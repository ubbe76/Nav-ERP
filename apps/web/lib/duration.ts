// Tidsfälten (2026-11-22, användarens val): a duration is typed as tt:mm —
// "1:30" — and a bare number is minutes ("90" = 1:30, "8" = 0:08). The
// separator may be ":", "." (Swedish clock times are written 7.30) or ","
// (the only separator on a Swedish phone's decimal keypad), but the minutes
// are always two digits: the old habit "4,5" (hours) is refused instead of
// read as 4:50 or 4 minutes. The API keeps its units — minutes, or hours with
// two decimals — so the forms convert at the edge.
import { round2 } from "./format";

export const DURATION_HINT = "Skriv tiden som tt:mm, t.ex. 1:30 eller 1,30 — eller bara minuter, t.ex. 90.";

// The example a field shows on a touch screen, where it opens the decimal
// keypad: no colon there, only the comma (user's choice 2026-11-24 — the
// iPhone keypad had no colon and nothing said the comma works). A clock
// example ("t.ex. 8:00") or the bare "tt:mm" gets the comma; any other text
// (a system default shown as a value) is left as it is.
export function keypadPlaceholder(placeholder: string): string {
  if (placeholder.trim() === "tt:mm") return "t.ex. 1,30";
  return placeholder.replace(/^t\.ex\. (\d+):([0-5]\d)$/, "t.ex. $1,$2");
}

const BODY = String.raw`(?:\d{1,6}|\d{0,4}[:.,][0-5]\d)`;

// The input's pattern attribute (anchored by the browser, compiled with the
// v flag — hence the sign as an alternation, not a class).
export function durationPattern(signed = false): string {
  return signed ? String.raw`\s*(?:-|−)?\s*${BODY}\s*` : String.raw`\s*${BODY}\s*`;
}

const PARSE = /^(-|−)?\s*(?:(\d{1,6})|(\d{0,4})[:.,]([0-5]\d))$/;

// Minutes, or null when the text is not a duration. A sign only when signed
// (an ATF adjustment can be negative).
export function parseDuration(text: string, { signed = false }: { signed?: boolean } = {}): number | null {
  const match = PARSE.exec(text.trim());
  if (!match) return null;
  const [, sign, bare, hours, minutes] = match;
  if (sign && !signed) return null;
  const total = bare !== undefined ? Number(bare) : Number(hours || "0") * 60 + Number(minutes);
  return sign && total !== 0 ? -total : total;
}

// "1:30", "40:00", "0:08", "-1:30" — whole minutes.
export function formatDuration(minutes: number): string {
  const whole = Math.round(Math.abs(minutes));
  const text = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  return minutes < 0 && whole > 0 ? `-${text}` : text;
}

// An hours value (numeric with two decimals) as the field shows it.
export function durationFromHours(hours: number | string): string {
  return formatDuration(Number(hours) * 60);
}

// What an hours field sends: hours to two decimals, as the column keeps
// them — but the stored value itself while the field still shows it, since
// two decimals do not survive the round trip (0.01 h shows as 0:01, which
// is 0.02 h). Null when the text is not a duration.
export function hoursFromDuration(text: string, original?: number | string | null): number | null {
  const minutes = parseDuration(text);
  if (minutes === null) return null;
  if (original !== undefined && original !== null && original !== "" && formatDuration(minutes) === durationFromHours(original)) {
    return Number(original);
  }
  return round2(minutes / 60);
}

// Frånvaro (the personalkort, the attestation and Stämplingar): 0:01–24:00 —
// the API's 1–1440 minutes. The minutes, or the error text to show.
export function readAbsenceMinutes(text: string): number | string {
  const minutes = parseDuration(text);
  if (minutes === null) return DURATION_HINT;
  if (minutes < 1 || minutes > 1440) return "Frånvaron ska vara mellan 0:01 och 24:00.";
  return minutes;
}
