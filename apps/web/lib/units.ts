// Unit conversion helpers — mirror of packages/shared/src/units.ts (the API
// side). Kept as a local copy because Turbopack can't transpile the shared
// package's NodeNext-style ".js" imports; keep the two files in sync.
//
// Factor semantics: quantity_per_base = how many of the alternative unit one
// base unit equals (st article weighing 5 kg apiece → the kg row stores 5).
// Stored quantities/prices are always in the article's base unit.

export type UnitFactor = number | string | null | undefined;

// The operation's display unit for Tid/enhet (stored always in minutes per
// unit) — mirror of operationTimeUnits in packages/shared/src/manufacturing.ts.
export type OperationTimeUnit = "minutes_per_unit" | "units_per_hour" | "seconds_per_unit";

// Labels for the unit switch and every place a run time is shown.
export const OPERATION_TIME_UNIT_LABELS: Record<OperationTimeUnit, string> = {
  minutes_per_unit: "min/st",
  seconds_per_unit: "sek/st",
  units_per_hour: "st/h",
};

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

// Sekunder (sek/st, migration 0167): the stored minutes keep 4 decimals and
// the shown seconds 2, so a value typed in seconds reads back unchanged —
// 7 s → 0.1167 min → 7 s. Unlike st/h, 0 converts fine both ways.
export function secondsPerUnitToMinutesPerUnit(secondsPerUnit: number): number {
  return Math.round((secondsPerUnit / 60) * 10000) / 10000;
}

export function minutesPerUnitToSecondsPerUnit(minutesPerUnit: number): number {
  return Math.round(minutesPerUnit * 60 * 100) / 100;
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

// articles.rounding (Avrundning) — mirror of the API helper. The SERVER does
// the rounding on every order row and proposal; the web only uses this to
// preview what a typed quantity will become (in the base unit).
export function roundUpToMultiple(quantity: number, step: UnitFactor): number {
  const s = step === null || step === undefined || step === "" ? NaN : Number(step);
  if (!Number.isFinite(s) || s <= 0) return quantity;
  if (quantity <= 0) return quantity;
  const multiples = Math.ceil(Number((quantity / s).toFixed(6)));
  return round4(multiples * s);
}
