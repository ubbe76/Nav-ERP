import { sql, type SQL } from "drizzle-orm";
import { moReports } from "@navet/db";

// Senaste inleverans — the ONE rule for when a manufacturing order last
// received finished goods (Efterkalkylera flera, #34). A leaf: no imports
// from the manufacturing repository, usable in any query (Db | Tx) that has
// `manufacturing_orders` in its FROM.
//
// The source is the rapporteringslogg: every receipt of finished goods —
// a report on the last operation (delinleverans), Slutför order, a lego
// receipt of the last operation — writes an mo_reports row with
// quantity_received > 0 in the transaction that books the goods, and Ångra
// stamps that row's undone_at. So a LIVE receipt is a row with
// quantity_received > 0 and undone_at null; an undone receipt does not
// count, and neither does a report that received nothing (an efterrapport
// on a Klar order, a mid-route operation). The stock log cannot answer
// this: it is append-only, an undo is one more mo_receipt row (negative),
// and which receipt it took back is not written there.
//
// The day is the Stockholm day of the newest such row's created_at — never
// ::date on the timestamptz itself (the process/session zone). null when
// the order has no live receipt.
//
// "manufacturing_orders"."id" is written out: Drizzle renders a column
// inside sql`` WITHOUT its table in a single-table select, and a bare "id"
// in this subquery would bind to mo_reports.id.
export const lastReceiptDaySql: SQL<string | null> = sql<string | null>`(
  select (max(last_receipt.created_at) at time zone 'Europe/Stockholm')::date
  from ${moReports} last_receipt
  where last_receipt.manufacturing_order_id = "manufacturing_orders"."id"
    and last_receipt.undone_at is null
    and last_receipt.quantity_received > 0
)`;

// The same day as YYYY-MM-DD text, for a select list (a date column would
// come back as a Date in the process's zone).
export const lastReceivedOnSql: SQL<string | null> = sql<string | null>`to_char(${lastReceiptDaySql}, 'YYYY-MM-DD')`;
