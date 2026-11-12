import { and, asc, count, desc, eq, getTableColumns, ilike, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  articles,
  articleDrawings,
  articleFiles,
  bomComponents,
  deviationReasons,
  employees,
  manufacturingOrders,
  moMaterialConsumptions,
  moOperationScrap,
  moOperations,
  moReportMaterials,
  stockBatches,
  moReports,
  productionGroups,
  purchaseOrders,
  routingOperationAlternatives,
  routingOperationArticleFiles,
  routingOperationDrawings,
  routingOperationFiles,
  routingOperations,
  stampSessions,
  stockLocations,
  stockTransactions,
  suppliers,
  timeReports,
  users,
  units,
  weekSchedules,
  workCenters,
  configuratorTemplates,
  type Db,
} from "@navet/db";
import {
  ilikePattern,
  type ConfiguratorMode,
  type CreateManufacturingOrderInput,
  type CreateMoOperationInput,
  type ManufacturingOrderConfiguration,
  type CreateProductionGroupInput,
  type CreateRoutingOperationInput,
  type CreateWorkCenterInput,
  type ListManufacturingOrdersQuery,
  splitLateFilter,
  type ListWorkCentersQuery,
  type UpdateMoOperationInput,
  type UpdateProductionGroupInput,
  type UpdateRoutingOperationInput,
  type UpdateWorkCenterInput,
  round4,
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
import { allocateOutflowLocations, lockArticlesForOutflow, type BlockedChoice } from "../../stock/service/outflow-locations.js";
import { isStockedArticle } from "../../stock/service/stocked-article.js";
import { getOrCreateBatch } from "../../stock/service/batches.js";
import { isBatchTrackedArticle } from "../../stock/service/batch-tracking.js";
import { batchCellQuantity } from "../../stock/repository/batch-balances.js";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import { listLegoPurchases } from "./lego-purchases.js";
import { legoOneOffSql } from "./lego-one-off.js";
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
import { snapshotOperationResourcesInTx, workCenterInAlternativesInTx } from "./operation-resources.js";
import { replaceRoutingAlternatives, replaceRoutingDrawings, replaceRoutingFiles } from "./routing-write.js";
import { operationDrawingLabels, orderRevisions, snapshotOrderRevisionsInTx, type OrderRevisions } from "./drawing-snapshot.js";
import { drawingFiles } from "../../article/repository/drawing-files.js";
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
  type PrepareOperationUpdate,
  type UpdateMaterialInput,
} from "./order-edit.js";

export type ConsumeMaterialResult =
  | { ok: true; row: typeof moMaterialConsumptions.$inferSelect; reportId: string }
  | { ok: false; reason: "order_not_found" | "row_not_found" | "invalid_status" | "over_consumption" };

export type CompleteResult =
  | { ok: true; order: typeof manufacturingOrders.$inferSelect; consumed: ConsumedMaterialLine[]; received: number; reportId: string }
  | { ok: false; reason: "order_not_found" | "invalid_status" };

// What an automatic draw actually booked, per material row AND location —
// the material row and location are what the report log keeps so Ångra can
// return it. A draw without a chosen location is split where the stock is
// (allocateOutflowLocations), so one material row may give several lines.
export interface ConsumedMaterialLine {
  componentArticleId: string;
  quantity: number;
  materialConsumptionId: string;
  // null = a service component: consumed, never drawn from stock.
  locationId: string | null;
  // Batch (#8): the batch the part was drawn from — null/left out = Okänd.
  // Kept on the report log so Ångra returns it to the same batch.
  batchId?: string | null;
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
  // Lego-inleveransen: the IO receipt behind the report (see
  // PurchaseReceiptLink). Only the real report runs it, never the dry run.
  receiptLink?: PurchaseReceiptLink;
}

// The purchase module's side of a lego report, run inside the report's own
// transaction (purchase owns purchase_receipts): `claim` locks the receipt
// FIRST — before the operation, the order Ångra inleverans takes them in —
// and throws when it was undone meanwhile (the report then rolls back);
// `link` stamps the report on it before the commit. The report and the link
// are thereby one commit: a report never stands without its link (which
// left it undoable from neither the IO nor the TO card).
export interface PurchaseReceiptLink {
  claim(tx: Tx): Promise<void>;
  link(tx: Tx, reportId: string): Promise<void>;
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
  await lockOrderComponents(tx, opts.moId);

  const consumed: ConsumedMaterialLine[] = [];
  for (const row of rows) {
    const perUnit = opts.orderQuantity === 0 ? 0 : Number(row.quantityPlanned) / opts.orderQuantity;
    const target = round4(perUnit * opts.reportedQuantity);
    const delta = round4(target - Number(row.quantityConsumed));
    if (delta <= 0) continue;

    await tx
      .update(moMaterialConsumptions)
      .set({ quantityConsumed: String(round4(Number(row.quantityConsumed) + delta)) })
      .where(eq(moMaterialConsumptions.id, row.id));

    // The TO card's field also receives the finished goods, so a Spärrad
    // lagerplats chosen there only takes the goods — the material is then
    // drawn as with Automatiskt ("automatic").
    consumed.push(...(await drawMaterial(tx, row, delta, opts.locationId, opts.moId, opts.createdBy, "automatic")));
  }
  return consumed;
}

// The automatic allocation locks each component before reading its
// balances. Lock EVERY component of the order, sorted, in one batch — not
// just the rows one call draws: one report can draw twice (the operation's
// linked rows, then receiveFinishedGoods's unlinked rows), and two separately
// sorted batches would let two reports wait on each other crosswise (MO1
// linked A + unlinked B against MO2 linked B + unlinked A). The second call
// then finds every lock already held, as does assertMaterialAvailable
// afterwards (same sort order). receiveFinishedGoods takes it before its
// receipt too: the receipt may revive the chosen place (a row lock on the
// place), and the lock order is article → place (outflow-locations.ts).
async function lockOrderComponents(tx: Tx, moId: string): Promise<void> {
  const components = await tx
    .selectDistinct({ articleId: moMaterialConsumptions.componentArticleId })
    .from(moMaterialConsumptions)
    .where(eq(moMaterialConsumptions.manufacturingOrderId, moId));
  await lockArticlesForOutflow(tx, components.map((c) => c.articleId));
}

// One material row's draw booked where the stock is: an explicit location
// wins for the whole draw (and may go negative); otherwise the component is
// taken from its own location and then from other locations with stock
// (allocateOutflowLocations) — one stock_transactions row and one
// ConsumedMaterialLine per location, so the report log and Ångra see each
// part.
// blockedChoice: what a chosen Spärrad lagerplats means — "refuse" for
// Förbruka (a pure outflow, 409 stock-location-blocked), "automatic" for the
// reports, where the same field receives the finished goods.
async function drawMaterial(
  tx: Tx,
  row: { id: string; componentArticleId: string },
  quantity: number,
  locationId: string | undefined,
  moId: string,
  createdBy: string | null,
  blockedChoice: BlockedChoice,
  // Batch (#8): only Förbruka chooses one (left out = Automatiskt per batch
  // for a batchstyrd component, null = Okänd).
  batchId?: string | null
): Promise<ConsumedMaterialLine[]> {
  // A service component (tjänst) is work, not goods: the consumption is
  // recorded (one line without a place, for the report log and Ångra), but
  // nothing is drawn from stock (stocked-article.ts).
  if (!(await isStockedArticle(tx, row.componentArticleId))) {
    return [{ componentArticleId: row.componentArticleId, quantity, materialConsumptionId: row.id, locationId: null }];
  }
  const parts = await allocateOutflowLocations(tx, row.componentArticleId, quantity, locationId, { blockedChoice, batchId });
  const lines: ConsumedMaterialLine[] = [];
  for (const part of parts) {
    await assertLocationNotUnderCount(tx, part.locationId);
    await tx.insert(stockTransactions).values({
      articleId: row.componentArticleId,
      locationId: part.locationId,
      quantityDelta: String(-part.quantity),
      transactionType: "mo_consumption",
      referenceId: moId,
      createdBy,
      batchId: part.batchId ?? null,
    });
    // The draw may have emptied a temporary location.
    await deactivateEmptyLocation(tx, part.locationId);
    lines.push({
      componentArticleId: row.componentArticleId,
      quantity: part.quantity,
      materialConsumptionId: row.id,
      locationId: part.locationId,
      batchId: part.batchId ?? null,
    });
  }
  return lines;
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
        batchId: m.batchId ?? null,
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
  | { ok: false; reason: "template_mode_changed" }
  | { ok: false; reason: "already_covered"; uncovered: number };

// The configurator mode the service read before the transaction (null = no
// template); `undefined` skips the re-check (callers outside prepareCreate).
export type CreateManufacturingOrderRow = CreateManufacturingOrderInput & { articleId: string; templateMode?: ConfiguratorMode | null };

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
): Promise<{ received: number; delta: number; locationId: string | null; batchId: string | null; consumed: ConsumedMaterialLine[] }> {
  const already = Number(order.quantityReceived);
  const delta = Number((opts.targetReceived - already).toFixed(4));
  if (delta <= 0) return { received: already, delta: 0, locationId: null, batchId: null, consumed: [] };

  // unit_cost is the produced article's current standard cost, stamped at
  // receipt time — null (not 0) when no standard cost is set, since 0 would
  // be a false claim of zero value.
  const [producedArticle] = await tx
    .select({ standardCost: articles.standardCost })
    .from(articles)
    .where(eq(articles.id, order.articleId));

  // Article → place: the components the unlinked draw below takes are locked
  // before the receipt may revive the chosen place (Slutför order comes here
  // first; a report has already locked them).
  await lockOrderComponents(tx, order.id);
  const receiptLocationId = await resolveStockLocation(tx, order.articleId, opts.locationId);
  await assertLocationNotUnderCount(tx, receiptLocationId);
  // Batch (#8, beslut 2): the finished goods of a batchstyrd article are
  // booked in the batch named after the TO — every delinleverans of one TO
  // is the same batch, and nobody types anything. The flag as it is NOW
  // (read FOR KEY SHARE, batch-tracking.ts); the report log keeps the batch
  // (mo_reports.receipt_batch_id) so Ångra takes exactly it back.
  const receiptBatch = (await isBatchTrackedArticle(tx, order.articleId))
    ? await getOrCreateBatch(tx, {
        articleId: order.articleId,
        batchNumber: order.orderNumber,
        origin: "manufacturing_order",
        manufacturingOrderId: order.id,
        createdBy: opts.createdBy,
      })
    : null;

  await tx.insert(stockTransactions).values({
    articleId: order.articleId,
    locationId: receiptLocationId,
    quantityDelta: String(delta),
    transactionType: "mo_receipt",
    referenceId: order.id,
    createdBy: opts.createdBy,
    batchId: receiptBatch?.id ?? null,
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

  // round4: 0.7 + 0.1 is 0.7999999999999999, which never reached an order
  // quantity of 0.8 — the order stayed in progress with everything received.
  const received = round4(already + delta);
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

  return { received, delta, locationId: receiptLocationId, batchId: receiptBatch?.id ?? null, consumed };
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

  // At the column's 4 decimals (round4): the sums are compared with the
  // order quantity below (done, the receipt) and float noise must not
  // leave a covered operation or order open.
  const totalOk = round4(Number(operation.quantityCompleted ?? 0) + input.quantityOk);
  const totalScrapped = round4(Number(operation.quantityScrapped) + input.quantityScrapped);

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
  // A location chosen on the TO card (Lagerplats för materialuttag) also
  // receives the finished goods — and the unlinked material is drawn from it,
  // as with Slutför order. Terminal and lego reports choose none.
  const goods =
    !lateReport && last?.sequenceNo === operation.sequenceNo
      ? await receiveFinishedGoods(tx, order, { targetReceived: totalOk, locationId: input.locationId, createdBy: input.createdBy })
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
      receiptBatchId: goods?.batchId ?? null,
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
  // (quantities multiplied down the chain) — see bom-explosion.ts. "Kalkyl"
  // rows (costing_only) are excluded here, exactly like the Kalkyl operations
  // below: they are priced in the förkalkyl but never drawn, never short,
  // never in the efterkalkyl.
  const exploded = configured ? [] : await explodeBom(tx, order.articleId, Number(order.quantity), "exclude");

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
  // Alternativa resurser: the operations' possible resources, snapshotted
  // like the times — the plain TO's rows just written, or a configured TO's
  // rows written at creation (its base operations carry the template's
  // routing row). Later beredning edits never touch them.
  await snapshotOperationResourcesInTx(tx, moId);

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
    // explodeBom merged per (component, routing operation); the material row
    // is unique per (TO, component, TO operation) with NULLS NOT DISTINCT
    // (mo_material_unique_per_operation). Two lines that land on the same TO
    // operation — e.g. one whose link is not on this TO (a Kalkyl operation)
    // and one unlinked — are merged here, summed, the base unit when the
    // display units differ: a guard, so a link the explosion could not place
    // never turns the release into a 500.
    const lines = new Map<
      string,
      { componentArticleId: string; moOperationId: string | null; totalQuantity: number; unitId: string | null; unitFactor: string | null }
    >();
    for (const c of exploded) {
      const moOperationId = c.routingOperationId ? (operationByRoutingId.get(c.routingOperationId) ?? null) : null;
      const key = `${c.componentArticleId}:${moOperationId ?? ""}`;
      const existing = lines.get(key);
      if (!existing) {
        lines.set(key, { componentArticleId: c.componentArticleId, moOperationId, totalQuantity: c.totalQuantity, unitId: c.unitId, unitFactor: c.unitFactor });
        continue;
      }
      existing.totalQuantity += c.totalQuantity;
      if (existing.unitId !== c.unitId || existing.unitFactor !== c.unitFactor) {
        existing.unitId = null;
        existing.unitFactor = null;
      }
    }
    const materialRows = await tx
      .insert(moMaterialConsumptions)
      .values(
        [...lines.values()].map((c) => ({
          manufacturingOrderId: moId,
          componentArticleId: c.componentArticleId,
          moOperationId: c.moOperationId,
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

  // Revisionerna TO:n byggs efter (0200) — a configured TO too: its
  // drawings are the beställningsvara's.
  await snapshotOrderRevisionsInTx(tx, moId);

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

  // Finished goods out of the location they went into — an outflow, so the
  // article lock first (order → article, as the reports take their
  // components): the "still in stock" check below must not race a delivery
  // drawing the same goods (both passed and the place went negative).
  const received = Number(report.quantityReceived);
  if (received > 0 && report.receiptLocationId) {
    await lockArticlesForOutflow(tx, [order.articleId]);
    const [balance] = await tx
      .select({ quantity: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
      .from(stockTransactions)
      .where(and(eq(stockTransactions.articleId, order.articleId), eq(stockTransactions.locationId, report.receiptLocationId)));
    // Batch (#8): out of the SAME batch the report booked them in
    // (receipt_batch_id, null = Okänd), whatever the article's flag says
    // now. With a batch on the report, or on an article that is batchstyrd
    // now, the goods must still be in that CELL too — the place may hold
    // enough in total while this batch is gone.
    let available = Number(balance?.quantity ?? 0);
    if (report.receiptBatchId !== null || (await isBatchTrackedArticle(tx, order.articleId))) {
      available = Math.min(available, await batchCellQuantity(tx, order.articleId, report.receiptLocationId, report.receiptBatchId));
    }
    if (available < received) return { ok: false, reason: "insufficient_stock", available, required: received };
    await assertLocationNotUnderCount(tx, report.receiptLocationId);
    await tx.insert(stockTransactions).values({
      articleId: order.articleId,
      locationId: report.receiptLocationId,
      quantityDelta: String(-received),
      transactionType: "mo_receipt",
      referenceId: order.id,
      createdBy: input.undoneBy,
      batchId: report.receiptBatchId,
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
      .set({ quantityConsumed: String(Math.max(round4(Number(row.quantityConsumed) - quantity), 0)) })
      .where(eq(moMaterialConsumptions.id, row.id));
    // Reactivates the location if it was cleaned up after the draw.
    // A service line (no place) was never drawn from stock: nothing to return.
    if (line.locationId === null) continue;
    const locationId = await resolveStockLocation(tx, row.componentArticleId, line.locationId);
    await assertLocationNotUnderCount(tx, locationId);
    await tx.insert(stockTransactions).values({
      articleId: row.componentArticleId,
      locationId,
      quantityDelta: String(quantity),
      transactionType: "mo_consumption",
      referenceId: order.id,
      createdBy: input.undoneBy,
      // Batch (#8): back into the batch the part was drawn from.
      batchId: line.batchId,
    });
  }

  // The operation's quantities, scrap rows and done flag.
  if (operation) {
    const newOk = Math.max(round4(Number(operation.quantityCompleted ?? 0) - Number(report.quantityOk)), 0);
    const newScrapped = Math.max(round4(Number(operation.quantityScrapped) - Number(report.quantityScrapped)), 0);
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
  const newReceived = Math.max(round4(Number(order.quantityReceived) - received), 0);
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

// Alternativa resurser (#15) for GET /articles/:id/routing and the routing
// create/update answers: operation id → its alternatives in rank order, each
// with the resource's code/name, whether it is active and whether it has
// capacity (a week schedule or Kapacitet (timmar per dag) — the planning's
// hasCapacityCalendar rule; a resource without it is never suggested).
// Times null = som ordinarie. One query.
export interface RoutingAlternativeView {
  workCenterId: string;
  code: string;
  name: string;
  rank: number;
  setupTime: string | null;
  runTimePerUnit: string | null;
  active: boolean;
  hasCapacity: boolean;
}
async function listRoutingAlternatives(dbc: Db | Tx, operationIds: string[]): Promise<Map<string, RoutingAlternativeView[]>> {
  const map = new Map<string, RoutingAlternativeView[]>();
  if (operationIds.length === 0) return map;
  const rows = await dbc
    .select({
      routingOperationId: routingOperationAlternatives.routingOperationId,
      workCenterId: routingOperationAlternatives.workCenterId,
      code: workCenters.code,
      name: workCenters.name,
      rank: routingOperationAlternatives.rank,
      setupTime: routingOperationAlternatives.setupTime,
      runTimePerUnit: routingOperationAlternatives.runTimePerUnit,
      active: workCenters.active,
      hasCapacity: sql<boolean>`(${workCenters.weekScheduleId} is not null or ${workCenters.hoursPerDay} is not null)`,
    })
    .from(routingOperationAlternatives)
    .innerJoin(workCenters, eq(workCenters.id, routingOperationAlternatives.workCenterId))
    .where(inArray(routingOperationAlternatives.routingOperationId, operationIds))
    .orderBy(asc(routingOperationAlternatives.routingOperationId), asc(routingOperationAlternatives.rank));
  for (const { routingOperationId, ...view } of rows) {
    const list = map.get(routingOperationId) ?? [];
    list.push(view);
    map.set(routingOperationId, list);
  }
  return map;
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

    // "in_alternatives": the edit makes the resource a legoresurs while it
    // takes part in alternatives (workCenterInAlternativesInTx) — refused,
    // nothing written. Asked on the resource's row locked FOR NO KEY UPDATE
    // (the UPDATE's own lock mode, so no FK insert waits on it), in the
    // UPDATE's transaction: two type changes of one resource run one after
    // the other.
    async updateWorkCenter(id: string, input: UpdateWorkCenterInput) {
      return db.transaction(async (tx) => {
        if (input.type === "subcontract") {
          const [current] = await tx
            .select({ type: workCenters.type })
            .from(workCenters)
            .where(eq(workCenters.id, id))
            .for("no key update");
          if (!current) return null;
          if (current.type !== "subcontract" && (await workCenterInAlternativesInTx(tx, id))) return "in_alternatives" as const;
        }
        const [row] = await tx
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
      });
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

    // The operation and its alternativa resurser in one transaction; the
    // service has run the rules (routing-alternatives.ts) — a new operation
    // has no earlier alternatives to race with.
    async createRoutingOperation(articleId: string, input: CreateRoutingOperationInput) {
      return db.transaction(async (tx) => {
        const [row] = await tx
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
        if (input.alternatives && input.alternatives.length > 0) await replaceRoutingAlternatives(tx, row!.id, input.alternatives);
        if (input.drawingIds && input.drawingIds.length > 0) await replaceRoutingDrawings(tx, row!.id, articleId, input.drawingIds);
        if (input.fileIds && input.fileIds.length > 0) await replaceRoutingFiles(tx, row!.id, articleId, input.fileIds);
        return row!;
      });
    },

    // Scoped to the article so a row id from another article's routing 404s
    // (null). One transaction: the operation FOR NO KEY UPDATE, its current
    // alternatives, then `prepare` — the service's rules on the locked state
    // (it throws to refuse, or returns the patch to write) — then the UPDATE
    // and, when the patch carries `alternatives`, the set replaced. Two edits
    // of one operation run one after the other, so the alternative rules
    // never judge a state another edit is changing.
    // - NO KEY UPDATE, the UPDATE's own lock mode, not FOR UPDATE: a TO
    //   created meanwhile takes FOR KEY SHARE on the routing row through
    //   mo_operations.routing_operation_id, and must not wait for the edit.
    // - `workCenter` reads through the transaction (never another pool
    //   connection while the lock is held) and FOR SHARE: a type change of
    //   that resource (updateWorkCenter, FOR NO KEY UPDATE) waits for this
    //   edit or this edit for it, so the rules never judge a resource that
    //   is just becoming a legoresurs.
    async updateRoutingOperation(
      articleId: string,
      operationId: string,
      prepare: (
        current: typeof routingOperations.$inferSelect,
        alternatives: (typeof routingOperationAlternatives.$inferSelect)[],
        workCenter: (id: string) => Promise<typeof workCenters.$inferSelect | null>
      ) => Promise<UpdateRoutingOperationInput>
    ) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(routingOperations)
          .where(and(eq(routingOperations.id, operationId), eq(routingOperations.articleId, articleId)))
          .for("no key update");
        if (!current) return null;
        const currentAlternatives = await tx
          .select()
          .from(routingOperationAlternatives)
          .where(eq(routingOperationAlternatives.routingOperationId, operationId))
          .orderBy(asc(routingOperationAlternatives.rank));
        const workCenter = async (id: string) => {
          const [row] = await tx.select().from(workCenters).where(eq(workCenters.id, id)).for("share");
          return row ?? null;
        };
        const { alternatives, drawingIds, fileIds, ...input } = await prepare(current, currentAlternatives, workCenter);
        if (drawingIds !== undefined) await replaceRoutingDrawings(tx, operationId, articleId, drawingIds);
        if (fileIds !== undefined) await replaceRoutingFiles(tx, operationId, articleId, fileIds);
        // Only the alternatives or drawings (e.g. [] on a lego operation,
        // whose patch keeps no cleared lego fields): no column to set —
        // drizzle refuses an empty SET.
        if (!Object.values(input).some((value) => value !== undefined)) {
          if (alternatives !== undefined) await replaceRoutingAlternatives(tx, operationId, alternatives);
          return current;
        }
        const [row] = await tx
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
        if (alternatives !== undefined) await replaceRoutingAlternatives(tx, operationId, alternatives);
        return row ?? null;
      });
    },

    // Alternativa resurser per routing operation — see listRoutingAlternatives.
    async listRoutingAlternatives(operationIds: string[]) {
      return listRoutingAlternatives(db, operationIds);
    },

    // Guards the "Kalkyl" flag: a BOM row linked to an operation that never
    // reaches the MO would silently fall through to final completion, so the
    // combination is refused. A costing-only ROW never reaches the MO either,
    // so its link is harmless and does not count — un-flagging such a row
    // re-checks the link (article.service.ts). The mirror-image read lives in
    // article.repository.ts's findRoutingOperationById.
    async countBomComponentsForOperation(operationId: string) {
      const [row] = await db
        .select({ value: count() })
        .from(bomComponents)
        .where(and(eq(bomComponents.routingOperationId, operationId), eq(bomComponents.costingOnly, false)));
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
      const operations = await db
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
        .where(eq(routingOperations.articleId, articleId))
        .orderBy(asc(routingOperations.sequenceNo));
      const alternatives = await listRoutingAlternatives(db, operations.map((op) => op.id));
      const drawings = await this.listRoutingDrawings(operations.map((op) => op.id));
      const files = await this.listRoutingFiles(operations.map((op) => op.id));
      return operations.map((op) => ({
        ...op,
        alternatives: alternatives.get(op.id) ?? [],
        drawings: drawings.get(op.id) ?? [],
        files: files.get(op.id) ?? [],
      }));
    },

    // Filer per operation: id and name of the chosen loose files (a file
    // that has since become a drawing revision's no longer counts).
    async listRoutingFiles(operationIds: string[]) {
      const map = new Map<string, { id: string; filename: string }[]>();
      if (operationIds.length === 0) return map;
      const rows = await db
        .select({
          routingOperationId: routingOperationArticleFiles.routingOperationId,
          id: articleFiles.id,
          filename: articleFiles.filename,
        })
        .from(routingOperationArticleFiles)
        .innerJoin(articleFiles, eq(articleFiles.id, routingOperationArticleFiles.articleFileId))
        .where(and(inArray(routingOperationArticleFiles.routingOperationId, operationIds), isNull(articleFiles.drawingRevisionId)))
        .orderBy(asc(articleFiles.filename), asc(articleFiles.id));
      for (const row of rows) {
        const list = map.get(row.routingOperationId) ?? [];
        list.push({ id: row.id, filename: row.filename });
        map.set(row.routingOperationId, list);
      }
      return map;
    },

    // How many of the ids are the article's loose files.
    async countArticleLooseFiles(articleId: string, fileIds: string[]) {
      if (fileIds.length === 0) return 0;
      const [row] = await db
        .select({ value: count() })
        .from(articleFiles)
        .where(and(eq(articleFiles.articleId, articleId), isNull(articleFiles.drawingRevisionId), inArray(articleFiles.id, fileIds)));
      return row?.value ?? 0;
    },

    // Ritningar per operation: id and number, in drawing-number order.
    async listRoutingDrawings(operationIds: string[]) {
      const map = new Map<string, { id: string; drawingNumber: string }[]>();
      if (operationIds.length === 0) return map;
      const rows = await db
        .select({
          routingOperationId: routingOperationDrawings.routingOperationId,
          id: articleDrawings.id,
          drawingNumber: articleDrawings.drawingNumber,
        })
        .from(routingOperationDrawings)
        .innerJoin(articleDrawings, eq(articleDrawings.id, routingOperationDrawings.drawingId))
        .where(inArray(routingOperationDrawings.routingOperationId, operationIds))
        .orderBy(asc(articleDrawings.drawingNumber));
      for (const row of rows) {
        const list = map.get(row.routingOperationId) ?? [];
        list.push({ id: row.id, drawingNumber: row.drawingNumber });
        map.set(row.routingOperationId, list);
      }
      return map;
    },

    // How many of the ids are the article's drawings (the service refuses
    // an operation's drawing that is another article's).
    async countArticleDrawings(articleId: string, drawingIds: string[]) {
      if (drawingIds.length === 0) return 0;
      const [row] = await db
        .select({ value: count() })
        .from(articleDrawings)
        .where(and(eq(articleDrawings.articleId, articleId), inArray(articleDrawings.id, drawingIds)));
      return row?.value ?? 0;
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
          // The inquiry row's prefilled Ställpris is the lego order's one-off
          // charge — Ställpris + Transportkostnad (lego-one-off.ts), like
          // every other reader; the raw setup_price dropped the transport.
          setupPrice: legoOneOffSql(routingOperations),
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
          setupPrice: legoOneOffSql(moOperations),
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
      input: CreateManufacturingOrderRow,
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
      input: CreateManufacturingOrderRow,
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
            .select({
              status: manufacturingOrders.status,
              quantity: manufacturingOrders.quantity,
              received: manufacturingOrders.quantityReceived,
            })
            .from(manufacturingOrders)
            .where(and(eq(manufacturingOrders.salesOrderRowId, configured.lockRow.rowId), ne(manufacturingOrders.status, "cancelled")));
          const uncovered = uncoveredConfiguredQuantity({
            quantityOrdered: locked.quantityOrdered,
            quantityDelivered: locked.quantityDelivered,
            linkedOrders: linkedOrders.map((o) => ({ status: o.status, quantity: Number(o.quantity), received: Number(o.received) })),
          });
          if (input.quantity > uncovered + 0.00005) return { ok: false, reason: "already_covered", uncovered };
        }
      }
      // Konfigurator: the mode the service read (and derived the structure
      // for) is re-read FOR SHARE here — after the row lock, before anything
      // is written; row → template is the order Ändra konfiguration locks
      // in, and the template writers take this row FOR UPDATE. A mode change
      // committed since the read would otherwise give a plain TO on a
      // beställningsvara, or a configured TO on an article that is none.
      if (input.templateMode !== undefined) {
        const [template] = await tx
          .select({ mode: configuratorTemplates.mode })
          .from(configuratorTemplates)
          .where(eq(configuratorTemplates.articleId, input.articleId))
          .for("share");
        if ((template?.mode ?? null) !== input.templateMode) return { ok: false, reason: "template_mode_changed" };
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
        .where(and(inArray(manufacturingOrders.salesOrderRowId, rowIds), ne(manufacturingOrders.status, "cancelled")))
        .orderBy(asc(manufacturingOrders.orderNumber));

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

    // --- Revisionerna TO:n byggs efter (drawing-snapshot.ts) ---

    async orderRevisions(moId: string) {
      return orderRevisions(db, moId);
    },

    async operationDrawingLabels(moId: string, view: OrderRevisions) {
      return operationDrawingLabels(db, moId, view);
    },

    // Uppdatera: the snapshot taken again from today's revisions, under the
    // order's row lock (the UPDATE's own mode). Returns the status it ran
    // on — the service refuses anything but an open order — or null.
    async refreshOrderRevisions(moId: string, allowed: readonly string[]) {
      return db.transaction(async (tx) => {
        const [order] = await tx
          .select({ status: manufacturingOrders.status })
          .from(manufacturingOrders)
          .where(eq(manufacturingOrders.id, moId))
          .for("no key update");
        if (!order) return null;
        if (!allowed.includes(order.status)) return { refreshed: false as const, status: order.status };
        await snapshotOrderRevisionsInTx(tx, moId);
        return { refreshed: true as const, status: order.status };
      });
    },

    // The files an operation is worked from (drawing-files.ts): its chosen
    // drawings, otherwise the order's; null when the operation is not the
    // order's.
    async operationDrawingFiles(moId: string, moOperationId: string) {
      const [op] = await db
        .select({ routingOperationId: moOperations.routingOperationId, articleId: manufacturingOrders.articleId })
        .from(moOperations)
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .where(and(eq(moOperations.id, moOperationId), eq(moOperations.manufacturingOrderId, moId)));
      if (!op) return null;
      return drawingFiles(db, { articleId: op.articleId, moId, routingOperationId: op.routingOperationId });
    },

    // One of the order's article's files — any revision's or a loose one
    // (open/print on demand from the TO card).
    async findOrderArticleFile(moId: string, fileId: string) {
      const [row] = await db
        .select({ filename: articleFiles.filename, contentType: articleFiles.contentType, data: articleFiles.data })
        .from(articleFiles)
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.articleId, articleFiles.articleId))
        .where(and(eq(manufacturingOrders.id, moId), eq(articleFiles.id, fileId)));
      return row ?? null;
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
          // Dokument på engelska (#7): for the customer's pallet card.
          articleNameEn: articles.nameEn,
          articleUnitCodeEn: units.codeEn,
        })
        .from(manufacturingOrders)
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .where(eq(manufacturingOrders.id, id));
      return row ?? null;
    },

    // Header update — today only the planned finish date (E2); everything
    // else moves through status transitions.
    // Under the order's lock, open orders only (the service's status check
    // is for the clean error): an order that turned done, closed or
    // cancelled in between keeps its date, and `before` is the date this
    // write replaced — not one a Flytta halvfabrikaten moved meanwhile.
    async updateManufacturingOrder(
      id: string,
      input: { dueDate: string | null }
    ): Promise<
      | { ok: true; before: typeof manufacturingOrders.$inferSelect; order: typeof manufacturingOrders.$inferSelect }
      | { ok: false; status: (typeof manufacturingOrders.$inferSelect)["status"] | null }
    > {
      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, id)).for("update");
        if (!before) return { ok: false, status: null };
        if (before.status !== "planned" && before.status !== "released" && before.status !== "in_progress") {
          return { ok: false, status: before.status };
        }
        const [row] = await tx
          .update(manufacturingOrders)
          .set({ dueDate: input.dueDate, updatedAt: new Date() })
          .where(eq(manufacturingOrders.id, id))
          .returning();
        return { ok: true, before, order: row! };
      });
    },

    // Flytta halvfabrikaten (pegging #9): the orders FOR UPDATE in id order
    // — only the order rows, nothing else, so the lock order of every other
    // writer (operation → order, advisory → operations → order, order →
    // material → stock) is never inverted. Unknown ids are simply absent.
    async lockManufacturingOrdersInTx(tx: Tx, ids: string[]) {
      if (ids.length === 0) return [];
      return tx
        .select({
          id: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          status: manufacturingOrders.status,
          dueDate: manufacturingOrders.dueDate,
        })
        .from(manufacturingOrders)
        .where(inArray(manufacturingOrders.id, ids))
        .orderBy(asc(manufacturingOrders.id))
        .for("update");
    },

    // The due date of one locked order (lockManufacturingOrdersInTx first).
    async setDueDateInTx(tx: Tx, id: string, dueDate: string) {
      await tx.update(manufacturingOrders).set({ dueDate, updatedAt: new Date() }).where(eq(manufacturingOrders.id, id));
    },

    // The orders the plan can call Sen: released/in progress, the same set
    // orderPlanSummaries loads (and Aviseringarna's sena TO:er).
    async listOpenManufacturingOrderIds(): Promise<string[]> {
      const rows = await db
        .select({ id: manufacturingOrders.id })
        .from(manufacturingOrders)
        .where(inArray(manufacturingOrders.status, ["released", "in_progress"]));
      return rows.map((r) => r.id);
    },

    // `onlyIds`: the status filter Sen, resolved by the service from the
    // plan (orderPlanSummaries) — an empty list matches nothing.
    async listManufacturingOrders(query: ListManufacturingOrdersQuery, onlyIds?: string[]) {
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
      const { statuses } = splitLateFilter(query.status);
      if (statuses) conditions.push(inArray(manufacturingOrders.status, statuses));
      if (onlyIds) conditions.push(onlyIds.length > 0 ? inArray(manufacturingOrders.id, onlyIds) : sql`false`);
      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, totalRows] = await Promise.all([
        db
          .select({
            ...getTableColumns(manufacturingOrders),
            articleNumber: articles.articleNumber,
            articleName: articles.name,
            // Base unit, so a list card (Översikten) never prints "st" for metres.
            articleUnitCode: units.code,
          })
          .from(manufacturingOrders)
          .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
          .innerJoin(units, eq(units.id, articles.unitId))
          .where(where)
          .orderBy(query.order === "asc" ? asc(manufacturingOrders.orderNumber) : desc(manufacturingOrders.orderNumber))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ total: count() })
          .from(manufacturingOrders)
          .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
          .where(where),
      ]);
      const total = totalRows[0]!.total;
      // One row shape for both branches: `operations` is there only when
      // asked for, so it is optional rather than a union the caller narrows.
      type ListedOrder = (typeof rows)[number] & { operations?: OperationSummary[] };
      if (!query.withOperations) {
        const plain: ListedOrder[] = rows;
        return { rows: plain, total };
      }

      // Opt-in (withOperations): each order's operation summaries, e.g. for
      // integrations. One batched query for the page, merged in JS — same shape as
      // coverageForSalesOrderRows — so the plain register list never pays.
      const summaries = await operationSummariesForOrders(db, rows.map((row) => row.id));
      return { rows: rows.map((row): ListedOrder => ({ ...row, operations: summaries.get(row.id) ?? [] })), total };
    },

    // fromStatus: only from that status (null when the order has moved on) —
    // Stäng order, whose done → closed must not overtake a Förbruka that
    // locked the order first.
    async updateStatus(
      id: string,
      status: (typeof manufacturingOrders.$inferSelect)["status"],
      fromStatus?: (typeof manufacturingOrders.$inferSelect)["status"]
    ) {
      const [row] = await db
        .update(manufacturingOrders)
        .set({ status, updatedAt: new Date() })
        .where(fromStatus ? and(eq(manufacturingOrders.id, id), eq(manufacturingOrders.status, fromStatus)) : eq(manufacturingOrders.id, id))
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

    // Legoinköp på TO-kortet — see lego-purchases.ts.
    async listLegoPurchases(manufacturingOrderId: string) {
      return listLegoPurchases(db, manufacturingOrderId);
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
    async updateOperation(
      moId: string,
      opId: string,
      input: UpdateMoOperationInput,
      replan?: OrderReplanner,
      prepare?: PrepareOperationUpdate
    ) {
      return db.transaction((tx) => updateOperationInTx(tx, moId, opId, input, replan, prepare));
    },
    async removeOperation(moId: string, opId: string, replan?: OrderReplanner) {
      return db.transaction((tx) => removeOperationInTx(tx, moId, opId, replan));
    },

    // Atomic: Släpp of a TO still in planned — see releaseInTx. The order
    // is locked and its status read again first: two Släpp at once (the
    // second fell on the snapshot's unique indexes) or a Makulera between
    // the service's check and here (overwritten with released) are refused.
    async release(moId: string) {
      return db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ status: manufacturingOrders.status })
          .from(manufacturingOrders)
          .where(eq(manufacturingOrders.id, moId))
          .for("update");
        if (!locked) return null;
        if (locked.status !== "planned") return { invalidStatus: locked.status };
        return releaseInTx(tx, moId);
      });
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
      input: { locationId?: string; batchId?: string | null; quantity: number; createdBy: string; materialShortage?: MaterialShortageCheck }
    ): Promise<ConsumeMaterialResult> {
      return db.transaction(async (tx) => {
        // The order FOR UPDATE, before the row (the reports' order → rows):
        // Stäng order is conditional on the status this lock serialises, so a
        // draw never lands on an order that closed under it.
        const [order] = await tx.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, moId)).for("update");
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

        const newConsumed = round4(Number(row.quantityConsumed) + input.quantity);
        if (newConsumed > round4(Number(row.quantityPlanned))) {
          return { ok: false, reason: "over_consumption" };
        }

        const [updatedRow] = await tx
          .update(moMaterialConsumptions)
          .set({ quantityConsumed: String(newConsumed) })
          .where(eq(moMaterialConsumptions.id, rowId))
          .returning();

        // Förbruka: drawn where the stock is unless a location was chosen —
        // never from a chosen Spärrad lagerplats (409).
        const lines = await drawMaterial(tx, row, input.quantity, input.locationId, moId, input.createdBy, "refuse", input.batchId);
        // Materialbrist: a throw here rolls the draw back.
        await assertMaterialAvailable(tx, lines, input.materialShortage ?? NO_MATERIAL_SHORTAGE_CHECK);

        const report = await insertReport(
          tx,
          {
            manufacturingOrderId: moId,
            kind: "material",
            source: "card",
            createdBy: input.createdBy,
          },
          lines
        );

        // reportId: the TO card's notice offers Ångra on exactly this draw.
        return { ok: true, row: updatedRow!, reportId: report.id };
      });
    },

    async findOperationById(operationId: string) {
      const [row] = await db.select().from(moOperations).where(eq(moOperations.id, operationId));
      return row ?? null;
    },

    // Atomic: one incremental quantity report — see reportOperationQuantitiesInTx.
    async reportOperationQuantities(operationId: string, input: ReportOperationQuantitiesInput): Promise<CompleteOperationResult> {
      return db.transaction(async (tx) => {
        await input.receiptLink?.claim(tx);
        const result = await reportOperationQuantitiesInTx(tx, operationId, input);
        if (result.ok) await input.receiptLink?.link(tx, result.reportId);
        return result;
      });
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
          // Batch (#8): the batch the finished goods were booked in.
          receiptBatchNumber: stockBatches.batchNumber,
        })
        .from(moReports)
        .leftJoin(stockBatches, eq(stockBatches.id, moReports.receiptBatchId))
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
              // The TO card hides Ta bort and the component swap on a row any
              // report line points at — undone ones too (materialHasConsumption).
              materialConsumptionId: moReportMaterials.materialConsumptionId,
              articleNumber: articles.articleNumber,
              quantity: moReportMaterials.quantity,
              // Uttag där saldot finns: one line per location the draw
              // took from.
              locationName: stockLocations.name,
              // Batch (#8): the batch the part was drawn from (null = Okänd).
              batchNumber: stockBatches.batchNumber,
            })
            .from(moReportMaterials)
            .leftJoin(stockBatches, eq(stockBatches.id, moReportMaterials.batchId))
            .innerJoin(moMaterialConsumptions, eq(moMaterialConsumptions.id, moReportMaterials.materialConsumptionId))
            .innerJoin(articles, eq(articles.id, moMaterialConsumptions.componentArticleId))
            // Left: a service line has no place (locationName null).
            .leftJoin(stockLocations, eq(stockLocations.id, moReportMaterials.locationId))
            .where(
              inArray(
                moReportMaterials.moReportId,
                rows.map((r) => r.id)
              )
            )
            .orderBy(asc(articles.articleNumber), asc(stockLocations.name))
        : [];
      return rows.map((r) => ({
        ...r,
        materials: materials
          .filter((m) => m.moReportId === r.id)
          .map(({ materialConsumptionId, articleNumber, quantity, locationName, batchNumber }) => ({
            materialConsumptionId,
            articleNumber,
            quantity,
            locationName,
            // Batch (#8): the batch the part was drawn from, null = Okänd
            // (and every line of a component that is not batchstyrd).
            batchNumber,
          })),
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

        const report = await insertReport(
          tx,
          {
            manufacturingOrderId: moId,
            kind: "completion",
            source: "card",
            quantityReceived: String(goods.delta),
            receiptLocationId: goods.locationId,
            receiptBatchId: goods.batchId,
            completedOrder: true,
            createdBy: input.createdBy,
          },
          goods.consumed
        );

        return { ok: true, order: updatedOrder!, consumed: goods.consumed, received: goods.delta, reportId: report.id };
      });
    },
  };
}

export type ManufacturingRepository = ReturnType<typeof createManufacturingRepository>;
