import { shortDate } from "./planning";

// Alternativa resurser (#15, etapp 2): the wording of a förslag. Dates arrive
// as YYYY-MM-DD. The same text is used on the TO card, in the
// Beläggning expansion and in Planera's notice.

export interface SuggestionTexts {
  code: string;
  toDate: string;
  currentToDate: string | null;
  reason: "overloaded" | "unplanned";
}

const dayOf = shortDate;

// "Kan bli klar 12 nov på 120 (i stället för 14 nov)" — or, when the current
// resource has no plan, "Kan planeras klar 12 nov på 120 (saknar plan på nuvarande resurs)".
export function suggestionText(s: SuggestionTexts): string {
  if (s.reason === "unplanned" || s.currentToDate === null) {
    return `Kan planeras klar ${dayOf(s.toDate)} på ${s.code} (saknar plan på nuvarande resurs)`;
  }
  return `Kan bli klar ${dayOf(s.toDate)} på ${s.code} (i stället för ${dayOf(s.currentToDate)})`;
}

// The list rows: "110 → 120, 14 nov → 12 nov" ("110 → 120, 12 nov" when unplanned).
export function suggestionShift(s: SuggestionTexts & { fromCode: string }): string {
  const dates =
    s.currentToDate === null ? dayOf(s.toDate) : `${dayOf(s.currentToDate)} → ${dayOf(s.toDate)}`;
  return `${s.fromCode} → ${s.code}, ${dates}`;
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
