// Tidsfälten (2026-11-22, användarens val): a duration is typed as tt:mm —
// "1:30". Digits alone are read with the last two as the minutes
// (2026-11-25, the user's wish — "130" = 1:30, "0130" = 1:30) and the field
// puts the colon in while they are typed (withAutoColon), so a phone's
// decimal keypad, which has no colon, is enough; one or two digits alone are
// minutes ("90" = 1:30, "8" = 0:08). The separator may also be typed: ":",
// "." (Swedish clock times are written 7.30) or ",", but the minutes are
// always two digits: the old habit "4,5" (hours) is refused instead of read
// as 4:50 or 4 minutes. The API keeps its units — minutes, or hours with two
// decimals — so the forms convert at the edge.
import { round2 } from "./format";

export const DURATION_HINT = "Skriv tiden som tt:mm, t.ex. 1:30 — kolonet fylls i själv, så 130 räcker. En eller två siffror är minuter, t.ex. 90.";

const BODY = String.raw`(?:\d{1,2}|\d{1,4}[0-5]\d|\d{0,4}[:.,][0-5]\d)`;

// The input's pattern attribute (anchored by the browser, compiled with the
// v flag — hence the sign as an alternation, not a class).
export function durationPattern(signed = false): string {
  return signed ? String.raw`\s*(?:-|−)?\s*${BODY}\s*` : String.raw`\s*${BODY}\s*`;
}

// Minutes alone (one or two digits), digits with the last two as the minutes,
// or hours and minutes with a separator.
const PARSE = /^(-|−)?\s*(?:(\d{1,2})|(\d{1,4})([0-5]\d)|(\d{0,4})[:.,]([0-5]\d))$/;

// Minutes, or null when the text is not a duration. A sign only when signed
// (an ATF adjustment can be negative).
export function parseDuration(text: string, { signed = false }: { signed?: boolean } = {}): number | null {
  const match = PARSE.exec(text.trim());
  if (!match) return null;
  const [, sign, bare, digitHours, digitMinutes, hours, minutes] = match;
  if (sign && !signed) return null;
  const total =
    bare !== undefined
      ? Number(bare)
      : digitHours !== undefined
        ? Number(digitHours) * 60 + Number(digitMinutes)
        : Number(hours || "0") * 60 + Number(minutes);
  return sign && total !== 0 ? -total : total;
}

// What the field shows while it is typed in (2026-11-25, the user's wish:
// one or two digits for the hours, two for the minutes, and the colon filled
// in — every field where hours and minutes share one field, the clock times
// too). Digits alone get the colon before the last two as soon as there are
// three — "130" shows 1:30, "0130" 01:30 — so deleting the colon on its own
// puts it back. A digit added to a time the field shows complete moves the
// colon along ("1:30" and a "5" is 13:05). A deletion is left as it is
// ("13:05" and a backspace is "13:0", so the last digit can be retyped), as
// is a colon, point or comma typed by hand on its way to a time; leaving the
// field writes the reading.
export function withAutoColon(next: string, previous: string): string {
  const [, sign, body] = /^\s*([-−]?)\s*(.*?)\s*$/.exec(next) ?? [];
  if (body === undefined) return next;
  const grewFromComplete = next.length > previous.length && /^\s*[-−]?\s*\d+:\d\d\s*$/.test(previous);
  const digits = /^\d+$/.test(body) ? body : grewFromComplete && /^\d*:\d*$/.test(body) ? body.replace(":", "") : null;
  if (digits === null) return next;
  return sign + (digits.length >= 3 ? `${digits.slice(0, -2)}:${digits.slice(-2)}` : digits);
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
