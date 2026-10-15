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
