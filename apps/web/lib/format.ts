// Money as it's written in Swedish: thousands separated, always two
// decimals. The currency code is appended by the caller — sales orders are
// always SEK, purchase orders carry the supplier's currency.
export function formatMoney(value: string | number): string {
  return Number(value).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// A unit price (à-pris, prislista, kundpris — numeric(14,4)): at least two
// decimals like money, up to four when the price has them — "245,83",
// "245,8333", "0,875". formatMoney would show 0,875 as "0,88" and the row
// would look as if it had a different price than it carries
// (webbgranskningen 2026-11-11).
export function formatUnitPrice(value: string | number): string {
  return Number(value).toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
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

// Tid/enhet in minutes (numeric(14,8), migration 0218): at most four
// decimals like a quantity, but a run time under a minute keeps six
// significant digits — 0,05 s/st is 0,00083333 min and showed as "0,0008".
export function formatRunMinutes(value: string | number): string {
  const n = Number(value);
  return n !== 0 && Math.abs(n) < 1
    ? n.toLocaleString("sv-SE", { maximumSignificantDigits: 6 })
    : n.toLocaleString("sv-SE", { maximumFractionDigits: 4 });
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
