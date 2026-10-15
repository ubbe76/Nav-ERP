import { MONTH_NAMES_SV } from "../../lib/types";

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// "2026-01" -> "Januari 2026" — same wording as Momsrapportens periodetiketter
// (MomsrapportPageClient's monthOptionLabel).
export function monthLabel(yyyyMm: string): string {
  const [year, month] = yyyyMm.split("-");
  const index = Number(month) - 1;
  const name = MONTH_NAMES_SV[index];
  return name ? `${capitalize(name)} ${year}` : yyyyMm;
}

// Signed percent for deviation columns (Kalkylutfall) — toLocaleString never
// adds a leading "+", but a deviation reads ambiguous without one since 0 is
// a real, common value.
export function formatSignedPercent(value: number, decimals = 1): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("sv-SE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} %`;
}
