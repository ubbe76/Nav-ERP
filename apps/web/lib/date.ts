// "Today" in Sweden — never the server/container's local timezone. The
// Docker containers run UTC, so `new Date().toISOString().slice(0, 10)`
// silently returns tomorrow's date for a few hours every evening. Format
// used (sv-SE) yields YYYY-MM-DD directly.
export function stockholmToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
}

const STOCKHOLM_DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });
const STOCKHOLM_DATE_TIME = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", dateStyle: "short", timeStyle: "short" });

// A timestamp shown in Swedish time — never the server's (UTC in Docker,
// which also makes server and browser render different text) nor the browser's.
export const formatStockholmDate = (iso: string | null): string => (iso ? STOCKHOLM_DATE.format(new Date(iso)) : "–");
export const formatStockholmDateTime = (iso: string | null): string => (iso ? STOCKHOLM_DATE_TIME.format(new Date(iso)) : "–");

// ISO instant -> "YYYY-MM-DDTHH:MM" for <input type="datetime-local">, in the
// browser's local time (the input has no timezone of its own).
export function toDateTimeLocalValue(iso: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// YYYY-MM-DD plus whole calendar days (pure calendar arithmetic in UTC, so
// the browser's timezone and DST never shift the result).
export function addDaysIso(day: string, days: number): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
