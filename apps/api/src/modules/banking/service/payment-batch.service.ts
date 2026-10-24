import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { auditLog, bankFiles, paymentBatchItems, paymentBatches, type CreditorSnapshot, type Db, type Tx } from "@navet/db";
import {
  SEK,
  exceedsPaymentReportingThreshold,
  paymentKind,
  round2,
  toSek,
  type AddPaymentBatchItemsInput,
  type PaymentKind,
  type ConfirmPaymentBatchInput,
  type CreatePaymentBatchInput,
  type ListPaymentBatchesQuery,
  type RejectPaymentBatchItemInput,
  type SupplierPaymentInput,
  type UpdatePaymentBatchItemInput,
} from "@navet/shared";
import { InvalidStatusTransitionError } from "../../purchase/service/purchase.service.js";
import { SupplierInvoiceInPaymentBatchError } from "../../purchase/service/supplier-invoice.service.js";
import { computeOpenAmounts } from "../../purchase/repository/open-amounts.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { errorBody } from "../../system/service/error-body.js";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { readPostingSettings } from "../../system/service/posting-settings.js";
import type { PaymentBatchRepository, BatchItemRow } from "../repository/payment-batch.repository.js";
import { addDays, stockholmDate } from "./banking-dates.js";
import {
  BankReturnBeforePaymentError,
  BankReturnSekDiffersError,
  InvalidPaymentBatchItemError,
  InvalidPaymentDateError,
  PaymentBatchItemNotConfirmableError,
  PaymentBatchItemNotFoundError,
  PaymentBatchNotFoundError,
  PaymentFileInvalidError,
  SupplierInvoicesNotPayableError,
  type NotPayableDetail,
} from "./banking.errors.js";
import type { ExchangeRateReader } from "../../system/service/exchange-rates.js";
import type { BankReady, BankSettingsService } from "./bank-settings.service.js";
import type { BankProfile, DomesticMethod } from "./iso20022/bank-profiles.js";
import { buildPain001, defaultPaymentMessage, type Pain001Creditor, type Pain001Input, type Pain001Item } from "./iso20022/pain001-builder.js";
import { checkPain001, type Pain001Violation } from "./iso20022/pain001-check.js";
import { sanitizeText, type CharsetHolder } from "./iso20022/sanitize.js";

// The slice of the purchase module's supplier payment service this module
// books through — declared here, at the consumer (Task 3's Tx seam).
export interface SupplierPaymentRegistrar {
  createInTx(
    tx: Tx,
    input: SupplierPaymentInput,
    createdBy: string,
    link: { paymentBatchItemId: string; bankFileEntryId: string | null }
  ): Promise<{ paymentId: string; paymentNumber: string }>;
  cancelInTx(tx: Tx, id: string, userId: string, opts: { date: string }): Promise<{ paymentBatchItemId: string | null }>;
}

export interface PaymentBatchServiceDeps {
  db: Db;
  repo: PaymentBatchRepository;
  bankSettings: Pick<BankSettingsService, "assertReady">;
  supplierPayments: SupplierPaymentRegistrar;
  // KU81: today's rate for a payment abroad in another currency than SEK
  // (the 150 000 kr threshold). Omitted = no rate is ever found, so every
  // such payment is reported (the safe side).
  exchangeRates?: Pick<ExchangeRateReader, "getRate">;
  now?: () => Date;
}

export type ItemResult = { itemId: string; ok: true; paymentNumber: string } | { itemId: string; ok: false; error: { error: string; code?: string } };

// KU81 for one payment: the code sent and the SEK value it was judged on.
// amountSek/rate null = no rate could be found for the currency, and the
// payment is reported anyway (see reportingDecision).
export type RegulatoryReportingDecision = { code: string; amountSek: number | null; rate: number | null; rateDate: string | null };
type ReportingRates = Map<string, { rate: number; date: string } | null>;

function creditorOf(row: BatchItemRow): Pain001Creditor {
  return {
    name: row.supplier.name,
    postalCode: row.supplier.postalCode,
    city: row.supplier.city,
    method: row.supplier.paymentMethod!,
    bankgiro: row.supplier.bankgiro,
    plusgiro: row.supplier.plusgiro,
    clearing: row.supplier.bankClearing,
    account: row.supplier.bankAccountNumber,
    iban: row.supplier.iban,
    bic: row.supplier.bic,
    street: row.supplier.address,
    country: row.supplier.country,
    foreignAccount: row.supplier.foreignAccountNumber,
    clearingSystem: row.supplier.clearingSystem,
    clearingMemberId: row.supplier.clearingMemberId,
    bankName: row.supplier.bankName,
    chargeBearer: row.supplier.chargeBearer,
  };
}

// The row's betalningstyp (null while the supplier has no payment details).
function kindOf(row: BatchItemRow): PaymentKind | null {
  if (!row.supplier.paymentMethod) return null;
  return paymentKind({ currency: row.item.currency, method: row.supplier.paymentMethod, iban: row.supplier.iban });
}

// The length limits and character set of the row's texts: the domestic
// rule for its method, or the profile's foreign rules.
function rowRule(row: BatchItemRow, profile: BankProfile, kind: PaymentKind): { nameMax: number; messageMax: number; charset: CharsetHolder } {
  if (kind === "domestic") {
    const rule = profile.creditor[row.supplier.paymentMethod as DomesticMethod];
    return { nameMax: rule.nameMax, messageMax: rule.messageMax, charset: profile };
  }
  return { nameMax: profile.foreign.nameMax, messageMax: profile.foreign.messageMax, charset: { charset: profile.foreign.charset } };
}

function referenceOf(row: BatchItemRow, profile: BankProfile): Pain001Item["reference"] {
  if (row.paymentReferenceKind && row.paymentReference) return { kind: row.paymentReferenceKind, value: row.paymentReference };
  const kind = kindOf(row) ?? "domestic";
  const max = rowRule(row, profile, kind).messageMax;
  return { kind: "message", value: defaultPaymentMessage(row.invoiceNumber, max, kind), generated: true };
}

function draftWarnings(row: BatchItemRow, profile: BankProfile | null, decision: RegulatoryReportingDecision | null): string[] {
  const kind = kindOf(row);
  if (!profile || !kind) return [];
  const rule = rowRule(row, profile, kind);
  const warnings: string[] = [];
  const name = sanitizeText(row.supplier.name, rule.charset, rule.nameMax);
  if (name.truncated) warnings.push(`Mottagarens namn kortas till ${rule.nameMax} tecken: "${name.value}"`);
  else if (name.changed) warnings.push(`Mottagarens namn skickas som "${name.value}"`);
  const ref = referenceOf(row, profile);
  if (ref.kind === "message" && !ref.generated) {
    const message = sanitizeText(ref.value, rule.charset, Number.MAX_SAFE_INTEGER);
    if (message.value.length > rule.messageMax) warnings.push(`Meddelandet får vara högst ${rule.messageMax} tecken`);
    else if (message.changed) warnings.push(`Meddelandet skickas som "${message.value}"`);
  }
  if (decision && decision.amountSek === null) {
    warnings.push(
      `Kurs för ${row.item.currency} saknas — betalningen rapporteras till Skatteverket med betalningskod ${decision.code} för säkerhets skull (ange kursen under Ekonomi → Valutakurser)`
    );
  }
  return warnings;
}

// KU81 (spec §4): a payment abroad whose value EXCEEDS 150 000 kr carries
// the supplier's betalningskod. SEK is its own value; another currency is
// valued at today's rate (getRate). A missing rate counts as above the
// threshold: an unneeded code is harmless (the element is optional and the
// bank forwards it), a missing one is not — SEB then reports 793 "Other
// capital transactions" on its own, and the customer must send an amendment.
// Refusing the export instead would stop every payment in a currency
// Riksbanken does not publish, or whenever Riksbanken does not answer.
export function reportingDecision(
  item: { amount: number; currency: string },
  kind: PaymentKind | null,
  code: string,
  rates: ReportingRates
): RegulatoryReportingDecision | null {
  if (kind === null || kind === "domestic") return null;
  const currency = item.currency.toUpperCase();
  if (currency === SEK) return exceedsPaymentReportingThreshold(item.amount) ? { code, amountSek: round2(item.amount), rate: 1, rateDate: null } : null;
  const rate = rates.get(currency) ?? null;
  if (!rate) return { code, amountSek: null, rate: null, rateDate: null };
  const amountSek = toSek(item.amount, rate.rate);
  return exceedsPaymentReportingThreshold(amountSek) ? { code, amountSek, rate: rate.rate, rateDate: rate.date } : null;
}

export function createPaymentBatchService(deps: PaymentBatchServiceDeps) {
  const { db, repo } = deps;
  const now = deps.now ?? (() => new Date());
  const today = () => stockholmDate(now());

  // Every write in this service logs inside its own transaction.
  async function audit(tx: Tx, batchNumber: string, action: string, detail: unknown, userId: string) {
    await tx.insert(auditLog).values({ entityType: "payment_batch", entityId: batchNumber, action, detail, userId });
  }

  // exported → confirmed when no row waits for the bank any more; logged in
  // the same transaction as the row change that closed it.
  async function closeIfDone(tx: Tx, batch: { id: string; batchNumber: string }, userId: string) {
    if (await repo.recomputeBatchStatus(tx, batch.id, now())) await audit(tx, batch.batchNumber, "confirmed", null, userId);
  }

  // Locks and checks the invoices; returns their open amounts. One error
  // for every invoice that cannot go into a batch (spec §4.1 step 3).
  async function payableInvoices(tx: Tx, invoiceIds: string[]) {
    const locked = await repo.lockInvoices(tx, invoiceIds, "update");
    const byId = new Map(locked.map((row) => [row.id, row]));
    const open = await computeOpenAmounts(tx, invoiceIds);
    const reserved = await repo.liveReservations(tx, invoiceIds);
    const problems: NotPayableDetail[] = [];
    for (const id of invoiceIds) {
      const invoice = byId.get(id);
      const detail = (reason: NotPayableDetail["reason"], extra: Partial<NotPayableDetail> = {}) =>
        problems.push({ invoiceId: id, registrationNumber: invoice?.registrationNumber ?? null, reason, ...extra });
      if (!invoice) detail("not_found");
      else if (invoice.status !== "approved") detail("not_approved");
      else if (round2(open.get(id) ?? 0) < 0) detail("credit_note");
      else if (round2(open.get(id) ?? 0) === 0) detail("not_open");
      // Valuta steg 2: an invoice in any currency, to an account in any
      // country, goes into a batch — what a payment abroad still lacks
      // (street, BIC, the company's debit IBAN) is shown on the draft and
      // refused at export (pain001-check).
      else if (!invoice.paymentMethod) detail("no_payment_details");
      else if (reserved.has(id)) detail("already_in_batch", { batchNumber: reserved.get(id)! });
    }
    if (problems.length > 0) throw new SupplierInvoicesNotPayableError(problems);
    return { byId, open };
  }

  async function insertItems(tx: Tx, batch: { id: string; batchNumber: string }, requested: string[]) {
    // One row per invoice, in the order chosen (a repeated id is the same
    // invoice, not a second payment).
    const invoiceIds = [...new Set(requested)];
    const { byId, open } = await payableInvoices(tx, invoiceIds);
    let seq = await repo.nextSeq(tx, batch.id);
    const stamp = Date.now();
    const rows = invoiceIds.map((id, index) => {
      const invoice = byId.get(id)!;
      const due = invoice.dueDate ?? today();
      const rowSeq = seq++;
      return {
        batchId: batch.id,
        seq: rowSeq,
        endToEndId: `${batch.batchNumber}-${rowSeq}`,
        supplierInvoiceId: id,
        supplierId: invoice.supplierId,
        amount: String(round2(open.get(id)!)),
        currency: invoice.currency,
        executionDate: due > today() ? due : today(),
        createdAt: new Date(stamp + index),
      };
    });
    try {
      await tx.insert(paymentBatchItems).values(rows);
    } catch (err) {
      // Unreachable while the invoice lock above serializes creations; the
      // partial unique index is the guarantee. The batch is not known here.
      if (isUniqueViolation(err)) throw new SupplierInvoiceInPaymentBatchError("(okänd)");
      throw err;
    }
  }

  // Today's rate per currency of the rows paid abroad in another currency
  // than SEK — looked up OUTSIDE any transaction (getRate may call
  // Riksbanken). A currency without a rate maps to null.
  async function reportingRates(rows: BatchItemRow[]): Promise<ReportingRates> {
    const currencies = [...new Set(rows.filter((row) => (kindOf(row) ?? "domestic") !== "domestic").map((row) => row.item.currency.toUpperCase()))].filter(
      (currency) => currency !== SEK
    );
    const rates: ReportingRates = new Map();
    for (const currency of currencies) {
      try {
        if (!deps.exchangeRates) throw new Error("no exchange rate reader");
        const found = await deps.exchangeRates.getRate(currency, today());
        rates.set(currency, { rate: found.rate, date: found.date });
      } catch {
        rates.set(currency, null);
      }
    }
    return rates;
  }

  const decisionOf = (row: BatchItemRow, rates: ReportingRates) =>
    reportingDecision({ amount: Number(row.item.amount), currency: row.item.currency }, kindOf(row), row.supplier.paymentReportingCode, rates);

  // The file's input, exactly as the export builds it: past execution dates
  // move to today, and the KU81 decision per row. Rows without payment
  // details are left out (the export refuses them before building).
  function exportInput(batch: { batchNumber: string }, ready: BankReady, rows: BatchItemRow[], rates: ReportingRates): Pain001Input {
    return {
      messageId: batch.batchNumber,
      createdAt: now(),
      debtor: {
        name: ready.company.name,
        orgNumber: ready.company.orgNumber,
        postalCode: ready.company.postalCode,
        city: ready.company.city,
        account: ready.debitAccount,
        foreignAccount: ready.foreignDebitAccount,
        // BankReady's resolved, normalized id — never the raw org number.
        initiatingPartyId: ready.initiatingPartyId,
        agreementId: ready.settings.debtorAgreementId,
      },
      items: rows
        .filter((row) => row.supplier.paymentMethod)
        .map((row) => ({
          endToEndId: row.item.endToEndId,
          amount: Number(row.item.amount),
          currency: row.item.currency,
          executionDate: row.item.executionDate < today() ? today() : row.item.executionDate,
          creditor: creditorOf(row),
          reference: referenceOf(row, ready.profile),
          regulatoryReportingCode: decisionOf(row, rates)?.code ?? null,
        })),
    };
  }

  async function requireDraft(tx: Tx, id: string) {
    const batch = await repo.lockBatch(tx, id);
    if (!batch) throw new PaymentBatchNotFoundError(id);
    if (batch.status !== "draft") throw new InvalidStatusTransitionError(`Cannot change a payment batch in status "${batch.status}"`);
    return batch;
  }

  const service = {
    async list(query: ListPaymentBatchesQuery) {
      return repo.list(query);
    },

    async get(id: string) {
      const batch = await repo.findBatch(db, id);
      if (!batch) throw new PaymentBatchNotFoundError(id);
      const [rows, file] = await Promise.all([repo.listItems(db, id), repo.findFileMeta(db, id)]);
      const draft = batch.status === "draft";
      let ready: BankReady | null = null;
      if (draft) {
        try {
          ready = await deps.bankSettings.assertReady();
        } catch {
          ready = null;
        }
      }
      const profile = ready?.profile ?? null;
      // The draft previews what the export would do: the KU81 decision per
      // row (today's rate) and the structural check's verdict.
      const rates = draft ? await reportingRates(rows) : (new Map() as ReportingRates);
      // Rows whose supplier lost its payment details are left out of the
      // preview (the export refuses them as not payable), so "no items" is
      // never the preview's own verdict.
      const preview = (draft && ready && rows.length > 0 ? checkPain001(exportInput(batch, ready, rows, rates), ready.profile, today()) : []).filter(
        (v) => v.field !== "items"
      );
      const problemsFor = (endToEndId: string | null) => preview.filter((v) => v.endToEndId === endToEndId).map((v) => v.message);
      const items = rows.map((row) => {
        const live = row.supplier.paymentMethod ? creditorOf(row) : null;
        const snapshot = row.item.creditorSnapshot;
        const decision = draft ? decisionOf(row, rates) : snapshot?.regulatoryReporting ?? null;
        return {
          id: row.item.id,
          seq: row.item.seq,
          endToEndId: row.item.endToEndId,
          status: row.item.status,
          amount: Number(row.item.amount),
          currency: row.item.currency,
          // Betalningstyp: what the export sent (snapshot), else live.
          paymentKind: (snapshot?.kind ?? kindOf(row)) as PaymentKind | null,
          // KU81: reported to Skatteverket with this code (rateMissing = no
          // rate was found, reported for safety).
          regulatoryReporting: decision ? { code: decision.code, amountSek: decision.amountSek, rateMissing: decision.amountSek === null } : null,
          executionDate: row.item.executionDate,
          supplierInvoiceId: row.item.supplierInvoiceId,
          registrationNumber: row.registrationNumber,
          invoiceNumber: row.invoiceNumber,
          supplierId: row.item.supplierId,
          supplierName: row.supplier.name,
          creditor: (snapshot ?? (live && {
            method: live.method,
            account:
              live.method === "bankgiro"
                ? live.bankgiro
                : live.method === "plusgiro"
                  ? live.plusgiro
                  : live.method === "iban"
                    ? live.iban
                    : live.method === "foreign_account"
                      ? live.foreignAccount
                      : live.account,
            clearing: live.method === "bank_account" ? live.clearing : live.method === "foreign_account" ? live.clearingMemberId ?? null : null,
            bic: live.method === "iban" || live.method === "foreign_account" ? live.bic : null,
            name: live.name,
            postalCode: live.postalCode,
            city: live.city,
            referenceKind: row.paymentReferenceKind ?? "message",
            reference: row.paymentReference ?? "",
            kind: kindOf(row) ?? undefined,
            currency: row.item.currency,
            street: live.street ?? null,
            country: live.country,
            clearingSystem: live.method === "foreign_account" ? live.clearingSystem ?? null : null,
            bankName: live.method === "foreign_account" ? live.bankName ?? null : null,
            chargeBearer: kindOf(row) === "sepa" ? "SLEV" : kindOf(row) === "international" ? live.chargeBearer : undefined,
          })) as CreditorSnapshot | null,
          rejectedReason: row.item.rejectedReason,
          payment: row.paymentId ? { id: row.paymentId, paymentNumber: row.paymentNumber!, cancelledAt: row.paymentCancelledAt } : null,
          warnings: draft ? draftWarnings(row, profile, decision) : [],
          // What the export would refuse for this row (draft only).
          problems: problemsFor(row.item.endToEndId),
        };
      });
      const live = items.filter((i) => i.status !== "cancelled");
      const totals = new Map<string, number>();
      for (const item of live) totals.set(item.currency, round2((totals.get(item.currency) ?? 0) + item.amount));
      return {
        ...batch,
        // SEK rows only; every currency (SEK included) in totalsByCurrency.
        totalAmount: round2(live.filter((i) => i.currency === SEK).reduce((sum, i) => sum + i.amount, 0)),
        totalsByCurrency: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount })),
        itemCount: live.length,
        confirmedCount: items.filter((i) => i.status === "confirmed").length,
        // What the export would refuse for the batch as a whole (draft only):
        // the bank settings' and the company's side, e.g. a missing debit
        // IBAN for payments abroad.
        problems: problemsFor(null),
        file,
        items,
      };
    },

    async create(input: CreatePaymentBatchInput, userId: string) {
      await deps.bankSettings.assertReady();
      const id = await db.transaction(async (tx) => {
        const batchNumber = await getNextOrderNumber(tx, "payment_batch");
        const bankAccountNumber = (await readPostingSettings(tx)).postingBank;
        const [batch] = await tx
          .insert(paymentBatches)
          .values({ batchNumber, bankAccountNumber, note: input.note ?? null, createdBy: userId })
          .returning();
        await insertItems(tx, batch!, input.invoiceIds);
        await audit(tx, batchNumber, "created", { invoices: input.invoiceIds.length }, userId);
        return batch!.id;
      });
      return service.get(id);
    },

    async addItems(id: string, input: AddPaymentBatchItemsInput, userId: string) {
      await db.transaction(async (tx) => {
        const batch = await requireDraft(tx, id);
        await insertItems(tx, batch, input.invoiceIds);
        await audit(tx, batch.batchNumber, "items_added", { invoices: input.invoiceIds.length }, userId);
      });
      return service.get(id);
    },

    async updateItem(id: string, itemId: string, input: UpdatePaymentBatchItemInput, userId: string) {
      await db.transaction(async (tx) => {
        const batch = await requireDraft(tx, id);
        const item = await repo.lockItem(tx, itemId);
        if (!item || item.batchId !== id) throw new PaymentBatchItemNotFoundError(itemId);
        const patch: { amount?: string; executionDate?: string; updatedAt: Date } = { updatedAt: now() };
        if (input.amount !== undefined) {
          // zod's positive() lets 0.004 through; it rounds to 0 (a CHECK 500).
          if (round2(input.amount) <= 0) throw new InvalidPaymentBatchItemError("Beloppet måste vara större än 0");
          const open = round2((await computeOpenAmounts(tx, [item.supplierInvoiceId])).get(item.supplierInvoiceId) ?? 0);
          const unit = item.currency === SEK ? "kr" : item.currency;
          if (round2(input.amount) > open) throw new InvalidPaymentBatchItemError(`Beloppet får vara högst det öppna beloppet (${open.toFixed(2)} ${unit})`);
          patch.amount = String(round2(input.amount));
        }
        if (input.executionDate !== undefined) {
          if (input.executionDate < today() || input.executionDate > addDays(today(), 365)) {
            throw new InvalidPaymentBatchItemError("Betalningsdagen måste ligga mellan idag och ett år framåt");
          }
          patch.executionDate = input.executionDate;
        }
        await tx.update(paymentBatchItems).set(patch).where(eq(paymentBatchItems.id, itemId));
        await audit(tx, batch.batchNumber, "item_updated", { endToEndId: item.endToEndId, ...input }, userId);
      });
      return service.get(id);
    },

    async removeItem(id: string, itemId: string, userId: string) {
      await db.transaction(async (tx) => {
        const batch = await requireDraft(tx, id);
        const item = await repo.lockItem(tx, itemId);
        if (!item || item.batchId !== id) throw new PaymentBatchItemNotFoundError(itemId);
        await tx.delete(paymentBatchItems).where(eq(paymentBatchItems.id, itemId));
        await audit(tx, batch.batchNumber, "item_removed", { endToEndId: item.endToEndId }, userId);
      });
      return service.get(id);
    },

    // draft → exported: one transaction — check, build, snapshot, archive.
    // The KU81 rates are looked up first, outside it (getRate may call
    // Riksbanken; no transaction is held over HTTP). A row added in between
    // in a new currency has no rate and is reported (the safe side).
    async export(id: string, userId: string) {
      const rates = await reportingRates(await repo.listItems(db, id));
      await db.transaction(async (tx) => {
        const batch = await requireDraft(tx, id);
        const ready = await deps.bankSettings.assertReady(tx);
        const rows = await repo.listItems(tx, id);
        if (rows.length === 0) throw new PaymentFileInvalidError([{ endToEndId: null, field: "items", message: "Omgången har inga poster" }]);
        const invoiceIds = rows.map((r) => r.item.supplierInvoiceId);
        const locked = await repo.lockInvoices(tx, invoiceIds, "share");
        const open = await computeOpenAmounts(tx, invoiceIds);
        const problems: NotPayableDetail[] = [];
        for (const row of rows) {
          const invoice = locked.find((l) => l.id === row.item.supplierInvoiceId)!;
          if (invoice.status !== "approved") problems.push({ invoiceId: invoice.id, registrationNumber: invoice.registrationNumber, reason: "not_approved" });
          else if (Number(row.item.amount) > round2(open.get(invoice.id) ?? 0)) problems.push({ invoiceId: invoice.id, registrationNumber: invoice.registrationNumber, reason: "not_open" });
          else if (!row.supplier.paymentMethod) problems.push({ invoiceId: invoice.id, registrationNumber: invoice.registrationNumber, reason: "no_payment_details" });
        }
        if (problems.length > 0) throw new SupplierInvoicesNotPayableError(problems);

        const movedDates = rows
          .filter((r) => r.item.executionDate < today())
          .map((r) => ({ endToEndId: r.item.endToEndId, from: r.item.executionDate, to: today() }));
        const input = exportInput(batch, ready, rows, rates);
        const violations = checkPain001(input, ready.profile, today());
        if (violations.length > 0) throw new PaymentFileInvalidError(violations);
        const { xml, items } = buildPain001(input, ready.profile);

        for (const built of items) {
          const row = rows.find((r) => r.item.endToEndId === built.endToEndId)!;
          const decision = decisionOf(row, rates);
          // The snapshot records the KU81 decision the file carries.
          const snapshot: CreditorSnapshot = built.snapshot.kind === "domestic" ? built.snapshot : { ...built.snapshot, regulatoryReporting: decision };
          await tx
            .update(paymentBatchItems)
            .set({
              status: "exported",
              creditorSnapshot: snapshot,
              executionDate: input.items.find((i) => i.endToEndId === built.endToEndId)!.executionDate,
              updatedAt: now(),
            })
            .where(eq(paymentBatchItems.id, row.item.id));
        }
        await tx
          .update(paymentBatches)
          .set({ status: "exported", exportedAt: now(), exportedBy: userId, bankProfile: ready.profile.id, updatedAt: now() })
          .where(eq(paymentBatches.id, id));
        const data = Buffer.from(xml, "utf8");
        const sha256 = createHash("sha256").update(data).digest("hex");
        await tx.insert(bankFiles).values({
          direction: "outgoing",
          messageType: ready.profile.painVersion,
          paymentBatchId: id,
          filename: `${batch.batchNumber}.xml`,
          contentType: "application/xml",
          sizeBytes: data.length,
          sha256,
          data,
          entryCount: rows.length,
          uploadedBy: userId,
        });
        const foreignTotals = new Map<string, number>();
        for (const item of input.items) {
          const currency = item.currency ?? SEK;
          if (currency !== SEK) foreignTotals.set(currency, round2((foreignTotals.get(currency) ?? 0) + item.amount));
        }
        const reported = input.items.filter((item) => item.regulatoryReportingCode).map((item) => item.endToEndId);
        await audit(
          tx,
          batch.batchNumber,
          "exported",
          {
            profile: ready.profile.id,
            sha256,
            count: rows.length,
            // SEK rows; the other currencies (valuta steg 2) and the KU81 rows only when there are any.
            amount: round2(input.items.filter((i) => (i.currency ?? SEK) === SEK).reduce((s, i) => s + i.amount, 0)),
            ...(foreignTotals.size > 0 ? { foreign: [...foreignTotals.entries()].map(([currency, amount]) => ({ currency, amount })) } : {}),
            ...(reported.length > 0 ? { regulatoryReporting: reported } : {}),
            movedDates,
          },
          userId
        );
      });
      return service.get(id);
    },

    async getFile(id: string) {
      const file = await repo.findFile(id);
      if (!file) throw new PaymentBatchNotFoundError(id);
      return file;
    },

    // Lock order (spec §4.4): batch → row → invoice (in createInTx) → payment.
    // A row in another currency than SEK needs the SEK that left the account
    // (amountSek, from camt.054's TxAmt or typed in Bekräfta utförd) and the
    // bank's fee in SEK (bankFeeSek); the registration refuses it without
    // (400 supplier-payment-amount-sek, reason required). A SEK row passes
    // neither, exactly as before.
    async confirmItemInTx(
      tx: Tx,
      itemId: string,
      opts: { paymentDate: string; bankFileEntryId: string | null; amountSek?: number; bankFeeSek?: number },
      userId: string
    ) {
      const found = await repo.findItem(tx, itemId);
      if (!found) throw new PaymentBatchItemNotFoundError(itemId);
      const batch = (await repo.lockBatch(tx, found.batchId))!;
      const item = (await repo.lockItem(tx, itemId))!;
      if (item.status !== "exported") throw new PaymentBatchItemNotConfirmableError(item.endToEndId, item.status);
      const amount = Number(item.amount);
      const result = await deps.supplierPayments.createInTx(
        tx,
        {
          supplierId: item.supplierId,
          paymentDate: opts.paymentDate,
          bankAccountNumber: batch.bankAccountNumber,
          amount,
          ...(opts.amountSek !== undefined ? { amountSek: opts.amountSek } : {}),
          ...(opts.bankFeeSek !== undefined ? { bankFeeSek: opts.bankFeeSek } : {}),
          note: `Betalfil ${batch.batchNumber}, post ${item.endToEndId}`,
          rows: [{ supplierInvoiceId: item.supplierInvoiceId, appliedAmount: amount }],
        },
        userId,
        { paymentBatchItemId: item.id, bankFileEntryId: opts.bankFileEntryId }
      );
      await tx.update(paymentBatchItems).set({ status: "confirmed", updatedAt: now() }).where(eq(paymentBatchItems.id, item.id));
      await audit(
        tx,
        batch.batchNumber,
        "item_confirmed",
        {
          endToEndId: item.endToEndId,
          payment: result.paymentNumber,
          via: opts.bankFileEntryId ? "bank_file" : "manual",
          date: opts.paymentDate,
          ...(item.currency !== SEK ? { currency: item.currency, amount, amountSek: opts.amountSek ?? null, bankFeeSek: opts.bankFeeSek ?? 0 } : {}),
        },
        userId
      );
      await closeIfDone(tx, batch, userId);
      return result;
    },

    async confirm(id: string, input: ConfirmPaymentBatchInput, userId: string) {
      if (input.paymentDate > today()) throw new InvalidPaymentDateError("Betalningsdagen kan inte ligga i framtiden");
      const batch = await repo.findBatch(db, id);
      if (!batch) throw new PaymentBatchNotFoundError(id);
      if (batch.status !== "exported") throw new InvalidStatusTransitionError(`Cannot confirm a payment batch in status "${batch.status}"`);
      const rows = await repo.listItems(db, id);
      // Without itemIds every exported row; with them, exactly the chosen
      // rows (spec §4.4) — each chosen id that is not an exported row of
      // this batch is answered per row, never silently dropped.
      const chosen = input.itemIds ? new Set(input.itemIds) : null;
      const sekAmounts = new Map((input.amounts ?? []).map((a) => [a.itemId, a]));
      const results: ItemResult[] = [];
      const refuse = (itemId: string, endToEndId: string, status: string) =>
        results.push({ itemId, ok: false, error: errorBody(new PaymentBatchItemNotConfirmableError(endToEndId, status)) });
      // Each row in its own transaction: a locked period or a stale invoice
      // fails that row only (the collective-invoicing pattern).
      for (const row of rows) {
        if (chosen && !chosen.has(row.item.id)) continue;
        if (row.item.status !== "exported") {
          if (chosen) refuse(row.item.id, row.item.endToEndId, row.item.status);
          continue;
        }
        try {
          const sek = sekAmounts.get(row.item.id);
          const done = await db.transaction((tx) =>
            service.confirmItemInTx(
              tx,
              row.item.id,
              { paymentDate: input.paymentDate, bankFileEntryId: null, amountSek: sek?.amountSek, bankFeeSek: sek?.bankFeeSek },
              userId
            )
          );
          results.push({ itemId: row.item.id, ok: true, paymentNumber: done.paymentNumber });
        } catch (err) {
          results.push({ itemId: row.item.id, ok: false, error: errorBody(err as Error) });
        }
      }
      for (const itemId of chosen ?? []) {
        if (!rows.some((r) => r.item.id === itemId)) refuse(itemId, itemId, "absent");
      }
      return { results, batch: await service.get(id) };
    },

    // The bank returned the payment (CRDT + RvslInd). A confirmed row's UTB is
    // cancelled with an omföring on the return's booking date; a row never
    // confirmed is simply rejected. Lock order: batch → row (→ payment →
    // invoices inside cancelInTx).
    async returnItemInTx(
      tx: Tx,
      itemId: string,
      entry: { id: string | null; bookingDate: string; returnReason: string | null; amountSek?: number },
      userId: string
    ) {
      const found = await repo.findItem(tx, itemId);
      if (!found) throw new PaymentBatchItemNotFoundError(itemId);
      const batch = (await repo.lockBatch(tx, found.batchId))!;
      const item = (await repo.lockItem(tx, itemId))!;
      if (item.status === "confirmed") {
        const payment = await repo.livePaymentForItem(tx, item.id);
        // A confirmed row always has its live UTB (cancelling it turns the
        // row "returned" in the same tx) — anything else is a broken invariant.
        if (!payment) throw new Error(`Payment batch row ${item.endToEndId} is confirmed but has no live payment`);
        // An omföring dated before the payment it reverses is never right.
        if (entry.bookingDate < payment.paymentDate) throw new BankReturnBeforePaymentError(item.endToEndId, payment.paymentDate, entry.bookingDate);
        // A payment in another currency: the omföring reverses the SEK the
        // payment took — only right when the bank returned exactly that.
        if (payment.currency !== SEK && entry.amountSek !== undefined && round2(entry.amountSek) !== round2(Number(payment.amountSek))) {
          throw new BankReturnSekDiffersError(item.endToEndId, Number(payment.amountSek), entry.amountSek);
        }
        await deps.supplierPayments.cancelInTx(tx, payment.id, userId, { date: entry.bookingDate });
        await tx
          .update(paymentBatchItems)
          .set({ status: "returned", returnBankFileEntryId: entry.id, updatedAt: now() })
          .where(eq(paymentBatchItems.id, item.id));
      } else if (item.status === "exported") {
        await tx
          .update(paymentBatchItems)
          .set({
            status: "rejected",
            rejectedReason: `Returnerad av banken${entry.returnReason ? ` (${entry.returnReason})` : ""}`,
            returnBankFileEntryId: entry.id,
            updatedAt: now(),
          })
          .where(eq(paymentBatchItems.id, item.id));
      } else {
        throw new PaymentBatchItemNotConfirmableError(item.endToEndId, item.status);
      }
      await audit(tx, batch.batchNumber, "item_returned", { endToEndId: item.endToEndId, returnCode: entry.returnReason, date: entry.bookingDate }, userId);
      await closeIfDone(tx, batch, userId);
    },

    async rejectItem(id: string, itemId: string, input: RejectPaymentBatchItemInput, userId: string) {
      await db.transaction(async (tx) => {
        const batch = await repo.lockBatch(tx, id);
        if (!batch) throw new PaymentBatchNotFoundError(id);
        if (batch.status !== "exported") throw new InvalidStatusTransitionError(`Cannot reject in a payment batch in status "${batch.status}"`);
        const item = await repo.lockItem(tx, itemId);
        if (!item || item.batchId !== id) throw new PaymentBatchItemNotFoundError(itemId);
        if (item.status !== "exported") throw new PaymentBatchItemNotConfirmableError(item.endToEndId, item.status);
        await tx.update(paymentBatchItems).set({ status: "rejected", rejectedReason: input.reason, updatedAt: now() }).where(eq(paymentBatchItems.id, itemId));
        await audit(tx, batch.batchNumber, "item_rejected", { endToEndId: item.endToEndId, reason: input.reason }, userId);
        await closeIfDone(tx, batch, userId);
      });
      return service.get(id);
    },

    async cancel(id: string, userId: string) {
      await db.transaction(async (tx) => {
        const batch = await repo.lockBatch(tx, id);
        if (!batch) throw new PaymentBatchNotFoundError(id);
        if (batch.status !== "draft" && batch.status !== "exported") {
          throw new InvalidStatusTransitionError(`Cannot cancel a payment batch in status "${batch.status}"`);
        }
        const items = await tx.select().from(paymentBatchItems).where(eq(paymentBatchItems.batchId, id)).for("update");
        if (items.some((i) => i.status === "confirmed" || i.status === "returned")) {
          throw new InvalidStatusTransitionError("A payment batch with confirmed payments cannot be cancelled — mark the remaining payments rejected instead");
        }
        await tx
          .update(paymentBatchItems)
          .set({ status: "cancelled", updatedAt: now() })
          .where(and(eq(paymentBatchItems.batchId, id), inArray(paymentBatchItems.status, ["pending", "exported"])));
        await tx.update(paymentBatches).set({ status: "cancelled", cancelledAt: now(), cancelledBy: userId, updatedAt: now() }).where(eq(paymentBatches.id, id));
        await audit(tx, batch.batchNumber, "cancelled", { fromStatus: batch.status }, userId);
      });
      return service.get(id);
    },
  };
  return service;
}

export type PaymentBatchService = ReturnType<typeof createPaymentBatchService>;
export type PaymentBatchDetail = Awaited<ReturnType<PaymentBatchService["get"]>>;
