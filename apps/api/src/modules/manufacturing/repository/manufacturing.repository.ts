import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articles,
  bomComponents,
  deviationReasons,
  employees,
  manufacturingOrders,
  moMaterialConsumptions,
  moOperationScrap,
  moOperations,
  moReportMaterials,
  moReports,
  productionGroups,
  purchaseOrders,
  routingOperationFiles,
  routingOperations,
  stampSessions,
  stockTransactions,
  suppliers,
  timeReports,
  users,
  units,
  weekSchedules,
  workCenters,
  type Db,
} from "@navet/db";
import {
  ilikePattern,
  type CreateManufacturingOrderInput,
  type CreateMoOperationInput,
  type ManufacturingOrderConfiguration,
  type CreateProductionGroupInput,
  type CreateRoutingOperationInput,
  type CreateWorkCenterInput,
  type ListManufacturingOrdersQuery,
  type ListWorkCentersQuery,
  type UpdateMoOperationInput,
  type UpdateProductionGroupInput,
  type UpdateRoutingOperationInput,
  type UpdateWorkCenterInput,
} from "@navet/shared";
import type { SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { explodeBom } from "../../article/service/bom-explosion.js";
// Konfigurator 4c: the derived rows a beställningsvara's TO is created with —
// types only, no runtime coupling to the configurator module.
import type { ManufacturingMaterial, ManufacturingOperation } from "../../configurator/service/manufacturing-structure.js";
import { resolveStockLocation } from "../../stock/service/location-resolver.js";
import { deactivateEmptyLocation } from "../../stock/service/location-lifecycle.js";
// The one rule for how much of a configured row still lacks a TO (pure).
import { uncoveredConfiguredQuantity } from "../../planning/service/configured-coverage.js";
import { assertLocationNotUnderCount } from "../../stock/service/count-guard.js";
import { getNextOrderNumber } from "../../system/service/number-series.js";
// Produktionsplanering: a leaf with only the lock SQL — no module cycle.
import { lockProductionPlan } from "../../planning/repository/plan-lock.js";
import { pluginEvents } from "../../system/service/plugin-events.js";
// Regel 10 — a leaf that imports only the schema, so no module cycle.
import { closeStampSessionsInTx } from "../../timereport/repository/stamp-close.js";
// Materialbrist vid rapportering — a leaf like count-guard, called inside
// the report transactions after the draws are booked.
import {
  assertMaterialAvailable,
  MaterialShortageError,
  NO_MATERIAL_SHORTAGE_CHECK,
  type MaterialShortage,
  type MaterialShortageCheck,
} from "../service/material-shortage.js";
import { shortageWarnings } from "./shortage-warnings.js";
// Ändra material och operationer: the edit transactions and the row
// selects they share with the list endpoints.
import {
  addMaterialInTx,
  addOperationInTx,
  removeMaterialInTx,
  removeOperationInTx,
  selectMaterialRows,
  selectOperationRows,
  updateMaterialInTx,
  updateOperationInTx,
  type AddMaterialInput,
  type OrderReplanner,
  type UpdateMaterialInput,
} from "./order-edit.js";

export type ConsumeMaterialResult =
  | { ok: true; row: typeof moMaterialConsumptions.$inferSelect }
  | { ok: false; reason: "order_not_found" | "row_not_found" | "invalid_status" | "over_consumption" };

export type CompleteResult =
  | { ok: true; order: typeof manufacturingOrders.$inferSelect; consumed: ConsumedMaterialLine[]; received: number }
  | { ok: false; reason: "order_not_found" | "invalid_status" };

// What an automatic draw actually booked, per material row — the material
// row and location are what the report log keeps so Ångra can return it.
export interface ConsumedMaterialLine {
  componentArticleId: string;
  quantity: number;
  materialConsumptionId: string;
  locationId: string;
}

// Where a reporting event came from (mo_reports.source).
export type ReportSource = "terminal" | "card" | "purchase_receipt" | "auto_close";

export type UndoReportResult =
  | {
      ok: true;
      order: typeof manufacturingOrders.$inferSelect;
      statusBefore: (typeof manufacturingOrders.$inferSelect)["status"];
      report: typeof moReports.$inferSelect;
      timeReport: typeof timeReports.$inferSelect | null;
    }
  | { ok: false; reason: "report_not_found" | "already_undone" | "from_purchase_receipt" | "invalid_status" }
  | { ok: false; reason: "insufficient_stock"; available: number; required: number };

export type CancelResult =
  | { ok: true; order: typeof manufacturingOrders.$inferSelect }
  | { ok: false; reason: "order_not_found" | "invalid_status" | "has_reports" | "open_stamps" };

export type CompleteOperationResult =
  | {
      ok: true;
      operation: typeof moOperations.$inferSelect;
      // The mo_reports row this report wrote (a lego receipt links to it).
      reportId: string;
      consumed: ConsumedMaterialLine[];
      // Set when the report was on the order's last operation and received
      // finished goods; `completed` = the order reached its quantity and is done.
      receipt?: { order: typeof manufacturingOrders.$inferSelect; received: number; completed: boolean };
    }
  | { ok: false; reason: "operation_not_found" | "order_not_found" | "invalid_status" };

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Thrown at the end of a dry run so the transaction rolls back — never
// leaves the repository.
class DryRunRollback extends Error {
  constructor() {
    super("dry run");
    this.name = "DryRunRollback";
  }
}

// One incremental quantity report on an operation — see
// reportOperationQuantitiesInTx.
export interface ReportOperationQuantitiesInput {
  quantityOk: number;
  quantityScrapped: number;
  scrapReason?: string;
  // Kvalitet: the Avvikelseorsak (validated by the service).
  scrapReasonId?: string;
  actualTime?: number;
  locationId?: string;
  markDone: boolean;
  // Lego (subcontract) receipts don't know whether the operation is
  // covered — a manually shorted IO row must leave it pending. When
  // set, this overrides `markDone`: the operation only flips to done
  // once accumulated quantity_completed (this report included) reaches
  // the MO's order quantity, so a later receipt/report against the
  // same operation is what actually closes it.
  markDoneWhenCovered?: boolean;
  employeeId?: string;
  createdBy: string | null;
  // Report log: where the report came from, the stamp-out's time
  // report and, for a lego receipt, the IO.
  source: ReportSource;
  timeReportId?: string;
  purchaseOrderId?: string;
  // Materialbrist: how the drawn material is checked against stock —
  // omitted = not at all (see material-shortage.ts).
  materialShortage?: MaterialShortageCheck;
}

// Draws the material rows matching `operationFilter` up to what the reported
// quantity requires: target = planned/orderQuantity × reported, and only the
// difference against what's already consumed is booked. Over-reporting
// therefore pulls extra material, while a re-report or earlier manual
// consumption never double-books. Deliberately has no planned-quantity cap —
// that guard belongs to the manual consumeMaterial path.
async function consumeLinkedMaterial(
  tx: Tx,
  opts: {
    moId: string;
    orderQuantity: number;
    reportedQuantity: number;
    operationFilter: SQL;
    locationId?: string;
    createdBy: string | null;
  }
): Promise<ConsumedMaterialLine[]> {
  const rows = await tx
    .select()
    .from(moMaterialConsumptions)
    .where(and(eq(moMaterialConsumptions.manufacturingOrderId, opts.moId), opts.operationFilter))
    .for("update");

  const consumed: ConsumedMaterialLine[] = [];
  for (const row of rows) {
    const perUnit = opts.orderQuantity === 0 ? 0 : Number(row.quantityPlanned) / opts.orderQuantity;
    const target = perUnit * opts.reportedQuantity;
    const delta = target - Number(row.quantityConsumed);
    if (delta <= 0) continue;

    await tx
      .update(moMaterialConsumptions)
      .set({ quantityConsumed: String(Number(row.quantityConsumed) + delta) })
      .where(eq(moMaterialConsumptions.id, row.id));

    // Explicit location wins for the whole draw; otherwise each component
    // resolves to its own article default / "***".
    const locationId = await resolveStockLocation(tx, row.componentArticleId, opts.locationId);
    await assertLocationNotUnderCount(tx, locationId);
    await tx.insert(stockTransactions).values({
      articleId: row.componentArticleId,
      locationId,
      quantityDelta: String(-delta),
      transactionType: "mo_consumption",
      referenceId: opts.moId,
      createdBy: opts.createdBy,
    });
    // The draw may have emptied the location.
    await deactivateEmptyLocation(tx, locationId);

    consumed.push({ componentArticleId: row.componentArticleId, quantity: delta, materialConsumptionId: row.id, locationId });
  }
  return consumed;
}

// Writes one report-log row and the material it drew (see mo_reports).
async function insertReport(
  tx: Tx,
  values: typeof moReports.$inferInsert,
  materials: ConsumedMaterialLine[]
): Promise<typeof moReports.$inferSelect> {
  const [report] = await tx.insert(moReports).values(values).returning();
  if (materials.length > 0) {
    await tx.insert(moReportMaterials).values(
      materials.map((m) => ({
        moReportId: report!.id,
        materialConsumptionId: m.materialConsumptionId,
        quantity: String(m.quantity),
        locationId: m.locationId,
      }))
    );
  }
  return report!;
}

// Regel 10: an operation (or the whole order) turning done stamps out
// everyone still stamped in on it, inside the same transaction — the stamp
// leaf writes the time reports, the report log gets one time-only row per
// closed stamp so each can be undone from the TO card on its own.
async function autoCloseStamps(
  tx: Tx,
  scope: { operationIds: string[] } | { orderId: string },
  manufacturingOrderId: string,
  createdBy: string | null
) {
  const closed = await closeStampSessionsInTx(tx, {
    ...scope,
    at: new Date(),
    createdBy,
    note: "orderId" in scope ? "Automatisk utstämpling: ordern klar" : "Automatisk utstämpling: operationen klar",
  });
  for (const stamp of closed) {
    await insertReport(
      tx,
      {
        manufacturingOrderId,
        moOperationId: stamp.moOperationId,
        kind: "operation",
        source: "auto_close",
        timeReportId: stamp.timeReportId,
        employeeId: stamp.employeeId,
        createdBy,
      },
      []
    );
  }
}

// Normalization for the routing operation's optional texts (Kommentar and
// Beskrivning). The zod schemas already trim and turn a blanked input into
// null, but that only runs on the HTTP boundary — every in-process caller
// (the import planner, tests, a future service) reaches the repository
// directly, and "not filled in" must have exactly one representation in the
// column whichever way the row was written.
function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// Nullable numeric columns take strings; create: absent → null.
function numericOrNull(value: number | null | undefined): string | null {
  return value === undefined || value === null ? null : String(value);
}

// Patch semantics for the same columns: undefined = leave untouched.
function numericPatch(value: number | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : String(value);
}

// Per-order operation summary for GET /manufacturing-orders?withOperations=
// true — a slim operation view per order (e.g. for integrations), not the
// full operation row. Every requested id gets an entry (possibly []).
async function operationSummariesForOrders(db: Db, orderIds: string[]) {
  const summaries = new Map<string, OperationSummary[]>(orderIds.map((id) => [id, []]));
  if (orderIds.length === 0) return summaries;

  const rows = await db
    .select({
      id: moOperations.id,
      manufacturingOrderId: moOperations.manufacturingOrderId,
      sequenceNo: moOperations.sequenceNo,
      status: moOperations.status,
      description: moOperations.description,
      workCenterCode: workCenters.code,
      workCenterName: workCenters.name,
      workCenterType: workCenters.type,
      productionGroupCode: productionGroups.code,
      productionGroupName: productionGroups.name,
    })
    .from(moOperations)
    .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
    .leftJoin(productionGroups, eq(productionGroups.id, workCenters.productionGroupId))
    .where(inArray(moOperations.manufacturingOrderId, orderIds))
    .orderBy(asc(moOperations.manufacturingOrderId), asc(moOperations.sequenceNo));

  for (const { manufacturingOrderId, ...summary } of rows) {
    summaries.get(manufacturingOrderId)!.push(summary);
  }
  return summaries;
}

export interface OperationSummary {
  id: string;
  sequenceNo: number;
  status: (typeof moOperations.$inferSelect)["status"];
  description: string | null;
  workCenterCode: string;
  workCenterName: string;
  workCenterType: (typeof workCenters.$inferSelect)["type"];
  productionGroupCode: string | null;
  productionGroupName: string | null;
}

// Konfigurator 4c: a beställningsvara's TO is created WITH its derived
// structure (written in the same transaction) — the release that follows
// snapshots nothing for it. lockRow re-checks the row's key under the row
// lock (row before order, the same order Ändra konfiguration locks in); a
// mismatch returns "configuration_changed" and writes nothing.
export interface ConfiguredCreateInput {
  configuration: ManufacturingOrderConfiguration;
  operations: ManufacturingOperation[];
  materials: ManufacturingMaterial[];
  lockRow?: {
    rowId: string;
    expectedKey: string;
    lock: (
      tx: Tx,
      rowId: string
    ) => Promise<{ configurationKey: string | null; quantityOrdered: number; quantityDelivered: number } | null>;
    // Behovsberäkningens Skapa ordrar: never more than the row still lacks,
    // decided under the row lock — a proposal from a cached list, or two
    // clicks, must not give the row a second TO. The order card's Skapa TO
    // leaves it off (a deliberate extra TO is the operator's call).
    onlyUncovered?: boolean;
  };
}

// Produktionsplanering: plans the new TO's operations inside the create
// transaction and returns its warning texts (bound to the planning service
// in app.ts; absent in fixtures that never read the plan).
export type NewOrderPlanner = (tx: Tx, manufacturingOrderId: string) => Promise<string[]>;

export type CreateManufacturingOrderOutcome =
  | { ok: true; order: typeof manufacturingOrders.$inferSelect; warnings: string[] }
  | { ok: false; reason: "configuration_changed" }
  | { ok: false; reason: "already_covered"; uncovered: number };

// Finished-goods receipt (inleverans) up to `targetReceived` in total — the
// one implementation behind both the delinleverans from the last operation
// and Slutför. Only the increment over quantity_received is booked, so a
// repeated or lower target never double-books; the order row must already be
// locked FOR UPDATE by the caller. Material not tied to an operation is drawn
// with the same top-up rule, for the quantity received so far.
async function receiveFinishedGoods(
  tx: Tx,
  order: typeof manufacturingOrders.$inferSelect,
  opts: { targetReceived: number; locationId?: string; createdBy: string | null }
): Promise<{ received: number; delta: number; locationId: string | null; consumed: ConsumedMaterialLine[] }> {
  const already = Number(order.quantityReceived);
  const delta = Number((opts.targetReceived - already).toFixed(4));
  if (delta <= 0) return { received: already, delta: 0, locationId: null, consumed: [] };

  // unit_cost is the produced article's current standard cost, stamped at
  // receipt time — null (not 0) when no standard cost is set, since 0 would
  // be a false claim of zero value.
  const [producedArticle] = await tx
    .select({ standardCost: articles.standardCost })
    .from(articles)
    .where(eq(articles.id, order.articleId));

  const receiptLocationId = await resolveStockLocation(tx, order.articleId, opts.locationId);
  await assertLocationNotUnderCount(tx, receiptLocationId);

  await tx.insert(stockTransactions).values({
    articleId: order.articleId,
    locationId: receiptLocationId,
    quantityDelta: String(delta),
    transactionType: "mo_receipt",
    referenceId: order.id,
    createdBy: opts.createdBy,
    // Konfigurator 4c: a beställningsvara is valued at its own förkalkyl
    // (TVK/st at the TO quantity, stored at creation) — never the
    // template's standard cost, which describes no real configuration.
    unitCost: order.configuration
      ? (() => {
          // == null: a missing cost (older/partial jsonb) must never
          // become the string "undefined".
          const c = (order.configuration as ManufacturingOrderConfiguration).cost?.manufacturingCostPerUnit;
          return c == null ? null : String(c);
        })()
      : producedArticle?.standardCost ?? null,
  });

  const received = already + delta;
  // Material not tied to any operation follows the finished goods.
  const consumed = await consumeLinkedMaterial(tx, {
    moId: order.id,
    orderQuantity: Number(order.quantity),
    reportedQuantity: received,
    operationFilter: isNull(moMaterialConsumptions.moOperationId),
    locationId: opts.locationId,
    createdBy: opts.createdBy,
  });

  await tx
    .update(manufacturingOrders)
    .set({ quantityReceived: String(received), updatedAt: new Date() })
    .where(eq(manufacturingOrders.id, order.id));

  return { received, delta, locationId: receiptLocationId, consumed };
}

// One incremental quantity report on an operation, inside a given
// transaction: marks the operation done for `quantityOk` units, draws the
// material linked to it and, on the order's last operation, receives the
// finished goods. The draw tops up to what the reported quantity requires
// (target − already consumed), so manual pre-consumption isn't double-booked
// and over-reporting pulls extra material. One shared, incremental reporting
// path for the stamp terminal (every stamp-out), the MO card's "Slutför
// operation" and the lego receipt: quantities accumulate on the operation,
// scrap gets a mandatory-reason log row, and the operation's linked material
// tops up to perUnit × (total OK + total scrapped) — scrapped units consume
// components too. Tx-only so the terminal can dry-run it (see
// dryRunOperationReport) before the stamp-out writes anything.
async function reportOperationQuantitiesInTx(
  tx: Tx,
  operationId: string,
  input: ReportOperationQuantitiesInput
): Promise<CompleteOperationResult> {
  const [operation] = await tx
    .select()
    .from(moOperations)
    .where(eq(moOperations.id, operationId))
    .for("update");
  if (!operation) return { ok: false, reason: "operation_not_found" };

  // Locked (operation first, then order) so a report on the last
  // operation and Slutför never both receive the same units.
  const [order] = await tx
    .select()
    .from(manufacturingOrders)
    .where(eq(manufacturingOrders.id, operation.manufacturingOrderId))
    .for("update");
  if (!order) return { ok: false, reason: "order_not_found" };
  // Efterrapportering: a done order still takes reports — operations left
  // unreported when the last one completed the order get their quantities,
  // scrap and material — but receives no finished goods and keeps its
  // status. Stäng order (closed) is what locks it.
  const lateReport = order.status === "done";
  if (order.status !== "released" && order.status !== "in_progress" && !lateReport) {
    return { ok: false, reason: "invalid_status" };
  }

  const totalOk = Number(operation.quantityCompleted ?? 0) + input.quantityOk;
  const totalScrapped = Number(operation.quantityScrapped) + input.quantityScrapped;

  const shouldMarkDone = input.markDoneWhenCovered ? totalOk >= Number(order.quantity) : input.markDone;

  const [updatedOperation] = await tx
    .update(moOperations)
    .set({
      ...(shouldMarkDone ? { status: "done" as const } : {}),
      actualTime: input.actualTime !== undefined ? String(input.actualTime) : undefined,
      quantityCompleted: String(totalOk),
      quantityScrapped: String(totalScrapped),
    })
    .where(eq(moOperations.id, operationId))
    .returning();

  const reportId = randomUUID();
  let scrapId: string | null = null;
  if (input.quantityScrapped > 0) {
    const [scrapRow] = await tx.insert(moOperationScrap).values({
      moOperationId: operationId,
      quantity: String(input.quantityScrapped),
      reasonId: input.scrapReasonId ?? null,
      // The comment (or, without the register, the whole reason).
      reason: input.scrapReason?.trim() ? input.scrapReason.trim() : null,
      employeeId: input.employeeId ?? null,
      createdBy: input.createdBy,
    }).returning({ id: moOperationScrap.id });
    scrapId = scrapRow!.id;
  }

  const consumed = await consumeLinkedMaterial(tx, {
    moId: operation.manufacturingOrderId,
    orderQuantity: Number(order.quantity),
    reportedQuantity: totalOk + totalScrapped,
    operationFilter: eq(moMaterialConsumptions.moOperationId, operationId),
    locationId: input.locationId,
    createdBy: input.createdBy,
  });

  // Delinleverans: OK on the order's LAST operation is finished goods —
  // received at once (scrapped units never are), and the order is done
  // once the received quantity reaches the order quantity. Never on a done
  // order: its goods are already in (more takes undoing what closed it).
  const [last] = await tx
    .select({ sequenceNo: moOperations.sequenceNo })
    .from(moOperations)
    .where(eq(moOperations.manufacturingOrderId, operation.manufacturingOrderId))
    .orderBy(desc(moOperations.sequenceNo))
    .limit(1);
  const goods =
    !lateReport && last?.sequenceNo === operation.sequenceNo
      ? await receiveFinishedGoods(tx, order, { targetReceived: totalOk, createdBy: input.createdBy })
      : null;
  const completed = goods !== null && goods.delta > 0 && goods.received >= Number(order.quantity);

  // Materialbrist: everything this report drew, checked against total
  // stock now that it is booked — a throw rolls the whole report back.
  await assertMaterialAvailable(tx, [...consumed, ...(goods?.consumed ?? [])], input.materialShortage ?? NO_MATERIAL_SHORTAGE_CHECK);

  const markedDone = operation.status === "pending" && shouldMarkDone;

  // Logged with exactly what this report booked, so Ångra can reverse it.
  await insertReport(
    tx,
    {
      id: reportId,
      manufacturingOrderId: order.id,
      moOperationId: operationId,
      kind: "operation",
      source: input.source,
      quantityOk: String(input.quantityOk),
      quantityScrapped: String(input.quantityScrapped),
      markedDone,
      quantityReceived: String(goods?.delta ?? 0),
      receiptLocationId: goods?.locationId ?? null,
      completedOrder: completed,
      timeReportId: input.timeReportId ?? null,
      employeeId: input.employeeId ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      createdBy: input.createdBy,
    },
    [...consumed, ...(goods?.consumed ?? [])]
  );
  if (scrapId) {
    await tx.update(moOperationScrap).set({ moReportId: reportId }).where(eq(moOperationScrap.id, scrapId));
  }

  // Regel 10: nobody may keep reporting on an operation (or order) that
  // just turned done — the dry run rolls this back with everything else.
  if (completed) {
    await autoCloseStamps(tx, { orderId: order.id }, order.id, input.createdBy);
  } else if (markedDone) {
    await autoCloseStamps(tx, { operationIds: [operationId] }, order.id, input.createdBy);
  }

  if (goods === null || goods.delta === 0) {
    return { ok: true, operation: updatedOperation!, reportId, consumed: [...consumed, ...(goods?.consumed ?? [])] };
  }

  const [receivedOrder] = await tx
    .update(manufacturingOrders)
    // Stock now exists for the order: a released one is under way and
    // can no longer be cancelled.
    .set({ status: completed ? "done" : "in_progress", updatedAt: new Date() })
    .where(eq(manufacturingOrders.id, order.id))
    .returning();
  // Tillägg: the last operation's report made the order done.
  if (completed) {
    await pluginEvents.emit(tx, { type: "manufacturing_order.completed", entityId: order.id, entityNumber: order.orderNumber });
  }
  return {
    ok: true,
    operation: updatedOperation!,
    reportId,
    consumed: [...consumed, ...goods.consumed],
    receipt: { order: receivedOrder!, received: goods.delta, completed },
  };
}

// Snapshots BOM components (x MO quantity) into mo_material_consumptions and
// Routing operations into mo_operations, soft-checks stock_balances for
// shortages (warnings only) and flips the order to released. Tx-only so a new
// TO is released in its own create transaction (release at creation) and
// Släpp of an older planned TO runs the very same code.
async function releaseInTx(tx: Tx, moId: string) {
  const [order] = await tx.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, moId));
  if (!order) return null;

  // Konfigurator 4c: a beställningsvara's TO already has its derived
  // structure (written at creation) — nothing is snapshotted from the
  // template's BOM/route, only the shortage check runs.
  const configured = order.configuration !== null;

  // Phantom BOM components are resolved past into their own components
  // (quantities multiplied down the chain) — see bom-explosion.ts.
  const exploded = configured ? [] : await explodeBom(tx, order.articleId, Number(order.quantity));

  // Operations are snapshotted first so material rows can point at
  // them: a component linked to a routing operation is drawn when that
  // operation is reported complete.
  // "Kalkyl" rows are priced into the pre-calculation but never worked,
  // so they are dropped here rather than downstream — mo_operations is
  // what the terminal, the capacity view, the post-calculation and the
  // MO printout all read.
  const routing = configured
    ? []
    : (await tx.select().from(routingOperations).where(eq(routingOperations.articleId, order.articleId))).filter(
        (op) => !op.costingOnly
      );
  const operationRows =
    routing.length > 0
      ? await tx
          .insert(moOperations)
          .values(
            routing.map((op) => ({
              manufacturingOrderId: moId,
              sequenceNo: op.sequenceNo,
              routingOperationId: op.id,
              workCenterId: op.workCenterId,
              setupTime: op.setupTime,
              runTimePerUnit: op.runTimePerUnit,
              timeUnit: op.timeUnit,
              description: op.description,
              comment: op.comment,
              printOnWorkCard: op.printOnWorkCard,
              packingInstructions: op.packingInstructions,
              // Lego snapshot — the drawing is read live via
              // routingOperationId, everything else freezes at release.
              subcontractSupplierId: op.subcontractSupplierId,
              setupPrice: op.setupPrice,
              transportPrice: op.transportPrice,
              unitPrice: op.unitPrice,
              showNetWeight: op.showNetWeight,
            }))
          )
          .returning()
      : [];
  const operationByRoutingId = new Map(operationRows.map((op) => [op.routingOperationId, op.id]));

  // Soft shortage check over the material rows the TO now has — the
  // freshly snapshotted ones for a plain TO, the rows written at
  // creation for a configured one. Warnings only, never a refusal
  // (shortage-warnings.ts, shared with Ändra material).
  let warnings: string[] = [];
  if (configured) {
    const written = await tx
      .select({
        componentArticleId: moMaterialConsumptions.componentArticleId,
        quantityPlanned: moMaterialConsumptions.quantityPlanned,
        componentName: articles.name,
      })
      .from(moMaterialConsumptions)
      .innerJoin(articles, eq(articles.id, moMaterialConsumptions.componentArticleId))
      .where(eq(moMaterialConsumptions.manufacturingOrderId, moId))
      // Stable warning order: by component name, then row id.
      .orderBy(asc(articles.name), asc(moMaterialConsumptions.id));
    warnings = await shortageWarnings(tx, written, new Map(written.map((r) => [r.componentArticleId, r.componentName])));
  } else if (exploded.length > 0) {
    const materialRows = await tx
      .insert(moMaterialConsumptions)
      .values(
        exploded.map((c) => ({
          manufacturingOrderId: moId,
          componentArticleId: c.componentArticleId,
          moOperationId: c.routingOperationId ? operationByRoutingId.get(c.routingOperationId) ?? null : null,
          quantityPlanned: String(c.totalQuantity),
          // Display unit snapshot from the BOM row — quantities stay in
          // the base unit.
          unitId: c.unitId,
          unitFactor: c.unitFactor,
        }))
      )
      .returning();
    warnings = await shortageWarnings(tx, materialRows, new Map(exploded.map((c) => [c.componentArticleId, c.componentName])));
  }

  const [updatedOrder] = await tx
    .update(manufacturingOrders)
    .set({ status: "released", updatedAt: new Date() })
    .where(eq(manufacturingOrders.id, moId))
    .returning();

  return { order: updatedOrder!, warnings };
}

// Ångra rapportering, run in the caller's transaction. A lego receipt's
// report belongs to its IO: from the TO card (fromPurchaseReceipt false) it
// is refused, since undoing it there would leave the purchase receipt
// standing; from the IO's Ångra inleverans (true) only such a report is.
async function undoReportInTx(
  tx: Tx,
  reportId: string,
  input: { undoneBy: string; fromPurchaseReceipt: boolean }
): Promise<UndoReportResult> {
  const [report] = await tx.select().from(moReports).where(eq(moReports.id, reportId)).for("update");
  if (!report) return { ok: false, reason: "report_not_found" };
  if (report.undoneAt) return { ok: false, reason: "already_undone" };
  if ((report.source === "purchase_receipt") !== input.fromPurchaseReceipt) {
    return { ok: false, reason: input.fromPurchaseReceipt ? "report_not_found" : "from_purchase_receipt" };
  }

  const [operation] = report.moOperationId
    ? await tx.select().from(moOperations).where(eq(moOperations.id, report.moOperationId)).for("update")
    : [];
  const [order] = await tx
    .select()
    .from(manufacturingOrders)
    .where(eq(manufacturingOrders.id, report.manufacturingOrderId))
    .for("update");
  if (!order) return { ok: false, reason: "report_not_found" };
  if (order.status !== "released" && order.status !== "in_progress" && order.status !== "done") {
    return { ok: false, reason: "invalid_status" };
  }

  // Finished goods out of the location they went into.
  const received = Number(report.quantityReceived);
  if (received > 0 && report.receiptLocationId) {
    const [balance] = await tx
      .select({ quantity: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
      .from(stockTransactions)
      .where(and(eq(stockTransactions.articleId, order.articleId), eq(stockTransactions.locationId, report.receiptLocationId)));
    const available = Number(balance?.quantity ?? 0);
    if (available < received) return { ok: false, reason: "insufficient_stock", available, required: received };
    await assertLocationNotUnderCount(tx, report.receiptLocationId);
    await tx.insert(stockTransactions).values({
      articleId: order.articleId,
      locationId: report.receiptLocationId,
      quantityDelta: String(-received),
      transactionType: "mo_receipt",
      referenceId: order.id,
      createdBy: input.undoneBy,
    });
    await deactivateEmptyLocation(tx, report.receiptLocationId);
  }

  // Drawn material back to where it was drawn from.
  const lines = await tx.select().from(moReportMaterials).where(eq(moReportMaterials.moReportId, report.id));
  for (const line of lines) {
    const [row] = await tx
      .select()
      .from(moMaterialConsumptions)
      .where(eq(moMaterialConsumptions.id, line.materialConsumptionId))
      .for("update");
    if (!row) continue;
    const quantity = Number(line.quantity);
    await tx
      .update(moMaterialConsumptions)
      .set({ quantityConsumed: String(Math.max(Number(row.quantityConsumed) - quantity, 0)) })
      .where(eq(moMaterialConsumptions.id, row.id));
    // Reactivates the location if it was cleaned up after the draw.
    const locationId = await resolveStockLocation(tx, row.componentArticleId, line.locationId);
    await assertLocationNotUnderCount(tx, locationId);
    await tx.insert(stockTransactions).values({
      articleId: row.componentArticleId,
      locationId,
      quantityDelta: String(quantity),
      transactionType: "mo_consumption",
      referenceId: order.id,
      createdBy: input.undoneBy,
    });
  }

  // The operation's quantities, scrap rows and done flag.
  if (operation) {
    const newOk = Math.max(Number(operation.quantityCompleted ?? 0) - Number(report.quantityOk), 0);
    const newScrapped = Math.max(Number(operation.quantityScrapped) - Number(report.quantityScrapped), 0);
    await tx.delete(moOperationScrap).where(eq(moOperationScrap.moReportId, report.id));
    // Reopened when this report closed it, or when what remains no
    // longer covers the order and no other live report closed it.
    const [otherMarker] = await tx
      .select({ id: moReports.id })
      .from(moReports)
      .where(
        and(
          eq(moReports.moOperationId, operation.id),
          ne(moReports.id, report.id),
          isNull(moReports.undoneAt),
          eq(moReports.markedDone, true)
        )
      )
      .limit(1);
    const reopen =
      operation.status === "done" && (report.markedDone || (newOk < Number(order.quantity) && !otherMarker));
    await tx
      .update(moOperations)
      .set({
        quantityCompleted: operation.quantityCompleted === null && newOk === 0 ? null : String(newOk),
        quantityScrapped: String(newScrapped),
        ...(reopen ? { status: "pending" as const } : {}),
      })
      .where(eq(moOperations.id, operation.id));
  }

  // The stamp's time report (stamp_sessions.time_report_id is ON
  // DELETE SET NULL; the payroll period lock is checked by the service).
  let timeReport: typeof timeReports.$inferSelect | null = null;
  if (report.timeReportId) {
    const [deleted] = await tx.delete(timeReports).where(eq(timeReports.id, report.timeReportId)).returning();
    timeReport = deleted ?? null;
  }

  await tx
    .update(moReports)
    .set({ undoneAt: new Date(), undoneBy: input.undoneBy })
    .where(eq(moReports.id, report.id));

  // The order stays done while a live Slutför order stands or the
  // received quantity still covers the order. A done order that no
  // longer is reopens — under way when anything is still reported on
  // it, else released; an open order keeps its status (stamping in
  // starts it, and nothing here un-starts it).
  const newReceived = Math.max(Number(order.quantityReceived) - received, 0);
  const live = await tx
    .select({ kind: moReports.kind })
    .from(moReports)
    .where(and(eq(moReports.manufacturingOrderId, order.id), isNull(moReports.undoneAt)));
  const stillDone = live.some((r) => r.kind === "completion") || newReceived >= Number(order.quantity);
  const status =
    order.status !== "done"
      ? order.status
      : stillDone
        ? "done"
        : newReceived > 0 || live.length > 0
          ? "in_progress"
          : "released";
  const [updatedOrder] = await tx
    .update(manufacturingOrders)
    .set({ quantityReceived: String(newReceived), status, updatedAt: new Date() })
    .where(eq(manufacturingOrders.id, order.id))
    .returning();

  return { ok: true, order: updatedOrder!, statusBefore: order.status, report, timeReport };
}

export function createManufacturingRepository(db: Db) {
  return {
    async createWorkCenter(input: CreateWorkCenterInput) {
      const [row] = await db
        .insert(workCenters)
        .values({
          code: input.code,
          name: input.name,
          type: input.type,
          productionGroupId: input.productionGroupId ?? null,
          hourlyRate: String(input.hourlyRate ?? 0),
          overheadPercent: String(input.overheadPercent ?? 0),
          weekScheduleId: input.weekScheduleId ?? null,
          capacityFactor: String(input.capacityFactor ?? 1),
          hoursPerDay: numericOrNull(input.hoursPerDay),
          supplierId: input.supplierId ?? null,
          active: input.active,
          defaultSetupTime: numericOrNull(input.defaultSetupTime),
          defaultOperationName: blankToNull(input.defaultOperationName),
          rateAppliesToSetup: input.rateAppliesToSetup ?? null,
          rateAppliesToRun: input.rateAppliesToRun ?? null,
          calcRate1: numericOrNull(input.calcRate1),
          calcRate2: numericOrNull(input.calcRate2),
          leadTimeDays: numericOrNull(input.leadTimeDays),
          queueTimeDays: numericOrNull(input.queueTimeDays),
          orderLeadTimeDays: numericOrNull(input.orderLeadTimeDays),
        })
        .returning();
      return row!;
    },

    async findWorkCenterById(id: string) {
      const [row] = await db.select().from(workCenters).where(eq(workCenters.id, id));
      return row ?? null;
    },

    async findWorkCenterByCode(code: string) {
      const [row] = await db.select().from(workCenters).where(eq(workCenters.code, code));
      return row ?? null;
    },

    async updateWorkCenter(id: string, input: UpdateWorkCenterInput) {
      const [row] = await db
        .update(workCenters)
        .set({
          ...input,
          hourlyRate: input.hourlyRate === undefined ? undefined : String(input.hourlyRate),
          overheadPercent: input.overheadPercent === undefined ? undefined : String(input.overheadPercent),
          capacityFactor: input.capacityFactor === undefined ? undefined : String(input.capacityFactor),
          // Nullable numerics: undefined = untouched, null = cleared.
          hoursPerDay: numericPatch(input.hoursPerDay),
          defaultSetupTime: numericPatch(input.defaultSetupTime),
          calcRate1: numericPatch(input.calcRate1),
          calcRate2: numericPatch(input.calcRate2),
          leadTimeDays: numericPatch(input.leadTimeDays),
          queueTimeDays: numericPatch(input.queueTimeDays),
          orderLeadTimeDays: numericPatch(input.orderLeadTimeDays),
          defaultOperationName:
            input.defaultOperationName === undefined ? undefined : blankToNull(input.defaultOperationName),
        })
        .where(eq(workCenters.id, id))
        .returning();
      return row ?? null;
    },

    // Terminal: every stampable operation (released/in-progress order,
    // pending, not lego), plus ALL operations of those orders for the
    // readiness rule (the previous operation may sit at another station or
    // be lego) and the material rows linked to the listed operations.
    async terminalOperationRows(workCenterIds?: string[]) {
      const listed = await db
        .select({
          operationId: moOperations.id,
          manufacturingOrderId: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          orderQuantity: manufacturingOrders.quantity,
          dueDate: manufacturingOrders.dueDate,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          sequenceNo: moOperations.sequenceNo,
          description: moOperations.description,
          workCenterId: workCenters.id,
          workCenterCode: workCenters.code,
          workCenterName: workCenters.name,
          quantityCompleted: moOperations.quantityCompleted,
          quantityScrapped: moOperations.quantityScrapped,
          packingInstructions: moOperations.packingInstructions,
          plannedStartWeek: moOperations.plannedStartWeek,
          plannedEndWeek: moOperations.plannedEndWeek,
        })
        .from(moOperations)
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .where(
          and(
            inArray(manufacturingOrders.status, ["released", "in_progress"]),
            eq(moOperations.status, "pending"),
            ne(workCenters.type, "subcontract"),
            workCenterIds && workCenterIds.length > 0 ? inArray(moOperations.workCenterId, workCenterIds) : undefined
          )
        );
      const orderIds = [...new Set(listed.map((r) => r.manufacturingOrderId))];
      const operationIds = listed.map((r) => r.operationId);
      const [siblings, materials] = await Promise.all([
        orderIds.length === 0
          ? []
          : db
              .select({
                id: moOperations.id,
                manufacturingOrderId: moOperations.manufacturingOrderId,
                sequenceNo: moOperations.sequenceNo,
                status: moOperations.status,
                quantityCompleted: moOperations.quantityCompleted,
              })
              .from(moOperations)
              .where(inArray(moOperations.manufacturingOrderId, orderIds)),
        operationIds.length === 0
          ? []
          : db
              .select({
                moOperationId: moMaterialConsumptions.moOperationId,
                articleId: articles.id,
                articleNumber: articles.articleNumber,
                articleName: articles.name,
              })
              .from(moMaterialConsumptions)
              .innerJoin(articles, eq(articles.id, moMaterialConsumptions.componentArticleId))
              .where(inArray(moMaterialConsumptions.moOperationId, operationIds)),
      ]);
      return { listed, siblings, materials };
    },

    // Stations for the terminal: active, non-lego work centers. Sorted by the
    // service (natural number order).
    async terminalStations() {
      return db
        .select({ id: workCenters.id, code: workCenters.code, name: workCenters.name })
        .from(workCenters)
        .where(and(eq(workCenters.active, true), ne(workCenters.type, "subcontract")));
    },

    async listWorkCenters(query?: ListWorkCentersQuery) {
      return db
        .select({
          ...getTableColumns(workCenters),
          productionGroupCode: productionGroups.code,
          productionGroupName: productionGroups.name,
          weekScheduleCode: weekSchedules.code,
          weekScheduleName: weekSchedules.name,
          supplierName: suppliers.name,
        })
        .from(workCenters)
        .leftJoin(productionGroups, eq(productionGroups.id, workCenters.productionGroupId))
        .leftJoin(weekSchedules, eq(weekSchedules.id, workCenters.weekScheduleId))
        .leftJoin(suppliers, eq(suppliers.id, workCenters.supplierId))
        .where(query?.type ? inArray(workCenters.type, query.type) : undefined)
        .orderBy(asc(workCenters.code));
    },

    async createProductionGroup(input: CreateProductionGroupInput) {
      const [row] = await db.insert(productionGroups).values(input).returning();
      return row!;
    },

    async updateProductionGroup(id: string, input: UpdateProductionGroupInput) {
      const [row] = await db.update(productionGroups).set(input).where(eq(productionGroups.id, id)).returning();
      return row ?? null;
    },

    async findProductionGroupById(id: string) {
      const [row] = await db.select().from(productionGroups).where(eq(productionGroups.id, id));
      return row ?? null;
    },

    async listProductionGroups() {
      return db
        .select({
          ...getTableColumns(productionGroups),
          // NB: ${productionGroups.id} would render as unqualified "id" here,
          // which the subquery would resolve against its own table — the
          // correlation must be table-qualified explicitly.
          workCenterCount: sql<number>`(select count(*)::int from ${workCenters} w where w.production_group_id = ${productionGroups}.id)`,
        })
        .from(productionGroups)
        .orderBy(productionGroups.code);
    },

    async listProductionGroupWorkCenters(productionGroupId: string) {
      return db
        .select({ id: workCenters.id, code: workCenters.code, name: workCenters.name, type: workCenters.type })
        .from(workCenters)
        .where(eq(workCenters.productionGroupId, productionGroupId))
        .orderBy(asc(workCenters.code));
    },

    // Replace-the-set semantics: the checkbox UI sends the group's complete
    // resource list. Checking a resource moves it here (even from another
    // group); unchecking clears its group.
    async setProductionGroupWorkCenters(productionGroupId: string, workCenterIds: string[]) {
      await db.transaction(async (tx) => {
        await tx
          .update(workCenters)
          .set({ productionGroupId: null })
          .where(
            and(
              eq(workCenters.productionGroupId, productionGroupId),
              workCenterIds.length > 0 ? notInArray(workCenters.id, workCenterIds) : undefined
            )
          );
        if (workCenterIds.length > 0) {
          await tx.update(workCenters).set({ productionGroupId }).where(inArray(workCenters.id, workCenterIds));
        }
      });
    },

    async createRoutingOperation(articleId: string, input: CreateRoutingOperationInput) {
      const [row] = await db
        .insert(routingOperations)
        .values({
          articleId,
          sequenceNo: input.sequenceNo,
          description: blankToNull(input.description),
          workCenterId: input.workCenterId,
          setupTime: String(input.setupTime),
          runTimePerUnit: String(input.runTimePerUnit),
          cycleTimePerUnit: input.cycleTimePerUnit != null ? String(input.cycleTimePerUnit) : null,
          timeUnit: input.timeUnit ?? "minutes_per_unit",
          costingOnly: input.costingOnly ?? false,
          comment: blankToNull(input.comment),
          printOnWorkCard: input.printOnWorkCard ?? false,
          packingInstructions: blankToNull(input.packingInstructions),
          subcontractSupplierId: input.subcontractSupplierId ?? null,
          setupPrice: input.setupPrice != null ? String(input.setupPrice) : null,
          transportPrice: input.transportPrice != null ? String(input.transportPrice) : null,
          unitPrice: input.unitPrice != null ? String(input.unitPrice) : null,
          showNetWeight: input.showNetWeight ?? false,
          useArticleDrawing: input.useArticleDrawing ?? true,
        })
        .returning();
      return row!;
    },

    // Scoped to the article so a row id from another article's routing 404s.
    async updateRoutingOperation(articleId: string, operationId: string, input: UpdateRoutingOperationInput) {
      const [row] = await db
        .update(routingOperations)
        .set({
          ...input,
          setupTime: input.setupTime === undefined ? undefined : String(input.setupTime),
          runTimePerUnit: input.runTimePerUnit === undefined ? undefined : String(input.runTimePerUnit),
          cycleTimePerUnit:
            input.cycleTimePerUnit === undefined
              ? undefined
              : input.cycleTimePerUnit === null
                ? null
                : String(input.cycleTimePerUnit),
          comment: input.comment === undefined ? undefined : blankToNull(input.comment),
          packingInstructions:
            input.packingInstructions === undefined ? undefined : blankToNull(input.packingInstructions),
          description: input.description === undefined ? undefined : blankToNull(input.description),
          setupPrice: input.setupPrice === undefined ? undefined : input.setupPrice === null ? null : String(input.setupPrice),
          transportPrice:
            input.transportPrice === undefined ? undefined : input.transportPrice === null ? null : String(input.transportPrice),
          unitPrice: input.unitPrice === undefined ? undefined : input.unitPrice === null ? null : String(input.unitPrice),
        })
        .where(and(eq(routingOperations.id, operationId), eq(routingOperations.articleId, articleId)))
        .returning();
      return row ?? null;
    },

    // Guards the "Kalkyl" flag: a BOM row linked to an operation that never
    // reaches the MO would silently fall through to final completion, so the
    // combination is refused. The mirror-image read lives in
    // article.repository.ts's findRoutingOperationById.
    async countBomComponentsForOperation(operationId: string) {
      const [row] = await db
        .select({ value: count() })
        .from(bomComponents)
        .where(eq(bomComponents.routingOperationId, operationId));
      return row?.value ?? 0;
    },

    async deleteRoutingOperation(articleId: string, operationId: string) {
      const [row] = await db
        .delete(routingOperations)
        .where(and(eq(routingOperations.id, operationId), eq(routingOperations.articleId, articleId)))
        .returning();
      return row ?? null;
    },

    async listRoutingOperationsByArticle(articleId: string) {
      // hasFile via EXISTS — list queries must never select the bytea data.
      return db
        .select({
          ...getTableColumns(routingOperations),
          workCenterName: workCenters.name,
          workCenterCode: workCenters.code,
          workCenterType: workCenters.type,
          subcontractSupplierName: suppliers.name,
          hasFile: sql<boolean>`exists (select 1 from ${routingOperationFiles} rof where rof.routing_operation_id = ${routingOperations}.id)`,
        })
        .from(routingOperations)
        .innerJoin(workCenters, eq(workCenters.id, routingOperations.workCenterId))
        .leftJoin(suppliers, eq(suppliers.id, routingOperations.subcontractSupplierId))
        .where(eq(routingOperations.articleId, articleId));
    },

    // Feeds the inquiry row form's Legooperation select — the article's own
    // lego routing operations (beredning) and open TO lego operations for
    // the same article. Same population as planning.repository.ts's
    // legoOperations() for the MO half, deliberately not imported from there
    // (this module doesn't depend on planning).
    async listLegoOperationOptions(articleId: string) {
      const routing = await db
        .select({
          id: routingOperations.id,
          sequenceNo: routingOperations.sequenceNo,
          description: routingOperations.description,
          supplierId: routingOperations.subcontractSupplierId,
          setupPrice: routingOperations.setupPrice,
          unitPrice: routingOperations.unitPrice,
        })
        .from(routingOperations)
        .innerJoin(workCenters, eq(workCenters.id, routingOperations.workCenterId))
        .where(and(eq(routingOperations.articleId, articleId), eq(workCenters.type, "subcontract")))
        .orderBy(asc(routingOperations.sequenceNo));

      const mo = await db
        .select({
          moOperationId: moOperations.id,
          routingOperationId: moOperations.routingOperationId,
          orderNumber: manufacturingOrders.orderNumber,
          sequenceNo: moOperations.sequenceNo,
          description: moOperations.description,
          supplierId: moOperations.subcontractSupplierId,
          setupPrice: moOperations.setupPrice,
          unitPrice: moOperations.unitPrice,
        })
        .from(moOperations)
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .where(
          and(
            eq(manufacturingOrders.articleId, articleId),
            inArray(manufacturingOrders.status, ["released", "in_progress"]),
            eq(moOperations.status, "pending"),
            eq(workCenters.type, "subcontract")
          )
        )
        .orderBy(asc(manufacturingOrders.orderNumber), asc(moOperations.sequenceNo));

      return { routing, mo };
    },

    // --- Lego operation drawing (one per operation, routing_operation_files) ---

    async findRoutingOperation(articleId: string, operationId: string) {
      const [row] = await db
        .select()
        .from(routingOperations)
        .where(and(eq(routingOperations.id, operationId), eq(routingOperations.articleId, articleId)));
      return row ?? null;
    },

    // Metadata only — never the bytea column.
    async findOperationFileMeta(operationId: string) {
      const [row] = await db
        .select({
          id: routingOperationFiles.id,
          routingOperationId: routingOperationFiles.routingOperationId,
          filename: routingOperationFiles.filename,
          contentType: routingOperationFiles.contentType,
          sizeBytes: routingOperationFiles.sizeBytes,
          createdAt: routingOperationFiles.createdAt,
        })
        .from(routingOperationFiles)
        .where(eq(routingOperationFiles.routingOperationId, operationId));
      return row ?? null;
    },

    async getOperationFileWithData(operationId: string) {
      const [row] = await db
        .select()
        .from(routingOperationFiles)
        .where(eq(routingOperationFiles.routingOperationId, operationId));
      return row ?? null;
    },

    // PUT semantics: one drawing per operation — replacing overwrites in one
    // statement (the UNIQUE constraint backs the upsert).
    async upsertOperationFile(
      operationId: string,
      file: { filename: string; contentType: string; sizeBytes: number; data: Buffer }
    ) {
      const [row] = await db
        .insert(routingOperationFiles)
        .values({ routingOperationId: operationId, ...file })
        .onConflictDoUpdate({
          target: routingOperationFiles.routingOperationId,
          set: {
            filename: file.filename,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            data: file.data,
            createdAt: new Date(),
          },
        })
        .returning({
          id: routingOperationFiles.id,
          routingOperationId: routingOperationFiles.routingOperationId,
          filename: routingOperationFiles.filename,
          contentType: routingOperationFiles.contentType,
          sizeBytes: routingOperationFiles.sizeBytes,
          createdAt: routingOperationFiles.createdAt,
        });
      return row!;
    },

    async deleteOperationFile(operationId: string) {
      const [row] = await db
        .delete(routingOperationFiles)
        .where(eq(routingOperationFiles.routingOperationId, operationId))
        .returning({ id: routingOperationFiles.id });
      return row ?? null;
    },

    // E3 (KO→TO-koppling): linkedSalesOrder is threaded in from the service
    // call (validated against the row before this tx even starts) rather
    // than injected into this factory — same call-parameter shape as
    // VerificationPoster passed into invoice.repository.ts's issueInvoice.
    // markInProduction runs LAST, inside this same transaction, so the MO
    // insert and the KO's autoflip are one atomic unit.
    async createManufacturingOrder(
      input: CreateManufacturingOrderInput & { articleId: string },
      createdBy: string | null,
      linkedSalesOrder?: { salesOrderId: string; markInProduction: (tx: Tx, salesOrderId: string) => Promise<void> },
      configured?: ConfiguredCreateInput,
      plan?: NewOrderPlanner
    ): Promise<CreateManufacturingOrderOutcome> {
      return db.transaction((tx) => this.createManufacturingOrderInTx(tx, input, createdBy, linkedSalesOrder, configured, plan));
    },

    // The create transaction's body, Tx-only so the reservation
    // (Leveranstidskontrollen's Använd datumet) can create a whole tree of
    // TOs in ONE transaction. Order inside: the production_plan advisory
    // lock FIRST (before the KO row lock and the order number — the lock
    // order is always advisory → rows, so a TO created while Planera runs is
    // either in Planera's reading or planned against Planera's result, never
    // in between), then the row lock, the number, the insert, the release,
    // the plan (`plan`, bound to the planning service) and the KO autoflip.
    async createManufacturingOrderInTx(
      tx: Tx,
      input: CreateManufacturingOrderInput & { articleId: string },
      createdBy: string | null,
      linkedSalesOrder?: { salesOrderId: string; markInProduction: (tx: Tx, salesOrderId: string) => Promise<void> },
      // Konfigurator 4c (ConfiguredCreateInput): the row lock is the first
      // row lock of the transaction, right after the advisory lock.
      configured?: ConfiguredCreateInput,
      plan?: NewOrderPlanner
    ): Promise<CreateManufacturingOrderOutcome> {
      await lockProductionPlan(tx);
      if (configured?.lockRow) {
        const locked = await configured.lockRow.lock(tx, configured.lockRow.rowId);
        if (!locked || locked.configurationKey !== configured.lockRow.expectedKey) {
          return { ok: false, reason: "configuration_changed" };
        }
        if (configured.lockRow.onlyUncovered) {
          const linkedOrders = await tx
            .select({ status: manufacturingOrders.status, quantity: manufacturingOrders.quantity })
            .from(manufacturingOrders)
            .where(and(eq(manufacturingOrders.salesOrderRowId, configured.lockRow.rowId), ne(manufacturingOrders.status, "cancelled")));
          const uncovered = uncoveredConfiguredQuantity({
            quantityOrdered: locked.quantityOrdered,
            quantityDelivered: locked.quantityDelivered,
            linkedOrders: linkedOrders.map((o) => ({ status: o.status, quantity: Number(o.quantity) })),
          });
          if (input.quantity > uncovered + 0.00005) return { ok: false, reason: "already_covered", uncovered };
        }
      }
      const orderNumber = await getNextOrderNumber(tx, "manufacturing_order");
      const [row] = await tx
        .insert(manufacturingOrders)
        .values({
          orderNumber,
          articleId: input.articleId,
          quantity: String(input.quantity),
          note: input.note,
          dueDate: input.dueDate ?? null,
          salesOrderRowId: input.salesOrderRowId,
          configuration: configured?.configuration ?? null,
          createdBy,
        })
        .returning();
      if (configured) {
        // Operations first so the material rows can point at them — the
        // same shape release writes for a plain TO.
        const inserted =
          configured.operations.length > 0
            ? await tx
                .insert(moOperations)
                .values(configured.operations.map((op) => ({ ...op, manufacturingOrderId: row!.id })))
                .returning()
            : [];
        const opIdBySeq = new Map(inserted.map((o) => [o.sequenceNo, o.id]));
        if (configured.materials.length > 0) {
          await tx.insert(moMaterialConsumptions).values(
            configured.materials.map((m) => ({
              manufacturingOrderId: row!.id,
              componentArticleId: m.componentArticleId,
              moOperationId: m.operationSequenceNo === null ? null : opIdBySeq.get(m.operationSequenceNo) ?? null,
              quantityPlanned: String(Number(m.totalQuantity.toFixed(4))),
              unitId: m.unitId,
              unitFactor: m.unitFactor,
            }))
          );
        }
      }
      // Release at creation: the TO is stampable in the terminal at once.
      // A configured TO's rows were written above, so release only runs
      // its shortage check for it.
      const released = (await releaseInTx(tx, row!.id))!;
      // Produktionsplanering: the new TO's operations are planned on free
      // capacity against every other open operation, in this same
      // transaction (the horizon only adds a warning, never a refusal).
      const planWarnings = plan ? await plan(tx, row!.id) : [];
      if (linkedSalesOrder) await linkedSalesOrder.markInProduction(tx, linkedSalesOrder.salesOrderId);
      // Tillägg: every way a TO is created ends here, in its transaction.
      await pluginEvents.emit(tx, { type: "manufacturing_order.created", entityId: row!.id, entityNumber: row!.orderNumber });
      return { ok: true, order: released.order, warnings: [...released.warnings, ...planWarnings] };
    },

    // E3 (KO→TO-koppling): coverage ("varav i tillverkning") for a batch of
    // sales order rows — one query, grouped in JS (same shape as
    // getInvoicedQuantitiesWith in sales/repository/invoice.repository.ts),
    // rather than a SQL GROUP BY, because the caller needs the linked orders
    // themselves (id/orderNumber/status/quantity), not just the sum.
    // Cancelled MOs never count towards coverage — a cancelled TO frees the
    // quantity back up for a new one.
    async coverageForSalesOrderRows(rowIds: string[]) {
      const coverage = new Map<string, { quantity: number; orders: { id: string; orderNumber: string; status: string; quantity: string; quantityReceived: string }[] }>();
      if (rowIds.length === 0) return coverage;

      const rows = await db
        .select({
          salesOrderRowId: manufacturingOrders.salesOrderRowId,
          id: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          status: manufacturingOrders.status,
          quantity: manufacturingOrders.quantity,
          quantityReceived: manufacturingOrders.quantityReceived,
        })
        .from(manufacturingOrders)
        .where(and(inArray(manufacturingOrders.salesOrderRowId, rowIds), ne(manufacturingOrders.status, "cancelled")));

      for (const row of rows) {
        if (!row.salesOrderRowId) continue;
        const entry = coverage.get(row.salesOrderRowId) ?? { quantity: 0, orders: [] };
        entry.quantity += Number(row.quantity);
        entry.orders.push({
          id: row.id,
          orderNumber: row.orderNumber,
          status: row.status,
          quantity: row.quantity,
          quantityReceived: row.quantityReceived,
        });
        coverage.set(row.salesOrderRowId, entry);
      }
      return coverage;
    },

    async findManufacturingOrderById(id: string) {
      const [row] = await db
        .select({
          ...getTableColumns(manufacturingOrders),
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          // Extra benämning — printed on the TO when the setting lists it.
          articleExtraDescription: articles.extraDescription,
          // The article's base unit — MO quantities are always base-unit.
          // Printed on the pallet card (Etapp F).
          articleUnitCode: units.code,
        })
        .from(manufacturingOrders)
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .where(eq(manufacturingOrders.id, id));
      return row ?? null;
    },

    // Header update — today only the planned finish date (E2); everything
    // else moves through status transitions.
    async updateManufacturingOrder(id: string, input: { dueDate: string | null }) {
      const [row] = await db
        .update(manufacturingOrders)
        .set({ dueDate: input.dueDate, updatedAt: new Date() })
        .where(eq(manufacturingOrders.id, id))
        .returning();
      return row ?? null;
    },

    async listManufacturingOrders(query: ListManufacturingOrdersQuery) {
      const conditions = [];
      if (query.search) {
        const pattern = ilikePattern(query.search);
        conditions.push(
          or(
            ilike(manufacturingOrders.orderNumber, pattern),
            ilike(articles.articleNumber, pattern),
            ilike(articles.name, pattern)
          )
        );
      }
      if (query.status) conditions.push(inArray(manufacturingOrders.status, query.status));
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select({ ...getTableColumns(manufacturingOrders), articleNumber: articles.articleNumber, articleName: articles.name })
          .from(manufacturingOrders)
          .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
          .where(where)
          .orderBy(desc(manufacturingOrders.orderNumber))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(manufacturingOrders)
          .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
          .where(where),
      ]);
      const total = totalRows[0]!.total;
      if (!query.withOperations) return { rows, total };

      // Opt-in (withOperations): each order's operation summaries, e.g. for
      // integrations. One batched query for the page, merged in JS — same shape as
      // coverageForSalesOrderRows — so the plain register list never pays.
      const summaries = await operationSummariesForOrders(db, rows.map((row) => row.id));
      return { rows: rows.map((row) => ({ ...row, operations: summaries.get(row.id) ?? [] })), total };
    },

    async updateStatus(id: string, status: (typeof manufacturingOrders.$inferSelect)["status"]) {
      const [row] = await db
        .update(manufacturingOrders)
        .set({ status, updatedAt: new Date() })
        .where(eq(manufacturingOrders.id, id))
        .returning();
      return row ?? null;
    },

    // Row shape shared with Ändra material (order-edit.ts): the unit the
    // row displays in is the unit snapshotted on the row (the BOM row's at
    // release), falling back to the component's base unit.
    async listMaterialConsumptions(manufacturingOrderId: string) {
      return selectMaterialRows(db)
        .where(eq(moMaterialConsumptions.manufacturingOrderId, manufacturingOrderId))
        .orderBy(asc(articles.articleNumber));
    },

    // Row shape shared with Ändra operationer (order-edit.ts): the work
    // card and the terminal show the description where the resource name
    // used to be, so the code rides along; the terminal hides lego
    // operations (they are bought, not stamped) and the MO card badges them.
    async listOperations(manufacturingOrderId: string) {
      return selectOperationRows(db).where(eq(moOperations.manufacturingOrderId, manufacturingOrderId)).orderBy(moOperations.sequenceNo);
    },

    // --- Ändra material och operationer (order-edit.ts) — each edit is one
    // transaction; the plan reader replans the order's operations inside it.
    async addMaterial(moId: string, input: AddMaterialInput) {
      return db.transaction((tx) => addMaterialInTx(tx, moId, input));
    },
    async updateMaterial(moId: string, rowId: string, input: UpdateMaterialInput) {
      return db.transaction((tx) => updateMaterialInTx(tx, moId, rowId, input));
    },
    async removeMaterial(moId: string, rowId: string) {
      return db.transaction((tx) => removeMaterialInTx(tx, moId, rowId));
    },
    async addOperation(moId: string, input: CreateMoOperationInput, replan?: OrderReplanner) {
      return db.transaction((tx) => addOperationInTx(tx, moId, input, replan));
    },
    async updateOperation(moId: string, opId: string, input: UpdateMoOperationInput, replan?: OrderReplanner) {
      return db.transaction((tx) => updateOperationInTx(tx, moId, opId, input, replan));
    },
    async removeOperation(moId: string, opId: string, replan?: OrderReplanner) {
      return db.transaction((tx) => removeOperationInTx(tx, moId, opId, replan));
    },

    // Atomic: Släpp of a TO still in planned — see releaseInTx.
    async release(moId: string) {
      return db.transaction((tx) => releaseInTx(tx, moId));
    },

    async findMaterialConsumptionById(rowId: string) {
      const [row] = await db.select().from(moMaterialConsumptions).where(eq(moMaterialConsumptions.id, rowId));
      return row ?? null;
    },

    // Atomic: locks the material row, validates order status + remaining
    // quantity, records the stock movement — mirrors purchase.repository.ts's
    // receiveGoods / sales.repository.ts's deliverGoods.
    async consumeMaterial(
      moId: string,
      rowId: string,
      input: { locationId?: string; quantity: number; createdBy: string; materialShortage?: MaterialShortageCheck }
    ): Promise<ConsumeMaterialResult> {
      return db.transaction(async (tx) => {
        const [order] = await tx.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, moId));
        if (!order) return { ok: false, reason: "order_not_found" };
        // Efterrapportering: a done order may still draw (see
        // reportOperationQuantitiesInTx); only a closed one is locked.
        if (order.status !== "released" && order.status !== "in_progress" && order.status !== "done") {
          return { ok: false, reason: "invalid_status" };
        }

        const [row] = await tx
          .select()
          .from(moMaterialConsumptions)
          .where(and(eq(moMaterialConsumptions.id, rowId), eq(moMaterialConsumptions.manufacturingOrderId, moId)))
          .for("update");
        if (!row) return { ok: false, reason: "row_not_found" };

        const newConsumed = Number(row.quantityConsumed) + input.quantity;
        if (newConsumed > Number(row.quantityPlanned)) {
          return { ok: false, reason: "over_consumption" };
        }

        const [updatedRow] = await tx
          .update(moMaterialConsumptions)
          .set({ quantityConsumed: String(newConsumed) })
          .where(eq(moMaterialConsumptions.id, rowId))
          .returning();

        const locationId = await resolveStockLocation(tx, row.componentArticleId, input.locationId);
        await assertLocationNotUnderCount(tx, locationId);
        await tx.insert(stockTransactions).values({
          articleId: row.componentArticleId,
          locationId,
          quantityDelta: String(-input.quantity),
          transactionType: "mo_consumption",
          referenceId: moId,
          createdBy: input.createdBy,
        });
        // The draw may have emptied the location.
        await deactivateEmptyLocation(tx, locationId);

        const line: ConsumedMaterialLine = {
          componentArticleId: row.componentArticleId,
          quantity: input.quantity,
          materialConsumptionId: row.id,
          locationId,
        };
        // Materialbrist: a throw here rolls the draw back.
        await assertMaterialAvailable(tx, [line], input.materialShortage ?? NO_MATERIAL_SHORTAGE_CHECK);

        await insertReport(tx, { manufacturingOrderId: moId, kind: "material", source: "card", createdBy: input.createdBy }, [line]);

        return { ok: true, row: updatedRow! };
      });
    },

    async findOperationById(operationId: string) {
      const [row] = await db.select().from(moOperations).where(eq(moOperations.id, operationId));
      return row ?? null;
    },

    // Atomic: one incremental quantity report — see reportOperationQuantitiesInTx.
    async reportOperationQuantities(operationId: string, input: ReportOperationQuantitiesInput): Promise<CompleteOperationResult> {
      return db.transaction((tx) => reportOperationQuantitiesInTx(tx, operationId, input));
    },

    // Materialbrist, dry run: runs the very same report in a transaction
    // that is ALWAYS rolled back and answers with the shortages it ran into
    // (empty = none, including when the report would fail for another
    // reason — that is for the real call to surface). The stamp terminal
    // needs the answer BEFORE it writes the time report and closes the
    // session (those are separate operations), and the lego receipt before
    // it books the goods. The check is forced on here regardless of mode;
    // the caller decides what the shortages mean.
    async dryRunOperationReport(operationId: string, input: ReportOperationQuantitiesInput): Promise<MaterialShortage[]> {
      try {
        await db.transaction(async (tx) => {
          await reportOperationQuantitiesInTx(tx, operationId, { ...input, materialShortage: { mode: "block", allow: false } });
          throw new DryRunRollback();
        });
      } catch (err) {
        if (err instanceof DryRunRollback) return [];
        if (err instanceof MaterialShortageError) return err.shortages;
        throw err;
      }
      return [];
    },

    // A stamp-out with nothing to report (0/0, not marked done — a stint
    // that finished nothing) still gets a report row, so the stamp's time
    // can be undone from the TO card like any other report. Draws nothing,
    // so Materialbrist never applies here.
    async logTimeOnlyReport(
      operationId: string,
      input: { timeReportId: string; employeeId: string; createdBy: string | null }
    ) {
      const [operation] = await db.select().from(moOperations).where(eq(moOperations.id, operationId));
      if (!operation) return null;
      const [report] = await db
        .insert(moReports)
        .values({
          manufacturingOrderId: operation.manufacturingOrderId,
          moOperationId: operationId,
          kind: "operation",
          source: "terminal",
          timeReportId: input.timeReportId,
          employeeId: input.employeeId,
          createdBy: input.createdBy,
        })
        .returning();
      return report!;
    },

    // The TO card's Rapporteringar: every report, newest first, with the
    // operation, the stamp's hours, the IO of a lego receipt and who did it.
    async listReports(moId: string) {
      const undoneByUser = alias(users, "undone_by_user");
      const rows = await db
        .select({
          id: moReports.id,
          kind: moReports.kind,
          source: moReports.source,
          moOperationId: moReports.moOperationId,
          sequenceNo: moOperations.sequenceNo,
          workCenterName: workCenters.name,
          quantityOk: moReports.quantityOk,
          quantityScrapped: moReports.quantityScrapped,
          quantityReceived: moReports.quantityReceived,
          completedOrder: moReports.completedOrder,
          hours: timeReports.hours,
          employeeName: employees.name,
          userName: users.name,
          purchaseOrderNumber: purchaseOrders.orderNumber,
          createdAt: moReports.createdAt,
          undoneAt: moReports.undoneAt,
          undoneByName: undoneByUser.name,
        })
        .from(moReports)
        .leftJoin(moOperations, eq(moOperations.id, moReports.moOperationId))
        .leftJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .leftJoin(timeReports, eq(timeReports.id, moReports.timeReportId))
        .leftJoin(employees, eq(employees.id, moReports.employeeId))
        .leftJoin(users, eq(users.id, moReports.createdBy))
        .leftJoin(undoneByUser, eq(undoneByUser.id, moReports.undoneBy))
        .leftJoin(purchaseOrders, eq(purchaseOrders.id, moReports.purchaseOrderId))
        .where(eq(moReports.manufacturingOrderId, moId))
        .orderBy(desc(moReports.createdAt));
      const materials = rows.length
        ? await db
            .select({
              moReportId: moReportMaterials.moReportId,
              articleNumber: articles.articleNumber,
              quantity: moReportMaterials.quantity,
            })
            .from(moReportMaterials)
            .innerJoin(moMaterialConsumptions, eq(moMaterialConsumptions.id, moReportMaterials.materialConsumptionId))
            .innerJoin(articles, eq(articles.id, moMaterialConsumptions.componentArticleId))
            .where(inArray(moReportMaterials.moReportId, rows.map((r) => r.id)))
            .orderBy(asc(articles.articleNumber))
        : [];
      return rows.map((r) => ({
        ...r,
        materials: materials.filter((m) => m.moReportId === r.id).map(({ articleNumber, quantity }) => ({ articleNumber, quantity })),
      }));
    },

    async findReportById(reportId: string) {
      const [row] = await db.select().from(moReports).where(eq(moReports.id, reportId));
      return row ?? null;
    },

    // Pallkort per rapport: the report with who reported it — the employee
    // (terminal stamp) first, else the user (TO card / Slutför operation).
    async findReportForPalletCard(reportId: string) {
      const [row] = await db
        .select({
          id: moReports.id,
          manufacturingOrderId: moReports.manufacturingOrderId,
          moOperationId: moReports.moOperationId,
          kind: moReports.kind,
          source: moReports.source,
          quantityOk: moReports.quantityOk,
          createdAt: moReports.createdAt,
          undoneAt: moReports.undoneAt,
          employeeName: employees.name,
          userName: users.name,
        })
        .from(moReports)
        .leftJoin(employees, eq(employees.id, moReports.employeeId))
        .leftJoin(users, eq(users.id, moReports.createdBy))
        .where(eq(moReports.id, reportId));
      return row ?? null;
    },

    async findTimeReportById(timeReportId: string) {
      const [row] = await db.select().from(timeReports).where(eq(timeReports.id, timeReportId));
      return row ?? null;
    },

    // Ångra rapportering: reverses exactly what one report booked, in one
    // transaction — the finished goods go back out of the location they were
    // received to (refused when they are no longer there), the drawn
    // material back to where it was drawn from, the operation's quantities
    // and scrap rows, the stamp's time report, and the order's status is
    // re-derived from what remains. Lock order: report → operation → order →
    // material rows, the same operation-before-order order as reporting.
    async undoReport(reportId: string, input: { undoneBy: string }): Promise<UndoReportResult> {
      return db.transaction((tx) => undoReportInTx(tx, reportId, { ...input, fromPurchaseReceipt: false }));
    },

    // Ångra inleverans on the IO: the lego receipt's report, undone inside
    // the purchase undo's own transaction (the IO row and the TO move
    // together or not at all).
    async undoPurchaseReceiptReportInTx(tx: Tx, reportId: string, input: { undoneBy: string }): Promise<UndoReportResult> {
      return undoReportInTx(tx, reportId, { ...input, fromPurchaseReceipt: true });
    },


    // Makulera order: only an order nothing is booked against — no live
    // report that moved quantities, material or goods (time-only stamps are
    // work that was done and stay), no material drawn outside the log, and
    // nobody stamped in on it.
    async cancel(moId: string): Promise<CancelResult> {
      return db.transaction(async (tx) => {
        const [order] = await tx.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, moId)).for("update");
        if (!order) return { ok: false, reason: "order_not_found" };
        if (order.status !== "planned" && order.status !== "released" && order.status !== "in_progress") {
          return { ok: false, reason: "invalid_status" };
        }
        const [live] = await tx
          .select({ id: moReports.id })
          .from(moReports)
          .where(
            and(
              eq(moReports.manufacturingOrderId, moId),
              isNull(moReports.undoneAt),
              or(
                ne(moReports.quantityOk, "0"),
                ne(moReports.quantityScrapped, "0"),
                ne(moReports.quantityReceived, "0"),
                ne(moReports.kind, "operation")
              )
            )
          )
          .limit(1);
        const [drawn] = await tx
          .select({ id: moMaterialConsumptions.id })
          .from(moMaterialConsumptions)
          .where(and(eq(moMaterialConsumptions.manufacturingOrderId, moId), ne(moMaterialConsumptions.quantityConsumed, "0")))
          .limit(1);
        if (live || drawn || Number(order.quantityReceived) > 0) return { ok: false, reason: "has_reports" };
        const [stamped] = await tx
          .select({ id: stampSessions.id })
          .from(stampSessions)
          .innerJoin(moOperations, eq(moOperations.id, stampSessions.moOperationId))
          .where(and(eq(moOperations.manufacturingOrderId, moId), isNull(stampSessions.stoppedAt)))
          .limit(1);
        if (stamped) return { ok: false, reason: "open_stamps" };
        const [updated] = await tx
          .update(manufacturingOrders)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(eq(manufacturingOrders.id, moId))
          .returning();
        return { ok: true, order: updated! };
      });
    },

    // Kassationsorsaken (Kvalitet): does the register have an active scrap
    // reason (then one is required), and the chosen reason's state.
    async scrapReasonRules(reasonId: string | undefined) {
      const [any] = await db
        .select({ id: deviationReasons.id })
        .from(deviationReasons)
        .where(and(eq(deviationReasons.active, true), eq(deviationReasons.appliesScrap, true)))
        .limit(1);
      const [reason] = reasonId
        ? await db
            .select({ active: deviationReasons.active, appliesScrap: deviationReasons.appliesScrap, name: deviationReasons.name })
            .from(deviationReasons)
            .where(eq(deviationReasons.id, reasonId))
        : [];
      return { registerHasScrapReasons: any !== undefined, reason: reason ?? null };
    },

    // Scrap log for a whole order, newest first, with the operation's
    // sequence number and who reported it.
    async listScrapForOrder(moId: string) {
      return db
        .select({
          id: moOperationScrap.id,
          moOperationId: moOperationScrap.moOperationId,
          sequenceNo: moOperations.sequenceNo,
          workCenterName: workCenters.name,
          quantity: moOperationScrap.quantity,
          // Kvalitet: the Avvikelseorsak; `reason` is its comment (or an
          // older row's whole free-text reason).
          reasonId: moOperationScrap.reasonId,
          reasonCode: deviationReasons.code,
          reasonName: deviationReasons.name,
          reason: moOperationScrap.reason,
          employeeName: employees.name,
          createdAt: moOperationScrap.createdAt,
        })
        .from(moOperationScrap)
        .innerJoin(moOperations, eq(moOperations.id, moOperationScrap.moOperationId))
        .leftJoin(deviationReasons, eq(deviationReasons.id, moOperationScrap.reasonId))
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .leftJoin(employees, eq(employees.id, moOperationScrap.employeeId))
        .where(eq(moOperations.manufacturingOrderId, moId))
        .orderBy(desc(moOperationScrap.createdAt));
    },

    // Atomic: validates status, receives `quantity` MORE finished goods
    // (default: what remains of the order quantity after any delinleverans;
    // 0 just closes a short order) and flips to done.
    async complete(
      moId: string,
      input: { locationId?: string; quantity?: number; createdBy: string; materialShortage?: MaterialShortageCheck }
    ): Promise<CompleteResult> {
      return db.transaction(async (tx) => {
        const [order] = await tx.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, moId)).for("update");
        if (!order) return { ok: false, reason: "order_not_found" };
        if (order.status !== "released" && order.status !== "in_progress") return { ok: false, reason: "invalid_status" };

        const already = Number(order.quantityReceived);
        const quantity = input.quantity ?? Math.max(Number(order.quantity) - already, 0);
        const goods = await receiveFinishedGoods(tx, order, {
          targetReceived: already + quantity,
          locationId: input.locationId,
          createdBy: input.createdBy,
        });
        // Materialbrist: the unlinked material the receipt drew.
        await assertMaterialAvailable(tx, goods.consumed, input.materialShortage ?? NO_MATERIAL_SHORTAGE_CHECK);

        const [updatedOrder] = await tx
          .update(manufacturingOrders)
          .set({ status: "done", updatedAt: new Date() })
          .where(eq(manufacturingOrders.id, moId))
          .returning();
        await autoCloseStamps(tx, { orderId: moId }, moId, input.createdBy);
        // Tillägg: Slutför order.
        await pluginEvents.emit(tx, { type: "manufacturing_order.completed", entityId: moId, entityNumber: order.orderNumber });

        await insertReport(
          tx,
          {
            manufacturingOrderId: moId,
            kind: "completion",
            source: "card",
            quantityReceived: String(goods.delta),
            receiptLocationId: goods.locationId,
            completedOrder: true,
            createdBy: input.createdBy,
          },
          goods.consumed
        );

        return { ok: true, order: updatedOrder!, consumed: goods.consumed, received: goods.delta };
      });
    },
  };
}

export type ManufacturingRepository = ReturnType<typeof createManufacturingRepository>;
