// TVK and SVK are plain sums of the stored buckets — the calculation never
// stores them (see packages/db/src/schema/costing.ts). TO (`overhead`) is in
// neither: it is added to the sales price last, after the general markup
// (markup.ts), and so is the materialpåslag, so a stored calculation's lines
// sum as
//   TVK + Affo = SVK; SVK + generellt påslag + materialpåslag + TO = salesPrice.
// Before this file the
// derivation was hand-rolled at five separate call sites, so adding a bucket
// meant finding all five; a missed one does not crash, it quietly reports a
// too-low manufacturing cost. This is the server-side authority, the sibling of
// the web's chainLines (apps/web/lib/costChain.ts).
//
// Every field is accepted as `number | string` because Drizzle hands numeric
// columns back as strings ("100.0000") while the in-flight calculation carries
// plain numbers.

export interface CostBuckets {
  materialCost: number | string;
  materialOverhead: number | string;
  laborCost: number | string;
  overhead: number | string;
  subcontractCost: number | string;
  subcontractOverhead: number | string;
  semiFinishedCost: number | string;
  businessOverhead: number | string;
}

// The buckets TVK reads — TO and Affo are outside it.
export type ManufacturingCostBuckets = Omit<CostBuckets, "overhead" | "businessOverhead">;

/** TVK — tillverkningskostnad. Without TO (see the file header). */
export function manufacturingCost(c: ManufacturingCostBuckets): number {
  return (
    Number(c.materialCost) +
    Number(c.materialOverhead) +
    Number(c.laborCost) +
    Number(c.subcontractCost) +
    Number(c.subcontractOverhead) +
    Number(c.semiFinishedCost)
  );
}

/** SVK — självkostnad. Without TO, like TVK. */
export function selfCost(c: CostBuckets): number {
  return manufacturingCost(c) + Number(c.businessOverhead);
}

// A per-unit figure, or null when the quantity cannot carry one. Null rather
// than 0: "no answer" and "free" are different claims, the same distinction
// resolvePrice and computeMovingAverage already make.
export function perUnit(total: number, quantity: number | string): number | null {
  const q = Number(quantity);
  if (!Number.isFinite(q) || q <= 0) return null;
  return total / q;
}

// What a SAVED calculation's totals are divided by to give a per-unit figure —
// the one rule behind Sätt standardpris, Sätt försäljningspris and the
// specification's Per st column (the web mirrors it in
// apps/web/lib/calculationDivisor.ts; kalkylgranskning.test.ts pins the two
// against each other).
//
// A förkalkyl is calculated FOR its quantity, so that is the divisor. An
// efterkalkyl's totals are what the order actually consumed, and they bought
// N = the received quantity (output_quantity, the same N Kalkylutfall divides
// by): an order for 10 that delivered 8 cost TVK ÷ 8 per piece, not ÷ 10.
//   - final analysis, N > 0      → N ("output")
//   - preliminary analysis       → no figure ("preliminary"): the order is
//     still open, its costs and its N are both moving
//   - final analysis, N = 0      → no figure ("no-output"): nothing was made
//   - saved before the analysis (0187: both fields null) → the quantity, as
//     it always was — N was never stored for those
export interface PerUnitDivisorSource {
  type: "pre" | "post";
  quantity: number | string;
  outputQuantity?: number | string | null;
  preliminary?: boolean | null;
}

export type PerUnitDivisor =
  | { divisor: number; basis: "quantity" | "output" }
  | { divisor: null; reason: "invalid-quantity" | "preliminary" | "no-output" };

export function perUnitDivisor(c: PerUnitDivisorSource): PerUnitDivisor {
  const analysed = c.type === "post" && c.outputQuantity !== null && c.outputQuantity !== undefined && typeof c.preliminary === "boolean";
  if (analysed) {
    if (c.preliminary) return { divisor: null, reason: "preliminary" };
    const n = Number(c.outputQuantity);
    if (!Number.isFinite(n) || n <= 0) return { divisor: null, reason: "no-output" };
    return { divisor: n, basis: "output" };
  }
  const q = Number(c.quantity);
  if (!Number.isFinite(q) || q <= 0) return { divisor: null, reason: "invalid-quantity" };
  return { divisor: q, basis: "quantity" };
}
