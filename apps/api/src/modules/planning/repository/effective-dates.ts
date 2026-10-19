import { sql } from "drizzle-orm";
import { purchaseOrderRows, purchaseOrders, salesOrderRows, salesOrders } from "@navet/db";

// The effective dates (migration 0126): a sales order row's own Leveransdatum,
// else the order's; a purchase order row's Bekräftat leveransdatum (its own,
// else the order's) before the requested one (its own, else the order's).
// Leaf file shared by the planning reads and the order register — both need
// the row joined to its order.
export const salesRowDeliveryDate = sql<
  string | null
>`coalesce(${salesOrderRows.expectedDeliveryDate}, ${salesOrders.expectedDeliveryDate})`;
export const purchaseRowArrivalDate = sql<
  string | null
>`coalesce(${purchaseOrderRows.confirmedDeliveryDate}, ${purchaseOrders.confirmedDeliveryDate}, ${purchaseOrderRows.expectedDeliveryDate}, ${purchaseOrders.expectedDeliveryDate})`;
