import { sql } from "drizzle-orm";
import type { Tx } from "@navet/db";

// Produktionsplanering's one lock: Planera, Flytta, Lås upp, the reservation
// and the planning of a new TO (createManufacturingOrderInTx) each run in ONE
// transaction that starts with it — same pattern as vat_settlements and
// demo_data. Two runs serialise; the second reads the first's plan as its
// starting point (read committed: the next statement sees what committed).
// Taken FIRST in the transaction, before the order number and before any
// row lock, so the lock order is always advisory → rows.
export const PRODUCTION_PLAN_LOCK_SQL = sql`select pg_advisory_xact_lock(hashtext('production_plan'))`;

export async function lockProductionPlan(tx: Tx): Promise<void> {
  await tx.execute(PRODUCTION_PLAN_LOCK_SQL);
}
