import { describe, expect, it } from "vitest";
import { DOCUMENT_LANGUAGES, DOCUMENT_LANGUAGE_LABELS, documentLanguageOf } from "@navet/shared";
import * as webLanguage from "../../web/lib/documentLanguage.js";
import { documentMailTexts } from "../../web/lib/documentMailTexts.js";

// Dokument på engelska (#7): the web's partial mirror of the language list
// (the web cannot import @navet/shared) and the mail defaults. The Swedish
// defaults are the literals the pages hard-coded before #7 — word for word.
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

describe("documentMailTexts", () => {
  const hej = (text: string) => `Hej!\n\n${text}\n\nMed vänliga hälsningar`;

  it("reproduces the pre-#7 Swedish defaults exactly", () => {
    expect(documentMailTexts({ kind: "quote", number: "OF100" }, "sv")).toEqual({
      subject: "Offert OF100",
      body: hej("Se bifogad offert OF100."),
    });
    expect(documentMailTexts({ kind: "orderConfirmation", number: "KO200" }, "sv")).toEqual({
      subject: "Orderbekräftelse KO200",
      body: hej("Tack för er order. Se bifogad orderbekräftelse KO200."),
    });
    expect(documentMailTexts({ kind: "orderConfirmation", number: "KO200", quoteNumber: "OF100" }, "sv")).toEqual({
      subject: "Orderbekräftelse för offert OF100",
      body: hej("Tack för er order. Se bifogad orderbekräftelse för vår offert OF100."),
    });
    expect(documentMailTexts({ kind: "legacyInvoice", number: "F1" }, "sv")).toEqual({
      subject: "Faktura F1",
      body: hej("Se bifogad faktura F1."),
    });
    expect(documentMailTexts({ kind: "invoice", number: "F1" }, "sv")).toEqual({
      subject: "Faktura F1",
      body: hej("Se bifogad faktura F1."),
    });
    expect(documentMailTexts({ kind: "creditNote", number: "F2" }, "sv")).toEqual({
      subject: "Kreditfaktura F2",
      body: hej("Se bifogad kreditfaktura F2."),
    });
    expect(documentMailTexts({ kind: "paymentReminder", number: "F1" }, "sv")).toEqual({
      subject: "Betalningspåminnelse faktura F1",
      body: hej("Vi har tyvärr ännu inte mottagit betalning för faktura F1. Se bifogad påminnelse."),
    });
    expect(documentMailTexts({ kind: "inquiry", number: "FF1" }, "sv")).toEqual({
      subject: "Förfrågan FF1",
      body: hej("Se bifogad förfrågan FF1."),
    });
    expect(documentMailTexts({ kind: "purchaseOrder", number: "IO1" }, "sv")).toEqual({
      subject: "Inköpsorder IO1",
      body: hej("Se bifogad inköpsorder IO1."),
    });
    for (const [type, title] of [
      ["customer", "Reklamationsbesked"],
      ["supplier", "Reklamation"],
      ["internal", "Avvikelserapport"],
    ] as const) {
      expect(documentMailTexts({ kind: "deviation", number: "AV1", deviationType: type }, "sv")).toEqual({
        subject: `${title} AV1`,
        body: hej(`Se bifogat ${title.toLowerCase()} AV1.`),
      });
    }
  });

  it("writes English defaults with no Swedish left", () => {
    const kinds = [
      { kind: "quote", number: "OF100" },
      { kind: "orderConfirmation", number: "KO200" },
      { kind: "orderConfirmation", number: "KO200", quoteNumber: "OF100" },
      { kind: "legacyInvoice", number: "F1" },
      { kind: "invoice", number: "F1" },
      { kind: "creditNote", number: "F2" },
      { kind: "paymentReminder", number: "F1" },
      { kind: "inquiry", number: "FF1" },
      { kind: "purchaseOrder", number: "IO1" },
      { kind: "deviation", number: "AV1", deviationType: "customer" },
      { kind: "deviation", number: "AV1", deviationType: "supplier" },
    ] as const;
    for (const doc of kinds) {
      const { subject, body } = documentMailTexts(doc, "en");
      expect(body.startsWith("Hello,\n\n")).toBe(true);
      expect(body.endsWith("\n\nBest regards")).toBe(true);
      expect(`${subject} ${body}`).not.toMatch(/[åäöÅÄÖ]|Hej|bifogad|Offert|Faktura|Förfrågan|Inköpsorder/);
    }
    expect(documentMailTexts({ kind: "quote", number: "OF100" }, "en").subject).toBe("Quotation OF100");
    expect(documentMailTexts({ kind: "creditNote", number: "F2" }, "en").subject).toBe("Credit note F2");
  });
});
