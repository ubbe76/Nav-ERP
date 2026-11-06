// Produkter i arbete (#25) — the bulk readers per day D. Every source is read
// in ONE query for all candidate orders and grouped on the TO by the service
// (no N+1). Leaf next to costing.repository.ts: the prices and the cost basis
// come from there. Built on an executor: the service runs every read in ONE
// repeatable-read snapshot, so a report committing mid-read is never half seen.
//
// Days are Stockholm days. stock_transactions is bounded on the
// värderingsdatum (stockValuedDate, the rule for every per-date reader of the
// stock log); time_reports on the work date; mo_reports and purchase_receipts
// are "alive on D": created on or before D and not undone, or undone after D.
import { and, asc, eq, lt, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  articles,
  manufacturingOrders,
  moOperations,
  moReports,
  purchaseOrderRows,
  purchaseOrders,
  purchaseReceipts,
  stockTransactions,
  timeReports,
  workCenters,
  type Db,
  type Tx,
} from "@navet/db";
import { stockValuedAt, stockValuedDate } from "../../stock/repository/valued-at.js";

function stockholmDay(column: AnyColumn) {
  return sql`(${column} AT TIME ZONE 'Europe/Stockholm')::date`;
}

// The orders the report looks at. A subquery rather than an id list, so the
// reads below never hit the parameter limit. Left out:
// - certainly done by D: a Slutför (kind completion) created on or before D
//   that was never undone — a strict subset of isDoneAt's rule (a)
//   (work-in-progress.ts), which still decides for every order left; this
//   only keeps years of finished orders out of the reads;
// - a short-closed order from before the report log: Stängd, received less
//   than ordered and no completion report at all. 0117 backfilled Slutför
//   rows only for orders then done, and since then a short close always goes
//   through Slutför, so only such an order matches. Not a per-day rule — the
//   day it became done is unknown;
// - cancelled on or before D. A cancel needs every quantity, draw and receipt
//   undone (the per-day nets are 0 after the undo day anyway), but time
//   reports survive it (a 0/0 stamp-out, a manual time report); before its
//   day the order counts like any other, so a past PIA does not change. A
//   cancelled order is never written again, so updated_at is its
//   cancellation (every writer refuses status cancelled).
function candidateOrders(asOf: string): SQL {
  return sql`(SELECT mo.id FROM ${manufacturingOrders} mo
    WHERE NOT (mo.status = 'cancelled' AND (mo.updated_at AT TIME ZONE 'Europe/Stockholm')::date <= ${asOf}::date)
      AND NOT EXISTS (
        SELECT 1 FROM ${moReports} r
        WHERE r.manufacturing_order_id = mo.id AND r.kind = 'completion' AND r.undone_at IS NULL
          AND (r.created_at AT TIME ZONE 'Europe/Stockholm')::date <= ${asOf}::date
      )
      AND NOT (
        mo.status = 'closed' AND mo.quantity_received < mo.quantity
        AND NOT EXISTS (SELECT 1 FROM ${moReports} r WHERE r.manufacturing_order_id = mo.id AND r.kind = 'completion')
      ))`;
}

export function createWorkInProgressRepository(db: Db | Tx) {
  return {
    async listOrders(asOf: string) {
      return db
        .select({
          id: manufacturingOrders.id,
          orderNumber: manufacturingOrders.orderNumber,
          articleId: manufacturingOrders.articleId,
          articleNumber: articles.articleNumber,
          articleName: articles.name,
          quantity: manufacturingOrders.quantity,
        })
        .from(manufacturingOrders)
        .innerJoin(articles, eq(articles.id, manufacturingOrders.articleId))
        .where(sql`${manufacturingOrders.id} IN ${candidateOrders(asOf)}`);
    },

    // Slutför reports (kind completion — Slutför/Slutför order, 0117's
    // backfill included) created on or before D, an undone one included:
    // isDoneAt decides whether it was alive on D. Not completed_order — that
    // only says a report flipped the order to done; an operation report that
    // did so stops making it done once an earlier receipt is undone
    // (undoReportInTx's stillDone: a live completion, or the receipts cover
    // the order — rule (b)).
    async listCompletedReports(asOf: string) {
      return db
        .select({
          manufacturingOrderId: moReports.manufacturingOrderId,
          createdOn: sql<string>`${stockholmDay(moReports.createdAt)}::text`,
          undoneOn: sql<string | null>`${stockholmDay(moReports.undoneAt)}::text`,
        })
        .from(moReports)
        .where(
          and(
            eq(moReports.kind, "completion"),
            sql`${stockholmDay(moReports.createdAt)} <= ${asOf}::date`,
            sql`${moReports.manufacturingOrderId} IN ${candidateOrders(asOf)}`
          )
        );
    },

    // Avräknat: the order's mo_receipt rows valued on or before D, in
    // värderingsdatum order (ties by id) — the order relievedValue replays.
    async listReceipts(asOf: string) {
      return db
        .select({
          manufacturingOrderId: sql<string>`${stockTransactions.referenceId}`,
          quantityDelta: stockTransactions.quantityDelta,
          unitCost: stockTransactions.unitCost,
        })
        .from(stockTransactions)
        .where(
          and(
            eq(stockTransactions.transactionType, "mo_receipt"),
            sql`${stockValuedDate} <= ${asOf}::date`,
            sql`${stockTransactions.referenceId} IN ${candidateOrders(asOf)}`
          )
        )
        .orderBy(asc(stockTransactions.referenceId), asc(stockValuedAt), asc(stockTransactions.id));
    },

    // Material: the net draw per (TO, article) by D — draws are negative and
    // Ångra rapportering's return is a positive mo_consumption, so the net is
    // −Σ quantity_delta; ≤ 0 is no row. drawnAt = the latest draw (created_at,
    // like getLatestConsumptionTimes: a draw is never backdated) — the moment
    // standard/supplier prices are read as of.
    async listMaterialNet(asOf: string) {
      const net = sql<string>`-sum(${stockTransactions.quantityDelta})`;
      return db
        .select({
          manufacturingOrderId: sql<string>`${stockTransactions.referenceId}`,
          articleId: stockTransactions.articleId,
          quantity: net,
          drawnAt: sql<Date | null>`max(${stockTransactions.createdAt}) FILTER (WHERE ${stockTransactions.quantityDelta} < 0)`.mapWith(
            stockTransactions.createdAt
          ),
        })
        .from(stockTransactions)
        .where(
          and(
            eq(stockTransactions.transactionType, "mo_consumption"),
            sql`${stockValuedDate} <= ${asOf}::date`,
            sql`${stockTransactions.referenceId} IN ${candidateOrders(asOf)}`
          )
        )
        .groupBy(stockTransactions.referenceId, stockTransactions.articleId)
        .having(sql`-sum(${stockTransactions.quantityDelta}) > 0`);
    },

    // Verklig kostnad per D: the draws (negative mo_consumption) by D and the
    // whole stock log of their articles by D, for weightedActualCosts
    // (actual-cost.ts). createdAt carries the värderingsdatum, the field name
    // weightedActualCosts reads (getConsumptionMovingAverageCosts' convention).
    async listDrawsAndHistory(asOf: string) {
      const drawsWhere = and(
        eq(stockTransactions.transactionType, "mo_consumption"),
        lt(stockTransactions.quantityDelta, "0"),
        sql`${stockValuedDate} <= ${asOf}::date`,
        sql`${stockTransactions.referenceId} IN ${candidateOrders(asOf)}`
      );
      const draws = await db
        .select({
          manufacturingOrderId: sql<string>`${stockTransactions.referenceId}`,
          articleId: stockTransactions.articleId,
          quantityDelta: stockTransactions.quantityDelta,
          createdAt: stockValuedAt,
          id: stockTransactions.id,
        })
        .from(stockTransactions)
        .where(drawsWhere);
      if (draws.length === 0) return { draws, history: [] };
      const history = await db
        .select({
          articleId: stockTransactions.articleId,
          quantityDelta: stockTransactions.quantityDelta,
          unitCost: stockTransactions.unitCost,
          createdAt: stockValuedAt,
          id: stockTransactions.id,
        })
        .from(stockTransactions)
        .where(
          and(
            sql`${stockValuedDate} <= ${asOf}::date`,
            sql`${stockTransactions.articleId} IN (
              SELECT DISTINCT st.article_id FROM ${stockTransactions} st
              WHERE st.transaction_type = 'mo_consumption' AND st.quantity_delta < 0
                AND (coalesce(st.valued_at, st.created_at) AT TIME ZONE 'Europe/Stockholm')::date <= ${asOf}::date
                AND st.reference_id IN ${candidateOrders(asOf)}
            )`
          )
        )
        // Ties on the moment by id, as in getConsumptionMovingAverageCosts.
        .orderBy(asc(stockTransactions.articleId), asc(stockValuedAt), asc(stockTransactions.id));
      return { draws, history };
    },

    // Lön: hours per operation and work day on or before D (the work date,
    // not when it was registered). The service prices each day at that
    // day's hourly rate (laborAtWorkDays, the efterkalkyl's rule, #14 etapp
    // 4); hourlyRate is the current one, for a resource without history.
    async listReportedHours(asOf: string) {
      return db
        .select({
          manufacturingOrderId: moOperations.manufacturingOrderId,
          operationId: moOperations.id,
          sequenceNo: moOperations.sequenceNo,
          workCenterId: workCenters.id,
          workCenterType: workCenters.type,
          hourlyRate: workCenters.hourlyRate,
          overheadPercent: workCenters.overheadPercent,
          date: timeReports.date,
          hours: sql<string>`sum(${timeReports.hours})`,
        })
        .from(timeReports)
        .innerJoin(moOperations, eq(moOperations.id, timeReports.moOperationId))
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .where(and(sql`${timeReports.date} <= ${asOf}::date`, sql`${moOperations.manufacturingOrderId} IN ${candidateOrders(asOf)}`))
        .groupBy(moOperations.id, workCenters.id, timeReports.date);
    },

    // Lego: getSubcontractActualCosts per D — per lego IO row (order not
    // cancelled) the receipts alive on D: Σ quantity × à-pris + the row's
    // one-off (ställpris) once when that quantity is > 0, at the order's
    // exchange rate. No fallback on the release snapshot: a lego operation
    // without a receipt has not cost anything yet.
    async listSubcontractCosts(asOf: string) {
      const liveQuantity = sql<string>`sum(${purchaseReceipts.quantity})`;
      return db
        .select({
          manufacturingOrderId: moOperations.manufacturingOrderId,
          operationId: moOperations.id,
          sequenceNo: moOperations.sequenceNo,
          workCenterId: workCenters.id,
          workCenterType: workCenters.type,
          amount: sql<string>`(coalesce(${purchaseOrderRows.setupPrice}, 0) + ${purchaseOrderRows.unitPrice} * ${liveQuantity}) * ${purchaseOrders.exchangeRate}`,
        })
        .from(purchaseReceipts)
        .innerJoin(purchaseOrderRows, eq(purchaseOrderRows.id, purchaseReceipts.purchaseOrderRowId))
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderRows.purchaseOrderId))
        .innerJoin(moOperations, eq(moOperations.id, purchaseOrderRows.moOperationId))
        .innerJoin(workCenters, eq(workCenters.id, moOperations.workCenterId))
        .where(
          and(
            ne(purchaseOrders.status, "cancelled"),
            sql`${stockholmDay(purchaseReceipts.createdAt)} <= ${asOf}::date`,
            sql`(${purchaseReceipts.undoneAt} IS NULL OR ${stockholmDay(purchaseReceipts.undoneAt)} > ${asOf}::date)`,
            sql`${moOperations.manufacturingOrderId} IN ${candidateOrders(asOf)}`
          )
        )
        .groupBy(purchaseOrderRows.id, purchaseOrders.id, moOperations.id, workCenters.id)
        .having(sql`${liveQuantity} > 0`);
    },
  };
}

export type WorkInProgressRepository = ReturnType<typeof createWorkInProgressRepository>;
