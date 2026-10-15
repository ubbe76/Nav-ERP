// F2: CSV siblings of the F1 reports. Pure builders (no DB) — they flatten
// the JSON response shapes reports.service.ts already produces into
// semicolon rows using the shared Excel-friendly CSV conventions
// (@navet/shared's buildCsv).
import { buildCsv, type CsvColumn } from "@navet/shared";
import type { PrecisionMonth } from "./delivery-precision-calc.js";
import type { OutcomeRow } from "./calc-outcome-calc.js";
import type { MarginGroup } from "./order-margin-calc.js";
import type {
  PurchaseStatisticsResponse,
  SalesStatisticsResponse,
  ScrapStatisticsResponse,
  StatisticsRowResponse,
  ScrapStatisticsRowResponse,
} from "./reports.service.js";

const PRECISION_COLUMNS: CsvColumn<PrecisionMonth>[] = [
  { label: "Månad", value: (r) => r.month },
  { label: "Antal ordrar", value: (r) => r.total },
  { label: "I tid", value: (r) => r.onTime },
  { label: "Försenade", value: (r) => r.late },
  { label: "Precision %", value: (r) => r.precisionPct },
  { label: "Snitt försening (dagar)", value: (r) => r.avgDaysLate, format: "number" },
];

export function buildDeliveryPrecisionCsv(months: PrecisionMonth[]): string {
  return buildCsv(PRECISION_COLUMNS, months);
}

const STATISTICS_COLUMNS: CsvColumn<StatisticsRowResponse>[] = [
  { label: "Grupp", value: (r) => r.label },
  { label: "Nettobelopp", value: (r) => r.netAmount, format: "money" },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "Antal fakturor", value: (r) => r.invoiceCount },
];

export function buildSalesStatisticsCsv(response: SalesStatisticsResponse): string {
  return buildCsv(STATISTICS_COLUMNS, response.rows);
}

export function buildPurchaseStatisticsCsv(response: PurchaseStatisticsResponse): string {
  return buildCsv(STATISTICS_COLUMNS, response.rows);
}

const SCRAP_COLUMNS: CsvColumn<ScrapStatisticsRowResponse>[] = [
  { label: "Grupp", value: (r) => r.label },
  { label: "Kasserat antal", value: (r) => r.scrappedQuantity, format: "number" },
  { label: "Antal rapporter", value: (r) => r.reportCount },
];

export function buildScrapStatisticsCsv(response: ScrapStatisticsResponse): string {
  return buildCsv(SCRAP_COLUMNS, response.rows);
}

const CALC_OUTCOME_COLUMNS: CsvColumn<OutcomeRow>[] = [
  { label: "TO", value: (r) => r.orderNumber },
  { label: "Artikel", value: (r) => r.articleNumber },
  { label: "Benämning", value: (r) => r.articleName },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "Förkalkyl TVK/st", value: (r) => r.preTvkPerUnit, format: "money" },
  { label: "Efterkalkyl TVK/st", value: (r) => r.postTvkPerUnit, format: "money" },
  { label: "Avvikelse/st", value: (r) => r.deltaPerUnit, format: "money" },
  { label: "Avvikelse %", value: (r) => r.deltaPct, format: "number" },
  { label: "Flernivå", value: (r) => (r.preMultiLevel ? "Ja" : "") },
];

const ORDER_MARGIN_COLUMNS: CsvColumn<MarginGroup>[] = [
  { label: "Grupp", value: (r) => r.label },
  { label: "Nettoomsättning", value: (r) => r.netRevenue, format: "money" },
  { label: "Varav med kalkyl", value: (r) => r.costedNetRevenue, format: "money" },
  { label: "Självkostnad", value: (r) => r.cost, format: "money" },
  { label: "Täckningsbidrag", value: (r) => r.contribution, format: "money" },
  { label: "Täckningsgrad %", value: (r) => r.marginPercent, format: "number" },
  { label: "Rader utan kalkyl", value: (r) => r.rowsWithoutCost, format: "number" },
];

export function buildOrderMarginCsv(result: { groups: MarginGroup[]; total: MarginGroup }): string {
  // The total is appended as an ordinary row so the file reconciles on its own
  // — the same shape the other statistics exports use.
  return buildCsv(ORDER_MARGIN_COLUMNS, [...result.groups, result.total]);
}

export function buildCalculationOutcomeCsv(rows: OutcomeRow[]): string {
  return buildCsv(CALC_OUTCOME_COLUMNS, rows);
}
