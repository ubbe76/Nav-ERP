import { and, asc, desc, eq, getTableColumns, inArray, lt, max, ne, sql } from "drizzle-orm";
import { legoOneOffSql } from "../../manufacturing/repository/lego-one-off.js";
import { alias } from "drizzle-orm/pg-core";
import {
  articleStandardCostHistory,
  articleSupplierPriceHistory,
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
  workCenterRateHistory,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import type { CostCalculationType, CostingMaterialSource, CostMaterialRowKind, CostPriceSource } from "@navet/shared";
import { explodeBom } from "../../article/service/bom-explosion.js";
import { weightedActualCosts } from "../service/actual-cost.js";
import { stockValuedAt } from "../../stock/repository/valued-at.js";
import { loadPriceBreaks } from "../../purchase/repository/price-breaks.js";
import type { HourlyRateHistoryRow, ReportedTimeRow, StandardCostHistoryRow, SupplierSnapshotRow } from "../service/price-at.js";

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
  // A supplier price in another currency: the catalog price, its currency
  // and the rate unitCost was converted at. All three null otherwise.
  supplierCurrency: string | null;
  supplierUnitPrice: number | null;
  exchangeRate: number | null;
  // Efterkalkyl: the day the standard/supplier price and rate were taken
  // (YYYY-MM-DD). Null otherwise.
  priceDate: string | null;
  // Avvikelseanalys (#14), efterkalkyl only: SQ, SP and its price source, and
  // the planned share of the scrapped units. Absent/null elsewhere.
  baseQuantity?: number | null;
  baseUnitCost?: number | null;
  basePriceSource?: CostPriceSource | null;
  scrapQuantity?: number | null;
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
  // Avvikelseanalys (#14), efterkalkyl only — a time row: Bs, Br, R₀ and the
  // reported run time (null until ställ/produktion is registered); a lego
  // row: N, Qa, P₀, F₀. Absent/null elsewhere.
  baseSetupHours?: number | null;
  baseRunHours?: number | null;
  runHours?: number | null;
  baseHourlyRate?: number | null;
  baseQuantity?: number | null;
  subcontractQuantity?: number | null;
  baseUnitPrice?: number | null;
  baseOneOff?: number | null;
}

// The calculation header the service hands over — plain numbers; the
// repository stringifies them for the numeric columns. Exported so the service
// can compute the header first and decide afterwards whether to save it.
// A resource time was reported on (getReportedTime, #15): what the
// efterkalkyl's row for that resource needs beyond its id.
export interface ReportedTimeResource {
  workCenterCode: string;
  workCenterName: string;
  hourlyRate: string;
  overheadPercent: string;
}

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
  // Avvikelseanalys (#14): N, the preliminary flag, T₀ and the förkalkyl's
  // material source of the base. All null on a förkalkyl (CHECK).
  outputQuantity: number | null;
  preliminary: boolean | null;
  basePricedAt: Date | null;
  baseMaterialSource: CostingMaterialSource | null;
}

// A nullable number for a numeric column (absent = null).
function numberOrNull(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function createCostingRepository(db: Db | Tx) {
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
    // (quantities multiplied down the chain) — see bom-explosion.ts. The
    // förkalkyl prices "Kalkyl" rows (costing_only) like any other row, so
    // they are included; the efterkalkyl never meets them (it prices the
    // MO's actual withdrawals, which release never created).
    async explodeBom(articleId: string, quantity: number) {
      return explodeBom(db, articleId, quantity, "include");
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
          supplierCurrency: articleSuppliers.currency,
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

    // One row per TO material row. quantityPlanned (for the order quantity)
    // and moOperationId are the avvikelseanalys's base; articleNumber labels
    // its rows in a preview.
    async getMaterialConsumptionsWithCost(manufacturingOrderId: string) {
      const rows = await db
        .select({
          componentArticleId: moMaterialConsumptions.componentArticleId,
          quantityPlanned: moMaterialConsumptions.quantityPlanned,
          quantityConsumed: moMaterialConsumptions.quantityConsumed,
          moOperationId: moMaterialConsumptions.moOperationId,
          unitId: moMaterialConsumptions.unitId,
          unitFactor: moMaterialConsumptions.unitFactor,
          articleNumber: articles.articleNumber,
          name: articles.name,
          type: articles.type,
          standardCost: articles.standardCost,
          supplierRowId: articleSuppliers.id,
          supplierPrice: articleSuppliers.price,
          supplierCurrency: articleSuppliers.currency,
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

    // Efterkalkylen prissätter vid uttaget: when each component was last
    // taken out for the order — the moment its standard or supplier price and
    // rate are read as of. Draws only (negative deltas); a component that was
    // never drawn is absent.
    async getLatestConsumptionTimes(manufacturingOrderId: string) {
      const rows = await db
        .select({ articleId: stockTransactions.articleId, drawnAt: max(stockTransactions.createdAt) })
        .from(stockTransactions)
        .where(
          and(
            eq(stockTransactions.transactionType, "mo_consumption"),
            eq(stockTransactions.referenceId, manufacturingOrderId),
            lt(stockTransactions.quantityDelta, "0")
          )
        )
        .groupBy(stockTransactions.articleId);
      return new Map(rows.filter((r) => r.drawnAt !== null).map((r) => [r.articleId, new Date(r.drawnAt!)]));
    },

    // The standard cost (D1) and supplier catalog (migration 0169) histories
    // of these articles, ascending — resolved per moment by price-at.ts.
    async getPriceHistories(articleIds: string[]) {
      const standard = new Map<string, StandardCostHistoryRow[]>();
      const supplier = new Map<string, SupplierSnapshotRow[]>();
      if (articleIds.length === 0) return { standard, supplier };
      const [standardRows, supplierRows] = await Promise.all([
        db
          .select({
            articleId: articleStandardCostHistory.articleId,
            cost: articleStandardCostHistory.cost,
            validFrom: articleStandardCostHistory.validFrom,
          })
          .from(articleStandardCostHistory)
          .where(inArray(articleStandardCostHistory.articleId, articleIds))
          .orderBy(asc(articleStandardCostHistory.validFrom), asc(articleStandardCostHistory.id)),
        db
          .select({
            articleId: articleSupplierPriceHistory.articleId,
            supplierId: articleSupplierPriceHistory.supplierId,
            price: articleSupplierPriceHistory.price,
            currency: articleSupplierPriceHistory.currency,
            priceBreaks: articleSupplierPriceHistory.priceBreaks,
            isPrimary: articleSupplierPriceHistory.isPrimary,
            removed: articleSupplierPriceHistory.removed,
            validFrom: articleSupplierPriceHistory.validFrom,
          })
          .from(articleSupplierPriceHistory)
          .where(inArray(articleSupplierPriceHistory.articleId, articleIds))
          .orderBy(asc(articleSupplierPriceHistory.validFrom), asc(articleSupplierPriceHistory.id)),
      ]);
      for (const { articleId, ...row } of standardRows) {
        const list = standard.get(articleId) ?? [];
        list.push(row);
        standard.set(articleId, list);
      }
      for (const { articleId, ...row } of supplierRows) {
        const list = supplier.get(articleId) ?? [];
        list.push({ ...row, priceBreaks: row.priceBreaks.map((b) => ({ fromQuantity: Number(b.fromQuantity), price: Number(b.price) })) });
        supplier.set(articleId, list);
      }
      return { standard, supplier };
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
    //
    // The replay runs on the värderingsdatum (#26, stockValuedAt — the field
    // keeps the name createdAt that weightedActualCosts reads): a stock count
    // registered per underlagets datum weighs in at its freeze time, before a
    // draw that was registered between the freeze and the registration.
    async getConsumptionMovingAverageCosts(manufacturingOrderId: string) {
      const draws = await db
        .select({
          articleId: stockTransactions.articleId,
          quantityDelta: stockTransactions.quantityDelta,
          createdAt: stockValuedAt,
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
          createdAt: stockValuedAt,
          id: stockTransactions.id,
        })
        .from(stockTransactions)
        .where(inArray(stockTransactions.articleId, articleIds))
        // Ties on the timestamp are broken by id so the replay is
        // deterministic — a receipt and a draw booked in the same transaction
        // share createdAt to the microsecond.
        .orderBy(asc(stockTransactions.articleId), asc(stockValuedAt), asc(stockTransactions.id));

      return weightedActualCosts(draws, history);
    },

    // One row per operation of the order, with its resource and the
    // avvikelseanalys's planned time (setupTime/runTimePerUnit, minutes). The
    // reported time is NOT here: getReportedTime is the one read of it, so H,
    // Hs, Hr and the work days all come from the same rows.
    async getPostCalculationOperations(manufacturingOrderId: string) {
      return db
        .select({
          operationId: moOperations.id,
          sequenceNo: moOperations.sequenceNo,
          workCenterId: workCenters.id,
          workCenterCode: workCenters.code,
          workCenterName: workCenters.name,
          workCenterType: workCenters.type,
          hourlyRate: workCenters.hourlyRate,
          overheadPercent: workCenters.overheadPercent,
          setupTime: moOperations.setupTime,
          runTimePerUnit: moOperations.runTimePerUnit,
          // Lego snapshot (post-calculation fallback when no IO is linked).
          setupPrice: legoOneOffSql(moOperations),
          unitPrice: moOperations.unitPrice,
          quantityCompleted: moOperations.quantityCompleted,
          quantityScrapped: moOperations.quantityScrapped,
        })
        .from(moOperations)
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .where(eq(moOperations.manufacturingOrderId, manufacturingOrderId))
        .orderBy(asc(moOperations.sequenceNo));
    },

    // Timkostnad per datum (#14 etapp 4, migration 0189): the hourly rate
    // histories of these resources, ascending — resolved per work day (and the
    // base's T₀) by price-at.ts. ONE query for a whole calculation or PIA day.
    async getWorkCenterRateHistories(workCenterIds: string[]) {
      const histories = new Map<string, HourlyRateHistoryRow[]>();
      if (workCenterIds.length === 0) return histories;
      const rows = await db
        .select({
          workCenterId: workCenterRateHistory.workCenterId,
          hourlyRate: workCenterRateHistory.hourlyRate,
          validFrom: workCenterRateHistory.validFrom,
        })
        .from(workCenterRateHistory)
        .where(inArray(workCenterRateHistory.workCenterId, workCenterIds))
        .orderBy(asc(workCenterRateHistory.validFrom), asc(workCenterRateHistory.id));
      for (const { workCenterId, ...row } of rows) {
        const list = histories.get(workCenterId);
        if (list) list.push(row);
        else histories.set(workCenterId, [row]);
      }
      return histories;
    },

    // The order's reported time — ONE grouped query on (operation, resource,
    // work day, kind), per operation. reportedTimeByResource and reportedTime
    // (price-at.ts) derive H, Hs (ställ), Hr (produktion) and the work days
    // Lön is priced on (each day at that day's hourly rate, #14 etapp 4) from
    // these same rows: two reads could straddle a time report's commit and
    // give H ≠ Σ H_d. The resource is the one the time was worked on
    // (time_reports.work_center_id, #15), or the operation's current one for
    // a report from before 0192; `resources` carries its labels, current
    // hourly rate (no history) and TO percentage.
    async getReportedTime(manufacturingOrderId: string) {
      const rows = await db
        .select({
          operationId: timeReports.moOperationId,
          workCenterId: workCenters.id,
          workCenterCode: workCenters.code,
          workCenterName: workCenters.name,
          hourlyRate: workCenters.hourlyRate,
          overheadPercent: workCenters.overheadPercent,
          date: timeReports.date,
          kind: timeReports.kind,
          hours: sql<string>`sum(${timeReports.hours})`,
        })
        .from(timeReports)
        .innerJoin(moOperations, eq(moOperations.id, timeReports.moOperationId))
        .innerJoin(workCenters, eq(workCenters.id, sql`coalesce(${timeReports.workCenterId}, ${moOperations.workCenterId})`))
        .where(eq(moOperations.manufacturingOrderId, manufacturingOrderId))
        .groupBy(timeReports.moOperationId, workCenters.id, timeReports.date, timeReports.kind);
      const byOperation = new Map<string, ReportedTimeRow[]>();
      const resources = new Map<string, ReportedTimeResource>();
      for (const { operationId, workCenterCode, workCenterName, hourlyRate, overheadPercent, ...row } of rows) {
        resources.set(row.workCenterId, { workCenterCode, workCenterName, hourlyRate, overheadPercent });
        const list = byOperation.get(operationId);
        if (list) list.push(row);
        else byOperation.set(operationId, [row]);
      }
      return { byOperation, resources };
    },

    // Actual lego cost per operation from the linked IO rows (non-cancelled
    // orders): Σ setupPrice + unitPrice × quantityReceived, each converted at
    // the order's exchange rate — the same SEK conversion the goods receipt
    // stamps on stock_transactions.unit_cost. Only rows with some receipt
    // count (an unreceived order has cost the MO nothing yet). `quantity` =
    // Σ received over the same rows — the Qa the avvikelseanalys prices.
    async getSubcontractActualCosts(manufacturingOrderId: string) {
      const rows = await db
        .select({
          moOperationId: purchaseOrderRows.moOperationId,
          amount: sql<string>`coalesce(sum((coalesce(${purchaseOrderRows.setupPrice}, 0) + ${purchaseOrderRows.unitPrice} * ${purchaseOrderRows.quantityReceived}) * ${purchaseOrders.exchangeRate}), 0)`,
          quantity: sql<string>`coalesce(sum(${purchaseOrderRows.quantityReceived}), 0)`,
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
      return new Map(
        rows
          .filter((r) => r.moOperationId !== null)
          .map((r) => [r.moOperationId!, { amount: Number(r.amount), quantity: Number(r.quantity) }])
      );
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
            outputQuantity: numberOrNull(input.outputQuantity),
            preliminary: input.preliminary,
            basePricedAt: input.basePricedAt,
            baseMaterialSource: input.baseMaterialSource,
          })
          .returning();

        if (materialRows.length > 0) {
          // One statement ⇒ one now() for every created_at, and
          // listMaterialRows sorts on it — stamp the rows a millisecond apart
          // in input order (same idiom as sales' invoice.repository create).
          const now = Date.now();
          await tx.insert(costCalculationMaterialRows).values(
            materialRows.map((r, i) => ({
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
              supplierCurrency: r.supplierCurrency,
              supplierUnitPrice: r.supplierUnitPrice === null ? null : String(r.supplierUnitPrice),
              exchangeRate: r.exchangeRate === null ? null : String(r.exchangeRate),
              priceDate: r.priceDate,
              baseQuantity: numberOrNull(r.baseQuantity),
              baseUnitCost: numberOrNull(r.baseUnitCost),
              basePriceSource: r.basePriceSource ?? null,
              scrapQuantity: numberOrNull(r.scrapQuantity),
              createdAt: new Date(now + i),
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
              baseSetupHours: numberOrNull(r.baseSetupHours),
              baseRunHours: numberOrNull(r.baseRunHours),
              runHours: numberOrNull(r.runHours),
              baseHourlyRate: numberOrNull(r.baseHourlyRate),
              baseQuantity: numberOrNull(r.baseQuantity),
              subcontractQuantity: numberOrNull(r.subcontractQuantity),
              baseUnitPrice: numberOrNull(r.baseUnitPrice),
              baseOneOff: numberOrNull(r.baseOneOff),
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
        .orderBy(asc(costCalculationMaterialRows.createdAt), asc(costCalculationMaterialRows.id));
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
        // An operation worked on several resources has a row each (#15): by
        // code in byte order, as the efterkalkyl computes them.
        .orderBy(asc(costCalculationOperationRows.sequenceNo), sql`${workCenters.code} collate "C"`, asc(costCalculationOperationRows.id));
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
