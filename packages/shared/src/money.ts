// Money/amount helpers (öre-level rounding for invoice line amounts, VAT
// amounts, price/quantity deviations, and — going forward — the general
// ledger balance check).

// Rounds half away from zero to `decimals` places — Postgres round(numeric)'s
// rule, so a JS amount and the same amount rounded in SQL agree, and
// roundToDecimals(-x) === -roundToDecimals(x) (a credit mirrors its invoice).
//
// The scaled value is first cut to 15 significant digits: a float product
// like 8597.755 * 100 = 859775.4999999999 is the binary neighbour of an exact
// half, and toPrecision(15) restores the 859775.5 it stands for. The old
// `+ Number.EPSILON` nudge (2.2e-16) was smaller than a float's spacing above
// 2 kr, so 2.175 → 2.17 and a 25 % VAT of 8597.755 → 8597.75
// (delatgranskningen 2026-11-11). -0 is never returned.
export function roundToDecimals(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  const magnitude = Math.round(Number((Math.abs(n) * factor).toPrecision(15))) / factor;
  return n < 0 && magnitude !== 0 ? -magnitude : magnitude;
}

// Rounds to 2 decimals (öre).
export function round2(n: number): number {
  return roundToDecimals(n, 2);
}

// Rounds to 4 decimals — the scale of every numeric(14,4) quantity. Sums of
// such quantities are added as JS numbers (0.1 + 0.2 = 0.30000000000000004),
// so a guard comparing them against another quantity rounds both sides first.
export function round4(n: number): number {
  return roundToDecimals(n, 4);
}
