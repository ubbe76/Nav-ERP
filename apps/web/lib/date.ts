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
