import { inArray, sql, type SQL } from "drizzle-orm";
import { purchaseOrderRows, purchaseOrders, salesOrderRows, salesOrders } from "@navet/db";
import { purchaseRowArrivalDate, salesRowDeliveryDate } from "./effective-dates.js";

// Sen (late) for kund- and inköpsorder — ONE rule for Aviseringarna's
// Försenade kundordrar/inköpsordrar and the order lists' status filter Sen,
// derived when read, never stored: an open order with a row that still has
// quantity left and whose effective date (effective-dates.ts) is before
// today. A fully delivered/received order falls out because no row has rest;
// quotes are never late. Leaf file: schema imports only.
export const LATE_SALES_ORDER_STATUSES = ["confirmed", "in_production"] as const;
export const LATE_PURCHASE_ORDER_STATUSES = ["draft", "confirmed", "partially_received"] as const;

// The row condition, for a query that has the row joined to its order.
export function salesRowLate(today: string): SQL {
  return sql`(${salesOrderRows.quantityOrdered} > ${salesOrderRows.quantityDelivered} and ${salesRowDeliveryDate} < ${today}::date)`;
}

export function purchaseRowLate(today: string): SQL {
  return sql`(${purchaseOrderRows.quantityOrdered} > ${purchaseOrderRows.quantityReceived} and ${purchaseRowArrivalDate} < ${today}::date)`;
}

// The order condition, for a WHERE over an unaliased sales_orders /
// purchase_orders (the row subquery correlates on the table name).
export function salesOrderLate(today: string): SQL {
  return sql`(${inArray(salesOrders.status, [...LATE_SALES_ORDER_STATUSES])} and exists (select 1 from ${salesOrderRows} where ${salesOrderRows.salesOrderId} = ${salesOrders.id} and ${salesRowLate(today)}))`;
}

export function purchaseOrderLate(today: string): SQL {
  return sql`(${inArray(purchaseOrders.status, [...LATE_PURCHASE_ORDER_STATUSES])} and exists (select 1 from ${purchaseOrderRows} where ${purchaseOrderRows.purchaseOrderId} = ${purchaseOrders.id} and ${purchaseRowLate(today)}))`;
}
