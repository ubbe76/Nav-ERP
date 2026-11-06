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
// rules as of T₀; Utfall (actual) = the efterkalkyl's rows. Per row and for
// the order: Utfall − Kalkylerat = Σ parts, exactly — every amount is whole
// öre and the sums are integer arithmetic.
import {
  round2,
  type CostingMaterialSource,
  type CostMaterialRowKind,
  type CostPriceSource,
  type CostVarianceAnalysis,
  type CostVarianceMaterialRow,
  type CostVarianceOperationRow,
  type CostVarianceParts,
} from "@navet/shared";

// ---------------------------------------------------------------------------
// The base rules
// ---------------------------------------------------------------------------

export interface OutputContext {
  // The order is not Klar/Stängd.
  preliminary: boolean;
  // Inlevererat — manufacturing_orders.quantity_received.
  received: number;
}

// Klar or Stängd is final; everything else (Frisläppt, Pågår, an older
// Planerad, Makulerad) is a preliminary analysis.
export function isPreliminaryStatus(status: string): boolean {
  return status !== "done" && status !== "closed";
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
// made an integer so every sum and difference below is exact.
function ore(kronor: number): number {
  return Math.round(round2(kronor) * 100);
}

function kronor(oreAmount: number): number {
  return oreAmount / 100;
}

function hours4(value: number): number {
  return Math.round(value * 10000) / 10000;
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
    return { base: 0, actual, parts };
  }
  const base = ore(row.baseQuantity * row.baseUnitCost);
  parts.price = ore((row.unitCost - row.baseUnitCost) * row.quantity);
  parts.quantity = actual - base - parts.price;
  parts.scrap = ore(row.baseUnitCost * (row.scrapQuantity ?? 0));
  return { base, actual, parts };
}

// Operation with time o: H reported, Hs/Hr of it registered as ställ/
// produktion, U = H − Hs − Hr not split (all of H before etapp 3).
//   Timpris = (R − R₀) × H, rounded with round2 (0 while R₀ = R);
//   U = 0: Ställ = (Hs − Bs) × R₀ rounded, Stycke = the rest;
//   U > 0: Tid (ej uppdelad) = the rest, for the whole operation — a half
//          classified operation is not split, or the rest would look like
//          saved setup time.
export function timeVariance(row: VarianceOperationInput): OreRow & { split: boolean; unclassifiedHours: number } {
  const parts = emptyParts();
  const actual = ore(row.laborAmount);
  const hasBase = row.baseSetupHours !== null && row.baseRunHours !== null && row.baseHourlyRate !== null;
  const setupBase = row.baseSetupHours ?? 0;
  const runBase = row.baseRunHours ?? 0;
  const baseRate = hasBase ? row.baseHourlyRate! : row.hourlyRate;
  const base = hasBase ? ore(baseRate * (setupBase + runBase)) : 0;
  const deviation = actual - base;
  parts.rate = ore((row.hourlyRate - baseRate) * row.hours);
  const setupHours = row.setupHours ?? 0;
  const runHours = row.runHours ?? 0;
  const unclassifiedHours = Math.max(0, hours4(row.hours - setupHours - runHours));
  const split = unclassifiedHours === 0;
  if (split) {
    parts.setup = ore((setupHours - setupBase) * baseRate);
    parts.run = deviation - parts.rate - parts.setup;
  } else {
    parts.unclassified = deviation - parts.rate;
  }
  return { base, actual, parts, split, unclassifiedHours };
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
    return { base: 0, actual, parts };
  }
  const base = ore(row.baseOneOff + row.baseUnitPrice * row.baseQuantity);
  parts.price = ore(amount - row.baseOneOff - row.baseUnitPrice * (row.subcontractQuantity ?? 0));
  parts.quantity = actual - base - parts.price;
  return { base, actual, parts };
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
  // The markup bases per side: MO on material, LO on lego (tjänster in the
  // structure and lego operations). A halvfabrikat carries no markup.
  const materialSum = { base: 0, actual: 0 };
  const legoSum = { base: 0, actual: 0 };

  const material: CostVarianceMaterialRow[] = materialRows.map((row) => {
    const v = materialVariance(row);
    base += v.base;
    actual += v.actual;
    addParts(total, v.parts);
    const markupSum = row.kind === "material" ? materialSum : row.kind === "subcontract" ? legoSum : null;
    if (markupSum) {
      markupSum.base += v.base;
      markupSum.actual += v.actual;
    }
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
      legoSum.base += v.base;
      legoSum.actual += v.actual;
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

  // Påslag (följer av material och lego): the same MO/LO on both sides, each
  // side's markup rounded once on the order's sums. Not split per cause.
  const markupOf = (side: "base" | "actual") =>
    ore(kronor(materialSum[side]) * (header.moPercent / 100) + kronor(legoSum[side]) * (header.loPercent / 100));
  const baseMarkup = markupOf("base");
  const actualMarkup = markupOf("actual");
  total.markups = actualMarkup - baseMarkup;
  base += baseMarkup;
  actual += actualMarkup;

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
