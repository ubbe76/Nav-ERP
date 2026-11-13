import { describe, expect, it } from "vitest";
import { DOCUMENT_LANGUAGES, DOCUMENT_LANGUAGE_LABELS, documentLanguageOf } from "@navet/shared";
import * as webLanguage from "../../web/lib/documentLanguage.js";

// Dokument på engelska (#7): the web's partial mirror of the language list
// (the web cannot import @navet/shared). The mail defaults moved to the
// e-mail templates' catalog (mail-templates.route.test.ts).
describe("web mirror of the document languages", () => {
  it("has the same languages and labels as shared", () => {
    expect(webLanguage.DOCUMENT_LANGUAGES).toEqual(DOCUMENT_LANGUAGES);
    expect(webLanguage.DOCUMENT_LANGUAGE_LABELS).toEqual(DOCUMENT_LANGUAGE_LABELS);
  });

  it("reads a stored value the same way as shared", () => {
    for (const value of ["sv", "en", "de", "", null, undefined]) {
      expect(webLanguage.documentLanguageOf(value)).toBe(documentLanguageOf(value));
    }
  });
});
