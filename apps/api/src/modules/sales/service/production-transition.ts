import { and, eq } from "drizzle-orm";
import { salesOrders, type Tx } from "@navet/db";

// E3 (KO→TO-koppling): the autoflip half of the link — when a TO is created
// against a confirmed KO row, the KO moves to "in_production" as a side
// effect of that same transaction. Tx-composable, exactly like
// resolveStockLocation: a plain function taking Tx so manufacturing's
// create-tx can call it as its last step without a service-to-service
// dependency.
//
// A conditional UPDATE (WHERE status = 'confirmed') rather than a
// read-then-branch: idempotent by construction — calling this again on an
// order that's already in_production (e.g. a second linked TO, or the order
// having been flipped by an earlier one in the same batch) matches zero rows
// and is a silent no-op, never an error.
export async function markSalesOrderInProduction(tx: Tx, salesOrderId: string): Promise<void> {
  await tx
    .update(salesOrders)
    .set({ status: "in_production", updatedAt: new Date() })
    .where(and(eq(salesOrders.id, salesOrderId), eq(salesOrders.status, "confirmed")));
}
