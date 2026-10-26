import type {
  DeliveryPrecisionQuery,
  OrderMarginQuery,
  ReportRangeQuery,
  SalesStatisticsQuery,
  PurchaseStatisticsQuery,
  ScrapStatisticsQuery,
} from "@navet/shared";
import type { ReportsRepository } from "../repository/reports.repository.js";
import { bucketDeliveryPrecision, type PrecisionOrderInput, type PrecisionSection } from "./delivery-precision-calc.js";
import {
  groupPrecisionByCounterparty,
  measuredOrderIds,
  monthRangeDates,
  type CounterpartyPrecisionRow,
  type CounterpartyPrecisionTotals,
  type QualityDeviationInput,
} from "./delivery-quality-calc.js";
import { pairCalculationOutcomes, type OutcomeResult } from "./calc-outcome-calc.js";
import { groupOrderMargin } from "./order-margin-calc.js";

// Gruppera: Motpart adds the per-counterparty rows to each side; the month
// view (groupBy month, the default) is unchanged.
export interface DeliveryPrecisionSide extends PrecisionSection {
  counterparties?: { rows: CounterpartyPrecisionRow[]; totals: CounterpartyPrecisionTotals };
}

export interface DeliveryPrecisionResponse {
  from: string;
  to: string;
  groupBy: DeliveryPrecisionQuery["groupBy"];
  sales: DeliveryPrecisionSide;
  purchase: DeliveryPrecisionSide;
}

// The quality module, narrowed (QualityService satisfies it): the period's
// cases of the side's type with their net cost, and which measured orders
// carry a case.
export interface PrecisionQualityReader {
  precisionQuality(
    kind: "sales" | "purchase",
    range: { fromDate: string; toDate: string },
    measuredOrderIds: string[]
  ): Promise<{ deviations: QualityDeviationInput[]; ordersWithDeviation: ReadonlySet<string> }>;
}

export interface CalculationOutcomeResponse extends OutcomeResult {
  from: string;
  to: string;
}

export interface StatisticsRowResponse {
  key: string;
  label: string;
  netAmount: number;
  quantity: number | null;
  invoiceCount: number;
}

export interface SalesStatisticsResponse {
  from: string;
  to: string;
  groupBy: SalesStatisticsQuery["groupBy"];
  rows: StatisticsRowResponse[];
  totalNet: number;
}

export interface PurchaseStatisticsResponse {
  from: string;
  to: string;
  groupBy: PurchaseStatisticsQuery["groupBy"];
  rows: StatisticsRowResponse[];
  totalNet: number;
  basis: "header" | "rows";
}

export interface ScrapStatisticsRowResponse {
  key: string;
  label: string;
  scrappedQuantity: number;
  reportCount: number;
}

export interface ScrapStatisticsResponse {
  from: string;
  to: string;
  groupBy: ScrapStatisticsQuery["groupBy"];
  rows: ScrapStatisticsRowResponse[];
  totalScrapped: number;
}

function shiftMonth(month: string, delta: number): string {
  let [year, m] = month.split("-").map(Number) as [number, number];
  m += delta;
  while (m < 1) {
    m += 12;
    year -= 1;
  }
  while (m > 12) {
    m -= 12;
    year += 1;
  }
  return `${year}-${String(m).padStart(2, "0")}`;
}

// A missing range defaults to the last 12 months including the current one
// (or, with only `to` given, the 12 months ending there). Pure and
// injectable-today for tests.
export function resolveReportRange(
  query: { from?: string; to?: string },
  today: string // YYYY-MM-DD (Stockholm)
): { from: string; to: string } {
  const to = query.to ?? today.slice(0, 7);
  const from = query.from ?? shiftMonth(to, -11);
  // The zod refine only guards when BOTH ends are supplied; a lone future
  // `from` would otherwise invert against the defaulted `to` and run the
  // month axis into its safety cap. Clamp to a single (empty) month instead.
  return from > to ? { from, to: from } : { from, to };
}

const stockholmToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());

// Narrow slice of the costing service — the margin report measures invoiced
// revenue against each article's latest saved pre-calculation. Same
// cross-module reader pattern the rest of the house uses; reports never
// imports the costing module.
export interface ArticleSelfCostReader {
  latestPreCalculationSelfCost(
    articleIds: string[]
  ): Promise<Map<string, { selfCostPerUnit: number; calculationId: string; calculatedAt: string; quantity: number }>>;
}

export function createReportsService(repo: ReportsRepository, selfCosts: ArticleSelfCostReader, quality?: PrecisionQualityReader) {
  async function precisionSide(
    kind: "sales" | "purchase",
    orders: PrecisionOrderInput[],
    range: { from: string; to: string },
    groupBy: DeliveryPrecisionQuery["groupBy"],
    seePrices: boolean
  ): Promise<DeliveryPrecisionSide> {
    const section = bucketDeliveryPrecision(orders, range);
    if (groupBy !== "counterparty") return section;
    const q = quality
      ? await quality.precisionQuality(kind, monthRangeDates(range), measuredOrderIds(orders, range))
      : { deviations: [], ordersWithDeviation: new Set<string>() };
    return { ...section, counterparties: groupPrecisionByCounterparty(orders, range, q, { seePrices }) };
  }

  return {
    // Marginalrapport. The self cost is each article's LATEST pre-calculation,
    // so this applies today's cost picture to historical revenue — a
    // limitation that is stated in the manual rather than hidden.
    async getOrderMargin(query: OrderMarginQuery) {
      const range = resolveReportRange(query, stockholmToday());
      const rows = await repo.loadInvoiceMarginRows(range);
      // Rows with their own förkalkyl (configured order rows, 4c) need no
      // article lookup.
      const articleIds = [
        ...new Set(rows.filter((r) => r.rowSelfCostPerUnit === undefined).map((r) => r.articleId).filter((id): id is string => id !== null)),
      ];
      const costs = await selfCosts.latestPreCalculationSelfCost(articleIds);
      const perUnit = new Map([...costs].map(([articleId, c]) => [articleId, c.selfCostPerUnit]));
      return { ...range, groupBy: query.groupBy, ...groupOrderMargin(rows, perUnit, query.groupBy) };
    },

    async getDeliveryPrecision(
      query: ReportRangeQuery & { groupBy?: DeliveryPrecisionQuery["groupBy"] },
      opts: { seePrices: boolean } = { seePrices: true }
    ): Promise<DeliveryPrecisionResponse> {
      const range = resolveReportRange(query, stockholmToday());
      const groupBy = query.groupBy ?? "month";
      const [sales, purchase] = await Promise.all([
        repo.loadSalesPrecisionOrders(),
        repo.loadPurchasePrecisionOrders(),
      ]);
      return {
        ...range,
        groupBy,
        sales: await precisionSide("sales", sales, range, groupBy, opts.seePrices),
        purchase: await precisionSide("purchase", purchase, range, groupBy, opts.seePrices),
      };
    },

    // CSV export covers one side at a time — load only that side instead of
    // paying for both and discarding half.
    async getDeliveryPrecisionSection(
      kind: "sales" | "purchase",
      query: ReportRangeQuery & { groupBy?: DeliveryPrecisionQuery["groupBy"] },
      opts: { seePrices: boolean } = { seePrices: true }
    ): Promise<{ from: string; to: string; section: DeliveryPrecisionSide }> {
      const range = resolveReportRange(query, stockholmToday());
      const orders =
        kind === "sales" ? await repo.loadSalesPrecisionOrders() : await repo.loadPurchasePrecisionOrders();
      return { ...range, section: await precisionSide(kind, orders, range, query.groupBy ?? "month", opts.seePrices) };
    },

    async getCalculationOutcome(query: ReportRangeQuery): Promise<CalculationOutcomeResponse> {
      const range = resolveReportRange(query, stockholmToday());
      const calcs = await repo.loadCalculationRows();
      return { ...range, ...pairCalculationOutcomes(calcs, range) };
    },

    async getSalesStatistics(query: SalesStatisticsQuery): Promise<SalesStatisticsResponse> {
      const range = resolveReportRange(query, stockholmToday());
      const rows = await repo.loadSalesStatistics({ ...range, groupBy: query.groupBy });
      const totalNet = rows.reduce((sum, r) => sum + r.netAmount, 0);
      return { ...range, groupBy: query.groupBy, rows, totalNet };
    },

    async getPurchaseStatistics(query: PurchaseStatisticsQuery): Promise<PurchaseStatisticsResponse> {
      const range = resolveReportRange(query, stockholmToday());
      const { basis, rows } = await repo.loadPurchaseStatistics({ ...range, groupBy: query.groupBy });
      const totalNet = rows.reduce((sum, r) => sum + r.netAmount, 0);
      return { ...range, groupBy: query.groupBy, rows, totalNet, basis };
    },

    async getScrapStatistics(query: ScrapStatisticsQuery): Promise<ScrapStatisticsResponse> {
      const range = resolveReportRange(query, stockholmToday());
      const rows = await repo.loadScrapStatistics({ ...range, groupBy: query.groupBy });
      const totalScrapped = rows.reduce((sum, r) => sum + r.scrappedQuantity, 0);
      return { ...range, groupBy: query.groupBy, rows, totalScrapped };
    },
  };
}

export type ReportsService = ReturnType<typeof createReportsService>;
