import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  bankFileEntries,
  bankFiles,
  customerPaymentRows,
  customerPayments,
  customers,
  fiscalYears,
  invoices,
  verifications,
  verificationSeries,
  type Db,
  type Tx,
} from "@navet/db";
import {
  applyPaymentTolerance,
  ilikePattern,
  releasedSek,
  round2,
  SEK,
  toSek,
  toleranceInCurrency,
  type ListOpenInvoicesQuery,
  type ListPaymentsQuery,
} from "@navet/shared";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { pluginEvents } from "../../system/service/plugin-events.js";
import { readPostingSettings } from "../../system/service/posting-settings.js";
// Type-only (erased at compile time), so declaring the poster interface at the
// consuming service does not create a runtime import cycle — same seam as
// invoice.repository.ts's CustomerInvoicePoster.
import type { CustomerPaymentPoster } from "../service/payment.service.js";
import {
  computeOpenAmounts,
  computeReleasedSek,
  grossAmountSekSql,
  grossAmountSql,
  openAmountSekSql,
  openAmountSql,
  openItemAggregates,
} from "./open-amounts.js";

// Control-flow signals thrown INSIDE the transaction so everything it did (the
// BET number, the payment rows, the K verification and its verifikatnummer)
// rolls back together instead of a guard failing after money was booked.
// createPayment/cancelPayment catch them immediately outside their own
// transaction and turn them into a discriminated `{ ok: false, reason }`
// result, the same convention as IssueRaceError in invoice.repository.ts and
// TransitionRaceError in supplier-invoice.repository.ts — the SERVICE decides
// what error each reason becomes. PaymentGuardError is exported for the Tx
// seam (createPaymentInTx): there the CALLER owns the transaction, so the
// signal propagates to the service, which translates it the same way.
export type PaymentGuardReason =
  | "invoice_not_found"
  | "not_issued"
  | "wrong_customer"
  | "not_open"
  | "sign_mismatch"
  | "exceeds_open"
  // Valuta: invoices in more than one currency on one payment, or another
  // currency than the one the caller expected (a bank entry in EUR).
  | "mixed_currencies"
  // Valuta: the SEK amount/fee does not fit the payment (detail.sekReason).
  | "amount_sek";

// Valuta: why the SEK amounts were refused — missing for a foreign payment,
// pointing the other way (or zero) than the amount, more fee than SEK moved,
// anything at all on a kvittning, or anything but the amount itself on a SEK
// payment.
export type CustomerPaymentSekReason = "required" | "sign" | "fee" | "kvittning" | "sek";

export type PaymentGuardDetail = {
  invoiceId: string;
  invoiceNumber: string | null;
  open?: number;
  applied?: number;
  currencies?: string[];
  currency?: string;
  sekReason?: CustomerPaymentSekReason;
};

export class PaymentGuardError extends Error {
  constructor(
    public reason: PaymentGuardReason,
    public detail: PaymentGuardDetail
  ) {
    super(reason);
  }
}

class CancelGuardError extends Error {
  constructor(public reason: "not_found" | "already_cancelled") {
    super(reason);
  }
}

// The booked verification's display number (K-2026-1), assembled from the
// joined series/fiscal year/number the same way economy.repository.ts formats
// it. `||` propagates NULL, so a payment with no verification (a pure
// kvittning) simply comes back null without a CASE. Used TWICE per payment —
// once for the payment's own verification, once for its cancellation omföring
// — so the joins below are aliased per role and this helper takes the three
// COLUMNS rather than the tables, which lets the aliased joins share it.
function displayNumberSql(seriesCode: SQLWrapper, yearLabel: SQLWrapper, verificationNumber: SQLWrapper) {
  return sql<string | null>`${seriesCode} || '-' || ${yearLabel} || '-' || ${verificationNumber}`;
}

// Betalningspåminnelse summary (B3 Task 7's Öppna poster "Påminnelser"
// column) — how many reminders an invoice has had, and whether any of them
// ever charged a fee. Same raw-SQL correlated-subquery style as
// open-amounts.ts's openAmountSql, and for the same reason: both queries
// below (listOpenInvoices, findOpenByOcr) join customers, so an INTERPOLATED
// invoices.id would already be correctly table-qualified by drizzle here —
// but a bare, hardcoded "invoices"."id" is unambiguous regardless of which
// query it ends up copied into next, so it stays consistent with the rest of
// this file's correlated subqueries.
const reminderCountSql = sql<string>`(
  SELECT COUNT(*)::int
  FROM invoice_reminders rem
  WHERE rem.invoice_id = "invoices"."id"
)`;

// Whether a påminnelseavgift has EVER been charged on this invoice — not
// whether it is still unpaid (that's already folded into openAmount via
// open-amounts.ts's own aggregate, and a payment can settle just the fee
// without a new reminder row). invoice_reminders_one_fee caps this at one
// row per invoice, but EXISTS doesn't lean on that for correctness.
const reminderFeeChargedSql = sql<boolean>`EXISTS (
  SELECT 1 FROM invoice_reminders rem
  WHERE rem.invoice_id = "invoices"."id" AND rem.fee > 0
)`;

export type PaymentHeaderWrite = {
  customerId: string;
  paymentDate: string;
  bankAccountNumber: string;
  amount: number;
  // Valuta: as the client sent them (null = not sent) — what they must be
  // depends on the invoices' currency, known only under the lock. currency =
  // the currency the caller expects the invoices to be in (a bank entry).
  currency: string | null;
  amountSek: number | null;
  bankFeeSek: number | null;
  note: string | null;
};

// What the client asked to settle: the cash part per open item. The write-off
// is derived inside the transaction (tolerance rule) and never taken from here.
export type PaymentRowInput = { invoiceId: string; appliedAmount: number };

export type CreatePaymentResult =
  | { ok: true; paymentId: string }
  | ({ ok: false; reason: PaymentGuardReason } & PaymentGuardDetail);

export type CancelPaymentResult = { ok: true } | { ok: false; reason: "not_found" | "already_cancelled" };

export function createPaymentRepository(db: Db) {
  // The payment + its cancellation omföring, each with its own three joins.
  const cancelVerifications = alias(verifications, "cancel_verifications");
  const cancelSeries = alias(verificationSeries, "cancel_verification_series");
  const cancelYears = alias(fiscalYears, "cancel_fiscal_years");

  const paymentColumns = {
    ...getTableColumns(customerPayments),
    customerName: customers.name,
    verificationDisplayNumber: displayNumberSql(
      verificationSeries.code,
      fiscalYears.label,
      verifications.verificationNumber
    ),
    cancellationDisplayNumber: displayNumberSql(
      cancelSeries.code,
      cancelYears.label,
      cancelVerifications.verificationNumber
    ),
  };

  const repo = {
    // Open items (issued, non-zero open amount). The open amount is computed
    // by openItemAggregates — the joined, list-shaped form of the SAME formula
    // computeOpenAmounts uses (open-amounts-list.test.ts pins the two against
    // each other) — so the list, the OCR lookup and the registration can
    // never disagree about what is left on an invoice. Ordered by due date
    // ascending with NULLS LAST (an invoice whose payment term produced no
    // due date is not "oldest"), then by issue time so the order is total —
    // see the orderBy below for why it is not the invoice number.
    async listOpenInvoices(query: ListOpenInvoicesQuery) {
      const agg = openItemAggregates(db);
      const conditions: SQL[] = [eq(invoices.status, "issued"), sql`${agg.openExpr} <> 0`];
      if (query.customerId) conditions.push(eq(invoices.customerId, query.customerId));
      // NULL < CURRENT_DATE is NULL, so an invoice with no computed due date
      // (a payment term like "KONTANT") drops out of the overdue view without
      // a separate IS NOT NULL.
      if (query.overdueOnly) conditions.push(sql`${invoices.dueDate} < CURRENT_DATE`);
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(
          or(
            ilike(invoices.invoiceNumber, pattern),
            ilike(invoices.ocrNumber, pattern),
            ilike(sql`COALESCE(${invoices.customerName}, ${customers.name})`, pattern)
          )!
        );
      }
      const where = and(...conditions);

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: invoices.id,
            invoiceNumber: invoices.invoiceNumber,
            type: invoices.type,
            customerId: invoices.customerId,
            // The frozen snapshot wins over the live join (same rule as the
            // invoice list): an issued invoice keeps the name it was issued to.
            customerName: sql<string>`COALESCE(${invoices.customerName}, ${customers.name})`,
            invoiceDate: invoices.invoiceDate,
            dueDate: invoices.dueDate,
            ocrNumber: invoices.ocrNumber,
            grossAmount: agg.grossExpr,
            openAmount: agg.openExpr,
            // Valuta: the open item's currency (the amounts above are in it),
            // its rate and the booked SEK values (signed like the amounts).
            currency: invoices.currency,
            exchangeRate: invoices.exchangeRate,
            grossAmountSek: agg.grossSekExpr,
            openAmountSek: agg.openSekExpr,
            reminderCount: reminderCountSql,
            reminderFeeCharged: reminderFeeChargedSql,
          })
          .from(invoices)
          .innerJoin(customers, eq(customers.id, invoices.customerId))
          .leftJoin(agg.gross, eq(agg.gross.invoiceId, invoices.id))
          .leftJoin(agg.settled, eq(agg.settled.invoiceId, invoices.id))
          .leftJoin(agg.fees, eq(agg.fees.invoiceId, invoices.id))
          .where(where)
          // Secondary sort is a timestamp, not the invoiceNumber text — FA
          // numbers sort lexicographically ("FA-10" before "FA-2"). It has to
          // be issuedAt rather than createdAt: the number is minted at ISSUE,
          // while createdAt stamps the draft, so two drafts issued in the
          // opposite order to their creation would sort against their numbers
          // — the very symptom this tie-break exists to fix. COALESCE keeps it
          // total for any legacy row without an issued_at (the list is
          // status = issued only, so that is the only gap).
          .orderBy(
            sql`${invoices.dueDate} ASC NULLS LAST`,
            sql`COALESCE(${invoices.issuedAt}, ${invoices.createdAt}) ASC`
          )
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(invoices)
          .innerJoin(customers, eq(customers.id, invoices.customerId))
          .leftJoin(agg.gross, eq(agg.gross.invoiceId, invoices.id))
          .leftJoin(agg.settled, eq(agg.settled.invoiceId, invoices.id))
          .leftJoin(agg.fees, eq(agg.fees.invoiceId, invoices.id))
          .where(where),
      ]);
      return {
        rows: rows.map((row) => ({
          ...row,
          grossAmount: Number(row.grossAmount),
          openAmount: Number(row.openAmount),
          exchangeRate: row.exchangeRate === null ? null : Number(row.exchangeRate),
          grossAmountSek: row.grossAmountSek === null ? null : Number(row.grossAmountSek),
          openAmountSek: row.openAmountSek === null ? null : Number(row.openAmountSek),
          reminderCount: Number(row.reminderCount),
        })),
        total: totalRows[0]!.total,
      };
    },

    // The open item an incoming OCR reference points at. Same issued +
    // non-zero-open scope as the list above: a settled invoice is no longer
    // matchable, which is what makes "OCR hittades inte" mean something.
    async findOpenByOcr(ocr: string) {
      const [row] = await db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          type: invoices.type,
          customerId: invoices.customerId,
          customerName: sql<string>`COALESCE(${invoices.customerName}, ${customers.name})`,
          invoiceDate: invoices.invoiceDate,
          dueDate: invoices.dueDate,
          ocrNumber: invoices.ocrNumber,
          grossAmount: grossAmountSql,
          openAmount: openAmountSql,
          // Valuta: the registration form shows (and asks for SEK on) a
          // foreign invoice — the same fields and types as /open-invoices.
          currency: invoices.currency,
          exchangeRate: invoices.exchangeRate,
          grossAmountSek: grossAmountSekSql,
          openAmountSek: openAmountSekSql,
          reminderCount: reminderCountSql,
          reminderFeeCharged: reminderFeeChargedSql,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(and(eq(invoices.ocrNumber, ocr), eq(invoices.status, "issued"), sql`${openAmountSql} <> 0`))
        // Uniqueness here is incidental (via the FA number's own uniqueness,
        // which ocrNumber is derived from) rather than a DB constraint on
        // ocrNumber itself — .limit(1) makes the "exactly one match" the
        // destructure below already assumes an explicit part of the query.
        .limit(1);
      return row
        ? {
            ...row,
            grossAmount: Number(row.grossAmount),
            openAmount: Number(row.openAmount),
            exchangeRate: row.exchangeRate === null ? null : Number(row.exchangeRate),
            grossAmountSek: row.grossAmountSek === null ? null : Number(row.grossAmountSek),
            openAmountSek: row.openAmountSek === null ? null : Number(row.openAmountSek),
            reminderCount: Number(row.reminderCount),
          }
        : null;
    },

    async list(query: ListPaymentsQuery) {
      const conditions: SQL[] = [];
      if (query.customerId) conditions.push(eq(customerPayments.customerId, query.customerId));
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(customerPayments.paymentNumber, pattern), ilike(customers.name, pattern))!);
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select(paymentColumns)
          .from(customerPayments)
          .innerJoin(customers, eq(customers.id, customerPayments.customerId))
          .leftJoin(verifications, eq(verifications.id, customerPayments.verificationId))
          .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
          .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
          .leftJoin(cancelVerifications, eq(cancelVerifications.id, customerPayments.cancellationVerificationId))
          .leftJoin(cancelSeries, eq(cancelSeries.id, cancelVerifications.seriesId))
          .leftJoin(cancelYears, eq(cancelYears.id, cancelVerifications.fiscalYearId))
          .where(where)
          .orderBy(desc(customerPayments.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(customerPayments)
          .innerJoin(customers, eq(customers.id, customerPayments.customerId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    async findById(id: string) {
      const [found] = await db
        .select({
          ...paymentColumns,
          entryBankFileId: bankFileEntries.bankFileId,
          entryDedupeKey: bankFileEntries.dedupeKey,
          entryFilename: bankFiles.filename,
        })
        .from(customerPayments)
        .innerJoin(customers, eq(customers.id, customerPayments.customerId))
        // Bankfiler: the camt.054 entry this payment was booked from.
        .leftJoin(bankFileEntries, eq(bankFileEntries.id, customerPayments.bankFileEntryId))
        .leftJoin(bankFiles, eq(bankFiles.id, bankFileEntries.bankFileId))
        .leftJoin(verifications, eq(verifications.id, customerPayments.verificationId))
        .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .leftJoin(cancelVerifications, eq(cancelVerifications.id, customerPayments.cancellationVerificationId))
        .leftJoin(cancelSeries, eq(cancelSeries.id, cancelVerifications.seriesId))
        .leftJoin(cancelYears, eq(cancelYears.id, cancelVerifications.fiscalYearId))
        .where(eq(customerPayments.id, id));
      if (!found) return null;
      const { entryBankFileId, entryDedupeKey, entryFilename, ...row } = found;
      return {
        ...row,
        bankFileEntry:
          row.bankFileEntryId && entryBankFileId
            ? { bankFileId: entryBankFileId, filename: entryFilename!, dedupeKey: entryDedupeKey! }
            : null,
      };
    },

    // Bankfiler: the open items the camt.054 matching needs (spec §5.3), on
    // the same joined aggregates as the open-items list (open-amounts.ts).
    // The filters are OR:ed — an item is a candidate by OCR, by amount within
    // the tolerance, or by belonging to a customer whose name matched.
    async openReceivables(filter: { ocrs?: string[]; amounts?: { values: number[]; tolerance: number }; customerIds?: string[] }) {
      const agg = openItemAggregates(db);
      const conditions: SQL[] = [eq(invoices.status, "issued"), sql`${agg.openExpr} <> 0`];
      const any: SQL[] = [];
      if (filter.ocrs?.length) any.push(inArray(invoices.ocrNumber, filter.ocrs));
      if (filter.customerIds?.length) any.push(inArray(invoices.customerId, filter.customerIds));
      const amounts = [...new Set(filter.amounts?.values ?? [])];
      if (amounts.length > 0) {
        const tolerance = filter.amounts!.tolerance;
        any.push(sql`(${sql.join(amounts.map((v) => sql`abs(${agg.openExpr} - ${v}) <= ${tolerance}`), sql` OR `)})`);
      }
      if (any.length === 0) return [];
      conditions.push(or(...any)!);
      const rows = await db
        .select({
          invoiceId: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          ocrNumber: invoices.ocrNumber,
          customerId: invoices.customerId,
          customerName: sql<string>`COALESCE(${invoices.customerName}, ${customers.name})`,
          dueDate: invoices.dueDate,
          openAmount: agg.openExpr,
          // Valuta: an entry is matched against open items in its own currency.
          currency: invoices.currency,
          exchangeRate: invoices.exchangeRate,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .leftJoin(agg.gross, eq(agg.gross.invoiceId, invoices.id))
        .leftJoin(agg.settled, eq(agg.settled.invoiceId, invoices.id))
        .leftJoin(agg.fees, eq(agg.fees.invoiceId, invoices.id))
        .where(and(...conditions))
        .orderBy(sql`${invoices.dueDate} ASC NULLS LAST`, sql`COALESCE(${invoices.issuedAt}, ${invoices.createdAt}) ASC`)
        .limit(500);
      return rows.map((row) => ({
        ...row,
        invoiceNumber: row.invoiceNumber!,
        openAmount: Number(row.openAmount),
        exchangeRate: row.exchangeRate === null ? 1 : Number(row.exchangeRate),
      }));
    },

    // OCRs that belong to an invoice with nothing left to pay — the matching's
    // "redan betald — möjlig dubbelbetalning".
    async closedByOcrs(ocrs: string[]) {
      if (ocrs.length === 0) return [];
      const rows = await db
        .select({ invoiceNumber: invoices.invoiceNumber, ocrNumber: invoices.ocrNumber, status: invoices.status })
        .from(invoices)
        .where(and(inArray(invoices.ocrNumber, ocrs), inArray(invoices.status, ["paid", "cancelled"])));
      return rows.map((row) => ({ invoiceNumber: row.invoiceNumber!, ocrNumber: row.ocrNumber!, status: row.status as "paid" | "cancelled" }));
    },

    async customersWithOpenItems() {
      const agg = openItemAggregates(db);
      return db
        .selectDistinct({ id: customers.id, name: customers.name })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .leftJoin(agg.gross, eq(agg.gross.invoiceId, invoices.id))
        .leftJoin(agg.settled, eq(agg.settled.invoiceId, invoices.id))
        .leftJoin(agg.fees, eq(agg.fees.invoiceId, invoices.id))
        .where(and(eq(invoices.status, "issued"), sql`${agg.openExpr} <> 0`));
    },

    // The settled open items, in registration order (the strictly increasing
    // createdAt stamps written below are what makes that order deterministic).
    async listRows(paymentId: string) {
      return db
        .select({
          ...getTableColumns(customerPaymentRows),
          invoiceNumber: invoices.invoiceNumber,
          invoiceType: invoices.type,
          invoiceDueDate: invoices.dueDate,
          invoiceExchangeRate: invoices.exchangeRate,
        })
        .from(customerPaymentRows)
        .innerJoin(invoices, eq(invoices.id, customerPaymentRows.invoiceId))
        .where(eq(customerPaymentRows.paymentId, paymentId))
        .orderBy(asc(customerPaymentRows.createdAt));
    },

    // Registration — ONE transaction, in this order and no other:
    //   1. allocate the BET number (tx-only, so a rejected registration rolls
    //      it back instead of burning it),
    //   2. row-lock the matched invoices (sorted ids + ORDER BY, the
    //      deadlock-free order invoice.repository.ts's
    //      validateCommittedQuantities established) — THIS is the
    //      serialization point: a concurrent registration against the same
    //      invoice blocks here and only then reads the open amounts,
    //   3. guard status/customer against the LOCKED rows,
    //   4. read the tolerance through this tx (readPostingSettings), and the
    //      open amounts through it too — after the lock, so what the rule
    //      decides on is what the writes below are committed against,
    //   5. apply the tolerance rule (the write-off is derived HERE, never
    //      taken from the client),
    //   6. insert header + rows,
    //   7. post the K verification (a pure kvittning books nothing and
    //      returns null — verificationId stays null),
    //   8. flip every fully settled invoice to paid, conditionally.
    //
    // The poster's own errors (locked/absent period, missing or inactive
    // account) are DELIBERATELY not caught: createPayment's catch only
    // normalizes this file's internal signals, so a posting failure takes the
    // whole registration with it.
    //
    // createPaymentInTx is the body, run in the CALLER's transaction (the bank
    // files book the bank entry and the payment together). It throws
    // PaymentGuardError; `link` is written in the payment's own INSERT, where
    // customer_payments_entry_live allows one live payment per bank entry.
    async createPaymentInTx(
      tx: Tx,
      header: PaymentHeaderWrite,
      rows: PaymentRowInput[],
      createdBy: string,
      poster: CustomerPaymentPoster,
      link: { bankFileEntryId: string } | null = null
    ): Promise<{ paymentId: string }> {
      const paymentNumber = await getNextOrderNumber(tx, "customer_payment");

      const invoiceIds = [...new Set(rows.map((row) => row.invoiceId))].sort();
      const locked = await tx
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          status: invoices.status,
          customerId: invoices.customerId,
          type: invoices.type,
          currency: invoices.currency,
          exchangeRate: invoices.exchangeRate,
          grossAmountSek: invoices.grossAmountSek,
          // Signed (credit notes negative), like the open amount.
          grossAmount: grossAmountSql,
        })
        .from(invoices)
        .where(inArray(invoices.id, invoiceIds))
        .orderBy(asc(invoices.id))
        .for("update");
      const lockedById = new Map(locked.map((invoice) => [invoice.id, invoice]));

      for (const row of rows) {
        const invoice = lockedById.get(row.invoiceId);
        if (!invoice) {
          throw new PaymentGuardError("invoice_not_found", { invoiceId: row.invoiceId, invoiceNumber: null });
        }
        const detail = { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber };
        // A payment belongs to ONE customer (spec): kvittning happens
        // within the customer, never across two.
        if (invoice.customerId !== header.customerId) throw new PaymentGuardError("wrong_customer", detail);
        // Reskontrans scope is exactly "issued" — a draft has no open
        // item yet, a paid one has none left, and an invoice marked paid
        // before B3 is deliberately never reopened by this path.
        if (invoice.status !== "issued") throw new PaymentGuardError("not_issued", detail);
      }

      // Valuta: one payment, one currency — the bank moves one amount in one
      // currency, and the SEK side below is read against it. A caller that
      // knows the currency (a bank entry) must find exactly that one.
      const currencies = [...new Set(locked.map((invoice) => invoice.currency))].sort();
      if (currencies.length > 1 || (header.currency !== null && currencies[0] !== header.currency)) {
        const first = locked[0]!;
        throw new PaymentGuardError("mixed_currencies", {
          invoiceId: first.id,
          invoiceNumber: first.invoiceNumber,
          currencies: header.currency !== null ? [...new Set([header.currency, ...currencies])].sort() : currencies,
        });
      }
      const currency = currencies[0]!;
      const sekGuard = (sekReason: CustomerPaymentSekReason) => {
        const first = locked[0]!;
        return new PaymentGuardError("amount_sek", { invoiceId: first.id, invoiceNumber: first.invoiceNumber, currency, sekReason });
      };
      const amount = round2(header.amount);
      let amountSek: number;
      let bankFeeSek: number;
      if (currency === SEK) {
        // A SEK payment moves exactly its amount and has no fee of its own.
        if (header.amountSek !== null && round2(header.amountSek) !== amount) throw sekGuard("sek");
        if (header.bankFeeSek !== null && round2(header.bankFeeSek) !== 0) throw sekGuard("sek");
        amountSek = amount;
        bankFeeSek = 0;
      } else if (amount === 0) {
        // A kvittning moves no money: nothing reached the bank, no fee.
        if ((header.amountSek !== null && round2(header.amountSek) !== 0) || (header.bankFeeSek !== null && round2(header.bankFeeSek) !== 0)) {
          throw sekGuard("kvittning");
        }
        amountSek = 0;
        bankFeeSek = 0;
      } else {
        if (header.amountSek === null) throw sekGuard("required");
        amountSek = round2(header.amountSek);
        if (amountSek === 0 || Math.sign(amountSek) !== Math.sign(amount)) throw sekGuard("sign");
        bankFeeSek = round2(header.bankFeeSek ?? 0);
        if (bankFeeSek < 0 || bankFeeSek > Math.abs(amountSek)) throw sekGuard("fee");
      }

      const settings = await readPostingSettings(tx);
      const tolerance = round2(settings.paymentTolerance);
      const openAmounts = await computeOpenAmounts(tx, invoiceIds);
      // Valuta: the SEK earlier live payments released from each invoice —
      // read under the same lock, so a settling row releases exactly the rest.
      const releasedBefore = await computeReleasedSek(tx, invoiceIds);

      // Decided against the LOCKED open amounts: the write-off is derived
      // here, never taken from the client.
      const writes = rows.map((row) => {
        const invoice = lockedById.get(row.invoiceId)!;
        const detail = { invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber };
        const open = round2(openAmounts.get(row.invoiceId) ?? 0);
        const applied = round2(row.appliedAmount);
        // The shared tolerance rule (packages/shared/src/payment-tolerance.ts) —
        // the same function the bank-file matching previews with. The
        // tolerance setting is kronor: on a foreign invoice it is what that
        // is worth in the invoice's currency at its rate.
        const rate = invoice.exchangeRate === null ? 1 : Number(invoice.exchangeRate);
        const result = applyPaymentTolerance(open, applied, toleranceInCurrency(tolerance, rate, invoice.currency));
        if (!result.ok) {
          if (result.reason === "not_open") throw new PaymentGuardError("not_open", detail);
          if (result.reason === "exceeds_open") throw new PaymentGuardError("exceeds_open", { ...detail, open, applied });
          // "zero" never reaches here (the service refuses it first); before the
          // extraction a zero applied amount was a sign mismatch, and it still is.
          throw new PaymentGuardError("sign_mismatch", detail);
        }
        // Valuta: frigjort SEK — signed like the amounts (a credit note's
        // receivable and releases are negative). gross_amount_sek is stamped
        // at Utfärda; the fallback covers an invoice issued without it.
        const grossAmount = Number(invoice.grossAmount);
        const sign = invoice.type === "credit" ? -1 : 1;
        const sek = releasedSek({
          currency: invoice.currency,
          grossAmount,
          grossAmountSek: invoice.grossAmountSek === null ? toSek(grossAmount, rate) : sign * Number(invoice.grossAmountSek),
          previouslyReleasedSek: releasedBefore.get(row.invoiceId) ?? 0,
          appliedAmount: applied,
          writeOffAmount: result.writeOffAmount,
          settles: result.settles,
        });
        return {
          invoiceId: row.invoiceId,
          appliedAmount: applied,
          writeOffAmount: result.writeOffAmount,
          appliedAmountSek: sek.appliedAmountSek,
          writeOffAmountSek: sek.writeOffAmountSek,
          settles: result.settles,
        };
      });

      const [payment] = await tx
        .insert(customerPayments)
        .values({
          paymentNumber,
          customerId: header.customerId,
          paymentDate: header.paymentDate,
          bankAccountNumber: header.bankAccountNumber,
          amount: String(amount),
          currency,
          amountSek: String(amountSek),
          bankFeeSek: String(bankFeeSek),
          note: header.note,
          createdBy,
          bankFileEntryId: link?.bankFileEntryId ?? null,
        })
        .returning();

      // createdAt is stamped explicitly, one tick per row, instead of
      // relying on the column's now()-default: Postgres evaluates now()
      // once per transaction, so every row in this single multi-row INSERT
      // would otherwise share the exact same timestamp and leave listRows'
      // ORDER BY createdAt without a tie-break (same fix as invoice_rows
      // and verification_rows).
      const now = Date.now();
      await tx.insert(customerPaymentRows).values(
        writes.map((write, index) => ({
          paymentId: payment!.id,
          invoiceId: write.invoiceId,
          appliedAmount: String(write.appliedAmount),
          writeOffAmount: String(write.writeOffAmount),
          appliedAmountSek: String(write.appliedAmountSek),
          writeOffAmountSek: String(write.writeOffAmountSek),
          createdAt: new Date(now + index),
        }))
      );

      const [customer] = await tx
        .select({ name: customers.name })
        .from(customers)
        .where(eq(customers.id, header.customerId));

      // null = the payment moved nothing in the ledger (a pure kvittning
      // between open items on the same receivable account). The payment
      // row with verificationId null IS the audit trail then — do not
      // infer it from the bank amount, a kvittning WITH a write-off does
      // book a verification at bank 0.
      const posted = await poster.postCustomerPayment(
        tx,
        {
          paymentNumber,
          paymentDate: header.paymentDate,
          bankAccountNumber: header.bankAccountNumber,
          bankAmount: amount,
          customerName: customer!.name,
          currency,
          bankAmountSek: amountSek,
          bankFeeSek,
        },
        writes.map((write) => ({
          appliedAmount: write.appliedAmount,
          writeOffAmount: write.writeOffAmount,
          appliedAmountSek: write.appliedAmountSek,
          writeOffAmountSek: write.writeOffAmountSek,
        })),
        createdBy
      );
      if (posted) {
        await tx
          .update(customerPayments)
          .set({ verificationId: posted.verificationId, updatedAt: new Date() })
          .where(eq(customerPayments.id, payment!.id));
      }

      // Conditional on status = "issued" for the same reason every other
      // transition in this module is: the invoice is row-locked here, but
      // stating the expected starting point keeps the write honest if the
      // lock is ever lost (and makes the flip a no-op rather than a
      // rewrite for anything already moved on).
      const settled = writes.filter((write) => write.settles);
      if (settled.length > 0) {
        const paidAt = new Date();
        const paid = await tx
          .update(invoices)
          .set({ status: "paid", paidAt, updatedAt: paidAt })
          .where(
            and(
              inArray(
                invoices.id,
                settled.map((write) => write.invoiceId)
              ),
              eq(invoices.status, "issued")
            )
          )
          .returning({ id: invoices.id, invoiceNumber: invoices.invoiceNumber });
        // Tillägg: invoice.paid for each invoice this registration settled.
        for (const invoice of paid) {
          await pluginEvents.emit(tx, { type: "invoice.paid", entityId: invoice.id, entityNumber: invoice.invoiceNumber });
        }
      }

      return { paymentId: payment!.id };
    },

    async createPayment(
      header: PaymentHeaderWrite,
      rows: PaymentRowInput[],
      createdBy: string,
      poster: CustomerPaymentPoster
    ): Promise<CreatePaymentResult> {
      try {
        const { paymentId } = await db.transaction((tx) =>
          repo.createPaymentInTx(tx, header, rows, createdBy, poster, null)
        );
        return { ok: true, paymentId };
      } catch (err) {
        if (err instanceof PaymentGuardError) {
          return { ok: false, reason: err.reason, ...err.detail };
        }
        throw err;
      }
    },

    // Makulering — the exact mirror of the registration, in ONE transaction:
    // lock the payment, lock its invoices (sorted, same order as above), book
    // the omföring (B2's supplier-invoice rule: an already BOOKED reversal is
    // reported and reused, an unbooked manual one collides with
    // verifications_reverses_unique and the 23505 propagates to the service as
    // a 409), stamp the cancellation, then reopen exactly those invoices whose
    // recomputed open amount is no longer zero.
    //
    // The stamp is written BEFORE the recompute on purpose: open-amounts.ts
    // counts non-cancelled payments only, so the rows this payment settled
    // stop counting the moment cancelledAt is set — which is what makes the
    // recompute see the reopened amounts inside this same transaction.
    //
    // opts.date dates the omföring (default: today) — for callers that carry
    // a date of their own, like the bank files.
    async cancelPayment(
      id: string,
      userId: string,
      poster: CustomerPaymentPoster,
      opts: { date?: string } = {}
    ): Promise<CancelPaymentResult> {
      try {
        return await db.transaction(async (tx) => {
          const [payment] = await tx
            .select()
            .from(customerPayments)
            .where(eq(customerPayments.id, id))
            .for("update");
          if (!payment) throw new CancelGuardError("not_found");
          if (payment.cancelledAt !== null) throw new CancelGuardError("already_cancelled");

          const rows = await tx
            .select({ invoiceId: customerPaymentRows.invoiceId })
            .from(customerPaymentRows)
            .where(eq(customerPaymentRows.paymentId, id));
          const invoiceIds = [...new Set(rows.map((row) => row.invoiceId))].sort();
          if (invoiceIds.length > 0) {
            await tx
              .select({ id: invoices.id })
              .from(invoices)
              .where(inArray(invoices.id, invoiceIds))
              .orderBy(asc(invoices.id))
              .for("update");
          }

          let cancellationVerificationId: string | null = null;
          if (payment.verificationId !== null) {
            const [customer] = await tx
              .select({ name: customers.name })
              .from(customers)
              .where(eq(customers.id, payment.customerId));
            const reversal = await poster.reverseBookedVerification(
              tx,
              payment.verificationId,
              {
                // Same today-in-sv-SE idiom as the supplier invoice's
                // cancellation and economy.service's reverse(): the omföring
                // is dated the cancellation day (or opts.date), so THAT day's
                // period must be open.
                date: opts.date ?? new Date().toLocaleDateString("sv-SE"),
                description: `Makulering betalning ${payment.paymentNumber} — ${customer!.name}`,
              },
              userId
            );
            // alreadyReversed: the correction already stands in the books
            // (a manual Omför that was booked), so the cancellation goes
            // through without a second omföring and without a link of its own.
            if ("verificationId" in reversal) cancellationVerificationId = reversal.verificationId;
          }

          const cancelledAt = new Date();
          await tx
            .update(customerPayments)
            .set({ cancelledAt, cancelledBy: userId, cancellationVerificationId, updatedAt: cancelledAt })
            .where(eq(customerPayments.id, id));

          const openAmounts = await computeOpenAmounts(tx, invoiceIds);
          const reopened = invoiceIds.filter((invoiceId) => round2(openAmounts.get(invoiceId) ?? 0) !== 0);
          if (reopened.length > 0) {
            // Conditional on status = "paid": an invoice this payment only
            // partly settled was never flipped and must not be touched, and
            // one somebody has since moved elsewhere is left alone.
            await tx
              .update(invoices)
              .set({ status: "issued", paidAt: null, updatedAt: new Date() })
              .where(and(inArray(invoices.id, reopened), eq(invoices.status, "paid")));
          }

          return { ok: true as const };
        });
      } catch (err) {
        if (err instanceof CancelGuardError) return { ok: false, reason: err.reason };
        throw err;
      }
    },
  };

  return repo;
}

export type PaymentRepository = ReturnType<typeof createPaymentRepository>;
