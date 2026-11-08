import { manufacturingCost, perUnit, selfCost, type CostBuckets } from "./cost-figures.js";

// Förkalkylera flera (#27) — the pure rules of the batch, no DB imports:
// which quantity an article is calculated with, the per-unit figures of a
// calculation and the change against the previous one. The DB work and the
// sequential run live in pre-calculation-batch.service.ts.

// Four decimals — the article's standard_cost/sales_price scale, and exactly
// the rounding applyStandardCostFromCalculation/applySalesPriceFromCalculation
// do before writing (costing.service.ts), so a previewed TVK/st IS the
// standard cost Sätt standardpris would write.
function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export type QuantitySource = "latest" | "fallback";

// The user's decision (spec 2026-11-08): an article is calculated with its
// latest saved förkalkyl's quantity; one without a saved förkalkyl with the
// chosen fallback. A latest calculation whose quantity is unusable (≤ 0,
// which the schema has refused since day one but a row could carry) counts
// as none — the fallback is used, never a quantity preCalculate would reject.
export function batchQuantity(
  latest: { quantity: number | string } | null | undefined,
  fallbackQuantity: number
): { quantity: number; quantitySource: QuantitySource } {
  const q = latest ? Number(latest.quantity) : NaN;
  if (Number.isFinite(q) && q > 0) return { quantity: q, quantitySource: "latest" };
  return { quantity: fallbackQuantity, quantitySource: "fallback" };
}

export interface PerUnitFigures {
  // TVK/st — what Sätt standardpris writes.
  manufacturingCostPerUnit: number;
  // SVK/st.
  selfCostPerUnit: number;
  // Pris/st — what Sätt försäljningspris writes.
  salesPricePerUnit: number;
}

// The card's three "per st" figures from a calculation (draft or stored):
// TVK/st, SVK/st and pris/st, each the stored total ÷ quantity through
// cost-figures.ts's perUnit (the one server-side division) and rounded to
// the article's four decimals. null when the quantity cannot carry a
// per-unit figure.
export function perUnitFigures(c: CostBuckets & { salesPrice: number | string; quantity: number | string }): PerUnitFigures | null {
  const manufacturing = perUnit(manufacturingCost(c), c.quantity);
  const self = perUnit(selfCost(c), c.quantity);
  const sales = perUnit(Number(c.salesPrice), c.quantity);
  if (manufacturing === null || self === null || sales === null) return null;
  return {
    manufacturingCostPerUnit: round(manufacturing, 4),
    selfCostPerUnit: round(self, 4),
    salesPricePerUnit: round(sales, 4),
  };
}

// Ändring: TVK/st now minus the previous förkalkyl's TVK/st, in kronor and in
// percent of the previous, both to two decimals. null without a previous
// calculation, when the previous TVK/st is unknown (unusable quantity) and
// when it is 0 — a percentage of nothing says nothing.
export function manufacturingCostChange(
  current: number,
  previousPerUnit: number | null | undefined
): { amount: number; percent: number } | null {
  if (previousPerUnit === null || previousPerUnit === undefined || previousPerUnit === 0) return null;
  const amount = current - previousPerUnit;
  return { amount: round(amount, 2), percent: round((amount / previousPerUnit) * 100, 2) };
}
