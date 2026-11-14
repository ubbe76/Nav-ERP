import type { DocumentLanguage } from "@navet/shared";
import { documentTexts } from "./document-texts.js";

// The one number format of the documents and reports — a leaf without
// pdfkit, so pure files (year-end-checks.ts, configuration-lines.ts) can
// import it; document-pdf.ts re-exports it.
// Exported for the B6a economy reports, which format their own amounts
// (economy owns the content, mail owns the paper) and therefore need this
// function's minus handling — a balance sheet is full of negative numbers.
// `language` picks the locale (sv-SE "1 234,50", en-GB "1,234.50" — #7);
// the default keeps every internal caller Swedish.
export function formatNumber(value: number, decimals = 2, language: DocumentLanguage = "sv"): string {
  // sv-SE renders a negative sign as U+2212 (MINUS SIGN), which the old
  // Helvetica standard font (WinAnsi) had no glyph for. The embedded
  // Liberation Sans (pdf-fonts.ts) has one, but the documents and their
  // tests print the plain ASCII hyphen-minus since the credit notes, and
  // every caller that copies this text (economy reports, CSV) expects it —
  // so the normalization stays. Kept for every locale — ICU data differs
  // between builds.
  return value
    .toLocaleString(documentTexts(language).locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace("−", "-");
}
