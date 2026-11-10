import { stockholmInstant } from "../../system/service/delivery-days.js";

// Bankfiler compute every date in Stockholm time from an injected clock
// (services take `now: () => Date`; tests pass a fixed one).
const DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" });
const DATE_TIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // h23, not hour12: false — the latter may render midnight as "24".
  hourCycle: "h23",
});

export function stockholmDate(d: Date): string {
  return DATE.format(d);
}

// xs:dateTime without zone or fraction — "2026-10-09T14:05:12".
export function stockholmDateTime(d: Date): string {
  return DATE_TIME.format(d).replace(" ", "T");
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// An xs:dateTime from a bank file (CreDtTm) as an instant. With a zone ("Z",
// "+02:00") it is what it says; WITHOUT one it is the bank's wall clock —
// Swedish time — never the process's zone (the container may run UTC, and
// `new Date("2026-10-09T08:15:00")` would then be two hours off). Null for
// anything that is not a date-time.
const ZONED = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const ZONELESS = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)(?:\.(\d{1,9}))?$/;

export function bankFileInstant(raw: string | null | undefined): Date | null {
  const text = raw?.trim();
  if (!text) return null;
  let ms: number;
  if (ZONED.test(text)) ms = Date.parse(text);
  else {
    const m = ZONELESS.exec(text);
    if (!m) return null;
    ms = stockholmInstant(m[1]!, m[2]!) + (m[3] ? Math.floor(Number(`0.${m[3]}`) * 1000) : 0);
  }
  return Number.isNaN(ms) ? null : new Date(ms);
}
