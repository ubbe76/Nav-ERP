import { and, asc, eq, getTableColumns, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articles,
  inquiries,
  inquiryRows,
  manufacturingOrders,
  moMaterialConsumptions,
  moOperationScrap,
  moOperations,
  moReportMaterials,
  moReports,
  purchaseOrderRows,
  purchaseOrders,
  stampSessions,
  suppliers,
  timeReports,
  units,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import { toBaseQuantity, type CreateMoOperationInput, type UpdateMoOperationInput } from "@navet/shared";
// Produktionsplanering: a leaf with only the lock SQL — no module cycle.
import { lockProductionPlan } from "../../planning/repository/plan-lock.js";
import { shortageWarnings } from "./shortage-warnings.js";

// Ändra material och operationer på en skapad tillverkningsorder — the
// transaction bodies behind POST/PATCH/DELETE …/materials and …/operations.
// Every edit touches the TO's OWN rows only (never the article's BOM or
// routing) and is allowed while the order is Frisläppt/Pågår.
//
// Lock order. Reporting takes operation → order → material rows, and the
// plan writer (writeOperationPlans) UPDATEs every operation of the order,
// so an operation edit takes the production_plan advisory lock, then ALL
// the order's operations FOR UPDATE (sorted by id), then the order — never
// the order before an operation, which would deadlock against a report
// that holds its operation and waits for the order. A material edit that
// points at an operation locks that operation (FOR SHARE) before the order
// for the same reason: the row's FK takes a key-share on the operation.

export type OrderReplanner = (tx: Tx, manufacturingOrderId: string) => Promise<string[]>;

type OrderRow = typeof manufacturingOrders.$inferSelect;
type OperationRow = typeof moOperations.$inferSelect;

// The same shape as GET /manufacturing-orders/:id/materials rows.
export function selectMaterialRows(dbc: Db | Tx) {
  const rowUnits = alias(units, "row_units");
  return dbc
    .select({
      ...getTableColumns(moMaterialConsumptions),
      componentArticleNumber: articles.articleNumber,
      componentName: articles.name,
      // The unit the row displays in: the unit snapshotted on the row,
      // falling back to the component's base unit.
      unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
    })
    .from(moMaterialConsumptions)
    .innerJoin(articles, eq(articles.id, moMaterialConsumptions.componentArticleId))
    .innerJoin(units, eq(units.id, articles.unitId))
    .leftJoin(rowUnits, eq(rowUnits.id, moMaterialConsumptions.unitId));
}
export type MaterialRow = Awaited<ReturnType<ReturnType<typeof selectMaterialRows>["execute"]>>[number];

// The same shape as GET /manufacturing-orders/:id/operations rows (the
// planned weeks are mirror columns on mo_operations and ride along).
export function selectOperationRows(dbc: Db | Tx) {
  return dbc
    .select({
      ...getTableColumns(moOperations),
      workCenterName: workCenters.name,
      workCenterCode: workCenters.code,
      workCenterType: workCenters.type,
      subcontractSupplierName: suppliers.name,
    })
    .from(moOperations)
    .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
    .leftJoin(suppliers, eq(suppliers.id, moOperations.subcontractSupplierId));
}
export type OperationRowView = Awaited<ReturnType<ReturnType<typeof selectOperationRows>["execute"]>>[number];

async function materialRow(tx: Tx, rowId: string): Promise<MaterialRow> {
  const [row] = await selectMaterialRows(tx).where(eq(moMaterialConsumptions.id, rowId));
  return row!;
}

async function operationRow(tx: Tx, opId: string): Promise<OperationRowView> {
  const [row] = await selectOperationRows(tx).where(eq(moOperations.id, opId));
  return row!;
}

export type EditableOrderFailure = "order_not_found" | "not_editable";

// The order FOR UPDATE, editable only while open (planned has no snapshot
// to edit — the release overwrites it — and done/closed/cancelled are over).
async function lockEditableOrder(tx: Tx, moId: string): Promise<{ ok: true; order: OrderRow } | { ok: false; reason: EditableOrderFailure }> {
  const [order] = await tx.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, moId)).for("update");
  if (!order) return { ok: false, reason: "order_not_found" };
  if (order.status !== "released" && order.status !== "in_progress") return { ok: false, reason: "not_editable" };
  return { ok: true, order };
}

// --- Material ------------------------------------------------------------

export type MaterialEditFailure = EditableOrderFailure | "row_not_found" | "operation_not_on_order" | "consumed";

export interface AddMaterialInput {
  componentArticleId: string;
  // Entered in the row's unit; stored in the base unit via unitFactor.
  quantity: number;
  unitId: string | null;
  unitFactor: number | null;
  moOperationId: string | null;
}

export interface UpdateMaterialInput {
  componentArticleId?: string;
  quantity?: number;
  // The resolved unit when the PATCH sets one (or the component changes).
  unit?: { unitId: string | null; unitFactor: number | null };
  moOperationId?: string | null;
}

export type MaterialEditResult =
  | { ok: true; order: OrderRow; before: MaterialRow | null; material: MaterialRow; warnings: string[] }
  | { ok: false; reason: MaterialEditFailure };

export type RemoveMaterialResult = { ok: true; order: OrderRow; before: MaterialRow } | { ok: false; reason: MaterialEditFailure };

// Locks the operation a material row will point at, ahead of the order
// (see the lock-order note above); null = no such operation.
async function lockOperationForMaterial(tx: Tx, opId: string): Promise<OperationRow | null> {
  const [op] = await tx.select().from(moOperations).where(eq(moOperations.id, opId)).for("share");
  return op ?? null;
}

// A row with anything drawn, or a report-log line that points at it (the
// cascade would take the history with it), can neither swap component nor
// be removed.
async function materialHasConsumption(tx: Tx, row: typeof moMaterialConsumptions.$inferSelect): Promise<boolean> {
  if (Number(row.quantityConsumed) > 0) return true;
  const [line] = await tx
    .select({ id: moReportMaterials.id })
    .from(moReportMaterials)
    .where(eq(moReportMaterials.materialConsumptionId, row.id))
    .limit(1);
  return line !== undefined;
}

export async function addMaterialInTx(tx: Tx, moId: string, input: AddMaterialInput): Promise<MaterialEditResult> {
  const operation = input.moOperationId ? await lockOperationForMaterial(tx, input.moOperationId) : null;
  const locked = await lockEditableOrder(tx, moId);
  if (!locked.ok) return locked;
  if (input.moOperationId && operation?.manufacturingOrderId !== moId) return { ok: false, reason: "operation_not_on_order" };

  // A duplicate (same component on the same operation) fails the unique
  // constraint mo_material_unique_per_operation — the throw rolls the
  // transaction back and the service names it.
  const [inserted] = await tx
    .insert(moMaterialConsumptions)
    .values({
      manufacturingOrderId: moId,
      componentArticleId: input.componentArticleId,
      moOperationId: input.moOperationId,
      quantityPlanned: String(toBaseQuantity(input.quantity, input.unitFactor)),
      unitId: input.unitId,
      unitFactor: input.unitFactor === null ? null : String(input.unitFactor),
    })
    .returning();
  const material = await materialRow(tx, inserted!.id);
  const warnings = await shortageWarnings(tx, [material], new Map([[material.componentArticleId, material.componentName]]));
  return { ok: true, order: locked.order, before: null, material, warnings };
}

export async function updateMaterialInTx(tx: Tx, moId: string, rowId: string, input: UpdateMaterialInput): Promise<MaterialEditResult> {
  const operation = input.moOperationId ? await lockOperationForMaterial(tx, input.moOperationId) : null;
  const locked = await lockEditableOrder(tx, moId);
  if (!locked.ok) return locked;
  const [row] = await tx
    .select()
    .from(moMaterialConsumptions)
    .where(and(eq(moMaterialConsumptions.id, rowId), eq(moMaterialConsumptions.manufacturingOrderId, moId)))
    .for("update");
  if (!row) return { ok: false, reason: "row_not_found" };
  if (input.moOperationId && operation?.manufacturingOrderId !== moId) return { ok: false, reason: "operation_not_on_order" };

  const componentChanged = input.componentArticleId !== undefined && input.componentArticleId !== row.componentArticleId;
  if (componentChanged && (await materialHasConsumption(tx, row))) return { ok: false, reason: "consumed" };

  const before = await materialRow(tx, rowId);
  // The quantity is read in the newly given unit, else the row's own.
  const factor = input.unit ? input.unit.unitFactor : row.unitFactor === null ? null : Number(row.unitFactor);
  const quantityPlanned = input.quantity !== undefined ? toBaseQuantity(input.quantity, factor) : Number(row.quantityPlanned);
  await tx
    .update(moMaterialConsumptions)
    .set({
      componentArticleId: componentChanged ? input.componentArticleId : undefined,
      moOperationId: input.moOperationId,
      quantityPlanned: String(quantityPlanned),
      unitId: input.unit ? input.unit.unitId : undefined,
      unitFactor: input.unit ? (input.unit.unitFactor === null ? null : String(input.unit.unitFactor)) : undefined,
    })
    .where(eq(moMaterialConsumptions.id, rowId));
  const material = await materialRow(tx, rowId);
  // Shortage only when the need grew: a raised quantity or another component.
  const warnings =
    componentChanged || quantityPlanned > Number(row.quantityPlanned)
      ? await shortageWarnings(tx, [material], new Map([[material.componentArticleId, material.componentName]]))
      : [];
  return { ok: true, order: locked.order, before, material, warnings };
}

export async function removeMaterialInTx(tx: Tx, moId: string, rowId: string): Promise<RemoveMaterialResult> {
  const locked = await lockEditableOrder(tx, moId);
  if (!locked.ok) return locked;
  const [row] = await tx
    .select()
    .from(moMaterialConsumptions)
    .where(and(eq(moMaterialConsumptions.id, rowId), eq(moMaterialConsumptions.manufacturingOrderId, moId)))
    .for("update");
  if (!row) return { ok: false, reason: "row_not_found" };
  if (await materialHasConsumption(tx, row)) return { ok: false, reason: "consumed" };
  const before = await materialRow(tx, rowId);
  await tx.delete(moMaterialConsumptions).where(eq(moMaterialConsumptions.id, rowId));
  return { ok: true, order: locked.order, before };
}

// --- Operations ----------------------------------------------------------

export type OperationEditFailure =
  | EditableOrderFailure
  | "operation_not_found"
  | "sequence_taken"
  | "done"
  | "stamped"
  | "linked_purchase"
  | "reported"
  | "last_operation_locked";

export type OperationEditResult =
  | { ok: true; order: OrderRow; before: OperationRowView | null; operation: OperationRowView; warnings: string[]; replanned: boolean }
  | { ok: false; reason: OperationEditFailure };

export type RemoveOperationResult =
  | { ok: true; order: OrderRow; before: OperationRowView; warnings: string[]; unlinkedMaterials: number }
  | { ok: false; reason: OperationEditFailure };

// Every operation of the order FOR UPDATE, in id order (see the lock-order
// note at the top).
async function lockOrderOperations(tx: Tx, moId: string): Promise<OperationRow[]> {
  return tx.select().from(moOperations).where(eq(moOperations.manufacturingOrderId, moId)).orderBy(asc(moOperations.id)).for("update");
}

// The operation with the highest sequence number — the one whose OK is
// finished goods.
function lastOf(ops: { id: string; sequenceNo: number }[]): string | null {
  let last: { id: string; sequenceNo: number } | null = null;
  for (const op of ops) if (!last || op.sequenceNo > last.sequenceNo) last = op;
  return last?.id ?? null;
}

async function exists(tx: Tx, query: PromiseLike<unknown[]>): Promise<boolean> {
  return (await query).length > 0;
}

// Has the operation ever had anything: reported quantities, a report-log
// row (undone ones included — they are history the cascade would delete),
// a time report, a stamp session or a scrap row.
async function operationHasHistory(tx: Tx, op: OperationRow): Promise<boolean> {
  if (Number(op.quantityCompleted ?? 0) > 0 || Number(op.quantityScrapped) > 0) return true;
  const id = op.id;
  return (
    (await exists(tx, tx.select({ id: moReports.id }).from(moReports).where(eq(moReports.moOperationId, id)).limit(1))) ||
    (await exists(tx, tx.select({ id: timeReports.id }).from(timeReports).where(eq(timeReports.moOperationId, id)).limit(1))) ||
    (await exists(tx, tx.select({ id: stampSessions.id }).from(stampSessions).where(eq(stampSessions.moOperationId, id)).limit(1))) ||
    (await exists(tx, tx.select({ id: moOperationScrap.id }).from(moOperationScrap).where(eq(moOperationScrap.moOperationId, id)).limit(1)))
  );
}

// An open or paused stamp (stopped_at null) on the operation.
async function operationIsStamped(tx: Tx, opId: string): Promise<boolean> {
  return exists(
    tx,
    tx
      .select({ id: stampSessions.id })
      .from(stampSessions)
      .where(and(eq(stampSessions.moOperationId, opId), isNull(stampSessions.stoppedAt)))
      .limit(1)
  );
}

// A lego operation bought on a live IO row or asked for on a live RFQ row.
async function operationHasLinkedPurchase(tx: Tx, opId: string): Promise<boolean> {
  return (
    (await exists(
      tx,
      tx
        .select({ id: purchaseOrderRows.id })
        .from(purchaseOrderRows)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
        .where(and(eq(purchaseOrderRows.moOperationId, opId), ne(purchaseOrders.status, "cancelled")))
        .limit(1)
    )) ||
    (await exists(
      tx,
      tx
        .select({ id: inquiryRows.id })
        .from(inquiryRows)
        .innerJoin(inquiries, eq(inquiries.id, inquiryRows.inquiryId))
        .where(and(eq(inquiryRows.moOperationId, opId), ne(inquiries.status, "cancelled")))
        .limit(1)
    ))
  );
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function addOperationInTx(
  tx: Tx,
  moId: string,
  input: CreateMoOperationInput,
  replan?: OrderReplanner
): Promise<OperationEditResult> {
  await lockProductionPlan(tx);
  const ops = await lockOrderOperations(tx, moId);
  const locked = await lockEditableOrder(tx, moId);
  if (!locked.ok) return locked;
  if (ops.some((o) => o.sequenceNo === input.sequenceNo)) return { ok: false, reason: "sequence_taken" };
  // Finished goods were received from the current last operation: a new one
  // after it would make the received units count against another's OK.
  const last = lastOf(ops);
  if (Number(locked.order.quantityReceived) > 0 && last !== null && input.sequenceNo > ops.find((o) => o.id === last)!.sequenceNo) {
    return { ok: false, reason: "last_operation_locked" };
  }
  const [inserted] = await tx
    .insert(moOperations)
    .values({
      manufacturingOrderId: moId,
      sequenceNo: input.sequenceNo,
      // No routing row behind it — the drawing is read via the routing
      // link when there is one, so a hand-added operation has none.
      routingOperationId: null,
      description: blankToNull(input.description),
      workCenterId: input.workCenterId,
      setupTime: String(input.setupTime),
      runTimePerUnit: String(input.runTimePerUnit),
      timeUnit: input.timeUnit ?? "minutes_per_unit",
      comment: blankToNull(input.comment),
      printOnWorkCard: input.printOnWorkCard ?? false,
      packingInstructions: blankToNull(input.packingInstructions),
      subcontractSupplierId: input.subcontractSupplierId ?? null,
      setupPrice: input.setupPrice != null ? String(input.setupPrice) : null,
      unitPrice: input.unitPrice != null ? String(input.unitPrice) : null,
      showNetWeight: input.showNetWeight ?? false,
    })
    .returning({ id: moOperations.id });
  const warnings = replan ? await replan(tx, moId) : [];
  return { ok: true, order: locked.order, before: null, operation: await operationRow(tx, inserted!.id), warnings, replanned: !!replan };
}

export async function updateOperationInTx(
  tx: Tx,
  moId: string,
  opId: string,
  input: UpdateMoOperationInput,
  replan?: OrderReplanner
): Promise<OperationEditResult> {
  await lockProductionPlan(tx);
  const ops = await lockOrderOperations(tx, moId);
  const op = ops.find((o) => o.id === opId);
  if (!op) return { ok: false, reason: "operation_not_found" };
  const locked = await lockEditableOrder(tx, moId);
  if (!locked.ok) return locked;
  if (op.status === "done") return { ok: false, reason: "done" };

  const workCenterChanged = input.workCenterId !== undefined && input.workCenterId !== op.workCenterId;
  if (workCenterChanged) {
    if (await operationIsStamped(tx, opId)) return { ok: false, reason: "stamped" };
    if (await operationHasLinkedPurchase(tx, opId)) return { ok: false, reason: "linked_purchase" };
    // Lego ↔ own: the two are reported differently (receipt vs stamping), so
    // a switch is only possible before anything has been reported.
    const [oldWc] = await tx.select({ type: workCenters.type }).from(workCenters).where(eq(workCenters.id, op.workCenterId));
    const [newWc] = await tx.select({ type: workCenters.type }).from(workCenters).where(eq(workCenters.id, input.workCenterId!));
    const oldLego = oldWc?.type === "subcontract";
    const newLego = newWc?.type === "subcontract";
    if (oldLego !== newLego && (await operationHasHistory(tx, op))) return { ok: false, reason: "reported" };
  }

  const sequenceChanged = input.sequenceNo !== undefined && input.sequenceNo !== op.sequenceNo;
  if (sequenceChanged) {
    if (ops.some((o) => o.id !== opId && o.sequenceNo === input.sequenceNo)) return { ok: false, reason: "sequence_taken" };
    if (Number(locked.order.quantityReceived) > 0) {
      const after = ops.map((o) => (o.id === opId ? { id: o.id, sequenceNo: input.sequenceNo! } : o));
      if (lastOf(ops) !== lastOf(after)) return { ok: false, reason: "last_operation_locked" };
    }
  }

  const timeChanged =
    (input.setupTime !== undefined && input.setupTime !== Number(op.setupTime)) ||
    (input.runTimePerUnit !== undefined && input.runTimePerUnit !== Number(op.runTimePerUnit));
  const replanNeeded = timeChanged || workCenterChanged || sequenceChanged;

  const before = await operationRow(tx, opId);
  await tx
    .update(moOperations)
    .set({
      sequenceNo: input.sequenceNo,
      description: input.description === undefined ? undefined : blankToNull(input.description),
      workCenterId: input.workCenterId,
      setupTime: input.setupTime === undefined ? undefined : String(input.setupTime),
      runTimePerUnit: input.runTimePerUnit === undefined ? undefined : String(input.runTimePerUnit),
      timeUnit: input.timeUnit,
      comment: input.comment === undefined ? undefined : blankToNull(input.comment),
      printOnWorkCard: input.printOnWorkCard,
      packingInstructions: input.packingInstructions === undefined ? undefined : blankToNull(input.packingInstructions),
      subcontractSupplierId: input.subcontractSupplierId,
      setupPrice: input.setupPrice === undefined ? undefined : input.setupPrice === null ? null : String(input.setupPrice),
      unitPrice: input.unitPrice === undefined ? undefined : input.unitPrice === null ? null : String(input.unitPrice),
      showNetWeight: input.showNetWeight,
      // The weeks were booked on the old resource: a locked operation that
      // changes resource loses its lock and is replanned like any other.
      planLocked: workCenterChanged && op.planLocked ? false : undefined,
    })
    .where(eq(moOperations.id, opId));
  const warnings = replanNeeded && replan ? await replan(tx, moId) : [];
  return { ok: true, order: locked.order, before, operation: await operationRow(tx, opId), warnings, replanned: replanNeeded && !!replan };
}

export async function removeOperationInTx(tx: Tx, moId: string, opId: string, replan?: OrderReplanner): Promise<RemoveOperationResult> {
  await lockProductionPlan(tx);
  const ops = await lockOrderOperations(tx, moId);
  const op = ops.find((o) => o.id === opId);
  if (!op) return { ok: false, reason: "operation_not_found" };
  const locked = await lockEditableOrder(tx, moId);
  if (!locked.ok) return locked;
  if (op.status === "done") return { ok: false, reason: "done" };
  if (await operationHasHistory(tx, op)) return { ok: false, reason: "reported" };
  if (await operationHasLinkedPurchase(tx, opId)) return { ok: false, reason: "linked_purchase" };
  if (Number(locked.order.quantityReceived) > 0 && lastOf(ops) === opId) return { ok: false, reason: "last_operation_locked" };

  const before = await operationRow(tx, opId);
  // The FK is ON DELETE set null; done explicitly so the count is known.
  const unlinked = await tx
    .update(moMaterialConsumptions)
    .set({ moOperationId: null })
    .where(eq(moMaterialConsumptions.moOperationId, opId))
    .returning({ id: moMaterialConsumptions.id });
  await tx.delete(moOperations).where(eq(moOperations.id, opId));
  const warnings = replan ? await replan(tx, moId) : [];
  return { ok: true, order: locked.order, before, warnings, unlinkedMaterials: unlinked.length };
}
