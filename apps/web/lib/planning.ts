// Production planning (Produktionsplanering) display helpers. Dates arrive
// from the API as "YYYY-MM-DD"; everything here is pure string arithmetic so
// the browser's timezone never shifts a day.

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

// "2 nov" of a YYYY-MM-DD date.
export function shortDate(isoDate: string): string {
  const [, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

// "12 nov" for one day, "12–14 nov" within a month, "28 nov–2 dec" across a
// month (or year) boundary. null start = unplanned.
export function plannedDateLabel(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const to = end ?? start;
  if (to === start) return shortDate(start);
  const [, m1, d1] = start.slice(0, 10).split("-").map(Number);
  const [, m2] = to.slice(0, 10).split("-").map(Number);
  if (m1 === m2 && start.slice(0, 4) === to.slice(0, 4)) return `${d1}–${shortDate(to)}`;
  return `${shortDate(start)}–${shortDate(to)}`;
}

const WEEKDAYS = ["sön", "mån", "tis", "ons", "tors", "fre", "lör"];

// "mån 16 nov" of a YYYY-MM-DD date (weekday by UTC arithmetic).
export function weekdayShortDate(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const weekday = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${shortDate(isoDate)}`;
}
