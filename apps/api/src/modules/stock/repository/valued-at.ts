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
import { stockTransactions } from "@navet/db";

// The moment, mapped like created_at (a Date) so callers can swap one for the
// other in a select.
export const stockValuedAt = sql<Date>`coalesce(${stockTransactions.valuedAt}, ${stockTransactions.createdAt})`.mapWith(
  stockTransactions.createdAt
);

// The Stockholm calendar day of the moment — "as of 2025-12-31" means "valued
// by the end of that day in Stockholm", whatever the database session's zone
// is (the container's Postgres runs UTC).
export const stockValuedDate = sql`(coalesce(${stockTransactions.valuedAt}, ${stockTransactions.createdAt}) AT TIME ZONE 'Europe/Stockholm')::date`;
