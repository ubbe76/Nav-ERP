import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { customerPaymentRows, customerPayments, invoiceReminders, invoiceRows, invoices, type Db, type Tx } from "@navet/db";

// Kundreskontra (B3): THE aggregation authority for "what is still open on
// this invoice". There is no stored balance column anywhere — the open amount
// is derived from the rows every single time (arkitekturprincip 1, "raderna är
// facit"), and every consumer (the open-items list, the OCR lookup, the
// tolerance rule, the paid-flip, the reopen on cancellation and Task 6's
// reminders) goes through this file so they can never disagree.
//
//   open = sign(type) · Σ invoice_rows(lineAmount + vatAmount)
//        − Σ customer_payment_rows(appliedAmount + writeOffAmount)      [1]
//        + Σ invoice_reminders(fee)                                     [2]
//
// [1] over NON-CANCELLED payments only — a cancelled payment's rows stay in
//     the table (append-only) but stop settling anything, which is exactly
//     what reopens the invoice.
// [2] the statutory påminnelseavgift (B3 Task 6) is charged ONTO the open
//     item, not invoiced separately: the fee raises what the customer owes,
//     so the invoice stays open (and keeps showing up in the förfallolista)
//     until invoice AND fee are settled. It is always POSITIVE and always
//     added — a reminder can only be sent for an invoice with a positive open
//     amount (sendReminder's own guard), never for a credit note, so there is
//     no sign convention to mirror here. There is at most one fee row per
//     invoice (partial unique index invoice_reminders_one_fee), but the SUM
//     is written anyway: the aggregation must not depend on that index for
//     its arithmetic to be right.
//
// IDENTIFIERS ARE SPELLED OUT inside the correlated subqueries below instead
// of being interpolated from the schema objects. Drizzle only qualifies an
// interpolated column with its table name when the surrounding query has
// joins; a single-table caller (computeOpenAmounts) gets a BARE column name,
// which inside these subqueries would bind to the subquery's own table —
// `invoices.id` rendered as "id" resolves to invoice_rows.id, wrong rather
// than merely ambiguous. The correlation target is therefore written
// "invoices"."id" verbatim, which also fixes the one thing callers must
// respect: SELECT FROM the invoices table UNALIASED.

// Signed gross straight off the stored row amounts. Stored amounts are ALWAYS
// positive (see invoice_rows' own comment); the CASE is the credit sign
// convention — this is the SECOND and last place it lives, the first being
// getInvoicedQuantitiesWith in invoice.repository.ts (which signs quantities
// for the invoiced-quantity aggregation the same way). Keep them in sync.
export const grossAmountSql = sql<string>`(
  CASE WHEN "invoices"."type" = 'credit' THEN -1 ELSE 1 END
  * COALESCE((
      SELECT SUM(ir.line_amount + ir.vat_amount)
      FROM invoice_rows ir
      WHERE ir.invoice_id = "invoices"."id"
    ), 0)
)`;

// Correlated on the `invoices` row in the surrounding query, so a query can
// select it and filter on it in SQL (the alternative — computing the amounts
// in TypeScript — cannot be pushed into a WHERE and would break pagination).
// The right tool for single ids (computeOpenAmounts below, findOpenByOcr);
// the open-items LIST uses openItemAggregates instead.
export const openAmountSql = sql<string>`(
  ${grossAmountSql}
  - COALESCE((
      SELECT SUM(cpr.applied_amount + cpr.write_off_amount)
      FROM customer_payment_rows cpr
      JOIN customer_payments cp ON cp.id = cpr.payment_id
      WHERE cpr.invoice_id = "invoices"."id"
        AND cp.cancelled_at IS NULL
    ), 0)
  + COALESCE((
      SELECT SUM(rem.fee)
      FROM invoice_reminders rem
      WHERE rem.invoice_id = "invoices"."id"
    ), 0)
)`;

// The open-items LIST's version of openAmountSql (B3 follow-up "openAmountSql
// dubbelevalueras"): the correlated subqueries above ran once per invoice in
// SELECT, again in WHERE and again in the count query. Here every aggregate is
// a GROUP BY subquery joined once, and the open amount is cheap arithmetic on
// the joined columns. Same formula, same sign convention (CASE on
// invoices.type) — open-amounts-list.test.ts pins it against
// computeOpenAmounts, which stays the authority for single ids.
//
// SCOPED TO ISSUED INVOICES: Postgres does not push the outer status filter
// into a GROUP BY subquery, so unscoped each one would aggregate the whole
// history of rows/payments/reminders on every request. Each subquery
// therefore only reads rows of issued invoices (the index on the invoice id
// column does the rest). Only use these aggregates in a query that itself is
// restricted to status = 'issued' — any other invoice joins to NULLs here.
export function openItemAggregates(executor: Db | Tx) {
  const issued = executor.select({ id: invoices.id }).from(invoices).where(eq(invoices.status, "issued"));
  const gross = executor
    .select({
      invoiceId: invoiceRows.invoiceId,
      total: sql<string>`SUM(${invoiceRows.lineAmount} + ${invoiceRows.vatAmount})`.as("gross_total"),
    })
    .from(invoiceRows)
    .where(inArray(invoiceRows.invoiceId, issued))
    .groupBy(invoiceRows.invoiceId)
    .as("open_gross");
  const settled = executor
    .select({
      invoiceId: customerPaymentRows.invoiceId,
      total: sql<string>`SUM(${customerPaymentRows.appliedAmount} + ${customerPaymentRows.writeOffAmount})`.as("settled_total"),
    })
    .from(customerPaymentRows)
    .innerJoin(customerPayments, eq(customerPayments.id, customerPaymentRows.paymentId))
    .where(and(isNull(customerPayments.cancelledAt), inArray(customerPaymentRows.invoiceId, issued)))
    .groupBy(customerPaymentRows.invoiceId)
    .as("open_settled");
  const fees = executor
    .select({
      invoiceId: invoiceReminders.invoiceId,
      total: sql<string>`SUM(${invoiceReminders.fee})`.as("fee_total"),
    })
    .from(invoiceReminders)
    .where(inArray(invoiceReminders.invoiceId, issued))
    .groupBy(invoiceReminders.invoiceId)
    .as("open_fees");
  const grossExpr = sql<string>`(CASE WHEN ${invoices.type} = 'credit' THEN -1 ELSE 1 END * COALESCE(${gross.total}, 0))`;
  const openExpr = sql<string>`(${grossExpr} - COALESCE(${settled.total}, 0) + COALESCE(${fees.total}, 0))`;
  return { gross, settled, fees, grossExpr, openExpr };
}

// Open amount per invoice id, as numbers (kr). Takes a Db or a Tx: the payment
// registration calls it from INSIDE its own transaction, after the matched
// invoices are row-locked, so what it reads is what the tolerance rule and the
// paid-flip are decided on — the same Db|Tx-composable seam as
// number-series.ts's getNextOrderNumber and readPostingSettings.
//
// Every requested id gets an entry; an id that is not an invoice at all comes
// back 0 (callers verify existence themselves — createPayment does it with the
// same locked read it needs anyway).
export async function computeOpenAmounts(executor: Db | Tx, invoiceIds: string[]): Promise<Map<string, number>> {
  const open = new Map<string, number>(invoiceIds.map((id) => [id, 0]));
  if (invoiceIds.length === 0) return open;

  const rows = await executor
    .select({ id: invoices.id, openAmount: openAmountSql })
    .from(invoices)
    .where(inArray(invoices.id, invoiceIds));
  for (const row of rows) open.set(row.id, Number(row.openAmount));
  return open;
}

// Årsbokslut (steg 1): the kundreskontra AS OF a date, for the reconciliation
// against the receivable account. Every document counts on the date it hit
// the ledger — its own verification's date — so both sides are measured at
// the same moment: a payment dated before `date` but cancelled after it still
// counts as paid (its omföring is dated after `date` too).
export async function receivablesTotalAsOf(executor: Db | Tx, date: string): Promise<number> {
  const rows = await executor.execute(sql`
    SELECT
      COALESCE((
        SELECT SUM(g.gross) FROM (
          SELECT ${grossAmountSql} AS gross
          FROM invoices
          JOIN verifications iv ON iv.id = "invoices"."verification_id"
          WHERE iv.date <= ${date}
        ) g
      ), 0)
      - COALESCE((
        SELECT SUM(cpr.applied_amount + cpr.write_off_amount)
        FROM customer_payment_rows cpr
        JOIN customer_payments cp ON cp.id = cpr.payment_id
        LEFT JOIN verifications cv ON cv.id = cp.cancellation_verification_id
        WHERE cp.payment_date <= ${date}
          AND (cp.cancelled_at IS NULL
               OR COALESCE(cv.date, (cp.cancelled_at AT TIME ZONE 'Europe/Stockholm')::date) > ${date})
      ), 0)
      + COALESCE((
        SELECT SUM(rem.fee)
        FROM invoice_reminders rem
        JOIN verifications fv ON fv.id = rem.fee_verification_id
        WHERE fv.date <= ${date}
      ), 0) AS total
  `);
  // postgres-js: db.execute returns an array of rows.
  const [row] = [...rows] as { total: string }[];
  return Math.round(Number(row?.total ?? 0) * 100) / 100;
}
