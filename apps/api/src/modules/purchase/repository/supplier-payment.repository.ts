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
  fiscalYears,
  paymentBatchItems,
  paymentBatches,
  suppliers,
  supplierInvoices,
  supplierPaymentRows,
  supplierPayments,
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
  type ListOpenSupplierInvoicesQuery,
  type ListSupplierPaymentsQuery,
} from "@navet/shared";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { readPostingSettings } from "../../system/service/posting-settings.js";
// Type-only (erased at compile time), so declaring the poster interface at the
// consuming service does not create a runtime import cycle — same seam as
// supplier-invoice.repository.ts's SupplierInvoicePoster.
import type { SupplierPaymentPoster } from "../service/supplier-payment.service.js";
import { computeOpenAmounts, computeReleasedSek, openItemAggregates } from "./open-amounts.js";

// Control-flow signals thrown INSIDE the transaction so everything it did (the
// UTB number, the payment rows, the U verification and its verifikatnummer)
// rolls back together instead of a guard failing after money was booked.
// createPayment/cancelPayment catch them immediately outside their own
// transaction and turn them into a discriminated `{ ok: false, reason }`
// result, the same convention as TransitionRaceError in
// supplier-invoice.repository.ts and PaymentGuardError in sales'
// payment.repository.ts — the SERVICE decides what error each reason becomes.
// Exported for the Tx seam (createPaymentInTx/cancelPaymentInTx): there the
// CALLER owns the transaction, so the signal propagates to the service, which
// translates it into the same domain errors.
export type SupplierPaymentGuardReason =
  | "invoice_not_found"
  | "not_approved"
  | "wrong_supplier"
  | "not_open"
  | "sign_mismatch"
  | "exceeds_open"
  // Bankfiler: the invoice is reserved in a live (pending/exported) batch row
  // other than the one paying it.
  | "reserved"
  // Bankfiler: the link names a batch row that is not an exported row of one
  // of the payment's own invoices (the seam defends itself, whoever calls).
  | "batch_link_mismatch"
  // Valuta: invoices in more than one currency on one payment.
  | "mixed_currencies"
  // Valuta: the SEK amount/fee does not fit the payment (detail.sekReason).
  | "amount_sek";

// Valuta: why the SEK amounts were refused — missing for a foreign payment,
// pointing the other way (or zero) than the amount, more fee than SEK moved,
// anything at all on a kvittning, or anything but the amount itself on a SEK
// payment.
export type SupplierPaymentSekReason = "required" | "sign" | "fee" | "kvittning" | "sek";

export type SupplierPaymentGuardDetail = {
  invoiceId: string;
  registrationNumber: string | null;
  open?: number;
  applied?: number;
  currencies?: string[];
  currency?: string;
  sekReason?: SupplierPaymentSekReason;
};

export class SupplierPaymentGuardError extends Error {
  constructor(
    public reason: SupplierPaymentGuardReason,
    // registrationNumber (LF-3) is the handle the messages name the invoice
    // by — the AP counterpart of the customer ledger's invoiceNumber, and the
    // one number that is unique across every supplier.
    public detail: SupplierPaymentGuardDetail
  ) {
    super(reason);
  }
}

export class CancelGuardError extends Error {
  constructor(public reason: "not_found" | "already_cancelled") {
    super(reason);
  }
}

// The booked verification's display number (U-2026-1), assembled from the
// joined series/fiscal year/number the same way economy.repository.ts formats
// it. `||` propagates NULL, so a payment with no verification (a pure
// kvittning) simply comes back null without a CASE. Used TWICE per payment —
// once for the payment's own verification, once for its cancellation omföring
// — so the joins below are aliased per role and this helper takes the three
// COLUMNS rather than the tables, which lets the aliased joins share it.
function displayNumberSql(seriesCode: SQLWrapper, yearLabel: SQLWrapper, verificationNumber: SQLWrapper) {
  return sql<string | null>`${seriesCode} || '-' || ${yearLabel} || '-' || ${verificationNumber}`;
}

export type SupplierPaymentHeaderWrite = {
  supplierId: string;
  paymentDate: string;
  bankAccountNumber: string;
  amount: number;
  // Valuta: as the client sent them (null = not sent) — what they must be
  // depends on the invoices' currency, known only under the lock.
  amountSek: number | null;
  bankFeeSek: number | null;
  note: string | null;
};

// What the client asked to settle: the cash part per open item. The write-off
// is derived inside the transaction (tolerance rule) and never taken from here.
export type SupplierPaymentRowInput = { supplierInvoiceId: string; appliedAmount: number };

export type CreateSupplierPaymentResult =
  | { ok: true; paymentId: string }
  | ({ ok: false; reason: SupplierPaymentGuardReason } & SupplierPaymentGuardDetail);

export type CancelSupplierPaymentResult = { ok: true } | { ok: false; reason: "not_found" | "already_cancelled" };

// Bankfiler: what a payment booked by the bank files points back to — the
// batch row it confirms (outgoing) and, for a camt confirmation, the bank
// entry. Written in the payment's own INSERT, never afterwards.
export type SupplierPaymentLink = { paymentBatchItemId: string; bankFileEntryId: string | null };

export function createSupplierPaymentRepository(db: Db) {
  // The payment + its cancellation omföring, each with its own three joins.
  const cancelVerifications = alias(verifications, "cancel_verifications");
  const cancelSeries = alias(verificationSeries, "cancel_verification_series");
  const cancelYears = alias(fiscalYears, "cancel_fiscal_years");

  const paymentColumns = {
    ...getTableColumns(supplierPayments),
    supplierName: suppliers.name,
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
    // Open items (approved, non-zero open amount). The open amount is computed
    // by openItemAggregates — the joined, list-shaped form of the SAME formula
    // computeOpenAmounts uses (open-amounts-list.test.ts pins the two against
    // each other) — so the list and the registration can never disagree about
    // what is left on an invoice. Ordered by due date ascending with NULLS
    // LAST (an invoice whose payment term produced no due date is not
    // "oldest"), then by the internal LF number so the order is total.
    async listOpenInvoices(query: ListOpenSupplierInvoicesQuery) {
      const agg = openItemAggregates(db);
      const conditions: SQL[] = [eq(supplierInvoices.status, "approved"), sql`${agg.openExpr} <> 0`];
      if (query.supplierId) conditions.push(eq(supplierInvoices.supplierId, query.supplierId));
      // NULL < CURRENT_DATE is NULL, so an invoice with no due date (a payment
      // term like "KONTANT", or one simply not typed in) drops out of the
      // overdue view without a separate IS NOT NULL.
      if (query.overdueOnly) conditions.push(sql`${supplierInvoices.dueDate} < CURRENT_DATE`);
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(
          or(
            ilike(supplierInvoices.registrationNumber, pattern),
            ilike(supplierInvoices.invoiceNumber, pattern),
            ilike(suppliers.name, pattern)
          )!
        );
      }
      const where = and(...conditions);
      // Bankfiler: the invoice's live (pending/exported) batch row — at most
      // one, the partial unique index payment_batch_items_invoice_live — so
      // the LEFT JOIN never multiplies a row.
      const liveItem = alias(paymentBatchItems, "live_batch_item");
      const liveBatch = alias(paymentBatches, "live_batch");
      const liveItemJoin = and(eq(liveItem.supplierInvoiceId, supplierInvoices.id), inArray(liveItem.status, ["pending", "exported"]));

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            id: supplierInvoices.id,
            registrationNumber: supplierInvoices.registrationNumber,
            invoiceNumber: supplierInvoices.invoiceNumber,
            supplierId: supplierInvoices.supplierId,
            // The LIVE supplier name: unlike the customer ledger, AP keeps no
            // name snapshot on the invoice (there is no such column and this
            // is not the place to invent one), so the join is the only source.
            supplierName: suppliers.name,
            invoiceDate: supplierInvoices.invoiceDate,
            dueDate: supplierInvoices.dueDate,
            // A header column entered off the paper invoice, already signed
            // (a credit note is a negative gross) — no row-derived total and
            // no type flip on this side, see open-amounts.ts.
            grossAmount: supplierInvoices.grossAmount,
            openAmount: agg.openExpr,
            // Valuta: the open item's currency (amounts above are in it), its
            // rate and the booked SEK values — the list's SEK column.
            currency: supplierInvoices.currency,
            exchangeRate: supplierInvoices.exchangeRate,
            grossAmountSek: supplierInvoices.grossAmountSek,
            openAmountSek: agg.openSekExpr,
            // What the batch picker needs: whether the supplier can be paid
            // by file at all, and which batch already holds the invoice.
            supplierPaymentMethod: suppliers.paymentMethod,
            supplierIban: suppliers.iban,
            paymentBatchId: liveBatch.id,
            paymentBatchNumber: liveBatch.batchNumber,
            paymentBatchStatus: liveBatch.status,
          })
          .from(supplierInvoices)
          .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
          .leftJoin(agg.settled, eq(agg.settled.supplierInvoiceId, supplierInvoices.id))
          .leftJoin(liveItem, liveItemJoin)
          .leftJoin(liveBatch, eq(liveBatch.id, liveItem.batchId))
          .where(where)
          // Secondary sort is createdAt, not the registrationNumber text —
          // LF numbers sort lexicographically ("LF-10" before "LF-2"), but
          // insertion order matches numbering order (numbers are minted
          // sequentially at creation) and createdAt sorts correctly
          // regardless of digit count.
          .orderBy(sql`${supplierInvoices.dueDate} ASC NULLS LAST`, asc(supplierInvoices.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(supplierInvoices)
          .innerJoin(suppliers, eq(suppliers.id, supplierInvoices.supplierId))
          .leftJoin(agg.settled, eq(agg.settled.supplierInvoiceId, supplierInvoices.id))
          .leftJoin(liveItem, liveItemJoin)
          .where(where),
      ]);
      return {
        rows: rows.map(({ paymentBatchId, paymentBatchNumber, paymentBatchStatus, ...row }) => ({
          ...row,
          grossAmount: Number(row.grossAmount),
          openAmount: Number(row.openAmount),
          exchangeRate: Number(row.exchangeRate),
          grossAmountSek: row.grossAmountSek === null ? null : Number(row.grossAmountSek),
          openAmountSek: row.openAmountSek === null ? null : Number(row.openAmountSek),
          paymentBatch: paymentBatchId ? { id: paymentBatchId, batchNumber: paymentBatchNumber!, status: paymentBatchStatus! } : null,
        })),
        total: totalRows[0]!.total,
      };
    },

    async list(query: ListSupplierPaymentsQuery) {
      const conditions: SQL[] = [];
      if (query.supplierId) conditions.push(eq(supplierPayments.supplierId, query.supplierId));
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(or(ilike(supplierPayments.paymentNumber, pattern), ilike(suppliers.name, pattern))!);
      }
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select(paymentColumns)
          .from(supplierPayments)
          .innerJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId))
          .leftJoin(verifications, eq(verifications.id, supplierPayments.verificationId))
          .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
          .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
          .leftJoin(cancelVerifications, eq(cancelVerifications.id, supplierPayments.cancellationVerificationId))
          .leftJoin(cancelSeries, eq(cancelSeries.id, cancelVerifications.seriesId))
          .leftJoin(cancelYears, eq(cancelYears.id, cancelVerifications.fiscalYearId))
          .where(where)
          .orderBy(desc(supplierPayments.createdAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(supplierPayments)
          .innerJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId))
          .where(where),
      ]);
      return { rows, total: totalRows[0]!.total };
    },

    // The detail also names the batch row a bank-file payment confirms
    // (spec §4.6) — the list keeps paymentColumns only.
    async findById(id: string) {
      const [found] = await db
        .select({
          ...paymentColumns,
          batchItemBatchId: paymentBatchItems.batchId,
          batchItemEndToEndId: paymentBatchItems.endToEndId,
          batchNumber: paymentBatches.batchNumber,
          entryBankFileId: bankFileEntries.bankFileId,
          entryDedupeKey: bankFileEntries.dedupeKey,
          entryFilename: bankFiles.filename,
        })
        .from(supplierPayments)
        .innerJoin(suppliers, eq(suppliers.id, supplierPayments.supplierId))
        .leftJoin(paymentBatchItems, eq(paymentBatchItems.id, supplierPayments.paymentBatchItemId))
        .leftJoin(paymentBatches, eq(paymentBatches.id, paymentBatchItems.batchId))
        // Bankfiler: the camt.054 debit entry that confirmed this payment.
        .leftJoin(bankFileEntries, eq(bankFileEntries.id, supplierPayments.bankFileEntryId))
        .leftJoin(bankFiles, eq(bankFiles.id, bankFileEntries.bankFileId))
        .leftJoin(verifications, eq(verifications.id, supplierPayments.verificationId))
        .leftJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
        .leftJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
        .leftJoin(cancelVerifications, eq(cancelVerifications.id, supplierPayments.cancellationVerificationId))
        .leftJoin(cancelSeries, eq(cancelSeries.id, cancelVerifications.seriesId))
        .leftJoin(cancelYears, eq(cancelYears.id, cancelVerifications.fiscalYearId))
        .where(eq(supplierPayments.id, id));
      if (!found) return null;
      const { batchItemBatchId, batchItemEndToEndId, batchNumber, entryBankFileId, entryDedupeKey, entryFilename, ...row } = found;
      return {
        ...row,
        paymentBatchItem:
          row.paymentBatchItemId && batchItemBatchId
            ? { id: row.paymentBatchItemId, batchId: batchItemBatchId, batchNumber: batchNumber!, endToEndId: batchItemEndToEndId! }
            : null,
        bankFileEntry:
          row.bankFileEntryId && entryBankFileId
            ? { bankFileId: entryBankFileId, filename: entryFilename!, dedupeKey: entryDedupeKey! }
            : null,
      };
    },

    // The settled open items, in registration order (the strictly increasing
    // createdAt stamps written below are what makes that order deterministic).
    async listRows(paymentId: string) {
      return db
        .select({
          ...getTableColumns(supplierPaymentRows),
          registrationNumber: supplierInvoices.registrationNumber,
          invoiceNumber: supplierInvoices.invoiceNumber,
          invoiceDueDate: supplierInvoices.dueDate,
          invoiceExchangeRate: supplierInvoices.exchangeRate,
        })
        .from(supplierPaymentRows)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierPaymentRows.supplierInvoiceId))
        .where(eq(supplierPaymentRows.paymentId, paymentId))
        .orderBy(asc(supplierPaymentRows.createdAt));
    },

    // Registration — ONE transaction, in this order and no other:
    //   1. allocate the UTB number (tx-only, so a rejected registration rolls
    //      it back instead of burning it),
    //   2. row-lock the matched supplier invoices (sorted ids + ORDER BY, the
    //      deadlock-free order invoice.repository.ts's
    //      validateCommittedQuantities established) — THIS is the
    //      serialization point: a concurrent registration against the same
    //      invoice blocks here and only then reads the open amounts,
    //   3. guard status/supplier against the LOCKED rows, and the batch
    //      reservation (bankfiler) under the same lock,
    //   4. read the tolerance through this tx (readPostingSettings), and the
    //      open amounts through it too — after the lock, so what the rule
    //      decides on is what the writes below are committed against,
    //   5. apply the tolerance rule (the write-off is derived HERE, never
    //      taken from the client),
    //   6. insert header + rows,
    //   7. post the U verification (a pure kvittning books nothing and
    //      returns null — verificationId stays null),
    //   8. flip every fully settled invoice to paid, conditionally.
    //
    // The poster's own errors (locked/absent period, missing or inactive
    // account, a betalkonto that collides with the payable/write-off account)
    // are DELIBERATELY not caught: createPayment's catch only normalizes this
    // file's internal signals, so a posting failure takes the whole
    // registration with it.
    //
    // createPaymentInTx is the body, run in the CALLER's transaction (the bank
    // files book the batch row / bank entry and the payment together). It
    // throws SupplierPaymentGuardError; `link` is written in the payment's own
    // INSERT and its batch row is the one reservation allowed to pay.
    async createPaymentInTx(
      tx: Tx,
      header: SupplierPaymentHeaderWrite,
      rows: SupplierPaymentRowInput[],
      createdBy: string,
      poster: SupplierPaymentPoster,
      link: SupplierPaymentLink | null = null
    ): Promise<{ paymentId: string }> {
      const paymentNumber = await getNextOrderNumber(tx, "supplier_payment");

      const invoiceIds = [...new Set(rows.map((row) => row.supplierInvoiceId))].sort();
      const locked = await tx
        .select({
          id: supplierInvoices.id,
          registrationNumber: supplierInvoices.registrationNumber,
          status: supplierInvoices.status,
          supplierId: supplierInvoices.supplierId,
          currency: supplierInvoices.currency,
          exchangeRate: supplierInvoices.exchangeRate,
          grossAmount: supplierInvoices.grossAmount,
          grossAmountSek: supplierInvoices.grossAmountSek,
        })
        .from(supplierInvoices)
        .where(inArray(supplierInvoices.id, invoiceIds))
        .orderBy(asc(supplierInvoices.id))
        .for("update");
      const lockedById = new Map(locked.map((invoice) => [invoice.id, invoice]));

      for (const row of rows) {
        const invoice = lockedById.get(row.supplierInvoiceId);
        if (!invoice) {
          throw new SupplierPaymentGuardError("invoice_not_found", {
            invoiceId: row.supplierInvoiceId,
            registrationNumber: null,
          });
        }
        const detail = { invoiceId: invoice.id, registrationNumber: invoice.registrationNumber };
        // A payment belongs to ONE supplier (spec): kvittning happens
        // within the supplier, never across two.
        if (invoice.supplierId !== header.supplierId) {
          throw new SupplierPaymentGuardError("wrong_supplier", detail);
        }
        // Reskontrans scope is exactly "approved" — a draft is not an
        // obligation yet, a cancelled one never was, and an invoice marked
        // paid before B4 is deliberately never reopened by this path.
        if (invoice.status !== "approved") throw new SupplierPaymentGuardError("not_approved", detail);
      }

      // Valuta: one payment, one currency — the bank moves one amount in one
      // currency, and the SEK side below is read against it.
      const currencies = [...new Set(locked.map((invoice) => invoice.currency))].sort();
      if (currencies.length > 1) {
        const first = locked[0]!;
        throw new SupplierPaymentGuardError("mixed_currencies", {
          invoiceId: first.id,
          registrationNumber: first.registrationNumber,
          currencies,
        });
      }
      const currency = currencies[0]!;
      const sekGuard = (sekReason: SupplierPaymentSekReason) => {
        const first = locked[0]!;
        return new SupplierPaymentGuardError("amount_sek", {
          invoiceId: first.id,
          registrationNumber: first.registrationNumber,
          currency,
          sekReason,
        });
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
        // A kvittning moves no money: nothing left the bank, no fee.
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

      // Bankfiler: an invoice reserved in a live batch row (pending/
      // exported) is paid by that row's confirmation only — anything else
      // would pay it twice when the bank confirms. Read under the invoice
      // lock taken above; the batch's own confirmation passes its row id.
      const reservations = await tx
        .select({ itemId: paymentBatchItems.id, invoiceId: paymentBatchItems.supplierInvoiceId, status: paymentBatchItems.status })
        .from(paymentBatchItems)
        .where(
          and(
            inArray(paymentBatchItems.supplierInvoiceId, invoiceIds),
            inArray(paymentBatchItems.status, ["pending", "exported"])
          )
        );
      for (const reservation of reservations) {
        if (reservation.itemId !== link?.paymentBatchItemId) {
          const invoice = lockedById.get(reservation.invoiceId)!;
          throw new SupplierPaymentGuardError("reserved", {
            invoiceId: invoice.id,
            registrationNumber: invoice.registrationNumber,
          });
        }
      }
      // The link itself must be one of those live rows — reserving one of
      // THIS payment's invoices — and sent to the bank (exported). A link to
      // another invoice's row, a pending (never exported) row or one already
      // confirmed/rejected would book a UTB the batch does not account for.
      if (link) {
        const own = reservations.find((reservation) => reservation.itemId === link.paymentBatchItemId);
        if (!own || own.status !== "exported") {
          const invoice = lockedById.get(invoiceIds[0]!)!;
          throw new SupplierPaymentGuardError("batch_link_mismatch", {
            invoiceId: invoice.id,
            registrationNumber: invoice.registrationNumber,
          });
        }
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
        const invoice = lockedById.get(row.supplierInvoiceId)!;
        const detail = { invoiceId: invoice.id, registrationNumber: invoice.registrationNumber };
        const open = round2(openAmounts.get(row.supplierInvoiceId) ?? 0);
        const applied = round2(row.appliedAmount);
        // The shared tolerance rule (packages/shared/src/payment-tolerance.ts) —
        // the same function the bank-file matching previews with. The
        // tolerance setting is kronor: on a foreign invoice it is what that is
        // worth in the invoice's currency at its rate.
        const result = applyPaymentTolerance(
          open,
          applied,
          toleranceInCurrency(tolerance, Number(invoice.exchangeRate), invoice.currency)
        );
        if (!result.ok) {
          if (result.reason === "not_open") throw new SupplierPaymentGuardError("not_open", detail);
          if (result.reason === "exceeds_open") {
            throw new SupplierPaymentGuardError("exceeds_open", { ...detail, open, applied });
          }
          // "zero" never reaches here (the service refuses it first); before the
          // extraction a zero applied amount was a sign mismatch, and it still is.
          throw new SupplierPaymentGuardError("sign_mismatch", detail);
        }
        const grossAmount = Number(invoice.grossAmount);
        const sek = releasedSek({
          currency: invoice.currency,
          grossAmount,
          // Stamped at attest; the fallback covers an invoice attested before
          // migration 0143 that the backfill could not reach (none expected).
          grossAmountSek: invoice.grossAmountSek === null ? toSek(grossAmount, Number(invoice.exchangeRate)) : Number(invoice.grossAmountSek),
          previouslyReleasedSek: releasedBefore.get(row.supplierInvoiceId) ?? 0,
          appliedAmount: applied,
          writeOffAmount: result.writeOffAmount,
          settles: result.settles,
        });
        return {
          supplierInvoiceId: row.supplierInvoiceId,
          appliedAmount: applied,
          writeOffAmount: result.writeOffAmount,
          appliedAmountSek: sek.appliedAmountSek,
          writeOffAmountSek: sek.writeOffAmountSek,
          settles: result.settles,
        };
      });

      const [payment] = await tx
        .insert(supplierPayments)
        .values({
          paymentNumber,
          supplierId: header.supplierId,
          paymentDate: header.paymentDate,
          bankAccountNumber: header.bankAccountNumber,
          amount: String(amount),
          currency,
          amountSek: String(amountSek),
          bankFeeSek: String(bankFeeSek),
          note: header.note,
          createdBy,
          paymentBatchItemId: link?.paymentBatchItemId ?? null,
          bankFileEntryId: link?.bankFileEntryId ?? null,
        })
        .returning();

      // createdAt is stamped explicitly, one tick per row, instead of
      // relying on the column's now()-default: Postgres evaluates now()
      // once per transaction, so every row in this single multi-row INSERT
      // would otherwise share the exact same timestamp and leave listRows'
      // ORDER BY createdAt without a tie-break (same fix as
      // supplier_invoice_rows and verification_rows).
      const now = Date.now();
      await tx.insert(supplierPaymentRows).values(
        writes.map((write, index) => ({
          paymentId: payment!.id,
          supplierInvoiceId: write.supplierInvoiceId,
          appliedAmount: String(write.appliedAmount),
          writeOffAmount: String(write.writeOffAmount),
          appliedAmountSek: String(write.appliedAmountSek),
          writeOffAmountSek: String(write.writeOffAmountSek),
          createdAt: new Date(now + index),
        }))
      );

      const [supplier] = await tx
        .select({ name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.id, header.supplierId));

      // null = the payment moved nothing in the ledger (a pure kvittning
      // between open items on the same payable account). The payment row
      // with verificationId null IS the audit trail then — do not infer it
      // from the bank amount, a kvittning WITH a write-off does book a
      // verification at bank 0.
      const posted = await poster.postSupplierPayment(
        tx,
        {
          paymentNumber,
          paymentDate: header.paymentDate,
          bankAccountNumber: header.bankAccountNumber,
          bankAmount: amount,
          supplierName: supplier!.name,
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
          .update(supplierPayments)
          .set({ verificationId: posted.verificationId, updatedAt: new Date() })
          .where(eq(supplierPayments.id, payment!.id));
      }

      // Conditional on status = "approved" for the same reason every other
      // transition in this module is: the invoice is row-locked here, but
      // stating the expected starting point keeps the write honest if the
      // lock is ever lost (and makes the flip a no-op rather than a
      // rewrite for anything already moved on).
      const settled = writes.filter((write) => write.settles);
      if (settled.length > 0) {
        const paidAt = new Date();
        await tx
          .update(supplierInvoices)
          .set({ status: "paid", paidAt, updatedAt: paidAt })
          .where(
            and(
              inArray(
                supplierInvoices.id,
                settled.map((write) => write.supplierInvoiceId)
              ),
              eq(supplierInvoices.status, "approved")
            )
          );
      }

      return { paymentId: payment!.id };
    },

    async createPayment(
      header: SupplierPaymentHeaderWrite,
      rows: SupplierPaymentRowInput[],
      createdBy: string,
      poster: SupplierPaymentPoster
    ): Promise<CreateSupplierPaymentResult> {
      try {
        const { paymentId } = await db.transaction((tx) =>
          repo.createPaymentInTx(tx, header, rows, createdBy, poster, null)
        );
        return { ok: true, paymentId };
      } catch (err) {
        if (err instanceof SupplierPaymentGuardError) {
          return { ok: false, reason: err.reason, ...err.detail };
        }
        throw err;
      }
    },

    // Makulering — the exact mirror of the registration, in ONE transaction:
    // lock its batch row (if any) and the payment, lock its invoices (sorted, same order as above), book
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
    // cancelPaymentInTx is the body, run in the CALLER's transaction (the
    // bank files' return path); it throws CancelGuardError. opts.date dates
    // the omföring (default: today). A batch payment leaves its row
    // "returned".
    async cancelPaymentInTx(
      tx: Tx,
      id: string,
      userId: string,
      poster: SupplierPaymentPoster,
      opts: { date?: string } = {}
    ): Promise<{ paymentBatchItemId: string | null }> {
      // Låsordning: omgångsrad → betalning → fakturor — the same order
      // the bank files' return path takes (omgång → omgångsrad →
      // betalning), so a return and a manual Makulera of the same UTB
      // cannot deadlock. The link is read WITHOUT a lock first: it is
      // written in the payment's INSERT and never changes afterwards, so
      // the row it names is the one to lock before the payment.
      const [linked] = await tx
        .select({ paymentBatchItemId: supplierPayments.paymentBatchItemId })
        .from(supplierPayments)
        .where(eq(supplierPayments.id, id));
      if (linked?.paymentBatchItemId) {
        await tx
          .select({ id: paymentBatchItems.id })
          .from(paymentBatchItems)
          .where(eq(paymentBatchItems.id, linked.paymentBatchItemId))
          .for("update");
      }

      const [payment] = await tx
        .select()
        .from(supplierPayments)
        .where(eq(supplierPayments.id, id))
        .for("update");
      if (!payment) throw new CancelGuardError("not_found");
      if (payment.cancelledAt !== null) throw new CancelGuardError("already_cancelled");

      const rows = await tx
        .select({ supplierInvoiceId: supplierPaymentRows.supplierInvoiceId })
        .from(supplierPaymentRows)
        .where(eq(supplierPaymentRows.paymentId, id));
      const invoiceIds = [...new Set(rows.map((row) => row.supplierInvoiceId))].sort();
      if (invoiceIds.length > 0) {
        await tx
          .select({ id: supplierInvoices.id })
          .from(supplierInvoices)
          .where(inArray(supplierInvoices.id, invoiceIds))
          .orderBy(asc(supplierInvoices.id))
          .for("update");
      }

      let cancellationVerificationId: string | null = null;
      if (payment.verificationId !== null) {
        const [supplier] = await tx
          .select({ name: suppliers.name })
          .from(suppliers)
          .where(eq(suppliers.id, payment.supplierId));
        const reversal = await poster.reverseBookedVerification(
          tx,
          payment.verificationId,
          {
            // Same today-in-sv-SE idiom as the supplier invoice's
            // cancellation and economy.service's reverse(): the omföring
            // is dated the cancellation day (or opts.date, e.g. the
            // bank's booking day of a return), so THAT day's period must
            // be open.
            date: opts.date ?? new Date().toLocaleDateString("sv-SE"),
            description: `Makulering betalning ${payment.paymentNumber} — ${supplier!.name}`,
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
        .update(supplierPayments)
        .set({ cancelledAt, cancelledBy: userId, cancellationVerificationId, updatedAt: cancelledAt })
        .where(eq(supplierPayments.id, id));

      // A batch payment that is cancelled — by the bank's return or by
      // hand — leaves its row "returned": the money came back (or the
      // confirmation was wrong) and the invoice is an open item again.
      if (payment.paymentBatchItemId !== null) {
        await tx
          .update(paymentBatchItems)
          .set({ status: "returned", updatedAt: new Date() })
          .where(
            and(eq(paymentBatchItems.id, payment.paymentBatchItemId), eq(paymentBatchItems.status, "confirmed"))
          );
      }

      const openAmounts = await computeOpenAmounts(tx, invoiceIds);
      const reopened = invoiceIds.filter((invoiceId) => round2(openAmounts.get(invoiceId) ?? 0) !== 0);
      if (reopened.length > 0) {
        // Conditional on status = "paid": an invoice this payment only
        // partly settled was never flipped and must not be touched, and
        // one somebody has since moved elsewhere is left alone.
        await tx
          .update(supplierInvoices)
          .set({ status: "approved", paidAt: null, updatedAt: new Date() })
          .where(and(inArray(supplierInvoices.id, reopened), eq(supplierInvoices.status, "paid")));
      }

      return { paymentBatchItemId: payment.paymentBatchItemId };
    },

    // opts.date dates the omföring (default: today) — same optional date as
    // sales' cancelPayment (C1).
    async cancelPayment(
      id: string,
      userId: string,
      poster: SupplierPaymentPoster,
      opts: { date?: string } = {}
    ): Promise<CancelSupplierPaymentResult> {
      try {
        await db.transaction((tx) => repo.cancelPaymentInTx(tx, id, userId, poster, opts));
        return { ok: true };
      } catch (err) {
        if (err instanceof CancelGuardError) return { ok: false, reason: err.reason };
        throw err;
      }
    },
  };

  return repo;
}

export type SupplierPaymentRepository = ReturnType<typeof createSupplierPaymentRepository>;
