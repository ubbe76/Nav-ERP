import { isoWeekNumber } from "./deliveryTimeCheck";

// Alternativa resurser (#15, etapp 2): the wording of a förslag. Weeks arrive
// as Mondays (YYYY-MM-DD). The same text is used on the TO card, in the
// Beläggning expansion and in Planera's notice.

export interface SuggestionTexts {
  code: string;
  toWeek: string;
  currentToWeek: string | null;
  reason: "overloaded" | "unplanned";
}

const weekOf = (monday: string) => `v.${isoWeekNumber(monday)}`;

// "Kan bli klar v.47 på 120 (i stället för v.49)" — or, when the current
// resource has no plan, "Kan planeras klar v.47 på 120 (saknar plan på nuvarande resurs)".
export function suggestionText(s: SuggestionTexts): string {
  if (s.reason === "unplanned" || s.currentToWeek === null) {
    return `Kan planeras klar ${weekOf(s.toWeek)} på ${s.code} (saknar plan på nuvarande resurs)`;
  }
  return `Kan bli klar ${weekOf(s.toWeek)} på ${s.code} (i stället för ${weekOf(s.currentToWeek)})`;
}

// The list rows: "110 → 120, v.49 → v.47" ("110 → 120, v.47" when unplanned).
export function suggestionShift(s: SuggestionTexts & { fromCode: string }): string {
  const weeks =
    s.currentToWeek === null ? weekOf(s.toWeek) : `${weekOf(s.currentToWeek)} → ${weekOf(s.toWeek)}`;
  return `${s.fromCode} → ${s.code}, ${weeks}`;
}

// "3 förslag på alternativ resurs"
export function suggestionCountLabel(n: number): string {
  return `${n} förslag på alternativ resurs`;
}

// "3 operationer kan bli klara tidigare på en alternativ resurs"
export function planSuggestionNotice(n: number): string {
  return n === 1
    ? "1 operation kan bli klar tidigare på en alternativ resurs"
    : `${n} operationer kan bli klara tidigare på en alternativ resurs`;
}
