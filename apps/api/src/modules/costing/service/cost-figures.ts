// TVK and SVK are plain sums of the stored buckets — the calculation never
// stores them (see packages/db/src/schema/costing.ts). Before this file the
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

/** TVK — tillverkningskostnad. */
export function manufacturingCost(c: CostBuckets): number {
  return (
    Number(c.materialCost) +
    Number(c.materialOverhead) +
    Number(c.laborCost) +
    Number(c.overhead) +
    Number(c.subcontractCost) +
    Number(c.subcontractOverhead) +
    Number(c.semiFinishedCost)
  );
}

/** SVK — självkostnad. */
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
