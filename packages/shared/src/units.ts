import { z } from "zod";

// Units register (enheter) + per-article alternative units with conversion
// factors. Factor semantics everywhere: quantity_per_base = how many of the
// alternative unit one base unit equals (st article weighing 5 kg apiece →
// the kg row stores factor 5). Stored quantities/prices are always in the
// article's base unit; rows entered in an alternative unit snapshot the
// factor for display.

export const createArticleUnitSchema = z.object({
  unitId: z.string().uuid(),
  quantityPerBase: z.coerce.number().positive(),
});
export type CreateArticleUnitInput = z.infer<typeof createArticleUnitSchema>;

export const updateArticleUnitSchema = z.object({
  quantityPerBase: z.coerce.number().positive(),
});
export type UpdateArticleUnitInput = z.infer<typeof updateArticleUnitSchema>;

// Numeric columns come back from postgres-js as strings — accept both.
export type UnitFactor = number | string | null | undefined;

const QUANTITY_SCALE = 4; // numeric(14,4) — storage scale for quantities/prices

function parseFactor(factor: UnitFactor): number {
  if (factor === null || factor === undefined) return 1;
  const n = typeof factor === "string" ? Number(factor) : factor;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
}

function round4(n: number): number {
  return Math.round(n * 10 ** QUANTITY_SCALE) / 10 ** QUANTITY_SCALE;
}

// Entered quantity in the row's unit → stored base-unit quantity.
export function toBaseQuantity(quantity: number, factor: UnitFactor): number {
  return round4(quantity / parseFactor(factor));
}

// Stored base-unit quantity → display quantity in the row's unit.
export function toUnitQuantity(baseQuantity: number, factor: UnitFactor): number {
  return round4(baseQuantity * parseFactor(factor));
}

// Prices convert in the opposite direction of quantities (kr/kg → kr/st).
export function toBasePrice(price: number, factor: UnitFactor): number {
  return round4(price * parseFactor(factor));
}

export function toUnitPrice(basePrice: number, factor: UnitFactor): number {
  return round4(basePrice / parseFactor(factor));
}

// Routing/MO operation time — "Tid/enhet" is always stored/returned in
// minutes per unit (canonical, used unchanged by costing, capacity planning,
// import and the external configurator API). The per-operation time_unit is
// a pure display preference: st/h (units per hour) is converted at the edges
// only. The round-trip is not exact — round4(60/round2(60/x)) can drift from
// x in the last digit(s) — so a value re-entered as e.g. 7 st/h is stored as
// 8.5714 min/st, which displays back as 7 st/h again, but a value that started
// life in minutes and gets toggled to st/h and back may show a tiny drift.
// This is accepted: the drift is presentational only, never re-persisted
// silently (a save always writes exactly what the active unit's field shows).
export function unitsPerHourToMinutesPerUnit(unitsPerHour: number): number {
  return Math.round((60 / unitsPerHour) * 10000) / 10000;
}

export function minutesPerUnitToUnitsPerHour(minutesPerUnit: number): number {
  return Math.round((60 / minutesPerUnit) * 100) / 100;
}

// articles.rounding (Avrundning): proposals from behovsberäkningen and the
// quantity on every order row (IO/förfrågan/KO/TO) are rounded UP to the
// nearest multiple of the step, always in the article's BASE unit — the
// services call this after toBaseQuantity. Applied after order_quantity's own
// multiple (which also acts as a minimum): 100 kg ordered in 7.38 kg bars is
// 103.32 kg, 14 whole bars. No usable step (null, "", 0, negative) leaves the
// quantity untouched, and 0 never rounds up to a step. toFixed(6) is the same
// float-noise guard requirements-calc uses for order_quantity (0.1 + 0.2
// over 0.3 must be 1 multiple, not 2).
export function roundUpToMultiple(quantity: number, step: UnitFactor): number {
  const s = step === null || step === undefined || step === "" ? NaN : Number(step);
  if (!Number.isFinite(s) || s <= 0) return quantity;
  if (quantity <= 0) return quantity;
  const multiples = Math.ceil(Number((quantity / s).toFixed(6)));
  return round4(multiples * s);
}
