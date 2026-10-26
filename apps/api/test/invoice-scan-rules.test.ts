import { describe, expect, it } from "vitest";
import { emptyInvoiceScanResult, isUncertain, rulesSufficient, type InvoiceScanRow } from "@navet/shared";
import {
  findBankgiros,
  findBics,
  findForeignVatNumbers,
  findIbans,
  findOrgNumbers,
  findPlusgiros,
  findSwedishVatNumbers,
  isValidOcr,
  normalizeOrgNumber,
} from "../src/modules/purchase/service/invoice-scan/identifiers.js";
import { findAmounts, findDates, parseLastAmount, plausibleDueDate, plausibleInvoiceDate } from "../src/modules/purchase/service/invoice-scan/invoice-values.js";
import { allLines, buildLines, extractPdfText, hasTextLayer, PdfUnreadableError, type PdfTextLine } from "../src/modules/purchase/service/invoice-scan/pdf-text.js";
import {
  interpretRules,
  learnLabels,
  matchSupplier,
  normalizeLabel,
  type CompanyIdentity,
  type SupplierIdentity,
} from "../src/modules/purchase/service/invoice-scan/rules-interpreter.js";
import { canPerform, INVOICE_SCAN_ACTIONS, statusAfter } from "../src/modules/purchase/service/invoice-scan/invoice-scan-status.js";
import { matchInvoiceRows, matchPurchaseOrder, purchaseOrderTokens } from "../src/modules/purchase/service/invoice-scan/po-matching.js";
import { brokenPdf, FAKE_BUYER, FAKE_OCR, FAKE_OTHER_SUPPLIER, FAKE_SUPPLIER, imageOnlyPdf, invoicePdf } from "./helpers/invoice-pdf.js";

// Fakturaskanning — the pure parts (spec §6): identifiers, dates/amounts,
// the rules on a real pdfkit text layer, rulesSufficient, the learning's
// label search, the status whitelist and the purchase order matching. All
// numbers are made up (only their check digits are real).

const TODAY = "2026-10-15";

const company: CompanyIdentity = {
  name: FAKE_BUYER.name,
  orgNumber: FAKE_BUYER.orgNumber,
  vatNumber: FAKE_BUYER.vatNumber,
  bankgiro: FAKE_BUYER.bankgiro,
  plusgiro: null,
  iban: null,
  postalCode: FAKE_BUYER.postalCode,
};

const supplier: SupplierIdentity = {
  id: "00000000-0000-4000-8000-000000000001",
  name: FAKE_SUPPLIER.name,
  orgNumber: FAKE_SUPPLIER.orgNumber,
  vatNumber: null,
  bankgiro: null,
  plusgiro: null,
  iban: null,
  currency: "SEK",
  country: "SE",
};
const other: SupplierIdentity = {
  id: "00000000-0000-4000-8000-000000000002",
  name: FAKE_OTHER_SUPPLIER.name,
  orgNumber: FAKE_OTHER_SUPPLIER.orgNumber,
  vatNumber: null,
  bankgiro: "55598767",
  plusgiro: null,
  iban: null,
  currency: "SEK",
  country: "SE",
};

async function linesOf(pdf: Promise<Buffer>): Promise<PdfTextLine[]> {
  return allLines(await extractPdfText(await pdf));
}

describe("identifiers", () => {
  it("finds organisationsnummer with a valid Luhn digit only", () => {
    expect(findOrgNumbers("Org.nr 559900-1236")).toEqual(["5599001236"]);
    expect(findOrgNumbers("Org.nr 559900-1237")).toEqual([]);
    // Ten bare digits count only on a line that names the number.
    expect(findOrgNumbers("Organisationsnummer 5599001236")).toEqual(["5599001236"]);
    expect(findOrgNumbers("Telefon 5599001236")).toEqual([]);
    expect(normalizeOrgNumber("16559900-1236")).toBe("5599001236");
  });

  it("finds Swedish and EU VAT numbers, never ordinary words", () => {
    expect(findSwedishVatNumbers("Momsreg.nr SE559900123601")).toEqual(["SE559900123601"]);
    expect(findSwedishVatNumbers("SE 559900-1236 01")).toEqual(["SE559900123601"]);
    expect(findSwedishVatNumbers("SE559900123701")).toEqual([]);
    expect(findForeignVatNumbers("USt-IdNr DE123456789")).toEqual(["DE123456789"]);
    expect(findForeignVatNumbers("DENNA FAKTURA AVSER DELLEVERANS")).toEqual([]);
  });

  it("finds bankgiro and plusgiro after their labels, Luhn-checked", () => {
    expect(findBankgiros("Bankgiro 5550-1233")).toEqual(["55501233"]);
    expect(findBankgiros("BG 5559-8767")).toEqual(["55598767"]);
    expect(findBankgiros("BG 123-4566")).toEqual(["1234566"]);
    expect(findBankgiros("Bankgiro 5550-1234")).toEqual([]);
    expect(findBankgiros("Telefon 5550-1233")).toEqual([]);
    expect(findPlusgiros("Bankgiro 5550-1233   Plusgiro 12 34 56-6")).toEqual(["1234566"]);
    expect(findPlusgiros("PG 123456-6")).toEqual(["1234566"]);
  });

  it("checks IBAN with mod 97 and reads a BIC after its label", () => {
    expect(findIbans("IBAN SE35 9999 0000 0012 3456 7890")).toEqual(["SE3599990000001234567890"]);
    expect(findIbans("IBAN SE36 9999 0000 0012 3456 7890")).toEqual([]);
    expect(findBics("BIC TESTSESS")).toEqual(["TESTSESS"]);
    expect(findBics("TESTSESS")).toEqual([]);
  });

  it("validates OCR with mod 10", () => {
    expect(isValidOcr(FAKE_OCR)).toBe(true);
    expect(isValidOcr("471100017")).toBe(false);
    expect(isValidOcr("1")).toBe(false);
  });
});

describe("dates and amounts", () => {
  it("reads the date formats", () => {
    expect(findDates("2026-10-01").map((d) => d.value)).toEqual(["2026-10-01"]);
    expect(findDates("20261001").map((d) => d.value)).toEqual(["2026-10-01"]);
    expect(findDates("01.10.2026").map((d) => d.value)).toEqual(["2026-10-01"]);
    expect(findDates("01/10/2026").map((d) => d.value)).toEqual(["2026-10-01"]);
    expect(findDates("1 oktober 2026").map((d) => d.value)).toEqual(["2026-10-01"]);
    expect(findDates("1 okt. 2026").map((d) => d.value)).toEqual(["2026-10-01"]);
    expect(findDates("15 March 2026").map((d) => d.value)).toEqual(["2026-03-15"]);
    expect(findDates("2026-02-30")).toEqual([]);
  });

  it("reads Swedish and English amounts, never a date or a percentage", () => {
    const values = (text: string) => findAmounts(text).map((a) => a.value);
    expect(values("1 234,50")).toEqual([1234.5]);
    expect(values("1.234,50")).toEqual([1234.5]);
    expect(values("1,234.50")).toEqual([1234.5]);
    expect(values("1234.50 SEK")).toEqual([1234.5]);
    expect(values("−1 234,50 kr")).toEqual([-1234.5]);
    expect(values("1 234,50-")).toEqual([-1234.5]);
    expect(values("30.11.2026")).toEqual([]);
    expect(values("25,00 %")).toEqual([]);
    expect(values("1250")).toEqual([]);
    expect(parseLastAmount("Moms 25 % på 1 000,00: 250,00")).toBe(250);
  });

  it("judges the dates' plausibility", () => {
    expect(plausibleInvoiceDate("2026-10-01", TODAY)).toBe(true);
    expect(plausibleInvoiceDate("2024-01-01", TODAY)).toBe(false);
    expect(plausibleDueDate("2026-10-31", "2026-10-01")).toBe(true);
    expect(plausibleDueDate("2026-09-30", "2026-10-01")).toBe(false);
    expect(plausibleDueDate("2027-06-01", "2026-10-01")).toBe(false);
  });
});

describe("pdf-text", () => {
  it("reads a pdfkit invoice into lines and cells", async () => {
    const text = await extractPdfText(await invoicePdf());
    expect(hasTextLayer(text)).toBe(true);
    expect(text.pageCount).toBe(1);
    const line = allLines(text).find((l) => l.text.startsWith("Fakturanummer"));
    expect(line?.cells.map((c) => c.text)).toEqual(["Fakturanummer:", "10045"]);
  });

  it("finds no text layer in an image-only PDF", async () => {
    const text = await extractPdfText(await imageOnlyPdf());
    expect(hasTextLayer(text)).toBe(false);
  });

  it("turns a broken file into PdfUnreadableError", async () => {
    await expect(extractPdfText(brokenPdf())).rejects.toBeInstanceOf(PdfUnreadableError);
    await expect(extractPdfText(Buffer.from("not a pdf"))).rejects.toBeInstanceOf(PdfUnreadableError);
  });

  it("reads at most maxPages pages", async () => {
    const text = await extractPdfText(await invoicePdf({ pages: 3 }), { maxPages: 2 });
    expect(text.pageCount).toBe(3);
    expect(text.pages).toHaveLength(2);
    expect(text.truncated).toBe(true);
  });

  it("groups items into lines on y and cells on the gap", () => {
    const lines = buildLines(
      [
        { text: "Att betala:", x: 40, y: 100, width: 50 },
        { text: "1 250,00", x: 200, y: 101, width: 40 },
        { text: "kr", x: 243, y: 100, width: 10 },
        { text: "Nästa rad", x: 40, y: 120, width: 40 },
      ],
      1
    );
    expect(lines.map((l) => l.cells.map((c) => c.text))).toEqual([["Att betala:", "1 250,00 kr"], ["Nästa rad"]]);
  });
});

describe("interpretRules on a generated invoice", () => {
  it("reads every header field and matches the supplier on its organisationsnummer", async () => {
    const lines = await linesOf(invoicePdf({ orderReference: "IO-1007" }));
    const result = interpretRules({ lines, company, suppliers: [supplier, other], hints: [], today: TODAY });
    expect(result.supplier).toMatchObject({ matchedSupplierId: supplier.id, matchedBy: "org_number", confidence: "high" });
    expect(result.invoiceNumber).toEqual({ value: "10045", confidence: "high", source: "rules" });
    expect(result.invoiceDate).toEqual({ value: "2026-10-01", confidence: "high", source: "rules" });
    expect(result.dueDate).toEqual({ value: "2026-10-31", confidence: "high", source: "rules" });
    expect(result.netAmount).toMatchObject({ value: 1000, confidence: "high" });
    expect(result.vatAmount).toMatchObject({ value: 250, confidence: "high" });
    expect(result.grossAmount).toMatchObject({ value: 1250, confidence: "high" });
    expect(result.vatRate).toMatchObject({ value: 25, confidence: "high" });
    expect(result.paymentReference).toMatchObject({ value: { kind: "ocr", value: FAKE_OCR }, confidence: "high" });
    expect(result.currency).toMatchObject({ value: "SEK", confidence: "high" });
    expect(result.isCreditNote).toMatchObject({ value: false });
    expect(result.purchaseOrderReference).toMatchObject({ value: "IO-1007", confidence: "high" });
    expect(result.supplier.vatNumber.value).toBe(FAKE_SUPPLIER.vatNumber);
    expect(result.supplier.bankgiro.value).toBe("55501233");
    expect(result.supplier.plusgiro.value).toBe("1234566");
    expect(result.supplier.iban.value).toBe(FAKE_SUPPLIER.iban);
    expect(result.checks).toEqual([]);
    expect(rulesSufficient(result)).toBe(true);
    expect(isUncertain(result)).toBe(false);
  });

  it("never matches the buyer's own identifiers to a supplier", async () => {
    // A supplier that happens to carry the COMPANY's organisationsnummer.
    const lookalike: SupplierIdentity = { ...other, orgNumber: FAKE_BUYER.orgNumber, bankgiro: null };
    const lines = await linesOf(invoicePdf({ seller: { name: "Okänd Säljare Exempel AB" } }));
    const match = matchSupplier(lines, company, [lookalike]);
    expect(match.matchedSupplierId).toBeNull();
    expect(match.found.orgNumbers).not.toContain("5599114567");
  });

  it("offers the invoice's supplier data for Skapa leverantör when nothing matches", async () => {
    const lines = await linesOf(invoicePdf());
    const result = interpretRules({ lines, company, suppliers: [other], hints: [], today: TODAY });
    expect(result.supplier.matchedSupplierId).toBeNull();
    expect(result.supplier.name).toMatchObject({ value: FAKE_SUPPLIER.name, confidence: "low" });
    expect(result.supplier.orgNumber.value).toBe(FAKE_SUPPLIER.orgNumber);
    expect(result.supplier.postalCode.value).toBe(FAKE_SUPPLIER.postalCode);
    expect(result.supplier.city.value).toBe(FAKE_SUPPLIER.city);
    expect(result.supplier.address.value).toBe(FAKE_SUPPLIER.address);
    expect(result.supplier.country.value).toBe("SE");
    expect(rulesSufficient(result)).toBe(false);
    expect(result.checks[0]).toMatch(/Ingen leverantör/);
  });

  it("lists several suppliers on the same identifier as candidates", async () => {
    const twin = { ...supplier, id: "00000000-0000-4000-8000-000000000003", name: "Tvilling AB" };
    const match = matchSupplier(await linesOf(invoicePdf()), company, [supplier, twin]);
    expect(match).toMatchObject({ matchedSupplierId: null, confidence: "low" });
    expect(match.candidates.sort()).toEqual([supplier.id, twin.id].sort());
  });

  it("falls back to an exact name match as low", async () => {
    const byName = { ...supplier, orgNumber: null };
    const lines = await linesOf(invoicePdf({ seller: { name: FAKE_SUPPLIER.name } }));
    const match = matchSupplier(lines, company, [byName]);
    expect(match).toMatchObject({ matchedSupplierId: byName.id, matchedBy: "name", confidence: "low" });
  });

  it("marks the amounts low and adds a check when net + VAT is not the amount due", async () => {
    const lines = await linesOf(invoicePdf({ gross: "1 250,40" }));
    const result = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(result.grossAmount).toMatchObject({ value: 1250.4, confidence: "low" });
    expect(result.netAmount.confidence).toBe("low");
    expect(result.checks).toContain("Netto + moms stämmer inte med att betala (diff 0,40)");
    expect(rulesSufficient(result)).toBe(false);
  });

  it("allows öresavrundning up to 0,50 when the invoice prints it", async () => {
    const lines = await linesOf(invoicePdf({ net: "1 000,00", vat: "250,00", gross: "1 250,40", extraLines: ["Öresavrundning 0,40"] }));
    const result = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(result.grossAmount.confidence).toBe("high");
  });

  it("derives the net from the amount due and the VAT (low)", async () => {
    const lines = await linesOf(invoicePdf({ net: null }));
    const result = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(result.netAmount).toMatchObject({ value: 1000, confidence: "low" });
  });

  it("reads a kreditfaktura as negative amounts", async () => {
    const lines = await linesOf(invoicePdf({ title: "Kreditfaktura" }));
    const result = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(result.isCreditNote.value).toBe(true);
    expect(result.grossAmount.value).toBe(-1250);
    expect(result.netAmount.value).toBe(-1000);
    expect(result.vatAmount.value).toBe(-250);
  });

  it("proposes an OCR without a valid check digit as a message (low)", async () => {
    const lines = await linesOf(invoicePdf({ ocr: "471100017" }));
    const result = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(result.paymentReference).toMatchObject({ value: { kind: "message", value: "471100017" }, confidence: "low" });
  });

  it("marks an implausible invoice date low", async () => {
    const lines = await linesOf(invoicePdf({ invoiceDate: "2023-01-01", dueDate: "2023-01-31" }));
    const result = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(result.invoiceDate.confidence).toBe("low");
    expect(rulesSufficient(result)).toBe(false);
  });

  it("keeps the supplier's currency and adds a check when the invoice says another", async () => {
    const lines = await linesOf(invoicePdf({ currencyText: "EUR" }));
    const result = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(result.currency).toMatchObject({ value: "SEK", confidence: "low", source: "supplier" });
    expect(result.checks.some((c) => c.includes("EUR"))).toBe(true);
  });

  it("reads values from a header row (labels above the values)", async () => {
    const lines = await linesOf(invoicePdf({ headerRow: true, ocr: null }));
    const result = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(result.invoiceNumber.value).toBe("10045");
    expect(result.invoiceDate.value).toBe("2026-10-01");
    expect(result.dueDate.value).toBe("2026-10-31");
  });

  it("does not know an unusual label — until the supplier's learned label says it", async () => {
    const lines = await linesOf(invoicePdf({ labels: { invoiceNumber: "Verifikat:" } }));
    const without = interpretRules({ lines, company, suppliers: [supplier], hints: [], today: TODAY });
    expect(without.invoiceNumber.value).toBeNull();
    const learned = learnLabels(lines, { invoiceNumber: "10045" });
    expect(learned).toEqual([{ field: "invoiceNumber", label: "verifikat" }]);
    const withHint = interpretRules({ lines, company, suppliers: [supplier], hints: learned, today: TODAY });
    expect(withHint.invoiceNumber).toEqual({ value: "10045", confidence: "high", source: "learned" });
  });
});

describe("learnLabels", () => {
  it("finds the label to the left of, or above, the confirmed value", async () => {
    const beside = await linesOf(invoicePdf());
    expect(
      learnLabels(beside, { invoiceNumber: "10045", invoiceDate: "2026-10-01", grossAmount: 1250, paymentReference: FAKE_OCR })
    ).toEqual([
      { field: "invoiceNumber", label: "fakturanummer" },
      { field: "invoiceDate", label: "fakturadatum" },
      { field: "grossAmount", label: "att betala" },
      { field: "paymentReference", label: "ocr-nummer" },
    ]);
    const above = await linesOf(invoicePdf({ headerRow: true, ocr: null, labels: { invoiceNumber: "Fakt.nr" } }));
    expect(learnLabels(above, { invoiceNumber: "10045" })).toEqual([{ field: "invoiceNumber", label: "fakt.nr" }]);
  });

  it("learns nothing for a value that is not in the text", async () => {
    expect(learnLabels(await linesOf(invoicePdf()), { invoiceNumber: "99999" })).toEqual([]);
  });

  it("normalizes labels", () => {
    expect(normalizeLabel("  Fakt.nr: ")).toBe("fakt.nr");
    expect(normalizeLabel("Att  BETALA:")).toBe("att betala");
    expect(normalizeLabel("x".repeat(80))).toHaveLength(60);
  });
});

describe("rulesSufficient / isUncertain", () => {
  it("needs a sure supplier, number, date and the three amounts", () => {
    const result = emptyInvoiceScanResult();
    expect(rulesSufficient(result)).toBe(false);
    expect(isUncertain(result)).toBe(true);
    result.supplier = { ...result.supplier, matchedSupplierId: supplier.id, matchedBy: "org_number", confidence: "high" };
    result.invoiceNumber = { value: "1", confidence: "high", source: "rules" };
    result.invoiceDate = { value: "2026-10-01", confidence: "high", source: "rules" };
    result.grossAmount = { value: 125, confidence: "high", source: "rules" };
    result.netAmount = { value: 100, confidence: "high", source: "rules" };
    result.vatAmount = { value: 25, confidence: "high", source: "rules" };
    expect(rulesSufficient(result)).toBe(true);
    result.vatAmount = { value: 25, confidence: "low", source: "rules" };
    expect(rulesSufficient(result)).toBe(false);
  });
});

describe("the status whitelist", () => {
  const table: [string, string, boolean][] = [
    ["interpret", "new", true],
    ["interpret", "interpreted", true],
    ["interpret", "converted", false],
    ["interpret", "rejected", false],
    ["convert", "new", true],
    ["convert", "interpreted", true],
    ["convert", "converted", false],
    ["convert", "rejected", false],
    ["reject", "new", true],
    ["reject", "interpreted", true],
    ["reject", "converted", false],
    ["reject", "rejected", false],
    ["restore", "new", false],
    ["restore", "interpreted", false],
    ["restore", "converted", false],
    ["restore", "rejected", true],
    ["delete", "new", false],
    ["delete", "interpreted", false],
    ["delete", "converted", false],
    ["delete", "rejected", true],
  ];
  it.each(table)("%s from %s: %s", (action, from, allowed) => {
    expect(canPerform(action as (typeof INVOICE_SCAN_ACTIONS)[number], from as "new")).toBe(allowed);
  });

  it("covers every action", () => {
    expect(new Set(table.map(([a]) => a))).toEqual(new Set(INVOICE_SCAN_ACTIONS));
  });

  it("never moves backwards on interpretation; restore goes back to where it was", () => {
    expect(statusAfter("interpret", "new")).toBe("interpreted");
    expect(statusAfter("interpret", "new", { interpretedOk: false })).toBe("new");
    expect(statusAfter("interpret", "interpreted", { interpretedOk: false })).toBe("interpreted");
    expect(statusAfter("restore", "rejected", { wasInterpreted: true })).toBe("interpreted");
    expect(statusAfter("restore", "rejected", { wasInterpreted: false })).toBe("new");
    expect(statusAfter("delete", "rejected")).toBeNull();
  });
});

describe("purchase order matching", () => {
  const orders = [
    { id: "po-1", orderNumber: "IO-1005", createdAt: "2026-09-01T10:00:00Z", fullyInvoiced: false },
    { id: "po-2", orderNumber: "IO-1007", createdAt: "2026-09-10T10:00:00Z", fullyInvoiced: true },
  ];

  it("matches the reference with or without the series prefix", () => {
    expect(matchPurchaseOrder({ reference: "IO-1007", tokens: [], orders, prefix: "IO-" })).toEqual({ purchaseOrderId: "po-2", confidence: "high" });
    expect(matchPurchaseOrder({ reference: "1005", tokens: [], orders, prefix: "IO-" })).toEqual({ purchaseOrderId: "po-1", confidence: "high" });
    expect(matchPurchaseOrder({ reference: "io 1005", tokens: [], orders, prefix: "IO-" })).toEqual({ purchaseOrderId: "po-1", confidence: "high" });
  });

  it("takes the latest of several candidates as low", () => {
    expect(matchPurchaseOrder({ reference: null, tokens: ["IO1005", "IO1007"], orders, prefix: "IO-" })).toEqual({ purchaseOrderId: "po-2", confidence: "low" });
  });

  it("proposes the one open order when the invoice names none", () => {
    expect(matchPurchaseOrder({ reference: null, tokens: [], orders, prefix: "IO-" })).toEqual({ purchaseOrderId: "po-1", confidence: "low" });
    expect(matchPurchaseOrder({ reference: null, tokens: [], orders: [...orders, { ...orders[0]!, id: "po-3" }], prefix: "IO-" })).toBeNull();
    expect(matchPurchaseOrder({ reference: "9999", tokens: [], orders, prefix: "IO-" })).toBeNull();
  });

  it("finds series tokens in the text", () => {
    expect(purchaseOrderTokens(["Avser IO-1005 och io 1007", "IO1009x"], "IO-")).toEqual(["IO1005", "IO1007"]);
    expect(purchaseOrderTokens(["1005"], "")).toEqual([]);
  });

  it("matches rows on supplier article number, our article number, then quantity and price", () => {
    const row = (over: Partial<InvoiceScanRow>): InvoiceScanRow => ({
      description: "Rad",
      quantity: 4,
      unitPrice: 250,
      lineAmount: 1000,
      vatRate: 25,
      supplierArticleNumber: null,
      articleId: null,
      purchaseOrderRowId: null,
      confidence: "low",
      ...over,
    });
    const poRows = [
      { id: "r-1", articleId: "a-1", articleNumber: "ART-100", supplierArticleNumber: "LEV-9", unitPrice: 250, openQuantity: 4 },
      { id: "r-2", articleId: "a-2", articleNumber: "ART-200", supplierArticleNumber: null, unitPrice: 99, openQuantity: 2 },
      { id: "r-3", articleId: "a-3", articleNumber: "ART-300", supplierArticleNumber: null, unitPrice: 10, openQuantity: 5 },
    ];
    const matched = matchInvoiceRows(
      [
        row({ supplierArticleNumber: "lev-9" }),
        row({ description: "Skruv ART-200 förzinkad", quantity: 3, unitPrice: 99 }),
        row({ description: "Okänd", quantity: 5, unitPrice: 10.05 }),
        row({ description: "Ingen träff", quantity: 1, unitPrice: 1 }),
      ],
      poRows
    );
    expect(matched.map((r) => [r.purchaseOrderRowId, r.articleId, r.confidence])).toEqual([
      ["r-1", "a-1", "high"],
      // 3 > 2 received but not invoiced.
      ["r-2", "a-2", "low"],
      ["r-3", "a-3", "high"],
      [null, null, "low"],
    ]);
  });
});
