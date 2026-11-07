import type { CalculatedPriceUnavailable, CostCalculationMarkupLevel, CostingMarkupLevel, OrderMarkupLevel } from "@navet/shared";

// Påslag per nivå (#16) — the ONE rule for which price markup applies. Pure:
// no DB, no settings lookup, so every reader (förkalkyl, efterkalkyl, the
// configurator's previewStructure, and from etapp 2 the Kalkylpris and the
// order's reading) resolves the same way and the rule is tested on its own.
//
// Only the two PRICE markups have levels — generellt påslag (on SVK) and
// materialpåslag (on dM + MO). The cost markups (MO, LO, Affo; TO per work
// center) decide TVK and SVK, which the standard cost, stock, efterkalkyl,
// PIA, the variance analysis and TB all read, so they stay the company's
// whoever buys.
//
// Field by field, never as a set: a customer that negotiated only the
// general markup does not repeat the material markup, and its empty material
// field must not hide the varugrupp's. null/absent = inherit the next level,
// 0 = explicitly 0 %. The company always has a value (0 from the start).
//
// Order, most specific first: trial (Pröva påslag on the Kalkyl tab) → order
// → customer → varugrupp → company. A calculation passes trial/group/company
// only (calculationMarkups below); an order row's Kalkylpris passes
// order/customer/group/company (orderRowMarkups below).

export interface LevelMarkups {
  generalMarkupPercent?: number | null;
  materialMarkupPercent?: number | null;
}

export interface CompanyMarkups {
  generalMarkupPercent: number;
  materialMarkupPercent: number;
}

export interface MarkupLevels {
  trial?: LevelMarkups | null;
  order?: LevelMarkups | null;
  customer?: LevelMarkups | null;
  group?: LevelMarkups | null;
  company: CompanyMarkups;
}

export interface ResolvedMarkup<L extends CostingMarkupLevel = CostingMarkupLevel> {
  percent: number;
  level: L;
}

export interface EffectiveMarkups<L extends CostingMarkupLevel = CostingMarkupLevel> {
  generalMarkup: ResolvedMarkup<L>;
  materialMarkup: ResolvedMarkup<L>;
}

// The levels above the company, most specific first.
const LEVEL_ORDER = ["trial", "order", "customer", "group"] as const;

// A resolved percentage at the scale the calculation's header stores it
// (numeric(6,2), toHeader's round(…, 2)) — the same formula, so rounding an
// already-rounded value changes nothing. markupPercentSchema bounds the range
// but not the decimals, nor does the company's setting: without this
// a tried 12.345 % priced the amounts at 12.345 while the header said 12.35,
// and the Kalkylpris delta against that header came out some öre wrong (the
// review of etapp 1). Every reader goes through effectiveMarkups, so the
// amounts and the stored percentage can no longer differ.
export function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function resolveField(levels: MarkupLevels, field: keyof LevelMarkups): ResolvedMarkup {
  for (const level of LEVEL_ORDER) {
    const value = levels[level]?.[field];
    if (value !== null && value !== undefined) return { percent: roundPercent(value), level };
  }
  return { percent: roundPercent(levels.company[field]), level: "company" };
}

export function effectiveMarkups(levels: MarkupLevels): EffectiveMarkups {
  return {
    generalMarkup: resolveField(levels, "generalMarkupPercent"),
    materialMarkup: resolveField(levels, "materialMarkupPercent"),
  };
}

function asCalculationLevel(resolved: ResolvedMarkup): ResolvedMarkup<CostCalculationMarkupLevel> {
  // Unreachable: calculationMarkups never passes an order or a customer.
  if (resolved.level === "order" || resolved.level === "customer") {
    throw new Error(`A calculation cannot carry the level ${resolved.level}`);
  }
  return { percent: resolved.percent, level: resolved.level };
}

// A calculation's price markups — varugrupp → företaget, or Pröva påslag —
// typed with the levels its header can store (costing_markup_level).
export function calculationMarkups(
  company: CompanyMarkups,
  group: LevelMarkups | null,
  trial: LevelMarkups | null = null
): EffectiveMarkups<CostCalculationMarkupLevel> {
  const resolved = effectiveMarkups({ trial, group, company });
  return {
    generalMarkup: asCalculationLevel(resolved.generalMarkup),
    materialMarkup: asCalculationLevel(resolved.materialMarkup),
  };
}

function asOrderLevel(resolved: ResolvedMarkup): ResolvedMarkup<OrderMarkupLevel> {
  // Unreachable: orderRowMarkups never passes a trial.
  if (resolved.level === "trial") throw new Error("An order row cannot carry the level trial");
  return { percent: resolved.percent, level: resolved.level };
}

// An order row's price markups (the Kalkylpris, #16 etapp 2): order →
// customer → the article's varugrupp → company, typed without trial.
export function orderRowMarkups(levels: Omit<MarkupLevels, "trial">): EffectiveMarkups<OrderMarkupLevel> {
  const resolved = effectiveMarkups(levels);
  return {
    generalMarkup: asOrderLevel(resolved.generalMarkup),
    materialMarkup: asOrderLevel(resolved.materialMarkup),
  };
}

// The price chain's Kalkylpris step applies only when the customer or the
// order has a price markup of its OWN — i.e. at least one field resolves on
// one of those levels. Without one the article's försäljningspris is the
// company's price, exactly as before #16. Checked before anything is read.
export function hasOwnMarkups(...levels: (LevelMarkups | null | undefined)[]): boolean {
  return levels.some((l) => (l?.generalMarkupPercent ?? null) !== null || (l?.materialMarkupPercent ?? null) !== null);
}

// What the Kalkylpris reads off the article's latest saved förkalkyl, as
// numbers: F₀ (sales_price), SVK (selfCost of the buckets), B
// (material_markup_base, null on an old multi-level calculation), g₀ and m₀
// (its own percentages) and q (its quantity).
export interface CalculationForPrice {
  salesPrice: number;
  selfCost: number;
  materialMarkupBase: number | null;
  generalMarkupPercent: number;
  materialMarkupPercent: number;
  quantity: number;
}

export type CalculatedUnitPrice = { unitPrice: number } | { unavailable: CalculatedPriceUnavailable };

// Kalkylpris per unit in SEK — a delta against the calculation itself:
//
//   P = F₀ + SVK × (g − g₀)/100 + B × (m − m₀)/100,   Kalkylpris/st = round4(P / q)
//
// Exact because every level prices on the same SVK and the same base
// (materialpåslag = m × B on every level of a multi-level calculation,
// costing.md). With g = g₀ and m = m₀ the delta is 0 and the answer is the
// one Sätt försäljningspris writes (round4(F₀ / q), the same arithmetic). g
// and m ≥ 0 keep P ≥ SVK + TO. Unavailable: q ≤ 0 ("no-calculation": no
// per-unit figure, as for Sätt försäljningspris), or B unknown while m ≠ m₀
// ("material-base-missing" — with m = m₀ the base is not needed).
export function calculatedUnitPrice(calculation: CalculationForPrice, generalPercent: number, materialPercent: number): CalculatedUnitPrice {
  if (!Number.isFinite(calculation.quantity) || calculation.quantity <= 0) return { unavailable: "no-calculation" };
  const generalDelta = generalPercent - calculation.generalMarkupPercent;
  const materialDelta = materialPercent - calculation.materialMarkupPercent;
  if (calculation.materialMarkupBase === null && materialDelta !== 0) return { unavailable: "material-base-missing" };
  const total =
    calculation.salesPrice +
    (calculation.selfCost * generalDelta) / 100 +
    ((calculation.materialMarkupBase ?? 0) * materialDelta) / 100;
  return { unitPrice: Math.round((total / calculation.quantity) * 10000) / 10000 };
}

// A nullable numeric(6,2) column as Drizzle hands it back ("40.00" | null).
export function percentOrNull(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}
