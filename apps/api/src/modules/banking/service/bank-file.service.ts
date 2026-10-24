import { createHash } from "node:crypto";
import { auditLog, type BankEntryCurrencyExchange, type BankEntryReference, type Db, type Tx } from "@navet/db";
import {
  round2,
  type BookIncomingEntriesInput,
  type BookOutgoingEntriesInput,
  type CreatePaymentInput,
  type IgnoreBankEntryInput,
  type ListBankFilesQuery,
} from "@navet/shared";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { errorBody } from "../../system/service/error-body.js";
import { readPostingSettings } from "../../system/service/posting-settings.js";
import { findItemByEndToEndId } from "../repository/payment-batch.repository.js";
import type { BankFileRepository } from "../repository/bank-file.repository.js";
import {
  BankEntryAlreadyBookedError,
  BankEntryAmountDiffersError,
  BankEntryAmountMismatchError,
  BankEntryDirectionError,
  BankEntryNotFoundError,
  BankEntryNotMatchedError,
  BankFileNotFoundError,
} from "./banking.errors.js";
import { candidateOcrs, matchIncomingEntry, type ClosedReceivable, type IncomingProposal, type MatchState, type OpenReceivable } from "./incoming-matching.js";
import { parseCamt054 } from "./iso20022/camt054-parser.js";
import { namesMatch } from "./name-match.js";
import { notificationAccountWarning, type CompanyAccounts } from "./own-account.js";
import type { PaymentBatchService } from "./payment-batch.service.js";

// The slices of the sales module this service books and reads through —
// declared here, at the consumer (the CustomerPaymentPoster/StockBalanceReader
// pattern). The sales payment service and repository implement them.
export interface CustomerPaymentRegistrar {
  createInTx(tx: Tx, input: CreatePaymentInput, createdBy: string, link: { bankFileEntryId: string }): Promise<{ paymentId: string; paymentNumber: string }>;
}
export interface OpenReceivablesReader {
  openReceivables(filter: { ocrs?: string[]; amounts?: { values: number[]; tolerance: number }; customerIds?: string[] }): Promise<OpenReceivable[]>;
  closedByOcrs(ocrs: string[]): Promise<ClosedReceivable[]>;
  customersWithOpenItems(): Promise<{ id: string; name: string }[]>;
}
export interface BankFileServiceDeps {
  db: Db;
  repo: BankFileRepository;
  batches: Pick<PaymentBatchService, "confirmItemInTx" | "returnItemInTx">;
  customerPayments: CustomerPaymentRegistrar;
  receivables: OpenReceivablesReader;
  // The company's own accounts, read live (the bank settings repository).
  company: { readCompany(): Promise<CompanyAccounts> };
  now?: () => Date;
}

// Where the entries an upload skipped were first read (spec §6.1).
export interface SkippedFrom {
  bankFileId: string;
  filename: string;
  count: number;
}

const skippedSummary = ({ filename, count }: SkippedFrom) => `${count} ${count === 1 ? "post var redan inläst" : "poster var redan inlästa"} (fil ${filename})`;

export type EntryResult = { entryId: string; ok: true; paymentNumber: string } | { entryId: string; ok: false; error: { error: string; code?: string } };

export interface IncomingEntryView {
  id: string;
  position: number;
  // The entry's own amount in the account's currency (SEK).
  amount: number;
  currency: string;
  // Valuta: a payment instructed in another currency (InstdAmt) — matched
  // against open items in that currency, booked with `amount` as the SEK
  // value — the bank's exchange details and the charges included.
  instructedAmount: number | null;
  instructedCurrency: string | null;
  currencyExchange: BankEntryCurrencyExchange | null;
  chargesAmount: number | null;
  bookingDate: string;
  counterpartyName: string | null;
  remittance: BankEntryReference[];
  dedupeSource: string;
  warning: string | null;
  state: "booked" | "ignored" | "not_sek" | MatchState;
  proposal: IncomingProposal | null;
  payment: { id: string; paymentNumber: string } | null;
  ignoreReason: string | null;
}
export interface OutgoingEntryView {
  id: string;
  position: number;
  direction: "credit" | "debit";
  reversal: boolean;
  // The entry's own amount in the account's currency (SEK).
  amount: number;
  currency: string;
  // Valuta steg 2: what was instructed in another currency (InstdAmt), the
  // bank's exchange details and the charges included in `amount`.
  instructedAmount: number | null;
  instructedCurrency: string | null;
  currencyExchange: BankEntryCurrencyExchange | null;
  chargesAmount: number | null;
  bookingDate: string;
  endToEndId: string | null;
  counterpartyName: string | null;
  returnReason: string | null;
  state: "booked" | "ignored" | "matched" | "return" | "amount_mismatch" | "already_confirmed" | "not_waiting" | "unknown";
  item: {
    id: string;
    batchId: string;
    batchNumber: string;
    endToEndId: string;
    status: string;
    // In the item's currency (the invoice's).
    amount: number;
    currency: string;
    registrationNumber: string;
    // The row's live UTB, however it was booked (Redan bekräftad).
    paymentId: string | null;
    paymentNumber: string | null;
  } | null;
  payment: { id: string; paymentNumber: string } | null;
  ignoreReason: string | null;
}

const NO_REFERENCE = "Banken angav ingen unik referens — posten känns igen på sitt innehåll";
const notSek = (currency: string) => `Posten är i ${currency} — bara SEK hanteras. Markera den som Hanterad utanför Nav.`;

// One live payment per bank entry (spec §1.7).
const ENTRY_LIVE_INDEXES = ["customer_payments_entry_live", "supplier_payments_entry_live"];

const isOutgoing = (entry: { direction: "credit" | "debit"; reversal: boolean }) => entry.direction === "debit" || entry.reversal;

// Valuta: what an incoming entry paid, in the payment's own currency — the
// instructed amount when the payer instructed another currency than the
// account's (InstdAmt in EUR on the SEK account), else the entry's own.
function paymentOf(entry: { amount: string | number; currency: string; instructedAmount: string | number | null; instructedCurrency: string | null }) {
  return entry.instructedCurrency !== null && entry.instructedAmount !== null
    ? { amount: round2(Number(entry.instructedAmount)), currency: entry.instructedCurrency }
    : { amount: round2(Number(entry.amount)), currency: entry.currency };
}

// Is the bank's amount the batch row's? A SEK row: the entry's own amount
// (as before). A row in another currency: the instructed amount in that
// currency (InstdAmt) — the entry's own amount is the SEK it cost.
function sameAmount(
  item: { amount: string | number; currency: string },
  entry: { amount: string | number; instructedAmount: string | number | null; instructedCurrency: string | null }
): boolean {
  if (item.currency === "SEK") return round2(Number(item.amount)) === round2(Number(entry.amount));
  return entry.instructedCurrency === item.currency && entry.instructedAmount !== null && round2(Number(entry.instructedAmount)) === round2(Number(item.amount));
}

export function createBankFileService(deps: BankFileServiceDeps) {
  const { db, repo } = deps;
  const now = deps.now ?? (() => new Date());

  // Every bank file write logs inside its own transaction (spec §10).
  async function audit(tx: Tx, filename: string, action: string, detail: unknown, userId: string) {
    await tx.insert(auditLog).values({ entityType: "bank_file", entityId: filename, action, detail, userId });
  }

  async function requireFile(id: string) {
    const file = await repo.findFile(id);
    if (!file) throw new BankFileNotFoundError(id);
    return file;
  }

  // Each entry in its own transaction, sequentially; errors are reported per
  // row so a locked period or a stale preview fails that entry only (the
  // collective-invoicing pattern). The booking, its links, the batch row's
  // status and the audit entry all commit — or roll back — together.
  async function perEntry(entryIds: string[], run: (tx: Tx, entryId: string) => Promise<string>): Promise<EntryResult[]> {
    const results: EntryResult[] = [];
    for (const entryId of entryIds) {
      try {
        const paymentNumber = await db.transaction((tx) => run(tx, entryId));
        results.push({ entryId, ok: true, paymentNumber });
      } catch (err) {
        // A concurrent booking of the same entry trips its partial unique
        // index; any other unique violation is a real error and stays one.
        const error = ENTRY_LIVE_INDEXES.some((name) => isUniqueViolation(err, name)) ? new BankEntryAlreadyBookedError() : (err as Error);
        results.push({ entryId, ok: false, error: errorBody(error) });
      }
    }
    return results;
  }

  async function lockOwnEntry(tx: Tx, fileId: string, entryId: string) {
    const entry = await repo.lockEntry(tx, entryId);
    if (!entry || entry.bankFileId !== fileId) throw new BankEntryNotFoundError(entryId);
    return entry;
  }

  const service = {
    // Spec §6.1. The same bytes again answer with the stored file; entries an
    // overlapping file already brought in are skipped by their dedupe key.
    async upload(input: { filename: string; contentType: string; data: Buffer }, userId: string) {
      const sha256 = createHash("sha256").update(input.data).digest("hex");
      const existing = await repo.findIncomingBySha(sha256);
      if (existing) return { file: existing, created: false, skippedFrom: [] as SkippedFrom[] };
      // Parse errors are thrown before anything is written.
      const parsed = parseCamt054(input.data.toString("utf8"));
      const bankCreatedAt = parsed.createdAt ? new Date(parsed.createdAt) : null;
      try {
        const { file, skippedFrom } = await db.transaction(async (tx) => {
          const earlier = await repo.existingEntries(tx, parsed.entries.map((e) => e.dedupeKey));
          const known = new Set(earlier.map((e) => e.key));
          const fresh = parsed.entries.filter((e) => !known.has(e.dedupeKey));
          const skipped = parsed.entries.length - fresh.length;
          const skippedFrom: SkippedFrom[] = [];
          for (const e of earlier) {
            const group = skippedFrom.find((g) => g.bankFileId === e.bankFileId);
            if (group) group.count += 1;
            else skippedFrom.push({ bankFileId: e.bankFileId, filename: e.filename, count: 1 });
          }
          // The counts are written in the file's own INSERT, before the
          // entries (their FK needs the file) — bank_files is insert-only
          // (NV001), so they cannot be corrected from insertEntries' result
          // afterwards. A concurrent upload of overlapping entries makes them
          // too low by that overlap, which is harmless (spec §6.1): DO NOTHING
          // still keeps every entry exactly once.
          const file = await repo.insertFile(tx, {
            direction: "incoming",
            messageType: "camt.054.001.02",
            filename: input.filename.slice(0, 255),
            contentType: (input.contentType || "application/xml").slice(0, 100),
            sizeBytes: input.data.length,
            sha256,
            data: input.data,
            bankMessageId: parsed.messageId.slice(0, 35),
            bankCreatedAt: bankCreatedAt && !Number.isNaN(bankCreatedAt.getTime()) ? bankCreatedAt : null,
            entryCount: fresh.length,
            skippedDuplicates: skipped,
            warnings: [...parsed.warnings, ...skippedFrom.map(skippedSummary)],
            uploadedBy: userId,
          });
          await repo.insertEntries(
            tx,
            fresh.map((e) => ({
              bankFileId: file.id,
              dedupeKey: e.dedupeKey,
              dedupeSource: e.dedupeSource,
              direction: e.direction,
              reversal: e.reversal,
              account: e.account.slice(0, 40),
              amount: String(e.amount),
              currency: e.currency.slice(0, 3),
              bookingDate: e.bookingDate,
              valueDate: e.valueDate,
              endToEndId: e.endToEndId?.slice(0, 35) ?? null,
              msgId: e.msgId?.slice(0, 35) ?? null,
              pmtInfId: e.pmtInfId?.slice(0, 35) ?? null,
              counterpartyName: e.counterpartyName?.slice(0, 140) ?? null,
              remittance: e.remittance,
              returnReason: e.returnReason?.slice(0, 10) ?? null,
              position: e.position,
              instructedAmount: e.instructedAmount === null ? null : String(e.instructedAmount),
              instructedCurrency: e.instructedCurrency,
              currencyExchange: e.currencyExchange,
              chargesAmount: e.chargesAmount === null ? null : String(e.chargesAmount),
            }))
          );
          await audit(tx, file.filename, "uploaded", { sha256, entries: fresh.length, skipped }, userId);
          return { file, skippedFrom };
        });
        return { file, created: true, skippedFrom };
      } catch (err) {
        // The same bytes uploaded concurrently: the partial unique index on
        // sha256 decides; the loser answers with the winner's file.
        if (isUniqueViolation(err)) {
          const winner = await repo.findIncomingBySha(sha256);
          if (winner) return { file: winner, created: false, skippedFrom: [] as SkippedFrom[] };
        }
        throw err;
      }
    },

    async list(query: ListBankFilesQuery) {
      return repo.list(query);
    },

    // The file plus the notification accounts it was read from, checked live
    // against Företagsinformation — a file for another account is flagged.
    async get(id: string) {
      const file = await requireFile(id);
      const [accounts, company] = await Promise.all([repo.fileAccounts(id), deps.company.readCompany()]);
      return { ...file, accounts, accountWarning: notificationAccountWarning(accounts, company) };
    },

    async download(id: string) {
      const file = await repo.findFileData(id);
      if (!file) throw new BankFileNotFoundError(id);
      return file;
    },

    // Spec §5.1: computed live on every GET — nothing about the matching is
    // stored, so a proposal always reflects today's open items.
    async incomingView(fileId: string): Promise<IncomingEntryView[]> {
      await requireFile(fileId);
      const rows = await repo.incomingEntries(fileId);
      const open = rows.filter((r) => !r.paymentId && !r.entry.ignoredAt && r.entry.currency === "SEK");
      const tolerance = round2((await readPostingSettings(db)).paymentTolerance);
      const ocrs = [...new Set(open.flatMap((r) => candidateOcrs(r.entry.remittance)))];
      const [byOcr, closed, byAmount, customers] = await Promise.all([
        deps.receivables.openReceivables({ ocrs }),
        deps.receivables.closedByOcrs(ocrs),
        // Valuta: the payment's own amount (the instructed one when it is in
        // another currency); the SEK tolerance is a superset in any currency
        // — matchIncomingEntry narrows per open item.
        deps.receivables.openReceivables({ amounts: { values: open.map((r) => paymentOf(r.entry).amount), tolerance } }),
        open.length > 0 ? deps.receivables.customersWithOpenItems() : Promise.resolve([]),
      ]);
      const namedIds = customers.filter((c) => open.some((r) => r.entry.counterpartyName && namesMatch(r.entry.counterpartyName, c.name))).map((c) => c.id);
      const byCustomerRows = await deps.receivables.openReceivables({ customerIds: namedIds });
      const openByCustomer = new Map<string, OpenReceivable[]>();
      for (const r of byCustomerRows) openByCustomer.set(r.customerId, [...(openByCustomer.get(r.customerId) ?? []), r]);
      const lookup = {
        openByOcr: new Map(byOcr.filter((r) => r.ocrNumber).map((r) => [r.ocrNumber!, r])),
        closedByOcr: new Map(closed.map((c) => [c.ocrNumber, c])),
        candidatesByAmount: byAmount,
        openByCustomer,
        customers,
      };
      return rows.map(({ entry, paymentId, paymentNumber }) => {
        const amount = Number(entry.amount);
        const warnings = [
          entry.dedupeSource === "content_hash" ? NO_REFERENCE : null,
          entry.currency !== "SEK" ? notSek(entry.currency) : null,
        ].filter((w): w is string => w !== null);
        const base = {
          id: entry.id,
          position: entry.position,
          amount,
          currency: entry.currency,
          instructedAmount: entry.instructedAmount === null ? null : Number(entry.instructedAmount),
          instructedCurrency: entry.instructedCurrency,
          currencyExchange: entry.currencyExchange,
          chargesAmount: entry.chargesAmount === null ? null : Number(entry.chargesAmount),
          bookingDate: entry.bookingDate,
          counterpartyName: entry.counterpartyName,
          remittance: entry.remittance,
          dedupeSource: entry.dedupeSource,
          warning: warnings.length > 0 ? warnings.join(" · ") : null,
          payment: paymentId ? { id: paymentId, paymentNumber: paymentNumber! } : null,
          ignoreReason: entry.ignoreReason,
        };
        if (paymentId) return { ...base, state: "booked" as const, proposal: null };
        if (entry.ignoredAt) return { ...base, state: "ignored" as const, proposal: null };
        if (entry.currency !== "SEK") return { ...base, state: "not_sek" as const, proposal: null };
        const payment = paymentOf(entry);
        const proposal = matchIncomingEntry(
          { id: entry.id, amount: payment.amount, currency: payment.currency, counterpartyName: entry.counterpartyName, remittance: entry.remittance },
          lookup,
          tolerance
        );
        return { ...base, state: proposal.state, proposal };
      });
    },

    // Spec §5.2. Lock order: entry → invoices (inside createInTx). The
    // live-payment check is the friendly half; customer_payments_entry_live
    // is the guarantee. The server re-applies the tolerance rule — the
    // preview is display only.
    async bookIncoming(fileId: string, input: BookIncomingEntriesInput, userId: string) {
      const file = await requireFile(fileId);
      const byId = new Map(input.entries.map((e) => [e.entryId, e]));
      const results = await perEntry(
        input.entries.map((e) => e.entryId),
        async (tx, entryId) => {
          const choice = byId.get(entryId)!;
          const entry = await lockOwnEntry(tx, fileId, entryId);
          if (isOutgoing(entry)) throw new BankEntryDirectionError("Posten är en utbetalning eller retur — bokför den under Inköp → Bankfiler");
          if (entry.currency !== "SEK") throw new BankEntryDirectionError(`Posten är i ${entry.currency} — bara SEK kan bokföras`);
          if (entry.ignoredAt || (await repo.incomingBooked(tx, entry.id))) throw new BankEntryAlreadyBookedError();
          // Valuta: the rows settle the payment's own amount — the instructed
          // one for a payment in another currency, booked with the entry's
          // SEK amount and the charges included in it (a bank that reports
          // none leaves the fee inside the exchange difference).
          const payment = paymentOf(entry);
          const foreign = payment.currency !== entry.currency;
          const applied = round2(choice.rows.reduce((sum, r) => sum + r.appliedAmount, 0));
          if (applied !== round2(payment.amount)) throw new BankEntryAmountMismatchError(payment.amount, applied);
          const bankAccountNumber = (await readPostingSettings(tx)).postingBank;
          const done = await deps.customerPayments.createInTx(
            tx,
            {
              customerId: choice.customerId,
              paymentDate: entry.bookingDate,
              bankAccountNumber,
              amount: payment.amount,
              currency: payment.currency,
              ...(foreign
                ? { amountSek: Number(entry.amount), bankFeeSek: entry.chargesAmount === null ? 0 : Number(entry.chargesAmount) }
                : {}),
              note: `Bankfil ${file.filename} · ${entry.dedupeKey}`.slice(0, 500),
              rows: choice.rows,
            },
            userId,
            { bankFileEntryId: entry.id }
          );
          await audit(tx, file.filename, "entry_booked", { dedupeKey: entry.dedupeKey, payment: done.paymentNumber }, userId);
          return done.paymentNumber;
        }
      );
      return { results };
    },

    // Spec §6.2: the file's debits and returns, matched on EndToEndId.
    async outgoingView(fileId: string): Promise<OutgoingEntryView[]> {
      await requireFile(fileId);
      const rows = await repo.outgoingEntries(fileId);
      return rows.map((row) => {
        const e = row.entry;
        const amount = Number(e.amount);
        const item = row.item?.id
          ? {
              id: row.item.id,
              batchId: row.item.batchId!,
              batchNumber: row.batchNumber!,
              endToEndId: row.item.endToEndId!,
              status: row.item.status!,
              amount: Number(row.item.amount),
              currency: row.item.currency!,
              registrationNumber: row.registrationNumber!,
              paymentId: row.itemPaymentId,
              paymentNumber: row.itemPaymentNumber,
            }
          : null;
        let state: OutgoingEntryView["state"];
        const same = item ? sameAmount(item, e) : false;
        if (row.handled) state = "booked";
        else if (e.ignoredAt) state = "ignored";
        // Our payments are drawn from the SEK account — an entry in another
        // account currency (a currency account) cannot be one of ours.
        else if (!item || e.currency !== "SEK") state = "unknown";
        // A return of another amount than we sent is checked by hand, like a
        // debit that differs — never cancelled or rejected automatically.
        else if (e.reversal) state = item.status === "confirmed" || item.status === "exported" ? (same ? "return" : "amount_mismatch") : "not_waiting";
        else if (item.status === "exported") state = same ? "matched" : "amount_mismatch";
        else if (item.status === "confirmed") state = "already_confirmed";
        else state = "not_waiting";
        return {
          id: e.id,
          position: e.position,
          direction: e.direction,
          reversal: e.reversal,
          amount,
          currency: e.currency,
          instructedAmount: e.instructedAmount === null ? null : Number(e.instructedAmount),
          instructedCurrency: e.instructedCurrency,
          currencyExchange: e.currencyExchange,
          chargesAmount: e.chargesAmount === null ? null : Number(e.chargesAmount),
          bookingDate: e.bookingDate,
          endToEndId: e.endToEndId,
          counterpartyName: e.counterpartyName,
          returnReason: e.returnReason,
          state,
          item,
          payment: row.paymentId ? { id: row.paymentId, paymentNumber: row.paymentNumber! } : null,
          ignoreReason: e.ignoreReason,
        };
      });
    },

    // Lock order: entry → batch → row → invoice (inside confirmItemInTx /
    // returnItemInTx). Entries are booked in the order sent; the web sends
    // file order, so a debit is booked before its return.
    async bookOutgoing(fileId: string, input: BookOutgoingEntriesInput, userId: string) {
      const file = await requireFile(fileId);
      const results = await perEntry(input.entryIds, async (tx, entryId) => {
        const entry = await lockOwnEntry(tx, fileId, entryId);
        if (!isOutgoing(entry)) throw new BankEntryDirectionError("Posten är en inbetalning — bokför den under Försäljning → Bankfiler");
        if (entry.ignoredAt || (await repo.outgoingHandled(tx, entry.id))) throw new BankEntryAlreadyBookedError();
        const item = entry.endToEndId && entry.currency === "SEK" ? await findItemByEndToEndId(tx, entry.endToEndId) : null;
        if (!item) throw new BankEntryNotMatchedError();
        // Debit or return, the bank's amount must be the row's (spec §6.2) —
        // for a payment in another currency the instructed amount in it.
        const foreign = item.currency !== "SEK";
        if (!sameAmount(item, entry)) {
          const actual = foreign ? (entry.instructedCurrency === item.currency && entry.instructedAmount !== null ? Number(entry.instructedAmount) : null) : Number(entry.amount);
          throw new BankEntryAmountDiffersError(item.endToEndId, Number(item.amount), actual, entry.reversal ? "returned" : "debited", item.currency);
        }
        if (entry.reversal) {
          await deps.batches.returnItemInTx(
            tx,
            item.id,
            { id: entry.id, bookingDate: entry.bookingDate, returnReason: entry.returnReason, ...(foreign ? { amountSek: Number(entry.amount) } : {}) },
            userId
          );
          await audit(tx, file.filename, "entry_booked", { dedupeKey: entry.dedupeKey, returned: item.endToEndId }, userId);
          // A return books no payment of its own: the row's EndToEndId stands in.
          return item.endToEndId;
        }
        // A payment in another currency books what left the SEK account
        // (the entry's amount, charges included) and the charges the bank
        // reports as included; a bank that reports none (Nordea) leaves the
        // fee inside the exchange difference.
        const done = await deps.batches.confirmItemInTx(
          tx,
          item.id,
          {
            paymentDate: entry.bookingDate,
            bankFileEntryId: entry.id,
            ...(foreign ? { amountSek: Number(entry.amount), bankFeeSek: entry.chargesAmount === null ? 0 : Number(entry.chargesAmount) } : {}),
          },
          userId
        );
        await audit(tx, file.filename, "entry_booked", { dedupeKey: entry.dedupeKey, payment: done.paymentNumber }, userId);
        return done.paymentNumber;
      });
      return { results };
    },

    // Hanterad utanför Nav (spec §6.3). The path's direction must match the
    // entry's, so the permission follows the direction.
    async ignore(fileId: string, direction: "incoming" | "outgoing", entryId: string, input: IgnoreBankEntryInput, userId: string) {
      const file = await requireFile(fileId);
      await db.transaction(async (tx) => {
        const entry = await lockOwnEntry(tx, fileId, entryId);
        const outgoing = isOutgoing(entry);
        if ((direction === "outgoing") !== outgoing) throw new BankEntryDirectionError("Posten hör till den andra riktningen");
        const handled = outgoing ? await repo.outgoingHandled(tx, entryId) : await repo.incomingBooked(tx, entryId);
        if (handled || entry.ignoredAt) throw new BankEntryAlreadyBookedError();
        await repo.setIgnored(tx, entryId, { ignoredAt: now(), ignoredBy: userId, ignoreReason: input.reason });
        await audit(tx, file.filename, "entry_ignored", { dedupeKey: entry.dedupeKey, reason: input.reason }, userId);
      });
    },

    async restore(fileId: string, direction: "incoming" | "outgoing", entryId: string, userId: string) {
      const file = await requireFile(fileId);
      await db.transaction(async (tx) => {
        const entry = await lockOwnEntry(tx, fileId, entryId);
        if ((direction === "outgoing") !== isOutgoing(entry)) throw new BankEntryDirectionError("Posten hör till den andra riktningen");
        // Idempotent: restoring an entry that is not ignored changes nothing.
        if (!entry.ignoredAt) return;
        await repo.setIgnored(tx, entryId, { ignoredAt: null, ignoredBy: null, ignoreReason: null });
        await audit(tx, file.filename, "entry_restored", { dedupeKey: entry.dedupeKey }, userId);
      });
    },
  };
  return service;
}

export type BankFileService = ReturnType<typeof createBankFileService>;
