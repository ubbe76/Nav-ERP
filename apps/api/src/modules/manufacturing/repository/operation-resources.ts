import { eq, sql, type SQL } from "drizzle-orm";
import { moOperationResources, type Tx } from "@navet/db";

// Alternativa resurser (#15) — a TO operation's possible resources
// (mo_operation_resources), the ONLY writer of that table. Leaf file: Tx
// helpers the release, Ändra operationer (order-edit.ts) and — in etapp 3 —
// the reservation compose inside their own transactions.
//
// Invariant: an operation with rows has its work_center_id among them, and
// that row carries the operation's times. resource_locked ("Vald för hand")
// is true only on an operation with rows.

// Rows per UPDATE … FROM (VALUES …), like writeOperationPlans.
const SWITCH_BATCH = 500;

// The snapshot at release: every operation of the TO that came from a
// routing row (routing_operation_id) which has alternatives, while the
// operation is still on that row's ordinarie, gets rank 0 = its own resource
// and times, then the routing's active alternatives (never a legoresurs,
// never its own resource) renumbered 1.. in rank order, times resolved: the
// alternative's own, else the operation's. A configured TO's base
// operations carry the template's routing row and are covered the same way;
// its conditional operations have none and get no rows. Operations that
// already have rows are left alone, so a second call (Släpp of an older
// configured TO written at creation) is harmless. One statement.
export async function snapshotOperationResourcesInTx(tx: Tx, manufacturingOrderId: string): Promise<void> {
  await tx.execute(sql`
    WITH ops AS (
      SELECT mo.id, mo.work_center_id, mo.setup_time, mo.run_time_per_unit, ro.id AS routing_id
      FROM mo_operations mo
      JOIN routing_operations ro ON ro.id = mo.routing_operation_id
        AND ro.work_center_id = mo.work_center_id AND NOT ro.costing_only
      JOIN work_centers owc ON owc.id = mo.work_center_id AND owc.type <> 'subcontract'
      WHERE mo.manufacturing_order_id = ${manufacturingOrderId}
        AND NOT EXISTS (SELECT 1 FROM mo_operation_resources r WHERE r.mo_operation_id = mo.id)
    ), alts AS (
      SELECT ops.id AS mo_operation_id, a.work_center_id,
        (row_number() OVER (PARTITION BY ops.id ORDER BY a.rank))::smallint AS rank,
        coalesce(a.setup_time, ops.setup_time) AS setup_time,
        coalesce(a.run_time_per_unit, ops.run_time_per_unit) AS run_time_per_unit
      FROM ops
      JOIN routing_operation_alternatives a ON a.routing_operation_id = ops.routing_id AND a.work_center_id <> ops.work_center_id
      JOIN work_centers w ON w.id = a.work_center_id AND w.active AND w.type <> 'subcontract'
    )
    INSERT INTO mo_operation_resources (mo_operation_id, work_center_id, rank, setup_time, run_time_per_unit)
    SELECT ops.id, ops.work_center_id, 0::smallint, ops.setup_time, ops.run_time_per_unit
    FROM ops WHERE EXISTS (SELECT 1 FROM alts WHERE alts.mo_operation_id = ops.id)
    UNION ALL
    SELECT mo_operation_id, work_center_id, rank, setup_time, run_time_per_unit FROM alts`);
}

export interface ResourceSwitch {
  moOperationId: string;
  // The resource the caller saw — the switch only happens while the
  // operation is still on it.
  fromWorkCenterId: string;
  // One of the operation's mo_operation_resources.
  toWorkCenterId: string;
  // "Vald för hand" after the switch.
  resourceLocked: boolean;
}

// EN skrivare av bytet: sets the resource and the target row's times on
// each operation, conditioned on its current resource and on the target
// being one of its rows, and sets resource_locked. plan_locked is cleared —
// the weeks were booked on the old resource; the caller's plan writer
// writes the new weeks afterwards (Ändra's replanOrderInTx, the
// reservation's planned weeks). Returns the ids actually switched. The
// caller holds the operations' row locks (Ändra: lockOrderOperations).
export async function switchOperationResourcesInTx(tx: Tx, switches: ResourceSwitch[]): Promise<string[]> {
  const switched: string[] = [];
  for (let i = 0; i < switches.length; i += SWITCH_BATCH) {
    const part = switches.slice(i, i + SWITCH_BATCH);
    const values = sql.join(
      part.map((s) => sql`(${s.moOperationId}::uuid, ${s.fromWorkCenterId}::uuid, ${s.toWorkCenterId}::uuid, ${s.resourceLocked}::boolean)`),
      sql`, `
    );
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE mo_operations o
      SET work_center_id = r.work_center_id,
          setup_time = r.setup_time,
          run_time_per_unit = r.run_time_per_unit,
          resource_locked = v.locked,
          plan_locked = false
      FROM (VALUES ${values}) AS v(id, from_wc, to_wc, locked)
      JOIN mo_operation_resources r ON r.mo_operation_id = v.id AND r.work_center_id = v.to_wc
      WHERE o.id = v.id AND o.work_center_id = v.from_wc
      RETURNING o.id`);
    switched.push(...[...rows].map((r) => r.id));
  }
  return switched;
}

// Ändra operationer that corrects the times also writes them on the current
// row, so the invariant holds and a switch back gives the corrected times.
export async function syncCurrentResourceTimesInTx(tx: Tx, moOperationId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE mo_operation_resources r
    SET setup_time = o.setup_time, run_time_per_unit = o.run_time_per_unit
    FROM mo_operations o
    WHERE o.id = ${moOperationId} AND r.mo_operation_id = o.id AND r.work_center_id = o.work_center_id`);
}

// A switch by hand to a resource outside the rows: the operation has no
// alternatives any more.
export async function clearOperationResourcesInTx(tx: Tx, moOperationId: string): Promise<void> {
  await tx.delete(moOperationResources).where(eq(moOperationResources.moOperationId, moOperationId));
}

export async function operationResourceRows(tx: Tx, moOperationId: string) {
  return tx.select().from(moOperationResources).where(eq(moOperationResources.moOperationId, moOperationId));
}

// The rows of one operation as the list shows them — a correlated subquery
// for selectOperationRows (GET /manufacturing-orders/:id/operations and
// Ändra's answer): [{ workCenterId, code, name, rank, setupTime,
// runTimePerUnit }] by rank, the times as numeric strings like the
// operation's own; [] = no alternatives. The outer column is spelled out:
// drizzle leaves a column of a join-less select unqualified, and inside the
// subquery that would be ambiguous.
export interface OperationResourceView {
  workCenterId: string;
  code: string;
  name: string;
  rank: number;
  setupTime: string;
  runTimePerUnit: string;
}
export function operationResourcesJson(): SQL<OperationResourceView[]> {
  return sql<OperationResourceView[]>`coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'workCenterId', r.work_center_id, 'code', w.code, 'name', w.name, 'rank', r.rank,
      'setupTime', r.setup_time::text, 'runTimePerUnit', r.run_time_per_unit::text) ORDER BY r.rank)
    FROM mo_operation_resources r JOIN work_centers w ON w.id = r.work_center_id
    WHERE r.mo_operation_id = "mo_operations"."id"), '[]'::jsonb)`;
}
