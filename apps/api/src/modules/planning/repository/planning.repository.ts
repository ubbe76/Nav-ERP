import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import {
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
  moOperations,
  productionGroups,
  purchaseOrderRows,
  purchaseOrders,
  routingOperations,
  salesOrderRows,
  salesOrders,
  stampSessions,
  stockBalances,
  suppliers,
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
import { loadPriceBreaks } from "../../purchase/repository/price-breaks.js";
import type { CapacityInput, PlannedWeek } from "../service/capacity-calc.js";
import type { OperationPlan } from "../service/production-plan.js";
import { roundPlanWeeks } from "../service/capacity-book.js";
import type { ArticleOverviewInput } from "../service/article-overview.js";
import { loadDeliveryContext } from "../../system/repository/delivery-context.js";
import { loadLongOperationWeeks } from "../../system/repository/plan-settings.js";
import { purchaseRowArrivalDate, salesRowDeliveryDate } from "./effective-dates.js";

export interface PlanningArticleInfo {
  articleId: string;
  articleNumber: string;
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
        workCenterName: workCenters.name,
        orderQuantity: manufacturingOrders.quantity,
        // Correlation must be table-qualified explicitly — see the
        // workCenterCount subquery note in manufacturing.repository.ts.
        orderedQuantity: sql<string>`coalesce((select sum(por.quantity_ordered) from ${purchaseOrderRows} por join ${purchaseOrders} po on po.id = por.purchase_order_id where por.mo_operation_id = ${moOperations}.id and po.status <> 'cancelled'), 0)`,
        supplierId: moOperations.subcontractSupplierId,
        supplierName: suppliers.name,
        setupPrice: moOperations.setupPrice,
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
      (r): LegoOperationRow => ({
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
        workCenterName: r.workCenterName,
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

  return {
    // One set-based query per source; all business rules (which statuses are
    // demand/supply, netting, cascade) live in the pure calc.
    async loadRequirementsInput(): Promise<RequirementsInput> {
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
            })
            .from(salesOrderRows)
            .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
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
              articleId: manufacturingOrders.articleId,
              status: manufacturingOrders.status,
              // Supply is what is still to come: units already received
              // (delinleverans) are on hand and must not count twice.
              quantity: moRemainingQuantity,
              // Konfigurator 4c: a configured TO has its own material rows.
              configured: sql<boolean>`${manufacturingOrders.configuration} is not null`,
            })
            .from(manufacturingOrders)
            .where(inArray(manufacturingOrders.status, OPEN_MO)),
          db
            .select({
              componentArticleId: moMaterialConsumptions.componentArticleId,
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
          db
            .select({
              articleId: stockBalances.articleId,
              quantity: sql<string>`sum(${stockBalances.quantityOnHand})`,
            })
            .from(stockBalances)
            .groupBy(stockBalances.articleId),
          db
            .select({
              parentArticleId: bomComponents.parentArticleId,
              componentArticleId: bomComponents.componentArticleId,
              quantity: bomComponents.quantity,
            })
            .from(bomComponents),
          primarySuppliersFor(),
          legoOperations(),
        ]);

      return {
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
          configuratorMode: r.configuratorMode,
        })),
        salesRows: salesRows.map((r) => ({
          articleId: r.articleId,
          orderStatus: r.orderStatus,
          quantityOrdered: Number(r.quantityOrdered),
          quantityDelivered: Number(r.quantityDelivered),
        })),
        purchaseRows: purchaseRows.map((r) => ({
          articleId: r.articleId,
          orderStatus: r.orderStatus,
          quantityOrdered: Number(r.quantityOrdered),
          quantityReceived: Number(r.quantityReceived),
        })),
        manufacturingOrders: moRows.map((r) => ({
          articleId: r.articleId,
          status: r.status,
          quantity: Number(r.quantity),
          configured: r.configured,
        })),
        moMaterialRows: materialRows.map((r) => ({
          componentArticleId: r.componentArticleId,
          orderStatus: r.orderStatus,
          quantityPlanned: Number(r.quantityPlanned),
          quantityConsumed: Number(r.quantityConsumed),
        })),
        stock: stockRows.map((r) => ({ articleId: r.articleId, quantity: Number(r.quantity) })),
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
        })
        .from(manufacturingOrders)
        .where(
          inArray(
            manufacturingOrders.salesOrderRowId,
            rows.map((r) => r.rowId)
          )
        );
      const byRow = new Map<string, { status: string; quantity: number }[]>();
      for (const l of linked) {
        if (!l.rowId) continue;
        const list = byRow.get(l.rowId) ?? [];
        list.push({ status: l.status, quantity: Number(l.quantity) });
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
    async loadArticleOverviewInput(articleId: string, dbc: Db | Tx = db): Promise<ArticleOverviewInput | null> {
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
    async loadArticleOverviewInputs(articleIds: string[], dbc: Db | Tx = db): Promise<Map<string, ArticleOverviewInput>> {
      const result = new Map<string, ArticleOverviewInput>();
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
        })
        .from(articles)
        .innerJoin(units, eq(units.id, articles.unitId))
        .where(inArray(articles.id, ids));
      if (articleRows.length === 0) return result;

      const [stockRows, salesRows, purchaseRows, moRows, materialRows, plannedRows, bomEdges, phantomRows, primary] =
        await Promise.all([
          dbc
            .select({
              articleId: stockBalances.articleId,
              quantity: sql<string>`coalesce(sum(${stockBalances.quantityOnHand}), 0)`,
            })
            .from(stockBalances)
            .where(inArray(stockBalances.articleId, ids))
            .groupBy(stockBalances.articleId),
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
            .from(bomComponents),
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
      const stockByArticle = new Map(stockRows.map((r) => [r.articleId, Number(r.quantity)]));
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
          },
          onHand: stockByArticle.get(article.articleId) ?? 0,
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
        })
        .from(salesOrderRows)
        .innerJoin(salesOrders, eq(salesOrders.id, salesOrderRows.salesOrderId))
        .innerJoin(customers, eq(customers.id, salesOrders.customerId))
        .where(eq(salesOrderRows.id, rowId));
      return row ?? null;
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
      opts: { orderIds?: string[] } = {}
    ): Promise<CapacityInput> {
      const openOrders = inArray(manufacturingOrders.status, ["released", "in_progress"]);
      const orderFilter = opts.orderIds ? and(openOrders, inArray(manufacturingOrders.id, opts.orderIds)) : openOrders;
      const [workCenterRows, groupRows, operationRows, weekDayRows, dayRows, breakRows, holidayRows, planRows] =
        await Promise.all([
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
        ]);

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
          plannedWeeks: plansByOperation.get(r.moOperationId) ?? null,
          plannedAt: r.plannedAt === null ? null : r.plannedAt.toISOString(),
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
    async fullDayHolidaysBetween(from: string, to: string): Promise<string[]> {
      const rows = await db
        .select({ date: holidays.date })
        .from(holidays)
        .where(and(gte(holidays.date, from), lte(holidays.date, to), isNull(holidays.dayScheduleId)));
      return rows.map((r) => r.date);
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
        .from(bomComponents);
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
                dueDate: manufacturingOrders.dueDate,
              })
              .from(manufacturingOrders)
              .where(and(inArray(manufacturingOrders.salesOrderRowId, configuredRowIds), ne(manufacturingOrders.status, "cancelled")))
              .orderBy(manufacturingOrders.orderNumber);
      const linkedByRow = new Map<string, { id: string; orderNumber: string; status: string; quantity: number; dueDate: string | null }[]>();
      for (const l of linked) {
        if (!l.rowId) continue;
        linkedByRow.set(l.rowId, [
          ...(linkedByRow.get(l.rowId) ?? []),
          { id: l.id, orderNumber: l.orderNumber, status: l.status, quantity: Number(l.quantity), dueDate: l.dueDate },
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
