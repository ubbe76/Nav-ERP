// Produkter i arbete (PIA) per datum (#25): the efterkalkyl per D for every TO
// open on D, less what it has received into stock (avräknat). Built from the
// efterkalkyl's own building blocks — buildMaterialRow/buildOperationRow/
// buildSubcontractOperationRow/directCosts (level-costing.ts), applyMarkups
// (markup.ts), pricedAtWithdrawal (price-at.ts), weightedActualCosts
// (actual-cost.ts) — with every source bounded to D; the PIA arithmetic is
// work-in-progress.ts.
//
// Every database source is read in ONE snapshot (a repeatable-read, read-only
// transaction, getPlan's pattern in fixed-asset.service.ts), so a report that
// commits mid-read is never half seen — the year-end step books what this
// returns. The supplier rates are attached AFTER that transaction: getRate may
// call Riksbanken, and there is no HTTP inside a transaction. For the same
// reason the year-end step calls this before its own transaction.
import {
  WIP_BASIS_LABELS,
  type CostingMaterialSource,
  type CostingSupplierPriceTier,
  type WipBasis,
  type WorkInProgressQuery,
} from "@navet/shared";
import type { Db, Tx } from "@navet/db";
import { formatNumber, type FinancialStatementPdfInput } from "../../mail/service/document-pdf.js";
import type { ExchangeRateReader } from "../../system/service/exchange-rates.js";
import { stockholmToday } from "../../system/service/delivery-days.js";
import { createCostingRepository, type MaterialRowWrite, type OperationRowWrite } from "../repository/costing.repository.js";
import { createWorkInProgressRepository } from "../repository/work-in-progress.repository.js";
import { weightedActualCosts, type HistoryRow } from "./actual-cost.js";
import { createRateAttacher, loadCostingConfig, type CostingSettingsReader } from "./costing.service.js";
import { buildMaterialRow, buildOperationRow, buildSubcontractOperationRow, directCosts } from "./level-costing.js";
import { applyMarkups } from "./markup.js";
import { laborAtWorkDays, pricedAtWithdrawal, type PriceHistories } from "./price-at.js";
import {
  isDoneAt,
  isEmptyWipRow,
  relievedValue,
  workInProgressRow,
  workInProgressTotals,
  type CompletedReport,
  type WipReceipt,
  type WipRowAmounts,
  type WipTotals,
} from "./work-in-progress.js";

export interface WorkInProgressRow extends WipRowAmounts {
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  quantity: number;
  // Inlevererat vid D.
  receivedQuantity: number;
}

export interface WorkInProgressReport {
  asOf: string;
  basis: WipBasis;
  rows: WorkInProgressRow[];
  totals: WipTotals;
  // Excludes the unvalued rows.
  totalValue: number;
  unvaluedCount: number;
  cappedCount: number;
  // The distinct price texts, as the efterkalkyl reports them.
  warnings: string[];
}

export interface WorkInProgressPdfRenderer {
  renderFinancialStatement(input: FinancialStatementPdfInput): Promise<Buffer>;
}

export interface WorkInProgressServiceDeps {
  db: Db;
  settings: CostingSettingsReader;
  rates: Pick<ExchangeRateReader, "getRate">;
  // Optional so unit tests can build the service without pdfkit (the
  // valuation service's pattern); the routes always pass it.
  pdf?: WorkInProgressPdfRenderer;
  today?: () => string;
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// Every database read the report needs, from one executor. Sequential: the
// statements share the snapshot's connection.
async function readSources(ex: Db | Tx, asOf: string, source: CostingMaterialSource) {
  const repo = createWorkInProgressRepository(ex);
  const costing = createCostingRepository(ex);
  const orders = await repo.listOrders(asOf);
  const completed = await repo.listCompletedReports(asOf);
  const receipts = await repo.listReceipts(asOf);
  const materialNet = await repo.listMaterialNet(asOf);
  // Verklig kostnad: only read when the source needs it (as in the efterkalkyl).
  const actual = source === "actual" ? await repo.listDrawsAndHistory(asOf) : null;
  const hours = await repo.listReportedHours(asOf);
  const lego = await repo.listSubcontractCosts(asOf);
  const articleIds = [...new Set(materialNet.map((row) => row.articleId))];
  const bases = await costing.getComponentCostBasis(articleIds);
  const labels = await costing.getArticleLabels(articleIds);
  const histories: PriceHistories | null = source === "actual" ? null : await costing.getPriceHistories(articleIds);
  // Timkostnad per datum: one load for every resource with hours by D.
  const rateHistories = await costing.getWorkCenterRateHistories([
    ...new Set(hours.filter((row) => row.workCenterType !== "subcontract").map((row) => row.workCenterId)),
  ]);
  return { orders, completed, receipts, materialNet, actual, hours, lego, bases, labels, histories, rateHistories };
}

type Sources = Awaited<ReturnType<typeof readSources>>;

export function createWorkInProgressService(deps: WorkInProgressServiceDeps) {
  const today = deps.today ?? stockholmToday;

  // Material rows per order, priced as the efterkalkyl prices them but as of
  // D: standard/supplier at the latest draw on or before D (and that day's
  // rate), actual weighted over the draws on or before D. The rates are the
  // only lookup here, after the snapshot.
  async function materialRowsByOrder(
    sources: Sources,
    orderIds: Set<string>,
    source: CostingMaterialSource,
    supplierPriceTier: CostingSupplierPriceTier,
    warnings: string[]
  ): Promise<Map<string, MaterialRowWrite[]>> {
    const net = sources.materialNet.filter((row) => orderIds.has(row.manufacturingOrderId));
    const result = new Map<string, MaterialRowWrite[]>();
    if (net.length === 0) return result;

    const basisById = new Map(sources.bases.map((basis) => [basis.id, basis]));
    const nameById = new Map(sources.labels.map((label) => [label.id, label.name]));

    let actualByOrder: Map<string, Map<string, number | null>> | null = null;
    if (sources.actual) {
      const historyByArticle = groupBy(sources.actual.history as HistoryRow[], (row) => row.articleId);
      actualByOrder = new Map();
      for (const [orderId, orderDraws] of groupBy(sources.actual.draws, (draw) => draw.manufacturingOrderId)) {
        if (!orderIds.has(orderId)) continue;
        const articlesOfOrder = [...new Set(orderDraws.map((draw) => draw.articleId))];
        actualByOrder.set(orderId, weightedActualCosts(orderDraws, articlesOfOrder.flatMap((id) => historyByArticle.get(id) ?? [])));
      }
    }

    const histories = sources.histories;
    const now = new Date();
    const consumptions = net.map((row) => {
      const basis = basisById.get(row.articleId);
      return {
        manufacturingOrderId: row.manufacturingOrderId,
        componentArticleId: row.articleId,
        quantity: round4(Number(row.quantity)),
        drawnAt: row.drawnAt,
        type: basis?.type ?? "purchased",
        standardCost: basis?.standardCost ?? null,
        supplierPrice: basis?.supplierPrice ?? null,
        supplierCurrency: basis?.supplierCurrency ?? null,
        supplierPriceBreaks: basis?.supplierPriceBreaks ?? [],
      };
    });
    // One row per (TO, article), so each order's draw moments key on the
    // article. Every row with a positive net has a draw, so drawnAt is always
    // set; `now` is only the shared rule's fallback.
    const priced = [...groupBy(consumptions, (c) => c.manufacturingOrderId).values()].flatMap((orderRows) =>
      histories
        ? pricedAtWithdrawal(
            orderRows,
            new Map(orderRows.flatMap((c) => (c.drawnAt ? [[c.componentArticleId, c.drawnAt] as const] : []))),
            histories,
            now
          )
        : orderRows.map((c) => ({ ...c, priceDate: null as string | null }))
    );
    const rated = await createRateAttacher(deps.rates, source, today())(priced);

    for (const c of rated) {
      const { row, warning } = buildMaterialRow(
        { componentArticleId: c.componentArticleId, quantity: c.quantity, unitId: null, unitFactor: null },
        { ...c, actualCost: actualByOrder?.get(c.manufacturingOrderId)?.get(c.componentArticleId) ?? null },
        source,
        supplierPriceTier
      );
      if (warning) warnings.push(`${nameById.get(c.componentArticleId) ?? "?"}: ${warning}`);
      const list = result.get(c.manufacturingOrderId);
      if (list) list.push(row);
      else result.set(c.manufacturingOrderId, [row]);
    }
    return result;
  }

  // Lön (time-priced operations) and lego (subcontract operations) per
  // order. As in the efterkalkyl, a subcontract operation's cost is its IO
  // receipts and a time-priced operation's its hours — never the other way.
  // Lön is priced per work day at that day's hourly rate (laborAtWorkDays,
  // the efterkalkyl's rule), so a rate changed after D never moves PIA per D.
  function operationRowsByOrder(sources: Sources, orderIds: Set<string>): Map<string, OperationRowWrite[]> {
    const result = new Map<string, OperationRowWrite[]>();
    const push = (orderId: string, row: OperationRowWrite) => {
      const list = result.get(orderId);
      if (list) list.push(row);
      else result.set(orderId, [row]);
    };
    for (const [, days] of groupBy(sources.hours, (row) => row.operationId)) {
      const op = days[0]!;
      if (!orderIds.has(op.manufacturingOrderId) || op.workCenterType === "subcontract") continue;
      const labor = laborAtWorkDays(
        days.map((day) => ({ date: day.date, hours: Number(day.hours) })),
        sources.rateHistories.get(op.workCenterId) ?? [],
        Number(op.hourlyRate)
      );
      push(
        op.manufacturingOrderId,
        buildOperationRow({ ...op, hours: labor.hours, setupHours: null, hourlyRate: String(labor.hourlyRate), laborAmount: labor.laborAmount })
      );
    }
    const legoByOperation = new Map<string, { orderId: string; sequenceNo: number; workCenterId: string; amount: number }>();
    for (const row of sources.lego) {
      if (!orderIds.has(row.manufacturingOrderId) || row.workCenterType !== "subcontract") continue;
      const entry = legoByOperation.get(row.operationId) ?? {
        orderId: row.manufacturingOrderId,
        sequenceNo: row.sequenceNo,
        workCenterId: row.workCenterId,
        amount: 0,
      };
      entry.amount += Number(row.amount);
      legoByOperation.set(row.operationId, entry);
    }
    for (const entry of legoByOperation.values()) push(entry.orderId, buildSubcontractOperationRow(entry, entry.amount));
    return result;
  }

  const service = {
    async getWorkInProgress(query: WorkInProgressQuery): Promise<WorkInProgressReport> {
      const asOf = query.asOf ?? today();
      const basis: WipBasis = query.basis ?? "manufacturing_cost";
      const { postSource: source, supplierPriceTier, markups } = await loadCostingConfig(deps.settings);

      const sources = await deps.db.transaction((tx) => readSources(tx, asOf, source), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
      const completedByOrder = groupBy(sources.completed, (row) => row.manufacturingOrderId);
      const receiptsByOrder = groupBy(sources.receipts, (row) => row.manufacturingOrderId);

      const open = sources.orders.flatMap((order) => {
        const orderReceipts: WipReceipt[] = (receiptsByOrder.get(order.id) ?? []).map((r) => ({
          quantityDelta: Number(r.quantityDelta),
          unitCost: r.unitCost === null ? null : Number(r.unitCost),
        }));
        const relieved = relievedValue(orderReceipts);
        const quantity = Number(order.quantity);
        const reports: CompletedReport[] = completedByOrder.get(order.id) ?? [];
        if (isDoneAt({ asOf, quantity, receivedQuantity: relieved.quantity, completedReports: reports })) return [];
        return [{ order, quantity, relieved }];
      });
      const openIds = new Set(open.map((entry) => entry.order.id));

      const warnings: string[] = [];
      const materials = await materialRowsByOrder(sources, openIds, source, supplierPriceTier, warnings);
      const operations = operationRowsByOrder(sources, openIds);

      const rows: WorkInProgressRow[] = [];
      for (const { order, quantity, relieved } of open) {
        const costs = applyMarkups(directCosts(materials.get(order.id) ?? [], operations.get(order.id) ?? []), markups);
        const amounts = workInProgressRow(costs, relieved.value, basis);
        if (isEmptyWipRow(amounts)) continue;
        rows.push({
          manufacturingOrderId: order.id,
          orderNumber: order.orderNumber,
          articleId: order.articleId,
          articleNumber: order.articleNumber,
          articleName: order.articleName,
          quantity,
          receivedQuantity: relieved.quantity,
          ...amounts,
        });
      }
      // TO number with numeric collation (PO-999 before PO-1000); the
      // numbers are unique, so the order is fixed.
      rows.sort((a, b) => a.orderNumber.localeCompare(b.orderNumber, "sv", { numeric: true }));

      return { asOf, basis, rows, ...workInProgressTotals(rows), warnings: [...new Set(warnings)] };
    },

    // Liggande A4: TO and article in the label, upparbetat, avräknat and PIA
    // as columns, and the summary row.
    async getWorkInProgressPdf(query: WorkInProgressQuery) {
      if (!deps.pdf) throw new Error("work-in-progress service was created without a PDF renderer");
      const report = await service.getWorkInProgress(query);
      const rows: FinancialStatementPdfInput["rows"] = report.rows.map((row) => ({
        kind: "account",
        label: `${row.orderNumber} ${row.articleNumber} ${row.articleName}`,
        amount: null,
        // "—" for an unknown amount, never a blank cell (Lagervärderingen's rule).
        amounts: [
          formatNumber(row.accumulated),
          row.relieved === null ? "—" : formatNumber(row.relieved),
          row.value === null ? "—" : formatNumber(row.value),
        ],
      }));
      rows.push({
        kind: "total",
        label: "SUMMA PRODUKTER I ARBETE",
        amount: null,
        amounts: [formatNumber(report.totals.accumulated), formatNumber(report.totals.relieved), formatNumber(report.totalValue)],
      });
      if (report.unvaluedCount > 0) {
        rows.push({ kind: "line", label: `varav ovärderat: ${report.unvaluedCount} ordrar har inlevererat utan pris`, amount: null });
      }
      if (report.cappedCount > 0) {
        rows.push({ kind: "line", label: `${report.cappedCount} ordrar: avräknat överstiger upparbetat (PIA 0)`, amount: null });
      }
      const content = await deps.pdf.renderFinancialStatement({
        title: "Produkter i arbete",
        subtitle: `Per ${report.asOf} · ${WIP_BASIS_LABELS[report.basis]}`,
        columns: ["Upparbetat", "Avräknat", "PIA"],
        landscape: true,
        rows,
      });
      return { filename: `produkter-i-arbete-${report.asOf}.pdf`, content };
    },
  };

  return service;
}

export type WorkInProgressService = ReturnType<typeof createWorkInProgressService>;
