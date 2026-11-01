// Dokument på engelska (#7): web mirror of the language list in
// packages/shared/src/document-language.ts (the web cannot import @navet/shared).
export const DOCUMENT_LANGUAGES = ["sv", "en"] as const;
export type DocumentLanguage = (typeof DOCUMENT_LANGUAGES)[number];

export const DOCUMENT_LANGUAGE_LABELS: Record<DocumentLanguage, string> = {
  sv: "Svenska",
  en: "Engelska",
};

// Anything but "en" is Swedish, the regression-safe side.
export function documentLanguageOf(value: string | null | undefined): DocumentLanguage {
  return value === "en" ? "en" : "sv";
}
