import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { legoOneOffSql, legoOrderedQuantitySql } from "../../manufacturing/repository/lego-one-off.js";
// Leaf: the rörd rule shared with Ändra operationer (#15) — no module cycle.
import {
  operationTouchedSql,
  switchOperationResourcesInTx,
  type ResourceSwitch,
} from "../../manufacturing/repository/operation-resources.js";
import {
  articleForecasts,
  articles,
  articleSuppliers,
  bomComponents,
  configuratorTemplates,
  configuratorVariants,
  customers,
  daySchedules,
  dayScheduleBreaks,
  holidays,
  inquiries,
  inquiryRows,
  manufacturingOrders,
  moMaterialConsumptions,
  moOperationPlanWeeks,
  moOperationResources,
  moOperations,
  productionGroups,
  purchaseOrderRows,
  purchaseOrders,
  routingOperations,
  salesOrderRows,
  salesOrders,
  stampSessions,
  stockTransactions,
  suppliers,
  timeReports,
  units,
  weekScheduleDays,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import { computeDayScheduleNetMinutes, type OrderRowConfiguration } from "@navet/shared";
import type {
  LegoOperationRow,
  ManufacturingOrderStatus,
  PrimarySupplierWithBreaks,
  PurchaseOrderStatus,
  RequirementsInput,
  SalesOrderStatus,
} from "../service/requirements-calc.js";
import type {
  DatingManufacturingOrder,
  DatingMoOperation,
  DatingRoutingOperation,
  DatingWorkCenter,
} from "../service/requirements-dating.js";
import type { LeadTimeDefaults } from "../service/manufacturing-lead-time.js";
import { addDays, stockholmDateOf, stockholmInstant, type PartnerDeliveryFields } from "../../system/service/delivery-days.js";
import { stockValuedAt } from "../../stock/repository/valued-at.js";
import { loadAbcSettings, loadForecastSettings } from "../../system/repository/plan-settings.js";
import type { ForecastMonth } from "../service/forecast.js";
import { loadPriceBreaks } from "../../purchase/repository/price-breaks.js";
import type { CapacityInput, OperationResourceOption, PlannedWeek } from "../service/capacity-calc.js";
import type { OperationPlan } from "../service/production-plan.js";
import { roundPlanWeeks } from "../service/capacity-book.js";
import type { ArticleOverviewLoad } from "../service/article-overview.js";
import { loadDeliveryContext } from "../../system/repository/delivery-context.js";
import { loadLeadTimeDefaults, loadLongOperationWeeks } from "../../system/repository/plan-settings.js";
import { purchaseRowArrivalDate, salesRowDeliveryDate } from "./effective-dates.js";
import { onHandByArticle } from "../../stock/repository/on-hand.js";

// Reported time per operation of the orders `orderFilter` selects, split by
// resource (#15, time_reports.work_center_id; a report without one counts on
// the operation's current resource) — what remainingOperationMinutes' setup
// rule (setupDoneOnCurrentResource, capacity-calc.ts) reads. ONE grouped
// query next to the operations, never per operation.
async function operationTimeOnResources(dbc: Db | Tx, orderFilter: SQL | undefined) {
  const rows = await dbc
    .select({
      moOperationId: timeReports.moOperationId,
      onCurrent: sql<boolean>`coalesce(bool_or(${timeReports.workCenterId} is null or ${timeReports.workCenterId} = ${moOperations.workCenterId}), false)`,
      onOther: sql<boolean>`coalesce(bool_or(${timeReports.workCenterId} <> ${moOperations.workCenterId}), false)`,
    })
    .from(timeReports)
    .innerJoin(moOperations, eq(moOperations.id, timeReports.moOperationId))
    .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
    .where(orderFilter)
    .groupBy(timeReports.moOperationId);
  return new Map(rows.map((row) => [row.moOperationId, { timeOnCurrentResource: row.onCurrent, timeOnOtherResource: row.onOther }]));
}
const NO_TIME = { timeOnCurrentResource: false, timeOnOtherResource: false };

// ABC-klassning (#10): one selected article as abcArticles returns it.
export interface AbcArticleRow {
  articleId: string;
  articleNumber: string;
  name: string;
  type: "purchased" | "manufactured";
  standardCost: number | null;
  reorderPoint: number | null;
  safetyStock: number | null;
  forecastControlled: boolean;
}

export interface PlanningArticleInfo {
  articleId: string;
  articleNumber: string;
}

// Tidsfasade förslag (#13): what the planning service needs to date every
// open TO's material (requirements-dating.ts) — the TOs' operations with
// their planned weeks, the resources, the routings and the articles' Ledtid
// (dagar). Loaded once per run, never per article.
export interface MoDatingInputs {
  operations: DatingMoOperation[];
  routings: DatingRoutingOperation[];
  workCenters: DatingWorkCenter[];
  articleLeadTimes: Map<string, number | null>;
  // The filtered TOs' remaining quantity (moRemainingQuantity, the same
  // figure the behovsberäkning dates with) — a TO without operations is
  // timed on the article's routing for it. Empty without an order filter.
  orderQuantities: Map<string, number>;
  // Standardledtid/Standardkötid (system settings), loaded with the rest so
  // every reader of one run applies the same pair.
  defaults: LeadTimeDefaults;
}

// loadRequirementsInput's result: the pure calc's input plus what the
// service dates it with before computeRequirements runs — the KO rows' raw
// delivery dates (moved to ship dates by toShipDates), the TOs' ids and due
// dates (moStartDate), the material rows' TO and the lego operations'
// resource and TO due date (computeLegoOperationDates). The calc ignores the
// extra fields.
export interface RequirementsLoad extends RequirementsInput {
  articles: (RequirementsInput["articles"][number] & { manufacturingLeadTimeDays: number | null })[];
  salesRows: (RequirementsInput["salesRows"][number] & { expectedDeliveryDate: string | null; customerDelivery: PartnerDeliveryFields })[];
  manufacturingOrders: (RequirementsInput["manufacturingOrders"][number] & DatingManufacturingOrder)[];
  moMaterialRows: (RequirementsInput["moMaterialRows"][number] & { manufacturingOrderId: string })[];
  legoOperationRows: (LegoOperationRow & { workCenterId: string; dueDate: string | null })[];
  dating: MoDatingInputs;
}

// Statuses worth loading at all — the pure calc owns the semantics, these
// filters only keep finished/cancelled history out of the transfer. Draft
// IOs ARE loaded (they net as their own supply bucket).
const OPEN_SALES: SalesOrderStatus[] = ["confirmed", "in_production"];
const OPEN_PO: PurchaseOrderStatus[] = ["draft", "confirmed", "partially_received"];
const OPEN_MO: ManufacturingOrderStatus[] = ["planned", "released", "in_progress"];
// Inquiry (förfrågan) statuses that still represent a live RFQ — cancelled
// and ordered inquiries are done deals (or superseded by the IO) and are
// deliberately left off the lego row: only a still-open ask is shown.
const OPEN_INQUIRY: ("draft" | "sent" | "answered")[] = ["draft", "sent", "answered"];

// An open TO's supply: the order quantity minus what is already received
// into stock (delinleverans from the last operation), never below zero.
const moRemainingQuantity = sql<string>`greatest(${manufacturingOrders.quantity} - ${manufacturingOrders.quantityReceived}, 0)`;

// Rows per INSERT / UPDATE … FROM (VALUES …) in writeOperationPlans — well
// under the driver's parameter limit at three parameters a row.
const WRITE_BATCH = 1000;

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// The BOM edges every demand reader sees (behovsberäkning, artikelöversikt,
// Leveranstidskontroll, Skapa ordrar's low-level codes): "Kalkyl" rows
// (bom_components.costing_only) are priced in the förkalkyl only and create no
// dependent demand. Dropping the EDGE also keeps a phantom under such a row
// from being exploded into demand — its whole subtree is costing-only.
const DEMAND_BOM_ROWS = eq(bomComponents.costingOnly, false);

// Förbrukning (#10, ONE definition shared by the forecast and the coming ABC
// classification): the net of sales deliveries and TO material draws —
// −Σ quantity_delta of these types, so an undone delivery/report (a positive
// row of the same type) cancels itself out. Receipts, stock counts,
// transfers and undone receipts are not consumption.
const CONSUMPTION_TYPES = ["sales_delivery", "mo_consumption"] as const;
// The Stockholm month of a stock row's värderingsdag (the same instant
// idx_stock_transactions_valued_at is built on).
const stockMonth = sql<string>`to_char(${stockValuedAt} AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM')`;

// Pegging (#9): what coverageParents loads for a set of parent TOs.
export interface CoverageParentsLoad {
  orders: {
    id: string;
    orderNumber: string;
    status: ManufacturingOrderStatus;
    articleId: string;
    articleNumber: string;
    quantity: number;
    dueDate: string | null;
  }[];
  // Per released/in-progress TO: the component articles with rest.
  materialComponents: Map<string, string[]>;
}

export function createPlanningRepository(db: Db) {
  // Pending lego (subcontract) operations on released/in_progress MOs, with
  // the already-ordered quantity per operation (Σ quantity_ordered on
  // non-cancelled IO rows pointing at the operation). Planned MOs are
  // deliberately excluded in v1 — no snapshot exists yet.
  async function legoOperations(moOperationIds?: string[]) {
    const conditions = [
      eq(workCenters.type, "subcontract"),
      eq(moOperations.status, "pending"),
      inArray(manufacturingOrders.status, ["released", "in_progress"]),
    ];
    if (moOperationIds) conditions.push(inArray(moOperations.id, moOperationIds));
    const rows = await db
      .select({
        moOperationId: moOperations.id,
        manufacturingOrderId: moOperations.manufacturingOrderId,
        orderNumber: manufacturingOrders.orderNumber,
        articleId: manufacturingOrders.articleId,
        articleNumber: articles.articleNumber,
        articleName: articles.name,
        articleType: articles.type,
        unitCode: units.code,
        groupId: articles.groupId,
        sequenceNo: moOperations.sequenceNo,
        operationDescription: moOperations.description,
        workCenterId: moOperations.workCenterId,
        workCenterName: workCenters.name,
        orderQuantity: manufacturingOrders.quantity,
        // The lego dates run backward from it (computeLegoOperationDates) —
        // Planera never gives a lego operation a planned week.
        dueDate: manufacturingOrders.dueDate,
        orderedQuantity: legoOrderedQuantitySql(),
        supplierId: moOperations.subcontractSupplierId,
        supplierName: suppliers.name,
        // Ställpris + Transportkostnad — the lego IO row's one-off.
        setupPrice: legoOneOffSql(moOperations),
        unitPrice: moOperations.unitPrice,
      })
      .from(moOperations)
      .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
      .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
      .innerJoin(units, eq(units.id, articles.unitId))
      .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
      .leftJoin(suppliers, eq(suppliers.id, moOperations.subcontractSupplierId))
      .where(and(...conditions));

    // Open förfrågningar for the returned operations, loaded in one extra
    // query and grouped in JS — same shape as the batched "all lego
    // operations" load above, just keyed by mo_operation_id instead of
    // article. Purely informational (see LegoOperationRow.openInquiries):
    // orderQuantity/orderedQuantity above are untouched by this.
    const operationIds = rows.map((r) => r.moOperationId);
    const openInquiriesByOperation = new Map<
      string,
      { id: string; inquiryNumber: string; status: "draft" | "sent" | "answered" }[]
    >();
    if (operationIds.length > 0) {
      const inquiryRowsForOps = await db
        .select({
          moOperationId: inquiryRows.moOperationId,
          id: inquiries.id,
          inquiryNumber: inquiries.inquiryNumber,
          status: inquiries.status,
        })
        .from(inquiryRows)
        .innerJoin(inquiries, eq(inquiries.id, inquiryRows.inquiryId))
        .where(and(inArray(inquiryRows.moOperationId, operationIds), inArray(inquiries.status, OPEN_INQUIRY)))
        .orderBy(inquiries.inquiryNumber);
      for (const r of inquiryRowsForOps) {
        // moOperationId is NOT NULL for these rows (filtered by the IN
        // above), the narrowing just satisfies the nullable column type.
        if (!r.moOperationId) continue;
        const list = openInquiriesByOperation.get(r.moOperationId);
        const entry = { id: r.id, inquiryNumber: r.inquiryNumber, status: r.status as "draft" | "sent" | "answered" };
        if (list) list.push(entry);
        else openInquiriesByOperation.set(r.moOperationId, [entry]);
      }
    }

    return rows.map(
      (r): LegoOperationRow & { workCenterId: string; dueDate: string | null } => ({
        moOperationId: r.moOperationId,
        manufacturingOrderId: r.manufacturingOrderId,
        orderNumber: r.orderNumber,
        articleId: r.articleId,
        articleNumber: r.articleNumber,
        articleName: r.articleName,
        // A lego operation on a service article cannot occur (services have
        // no routing), so the narrowing only formalises the join.
        articleType: r.articleType === "purchased" ? "purchased" : "manufactured",
        unitCode: r.unitCode,
        groupId: r.groupId,
        sequenceNo: r.sequenceNo,
        operationDescription: r.operationDescription,
        workCenterId: r.workCenterId,
        workCenterName: r.workCenterName,
        dueDate: r.dueDate,
        orderQuantity: Number(r.orderQuantity),
        orderedQuantity: Number(r.orderedQuantity),
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        setupPrice: r.setupPrice === null ? null : Number(r.setupPrice),
        unitPrice: r.unitPrice === null ? null : Number(r.unitPrice),
        openInquiries: openInquiriesByOperation.get(r.moOperationId) ?? [],
      })
    );
  }

  async function primarySuppliersFor(articleIds?: string[], dbc: Db | Tx = db) {
    const where = articleIds
      ? and(eq(articleSuppliers.isPrimary, true), inArray(articleSuppliers.articleId, articleIds))
      : eq(articleSuppliers.isPrimary, true);
    const rows = await dbc
      .select({
        rowId: articleSuppliers.id,
        articleId: articleSuppliers.articleId,
        supplierId: articleSuppliers.supplierId,
        supplierName: suppliers.name,
        price: articleSuppliers.price,
        currency: articleSuppliers.currency,
        leadTimeDays: articleSuppliers.leadTimeDays,
        // Fasta leveransdagar — Skapa ordrar dates the IO rows with them.
        supplierDelivery: {
          deliveryWeekdays: suppliers.deliveryWeekdays,
          deliveryDayMode: suppliers.deliveryDayMode,
          transitDays: suppliers.transitDays,
        },
      })
      .from(articleSuppliers)
      .innerJoin(suppliers, eq(suppliers.id, articleSuppliers.supplierId))
      .where(where);
    return rows.map((r) => ({
      ...r,
      price: r.price === null ? null : Number(r.price),
    }));
  }

  // The dating inputs (requirements-dating.ts). `orderIds`/`articleIds`
  // undefined = every open TO / every routing (the behovsberäkning's whole
  // run); a list = only those (the artikelöversikt's TOs and parents, the
  // färdigdatumsförslag's one article). The resources are always all of
  // them — a handful of rows.
  async function datingInputs(
    dbc: Db | Tx,
    filter: { orderIds?: string[]; articleIds?: string[] } = {}
  ): Promise<MoDatingInputs> {
    const orderConditions = [inArray(manufacturingOrders.status, OPEN_MO)];
    if (filter.orderIds) orderConditions.push(inArray(manufacturingOrders.id, filter.orderIds));
    const routingConditions = [eq(routingOperations.costingOnly, false)];
    if (filter.articleIds) routingConditions.push(inArray(routingOperations.articleId, filter.articleIds));
    const articleConditions = [eq(articles.type, "manufactured")];
    if (filter.articleIds) articleConditions.push(inArray(articles.id, filter.articleIds));
    const noOrders = filter.orderIds !== undefined && filter.orderIds.length === 0;
    const noArticles = filter.articleIds !== undefined && filter.articleIds.length === 0;
    const [operationRows, routingRows, workCenterRows, articleRows, orderRows, defaults, timeOnResources] = await Promise.all([
      noOrders
        ? Promise.resolve([])
        : dbc
            .select({
              moOperationId: moOperations.id,
              sequenceNo: moOperations.sequenceNo,
              manufacturingOrderId: moOperations.manufacturingOrderId,
              workCenterId: moOperations.workCenterId,
              setupTime: moOperations.setupTime,
              runTimePerUnit: moOperations.runTimePerUnit,
              operationStatus: moOperations.status,
              orderQuantity: manufacturingOrders.quantity,
              quantityCompleted: moOperations.quantityCompleted,
              quantityScrapped: moOperations.quantityScrapped,
              plannedStartWeek: moOperations.plannedStartWeek,
              planLocked: moOperations.planLocked,
            })
            .from(moOperations)
            .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
            .where(and(...orderConditions)),
      noArticles
        ? Promise.resolve([])
        : dbc
            .select({
              articleId: routingOperations.articleId,
              workCenterId: routingOperations.workCenterId,
              setupTime: routingOperations.setupTime,
              runTimePerUnit: routingOperations.runTimePerUnit,
            })
            .from(routingOperations)
            .where(and(...routingConditions)),
      dbc
        .select({
          workCenterId: workCenters.id,
          type: workCenters.type,
          hoursPerDay: workCenters.hoursPerDay,
          leadTimeDays: workCenters.leadTimeDays,
          queueTimeDays: workCenters.queueTimeDays,
          orderLeadTimeDays: workCenters.orderLeadTimeDays,
        })
        .from(workCenters),
      noArticles
        ? Promise.resolve([])
        : dbc
            .select({ articleId: articles.id, manufacturingLeadTimeDays: articles.manufacturingLeadTimeDays })
            .from(articles)
            .where(and(...articleConditions)),
      filter.orderIds === undefined || noOrders
        ? Promise.resolve([])
        : dbc
            .select({ manufacturingOrderId: manufacturingOrders.id, quantity: moRemainingQuantity })
            .from(manufacturingOrders)
            .where(inArray(manufacturingOrders.id, filter.orderIds)),
      loadLeadTimeDefaults(dbc),
      noOrders ? Promise.resolve(new Map<string, typeof NO_TIME>()) : operationTimeOnResources(dbc, and(...orderConditions)),
    ]);
    const num = (v: string | null) => (v === null ? null : Number(v));
    return {
      operations: operationRows.map((r) => ({
        ...r,
        setupTime: Number(r.setupTime),
        runTimePerUnit: Number(r.runTimePerUnit),
        orderQuantity: Number(r.orderQuantity),
        quantityCompleted: num(r.quantityCompleted),
        quantityScrapped: Number(r.quantityScrapped),
        ...(timeOnResources.get(r.moOperationId) ?? NO_TIME),
      })),
      routings: routingRows.map((r) => ({ ...r, setupTime: Number(r.setupTime), runTimePerUnit: Number(r.runTimePerUnit) })),
      workCenters: workCenterRows.map((r) => ({
        workCenterId: r.workCenterId,
        type: r.type,
        hoursPerDay: num(r.hoursPerDay),
        leadTimeDays: num(r.leadTimeDays),
        queueTimeDays: num(r.queueTimeDays),
        orderLeadTimeDays: num(r.orderLeadTimeDays),
      })),
      articleLeadTimes: new Map(articleRows.map((r) => [r.articleId, r.manufacturingLeadTimeDays])),
      orderQuantities: new Map(orderRows.map((r) => [r.manufacturingOrderId, Number(r.quantity)])),
      defaults,
    };
  }

  return {
    // One set-based query per source; all business rules (which statuses are
    // demand/supply, netting, cascade) live in the pure calc.
    async loadRequirementsInput(): Promise<RequirementsLoad> {
      const [articleRows, salesRows, purchaseRows, moRows, materialRows, stockRows, bomEdges, primary, legoRows] =
        await Promise.all([
          db
            .select({
              articleId: articles.id,
              articleNumber: articles.articleNumber,
              name: articles.name,
              type: articles.type,
              isPhantom: articles.isPhantom,
              active: articles.active,
              unitCode: units.code,
              groupId: articles.groupId,
              reorderPoint: articles.reorderPoint,
              safetyStock: articles.safetyStock,
              orderQuantity: articles.orderQuantity,
              rounding: articles.rounding,
              manufacturingLeadTimeDays: articles.manufacturingLeadTimeDays,
              forecastControlled: articles.forecastControlled,
              // Konfigurator: same left join as the article list's configuratorMode.
              configuratorMode: configuratorTemplates.mode,
            })
            .from(articles)
            .innerJoin(units, eq(units.id, articles.unitId))
            .leftJoin(configuratorTemplates, eq(configuratorTemplates.articleId, articles.id))
            .where(ne(articles.type, "service")),
          db
            .select({
              articleId: salesOrderRows.articleId,
              orderStatus: salesOrders.status,
              quantityOrdered: salesOrderRows.quantityOrdered,
              quantityDelivered: salesOrderRows.quantityDelivered,
              // Tidsfasade förslag: the row's effective delivery date and the
              // customer's delivery fields — the service moves it to the ship
              // date (toShipDates), exactly as the artikelöversikt's rows.
              expectedDeliveryDate: salesRowDeliveryDate,
              customerDelivery: {
                deliveryWeekdays: customers.deliveryWeekdays,
                deliveryDayMode: customers.deliveryDayMode,
                transitDays: customers.transitDays,
              },
            })
            .from(salesOrderRows)
            .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
            .innerJoin(customers, eq(customers.id, salesOrders.customerId))
            // Konfigurator 4c: configured rows count as demand on the template
            // like any row (the TO made for the row is the template's supply);
            // the template itself is never proposed (configuratorMode).
            .where(inArray(salesOrders.status, OPEN_SALES)),
          db
            .select({
              articleId: purchaseOrderRows.articleId,
              orderStatus: purchaseOrders.status,
              quantityOrdered: purchaseOrderRows.quantityOrdered,
              quantityReceived: purchaseOrderRows.quantityReceived,
            })
            .from(purchaseOrderRows)
            .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
            // Lego rows (mo_operation_id set) are OPERATION demand, never
            // article supply — the goods come home via the MO's mo_receipt,
            // and the MO already counts as supply (supplyMo). Counting the
            // lego IO too would double the units. Applies to draft and
            // confirmed alike (OPEN_PO covers both).
            .where(and(inArray(purchaseOrders.status, OPEN_PO), isNull(purchaseOrderRows.moOperationId))),
          db
            .select({
              manufacturingOrderId: manufacturingOrders.id,
              articleId: manufacturingOrders.articleId,
              status: manufacturingOrders.status,
              // Supply is what is still to come: units already received
              // (delinleverans) are on hand and must not count twice.
              quantity: moRemainingQuantity,
              dueDate: manufacturingOrders.dueDate,
              // Konfigurator 4c: a configured TO has its own material rows.
              configured: sql<boolean>`${manufacturingOrders.configuration} is not null`,
            })
            .from(manufacturingOrders)
            .where(inArray(manufacturingOrders.status, OPEN_MO)),
          db
            .select({
              componentArticleId: moMaterialConsumptions.componentArticleId,
              manufacturingOrderId: moMaterialConsumptions.manufacturingOrderId,
              orderStatus: manufacturingOrders.status,
              quantityPlanned: moMaterialConsumptions.quantityPlanned,
              quantityConsumed: moMaterialConsumptions.quantityConsumed,
            })
            .from(moMaterialConsumptions)
            .innerJoin(
              manufacturingOrders,
              eq(manufacturingOrders.id, moMaterialConsumptions.manufacturingOrderId)
            )
            .where(inArray(manufacturingOrders.status, OPEN_MO)),
          // Användbart saldo — a Spärrad lagerplats does not cover demand
          // (same reader as the artikelöversikt below, so the invariant holds).
          onHandByArticle(db),
          db
            .select({
              parentArticleId: bomComponents.parentArticleId,
              componentArticleId: bomComponents.componentArticleId,
              quantity: bomComponents.quantity,
            })
            .from(bomComponents)
            // "Kalkyl" rows create no dependent demand (DEMAND_BOM_ROWS).
            .where(DEMAND_BOM_ROWS),
          primarySuppliersFor(),
          legoOperations(),
        ]);
      const dating = await datingInputs(db);

      return {
        dating,
        articles: articleRows.map((r) => ({
          articleId: r.articleId,
          articleNumber: r.articleNumber,
          name: r.name,
          type: r.type,
          isPhantom: r.isPhantom,
          active: r.active,
          unitCode: r.unitCode,
          groupId: r.groupId,
          reorderPoint: r.reorderPoint === null ? null : Number(r.reorderPoint),
          safetyStock: r.safetyStock === null ? null : Number(r.safetyStock),
          orderQuantity: r.orderQuantity === null ? null : Number(r.orderQuantity),
          rounding: r.rounding === null ? null : Number(r.rounding),
          manufacturingLeadTimeDays: r.manufacturingLeadTimeDays,
          forecastControlled: r.forecastControlled,
          configuratorMode: r.configuratorMode,
        })),
        salesRows: salesRows.map((r) => ({
          articleId: r.articleId,
          orderStatus: r.orderStatus,
          quantityOrdered: Number(r.quantityOrdered),
          quantityDelivered: Number(r.quantityDelivered),
          expectedDeliveryDate: r.expectedDeliveryDate,
          customerDelivery: r.customerDelivery,
        })),
        purchaseRows: purchaseRows.map((r) => ({
          articleId: r.articleId,
          orderStatus: r.orderStatus,
          quantityOrdered: Number(r.quantityOrdered),
          quantityReceived: Number(r.quantityReceived),
        })),
        manufacturingOrders: moRows.map((r) => ({
          manufacturingOrderId: r.manufacturingOrderId,
          articleId: r.articleId,
          status: r.status,
          quantity: Number(r.quantity),
          dueDate: r.dueDate,
          configured: r.configured,
        })),
        moMaterialRows: materialRows.map((r) => ({
          componentArticleId: r.componentArticleId,
          manufacturingOrderId: r.manufacturingOrderId,
          orderStatus: r.orderStatus,
          quantityPlanned: Number(r.quantityPlanned),
          quantityConsumed: Number(r.quantityConsumed),
        })),
        stock: [...stockRows].map(([articleId, onHand]) => ({ articleId, quantity: onHand.usable })),
        bomEdges: bomEdges.map((r) => ({
          parentArticleId: r.parentArticleId,
          componentArticleId: r.componentArticleId,
          quantity: Number(r.quantity),
        })),
        primarySuppliers: primary,
        legoOperationRows: legoRows,
        // Konfigurator 4c: filled by the planning service (it derives the
        // configured rows' material through the configurator).
        configuredRows: [],
        configuredCascade: new Map(),
      };
    },

    // Konfigurator 4c: configured (beställningsvara) rows on open sales orders,
    // with the TOs linked to each row — the planning service turns them into
    // proposal rows (uncoveredConfiguredQuantity) and cascades their derived
    // material. Same open statuses as the demand query.
    async loadConfiguredSalesRows() {
      const rows = await db
        .select({
          rowId: salesOrderRows.id,
          salesOrderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          customerName: customers.name,
          articleId: salesOrderRows.articleId,
          expectedDeliveryDate: salesRowDeliveryDate,
          customerDelivery: {
            deliveryWeekdays: customers.deliveryWeekdays,
            deliveryDayMode: customers.deliveryDayMode,
            transitDays: customers.transitDays,
          },
          quantityOrdered: salesOrderRows.quantityOrdered,
          quantityDelivered: salesOrderRows.quantityDelivered,
          configuration: salesOrderRows.configuration,
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(and(inArray(salesOrders.status, OPEN_SALES), isNotNull(salesOrderRows.configuration)));
      if (rows.length === 0) return [];
      // Every linked TO regardless of status — the coverage rule decides what
      // counts (cancelled ones count for nothing).
      const linked = await db
        .select({
          rowId: manufacturingOrders.salesOrderRowId,
          status: manufacturingOrders.status,
          quantity: manufacturingOrders.quantity,
          received: manufacturingOrders.quantityReceived,
        })
        .from(manufacturingOrders)
        .where(
          inArray(
            manufacturingOrders.salesOrderRowId,
            rows.map((r) => r.rowId)
          )
        );
      const byRow = new Map<string, { status: string; quantity: number; received: number }[]>();
      for (const l of linked) {
        if (!l.rowId) continue;
        const list = byRow.get(l.rowId) ?? [];
        list.push({ status: l.status, quantity: Number(l.quantity), received: Number(l.received) });
        byRow.set(l.rowId, list);
      }
      return rows.map((r) => ({
        ...r,
        quantityOrdered: Number(r.quantityOrdered),
        quantityDelivered: Number(r.quantityDelivered),
        configuration: r.configuration as OrderRowConfiguration,
        linkedOrders: byRow.get(r.rowId) ?? [],
      }));
    },

    // Artikelöversikt — ONE article's open rows WITH dates, for the pure
    // builder in article-overview.ts. Delegates to the batch loader below
    // (one implementation); null when the article does not exist.
    async loadArticleOverviewInput(articleId: string, dbc: Db | Tx = db): Promise<ArticleOverviewLoad | null> {
      return (await this.loadArticleOverviewInputs([articleId], dbc)).get(articleId) ?? null;
    },

    // The same for a SET of articles in a fixed number of queries
    // (Leveranstidskontroll loads every article in the checked tree): the
    // per-article sources are loaded with inArray and partitioned in JS,
    // the shared ones (planned MOs, BOM edges, phantoms) once. Same status
    // filters and the same lego exclusion as loadRequirementsInput, so the
    // two readers agree; the only additions are the order dates and the
    // document/partner columns the row list shows. Planned MOs are loaded
    // for every article (no snapshot exists yet — the builder explodes the
    // parent's BOM), as the MRP does per run. Unknown ids are simply absent.
    // `dbc`: the reservation runs the check inside its own transaction
    // (same Db | Tx widening as loadCapacityInput / loadDeliveryContext).
    // The material rows and planned TOs carry the TO's due date and parent
    // article; the service dates them with the TO's START (moStartDate,
    // loadMoDatingInputs) before the builder runs.
    async loadArticleOverviewInputs(articleIds: string[], dbc: Db | Tx = db): Promise<Map<string, ArticleOverviewLoad>> {
      const result = new Map<string, ArticleOverviewLoad>();
      const ids = [...new Set(articleIds)];
      if (ids.length === 0) return result;

      const articleRows = await dbc
        .select({
          articleId: articles.id,
          articleNumber: articles.articleNumber,
          name: articles.name,
          type: articles.type,
          isPhantom: articles.isPhantom,
          active: articles.active,
          unitCode: units.code,
          reorderPoint: articles.reorderPoint,
          orderQuantity: articles.orderQuantity,
          rounding: articles.rounding,
          // Prognos (#10): the service builds the forecast rows for a
          // prognosstyrd article; the template mode keeps the eligibility
          // rule the same as the behovsberäkning's (isForecastArticle).
          forecastControlled: articles.forecastControlled,
          configuratorMode: configuratorTemplates.mode,
        })
        .from(articles)
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(configuratorTemplates, eq(configuratorTemplates.articleId, articles.id))
        .where(inArray(articles.id, ids));
      if (articleRows.length === 0) return result;

      const [stockRows, salesRows, purchaseRows, moRows, materialRows, plannedRows, bomEdges, phantomRows, primary] =
        await Promise.all([
          // Användbart saldo plus the blocked part, which is only shown.
          onHandByArticle(dbc, ids),
          dbc
            .select({
              articleId: salesOrderRows.articleId,
              rowId: salesOrderRows.id,
              salesOrderId: salesOrders.id,
              orderNumber: salesOrders.orderNumber,
              orderStatus: salesOrders.status,
              customerName: customers.name,
              expectedDeliveryDate: salesRowDeliveryDate,
              customerDelivery: {
                deliveryWeekdays: customers.deliveryWeekdays,
                deliveryDayMode: customers.deliveryDayMode,
                transitDays: customers.transitDays,
              },
              quantityOrdered: salesOrderRows.quantityOrdered,
              quantityDelivered: salesOrderRows.quantityDelivered,
            })
            .from(salesOrderRows)
            .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
            .innerJoin(customers, eq(customers.id, salesOrders.customerId))
            // Konfigurator 4c: configured rows are demand on the template
            // here too — same rows as loadRequirementsInput's demand query.
            .where(and(inArray(salesOrderRows.articleId, ids), inArray(salesOrders.status, OPEN_SALES))),
          dbc
            .select({
              articleId: purchaseOrderRows.articleId,
              rowId: purchaseOrderRows.id,
              purchaseOrderId: purchaseOrders.id,
              orderNumber: purchaseOrders.orderNumber,
              orderStatus: purchaseOrders.status,
              supplierName: suppliers.name,
              // A Bekräftat leveransdatum (the row's, else the order's) wins
              // over the requested one (the row's, else the order's).
              expectedDeliveryDate: purchaseRowArrivalDate,
              quantityOrdered: purchaseOrderRows.quantityOrdered,
              quantityReceived: purchaseOrderRows.quantityReceived,
            })
            .from(purchaseOrderRows)
            .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
            .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
            .where(
              and(
                inArray(purchaseOrderRows.articleId, ids),
                inArray(purchaseOrders.status, OPEN_PO),
                isNull(purchaseOrderRows.moOperationId)
              )
            ),
          dbc
            .select({
              articleId: manufacturingOrders.articleId,
              moId: manufacturingOrders.id,
              orderNumber: manufacturingOrders.orderNumber,
              status: manufacturingOrders.status,
              dueDate: manufacturingOrders.dueDate,
              // Remaining only — the received part is already on hand.
              quantity: moRemainingQuantity,
            })
            .from(manufacturingOrders)
            .where(and(inArray(manufacturingOrders.articleId, ids), inArray(manufacturingOrders.status, OPEN_MO))),
          dbc
            .select({
              articleId: moMaterialConsumptions.componentArticleId,
              rowId: moMaterialConsumptions.id,
              moId: manufacturingOrders.id,
              orderNumber: manufacturingOrders.orderNumber,
              orderStatus: manufacturingOrders.status,
              dueDate: manufacturingOrders.dueDate,
              parentArticleId: manufacturingOrders.articleId,
              parentArticleNumber: articles.articleNumber,
              parentArticleName: articles.name,
              quantityPlanned: moMaterialConsumptions.quantityPlanned,
              quantityConsumed: moMaterialConsumptions.quantityConsumed,
            })
            .from(moMaterialConsumptions)
            .innerJoin(
              manufacturingOrders,
              eq(manufacturingOrders.id, moMaterialConsumptions.manufacturingOrderId)
            )
            .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
            .where(
              and(
                inArray(moMaterialConsumptions.componentArticleId, ids),
                inArray(manufacturingOrders.status, OPEN_MO)
              )
            ),
          dbc
            .select({
              moId: manufacturingOrders.id,
              orderNumber: manufacturingOrders.orderNumber,
              dueDate: manufacturingOrders.dueDate,
              parentArticleId: manufacturingOrders.articleId,
              parentArticleNumber: articles.articleNumber,
              parentArticleName: articles.name,
              quantity: manufacturingOrders.quantity,
            })
            .from(manufacturingOrders)
            .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
            // Konfigurator 4c (Avvikelse 7): a configured planned TO already
            // has material rows (seen via materialRows above, planned is in
            // MATERIAL_MO_STATUSES) — exploding it too would double count.
            .where(and(eq(manufacturingOrders.status, "planned"), isNull(manufacturingOrders.configuration))),
          dbc
            .select({
              parentArticleId: bomComponents.parentArticleId,
              componentArticleId: bomComponents.componentArticleId,
              quantity: bomComponents.quantity,
            })
            .from(bomComponents)
            // "Kalkyl" rows create no dependent demand (DEMAND_BOM_ROWS).
            .where(DEMAND_BOM_ROWS),
          dbc.select({ id: articles.id }).from(articles).where(eq(articles.isPhantom, true)),
          primarySuppliersFor(ids, dbc),
        ]);

      // Partition the per-article rows; the article id column is dropped
      // again so the row shapes stay exactly the builder's.
      function groupBy<T extends { articleId: string }>(rows: T[]): Map<string, Omit<T, "articleId">[]> {
        const map = new Map<string, Omit<T, "articleId">[]>();
        for (const { articleId, ...rest } of rows) {
          const list = map.get(articleId) ?? [];
          list.push(rest);
          map.set(articleId, list);
        }
        return map;
      }
      const stockByArticle = stockRows;
      const salesByArticle = groupBy(salesRows);
      const purchaseByArticle = groupBy(purchaseRows);
      const moByArticle = groupBy(moRows);
      const materialByArticle = groupBy(materialRows);
      const supplierByArticle = new Map(primary.map((s) => [s.articleId, s]));
      // Shared, read-only — the builder never mutates its input.
      const plannedMos = plannedRows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
      const sharedBomEdges = bomEdges.map((r) => ({
        parentArticleId: r.parentArticleId,
        componentArticleId: r.componentArticleId,
        quantity: Number(r.quantity),
      }));
      const phantomIds = phantomRows.map((r) => r.id);

      for (const article of articleRows) {
        const supplier = supplierByArticle.get(article.articleId);
        result.set(article.articleId, {
          article: {
            articleId: article.articleId,
            articleNumber: article.articleNumber,
            name: article.name,
            type: article.type,
            isPhantom: article.isPhantom,
            active: article.active,
            unitCode: article.unitCode,
            reorderPoint: article.reorderPoint === null ? null : Number(article.reorderPoint),
            orderQuantity: article.orderQuantity === null ? null : Number(article.orderQuantity),
            rounding: article.rounding === null ? null : Number(article.rounding),
            forecastControlled: article.forecastControlled,
            configuratorMode: article.configuratorMode,
          },
          // onHand = usable (the calculation's start); blockedOnHand is shown only.
          onHand: stockByArticle.get(article.articleId)?.usable ?? 0,
          blockedOnHand: stockByArticle.get(article.articleId)?.blocked ?? 0,
          salesRows: (salesByArticle.get(article.articleId) ?? []).map((r) => ({
            ...r,
            quantityOrdered: Number(r.quantityOrdered),
            quantityDelivered: Number(r.quantityDelivered),
          })),
          purchaseRows: (purchaseByArticle.get(article.articleId) ?? []).map((r) => ({
            ...r,
            quantityOrdered: Number(r.quantityOrdered),
            quantityReceived: Number(r.quantityReceived),
          })),
          manufacturingOrders: (moByArticle.get(article.articleId) ?? []).map((r) => ({ ...r, quantity: Number(r.quantity) })),
          materialRows: (materialByArticle.get(article.articleId) ?? []).map((r) => ({
            ...r,
            quantityPlanned: Number(r.quantityPlanned),
            quantityConsumed: Number(r.quantityConsumed),
          })),
          plannedMos,
          bomEdges: sharedBomEdges,
          phantomIds,
          primarySupplier: supplier
            ? { supplierId: supplier.supplierId, supplierName: supplier.supplierName, leadTimeDays: supplier.leadTimeDays }
            : null,
        });
      }
      return result;
    },

    // --- Prognos (#10) -----------------------------------------------------

    // The history window and the horizon (system settings, one query).
    async forecastSettings(dbc: Db | Tx = db) {
      return loadForecastSettings(dbc);
    },

    // Förbrukning per article and Stockholm month over [from, to] (both
    // inclusive Stockholm days): ONE grouped query, one row per (article,
    // month) with consumption; a month without a row consumed 0. `null`
    // article ids = every article (the ABC classification's read). The
    // range is applied to the värderingsdag instant so the expression index
    // is used; the month is the same instant's Stockholm month.
    async consumptionByMonth(
      articleIds: string[] | null,
      from: string,
      to: string,
      dbc: Db | Tx = db
    ): Promise<{ articleId: string; month: ForecastMonth; consumed: number }[]> {
      if (articleIds && articleIds.length === 0) return [];
      // Bound as ISO text: a Date next to a SQL expression (not a column)
      // has no column mapper, and the driver refuses it.
      const fromInstant = new Date(stockholmInstant(from, "00:00")).toISOString();
      const toInstant = new Date(stockholmInstant(addDays(to, 1), "00:00")).toISOString();
      const rows = await dbc
        .select({
          articleId: stockTransactions.articleId,
          month: stockMonth,
          consumed: sql<string>`-sum(${stockTransactions.quantityDelta})`,
        })
        .from(stockTransactions)
        .where(
          and(
            inArray(stockTransactions.transactionType, [...CONSUMPTION_TYPES]),
            sql`${stockValuedAt} >= ${fromInstant}::timestamptz`,
            sql`${stockValuedAt} < ${toInstant}::timestamptz`,
            articleIds ? inArray(stockTransactions.articleId, [...new Set(articleIds)]) : undefined
          )
        )
        .groupBy(stockTransactions.articleId, stockMonth);
      return rows.map((r) => ({ articleId: r.articleId, month: r.month, consumed: Number(r.consumed) }));
    },

    // --- ABC-klassning (#10, etapp 2) -------------------------------------

    // The period and the class limits (system settings, one query).
    async abcSettings(dbc: Db | Tx = db) {
      return loadAbcSettings(dbc);
    },

    // The classification's selection: active purchased and manufactured
    // articles that are neither phantoms nor configurator templates (in
    // either mode — a variant template's variants and a beställningsvara's
    // configured TOs are what moves in stock, never the template itself),
    // with the current standard cost and the Planering card's fields.
    async abcArticles(dbc: Db | Tx = db): Promise<AbcArticleRow[]> {
      const rows = await dbc
        .select({
          articleId: articles.id,
          articleNumber: articles.articleNumber,
          name: articles.name,
          type: articles.type,
          standardCost: articles.standardCost,
          reorderPoint: articles.reorderPoint,
          safetyStock: articles.safetyStock,
          forecastControlled: articles.forecastControlled,
        })
        .from(articles)
        .leftJoin(configuratorTemplates, eq(configuratorTemplates.articleId, articles.id))
        .where(
          and(
            eq(articles.active, true),
            eq(articles.isPhantom, false),
            inArray(articles.type, ["purchased", "manufactured"]),
            isNull(configuratorTemplates.articleId)
          )
        );
      return rows.map((r) => ({
        articleId: r.articleId,
        articleNumber: r.articleNumber,
        name: r.name,
        type: r.type as "purchased" | "manufactured",
        standardCost: r.standardCost === null ? null : Number(r.standardCost),
        reorderPoint: r.reorderPoint === null ? null : Number(r.reorderPoint),
        safetyStock: r.safetyStock === null ? null : Number(r.safetyStock),
        forecastControlled: r.forecastControlled,
      }));
    },

    // The Stockholm day of each article's first stock movement (any type) —
    // the short-history rule's divisor (forecast.ts). Absent = never moved.
    async firstMovementByArticle(articleIds: string[] | null, dbc: Db | Tx = db): Promise<Map<string, string>> {
      if (articleIds && articleIds.length === 0) return new Map();
      const rows = await dbc
        .select({ articleId: stockTransactions.articleId, first: sql<Date>`min(${stockValuedAt})`.mapWith(stockTransactions.createdAt) })
        .from(stockTransactions)
        .where(articleIds ? inArray(stockTransactions.articleId, [...new Set(articleIds)]) : undefined)
        .groupBy(stockTransactions.articleId);
      return new Map(rows.map((r) => [r.articleId, stockholmDateOf(r.first)]));
    },

    // The articles' own quantities per month ("YYYY-MM" → quantity).
    async ownForecastQuantities(articleIds: string[], dbc: Db | Tx = db): Promise<Map<string, Map<ForecastMonth, number>>> {
      const out = new Map<string, Map<ForecastMonth, number>>();
      if (articleIds.length === 0) return out;
      const rows = await dbc
        .select({ articleId: articleForecasts.articleId, month: articleForecasts.month, quantity: articleForecasts.quantity })
        .from(articleForecasts)
        .where(inArray(articleForecasts.articleId, [...new Set(articleIds)]));
      for (const r of rows) {
        const months = out.get(r.articleId) ?? new Map<ForecastMonth, number>();
        months.set(r.month.slice(0, 7), Number(r.quantity));
        out.set(r.articleId, months);
      }
      return out;
    },

    // PUT /articles/:id/forecast: replace the given months in ONE
    // transaction — null deletes the own quantity (the average applies
    // again), a number upserts it. Returns the months' values before and
    // after for the händelselogg.
    async replaceArticleForecasts(
      articleId: string,
      months: { month: ForecastMonth; quantity: number | null }[],
      userId: string | null
    ): Promise<{ before: Map<ForecastMonth, number>; after: Map<ForecastMonth, number> }> {
      return db.transaction(async (tx) => {
        const dates = months.map((m) => `${m.month}-01`);
        const existing = await tx
          .select({ month: articleForecasts.month, quantity: articleForecasts.quantity })
          .from(articleForecasts)
          .where(and(eq(articleForecasts.articleId, articleId), inArray(articleForecasts.month, dates)));
        const before = new Map(existing.map((r) => [r.month.slice(0, 7), Number(r.quantity)]));
        const after = new Map(before);
        const toDelete = months.filter((m) => m.quantity === null).map((m) => `${m.month}-01`);
        if (toDelete.length > 0) {
          await tx.delete(articleForecasts).where(and(eq(articleForecasts.articleId, articleId), inArray(articleForecasts.month, toDelete)));
          for (const m of months) if (m.quantity === null) after.delete(m.month);
        }
        const toWrite = months.filter((m): m is { month: ForecastMonth; quantity: number } => m.quantity !== null);
        if (toWrite.length > 0) {
          const now = new Date();
          await tx
            .insert(articleForecasts)
            .values(toWrite.map((m) => ({ articleId, month: `${m.month}-01`, quantity: String(m.quantity), updatedAt: now, updatedBy: userId })))
            .onConflictDoUpdate({
              target: [articleForecasts.articleId, articleForecasts.month],
              set: { quantity: sql`excluded.quantity`, updatedAt: now, updatedBy: userId },
            });
          for (const m of toWrite) after.set(m.month, m.quantity);
        }
        return { before, after };
      });
    },

    // Tidsfasade förslag: the dating inputs for a set of TOs and the articles
    // whose routing/field decide the lead time (the artikelöversikt's TOs
    // and their parents; the färdigdatumsförslag's article with no TOs).
    async loadMoDatingInputs(filter: { orderIds: string[]; articleIds: string[] }, dbc: Db | Tx = db): Promise<MoDatingInputs> {
      return datingInputs(dbc, filter);
    },

    // Konfigurator 4c: ONE sales order row for the färdigdatumsförslag — the
    // service dates a configured row's TO from the row itself (its supply is
    // not interchangeable with other configurations' units, so the pooled
    // coverage in findFirmDemand does not apply). null = no such row.
    async salesOrderRowForDueDate(rowId: string) {
      const [row] = await db
        .select({
          rowId: salesOrderRows.id,
          articleId: salesOrderRows.articleId,
          salesOrderId: salesOrders.id,
          orderNumber: salesOrders.orderNumber,
          orderStatus: salesOrders.status,
          expectedDeliveryDate: salesRowDeliveryDate,
          customerDelivery: {
            deliveryWeekdays: customers.deliveryWeekdays,
            deliveryDayMode: customers.deliveryDayMode,
            transitDays: customers.transitDays,
          },
          configured: sql<boolean>`${salesOrderRows.configuration} is not null`,
          // Skapa ordrar derives the configured TO's lead time from the row's
          // own configuration (requirements-dating.ts configuredLeadDays).
          configuration: salesOrderRows.configuration,
          quantityOrdered: salesOrderRows.quantityOrdered,
          quantityDelivered: salesOrderRows.quantityDelivered,
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(eq(salesOrderRows.id, rowId));
      return row
        ? {
            ...row,
            configuration: row.configuration as OrderRowConfiguration | null,
            quantityOrdered: Number(row.quantityOrdered),
            quantityDelivered: Number(row.quantityDelivered),
          }
        : null;
    },

    // Server-side reload of the lego operations behind subcontract proposals
    // (never trust client-carried supplier/prices) — same idea as
    // primarySuppliersForArticles for purchase proposals.
    async legoOperationsForIds(moOperationIds: string[]) {
      if (moOperationIds.length === 0) return [];
      return legoOperations(moOperationIds);
    },

    // Beläggning (E2) — one set-based batch; the pure calc owns all rules.
    // Holidays are only needed inside the visible week horizon. `dbc` lets
    // Planera, Flytta and the planning of a new TO read the load inside
    // their own transaction, AFTER the production_plan lock (the same
    // Db | Tx widening as loadDeliveryContext).
    async loadCapacityInput(
      holidayFrom: string,
      holidayTo: string,
      dbc: Db | Tx = db,
      // The TO list's plan summary: only these orders' operations (the
      // calendars are loaded as usual — the finish day needs them).
      // `resources` (#15, the readers that suggest: Beläggning, Planera's
      // answer, the TO card): each operation's possible resources
      // (mo_operation_resources) and, for an operation that has them,
      // whether it is rörd (operationTouchedSql) — two more set-based
      // queries in the same batch, never per operation.
      opts: { orderIds?: string[]; resources?: boolean } = {}
    ): Promise<CapacityInput> {
      const openOrders = inArray(manufacturingOrders.status, ["released", "in_progress"]);
      const orderFilter = opts.orderIds ? and(openOrders, inArray(manufacturingOrders.id, opts.orderIds)) : openOrders;
      const hasResources = sql`EXISTS (SELECT 1 FROM mo_operation_resources has_r WHERE has_r.mo_operation_id = "mo_operations"."id")`;
      const [
        workCenterRows,
        groupRows,
        operationRows,
        weekDayRows,
        dayRows,
        breakRows,
        holidayRows,
        planRows,
        timeOnResources,
        resourceRows,
        touchedRows,
      ] = await Promise.all([
        dbc
          .select({
            workCenterId: workCenters.id,
            code: workCenters.code,
            name: workCenters.name,
            type: workCenters.type,
            productionGroupId: workCenters.productionGroupId,
            weekScheduleId: workCenters.weekScheduleId,
            capacityFactor: workCenters.capacityFactor,
            hoursPerDay: workCenters.hoursPerDay,
            active: workCenters.active,
            leadTimeDays: workCenters.leadTimeDays,
          })
          .from(workCenters),
        dbc
          .select({ productionGroupId: productionGroups.id, code: productionGroups.code, name: productionGroups.name })
          .from(productionGroups),
        dbc
          .select({
            moOperationId: moOperations.id,
            manufacturingOrderId: moOperations.manufacturingOrderId,
            orderNumber: manufacturingOrders.orderNumber,
            articleNumber: articles.articleNumber,
            articleName: articles.name,
            workCenterId: moOperations.workCenterId,
            orderQuantity: manufacturingOrders.quantity,
            dueDate: manufacturingOrders.dueDate,
            sequenceNo: moOperations.sequenceNo,
            setupTime: moOperations.setupTime,
            runTimePerUnit: moOperations.runTimePerUnit,
            operationStatus: moOperations.status,
            quantityCompleted: moOperations.quantityCompleted,
            quantityScrapped: moOperations.quantityScrapped,
            planLocked: moOperations.planLocked,
            plannedAt: moOperations.plannedAt,
            resourceLocked: moOperations.resourceLocked,
          })
          .from(moOperations)
          .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
          .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
          .where(orderFilter),
        dbc
          .select({
            weekScheduleId: weekScheduleDays.weekScheduleId,
            weekday: weekScheduleDays.weekday,
            dayScheduleId: weekScheduleDays.dayScheduleId,
          })
          .from(weekScheduleDays),
        dbc
          .select({ id: daySchedules.id, startTime: daySchedules.startTime, endTime: daySchedules.endTime })
          .from(daySchedules),
        dbc
          .select({
            dayScheduleId: dayScheduleBreaks.dayScheduleId,
            type: dayScheduleBreaks.type,
            startTime: dayScheduleBreaks.startTime,
            endTime: dayScheduleBreaks.endTime,
          })
          .from(dayScheduleBreaks),
        dbc
          .select({ date: holidays.date, dayScheduleId: holidays.dayScheduleId })
          .from(holidays)
          .where(and(gte(holidays.date, holidayFrom), lte(holidays.date, holidayTo))),
        // The allocations of every open operation — the same status filter
        // as the operations, so a plan row never arrives without its row.
        dbc
          .select({
            moOperationId: moOperationPlanWeeks.moOperationId,
            monday: moOperationPlanWeeks.weekMonday,
            minutes: moOperationPlanWeeks.minutes,
          })
          .from(moOperationPlanWeeks)
          .innerJoin(moOperations, eq(moOperations.id, moOperationPlanWeeks.moOperationId))
          .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
          .where(orderFilter)
          .orderBy(moOperationPlanWeeks.weekMonday),
        operationTimeOnResources(dbc, orderFilter),
        opts.resources
          ? dbc
              .select({
                moOperationId: moOperationResources.moOperationId,
                workCenterId: moOperationResources.workCenterId,
                rank: moOperationResources.rank,
                setupTime: moOperationResources.setupTime,
                runTimePerUnit: moOperationResources.runTimePerUnit,
              })
              .from(moOperationResources)
              .innerJoin(moOperations, eq(moOperations.id, moOperationResources.moOperationId))
              .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
              .where(orderFilter)
              .orderBy(moOperationResources.moOperationId, moOperationResources.rank)
          : Promise.resolve([]),
        // Rörd is asked only of the operations with possible resources —
        // the only ones a förslag can concern.
        opts.resources
          ? dbc
              .select({ moOperationId: moOperations.id })
              .from(moOperations)
              .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
              .where(and(orderFilter, hasResources, operationTouchedSql()))
          : Promise.resolve([]),
      ]);

      const resourcesByOperation = new Map<string, OperationResourceOption[]>();
      for (const row of resourceRows) {
        const list = resourcesByOperation.get(row.moOperationId) ?? [];
        list.push({ workCenterId: row.workCenterId, rank: row.rank, setupTime: Number(row.setupTime), runTimePerUnit: Number(row.runTimePerUnit) });
        resourcesByOperation.set(row.moOperationId, list);
      }
      const touched = new Set(touchedRows.map((row) => row.moOperationId));

      const plansByOperation = new Map<string, PlannedWeek[]>();
      for (const row of planRows) {
        const list = plansByOperation.get(row.moOperationId) ?? [];
        list.push({ monday: row.monday, minutes: Number(row.minutes) });
        plansByOperation.set(row.moOperationId, list);
      }

      const breaksBySchedule = new Map<string, { type: "unpaid" | "paid"; startTime: string; endTime: string }[]>();
      for (const row of breakRows) {
        const list = breaksBySchedule.get(row.dayScheduleId) ?? [];
        list.push({ type: row.type, startTime: row.startTime, endTime: row.endTime });
        breaksBySchedule.set(row.dayScheduleId, list);
      }

      return {
        workCenters: workCenterRows.map((r) => ({
          ...r,
          capacityFactor: Number(r.capacityFactor),
          hoursPerDay: r.hoursPerDay === null ? null : Number(r.hoursPerDay),
          leadTimeDays: r.leadTimeDays === null ? null : Number(r.leadTimeDays),
        })),
        productionGroups: groupRows,
        operations: operationRows.map((r) => ({
          ...r,
          orderQuantity: Number(r.orderQuantity),
          setupTime: Number(r.setupTime),
          runTimePerUnit: Number(r.runTimePerUnit),
          quantityCompleted: r.quantityCompleted === null ? null : Number(r.quantityCompleted),
          quantityScrapped: Number(r.quantityScrapped),
          ...(timeOnResources.get(r.moOperationId) ?? NO_TIME),
          plannedWeeks: plansByOperation.get(r.moOperationId) ?? null,
          plannedAt: r.plannedAt === null ? null : r.plannedAt.toISOString(),
          ...(opts.resources
            ? { resources: resourcesByOperation.get(r.moOperationId) ?? [], touched: touched.has(r.moOperationId) }
            : {}),
        })),
        weekScheduleDays: weekDayRows,
        daySchedules: dayRows.map((r) => ({
          id: r.id,
          netMinutes: computeDayScheduleNetMinutes({
            startTime: r.startTime,
            endTime: r.endTime,
            breaks: breaksBySchedule.get(r.id) ?? [],
          }),
        })),
        holidays: holidayRows,
      };
    },

    // --- Produktionsplanering ---------------------------------------------

    // Planera, Flytta and Lås upp each run in one transaction that starts
    // with the production_plan lock (plan-lock.ts).
    transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
      return db.transaction(fn);
    },

    // Påbörjad through the terminal: operations with an open or paused stamp
    // session (nothing reported yet, but someone is on it).
    async stampedOperationIds(dbc: Db | Tx = db): Promise<Set<string>> {
      const rows = await dbc
        .selectDistinct({ moOperationId: stampSessions.moOperationId })
        .from(stampSessions)
        .where(isNull(stampSessions.stoppedAt));
      return new Set(rows.map((r) => r.moOperationId));
    },

    // The ONE writer of allocations: replaces each planned operation's weeks
    // (DELETE + INSERT) and sets the mirror columns from the WRITTEN rows
    // (start = first Monday, end = last) and planned_at; `clear` removes the
    // allocation and the mirror — and the lock, which the CHECK forbids
    // without a plan (a cleared operation is done, lego, 0 minutes or beyond
    // the horizon, where a lock means nothing). The rows are stored with two
    // decimals under CHECK minutes > 0, so the weeks are rounded here
    // (`roundPlanWeeks`): a week that rounds to 0.00 is merged into its
    // neighbour, and an operation left without rows is cleared instead —
    // whatever the engine or the reservation handed over, the write never
    // breaks the CHECK. One statement per table (the mirror as one
    // UPDATE … FROM (VALUES …) per batch) — this runs under the
    // production_plan lock, one round trip per operation would hold it for
    // every open TO. Runs inside the caller's transaction.
    async writeOperationPlans(tx: Tx, write: { plans: OperationPlan[]; clear: string[]; plannedAt: Date }): Promise<void> {
      const plans: { operationId: string; weeks: PlannedWeek[]; startWeek: string; endWeek: string }[] = [];
      const clear = new Set(write.clear);
      for (const p of write.plans) {
        const weeks = roundPlanWeeks(p.weeks);
        if (weeks.length === 0) clear.add(p.operationId);
        else plans.push({ operationId: p.operationId, weeks, startWeek: weeks[0]!.monday, endWeek: weeks[weeks.length - 1]!.monday });
      }
      const touched = [...new Set([...plans.map((p) => p.operationId), ...clear])];
      if (touched.length === 0) return;
      await tx.delete(moOperationPlanWeeks).where(inArray(moOperationPlanWeeks.moOperationId, touched));
      const rows = plans.flatMap((p) =>
        p.weeks.map((w) => ({ moOperationId: p.operationId, weekMonday: w.monday, minutes: w.minutes.toFixed(2) }))
      );
      for (const batch of chunk(rows, WRITE_BATCH)) await tx.insert(moOperationPlanWeeks).values(batch);
      for (const batch of chunk(plans, WRITE_BATCH)) {
        const values = sql.join(
          batch.map((p) => sql`(${p.operationId}::uuid, ${p.startWeek}::date, ${p.endWeek}::date)`),
          sql`, `
        );
        await tx.execute(sql`
          UPDATE ${moOperations} AS o
          SET planned_start_week = v.start_week, planned_end_week = v.end_week, planned_at = ${write.plannedAt.toISOString()}::timestamptz
          FROM (VALUES ${values}) AS v(id, start_week, end_week)
          WHERE o.id = v.id
        `);
      }
      if (clear.size > 0) {
        await tx
          .update(moOperations)
          .set({ plannedStartWeek: null, plannedEndWeek: null, planLocked: false, plannedAt: write.plannedAt })
          .where(inArray(moOperations.id, [...clear]));
      }
    },

    // Flytta / Lås upp: the operation as the plan sees it, with what decides
    // whether it can be planned (its own status, the resource type, the
    // order's status). Read under the lock.
    async planOperation(opId: string, dbc: Db | Tx = db) {
      const [row] = await dbc
        .select({
          moOperationId: moOperations.id,
          manufacturingOrderId: moOperations.manufacturingOrderId,
          orderNumber: manufacturingOrders.orderNumber,
          orderStatus: manufacturingOrders.status,
          sequenceNo: moOperations.sequenceNo,
          operationStatus: moOperations.status,
          workCenterType: workCenters.type,
          workCenterCode: workCenters.code,
          plannedStartWeek: moOperations.plannedStartWeek,
          plannedEndWeek: moOperations.plannedEndWeek,
          planLocked: moOperations.planLocked,
        })
        .from(moOperations)
        .innerJoin(manufacturingOrders, eq(manufacturingOrders.id, moOperations.manufacturingOrderId))
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .where(eq(moOperations.id, opId));
      return row ?? null;
    },

    async setOperationLock(tx: Tx, opId: string, locked: boolean) {
      const [row] = await tx
        .update(moOperations)
        .set({ planLocked: locked })
        .where(eq(moOperations.id, opId))
        .returning({
          plannedStartWeek: moOperations.plannedStartWeek,
          plannedEndWeek: moOperations.plannedEndWeek,
          planLocked: moOperations.planLocked,
        });
      return row ?? null;
    },

    // Order creation only: the staffel is loaded here, not for the whole
    // requirements run (the MRP nets quantities, never prices).
    async primarySuppliersForArticles(articleIds: string[], dbc: Db | Tx = db): Promise<PrimarySupplierWithBreaks[]> {
      if (articleIds.length === 0) return [];
      const rows = await primarySuppliersFor(articleIds, dbc);
      const breaks = await loadPriceBreaks(dbc, rows.map((r) => r.rowId));
      return rows.map((r) => ({ ...r, priceBreaks: breaks.get(r.rowId) ?? [] }));
    },

    async articleInfoForIds(articleIds: string[]): Promise<PlanningArticleInfo[]> {
      if (articleIds.length === 0) return [];
      return db
        .select({ articleId: articles.id, articleNumber: articles.articleNumber })
        .from(articles)
        .where(inArray(articles.id, articleIds));
    },

    // Fasta leveransdagar: the system defaults + full-day holidays in the
    // window — the service moves sales order dates to the ship date with it.
    async deliveryContext(window: { from: string; to: string }, dbc: Db | Tx = db) {
      return loadDeliveryContext(dbc, window);
    },

    // Orimligt mycket tid — the planner's limit, read in the run's transaction.
    async longOperationWeeks(dbc: Db | Tx = db) {
      return loadLongOperationWeeks(dbc);
    },

    // Färdigdatumsförslag: the holiday register's full days off in [from, to]
    // — a holiday WITH a day schedule is a shortened working day, not off.
    // `dbc`: Skapa saknade halvfabrikat reads under the plan lock in its own
    // transaction.
    async fullDayHolidaysBetween(from: string, to: string, dbc: Db | Tx = db): Promise<string[]> {
      const rows = await dbc
        .select({ date: holidays.date })
        .from(holidays)
        .where(and(gte(holidays.date, from), lte(holidays.date, to), isNull(holidays.dayScheduleId)));
      return rows.map((r) => r.date);
    },

    // Pegging (#9): the parents a coverage is computed for — the TO heads
    // (with the article number, for the notes) and, per TO, the component
    // articles of its material rows with rest (the overview's mo_material
    // rows). Only a released/in-progress TO has a material table, so a
    // planned (legacy) TO gets none — the service treats it as closed.
    // Unknown ids are absent. Two set-based queries, never per order.
    async coverageParents(orderIds: string[], dbc: Db | Tx = db): Promise<CoverageParentsLoad> {
      const ids = [...new Set(orderIds)];
      const empty: CoverageParentsLoad = { orders: [], materialComponents: new Map() };
      if (ids.length === 0) return empty;
      // One query at a time, like loadAll — keep the reads sequential inside
      // the transaction (Skapa saknade halvfabrikat runs this under the plan
      // lock).
      const orders = await dbc
        .select({
          id: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          status: manufacturingOrders.status,
          articleId: manufacturingOrders.articleId,
          articleNumber: articles.articleNumber,
          quantity: manufacturingOrders.quantity,
          dueDate: manufacturingOrders.dueDate,
        })
        .from(manufacturingOrders)
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .where(inArray(manufacturingOrders.id, ids));
      const materials = await dbc
        .select({
          manufacturingOrderId: moMaterialConsumptions.manufacturingOrderId,
          componentArticleId: moMaterialConsumptions.componentArticleId,
        })
        .from(moMaterialConsumptions)
        .where(
          and(
            inArray(moMaterialConsumptions.manufacturingOrderId, ids),
            sql`${moMaterialConsumptions.quantityPlanned} > ${moMaterialConsumptions.quantityConsumed}`
          )
        );
      const materialComponents = new Map<string, string[]>();
      for (const m of materials) {
        const list = materialComponents.get(m.manufacturingOrderId) ?? [];
        if (!list.includes(m.componentArticleId)) list.push(m.componentArticleId);
        materialComponents.set(m.manufacturingOrderId, list);
      }
      return { orders: orders.map((o) => ({ ...o, quantity: Number(o.quantity) })), materialComponents };
    },

    // The phantom articles — with loadBomEdges the whole demand structure an
    // in-memory explosion needs (Skapa saknade halvfabrikat).
    async phantomArticleIds(dbc: Db | Tx = db): Promise<string[]> {
      const rows = await dbc.select({ id: articles.id }).from(articles).where(eq(articles.isPhantom, true));
      return rows.map((r) => r.id);
    },

    // Just the BOM edges — Skapa ordrar orders its TO proposals parents first
    // without loading the whole MRP input.
    async loadBomEdges(dbc: Db | Tx = db): Promise<{ parentArticleId: string; componentArticleId: string; quantity: number }[]> {
      const rows = await dbc
        .select({
          parentArticleId: bomComponents.parentArticleId,
          componentArticleId: bomComponents.componentArticleId,
          quantity: bomComponents.quantity,
        })
        .from(bomComponents)
        .where(DEMAND_BOM_ROWS);
      return rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));
    },

    // --- Leveranstidskontroll -------------------------------------------

    // The order a check is run for: its customer and open rows (restantal
    // and configuration). null = no such order.
    async deliveryCheckOrder(salesOrderId: string, dbc: Db | Tx = db) {
      const [order] = await dbc
        .select({ id: salesOrders.id, orderNumber: salesOrders.orderNumber, customerId: salesOrders.customerId, status: salesOrders.status })
        .from(salesOrders)
        .where(eq(salesOrders.id, salesOrderId));
      if (!order) return null;
      const rows = await dbc
        .select({
          rowId: salesOrderRows.id,
          articleId: salesOrderRows.articleId,
          quantityOrdered: salesOrderRows.quantityOrdered,
          quantityDelivered: salesOrderRows.quantityDelivered,
          configuration: salesOrderRows.configuration,
        })
        .from(salesOrderRows)
        .where(eq(salesOrderRows.salesOrderId, salesOrderId));
      // The TOs linked to the configured rows (a configured row's template
      // has no pool, so its own TOs are netted by uncoveredConfiguredQuantity
      // in the service — an ordinary row's linked TO is supply in the
      // article overview). Cancelled ones count for nothing, as everywhere.
      const configuredRowIds = rows.filter((r) => r.configuration !== null).map((r) => r.rowId);
      const linked =
        configuredRowIds.length === 0
          ? []
          : await dbc
              .select({
                rowId: manufacturingOrders.salesOrderRowId,
                id: manufacturingOrders.id,
                orderNumber: manufacturingOrders.orderNumber,
                status: manufacturingOrders.status,
                quantity: manufacturingOrders.quantity,
                received: manufacturingOrders.quantityReceived,
                dueDate: manufacturingOrders.dueDate,
              })
              .from(manufacturingOrders)
              .where(and(inArray(manufacturingOrders.salesOrderRowId, configuredRowIds), ne(manufacturingOrders.status, "cancelled")))
              .orderBy(manufacturingOrders.orderNumber);
      const linkedByRow = new Map<
        string,
        { id: string; orderNumber: string; status: string; quantity: number; received: number; dueDate: string | null }[]
      >();
      for (const l of linked) {
        if (!l.rowId) continue;
        linkedByRow.set(l.rowId, [
          ...(linkedByRow.get(l.rowId) ?? []),
          { id: l.id, orderNumber: l.orderNumber, status: l.status, quantity: Number(l.quantity), received: Number(l.received), dueDate: l.dueDate },
        ]);
      }
      return {
        ...order,
        rows: rows.map((r) => ({
          rowId: r.rowId,
          articleId: r.articleId,
          quantityOrdered: Number(r.quantityOrdered),
          quantityDelivered: Number(r.quantityDelivered),
          rest: Math.max(Number(r.quantityOrdered) - Number(r.quantityDelivered), 0),
          configuration: r.configuration as OrderRowConfiguration | null,
          linkedOrders: linkedByRow.get(r.rowId) ?? [],
        })),
      };
    },

    // Reservationen: the plans of a new TO's operations are locked (Planera
    // keeps them — the promised date holds until Lås upp). Only operations
    // with a plan: the CHECK forbids a lock without one, and a lego or
    // 0-minute operation has none. Runs in the reservation's transaction.
    async lockOrderPlans(tx: Tx, manufacturingOrderId: string): Promise<number> {
      const rows = await tx
        .update(moOperations)
        .set({ planLocked: true })
        .where(and(eq(moOperations.manufacturingOrderId, manufacturingOrderId), isNotNull(moOperations.plannedStartWeek)))
        .returning({ id: moOperations.id });
      return rows.length;
    },

    async customerDeliveryFields(customerId: string, dbc: Db | Tx = db) {
      const [row] = await dbc
        .select({
          deliveryWeekdays: customers.deliveryWeekdays,
          deliveryDayMode: customers.deliveryDayMode,
          transitDays: customers.transitDays,
        })
        .from(customers)
        .where(eq(customers.id, customerId));
      return row ?? null;
    },

    // Articles in the checked tree, with their configurator mode (null = not
    // a template).
    async deliveryCheckArticles(articleIds: string[], dbc: Db | Tx = db) {
      if (articleIds.length === 0) return [];
      const rows = await dbc
        .select({
          articleId: articles.id,
          articleNumber: articles.articleNumber,
          name: articles.name,
          type: articles.type,
          isPhantom: articles.isPhantom,
          rounding: articles.rounding,
          configuratorMode: configuratorTemplates.mode,
        })
        .from(articles)
        .leftJoin(configuratorTemplates, eq(configuratorTemplates.articleId, articles.id))
        .where(inArray(articles.id, articleIds));
      return rows.map((r) => ({ ...r, rounding: r.rounding === null ? null : Number(r.rounding) }));
    },

    // Worked operations only — Kalkyl (costing-only) operations never reach
    // a TO, so they take no capacity.
    async routingsForArticles(articleIds: string[], dbc: Db | Tx = db) {
      if (articleIds.length === 0) return [];
      const rows = await dbc
        .select({
          id: routingOperations.id,
          articleId: routingOperations.articleId,
          sequenceNo: routingOperations.sequenceNo,
          workCenterId: routingOperations.workCenterId,
          description: routingOperations.description,
          setupTime: routingOperations.setupTime,
          runTimePerUnit: routingOperations.runTimePerUnit,
        })
        .from(routingOperations)
        .where(and(inArray(routingOperations.articleId, articleIds), eq(routingOperations.costingOnly, false)));
      return rows.map((r) => ({ ...r, setupTime: Number(r.setupTime), runTimePerUnit: Number(r.runTimePerUnit) }));
    },

    // Alternativa resurser (#15, etapp 3) for Leveranstidskontrollen: the
    // alternatives of these routing rows as the TO's snapshot would take them
    // (snapshotOperationResourcesInTx): a row that is worked (not Kalkyl) on
    // an own ordinarie, the alternative's resource active and not lego and
    // never the ordinarie, in rank order. The times are raw (null = som
    // ordinarie) — the caller resolves them against the operation's own, as
    // the snapshot does; `ordinaryWorkCenterId` lets it apply them only to
    // an operation still on the row's ordinarie (a configured row's base
    // operation).
    async routingAlternatives(routingOperationIds: string[], dbc: Db | Tx = db) {
      if (routingOperationIds.length === 0) return [];
      const rows = await dbc.execute<{
        routing_operation_id: string;
        ordinary_work_center_id: string;
        work_center_id: string;
        setup_time: string | null;
        run_time_per_unit: string | null;
      }>(sql`
        SELECT a.routing_operation_id, ro.work_center_id AS ordinary_work_center_id, a.work_center_id,
          a.setup_time::text AS setup_time, a.run_time_per_unit::text AS run_time_per_unit
        FROM routing_operation_alternatives a
        JOIN routing_operations ro ON ro.id = a.routing_operation_id AND NOT ro.costing_only
        JOIN work_centers owc ON owc.id = ro.work_center_id AND owc.type <> 'subcontract'
        JOIN work_centers w ON w.id = a.work_center_id AND w.active AND w.type <> 'subcontract'
        WHERE a.routing_operation_id IN (${sql.join(
          routingOperationIds.map((id) => sql`${id}::uuid`),
          sql`, `
        )})
          AND a.work_center_id <> ro.work_center_id
        ORDER BY a.routing_operation_id, a.rank`);
      return [...rows].map((r) => ({
        routingOperationId: r.routing_operation_id,
        ordinaryWorkCenterId: r.ordinary_work_center_id,
        workCenterId: r.work_center_id,
        setupTime: r.setup_time === null ? null : Number(r.setup_time),
        runTimePerUnit: r.run_time_per_unit === null ? null : Number(r.run_time_per_unit),
      }));
    },

    // The reservation (#15): the possible resources of one TO's operations
    // (mo_operation_resources) with their times — what a given plan's
    // resource is matched against.
    async orderOperationResources(tx: Tx, manufacturingOrderId: string) {
      return tx
        .select({
          moOperationId: moOperationResources.moOperationId,
          workCenterId: moOperationResources.workCenterId,
          setupTime: moOperationResources.setupTime,
          runTimePerUnit: moOperationResources.runTimePerUnit,
        })
        .from(moOperationResources)
        .innerJoin(moOperations, eq(moOperations.id, moOperationResources.moOperationId))
        .where(eq(moOperations.manufacturingOrderId, manufacturingOrderId));
    },

    // The reservation (#15): the switch to the alternatives the check chose,
    // through the leaf's ONE switch writer (resource and the row's times,
    // Vald för hand, plan_locked cleared). Returns the ids switched.
    async switchOperationResources(tx: Tx, switches: ResourceSwitch[]): Promise<string[]> {
      return switchOperationResourcesInTx(tx, switches);
    },

    // The reservation's händelselogg (#15): the operations of a TO it put on
    // an alternative, read back from what was written — Vald för hand on a
    // resource other than the beredning's ordinarie (rank 0).
    async orderResourceSwitches(tx: Tx, manufacturingOrderId: string) {
      const rows = await tx.execute<{ sequence_no: number; from_id: string; from_code: string; to_id: string; to_code: string }>(sql`
        SELECT o.sequence_no, r0.work_center_id AS from_id, fw.code AS from_code, o.work_center_id AS to_id, tw.code AS to_code
        FROM mo_operations o
        JOIN mo_operation_resources r0 ON r0.mo_operation_id = o.id AND r0.rank = 0
        JOIN work_centers fw ON fw.id = r0.work_center_id
        JOIN work_centers tw ON tw.id = o.work_center_id
        WHERE o.manufacturing_order_id = ${manufacturingOrderId} AND o.resource_locked AND o.work_center_id <> r0.work_center_id
        ORDER BY o.sequence_no`);
      return [...rows].map((r) => ({
        sequenceNo: Number(r.sequence_no),
        fromWorkCenterId: r.from_id,
        fromCode: r.from_code,
        toWorkCenterId: r.to_id,
        toCode: r.to_code,
      }));
    },

    // Legoresurser's lead time in days (Monitor's Lego export).
    async workCenterLeadTimes(dbc: Db | Tx = db) {
      const rows = await dbc
        .select({ workCenterId: workCenters.id, leadTimeDays: workCenters.leadTimeDays })
        .from(workCenters);
      return rows.map((r) => ({ workCenterId: r.workCenterId, leadTimeDays: r.leadTimeDays === null ? null : Number(r.leadTimeDays) }));
    },

    // The variant already made for (template, configuration key), if any.
    async findVariantByKey(templateArticleId: string, configKey: string, dbc: Db | Tx = db): Promise<string | null> {
      const [row] = await dbc
        .select({ articleId: configuratorVariants.articleId })
        .from(configuratorVariants)
        .where(and(eq(configuratorVariants.templateArticleId, templateArticleId), eq(configuratorVariants.configKey, configKey)));
      return row?.articleId ?? null;
    },
  };
}

export type PlanningRepository = ReturnType<typeof createPlanningRepository>;
