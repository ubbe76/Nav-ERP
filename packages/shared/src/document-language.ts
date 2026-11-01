import { z } from "zod";

// Dokument på engelska (#7). The language a counterparty's documents are
// written in: the customer's steers quote/order confirmation/delivery
// note/pallet card/deviation report at print time and is STAMPED on the
// invoice at Utfärda (invoices.language — the PDF is archived then); the
// supplier's steers the inquiry/purchase order. Swedish is the default and
// the regression guard: the Swedish print never changes with the English
// fields. More languages are added here, in the three CHECK constraints
// (customers/suppliers/invoices.language) and in the PDF dictionary.
export const DOCUMENT_LANGUAGES = ["sv", "en"] as const;
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number];

export const DEFAULT_DOCUMENT_LANGUAGE: DocumentLanguage = "sv";

export const documentLanguageSchema = z.enum(DOCUMENT_LANGUAGES);

export function isDocumentLanguage(value: string): value is DocumentLanguage {
  return (DOCUMENT_LANGUAGES as readonly string[]).includes(value);
}

// A stored language column (varchar, CHECK-guarded) as the type — anything
// else (a column value from before the CHECK, an unknown value in a test
// fixture) is Swedish, the regression-safe side.
export function documentLanguageOf(value: string | null | undefined): DocumentLanguage {
  return value !== null && value !== undefined && isDocumentLanguage(value) ? value : DEFAULT_DOCUMENT_LANGUAGE;
}

// Swedish names of the languages for the pickers and the imports' Språk
// column ("Svenska"/"Engelska").
export const DOCUMENT_LANGUAGE_LABELS: Record<DocumentLanguage, string> = {
  sv: "Svenska",
  en: "Engelska",
};

// The imports' Språk column (customers, suppliers): the code or the Swedish
// or English name of the language, case-insensitively — "sv", "en",
// "Svenska", "Engelska", "Swedish", "English". null = not a language (the
// planner makes it a row error; an empty cell never reaches this).
export function parseDocumentLanguageCell(raw: string): DocumentLanguage | null {
  const value = raw.trim().toLowerCase();
  if (value === "sv" || value === "svenska" || value === "swedish") return "sv";
  if (value === "en" || value === "engelska" || value === "english") return "en";
  return null;
}

// The ONE fallback rule for every translatable field (article name and
// extra description, the terms' names, the unit code, the VAT code's name
// and invoice text): English only when the document is in English AND an
// English text is filled in; otherwise the Swedish text. A blank or
// whitespace-only English text counts as not filled in.
export function localized(sv: string, en: string | null | undefined, language: DocumentLanguage): string {
  if (language === "en" && en !== null && en !== undefined && en.trim() !== "") return en;
  return sv;
}
