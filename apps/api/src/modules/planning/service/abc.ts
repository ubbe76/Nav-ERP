// ABC-klassning (#10, etapp 2) — pure like forecast.ts: the repository
// loads the selected articles, their standard cost and the förbrukning over
// the period (consumptionByMonth, the ONE consumption definition shared with
// the prognos); this module turns them into the classes. Derived at every
// read, nothing stored. ONE implementation for GET /planning/abc, the
// article register's ABC column/filter and the article card.
//
// Rules (spec 2026-11-07-prognos-abc-design.md, "ABC-klassning"):
// - Förbrukningsvärde = consumed quantity in the period × the article's
//   current standard cost. No standard cost with consumption ⇒ value 0 and
//   the flag missingStandardCost. A consumption ≤ 0 (nothing drawn, or an
//   undo inside the period of a draw before it) ⇒ value 0.
// - Sort by value descending, article number ascending as the tie-break.
// - Class by the cumulative share of the total BEFORE the article: A while
//   it is below the A limit, B while below the B limit, else C. Value 0 ⇒
//   always C. Total 0 ⇒ every article C.
// - Shares are percent of the total value (two decimals in the answer; the
//   class is decided on the exact cumulative sum).
import type { AbcClass } from "@navet/shared";
import type { AbcLimits } from "../../system/service/plan-settings.js";

export type { AbcClass };

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

export interface AbcInputRow {
  articleId: string;
  articleNumber: string;
  consumed: number;
  standardCost: number | null;
}

export interface AbcClassification {
  value: number;
  // Percent of the total value (0 when the total is 0).
  share: number;
  // Percent of the total value through this article (sorted order).
  cumulativeShare: number;
  abcClass: AbcClass;
  missingStandardCost: boolean;
}

export interface AbcSummaryRow {
  abcClass: AbcClass;
  count: number;
  value: number;
  share: number;
}

export interface AbcResult<T extends AbcInputRow> {
  rows: (T & AbcClassification)[];
  total: number;
  summary: AbcSummaryRow[];
}

// The förbrukningsvärde of one article — ONE place for the flag's rule too.
export function abcValue(row: Pick<AbcInputRow, "consumed" | "standardCost">): { value: number; missingStandardCost: boolean } {
  if (row.consumed <= 0) return { value: 0, missingStandardCost: false };
  if (row.standardCost === null) return { value: 0, missingStandardCost: true };
  return { value: round4(row.consumed * row.standardCost), missingStandardCost: false };
}

export function classifyAbc<T extends AbcInputRow>(rows: readonly T[], limits: AbcLimits): AbcResult<T> {
  const valued = rows.map((row) => ({ row, ...abcValue(row) }));
  valued.sort((a, b) => b.value - a.value || (a.row.articleNumber < b.row.articleNumber ? -1 : a.row.articleNumber > b.row.articleNumber ? 1 : 0));
  const total = round4(valued.reduce((sum, v) => sum + v.value, 0));
  const summary = new Map<AbcClass, AbcSummaryRow>(
    (["A", "B", "C"] as const).map((abcClass) => [abcClass, { abcClass, count: 0, value: 0, share: 0 }])
  );
  // The boundary is decided in ONE scale, exactly: the running sum is
  // rounded to the same 4 decimals as the values and the total, both are
  // taken as integers in ten-thousandths, and "share before < limit" is
  // compared as cumulative × 100 < limit × total — integer arithmetic, no
  // division, so an article that ends exactly on the A limit is the last A
  // and the next one starts B (a float quotient like 79.99999 or 80.00001
  // would decide it at random).
  const units = (n: number) => Math.round(n * 1e4);
  const totalUnits = units(total);
  let cumulative = 0;
  const out = valued.map(({ row, value, missingStandardCost }) => {
    const before = units(cumulative);
    cumulative = round4(cumulative + value);
    let abcClass: AbcClass = "C";
    if (value > 0 && total > 0) {
      if (before * 100 < limits.aPercent * totalUnits) abcClass = "A";
      else if (before * 100 < limits.bPercent * totalUnits) abcClass = "B";
    }
    const entry = summary.get(abcClass)!;
    entry.count++;
    entry.value = round4(entry.value + value);
    return {
      ...row,
      value,
      share: total > 0 ? round2((value / total) * 100) : 0,
      cumulativeShare: total > 0 ? round2((cumulative / total) * 100) : 0,
      abcClass,
      missingStandardCost,
    };
  });
  for (const entry of summary.values()) entry.share = total > 0 ? round2((entry.value / total) * 100) : 0;
  return { rows: out, total, summary: [...summary.values()] };
}
