// The lego operation's one-off charge per order: Ställpris + Transportkostnad.
// ONE expression for every reader that prices a lego order — the
// behovsberäkning's lego proposals, the IO row raised for an operation, and
// the pre-/post-calculation — so they can never disagree. Null when neither
// is set ("unpriced"), never 0, like the two columns themselves.
import { sql, type SQL } from "drizzle-orm";
import { moOperations, purchaseOrderRows, purchaseOrders, routingOperations } from "@navet/db";

type LegoPriced = typeof routingOperations | typeof moOperations;

export function legoOneOffSql(table: LegoPriced): SQL<string | null> {
  return sql<string | null>`case when ${table.setupPrice} is null and ${table.transportPrice} is null then null else coalesce(${table.setupPrice}, 0) + coalesce(${table.transportPrice}, 0) end`;
}

// What is already bought of a lego operation: Σ quantity_ordered on the IO
// rows pointing at it, on orders that are not cancelled (a received or
// closed order still counts — the operation was bought). ONE expression for
// the behovsberäkning's lego proposal (orderantal − this) and the TO card's
// Skapa inköpsorder prefill. Correlated on `moOperations` in the outer query —
// the correlation must be table-qualified explicitly (see the workCenterCount
// subquery note in manufacturing.repository.ts).
export function legoOrderedQuantitySql(): SQL<string> {
  return sql<string>`coalesce((select sum(por.quantity_ordered) from ${purchaseOrderRows} por join ${purchaseOrders} po on po.id = por.purchase_order_id where por.mo_operation_id = ${moOperations}.id and po.status <> 'cancelled'), 0)`;
}
