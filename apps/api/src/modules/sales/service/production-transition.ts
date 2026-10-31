import { eq } from "drizzle-orm";
import { salesOrders, type Tx } from "@navet/db";
import type { SalesOrderStatus } from "@navet/shared";

// E3 (KO→TO-koppling): the autoflip half of the link — when a TO is created
// against a confirmed KO row, the KO moves to "in_production" as a side
// effect of that same transaction. Tx-composable, exactly like
// resolveStockLocation: a plain function taking Tx so manufacturing's
// create-tx can call it as its last step without a service-to-service
// dependency.
//
// The header is locked and its status returned: the TO's validation read
// the order BEFORE the transaction, so an order cancelled in between must be
// seen here, under the same row lock Makulera takes — the caller refuses
// anything but confirmed/in_production and the TO rolls back with it.
// FOR NO KEY UPDATE is the lock the status UPDATE itself takes, so the TO
// transaction's lock order (rows → header, last) is unchanged. Idempotent:
// an order already in_production (a second linked TO, or one flipped
// earlier in the same batch) is left as it is. null = no such order.
export async function markSalesOrderInProduction(tx: Tx, salesOrderId: string): Promise<SalesOrderStatus | null> {
  const [order] = await tx
    .select({ status: salesOrders.status })
    .from(salesOrders)
    .where(eq(salesOrders.id, salesOrderId))
    .for("no key update");
  if (!order) return null;
  if (order.status === "confirmed") {
    await tx.update(salesOrders).set({ status: "in_production", updatedAt: new Date() }).where(eq(salesOrders.id, salesOrderId));
  }
  return order.status;
}
