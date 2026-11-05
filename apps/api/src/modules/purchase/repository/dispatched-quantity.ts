// Skickat (avsändning till legoleverantör): what has been sent of an IO row —
// Σ quantity over its dispatch rows whose dispatch is not undone, in the
// article's base unit like the row. ONE expression for every reader (the IO
// card's rows, the TO card's lego purchases, the dispatch routine) so they
// can never disagree; nothing is stored on the row (härlett före lagrat).
// Correlated on `purchaseOrderRows` in the outer query — the correlation is
// table-qualified explicitly, like legoOrderedQuantitySql.
import { sql, type SQL } from "drizzle-orm";
import {
  purchaseOrderDispatchRows,
  purchaseOrderDispatches,
  purchaseOrderRows,
} from "@navet/db";

export function dispatchedQuantitySql(): SQL<string> {
  return sql<string>`coalesce((select sum(dr.quantity) from ${purchaseOrderDispatchRows} dr join ${purchaseOrderDispatches} d on d.id = dr.dispatch_id where dr.purchase_order_row_id = ${purchaseOrderRows}.id and d.undone_at is null), 0)`;
}
