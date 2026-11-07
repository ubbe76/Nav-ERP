// Where a price markup (generellt påslag / materialpåslag) came from (#16).
// Mirrors the API's `costing_markup_level` enum; the web cannot import
// @navet/shared, so the type lives here and in lib/types.ts.
export type MarkupLevel = "company" | "group" | "trial";

// Capitalised: the panel and the table (Företaget / Varugrupp / Prövat).
export const MARKUP_LEVEL_NAMES: Record<MarkupLevel, string> = {
  company: "Företaget",
  group: "Varugrupp",
  trial: "Prövat",
};

// Lower case, for the suffix in a chain label: "Generellt påslag 25 % (företaget)".
export const MARKUP_LEVEL_WORDS: Record<MarkupLevel, string> = {
  company: "företaget",
  group: "varugruppen",
  trial: "prövat",
};

function percentText(value: string | number): string {
  return `${Number(value).toLocaleString("sv-SE", { maximumFractionDigits: 2 })} %`;
}

// "Generellt påslag 25 % (företaget)". Without a level (a draft from an older
// API, a stub) the label is the plain name, as before.
export function markupLabel(
  name: string,
  percent: string | number | undefined,
  level: MarkupLevel | undefined
): string {
  if (percent === undefined || level === undefined) return name;
  return `${name} ${percentText(percent)} (${MARKUP_LEVEL_WORDS[level]})`;
}

// "40 % / —" for the Påslag column of the varugrupp list: the group's own
// general and material markup, "—" where the group inherits the company's.
export function groupMarkupsText(general: string | null, material: string | null): string {
  const part = (v: string | null) => (v === null ? "—" : percentText(v));
  return `${part(general)} / ${part(material)}`;
}
