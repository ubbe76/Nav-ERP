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

// Quantities, hours and minutes as they're written in Swedish: comma decimal,
// a space between thousands, at most four decimals (numeric(14,4)) and no
// trailing zeros — "10,4", "1 936", "0,25". A bare Number() in a table cell
// renders "10.4".
export function formatQuantity(value: string | number): string {
  return Number(value).toLocaleString("sv-SE", { maximumFractionDigits: 4 });
}

// Percentages as they're written in Swedish: comma decimal, a space before
// the sign. Used by the Rapporter section (precision, statistics, outcome).
export function formatPercent(value: number, decimals = 1): string {
  return `${value.toLocaleString("sv-SE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} %`;
}

// Round to 2 decimals (öre) without landing on the classic floating-point
// trap (e.g. 1.005 * 100 truncating to 100.49999999999999 and rounding down
// instead of up). The old `+ Number.EPSILON` nudge only helped below ~2 kr
// (2.175 → 2.17; delatgranskningen 2026-11-11).
export function round2(n: number): number {
  return roundToDecimals(n, 2);
}

// Half away from zero to `decimals` places, cut to 15 significant digits first
// — @navet/shared money.ts's roundToDecimals (the web can't import the package).
export function roundToDecimals(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  const magnitude = Math.round(Number((Math.abs(n) * factor).toPrecision(15))) / factor;
  return n < 0 && magnitude !== 0 ? -magnitude : magnitude;
}

// Rounds to 4 decimals — the scale of every numeric(14,4) quantity.
export function round4(n: number): number {
  return roundToDecimals(n, 4);
}
