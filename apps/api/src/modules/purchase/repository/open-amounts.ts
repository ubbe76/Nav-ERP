import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { supplierInvoices, supplierPaymentRows, supplierPayments, type Db, type Tx } from "@navet/db";

// Leverantörsreskontra (B4): THE aggregation authority for "what is still
// open on this supplier invoice" — mirrors sales' open-amounts.ts (B3), same
// derivation-not-storage rule (arkitekturprincip 1, "raderna är facit"),
// adapted for AP.
//
//   open = "supplier_invoices"."gross_amount"
//        − Σ supplier_payment_rows(appliedAmount + writeOffAmount)   [1]
//
// [1] over NON-CANCELLED payments only — a cancelled payment's rows stay in
//     the table (append-only) but stop settling anything, which is exactly
//     what reopens the invoice.
//
// AP vs AR difference: sales' mirror derives its gross from invoice_rows via
// grossAmountSql, because invoices.type ('credit') flips the sign of summed
// row amounts that are themselves always stored positive. Here there is no
// such derivation and no grossAmountSql at all — supplier_invoices.gross_amount
// is a HEADER column entered straight off the paper invoice (see its own
// comment: "the source of truth so freight/rounding on the paper invoice
// always reconciles"), and it is signed already: a credit note is simply a
// supplier invoice with a negative gross_amount, no separate type column and
// no sign flip to apply here. Rows are optional/IO-matching only and never
// feed this arithmetic. There is also no reminder term — B4 has no
// leverantörspåminnelse.
//
// IDENTIFIERS ARE SPELLED OUT inside the correlated subquery below instead of
// being interpolated from the schema objects. Drizzle only qualifies an
// interpolated column with its table name when the surrounding query has
// joins; a single-table caller (computeOpenAmounts) gets a BARE column name,
// which inside this subquery would bind to the subquery's own table —
// `supplierInvoices.id` rendered as "id" resolves to supplier_payment_rows.id,
// wrong rather than merely ambiguous. The correlation target is therefore
// written "supplier_invoices"."id" verbatim, which also fixes the one thing
// callers must respect: SELECT FROM the supplier_invoices table UNALIASED.

// Correlated on the `supplier_invoices` row in the surrounding query — the
// right tool for single ids (computeOpenAmounts below); the open-items LIST
// uses openItemAggregates instead.
export const openAmountSql = sql<string>`(
  "supplier_invoices"."gross_amount"
  - COALESCE((
      SELECT SUM(spr.applied_amount + spr.write_off_amount)
      FROM supplier_payment_rows spr
      JOIN supplier_payments sp ON sp.id = spr.payment_id
      WHERE spr.supplier_invoice_id = "supplier_invoices"."id"
        AND sp.cancelled_at IS NULL
    ), 0)
)`;

// The open-items LIST's version of openAmountSql — see sales' twin. AP has no
// row-derived gross and no reminder term: gross_amount is the signed header.
// SCOPED TO APPROVED INVOICES for the same reason as the twin (the outer
// status filter is not pushed into the GROUP BY): only use it in a query
// that itself is restricted to status = 'approved'.
export function openItemAggregates(executor: Db | Tx) {
  const approved = executor
    .select({ id: supplierInvoices.id })
    .from(supplierInvoices)
    .where(eq(supplierInvoices.status, "approved"));
  const settled = executor
    .select({
      supplierInvoiceId: supplierPaymentRows.supplierInvoiceId,
      total: sql<string>`SUM(${supplierPaymentRows.appliedAmount} + ${supplierPaymentRows.writeOffAmount})`.as("settled_total"),
      totalSek: sql<string>`SUM(${supplierPaymentRows.appliedAmountSek} + ${supplierPaymentRows.writeOffAmountSek})`.as(
        "settled_total_sek"
      ),
    })
    .from(supplierPaymentRows)
    .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentRows.paymentId))
    .where(and(isNull(supplierPayments.cancelledAt), inArray(supplierPaymentRows.supplierInvoiceId, approved)))
    .groupBy(supplierPaymentRows.supplierInvoiceId)
    .as("open_settled");
  const openExpr = sql<string>`(${supplierInvoices.grossAmount} - COALESCE(${settled.total}, 0))`;
  // Valuta: the same open item's booked SEK value.
  const openSekExpr = sql<string | null>`(${supplierInvoices.grossAmountSek} - COALESCE(${settled.totalSek}, 0))`;
  return { settled, openExpr, openSekExpr };
}

// Valuta: the SEK side of the same derivation —
//
//   open SEK = gross_amount_sek − Σ live supplier_payment_rows(applied_amount_sek + write_off_amount_sek)
//
// gross_amount_sek is the debt the attest booked (null in draft ⇒ null), and
// each payment row stores the SEK it released (frigjort SEK). For a SEK
// invoice both sides equal the open amount above.
export const openAmountSekSql = sql<string | null>`(
  "supplier_invoices"."gross_amount_sek"
  - COALESCE((
      SELECT SUM(spr.applied_amount_sek + spr.write_off_amount_sek)
      FROM supplier_payment_rows spr
      JOIN supplier_payments sp ON sp.id = spr.payment_id
      WHERE spr.supplier_invoice_id = "supplier_invoices"."id"
        AND sp.cancelled_at IS NULL
    ), 0)
)`;

// Open SEK value per invoice id (null for one without a stamped debt).
export async function computeOpenAmountsSek(executor: Db | Tx, invoiceIds: string[]): Promise<Map<string, number | null>> {
  const open = new Map<string, number | null>(invoiceIds.map((id) => [id, null]));
  if (invoiceIds.length === 0) return open;
  const rows = await executor
    .select({ id: supplierInvoices.id, openAmountSek: openAmountSekSql })
    .from(supplierInvoices)
    .where(inArray(supplierInvoices.id, invoiceIds));
  for (const row of rows) open.set(row.id, row.openAmountSek === null ? null : Number(row.openAmountSek));
  return open;
}

// The SEK already released from each invoice by live (non-cancelled)
// payments — what a settling row subtracts from gross_amount_sek
// (@navet/shared releasedSek). Called inside the registration's transaction
// after the invoices are row-locked, like computeOpenAmounts.
export async function computeReleasedSek(executor: Db | Tx, invoiceIds: string[]): Promise<Map<string, number>> {
  const released = new Map<string, number>(invoiceIds.map((id) => [id, 0]));
  if (invoiceIds.length === 0) return released;
  const rows = await executor
    .select({
      supplierInvoiceId: supplierPaymentRows.supplierInvoiceId,
      total: sql<string>`SUM(${supplierPaymentRows.appliedAmountSek} + ${supplierPaymentRows.writeOffAmountSek})`,
    })
    .from(supplierPaymentRows)
    .innerJoin(supplierPayments, eq(supplierPayments.id, supplierPaymentRows.paymentId))
    .where(and(isNull(supplierPayments.cancelledAt), inArray(supplierPaymentRows.supplierInvoiceId, invoiceIds)))
    .groupBy(supplierPaymentRows.supplierInvoiceId);
  for (const row of rows) released.set(row.supplierInvoiceId, Number(row.total));
  return released;
}

// Open amount per supplier invoice id, as numbers (kr). Takes a Db or a Tx:
// the payment registration calls it from INSIDE its own transaction, after
// the matched invoices are row-locked, so what it reads is what the
// tolerance rule and the paid-flip are decided on — the same Db|Tx-composable
// seam as number-series.ts's getNextOrderNumber and readPostingSettings.
//
// Every requested id gets an entry; an id that is not a supplier invoice at
// all comes back 0 (callers verify existence themselves — createPayment does
// it with the same locked read it needs anyway).
export async function computeOpenAmounts(executor: Db | Tx, invoiceIds: string[]): Promise<Map<string, number>> {
  const open = new Map<string, number>(invoiceIds.map((id) => [id, 0]));
  if (invoiceIds.length === 0) return open;

  const rows = await executor
    .select({ id: supplierInvoices.id, openAmount: openAmountSql })
    .from(supplierInvoices)
    .where(inArray(supplierInvoices.id, invoiceIds));
  for (const row of rows) open.set(row.id, Number(row.openAmount));
  return open;
}

// Årsbokslut (steg 1): the leverantörsreskontra AS OF a date — an attested
// invoice counts from its L verification's date until it is CANCELLED with a
// BOOKED omföring dated on or before `date`; payments follow the same rule as
// the kundreskontra's (sales open-amounts.ts receivablesTotalAsOf). Only a
// cancelled invoice leaves the register: a manual Omför of the L verification
// alone leaves the invoice approved and open everywhere else, so the register
// must keep it too — the ledger loses it and the reconciliation shows the gap.
//
// Valuta: in SEK — Σ gross_amount_sek (the debt each L verification booked)
// − Σ frigjort SEK (applied_amount_sek + write_off_amount_sek), so an EUR
// and a SEK invoice are never summed in their own currencies and the total
// reconciles with the payable account (the exchange differences are booked
// on 3960/7960, never on it).
export async function payablesTotalAsOf(executor: Db | Tx, date: string): Promise<number> {
  const rows = await executor.execute(sql`
    SELECT
      COALESCE((
        SELECT SUM(si.gross_amount_sek)
        FROM supplier_invoices si
        JOIN verifications v ON v.id = si.verification_id
        WHERE v.date <= ${date}
          AND NOT (si.status = 'cancelled' AND EXISTS (
            SELECT 1 FROM verifications r
            WHERE r.reverses_verification_id = si.verification_id
              AND r.status = 'booked'
              AND r.date <= ${date}
          ))
      ), 0)
      - COALESCE((
        SELECT SUM(spr.applied_amount_sek + spr.write_off_amount_sek)
        FROM supplier_payment_rows spr
        JOIN supplier_payments sp ON sp.id = spr.payment_id
        LEFT JOIN verifications cv ON cv.id = sp.cancellation_verification_id
        WHERE sp.payment_date <= ${date}
          AND (sp.cancelled_at IS NULL
               OR COALESCE(cv.date, (sp.cancelled_at AT TIME ZONE 'Europe/Stockholm')::date) > ${date})
      ), 0) AS total
  `);
  // postgres-js: db.execute returns an array of rows.
  const [row] = [...rows] as { total: string }[];
  return Math.round(Number(row?.total ?? 0) * 100) / 100;
}
