// Money/amount helpers (öre-level rounding for invoice line amounts, VAT
// amounts, price/quantity deviations, and — going forward — the general
// ledger balance check).

// Rounds to 2 decimals (öre). The Number.EPSILON guard nudges positive
// values that land exactly on a floating-point half-öre (e.g. 1.005, which
// is actually stored as 1.00499999...) up to the expected 1.01. It is a
// one-sided nudge: negative half-öre values are NOT mirrored and simply
// follow Math.round's own (round-half-away-from-zero-ish, but still
// floating-point-affected) behavior, e.g. round2(-1.005) === -1, not -1.01.
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
