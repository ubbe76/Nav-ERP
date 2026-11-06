import type { CostVarianceAnalysis, CostVarianceOperationRow } from "./types";

// Presentation rules for the Avvikelseanalys (#14). The server has computed
// every figure; this only decides what is worth showing and how a deviation is
// signed. A positive deviation means dearer than kalkylerat.

// Amounts are rounded to öre by the server, so anything under half an öre is
// a zero (and never "+0,00" or "−0,00").
export function isZeroAmount(value: number): boolean {
  return Math.abs(value) < 0.005;
}

export type DeviationTone = "dearer" | "cheaper" | "none";

export function deviationTone(value: number): DeviationTone {
  if (isZeroAmount(value)) return "none";
  return value > 0 ? "dearer" : "cheaper";
}

// The words that carry the tone besides colour (screen readers, print).
export const DEVIATION_TONE_TEXT: Record<DeviationTone, string> = {
  dearer: "dyrare än kalkylerat",
  cheaper: "billigare än kalkylerat",
  none: "ingen avvikelse",
};

export interface VarianceSummaryLine {
  key: "price" | "quantity" | "scrap" | "rate" | "setup" | "run" | "unclassified" | "markups";
  label: string;
  amount: number;
  // "varav" line: shown indented and not part of the sum.
  sub?: boolean;
}

function timeRows(analysis: CostVarianceAnalysis) {
  return analysis.operationRows.filter((r): r is Extract<CostVarianceOperationRow, { kind: "time" }> => r.kind === "time");
}

// The parts that exist for this analysis, in the order of the spec: Pris,
// Mängd (varav kassation), [Timpris], Ställ, Stycke, Ej uppdelad, Påslag.
// Pris and Mängd always show; the time parts only when some operation has
// time to explain (a split operation puts it in Ställ/Stycke, any other in
// Ej uppdelad), Timpris and Påslag only when nonzero. Pris + Mängd + the time
// parts + Påslag (+ Timpris) = Avvikelse; "varav kassation" is not added.
export function varianceSummaryLines(analysis: CostVarianceAnalysis): VarianceSummaryLine[] {
  const { parts } = analysis;
  const ops = timeRows(analysis);
  // An operation with no reported time counts as split too (its whole deviation
  // is planned time not used), but it has nothing to show unless the amount is nonzero.
  const hasSplit = ops.some((r) => r.split && r.hours > 0);  // nonzero amounts are covered by the checks below
  const hasUnclassified = ops.some((r) => !r.split && (r.hours !== 0 || r.baseSetupHours || r.baseRunHours));
  const lines: VarianceSummaryLine[] = [
    { key: "price", label: "Pris", amount: parts.price },
    { key: "quantity", label: "Mängd", amount: parts.quantity },
  ];
  if (!isZeroAmount(parts.scrap)) lines.push({ key: "scrap", label: "varav kassation", amount: parts.scrap, sub: true });
  if (!isZeroAmount(parts.rate)) lines.push({ key: "rate", label: "Timpris", amount: parts.rate });
  if (hasSplit || !isZeroAmount(parts.setup)) lines.push({ key: "setup", label: "Ställ", amount: parts.setup });
  if (hasSplit || !isZeroAmount(parts.run)) lines.push({ key: "run", label: "Stycke", amount: parts.run });
  if (hasUnclassified || !isZeroAmount(parts.unclassified)) {
    lines.push({ key: "unclassified", label: "Ej uppdelad", amount: parts.unclassified });
  }
  if (!isZeroAmount(parts.markups)) lines.push({ key: "markups", label: "Påslag", amount: parts.markups });
  return lines;
}

// Timpris (#14 etapp 4): the hourly rate's deviation — Lön at each work day's
// rate against R₀ at T₀. A column of its own on the specification's
// Operationer only when some row has one; otherwise it is 0 everywhere.
export function hasRateDeviation(rows: Array<{ parts: { rate: number } }>): boolean {
  return rows.some((row) => !isZeroAmount(row.parts.rate));
}

export const PRELIMINARY_NOTICE = "Ordern är inte klar — kalkylerat räknas på klart antal per operation.";
export const OLD_CALCULATION_NOTICE =
  "Sparad före avvikelseanalysen — efterkalkylera och spara igen för att få den.";
