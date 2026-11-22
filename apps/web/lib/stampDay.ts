// Stämplingar (Personal & lön → Stämplingar, 2026-11-22): the page's pure
// rules — the address, the clock texts and what a datetime-local field sends.
import { toDateTimeLocalValue } from "./date";
import { round2 } from "./format";

export const STAMP_DAY_PATH = "/personal/stamplingar";

export function stampDayHref(employeeId: string, date: string): string {
  return `${STAMP_DAY_PATH}?employee=${encodeURIComponent(employeeId)}&date=${date}`;
}

const clockFormat = new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
const dayFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" });
const shortDayFormat = new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", timeZone: "Europe/Stockholm" });
const longDayFormat = new Intl.DateTimeFormat("sv-SE", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// "07:02" on the viewed day, "2 nov. 22:10" on another (a pass over midnight).
export function stampClock(iso: string, day: string): string {
  const instant = new Date(iso);
  const clock = clockFormat.format(instant);
  return dayFormat.format(instant) === day ? clock : `${shortDayFormat.format(instant)} ${clock}`;
}

export function stampRange(startIso: string, stopIso: string | null, day: string): string {
  return `${stampClock(startIso, day)} – ${stopIso ? stampClock(stopIso, day) : "pågår"}`;
}

// "tisdag 3 november 2026" — the day is a calendar date, read in UTC.
export function stampDayLabel(day: string): string {
  return longDayFormat.format(new Date(`${day}T00:00:00Z`));
}

// What a datetime-local field sends. The field has whole minutes: left as it
// was opened it sends the stored instant itself, so the stored seconds are
// never cut off (the server then sees no change). Null = not a time.
export function instantFromField(field: string, original: string | null): string | null {
  if (original !== null && field === toDateTimeLocalValue(original)) return original;
  const ms = Date.parse(field);
  return field === "" || Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// The hours a stamp reports — the server's stampedHours: (stop − start −
// pause), to two decimals, at least 0.01. For the form's preview; null when
// the times do not make a stint.
export function stampHours(startIso: string | null, stopIso: string | null, pauseMinutes: number): number | null {
  if (!startIso || !stopIso) return null;
  const ms = Date.parse(stopIso) - Date.parse(startIso) - pauseMinutes * 60_000;
  if (Number.isNaN(ms) || Date.parse(stopIso) <= Date.parse(startIso) || ms <= 0) return null;
  return Math.max(0.01, round2(ms / 3_600_000));
}
