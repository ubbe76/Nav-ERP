import { isoWeekNumber } from "./deliveryTimeCheck";

// Production planning (Produktionsplanering) display helpers. Weeks arrive
// from the API as Mondays ("YYYY-MM-DD"); everything here is pure string/UTC
// arithmetic so the browser's timezone never shifts a week.

// "v.45" for one week, "v.45–47" for a span (the end week keeps its own
// number across New Year, e.g. "v.52–2"). null/null = unplanned.
export function plannedWeekLabel(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const from = isoWeekNumber(start);
  const to = isoWeekNumber(end ?? start);
  return from === to ? `v.${from}` : `v.${from}–${to}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

// "2 nov" of a YYYY-MM-DD date.
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}
