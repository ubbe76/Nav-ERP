import { describe, expect, it } from "vitest";
import type { ReceivedEInvoice } from "../src/modules/einvoice/service/ubl/received-einvoice.js";
import { readUblInvoice } from "../src/modules/einvoice/service/ubl/ubl-reader.js";
import { buildUblDocument } from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import { interpretEInvoice } from "../src/modules/purchase/service/invoice-scan/einvoice-result.js";
import { matchInvoiceRows } from "../src/modules/purchase/service/invoice-scan/po-matching.js";
import { formatAmountSv } from "../src/modules/purchase/service/invoice-scan/invoice-values.js";
import type { CompanyIdentity, SupplierIdentity } from "../src/modules/purchase/service/invoice-scan/rules-interpreter.js";
import { invoiceTwoRatesDiscount, SELLER } from "./helpers/ubl-fixtures.js";
import { FAKE_BUYER, FAKE_OCR, FAKE_SUPPLIER } from "./helpers/invoice-pdf.js";

// The pure mapping of a received e-invoice to the inbox's proposal (spec
// 2026-11-05-e-faktura-mottagning): supplier matching on orgnr / momsnr /
// bankgiro / none, the currency rule, OCR mod 10, the buyer's item number
// and the row matching against a purchase order. All data invented.

const company: CompanyIdentity = {
  name: FAKE_BUYER.name,
  orgNumber: FAKE_BUYER.orgNumber,
  vatNumber: FAKE_BUYER.vatNumber,
  bankgiro: FAKE_BUYER.bankgiro,
  plusgiro: null,
  iban: null,
  postalCode: FAKE_BUYER.postalCode,
};
const SUP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ART_ID = "33333333-3333-4333-8333-333333333333";
const supplier = (over: Partial<SupplierIdentity> = {}): SupplierIdentity => ({
  id: SUP_ID,
  name: SELLER.name,
  orgNumber: "556677-8899",
  vatNumber: null,
  bankgiro: null,
  plusgiro: null,
  iban: null,
  currency: "SEK",
  country: "SE",
  ...over,
});

// Nav's own two-rate golden invoice, read back through the reader.
const doc = (): ReceivedEInvoice => readUblInvoice(buildUblDocument(invoiceTwoRatesDiscount()));

describe("interpretEInvoice", () => {
  it("matches the supplier on the organisation number and fills every field high from the document", () => {
    const result = interpretEInvoice({ einvoice: doc(), company, suppliers: [supplier()], articles: [] });
    expect(result.supplier).toMatchObject({ matchedSupplierId: SUP_ID, matchedBy: "org_number", confidence: "high" });
    expect(result.supplier.name).toEqual({ value: SELLER.name, confidence: "high", source: "supplier" });
    expect(result.supplier.orgNumber).toEqual({ value: "556677-8899", confidence: "high", source: "einvoice" });
    expect(result.supplier.vatNumber.value).toBe("SE556677889901");
    expect(result.supplier.bankgiro).toEqual({ value: "551-2348", confidence: "high", source: "einvoice" });
    expect(result.supplier.address.value).toBe("Industrigatan 12");
    expect(result.supplier.city.value).toBe("Gävle");
    expect(result.invoiceNumber).toEqual({ value: "FA-1001", confidence: "high", source: "einvoice" });
    expect(result.invoiceDate.value).toBe("2026-10-21");
    expect(result.dueDate.value).toBe("2026-11-20");
    expect(result.netAmount).toEqual({ value: 13625, confidence: "high", source: "einvoice" });
    expect(result.vatAmount.value).toBe(3276.9);
    expect(result.grossAmount.value).toBe(16901.9);
    expect(result.isCreditNote).toEqual({ value: false, confidence: "high", source: "einvoice" });
    expect(result.currency).toEqual({ value: "SEK", confidence: "high", source: "einvoice" });
    expect(result.purchaseOrderReference.value).toBe("PO-4711");
    // Two rates ⇒ no single vatRate.
    expect(result.vatRate.value).toBeNull();
    expect(result.paymentReference).toEqual({ value: { kind: "ocr", value: "10012345673" }, confidence: "high", source: "einvoice" });
    expect(result.rows).toHaveLength(3);
    // The discounted row's unit price is the NET price the row calculates with.
    expect(result.rows[0]).toMatchObject({ description: "Arbetsbord 1200×600", quantity: 2, unitPrice: 5040, lineAmount: 10080, vatRate: 25, supplierArticleNumber: "3001", articleId: null, confidence: "high" });
    expect(result.rows[1]).toMatchObject({ quantity: 3, unitPrice: 850, lineAmount: 2550 });
    expect(result.checks).toEqual([]);
    expect(result.duplicateOf).toBeNull();
  });

  it("matches on the VAT number, then on the bankgiro; none ⇒ no supplier and a check", () => {
    const onVat = interpretEInvoice({ einvoice: doc(), company, suppliers: [supplier({ orgNumber: null, vatNumber: "SE556677889901" })], articles: [] });
    expect(onVat.supplier).toMatchObject({ matchedSupplierId: SUP_ID, matchedBy: "vat_number" });
    const onGiro = interpretEInvoice({ einvoice: doc(), company, suppliers: [supplier({ orgNumber: null, bankgiro: "5512-348" })], articles: [] });
    expect(onGiro.supplier).toMatchObject({ matchedSupplierId: SUP_ID, matchedBy: "bankgiro" });
    const none = interpretEInvoice({ einvoice: doc(), company, suppliers: [supplier({ id: OTHER_ID, name: "Annan", orgNumber: FAKE_SUPPLIER.orgNumber })], articles: [] });
    expect(none.supplier.matchedSupplierId).toBeNull();
    expect(none.supplier.name).toEqual({ value: SELLER.name, confidence: "high", source: "einvoice" });
    expect(none.currency).toEqual({ value: "SEK", confidence: "low", source: "einvoice" });
    expect(none.checks[0]).toMatch(/Ingen leverantör i registret/);
  });

  it("never matches the company's own identifiers", () => {
    const d = doc();
    d.seller.companyId = { scheme: "0007", value: FAKE_BUYER.orgNumber.replace("-", "") };
    d.seller.vatNumber = FAKE_BUYER.vatNumber;
    d.payment.account = { kind: "bankgiro", account: FAKE_BUYER.bankgiro.replace("-", "") };
    const result = interpretEInvoice({ einvoice: d, company, suppliers: [supplier({ orgNumber: FAKE_BUYER.orgNumber, bankgiro: FAKE_BUYER.bankgiro })], articles: [] });
    // Only the name is left, and the supplier IS named after the seller.
    expect(result.supplier.matchedBy).toBe("name");
    expect(result.checks).toContainEqual(expect.stringMatching(/bara på namnet/));
  });

  it("gives the supplier's currency with low confidence and a check when the e-invoice is in another", () => {
    const result = interpretEInvoice({ einvoice: doc(), company, suppliers: [supplier({ currency: "EUR" })], articles: [] });
    expect(result.currency).toEqual({ value: "EUR", confidence: "low", source: "supplier" });
    expect(result.checks).toContainEqual("E-fakturan är i SEK men leverantören har EUR — leverantörsfakturan får leverantörens valuta");
  });

  it("takes a PaymentID that fails mod 10 as a message, and one that passes as OCR", () => {
    const d = doc();
    d.payment.paymentId = "Faktura 1001";
    expect(interpretEInvoice({ einvoice: d, company, suppliers: [supplier()], articles: [] }).paymentReference.value).toEqual({ kind: "message", value: "Faktura 1001" });
    d.payment.paymentId = "10012345674";
    expect(interpretEInvoice({ einvoice: d, company, suppliers: [supplier()], articles: [] }).paymentReference.value).toEqual({ kind: "message", value: "10012345674" });
    d.payment.paymentId = FAKE_OCR;
    expect(interpretEInvoice({ einvoice: d, company, suppliers: [supplier()], articles: [] }).paymentReference.value).toEqual({ kind: "ocr", value: FAKE_OCR });
  });

  it("negates a credit note's amounts, sets vatRate for one rate and flags a sum that does not add up", () => {
    const d = doc();
    d.type = "credit_note";
    d.vat = [d.vat[0]!];
    const credit = interpretEInvoice({ einvoice: d, company, suppliers: [supplier()], articles: [] });
    expect(credit.isCreditNote.value).toBe(true);
    expect(credit.grossAmount.value).toBe(-16901.9);
    expect(credit.netAmount.value).toBe(-13625);
    expect(credit.vatAmount.value).toBe(-3276.9);
    expect(credit.vatRate.value).toBe(25);

    const broken = doc();
    broken.totals.payableAmount = 16000;
    const result = interpretEInvoice({ einvoice: broken, company, suppliers: [supplier()], articles: [] });
    expect(result.grossAmount).toMatchObject({ value: 16000, confidence: "low" });
    expect(result.netAmount.confidence).toBe("low");
    expect(result.checks).toContainEqual("Netto + moms stämmer inte med att betala (diff 901,90)");
  });

  it("accepts an öresavrundning in PayableRoundingAmount", () => {
    const d = doc();
    d.totals.payableRoundingAmount = 0.1;
    d.totals.payableAmount = 16902;
    const result = interpretEInvoice({ einvoice: d, company, suppliers: [supplier()], articles: [] });
    expect(result.grossAmount).toMatchObject({ value: 16902, confidence: "high" });
    expect(result.checks).toEqual([]);
  });

  it("resolves the buyer's item number to our article and lets the row matching use it", () => {
    const d = doc();
    d.lines[0]!.buyerItemNumber = "ab-1200";
    const result = interpretEInvoice({ einvoice: d, company, suppliers: [supplier()], articles: [{ articleNumber: "AB-1200", id: ART_ID }] });
    expect(result.rows[0]!.articleId).toBe(ART_ID);
    expect(result.rows[1]!.articleId).toBeNull();
    const matched = matchInvoiceRows(result.rows, [
      { id: "44444444-4444-4444-8444-444444444444", articleId: ART_ID, articleNumber: "AB-1200", supplierArticleNumber: "3001", unitPrice: 5040, openQuantity: 2 },
    ]);
    expect(matched[0]).toMatchObject({ articleId: ART_ID, purchaseOrderRowId: "44444444-4444-4444-8444-444444444444", confidence: "high" });
    expect(matched[1]).toMatchObject({ purchaseOrderRowId: null, confidence: "low" });
  });

  it("matches on any of several accounts and takes a prepaid amount into the sum check", () => {
    const d = doc();
    d.payment.accounts = [{ kind: "iban", iban: "SE3550000000054910000003", bic: "ESSESESS" }, { kind: "plusgiro", account: FAKE_SUPPLIER.plusgiro }];
    d.payment.account = d.payment.accounts[0]!;
    const onPg = interpretEInvoice({ einvoice: d, company, suppliers: [supplier({ orgNumber: null, plusgiro: FAKE_SUPPLIER.plusgiro })], articles: [] });
    expect(onPg.supplier).toMatchObject({ matchedSupplierId: SUP_ID, matchedBy: "plusgiro" });
    expect(onPg.supplier.iban.value).toBe("SE3550000000054910000003");
    expect(onPg.supplier.plusgiro.value).toBe("123456-6");

    const prepaid = doc();
    prepaid.totals.prepaidAmount = 1000;
    prepaid.totals.payableAmount = 15901.9;
    const result = interpretEInvoice({ einvoice: prepaid, company, suppliers: [supplier()], articles: [] });
    expect(result.grossAmount).toMatchObject({ value: 15901.9, confidence: "high" });
    expect(result.netAmount.value).toBe(13625);
    expect(result.checks).toEqual([`E-fakturan anger ${formatAmountSv(1000)} som redan betalt — att betala är resten`]);
  });

  it("carries the reception's extra checks and flags rows that do not sum to the net", () => {
    const d = doc();
    d.lines[2]!.lineAmount = 1;
    const result = interpretEInvoice({ einvoice: d, company, suppliers: [supplier()], articles: [], extraChecks: ["Bilagan var för stor och finns kvar i e-fakturan"] });
    expect(result.checks[0]).toBe("Bilagan var för stor och finns kvar i e-fakturan");
    expect(result.checks).toContainEqual(expect.stringMatching(/Radernas summa .* stämmer inte med nettot/));
  });
});
