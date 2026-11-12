// F2: CSV siblings of the F1 reports. Pure builders (no DB) — they flatten
// the JSON response shapes reports.service.ts already produces into
// semicolon rows using the shared Excel-friendly CSV conventions
// (@navet/shared's buildCsv).
import { exportTable, tableCsv, type ExportTable, type CsvColumn } from "@navet/shared";
import type { PrecisionMonth } from "./delivery-precision-calc.js";
import type { CounterpartyPrecisionRow, CounterpartyPrecisionTotals } from "./delivery-quality-calc.js";
import type {
  AnalysisArticleRow,
  AnalysisOrderRow,
  AnalysisOutcomeResult,
  AnalysisWorkCenterRow,
  OutcomeAmounts,
  OutcomeRow,
} from "./calc-outcome-calc.js";
import type { MarginGroup } from "./order-margin-calc.js";
import type {
  PurchaseStatisticsResponse,
  SalesStatisticsResponse,
  ScrapStatisticsResponse,
  StatisticsRowResponse,
  ScrapStatisticsRowResponse,
} from "./reports.service.js";

// För tidiga only when the side's early margin is on (#29) — the same rule
// as the web table; off, every non-late delivery is I tid.
export function buildDeliveryPrecisionTable(months: PrecisionMonth[], opts: { early: boolean }): ExportTable {
  const columns: CsvColumn<PrecisionMonth>[] = [
    { label: "Månad", value: (r) => r.month },
    { label: "Antal ordrar", value: (r) => r.total },
    ...(opts.early ? [{ label: "För tidiga", value: (r: PrecisionMonth) => r.early }] : []),
    { label: "I tid", value: (r) => r.onTime },
    { label: "Försenade", value: (r) => r.late },
    { label: "Precision %", cell: "percent", value: (r) => r.precisionPct },
    { label: "Snitt försening (dagar)", value: (r) => r.avgDaysLate, format: "number" },
  ];
  return exportTable(columns, months);
}

// Gruppera: Motpart — one row per supplier/customer plus a Totalt row.
// Reklamerat antal is blank where the units are mixed (the web shows "—").
export function buildCounterpartyPrecisionTable(
  grouped: { rows: CounterpartyPrecisionRow[]; totals: CounterpartyPrecisionTotals },
  opts: { kind: "sales" | "purchase"; seePrices: boolean; early: boolean }
): ExportTable {
  type Row = Omit<CounterpartyPrecisionRow, "counterpartyId">;
  const columns: CsvColumn<Row>[] = [
    { label: opts.kind === "sales" ? "Kund" : "Leverantör", value: (r) => r.counterpartyName },
    { label: "Antal ordrar", value: (r) => r.total },
    ...(opts.early ? [{ label: "För tidiga", value: (r: Row) => r.early }] : []),
    { label: "I tid", value: (r) => r.onTime },
    { label: "Försenade", value: (r) => r.late },
    { label: "Precision %", cell: "percent", value: (r) => r.precisionPct },
    { label: "Snitt försening (dagar)", value: (r) => r.avgDaysLate, format: "number" },
    { label: "Avvikelser", value: (r) => r.deviations },
    { label: "Order med avvikelse", value: (r) => r.ordersWithDeviation },
    { label: "Andel felfria %", cell: "percent", value: (r) => r.defectFreePct },
    { label: "Reklamerat antal", value: (r) => r.claimedQuantity, format: "number" },
    { label: "Enhet", value: (r) => r.claimedUnit },
    ...(opts.seePrices ? [{ label: "Avvikelsekostnad", value: (r: Row) => r.deviationCost, format: "money" as const }] : []),
  ];
  return exportTable(columns, [...grouped.rows, { ...grouped.totals, counterpartyName: "Totalt" }]);
}

const STATISTICS_COLUMNS: CsvColumn<StatisticsRowResponse>[] = [
  { label: "Grupp", value: (r) => r.label },
  { label: "Nettobelopp", value: (r) => r.netAmount, format: "money" },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "Antal fakturor", value: (r) => r.invoiceCount },
];

export function buildSalesStatisticsTable(response: SalesStatisticsResponse): ExportTable {
  return exportTable(STATISTICS_COLUMNS, response.rows);
}

export function buildPurchaseStatisticsTable(response: PurchaseStatisticsResponse): ExportTable {
  return exportTable(STATISTICS_COLUMNS, response.rows);
}

const SCRAP_COLUMNS: CsvColumn<ScrapStatisticsRowResponse>[] = [
  { label: "Grupp", value: (r) => r.label },
  { label: "Kasserat antal", value: (r) => r.scrappedQuantity, format: "number" },
  { label: "Antal rapporter", value: (r) => r.reportCount },
];

export function buildScrapStatisticsTable(response: ScrapStatisticsResponse): ExportTable {
  return exportTable(SCRAP_COLUMNS, response.rows);
}

// Mot förkalkyl. Efterkalkyl TVK/st is per Inlevererat on a final analysis,
// otherwise per Antal — the column "Delat med" says which.
const CALC_OUTCOME_COLUMNS: CsvColumn<OutcomeRow>[] = [
  { label: "TO", value: (r) => r.orderNumber },
  { label: "Artikel", value: (r) => r.articleNumber },
  { label: "Benämning", value: (r) => r.articleName },
  { label: "Antal", value: (r) => r.quantity, format: "number" },
  { label: "Inlevererat", value: (r) => r.outputQuantity, format: "number" },
  { label: "Förkalkyl TVK/st", value: (r) => r.preTvkPerUnit, format: "money" },
  { label: "Kalkylerat TVK/st", value: (r) => r.calculatedTvkPerUnit, format: "money" },
  { label: "Efterkalkyl TVK/st", value: (r) => r.postTvkPerUnit, format: "money" },
  { label: "Avvikelse/st", value: (r) => r.deltaPerUnit, format: "money" },
  { label: "Avvikelse %", cell: "percent", value: (r) => r.deltaPct, format: "number" },
  { label: "Delat med", value: (r) => (r.perUnitBasis === "output" ? "Inlevererat" : "Antal") },
  { label: "Förkalkyl", value: (r) => (r.preSource === "configuration" ? "Konfiguration" : "Artikel") },
  { label: "Flernivå", value: (r) => (r.preMultiLevel ? "Ja" : "") },
  { label: "Ej klar", value: (r) => (r.preliminary ? "Ja" : "") },
  { label: "Förkalkylerad", value: (r) => r.preCalculatedAt, format: "datetime" },
  { label: "Efterkalkylerad", value: (r) => r.postCalculatedAt, format: "datetime" },
];

// Avvikelseanalys: the amounts every grouping shares, varav kassation as a
// column of its own (part of Mängd, not added) and Timpris (0 until the
// hourly rate has a history) so the row adds up on its own.
function amountColumns<T extends OutcomeAmounts>(): CsvColumn<T>[] {
  return [
    { label: "Kalkylerat", value: (r) => r.base, format: "money" },
    { label: "Utfall", value: (r) => r.actual, format: "money" },
    { label: "Avvikelse", value: (r) => r.deviation, format: "money" },
    { label: "Avvikelse %", cell: "percent", value: (r) => r.deviationPct, format: "number" },
    { label: "Pris", value: (r) => r.parts.price, format: "money" },
    { label: "Mängd", value: (r) => r.parts.quantity, format: "money" },
    { label: "varav kassation", value: (r) => r.parts.scrap, format: "money" },
    { label: "Timpris", value: (r) => r.parts.rate, format: "money" },
    { label: "Ställ", value: (r) => r.parts.setup, format: "money" },
    { label: "Stycke", value: (r) => r.parts.run, format: "money" },
    { label: "Ej uppdelad", value: (r) => r.parts.unclassified, format: "money" },
    { label: "Påslag", value: (r) => r.parts.markups, format: "money" },
  ];
}

type Total<T> = Partial<T> & OutcomeAmounts;

const ANALYSIS_ORDER_COLUMNS: CsvColumn<Total<AnalysisOrderRow>>[] = [
  { label: "TO", value: (r) => r.orderNumber },
  { label: "Artikel", value: (r) => r.articleNumber },
  { label: "Benämning", value: (r) => r.articleName },
  { label: "Efterkalkylerad", value: (r) => r.calculatedAt, format: "datetime" },
  { label: "Inlevererat", value: (r) => r.outputQuantity, format: "number" },
  ...amountColumns<Total<AnalysisOrderRow>>(),
];

const ANALYSIS_ARTICLE_COLUMNS: CsvColumn<Total<AnalysisArticleRow>>[] = [
  { label: "Artikel", value: (r) => r.articleNumber },
  { label: "Benämning", value: (r) => r.articleName },
  { label: "Antal TO", value: (r) => r.orderCount },
  { label: "Inlevererat", value: (r) => r.outputQuantity, format: "number" },
  ...amountColumns<Total<AnalysisArticleRow>>(),
];

const ANALYSIS_WORK_CENTER_COLUMNS: CsvColumn<Total<AnalysisWorkCenterRow>>[] = [
  { label: "Resurs", value: (r) => r.workCenterCode },
  { label: "Benämning", value: (r) => r.workCenterName },
  { label: "Typ", value: (r) => (r.kind === undefined ? "" : r.kind === "subcontract" ? "Lego" : "Tid") },
  { label: "Antal operationer", value: (r) => r.operationCount },
  { label: "Antal TO", value: (r) => r.orderCount },
  { label: "Planerad ställ (h)", value: (r) => r.baseSetupHours, format: "number" },
  { label: "Verklig ställ (h)", value: (r) => r.setupHours, format: "number" },
  { label: "Planerad stycke (h)", value: (r) => r.baseRunHours, format: "number" },
  { label: "Verklig stycke (h)", value: (r) => r.runHours, format: "number" },
  { label: "Ej uppdelad (h)", value: (r) => r.unclassifiedHours, format: "number" },
  { label: "Rapporterad tid (h)", value: (r) => r.hours, format: "number" },
  { label: "Tidsavvikelse", value: (r) => r.timeDeviation, format: "money" },
  { label: "Kalkylerat antal", value: (r) => r.baseQuantity, format: "number" },
  { label: "Mottaget antal", value: (r) => r.subcontractQuantity, format: "number" },
  ...amountColumns<Total<AnalysisWorkCenterRow>>(),
];

// One row per group plus a Totalt row, so the file reconciles on its own.
export function buildCalculationOutcomeAnalysisTable(result: AnalysisOutcomeResult): ExportTable {
  switch (result.groupBy) {
    case "order":
      return exportTable(ANALYSIS_ORDER_COLUMNS, [
        ...(result.rows as AnalysisOrderRow[]),
        { ...result.totals, orderNumber: "Totalt" },
      ]);
    case "article":
      return exportTable(ANALYSIS_ARTICLE_COLUMNS, [
        ...(result.rows as AnalysisArticleRow[]),
        { ...result.totals, articleNumber: "Totalt", orderCount: result.counts.analysed },
      ]);
    case "workCenter":
      return exportTable(ANALYSIS_WORK_CENTER_COLUMNS, [
        ...(result.rows as AnalysisWorkCenterRow[]),
        { ...result.totals, workCenterCode: "Totalt" },
      ]);
  }
}

const ORDER_MARGIN_COLUMNS: CsvColumn<MarginGroup>[] = [
  { label: "Grupp", value: (r) => r.label },
  { label: "Nettoomsättning", value: (r) => r.netRevenue, format: "money" },
  { label: "Varav med kalkyl", value: (r) => r.costedNetRevenue, format: "money" },
  { label: "Självkostnad", value: (r) => r.cost, format: "money" },
  { label: "Täckningsbidrag", value: (r) => r.contribution, format: "money" },
  { label: "Täckningsgrad %", cell: "percent", value: (r) => r.marginPercent, format: "number" },
  { label: "Rader utan kalkyl", value: (r) => r.rowsWithoutCost, format: "number" },
];

export function buildOrderMarginTable(result: { groups: MarginGroup[]; total: MarginGroup }): ExportTable {
  // The total is appended as an ordinary row so the file reconciles on its own
  // — the same shape the other statistics exports use.
  return exportTable(ORDER_MARGIN_COLUMNS, [...result.groups, result.total]);
}

export function buildCalculationOutcomeTable(rows: OutcomeRow[]): ExportTable {
  return exportTable(CALC_OUTCOME_COLUMNS, rows);
}

// The CSV rendering of each table above — the Excel twin renders the same
// table (system/service/table-export.ts).
export function buildDeliveryPrecisionCsv(...args: Parameters<typeof buildDeliveryPrecisionTable>): string {
  return tableCsv(buildDeliveryPrecisionTable(...args));
}
export function buildCounterpartyPrecisionCsv(...args: Parameters<typeof buildCounterpartyPrecisionTable>): string {
  return tableCsv(buildCounterpartyPrecisionTable(...args));
}
export function buildSalesStatisticsCsv(...args: Parameters<typeof buildSalesStatisticsTable>): string {
  return tableCsv(buildSalesStatisticsTable(...args));
}
export function buildPurchaseStatisticsCsv(...args: Parameters<typeof buildPurchaseStatisticsTable>): string {
  return tableCsv(buildPurchaseStatisticsTable(...args));
}
export function buildScrapStatisticsCsv(...args: Parameters<typeof buildScrapStatisticsTable>): string {
  return tableCsv(buildScrapStatisticsTable(...args));
}
export function buildCalculationOutcomeAnalysisCsv(...args: Parameters<typeof buildCalculationOutcomeAnalysisTable>): string {
  return tableCsv(buildCalculationOutcomeAnalysisTable(...args));
}
export function buildOrderMarginCsv(...args: Parameters<typeof buildOrderMarginTable>): string {
  return tableCsv(buildOrderMarginTable(...args));
}
export function buildCalculationOutcomeCsv(...args: Parameters<typeof buildCalculationOutcomeTable>): string {
  return tableCsv(buildCalculationOutcomeTable(...args));
}
