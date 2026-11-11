// Avvikelseanalys i efterkalkylen (#14) — pure: no DB imports, ONE
// implementation. Spec: private/superpowers/specs/2026-11-06-avvikelseanalys-
// efterkalkyl-design.md (Formlerna).
//
// Two halves:
// - the base rules (which quantity N each row is calculated for, whether the
//   setup/one-off counts, the scrapped share) that computePostCalculation
//   applies when it computes the base it SAVES on the efterkalkyl's rows;
// - costVarianceAnalysis, which DERIVES the parts from those saved inputs on
//   every read (GET /cost-calculations/:id, the post-calculate preview and,
//   in etapp 2, Kalkylutfall). Nothing derived is stored.
//
// Kalkylerat (base) = the order's own rows for N, priced with the förkalkyl's
// rules as of T₀; Utfall (actual) = the efterkalkyl's rows. For the order
// both are a TVK, summed the same way (the base's from its rows, the
// efterkalkyl's from its header). Per row and for the order: Utfall −
// Kalkylerat = Σ parts, exactly — every amount is whole öre and the sums are
// integer arithmetic.
import {
  round2,
  type CostingMaterialSource,
  type CostMaterialRowKind,
  type CostPriceSource,
  type CostVarianceAnalysis,
  type CostVarianceMaterialRow,
  type CostVarianceOperationRow,
  type CostVarianceParts,
  round4,
} from "@navet/shared";
import { manufacturingCost, type ManufacturingCostBuckets } from "./cost-figures.js";

// ---------------------------------------------------------------------------
// The base rules
// ---------------------------------------------------------------------------

export interface OutputContext {
  // The order is not Klar/Stängd.
  preliminary: boolean;
  // Inlevererat — manufacturing_orders.quantity_received.
  received: number;
}

// Klar, Stängd and Makulerad are final; Frisläppt, Pågår and an older
// Planerad give a preliminary analysis. Makulerad is final with N = the
// received quantity (normally 0): its time reports outlive the cancellation,
// so what was spent on it shows as a deviation instead of the order staying
// out of Kalkylutfall for good.
const FINAL_STATUSES = new Set(["done", "closed", "cancelled"]);
export function isPreliminaryStatus(status: string): boolean {
  return !FINAL_STATUSES.has(status);
}

// N for an operation's time, its lego and the material linked to it: the
// received quantity on a final order (kassation and överrapportering become
// deviations, a kortstängd order is valued at what it delivered), the
// operation's own OK quantity on a preliminary one (work in progress is not a
// deviation).
export function operationOutput(ctx: OutputContext, completed: number): number {
  return ctx.preliminary ? completed : ctx.received;
}

// N for a material row. Unlinked material is drawn with the receipt, so it
// is always the received quantity.
export function materialOutput(ctx: OutputContext, linked: { completed: number } | null): number {
  return linked ? operationOutput(ctx, linked.completed) : ctx.received;
}

export interface OperationQuantities {
  sequenceNo: number;
  scrapped: number;
}

// K for a material row — the scrapped units that drew it: top-up draws for
// OK + kasserat on the row's operation, and a unit scrapped on a LATER
// operation had already drawn it. The later operations only count on a final
// order: on a preliminary one N is this operation's OK, which still contains
// them. Unlinked material is drawn at the receipt and gets 0.
export function materialScrap(
  ctx: OutputContext,
  linked: OperationQuantities | null,
  operations: OperationQuantities[]
): number {
  if (!linked) return 0;
  let scrapped = linked.scrapped;
  if (!ctx.preliminary) {
    for (const op of operations) if (op.sequenceNo > linked.sequenceNo) scrapped += op.scrapped;
  }
  return scrapped;
}

// The planned share of `units`: quantity_planned is for the order quantity.
export function plannedShare(planned: number, orderQuantity: number, units: number): number {
  return orderQuantity > 0 ? (planned * units) / orderQuantity : 0;
}

// An operation has been worked when it has time, a reported quantity or (lego)
// a receipt on an IO row.
export function operationWorked(op: { hours: number; completed: number; scrapped: number; received?: boolean }): boolean {
  return op.hours > 0 || op.completed > 0 || op.scrapped > 0 || op.received === true;
}

// Ställtid and the lego one-off (ställpris + transport) count once: when the
// operation has been worked, or when the order is final with N > 0.
export function oneOffCounts(ctx: OutputContext, worked: boolean): boolean {
  return worked || (!ctx.preliminary && ctx.received > 0);
}

// The value a numeric(p, scale) column stores for String(value): Postgres
// rounds the DECIMAL TEXT half away from zero, which Math.round on the binary
// value does not always agree with (12.34565 is 12.3456499… in binary). The
// preview derives its analysis from the in-memory rows through this, so it
// sees exactly what a saved calculation reads back.
export function roundAsNumeric(value: number, scale: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const { integer, fraction } = decimalText(Math.abs(value));
  if (fraction.length <= scale) return value;
  let digits = BigInt(integer + fraction.slice(0, scale));
  if (fraction.charCodeAt(scale) >= 53 /* "5" */) digits += 1n;
  const rounded = Number(digits) / 10 ** scale;
  return value < 0 ? -rounded : rounded;
}

// String(magnitude) as integer and fraction digits — also when String()
// writes an exponent (below 1e-6, from 1e21), which Postgres reads the same.
function decimalText(magnitude: number): { integer: string; fraction: string } {
  const text = String(magnitude);
  const exponent = /^(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!exponent) {
    const [integer, fraction = ""] = text.split(".");
    return { integer: integer!, fraction };
  }
  const digits = exponent[1]! + (exponent[2] ?? "");
  const point = exponent[1]!.length + Number(exponent[3]);
  if (point >= digits.length) return { integer: digits + "0".repeat(point - digits.length), fraction: "" };
  if (point > 0) return { integer: digits.slice(0, point), fraction: digits.slice(point) };
  return { integer: "0", fraction: "0".repeat(-point) + digits };
}

// ---------------------------------------------------------------------------
// The analysis, derived on read
// ---------------------------------------------------------------------------

export interface VarianceHeader {
  outputQuantity: number | null;
  preliminary: boolean | null;
  basePricedAt: Date | string | null;
  baseMaterialSource: CostingMaterialSource | null;
  // The efterkalkyl's MO and LO — the same on both sides.
  moPercent: number;
  loPercent: number;
  // The efterkalkyl's TVK (cost-figures.ts's manufacturingCost of the header,
  // whose columns have four decimals). The order's Utfall IS this figure in
  // whole öre, so the analysis and the chain never disagree.
  manufacturingCost: number;
}

export interface VarianceMaterialInput {
  id: string | null;
  componentArticleId: string;
  articleNumber: string;
  articleName: string;
  kind: CostMaterialRowKind;
  // AQ, AP and the row's amount.
  quantity: number;
  unitCost: number;
  amount: number;
  // SQ, SP; null = no base.
  baseQuantity: number | null;
  baseUnitCost: number | null;
  basePriceSource: CostPriceSource | null;
  scrapQuantity: number | null;
}

export interface VarianceOperationInput {
  id: string | null;
  sequenceNo: number;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  hours: number;
  setupHours: number | null;
  runHours: number | null;
  hourlyRate: number;
  laborAmount: number;
  // Not null = a lego operation.
  subcontractAmount: number | null;
  baseSetupHours: number | null;
  baseRunHours: number | null;
  baseHourlyRate: number | null;
  baseQuantity: number | null;
  subcontractQuantity: number | null;
  baseUnitPrice: number | null;
  baseOneOff: number | null;
}

// Kronor → whole öre: the amount rounded with round2 (the house rule), then
// made an integer so every sum and difference below is exact. `+ 0` turns a
// -0 (a difference a hair under zero, e.g. Lön − R₀ × H) into 0.
function ore(kronor: number): number {
  return Math.round(round2(kronor) * 100) + 0;
}

function kronor(oreAmount: number): number {
  return oreAmount / 100;
}

// A sum of four-decimal columns (the header's TVK) → whole öre, exactly:
// first to integer ten-thousandths (a float sum of such values is off by far
// less than half of one), then half away from zero to öre.
function oreOfFourDecimals(kronor: number): number {
  const tenThousandths = Math.round(kronor * 10000);
  return Math.sign(tenThousandths) * Math.round(Math.abs(tenThousandths) / 100);
}

// The base product as the actual side's amount is stored: the efterkalkyl's
// amount columns have four decimals and are then rounded to öre, so the base
// is rounded the same two steps. Rounding it once (ore of the raw product)
// gave a false öre: AQ = SQ = 1.5 and AP = SP = 1.0033 is 1.50495 — 1.50 as
// the base, 1.5050 → 1.51 as the outcome.
function oreAsStored(kronor: number): number {
  return ore(roundAsNumeric(kronor, 4));
}

// A header bucket at its column's scale, as toHeader (costing.service.ts)
// rounds it before it is stored.
function fourDecimals(value: number): number {
  return round4(value);
}

function hours4(value: number): number {
  return round4(value);
}

type OreParts = { [K in keyof CostVarianceParts]: number };

function emptyParts(): OreParts {
  return { price: 0, quantity: 0, scrap: 0, rate: 0, setup: 0, run: 0, unclassified: 0, markups: 0 };
}

function partsInKronor(parts: OreParts): CostVarianceParts {
  return {
    price: kronor(parts.price),
    quantity: kronor(parts.quantity),
    scrap: kronor(parts.scrap),
    rate: kronor(parts.rate),
    setup: kronor(parts.setup),
    run: kronor(parts.run),
    unclassified: kronor(parts.unclassified),
    markups: kronor(parts.markups),
  };
}

interface OreRow {
  base: number;
  actual: number;
  parts: OreParts;
  // Kalkylerat unrounded, in kronor — what the base's TVK is summed from,
  // the way the efterkalkyl's header sums its rows' unrounded amounts.
  baseAmount: number;
}

// Material and tjänst row r:
//   Pris  = (AP − SP) × AQ, rounded with round2;
//   Mängd = the rest of the row's deviation ≈ (AQ − SQ) × SP, kassation included;
//   varav kassation = SP × scrapQuantity (informational, not summed).
// A row without a base counts its whole amount as Mängd.
export function materialVariance(row: VarianceMaterialInput): OreRow {
  const parts = emptyParts();
  const actual = ore(row.amount);
  if (row.baseQuantity === null || row.baseUnitCost === null) {
    parts.quantity = actual;
    return { base: 0, actual, parts, baseAmount: 0 };
  }
  const baseAmount = row.baseQuantity * row.baseUnitCost;
  const base = oreAsStored(baseAmount);
  parts.price = ore((row.unitCost - row.baseUnitCost) * row.quantity);
  parts.quantity = actual - base - parts.price;
  parts.scrap = ore(row.baseUnitCost * (row.scrapQuantity ?? 0));
  return { base, actual, parts, baseAmount };
}

// Operation with time o: H reported, Hs/Hr of it registered as ställ/
// produktion, U = H − Hs − Hr not split (all of H before etapp 3).
//   Timpris = Lön − R₀ × H, rounded with round2: Σ (R_d − R₀) × H_d over the
//          work days, since the efterkalkyl prices each day's hours at that
//          day's hourly rate (etapp 4) — exact, where the row's average R
//          (two decimals) would not be; 0 while every day's rate is R₀;
//   U = 0: Ställ = (Hs − Bs) × R₀ rounded, Stycke = the rest;
//   U > 0: Tid (ej uppdelad) = the rest, for the whole operation — a half
//          classified operation is not split, or the rest would look like
//          saved setup time. Ej uppdelad (h) is then all of H, so the hours
//          and the kronor reconcile (unclassifiedHours = H, Hs/Hr only
//          informative); split, it is 0.
export function timeVariance(row: VarianceOperationInput): OreRow & { split: boolean; unclassifiedHours: number } {
  const parts = emptyParts();
  const actual = ore(row.laborAmount);
  const hasBase = row.baseSetupHours !== null && row.baseRunHours !== null && row.baseHourlyRate !== null;
  const setupBase = row.baseSetupHours ?? 0;
  const runBase = row.baseRunHours ?? 0;
  const baseRate = hasBase ? row.baseHourlyRate! : row.hourlyRate;
  const baseAmount = hasBase ? baseRate * (setupBase + runBase) : 0;
  const base = hasBase ? oreAsStored(baseAmount) : 0;
  const deviation = actual - base;
  parts.rate = ore(row.laborAmount - baseRate * row.hours);
  const setupHours = row.setupHours ?? 0;
  const runHours = row.runHours ?? 0;
  const split = Math.max(0, hours4(row.hours - setupHours - runHours)) === 0;
  if (split) {
    parts.setup = ore((setupHours - setupBase) * baseRate);
    parts.run = deviation - parts.rate - parts.setup;
  } else {
    parts.unclassified = deviation - parts.rate;
  }
  return { base, actual, parts, baseAmount, split, unclassifiedHours: split ? 0 : row.hours };
}

// Lego operation l: A = the IO cost as the efterkalkyl took it, Qa what it
// was taken for. Kalkylerat = F₀ + P₀ × N.
//   Pris  = A − F₀ − P₀ × Qa, rounded with round2 (à-pris, ställ- and
//           transportpris and the rate);
//   Mängd = the rest ≈ (Qa − N) × P₀.
export function subcontractVariance(row: VarianceOperationInput): OreRow {
  const parts = emptyParts();
  const amount = row.subcontractAmount ?? 0;
  const actual = ore(amount);
  if (row.baseQuantity === null || row.baseUnitPrice === null || row.baseOneOff === null) {
    parts.quantity = actual;
    return { base: 0, actual, parts, baseAmount: 0 };
  }
  const baseAmount = row.baseOneOff + row.baseUnitPrice * row.baseQuantity;
  const base = oreAsStored(baseAmount);
  parts.price = ore(amount - row.baseOneOff - row.baseUnitPrice * (row.subcontractQuantity ?? 0));
  parts.quantity = actual - base - parts.price;
  return { base, actual, parts, baseAmount };
}

function addParts(into: OreParts, from: OreParts) {
  for (const key of Object.keys(into) as (keyof OreParts)[]) into[key] += from[key];
}

// The whole analysis, or null when the calculation has none (a förkalkyl, or
// an efterkalkyl saved before the analysis existed).
export function costVarianceAnalysis(
  header: VarianceHeader,
  materialRows: VarianceMaterialInput[],
  operationRows: VarianceOperationInput[]
): CostVarianceAnalysis | null {
  if (
    header.outputQuantity === null ||
    header.preliminary === null ||
    header.basePricedAt === null ||
    header.baseMaterialSource === null ||
    header.baseMaterialSource === "actual"
  ) {
    return null;
  }

  const total = emptyParts();
  let base = 0;
  let actual = 0;
  // The base's TVK buckets, unrounded as the efterkalkyl's directCosts sums
  // its rows: MO on material, LO on lego (tjänster in the structure and lego
  // operations), none on time or a halvfabrikat.
  const baseBuckets = { material: 0, lego: 0, labor: 0, semi: 0 };

  const material: CostVarianceMaterialRow[] = materialRows.map((row) => {
    const v = materialVariance(row);
    base += v.base;
    actual += v.actual;
    addParts(total, v.parts);
    if (row.kind === "material") baseBuckets.material += v.baseAmount;
    else if (row.kind === "subcontract") baseBuckets.lego += v.baseAmount;
    else baseBuckets.semi += v.baseAmount;
    const hasBase = row.baseQuantity !== null && row.baseUnitCost !== null;
    return {
      id: row.id,
      componentArticleId: row.componentArticleId,
      articleNumber: row.articleNumber,
      articleName: row.articleName,
      kind: row.kind,
      baseQuantity: hasBase ? row.baseQuantity : null,
      baseUnitCost: hasBase ? row.baseUnitCost : null,
      basePriceSource: hasBase ? row.basePriceSource : null,
      quantity: row.quantity,
      unitCost: row.unitCost,
      scrapQuantity: hasBase ? (row.scrapQuantity ?? 0) : 0,
      base: kronor(v.base),
      actual: kronor(v.actual),
      deviation: kronor(v.actual - v.base),
      parts: partsInKronor(v.parts),
    };
  });

  const operations: CostVarianceOperationRow[] = operationRows.map((row) => {
    const identity = {
      id: row.id,
      sequenceNo: row.sequenceNo,
      workCenterId: row.workCenterId,
      workCenterCode: row.workCenterCode,
      workCenterName: row.workCenterName,
    };
    if (row.subcontractAmount !== null) {
      const v = subcontractVariance(row);
      base += v.base;
      actual += v.actual;
      addParts(total, v.parts);
      baseBuckets.lego += v.baseAmount;
      const hasBase = row.baseQuantity !== null && row.baseUnitPrice !== null && row.baseOneOff !== null;
      return {
        kind: "subcontract",
        ...identity,
        baseQuantity: hasBase ? row.baseQuantity : null,
        baseUnitPrice: hasBase ? row.baseUnitPrice : null,
        baseOneOff: hasBase ? row.baseOneOff : null,
        subcontractQuantity: row.subcontractQuantity,
        base: kronor(v.base),
        actual: kronor(v.actual),
        deviation: kronor(v.actual - v.base),
        parts: partsInKronor(v.parts),
      };
    }
    const v = timeVariance(row);
    base += v.base;
    actual += v.actual;
    addParts(total, v.parts);
    baseBuckets.labor += v.baseAmount;
    const hasBase = row.baseSetupHours !== null && row.baseRunHours !== null && row.baseHourlyRate !== null;
    return {
      kind: "time",
      ...identity,
      baseSetupHours: hasBase ? row.baseSetupHours : null,
      baseRunHours: hasBase ? row.baseRunHours : null,
      baseHourlyRate: hasBase ? row.baseHourlyRate : null,
      hours: row.hours,
      setupHours: row.setupHours,
      runHours: row.runHours,
      unclassifiedHours: v.unclassifiedHours,
      hourlyRate: row.hourlyRate,
      split: v.split,
      base: kronor(v.base),
      actual: kronor(v.actual),
      deviation: kronor(v.actual - v.base),
      parts: partsInKronor(v.parts),
    };
  });

  // Påslag (följer av material och lego): the same MO/LO on both sides. Not
  // split per cause. Both sides are a TVK in öre, computed the same way:
  // - Utfall: the efterkalkyl's TVK, so the order's Utfall is exactly the
  //   chain's TVK;
  // - Kalkylerat: the base's TVK, summed like the header's (each bucket and
  //   MO/LO on its unrounded sum at four decimals — toHeader's rounding —
  //   then the sum to öre).
  // Each side's markup part is its TVK − Σ its rounded rows: MO/LO plus the
  // rows' rounding rest (up to half an öre per row × (1 + MO %)). An outcome
  // exactly as calculated therefore has Påslag 0 — the same rest on both
  // sides — instead of the few öre a markup on the rounded base rows gave.
  const baseTvk = oreOfFourDecimals(
    fourDecimals(baseBuckets.material) +
      fourDecimals(baseBuckets.material * (header.moPercent / 100)) +
      fourDecimals(baseBuckets.labor) +
      fourDecimals(baseBuckets.lego) +
      fourDecimals(baseBuckets.lego * (header.loPercent / 100)) +
      fourDecimals(baseBuckets.semi)
  );
  const tvk = oreOfFourDecimals(header.manufacturingCost);
  total.markups = tvk - actual - (baseTvk - base);
  base = baseTvk;
  actual = tvk;

  return {
    outputQuantity: header.outputQuantity,
    preliminary: header.preliminary,
    basePricedAt: new Date(header.basePricedAt).toISOString(),
    baseMaterialSource: header.baseMaterialSource,
    base: kronor(base),
    actual: kronor(actual),
    deviation: kronor(actual - base),
    parts: partsInKronor(total),
    materialRows: material,
    operationRows: operations,
  };
}

// ---------------------------------------------------------------------------
// A saved calculation, as its columns read back
// ---------------------------------------------------------------------------

// Drizzle hands numeric columns back as strings ("100.0000"). The one mapping
// from a saved efterkalkyl's header and rows to the analysis — GET
// /cost-calculations/:id, the save's answer and Kalkylutfall all read it.
type Numeric = string | number;

export interface StoredVarianceCalculation extends ManufacturingCostBuckets {
  outputQuantity: Numeric | null;
  preliminary: boolean | null;
  basePricedAt: Date | string | null;
  baseMaterialSource: CostingMaterialSource | null;
  moPercent: Numeric;
  loPercent: Numeric;
}

export interface StoredVarianceMaterialRow {
  id: string;
  componentArticleId: string;
  articleNumber: string;
  articleName: string;
  kind: CostMaterialRowKind;
  quantity: Numeric;
  unitCost: Numeric;
  amount: Numeric;
  baseQuantity: Numeric | null;
  baseUnitCost: Numeric | null;
  basePriceSource: CostPriceSource | null;
  scrapQuantity: Numeric | null;
}

export interface StoredVarianceOperationRow {
  id: string;
  sequenceNo: number;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  hours: Numeric;
  setupHours: Numeric | null;
  runHours: Numeric | null;
  hourlyRate: Numeric;
  laborAmount: Numeric;
  subcontractAmount: Numeric | null;
  baseSetupHours: Numeric | null;
  baseRunHours: Numeric | null;
  baseHourlyRate: Numeric | null;
  baseQuantity: Numeric | null;
  subcontractQuantity: Numeric | null;
  baseUnitPrice: Numeric | null;
  baseOneOff: Numeric | null;
}

const numberOrNull = (value: Numeric | null) => (value === null ? null : Number(value));

export function storedVarianceAnalysis(
  calculation: StoredVarianceCalculation,
  materialRows: StoredVarianceMaterialRow[],
  operationRows: StoredVarianceOperationRow[]
): CostVarianceAnalysis | null {
  return costVarianceAnalysis(
    {
      outputQuantity: numberOrNull(calculation.outputQuantity),
      preliminary: calculation.preliminary,
      basePricedAt: calculation.basePricedAt,
      baseMaterialSource: calculation.baseMaterialSource,
      moPercent: Number(calculation.moPercent),
      loPercent: Number(calculation.loPercent),
      manufacturingCost: manufacturingCost(calculation),
    },
    materialRows.map((r) => ({
      id: r.id,
      componentArticleId: r.componentArticleId,
      articleNumber: r.articleNumber,
      articleName: r.articleName,
      kind: r.kind,
      quantity: Number(r.quantity),
      unitCost: Number(r.unitCost),
      amount: Number(r.amount),
      baseQuantity: numberOrNull(r.baseQuantity),
      baseUnitCost: numberOrNull(r.baseUnitCost),
      basePriceSource: r.basePriceSource,
      scrapQuantity: numberOrNull(r.scrapQuantity),
    })),
    operationRows.map((r) => ({
      id: r.id,
      sequenceNo: r.sequenceNo,
      workCenterId: r.workCenterId,
      workCenterCode: r.workCenterCode,
      workCenterName: r.workCenterName,
      hours: Number(r.hours),
      setupHours: numberOrNull(r.setupHours),
      runHours: numberOrNull(r.runHours),
      hourlyRate: Number(r.hourlyRate),
      laborAmount: Number(r.laborAmount),
      subcontractAmount: numberOrNull(r.subcontractAmount),
      baseSetupHours: numberOrNull(r.baseSetupHours),
      baseRunHours: numberOrNull(r.baseRunHours),
      baseHourlyRate: numberOrNull(r.baseHourlyRate),
      baseQuantity: numberOrNull(r.baseQuantity),
      subcontractQuantity: numberOrNull(r.subcontractQuantity),
      baseUnitPrice: numberOrNull(r.baseUnitPrice),
      baseOneOff: numberOrNull(r.baseOneOff),
    }))
  );
}
