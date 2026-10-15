// Money as it's written in Swedish: thousands separated, always two
// decimals. The currency code is appended by the caller — sales orders are
// always SEK, purchase orders carry the supplier's currency.
export function formatMoney(value: string | number): string {
  return Number(value).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A price addition: "+100,00" / "−100,00" (formatMoney already writes the
// minus sign, so a negative amount never becomes "+−").
export function formatSignedMoney(value: string | number): string {
  const n = Number(value);
  return n < 0 ? formatMoney(n) : `+${formatMoney(n)}`;
}

// Percentages as they're written in Swedish: comma decimal, a space before
// the sign. Used by the Rapporter section (precision, statistics, outcome).
export function formatPercent(value: number, decimals = 1): string {
  return `${value.toLocaleString("sv-SE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} %`;
}

// Round to 2 decimals (öre) without landing on the classic floating-point
// trap (e.g. 1.005 * 100 truncating to 100.49999999999999 and rounding down
// instead of up) — the +Number.EPSILON nudge every local copy of this
// function already used before being consolidated here.
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
