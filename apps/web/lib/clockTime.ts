// Klockslag (scheman, OB-tillägg): a 24-hour clock time "HH:MM", typed
// loosely — "7" → "07:00", "730"/"7:30"/"7.30" → "07:30", "1630" → "16:30".
// One or two digits are whole hours (unlike a duration, where they are
// minutes). While typed, digits get their colon as in the duration fields
// (withAutoColon in lib/duration.ts). Null when the text is no clock time.
export function normalizeClockTime(raw: string): string | null {
  const cleaned = raw.trim().replace(/[.,]/g, ":");
  let hours: number;
  let minutes: number;
  if (cleaned.includes(":")) {
    const [h = "", m = ""] = cleaned.split(":");
    if (!/^\d{1,2}$/.test(h) || !/^\d{0,2}$/.test(m)) return null;
    hours = Number(h);
    minutes = m === "" ? 0 : Number(m.padEnd(2, "0"));
  } else if (/^\d{1,4}$/.test(cleaned)) {
    if (cleaned.length <= 2) {
      hours = Number(cleaned);
      minutes = 0;
    } else {
      hours = Number(cleaned.slice(0, -2));
      minutes = Number(cleaned.slice(-2));
    }
  } else {
    return null;
  }
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export const CLOCK_PATTERN = "([01][0-9]|2[0-3]):[0-5][0-9]";
