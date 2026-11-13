import { describe, expect, it } from "vitest";
import { DOCUMENT_LANGUAGES } from "@navet/shared";
import { DOCUMENT_TEXTS, documentTexts, type DocumentTexts } from "../src/modules/mail/service/document-texts.js";
import { addressLines, formatArticleAttributes, formatNumber, formatRevisionInfo } from "../src/modules/mail/service/document-pdf.js";
import { configurationLines, formatMeasure, rowConfigurationLines } from "../src/modules/configurator/service/configuration-lines.js";
import {
  accruedInterestText,
  formatRates,
  LATE_INTEREST_TERMS_TEXT,
  lateFeeRowText,
  lateInterestRowText,
} from "../src/modules/sales/service/late-interest.js";
import { freightRowDescription } from "../src/modules/sales/service/invoice.service.js";

// Dokument på engelska (#7): the dictionary itself and the pure helpers that
// read it. The Swedish side is pinned by the ~42 pdfText suites; this file
// checks that the English side is complete (no empty or copied-over entry
// where the text obviously must differ) and that the helpers switch locale.

// Walks a dictionary: every string leaf, and every function leaf called with
// sample arguments — so a key added to the type cannot stay "" in a language.
function leaves(value: unknown, path: string, out: { path: string; text: string }[]) {
  if (typeof value === "string") out.push({ path, text: value });
  else if (typeof value === "function") {
    const args = sampleArgs(path);
    out.push({ path, text: String((value as (...a: unknown[]) => unknown)(...args)) });
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) leaves(child, `${path}.${key}`, out);
  }
}

function sampleArgs(path: string): unknown[] {
  if (path.endsWith("lateInterest.interestRow")) return [{ invoiceNumber: "FA-1", from: "2026-01-02", to: "2026-01-20", days: 19, rates: "12.00%" }];
  if (path.endsWith("lateInterest.rates")) return [[12]];
  if (path.endsWith("rowInfo.legoReference")) return ["PO-1", 20, "Svets"];
  if (path.endsWith("rowInfo.orderReference")) return ["KO-1", "4711"];
  if (path.endsWith("rowInfo.drawing")) return ["4711", "C"];
  if (path.endsWith("filenames.deviation")) return ["Complaint notice", "AV-1"];
  if (path.endsWith("freightRow")) return ["DHL Paket", "FR-1"];
  if (path.endsWith("pageOf") || path.endsWith("palletCard.parcel")) return [1, 2];
  if (path.endsWith("titles.paymentReminder")) return [2];
  if (path.endsWith("totals.vat")) return [25];
  if (path.endsWith("discount")) return ["10"];
  return ["X", "Y"];
}

describe("DOCUMENT_TEXTS — completeness", () => {
  it("has a dictionary for every document language", () => {
    expect(Object.keys(DOCUMENT_TEXTS).sort()).toEqual([...DOCUMENT_LANGUAGES].sort());
    for (const language of DOCUMENT_LANGUAGES) expect(documentTexts(language)).toBe(DOCUMENT_TEXTS[language]);
  });

  it("every text in every language is non-empty (strings and the parameterised functions alike)", () => {
    for (const language of DOCUMENT_LANGUAGES) {
      const out: { path: string; text: string }[] = [];
      leaves(DOCUMENT_TEXTS[language], language, out);
      expect(out.length).toBeGreaterThan(150);
      for (const leaf of out) expect(leaf.text.trim(), leaf.path).not.toBe("");
    }
  });

  it("the English texts differ from the Swedish where they obviously must — titles, labels, columns, totals, footer, filenames", () => {
    const sv = DOCUMENT_TEXTS.sv;
    const en = DOCUMENT_TEXTS.en;
    const mustDiffer: (keyof DocumentTexts)[] = [
      "titles",
      "partnerLabels",
      "meta",
      "terms",
      "columns",
      "totals",
      "reminder",
      "lateInterest",
      "deliveryNote",
      "palletCard",
      "deviation",
    ];
    for (const section of mustDiffer) {
      const svLeaves: { path: string; text: string }[] = [];
      const enLeaves: { path: string; text: string }[] = [];
      leaves(sv[section], `sv.${section}`, svLeaves);
      leaves(en[section], `en.${section}`, enLeaves);
      expect(enLeaves.map((l) => l.path.slice(3))).toEqual(svLeaves.map((l) => l.path.slice(3)));
      const same = enLeaves.filter((leaf, i) => leaf.text === svLeaves[i]!.text).map((leaf) => leaf.path);
      expect(same).toEqual([]);
    }
    expect(en.footer.orgNumber).toBe("Reg. no");
    expect(en.footer.vatNumber).toBe("VAT no");
    expect(en.footer.companySeat).toBe("Registered office");
    expect(en.footer.fSkatt).toBe("Approved for F-tax");
    expect(en.pricesIncludeVat).toBe("Prices include VAT");
    expect(en.totals.vat(25)).toBe("VAT (25%)");
    expect(sv.totals.vat(25)).toBe("Moms (25 %)");
    expect(en.totals.amountDue("EUR")).toBe("Amount due EUR");
    expect(en.totals.vatInSek("2,782.75", "11.131000")).toBe("VAT in SEK: 2,782.75 (rate 11.131000)");
    expect(en.lateInterest.terms).toBe("Interest on late payment is charged in accordance with the Swedish Interest Act (räntelagen).");
    expect(en.reminder.body).toBe("According to our records, the invoice below has not been paid. Please pay at your earliest convenience.");
    expect(en.configurationYes).toBe("Yes");
    for (const [key, make] of Object.entries(en.filenames)) {
      if (key === "deviation") continue;
      expect(make("X-1", "Y"), key).toMatch(/^[A-Z][A-Za-z-]+-X-1\.pdf$/);
    }
    expect(en.filenames.deviation("Complaint notice", "AV-1")).toBe("Complaint-notice-AV-1.pdf");
  });

  it("the credit note names the invoice it credits as a fact in the header box", () => {
    expect(DOCUMENT_TEXTS.sv.meta.creditedInvoice).toBe("Krediterar faktura");
    expect(DOCUMENT_TEXTS.en.meta.creditedInvoice).toBe("Credit note for invoice");
  });

  it("country names: Swedish list as before, English list covers the same codes", () => {
    expect(Object.keys(DOCUMENT_TEXTS.en.countryNames).sort()).toEqual(Object.keys(DOCUMENT_TEXTS.sv.countryNames).sort());
    expect(DOCUMENT_TEXTS.sv.countryNames.DE).toBe("Tyskland");
    expect(DOCUMENT_TEXTS.en.countryNames.DE).toBe("Germany");
  });
});

describe("number and text helpers follow the language", () => {
  it("formatNumber: sv-SE by default, en-GB for en; the minus is always the ASCII hyphen", () => {
    // sv-SE groups with U+00A0 (the no-break space).
    expect(formatNumber(1234.5)).toBe("1\u00a0234,50");
    expect(formatNumber(1234.5, 2, "sv")).toBe("1\u00a0234,50");
    expect(formatNumber(1234.5, 2, "en")).toBe("1,234.50");
    expect(formatNumber(-125, 2, "en")).toBe("-125.00");
    expect(formatNumber(11.131, 6, "en")).toBe("11.131000");
  });

  it("addressLines: country names in the document's language, ISO code for unlisted countries, never Sweden", () => {
    const address = { address: "Hauptstraße 1", postalCode: "10115", city: "Berlin", country: "DE" };
    expect(addressLines(address)).toEqual(["Hauptstraße 1", "10115 Berlin", "Tyskland"]);
    expect(addressLines(address, "en")).toEqual(["Hauptstraße 1", "10115 Berlin", "Germany"]);
    expect(addressLines({ ...address, country: "JP" }, "en")).toEqual(["Hauptstraße 1", "10115 Berlin", "JP"]);
    expect(addressLines({ ...address, country: "SE" }, "en")).toEqual(["Hauptstraße 1", "10115 Berlin"]);
  });

  it("formatArticleAttributes / formatRevisionInfo: English labels, values as entered", () => {
    expect(formatArticleAttributes({ surfaceTreatment: "Pulverlack RAL 9010", colour: "Vit" })).toBe("Ytbehandling: Pulverlack RAL 9010 · Färg: Vit");
    expect(formatArticleAttributes({ surfaceTreatment: "Pulverlack RAL 9010", colour: "Vit" }, "en")).toBe(
      "Surface treatment: Pulverlack RAL 9010 · Colour: Vit"
    );
    expect(formatArticleAttributes({ surfaceTreatment: null, colour: null }, "en")).toBeNull();
    const info = { revision: "B", drawings: [{ drawingNumber: "4711", revision: "C" }, { drawingNumber: "4712", revision: null }] };
    expect(formatRevisionInfo(info)).toBe("Rev B · Ritn 4711 rev C · Ritn 4712");
    expect(formatRevisionInfo(info, "en")).toBe("Rev B · Drawing 4711 rev C · Drawing 4712");
  });

  it("configurator lines: 'Ja' becomes 'Yes', measures and additions use en-GB; the default stays the Swedish mirror", () => {
    const selection = [
      { kind: "choice", groupCode: "front", groupName: "Front", valueCode: "x", valueName: "Rostfri" },
      { kind: "boolean", groupCode: "hyll", groupName: "Hyllplan", value: true },
      { kind: "measure", groupCode: "bredd", groupName: "Bredd", value: 1200.5, unit: "mm" },
    ] as never;
    const additions = [{ groupCode: "bredd", amount: 1240 }];
    expect(configurationLines(selection, additions)).toEqual(["Front: Rostfri", "Hyllplan: Ja", "Bredd: 1 200,5 mm (+ 1 240,00)"]);
    expect(configurationLines(selection, additions, "en")).toEqual(["Front: Rostfri", "Hyllplan: Yes", "Bredd: 1,200.5 mm (+ 1,240.00)"]);
    expect(formatMeasure(1234567.5, "en")).toBe("1,234,567.5");
    expect(rowConfigurationLines({ selection, price: { additions } }, false, "en")).toEqual(["Front: Rostfri", "Hyllplan: Yes", "Bredd: 1,200.5 mm"]);
    expect(rowConfigurationLines(null, true, "en")).toBeUndefined();
  });

  it("late-interest texts: Swedish unchanged, English rows/terms/accrued line", () => {
    expect(LATE_INTEREST_TERMS_TEXT).toBe("Vid betalning efter förfallodagen debiteras dröjsmålsränta enligt räntelagen.");
    expect(formatRates([10, 12])).toBe("10,00/12,00 %");
    expect(formatRates([10, 12], "en")).toBe("10.00/12.00%");
    expect(lateInterestRowText({ invoiceNumber: "FA-1234", from: "2026-09-02", to: "2026-09-20", days: 19, rates: [12] })).toBe(
      "Dröjsmålsränta FA-1234, 2026-09-02–2026-09-20 (19 dagar, 12,00 %)"
    );
    expect(lateInterestRowText({ invoiceNumber: "FA-1234", from: "2026-09-02", to: "2026-09-20", days: 19, rates: [12] }, "en")).toBe(
      "Interest on late payment FA-1234, 2026-09-02–2026-09-20 (19 days, 12.00%)"
    );
    expect(lateInterestRowText({ invoiceNumber: "FA-1", from: "2026-09-02", to: "2026-09-02", days: 1, rates: [12] }, "en")).toContain("(1 day,");
    expect(lateFeeRowText("FA-1234", "en")).toBe("Late payment compensation FA-1234");
    expect(accruedInterestText("2026-10-25", 1234.5)).toBe("Upplupen dröjsmålsränta t.o.m. 2026-10-25: 1 234,50 kr");
    expect(accruedInterestText("2026-10-25", 1234.5, "en")).toBe("Accrued interest on late payment through 2026-10-25: 1,234.50 SEK");
  });

  it("freight row text: 'Frakt …' / 'Freight …'", () => {
    const shipment = { carrierName: "DHL", productName: "Paket", shipmentNumber: "FR-2026-12" };
    expect(freightRowDescription(shipment)).toBe("Frakt DHL Paket (FR-2026-12)");
    expect(freightRowDescription(shipment, "en")).toBe("Freight DHL Paket (FR-2026-12)");
    expect(freightRowDescription({ carrierName: null, productName: null, shipmentNumber: "FR-1" }, "en")).toBe("Freight (FR-1)");
  });
});
