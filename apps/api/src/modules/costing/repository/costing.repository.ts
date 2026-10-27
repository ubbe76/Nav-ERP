import { and, asc, desc, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";
import { legoOneOffSql } from "../../manufacturing/repository/lego-one-off.js";
import { alias } from "drizzle-orm/pg-core";
import {
  articleSuppliers,
  articles,
  bomComponents,
  stockTransactions,
  costCalculationMaterialRows,
  costCalculationOperationRows,
  costCalculations,
  manufacturingOrders,
  moMaterialConsumptions,
  moOperations,
  purchaseOrderRows,
  purchaseOrders,
  routingOperations,
  timeReports,
  units,
  workCenters,
  type Db,
} from "@navet/db";
import type { CostCalculationType, CostingMaterialSource, CostMaterialRowKind, CostPriceSource } from "@navet/shared";
import { explodeBom } from "../../article/service/bom-explosion.js";
import { weightedActualCosts } from "../service/actual-cost.js";
import { loadPriceBreaks } from "../../purchase/repository/price-breaks.js";

// At most one row per article thanks to the article_suppliers_one_primary
// partial unique index, so this join never fans out.
const primarySupplierJoin = and(eq(articleSuppliers.articleId, articles.id), eq(articleSuppliers.isPrimary, true));

// The specification rows the service hands over, in numbers — the repository
// stringifies them for the numeric columns.
export interface MaterialRowWrite {
  componentArticleId: string;
  kind: CostMaterialRowKind;
  quantity: number;
  unitId: string | null;
  unitFactor: string | null;
  unitCost: number;
  priceSource: CostPriceSource;
  amount: number;
  // TO lifted up from a sub-assembly costed from its own structure (kind
  // "semi"): TO is outside TVK, so it cannot ride inside `amount`. Feeds the
  // header's overhead bucket together with the operation rows' TO. 0 on
  // material/lego rows.
  overheadAmount: number;
  // Materialpåslag lifted up from a "semi" row's sub-calculation, the same
  // way as overheadAmount. 0 on material/lego rows.
  materialMarkupAmount: number;
}

export interface OperationRowWrite {
  sequenceNo: number;
  workCenterId: string;
  hours: number;
  setupHours: number | null;
  hourlyRate: number;
  overheadPercent: number;
  laborAmount: number;
  overheadAmount: number;
  // Lego operation (subcontract work center): setupPrice + unitPrice × qty,
  // feeding subcontractCost (LO markup). Null on time-priced rows.
  subcontractAmount: number | null;
}

// The calculation header the service hands over — plain numbers; the
// repository stringifies them for the numeric columns. Exported so the service
// can compute the header first and decide afterwards whether to save it.
export interface CostCalculationWrite {
  articleId: string;
  manufacturingOrderId: string | null;
  quantity: number;
  materialCost: number;
  materialOverhead: number;
  laborCost: number;
  overhead: number;
  subcontractCost: number;
  subcontractOverhead: number;
  semiFinishedCost: number;
  businessOverhead: number;
  generalMarkup: number;
  materialMarkup: number;
  salesPrice: number;
  materialSource: CostingMaterialSource;
  multiLevel: boolean;
  moPercent: number;
  loPercent: number;
  affoPercent: number;
  generalMarkupPercent: number;
  materialMarkupPercent: number;
  type: CostCalculationType;
}

export function createCostingRepository(db: Db) {
  return {
    async findArticleById(id: string) {
      const [row] = await db.select().from(articles).where(eq(articles.id, id));
      return row ?? null;
    },

    async findManufacturingOrderById(id: string) {
      const [row] = await db.select().from(manufacturingOrders).where(eq(manufacturingOrders.id, id));
      return row ?? null;
    },

    // Phantom BOM components are resolved past into their own components
    // (quantities multiplied down the chain) — see bom-explosion.ts.
    async explodeBom(articleId: string, quantity: number) {
      return explodeBom(db, articleId, quantity);
    },

    // Cost basis for the exploded components: the article's own standard cost
    // plus its primary supplier's price. Which one is used is the service's
    // call (System → Kalkyler), and `type` splits direct material from lego.
    //
    // hasBom/hasRouting tell a multi-level run whether a manufactured component
    // can be costed from its own structure at all. They are EXISTS subqueries,
    // deliberately NOT joins: joining bom_components would fan the row out once
    // per structure line and silently multiply the component's material cost.
    // (primarySupplierJoin above is safe only because of the
    // article_suppliers_one_primary partial unique index.)
    async getComponentCostBasis(articleIds: string[]) {
      if (articleIds.length === 0) return [];
      const rows = await db
        .select({
          id: articles.id,
          type: articles.type,
          standardCost: articles.standardCost,
          supplierRowId: articleSuppliers.id,
          supplierPrice: articleSuppliers.price,
          hasBom: sql<boolean>`exists (select 1 from ${bomComponents} bc where bc.parent_article_id = ${articles.id})`,
          hasRouting: sql<boolean>`exists (select 1 from ${routingOperations} ro where ro.article_id = ${articles.id})`,
        })
        .from(articles)
        .leftJoin(articleSuppliers, primarySupplierJoin)
        .where(inArray(articles.id, articleIds));
      // Stafflade leverantörspriser — one batched load for the primary rows.
      const breaks = await loadPriceBreaks(
        db,
        rows.map((r) => r.supplierRowId).filter((id): id is string => id !== null)
      );
      return rows.map(({ supplierRowId, ...r }) => ({
        ...r,
        supplierPriceBreaks: supplierRowId ? (breaks.get(supplierRowId) ?? []) : [],
      }));
    },

    // Display data + the phantom flag for a derived structure's components
    // (configurator pre-costing): the structure is not stored in bom_components,
    // so the service resolves phantoms and labels rows from these.
    async getArticleLabels(articleIds: string[]) {
      if (articleIds.length === 0) return [];
      return db
        .select({ id: articles.id, articleNumber: articles.articleNumber, name: articles.name, isPhantom: articles.isPhantom })
        .from(articles)
        .where(inArray(articles.id, articleIds));
    },

    // The work-center side of RoutingRow, for a derived route that is not
    // stored in routing_operations either.
    async getWorkCentersForCosting(ids: string[]) {
      if (ids.length === 0) return [];
      return db
        .select({
          id: workCenters.id,
          name: workCenters.name,
          type: workCenters.type,
          hourlyRate: workCenters.hourlyRate,
          overheadPercent: workCenters.overheadPercent,
        })
        .from(workCenters)
        .where(inArray(workCenters.id, ids));
    },

    async getRoutingWithWorkCenters(articleId: string) {
      return db
        .select({
          sequenceNo: routingOperations.sequenceNo,
          setupTime: routingOperations.setupTime,
          runTimePerUnit: routingOperations.runTimePerUnit,
          workCenterId: workCenters.id,
          workCenterName: workCenters.name,
          workCenterType: workCenters.type,
          hourlyRate: workCenters.hourlyRate,
          overheadPercent: workCenters.overheadPercent,
          // Lego operation pricing (subcontract work centers only); the
          // one-off is Ställpris + Transportkostnad.
          setupPrice: legoOneOffSql(routingOperations),
          unitPrice: routingOperations.unitPrice,
        })
        .from(routingOperations)
        .innerJoin(workCenters, eq(workCenters.id, routingOperations.workCenterId))
        .where(eq(routingOperations.articleId, articleId))
        .orderBy(asc(routingOperations.sequenceNo));
    },

    async getMaterialConsumptionsWithCost(manufacturingOrderId: string) {
      const rows = await db
        .select({
          componentArticleId: moMaterialConsumptions.componentArticleId,
          quantityConsumed: moMaterialConsumptions.quantityConsumed,
          unitId: moMaterialConsumptions.unitId,
          unitFactor: moMaterialConsumptions.unitFactor,
          name: articles.name,
          type: articles.type,
          standardCost: articles.standardCost,
          supplierRowId: articleSuppliers.id,
          supplierPrice: articleSuppliers.price,
        })
        .from(moMaterialConsumptions)
        .innerJoin(articles, eq(articles.id, moMaterialConsumptions.componentArticleId))
        .leftJoin(articleSuppliers, primarySupplierJoin)
        .where(eq(moMaterialConsumptions.manufacturingOrderId, manufacturingOrderId));
      const breaks = await loadPriceBreaks(
        db,
        rows.map((r) => r.supplierRowId).filter((id): id is string => id !== null)
      );
      return rows.map(({ supplierRowId, ...r }) => ({
        ...r,
        supplierPriceBreaks: supplierRowId ? (breaks.get(supplierRowId) ?? []) : [],
      }));
    },

    // Verklig kostnad (System → Kalkyler) — what the material a manufacturing
    // order consumed ACTUALLY cost, per component article.
    //
    // mo_material_consumptions cannot answer this: its created_at is when the
    // row was snapshotted at release, and quantity_consumed is an accumulating
    // total. The real events are the stock_transactions the consumption wrote
    // (type mo_consumption, reference_id = the MO), which carry both the moment
    // and the quantity — the log is the record, exactly as it is for quantities.
    //
    // D0 stamps unit_cost on INFLOWS only, so an outflow's cost has to be
    // derived: the moving average as of that moment, replayed with the same
    // pure computeMovingAverage the valuation report (D1) stands on. Two
    // queries total, then the arithmetic happens in memory.
    //
    // A component drawn at two different operations shares one figure: the
    // stock log records the MO, not the operation, so the result is the
    // quantity-weighted average across the order's draws of that article.
    async getConsumptionMovingAverageCosts(manufacturingOrderId: string) {
      const draws = await db
        .select({
          articleId: stockTransactions.articleId,
          quantityDelta: stockTransactions.quantityDelta,
          createdAt: stockTransactions.createdAt,
          id: stockTransactions.id,
        })
        .from(stockTransactions)
        .where(
          and(
            eq(stockTransactions.transactionType, "mo_consumption"),
            eq(stockTransactions.referenceId, manufacturingOrderId)
          )
        );
      if (draws.length === 0) return new Map<string, number | null>();

      const articleIds = [...new Set(draws.map((d) => d.articleId))];
      const history = await db
        .select({
          articleId: stockTransactions.articleId,
          quantityDelta: stockTransactions.quantityDelta,
          unitCost: stockTransactions.unitCost,
          createdAt: stockTransactions.createdAt,
          id: stockTransactions.id,
        })
        .from(stockTransactions)
        .where(inArray(stockTransactions.articleId, articleIds))
        // Ties on the timestamp are broken by id so the replay is
        // deterministic — a receipt and a draw booked in the same transaction
        // share createdAt to the microsecond.
        .orderBy(asc(stockTransactions.articleId), asc(stockTransactions.createdAt), asc(stockTransactions.id));

      return weightedActualCosts(draws, history);
    },

    // One row per operation with its total reported hours (0 if none reported yet).
    async getOperationsWithReportedHours(manufacturingOrderId: string) {
      return db
        .select({
          operationId: moOperations.id,
          sequenceNo: moOperations.sequenceNo,
          workCenterId: workCenters.id,
          workCenterName: workCenters.name,
          workCenterType: workCenters.type,
          hourlyRate: workCenters.hourlyRate,
          overheadPercent: workCenters.overheadPercent,
          reportedHours: sql<string>`coalesce(sum(${timeReports.hours}), 0)`,
          // Lego snapshot (post-calculation fallback when no IO is linked).
          setupPrice: legoOneOffSql(moOperations),
          unitPrice: moOperations.unitPrice,
          quantityCompleted: moOperations.quantityCompleted,
          quantityScrapped: moOperations.quantityScrapped,
        })
        .from(moOperations)
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .leftJoin(timeReports, eq(timeReports.moOperationId, moOperations.id))
        .where(eq(moOperations.manufacturingOrderId, manufacturingOrderId))
        .groupBy(moOperations.id, workCenters.id)
        .orderBy(asc(moOperations.sequenceNo));
    },

    // Actual lego cost per operation from the linked IO rows (non-cancelled
    // orders): Σ setupPrice + unitPrice × quantityReceived, each converted at
    // the order's exchange rate — the same SEK conversion the goods receipt
    // stamps on stock_transactions.unit_cost. Only rows with some receipt
    // count (an unreceived order has cost the MO nothing yet).
    async getSubcontractActualCosts(manufacturingOrderId: string) {
      const rows = await db
        .select({
          moOperationId: purchaseOrderRows.moOperationId,
          amount: sql<string>`coalesce(sum((coalesce(${purchaseOrderRows.setupPrice}, 0) + ${purchaseOrderRows.unitPrice} * ${purchaseOrderRows.quantityReceived}) * ${purchaseOrders.exchangeRate}), 0)`,
        })
        .from(purchaseOrderRows)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
        .innerJoin(moOperations, eq(moOperations.id, purchaseOrderRows.moOperationId))
        .where(
          and(
            eq(moOperations.manufacturingOrderId, manufacturingOrderId),
            ne(purchaseOrders.status, "cancelled"),
            sql`${purchaseOrderRows.quantityReceived} > 0`
          )
        )
        .groupBy(purchaseOrderRows.moOperationId);
      return new Map(rows.filter((r) => r.moOperationId !== null).map((r) => [r.moOperationId!, Number(r.amount)]));
    },

    // Header and its specification rows are written together — a calculation
    // whose rows failed to insert would claim totals it cannot account for.
    async createCostCalculation(
      input: CostCalculationWrite,
      materialRows: MaterialRowWrite[],
      operationRows: OperationRowWrite[]
    ) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(costCalculations)
          .values({
            articleId: input.articleId,
            manufacturingOrderId: input.manufacturingOrderId,
            quantity: String(input.quantity),
            materialCost: String(input.materialCost),
            materialOverhead: String(input.materialOverhead),
            laborCost: String(input.laborCost),
            overhead: String(input.overhead),
            subcontractCost: String(input.subcontractCost),
            subcontractOverhead: String(input.subcontractOverhead),
            semiFinishedCost: String(input.semiFinishedCost),
            businessOverhead: String(input.businessOverhead),
            generalMarkup: String(input.generalMarkup),
            materialMarkup: String(input.materialMarkup),
            salesPrice: String(input.salesPrice),
            materialSource: input.materialSource,
            multiLevel: input.multiLevel,
            moPercent: String(input.moPercent),
            loPercent: String(input.loPercent),
            affoPercent: String(input.affoPercent),
            generalMarkupPercent: String(input.generalMarkupPercent),
            materialMarkupPercent: String(input.materialMarkupPercent),
            type: input.type,
          })
          .returning();

        if (materialRows.length > 0) {
          await tx.insert(costCalculationMaterialRows).values(
            materialRows.map((r) => ({
              costCalculationId: row!.id,
              componentArticleId: r.componentArticleId,
              kind: r.kind,
              quantity: String(r.quantity),
              unitId: r.unitId,
              unitFactor: r.unitFactor,
              unitCost: String(r.unitCost),
              priceSource: r.priceSource,
              amount: String(r.amount),
              overheadAmount: String(r.overheadAmount),
              materialMarkupAmount: String(r.materialMarkupAmount),
            }))
          );
        }

        if (operationRows.length > 0) {
          await tx.insert(costCalculationOperationRows).values(
            operationRows.map((r) => ({
              costCalculationId: row!.id,
              sequenceNo: r.sequenceNo,
              workCenterId: r.workCenterId,
              hours: String(r.hours),
              setupHours: r.setupHours === null ? null : String(r.setupHours),
              hourlyRate: String(r.hourlyRate),
              overheadPercent: String(r.overheadPercent),
              laborAmount: String(r.laborAmount),
              overheadAmount: String(r.overheadAmount),
              subcontractAmount: r.subcontractAmount === null ? null : String(r.subcontractAmount),
            }))
          );
        }

        return row!;
      });
    },

    async listMaterialRows(costCalculationId: string) {
      const rowUnits = alias(units, "row_units");
      return db
        .select({
          ...getTableColumns(costCalculationMaterialRows),
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          // The unit the row displays in: the BOM/consumption row's unit,
          // falling back to the component's base unit. Same shape as
          // manufacturing's listMaterialConsumptions.
          unitCode: sql<string>`coalesce(${rowUnits.code}, ${units.code})`,
        })
        .from(costCalculationMaterialRows)
        .innerJoin(articles, eq(articles.id, costCalculationMaterialRows.componentArticleId))
        .innerJoin(units, eq(units.id, articles.unitId))
        .leftJoin(rowUnits, eq(rowUnits.id, costCalculationMaterialRows.unitId))
        .where(eq(costCalculationMaterialRows.costCalculationId, costCalculationId))
        .orderBy(asc(costCalculationMaterialRows.createdAt));
    },

    async listOperationRows(costCalculationId: string) {
      return db
        .select({
          ...getTableColumns(costCalculationOperationRows),
          workCenterCode: workCenters.code,
          workCenterName: workCenters.name,
        })
        .from(costCalculationOperationRows)
        .innerJoin(workCenters, eq(workCenters.id, costCalculationOperationRows.workCenterId))
        .where(eq(costCalculationOperationRows.costCalculationId, costCalculationId))
        .orderBy(asc(costCalculationOperationRows.sequenceNo));
    },

    async findCostCalculationById(id: string) {
      const [row] = await db.select().from(costCalculations).where(eq(costCalculations.id, id));
      return row ?? null;
    },

    // One statement is enough: cost_calculation_material_rows and
    // cost_calculation_operation_rows both cascade on cost_calculation_id.
    async deleteCostCalculation(id: string) {
      await db.delete(costCalculations).where(eq(costCalculations.id, id));
    },

    // Newest first — the cards show the latest calculation's specification.
    async listCostCalculationsByArticle(articleId: string) {
      return db
        .select()
        .from(costCalculations)
        .where(eq(costCalculations.articleId, articleId))
        .orderBy(desc(costCalculations.calculatedAt));
    },

    // The latest saved PRE-calculation per article — the basis every margin
    // figure in the house is measured against. Pre only: a post-calculation
    // belongs to one manufacturing order's outcome and says nothing about what
    // the article costs to sell today.
    //
    // DISTINCT ON is the point: one row per article without a correlated
    // subquery per article, so a whole order's lines resolve in one query.
    async findLatestPreCalculationsByArticles(articleIds: string[]) {
      if (articleIds.length === 0) return [];
      return db
        .selectDistinctOn([costCalculations.articleId], {
          articleId: costCalculations.articleId,
          id: costCalculations.id,
          quantity: costCalculations.quantity,
          calculatedAt: costCalculations.calculatedAt,
          materialCost: costCalculations.materialCost,
          materialOverhead: costCalculations.materialOverhead,
          laborCost: costCalculations.laborCost,
          overhead: costCalculations.overhead,
          subcontractCost: costCalculations.subcontractCost,
          subcontractOverhead: costCalculations.subcontractOverhead,
          semiFinishedCost: costCalculations.semiFinishedCost,
          businessOverhead: costCalculations.businessOverhead,
        })
        .from(costCalculations)
        .where(and(eq(costCalculations.type, "pre"), inArray(costCalculations.articleId, articleIds)))
        .orderBy(asc(costCalculations.articleId), desc(costCalculations.calculatedAt), desc(costCalculations.id));
    },

    async listCostCalculationsByManufacturingOrder(manufacturingOrderId: string) {
      return db
        .select()
        .from(costCalculations)
        .where(eq(costCalculations.manufacturingOrderId, manufacturingOrderId))
        .orderBy(desc(costCalculations.calculatedAt));
    },
  };
}

export type CostingRepository = ReturnType<typeof createCostingRepository>;
