import { z } from "zod";
import type { OperationTimeUnit } from "./manufacturing.js";
import { round2, round4, roundToDecimals } from "./money.js";
import { blankSafe, numericMax, numericStep } from "./coerce.js";

// Units register (enheter) + per-article alternative units with conversion
// factors. Factor semantics everywhere: quantity_per_base = how many of the
// alternative unit one base unit equals (st article weighing 5 kg apiece →
// the kg row stores factor 5). Stored quantities/prices are always in the
// article's base unit; rows entered in an alternative unit snapshot the
// factor for display.

export const createArticleUnitSchema = z.object({
  unitId: z.string().uuid(),
  quantityPerBase: blankSafe(z.coerce.number().min(numericStep(6)).max(numericMax(16, 6))),
});
export type CreateArticleUnitInput = z.infer<typeof createArticleUnitSchema>;

export const updateArticleUnitSchema = z.object({
  quantityPerBase: blankSafe(z.coerce.number().min(numericStep(6)).max(numericMax(16, 6))),
});
export type UpdateArticleUnitInput = z.infer<typeof updateArticleUnitSchema>;

// Numeric columns come back from postgres-js as strings — accept both.
export type UnitFactor = number | string | null | undefined;


function parseFactor(factor: UnitFactor): number {
  if (factor === null || factor === undefined) return 1;
  const n = typeof factor === "string" ? Number(factor) : factor;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return n;
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
// a pure display preference: st/h (units per hour) and sek/st are converted
// at the edges only.
//
// The stored minutes keep RUN_TIME_DECIMALS (numeric(14,8), migration 0218 —
// 4 decimals made 0,05 s/st 0,048 s and 36 000 st/h 35 294 st/h). Every
// conversion INTO minutes rounds with roundRunTime, never round4.
export const RUN_TIME_DECIMALS = 8;
export function roundRunTime(minutesPerUnit: number): number {
  return roundToDecimals(minutesPerUnit, RUN_TIME_DECIMALS);
}

export function unitsPerHourToMinutesPerUnit(unitsPerHour: number): number {
  return roundRunTime(60 / unitsPerHour);
}

// The st/h shown for stored minutes: the SHORTEST number (at most 2 decimals)
// that converts back to exactly those minutes — 36 000 st/h is stored as
// 0.00166667 min, which is 35 999,99 st/h rounded but 36 000 shortest. A
// typed st/h therefore reads back unchanged (up to ~77 000 st/h every whole
// number does); minutes typed as minutes (13 min/st = 4,615… st/h) have no
// short st/h and show rounded to 2 decimals as before. A save never converts
// the shown st/h back (the dialog keeps the stored minutes until typed over).
export function minutesPerUnitToUnitsPerHour(minutesPerUnit: number): number {
  const exact = 60 / minutesPerUnit;
  for (let digits = 1; digits <= 15; digits++) {
    const candidate = Number(exact.toPrecision(digits));
    if (candidate !== round2(candidate)) break;
    if (unitsPerHourToMinutesPerUnit(candidate) === minutesPerUnit) return candidate;
  }
  return round2(exact);
}

// Sekunder (sek/st, migration 0167): the shown seconds keep 2 decimals, so a
// value typed in seconds reads back unchanged — 7 s → 0.11666667 min → 7 s,
// 0,05 s → 0.00083333 min → 0,05 s. Unlike st/h, 0 converts fine both ways.
export function secondsPerUnitToMinutesPerUnit(secondsPerUnit: number): number {
  return roundRunTime(secondsPerUnit / 60);
}

export function minutesPerUnitToSecondsPerUnit(minutesPerUnit: number): number {
  return round2(minutesPerUnit * 60);
}

// The operation's run time (stored in minutes per unit) in its display unit,
// and back — the one place the three units meet. 0 has no st/h value; the
// callers keep their own guard for that (they show it in minutes instead).
export function runTimeInUnit(minutesPerUnit: number, unit: OperationTimeUnit): number {
  if (unit === "units_per_hour") return minutesPerUnitToUnitsPerHour(minutesPerUnit);
  if (unit === "seconds_per_unit") return minutesPerUnitToSecondsPerUnit(minutesPerUnit);
  return minutesPerUnit;
}

export function runTimeToMinutes(value: number, unit: OperationTimeUnit): number {
  if (unit === "units_per_hour") return unitsPerHourToMinutesPerUnit(value);
  if (unit === "seconds_per_unit") return secondsPerUnitToMinutesPerUnit(value);
  return value;
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
