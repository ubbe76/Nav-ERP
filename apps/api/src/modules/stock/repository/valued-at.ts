// Värderingsdatum (#26) — THE expression every "as of a date" reader of
// stock_transactions uses: valued_at when a row was booked onto an earlier
// moment (a stock count registered per underlagets datum), else created_at.
// Leaf file (no service imports) so stock, costing and the valuation report
// share one definition; the expression index idx_stock_transactions_valued_at
// is built on exactly this coalesce.
//
// Readers that ask "when was it registered" (the count's disturbed flag, the
// receipt log, the latest draw) keep created_at on purpose.
import { sql } from "drizzle-orm";
import { purchaseReceipts, stockTransactions } from "@navet/db";

// The moment, mapped like created_at (a Date) so callers can swap one for the
// other in a select.
export const stockValuedAt = sql<Date>`coalesce(${stockTransactions.valuedAt}, ${stockTransactions.createdAt})`.mapWith(
  stockTransactions.createdAt
);

// The Stockholm calendar day of the moment — "as of 2025-12-31" means "valued
// by the end of that day in Stockholm", whatever the database session's zone
// is (the container's Postgres runs UTC).
export const stockValuedDate = sql`(coalesce(${stockTransactions.valuedAt}, ${stockTransactions.createdAt}) AT TIME ZONE 'Europe/Stockholm')::date`;

// "Valued by the end of Stockholm day asOf" as a comparison on the moment
// itself: the moment is before the next Stockholm midnight. Same rows as
// `${stockValuedDate} <= asOf`, but without turning every row's moment into
// a Stockholm day first — that per-row conversion was most of the valuation
// report's scan, and it kept the expression index above out of reach
// (perf run 2026-11-09). The lagerlogg's to-filter uses the same bound.
export function stockValuedOnOrBefore(asOf: string) {
  return sql`${stockValuedAt} < ((${asOf}::date + 1)::timestamp AT TIME ZONE 'Europe/Stockholm')`;
}


// Bokför per (#19) — the same idea on the receipt log: when the goods
// arrived. A receipt registered later for an earlier day carries received_at
// (that day's end, the same moment as its stock row's valued_at); NULL = the
// same as created_at. Every "when was it received" reader goes through this
// (leveransprecision, the fakturaunderlag's Inlevererad, the IO card's Inleveranser,
// the batch trace) — raw subqueries over an alias write the same coalesce.
export const receiptReceivedAt = sql<Date>`coalesce(${purchaseReceipts.receivedAt}, ${purchaseReceipts.createdAt})`.mapWith(
  purchaseReceipts.createdAt
);
