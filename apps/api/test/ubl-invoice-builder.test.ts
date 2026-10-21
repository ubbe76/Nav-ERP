import { describe, expect, it } from "vitest";
import { child, children, parseXml, path, textAt, type XmlNode } from "../src/modules/banking/service/iso20022/xml-reader.js";
import {
  buildUblCreditNote,
  buildUblDocument,
  buildUblInvoice,
  computeTotals,
  formatAmount,
  formatDecimal,
  linePricing,
  UBL_CUSTOMIZATION_ID,
  UBL_NAMESPACES,
  UBL_PROFILE_ID,
} from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import { checkUblInput } from "../src/modules/einvoice/service/ubl/ubl-check.js";
import { creditNote, GOLDEN_CASES, ibanInvoice, invoiceExemptRow, invoiceTwoRatesDiscount, line, plusgiroInvoice } from "./helpers/ubl-fixtures.js";
import { validateAgainstUblXsd } from "./helpers/ubl-xsd.js";

// ---- re-deriving the Peppol sum rules from the produced XML ----------------
// A tiny re-implementation of the schematron arithmetic over the parsed
// document, so a change in the builder that breaks a calculation rule fails
// here before it reaches the access point. Prefixes are stripped by the
// reader, so names are bare.
const num = (node: XmlNode | null, ...names: string[]) => Number(textAt(node, ...names) ?? Number.NaN);
const round2 = (n: number) => Math.round(n * 100) / 100;

function assertSumRules(xml: string): void {
  const { root } = parseXml(xml);
  const lines = [...children(root, "InvoiceLine"), ...children(root, "CreditNoteLine")];
  expect(lines.length).toBeGreaterThan(0);
  const monetary = child(root, "LegalMonetaryTotal");
  const taxTotal = child(root, "TaxTotal");
  // BR-CO-10: Σ line net = LineExtensionAmount (exact).
  const lineSum = round2(lines.reduce((sum, l) => sum + num(l, "LineExtensionAmount"), 0));
  expect(num(monetary, "LineExtensionAmount")).toBe(lineSum);
  // BR-CO-13: no document-level allowances/charges ⇒ TaxExclusive = LineExtension.
  expect(num(monetary, "TaxExclusiveAmount")).toBe(lineSum);
  // BR-CO-14: TaxTotal = Σ subtotals (exact).
  const subtotals = children(taxTotal, "TaxSubtotal");
  const taxSum = round2(subtotals.reduce((sum, s) => sum + num(s, "TaxAmount"), 0));
  expect(num(taxTotal, "TaxAmount")).toBe(taxSum);
  // BR-CO-15 / BR-CO-16: TaxInclusive = TaxExclusive + VAT, Payable = TaxInclusive.
  expect(num(monetary, "TaxInclusiveAmount")).toBe(round2(lineSum + taxSum));
  expect(num(monetary, "PayableAmount")).toBe(num(monetary, "TaxInclusiveAmount"));
  for (const subtotal of subtotals) {
    const category = child(subtotal, "TaxCategory");
    const id = textAt(category, "ID");
    const percent = num(category, "Percent");
    const taxable = num(subtotal, "TaxableAmount");
    const tax = num(subtotal, "TaxAmount");
    // BR-S-08 / BR-E-08: taxable = Σ lines of that category and rate.
    const matching = lines.filter((l) => textAt(l, "Item", "ClassifiedTaxCategory", "ID") === id && num(l, "Item", "ClassifiedTaxCategory", "Percent") === percent);
    expect(taxable).toBe(round2(matching.reduce((sum, l) => sum + num(l, "LineExtensionAmount"), 0)));
    // BR-CO-17 / BR-S-09: |tax − round2(taxable × rate)| < 1; BR-E-09: E ⇒ 0.
    if (id === "E") {
      expect(tax).toBe(0);
      expect(textAt(category, "TaxExemptionReason")).toBe("Undantagen från mervärdesskatt");
    } else {
      expect(Math.abs(tax - round2(taxable * (percent / 100)))).toBeLessThan(1);
      expect(child(category, "TaxExemptionReason")).toBeNull();
    }
  }
  for (const l of lines) {
    // PEPPOL-EN16931-R120: net = qty × price + charges − allowances, ±0.02.
    const quantity = num(l, "InvoicedQuantity") || num(l, "CreditedQuantity");
    const price = num(l, "Price", "PriceAmount");
    const allowances = children(l, "AllowanceCharge");
    const allowanceSum = allowances.reduce((sum, a) => sum + (textAt(a, "ChargeIndicator") === "false" ? num(a, "Amount") : -num(a, "Amount")), 0);
    expect(Math.abs(quantity * price - allowanceSum - num(l, "LineExtensionAmount"))).toBeLessThanOrEqual(0.02);
    for (const a of allowances) {
      // PEPPOL-EN16931-R040/R041/R042: percentage ⇔ base, amount = base × % ± 0.02.
      expect(textAt(a, "ChargeIndicator")).toBe("false");
      expect(textAt(a, "AllowanceChargeReasonCode")).toBe("95");
      const factor = num(a, "MultiplierFactorNumeric");
      const base = num(a, "BaseAmount");
      expect(Number.isFinite(factor) && Number.isFinite(base)).toBe(true);
      expect(Math.abs(num(a, "Amount") - (base * factor) / 100)).toBeLessThanOrEqual(0.02);
    }
    expect(price).toBeGreaterThanOrEqual(0); // BR-27
    expect(textAt(l, "Item", "Name")).not.toBeNull();
  }
}

// PEPPOL-EN16931-R008: no empty elements anywhere.
function assertNoEmptyElements(xml: string): void {
  expect(xml).not.toMatch(/<([A-Za-z:]+)(?: [^>]*)?><\/\1>/);
  expect(xml).not.toMatch(/<[A-Za-z:]+(?: [^>]*)?\/>/);
}

describe("UBL builder — golden files", () => {
  for (const { name, input } of GOLDEN_CASES) {
    it(`${name}: matches the golden file, validates against the UBL 2.1 XSD and the sum rules`, async () => {
      const data = input();
      expect(checkUblInput(data)).toEqual([]);
      const xml = buildUblDocument(data);
      assertNoEmptyElements(xml);
      assertSumRules(xml);
      expect(await validateAgainstUblXsd(xml, data.type === "credit" ? "CreditNote" : "Invoice")).toEqual([]);
      await expect(xml).toMatchFileSnapshot(`./fixtures/ubl/${name}.xml`);
    });
  }
});

describe("UBL builder — document content", () => {
  it("invoice: identifiers, type code, references, parties and the F-skatt tax scheme in schema order", () => {
    const xml = buildUblInvoice(invoiceTwoRatesDiscount());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="' + UBL_NAMESPACES.invoice + '"')).toBe(true);
    expect(xml).toContain(`<cbc:CustomizationID>${UBL_CUSTOMIZATION_ID}</cbc:CustomizationID><cbc:ProfileID>${UBL_PROFILE_ID}</cbc:ProfileID><cbc:ID>FA-1001</cbc:ID>`);
    expect(xml).toContain("<cbc:IssueDate>2026-10-21</cbc:IssueDate><cbc:DueDate>2026-11-20</cbc:DueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>");
    expect(xml).toContain("<cbc:Note>Leverans enligt orderbekräftelse.</cbc:Note><cbc:DocumentCurrencyCode>SEK</cbc:DocumentCurrencyCode>");
    expect(xml).toContain("<cbc:BuyerReference>Anna Andersson</cbc:BuyerReference><cac:OrderReference><cbc:ID>PO-4711</cbc:ID></cac:OrderReference>");
    expect(xml).not.toContain("BillingReference");
    // Seller (BG-4).
    expect(xml).toContain('<cac:AccountingSupplierParty><cac:Party><cbc:EndpointID schemeID="0007">5566778899</cbc:EndpointID>');
    expect(xml).toContain('<cac:PartyIdentification><cbc:ID schemeID="0007">5566778899</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>Exempel Verkstad AB</cbc:Name></cac:PartyName>');
    expect(xml).toContain("<cac:PostalAddress><cbc:StreetName>Industrigatan 12</cbc:StreetName><cbc:CityName>Gävle</cbc:CityName><cbc:PostalZone>802 22</cbc:PostalZone><cac:Country><cbc:IdentificationCode>SE</cbc:IdentificationCode></cac:Country></cac:PostalAddress>");
    expect(xml).toContain("<cac:PartyTaxScheme><cbc:CompanyID>SE556677889901</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>");
    expect(xml).toContain("<cac:PartyTaxScheme><cbc:CompanyID>Godkänd för F-skatt</cbc:CompanyID><cac:TaxScheme><cbc:ID>TAX</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>");
    expect(xml).toContain('<cac:PartyLegalEntity><cbc:RegistrationName>Exempel Verkstad AB</cbc:RegistrationName><cbc:CompanyID schemeID="0007">5566778899</cbc:CompanyID></cac:PartyLegalEntity>');
    expect(xml).toContain("<cac:Contact><cbc:Telephone>026-12 34 56</cbc:Telephone><cbc:ElectronicMail>faktura@exempelverkstad.example</cbc:ElectronicMail></cac:Contact>");
    // Buyer (BG-7): the name is escaped, the org number is written as digits.
    expect(xml).toContain('<cac:AccountingCustomerParty><cac:Party><cbc:EndpointID schemeID="0007">5590001235</cbc:EndpointID><cac:PartyIdentification><cbc:ID>1001</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>Kund &amp; Son AB</cbc:Name></cac:PartyName>');
    expect(xml).toContain("<cbc:StreetName>Storgatan 1</cbc:StreetName><cbc:AdditionalStreetName>Box 44</cbc:AdditionalStreetName><cbc:CityName>Uppsala</cbc:CityName>");
    expect(xml).toContain('<cac:PartyLegalEntity><cbc:RegistrationName>Kund &amp; Son AB</cbc:RegistrationName><cbc:CompanyID schemeID="0007">5590001235</cbc:CompanyID></cac:PartyLegalEntity>');
    // Payment (BG-16): bankgiro digits, code 30, OCR.
    expect(xml).toContain("<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cbc:PaymentID>10012345673</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>5512348</cbc:ID><cac:FinancialInstitutionBranch><cbc:ID>SE:BANKGIRO</cbc:ID></cac:FinancialInstitutionBranch></cac:PayeeFinancialAccount></cac:PaymentMeans>");
    expect(xml).toContain("<cac:PaymentTerms><cbc:Note>30 dagar netto</cbc:Note></cac:PaymentTerms>");
  });

  it("invoice: VAT breakdown per rate, totals from the stored row figures, and the discounted line", () => {
    const xml = buildUblInvoice(invoiceTwoRatesDiscount());
    expect(xml).toContain(
      '<cac:TaxTotal><cbc:TaxAmount currencyID="SEK">3276.90</cbc:TaxAmount>' +
        '<cac:TaxSubtotal><cbc:TaxableAmount currencyID="SEK">12630.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="SEK">3157.50</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>25</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>' +
        '<cac:TaxSubtotal><cbc:TaxableAmount currencyID="SEK">995.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="SEK">119.40</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>12</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>'
    );
    expect(xml).toContain(
      '<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="SEK">13625.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="SEK">13625.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="SEK">16901.90</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="SEK">16901.90</cbc:PayableAmount></cac:LegalMonetaryTotal>'
    );
    // Line 1: 2 × 5600 − 10 % = 10080. Gross price on the line, the discount
    // as a line allowance with base 11200 and amount 1120.
    expect(xml).toContain(
      '<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">2</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SEK">10080.00</cbc:LineExtensionAmount>' +
        "<cac:OrderLineReference><cbc:LineID>KO-2001:1</cbc:LineID></cac:OrderLineReference>" +
        '<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Rabatt</cbc:AllowanceChargeReason><cbc:MultiplierFactorNumeric>10</cbc:MultiplierFactorNumeric><cbc:Amount currencyID="SEK">1120.00</cbc:Amount><cbc:BaseAmount currencyID="SEK">11200.00</cbc:BaseAmount></cac:AllowanceCharge>' +
        "<cac:Item><cbc:Name>Arbetsbord 1200×600</cbc:Name><cac:SellersItemIdentification><cbc:ID>3001</cbc:ID></cac:SellersItemIdentification><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>25</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item>" +
        '<cac:Price><cbc:PriceAmount currencyID="SEK">5600.00</cbc:PriceAmount></cac:Price></cac:InvoiceLine>'
    );
    // Line 2: hours ⇒ HUR, no article number ⇒ no SellersItemIdentification.
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="HUR">3</cbc:InvoicedQuantity>');
    expect(xml).toContain("<cac:Item><cbc:Name>Montering på plats</cbc:Name><cac:ClassifiedTaxCategory>");
    // The PDF rides along as an embedded attachment.
    expect(xml).toContain(
      '<cac:AdditionalDocumentReference><cbc:ID>FA-1001</cbc:ID><cbc:DocumentDescription>Faktura (PDF)</cbc:DocumentDescription><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="Faktura-FA-1001.pdf">'
    );
  });

  it("0 % row: category E with the exemption reason on the breakdown, S rows untouched", () => {
    const xml = buildUblInvoice(invoiceExemptRow());
    expect(xml).toContain(
      '<cac:TaxSubtotal><cbc:TaxableAmount currencyID="SEK">180.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="SEK">0.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>E</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReason>Undantagen från mervärdesskatt</cbc:TaxExemptionReason><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal>'
    );
    expect(xml).toContain("<cac:ClassifiedTaxCategory><cbc:ID>E</cbc:ID><cbc:Percent>0</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>");
    expect(xml).toContain('<cbc:TaxAmount currencyID="SEK">600.00</cbc:TaxAmount><cac:TaxSubtotal>');
    // No order reference on this one — the buyer reference carries R003.
    expect(xml).not.toContain("OrderReference");
  });

  it("credit note: CreditNote root, type code 381, billing reference, no due date, no payment means, positive amounts", () => {
    const xml = buildUblCreditNote(creditNote());
    expect(xml).toContain(`<CreditNote xmlns="${UBL_NAMESPACES.creditNote}"`);
    expect(xml).toContain("<cbc:IssueDate>2026-10-21</cbc:IssueDate><cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode><cbc:DocumentCurrencyCode>SEK</cbc:DocumentCurrencyCode>");
    expect(xml).toContain("<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>FA-1001</cbc:ID></cac:InvoiceDocumentReference></cac:BillingReference>");
    expect(xml).not.toContain("DueDate");
    expect(xml).not.toContain("PaymentMeans");
    expect(xml).not.toContain("PaymentTerms");
    expect(xml).toContain('<cac:CreditNoteLine><cbc:ID>1</cbc:ID><cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity><cbc:LineExtensionAmount currencyID="SEK">5040.00</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SEK">6300.00</cbc:PayableAmount>');
    expect(xml).not.toMatch(/>-\d/); // amounts stay positive — the root carries the sign
  });

  it("plusgiro ⇒ SE:PLUSGIRO with digits only; a GLN endpoint keeps its scheme", () => {
    const xml = buildUblInvoice(plusgiroInvoice());
    expect(xml).toContain("<cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cbc:PaymentID>10012345673</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>4892162</cbc:ID><cac:FinancialInstitutionBranch><cbc:ID>SE:PLUSGIRO</cbc:ID>");
    expect(xml).toContain('<cbc:EndpointID schemeID="0088">7350000000009</cbc:EndpointID>');
    // No VAT number on the buyer ⇒ no PartyTaxScheme on the customer party.
    expect(xml.split("<cac:PartyTaxScheme>").length - 1).toBe(2);
  });

  it("IBAN ⇒ code 58 with the IBAN compacted and the BIC as the branch id; units kg/m2; derived price for a drifted row", () => {
    const xml = buildUblInvoice(ibanInvoice());
    expect(xml).toContain("<cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentID>10012345673</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>SE3550000000054910000003</cbc:ID><cac:FinancialInstitutionBranch><cbc:ID>ESSESESS</cbc:ID>");
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="KGM">12.5</cbc:InvoicedQuantity>');
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="MTK">3.25</cbc:InvoicedQuantity>');
    // 1000 × 0.3333 = 333.30 is 0.03 off the stored 333.33 — more than
    // R120's slack — so the price is derived from the stored amount.
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="C62">1000</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SEK">333.33</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cac:Price><cbc:PriceAmount currencyID="SEK">0.33333</cbc:PriceAmount></cac:Price>');
    // Buyer reference fallback (customer number) and no party identification.
    expect(xml).toContain("<cbc:BuyerReference>1001</cbc:BuyerReference><cac:AccountingSupplierParty>");
    expect(xml).not.toContain("PartyIdentification><cbc:ID>1001");
    expect(xml).not.toContain("AdditionalDocumentReference><cbc:ID>FA-1007"); // no attachment on this one
    // No org number on the buyer ⇒ PartyLegalEntity carries the name only.
    expect(xml).toContain("<cac:PartyLegalEntity><cbc:RegistrationName>Kund &amp; Son AB</cbc:RegistrationName></cac:PartyLegalEntity>");
  });

  it("configured row: Grupp/Värde as AdditionalItemProperty after the tax category", () => {
    const xml = buildUblDocument(GOLDEN_CASES[4]!.input());
    expect(xml).toContain(
      "</cac:ClassifiedTaxCategory><cac:AdditionalItemProperty><cbc:Name>Bredd</cbc:Name><cbc:Value>1200 mm</cbc:Value></cac:AdditionalItemProperty><cac:AdditionalItemProperty><cbc:Name>Material</cbc:Name><cbc:Value>Rostfritt 1,5 mm</cbc:Value></cac:AdditionalItemProperty><cac:AdditionalItemProperty><cbc:Name>Ho</cbc:Name><cbc:Value>Höger</cbc:Value></cac:AdditionalItemProperty></cac:Item>"
    );
    expect(xml).toContain('<cbc:InvoicedQuantity unitCode="MTR">1.5</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SEK">217.88</cbc:LineExtensionAmount>');
    expect(xml).toContain('<cbc:PriceAmount currencyID="SEK">145.25</cbc:PriceAmount>');
  });

  it("the named builders refuse the other document type", () => {
    expect(() => buildUblInvoice(creditNote())).toThrow(/credit note/);
    expect(() => buildUblCreditNote(invoiceTwoRatesDiscount())).toThrow(/invoice/);
  });

  it("escapes XML and strips control characters in free text", () => {
    const input = invoiceExemptRow();
    input.note = 'Ref <"A&B"> \u0007klart';
    const xml = buildUblInvoice(input);
    expect(xml).toContain("<cbc:Note>Ref &lt;&quot;A&amp;B&quot;&gt; klart</cbc:Note>");
  });
});

describe("UBL builder — amounts and line arithmetic", () => {
  it("formats money with exactly two decimals and a dot, never -0.00", () => {
    expect(formatAmount(1234.5)).toBe("1234.50");
    expect(formatAmount(0.005)).toBe("0.01");
    expect(formatAmount(10.345)).toBe("10.35");
    expect(formatAmount(-0.001)).toBe("0.00");
    expect(formatAmount(1e6)).toBe("1000000.00");
  });

  it("formats quantities and prices with trimmed decimals", () => {
    expect(formatDecimal(2, 4)).toBe("2");
    expect(formatDecimal(2.5, 4)).toBe("2.5");
    expect(formatDecimal(0.1 + 0.2, 4)).toBe("0.3");
    expect(formatDecimal(5600, 4, 2)).toBe("5600.00");
    expect(formatDecimal(145.2575, 4, 2)).toBe("145.2575");
    expect(formatDecimal(12.5, 4)).toBe("12.5");
  });

  it("totals: per-rate buckets in descending rate order, sums in öre", () => {
    const totals = computeTotals(invoiceTwoRatesDiscount().lines);
    expect(totals.subtotals.map((s) => [s.category.id, s.category.percent, s.taxableCents, s.taxCents])).toEqual([
      ["S", 25, 1263000, 315750],
      ["S", 12, 99500, 11940],
    ]);
    expect(totals.lineTotalCents).toBe(1362500);
    expect(totals.taxTotalCents).toBe(327690);
    expect(totals.grossCents).toBe(1690190);
  });

  it("totals: float noise cannot creep in (0.1 + 0.2 rows)", () => {
    const totals = computeTotals([
      line({ lineNumber: 1, description: "a", quantity: 1, unitPrice: 0.1, lineAmount: 0.1, vatAmount: 0.03, vatRate: 25 }),
      line({ lineNumber: 2, description: "b", quantity: 1, unitPrice: 0.2, lineAmount: 0.2, vatAmount: 0.05, vatRate: 25 }),
    ]);
    expect(totals.lineTotalCents).toBe(30);
    expect(totals.taxTotalCents).toBe(8);
  });

  it("line pricing rule 1: gross = round2(qty × price), allowance = gross − stored net, price as given", () => {
    const pricing = linePricing(line({ lineNumber: 1, description: "a", quantity: 3, unitPrice: 12.345, discountPercent: 20, lineAmount: 29.63, vatAmount: 7.41, vatRate: 25 }));
    // 3 × 12.345 = 37.035 → base 37.04 (round2 as Nav's own), allowance
    // 37.04 − 29.63 = 7.41 ≈ 20 % of 37.04 (7.408) — inside R040's 0.02.
    expect(pricing.allowance).toEqual({ percent: 20, baseCents: 3704, amountCents: 741 });
    expect(pricing.priceAmount).toBe("12.345");
    expect(Math.abs(pricing.residual)).toBeLessThanOrEqual(0.02);
  });

  it("line pricing rule 2: a drifted discount row rebuilds the gross from the stored net and derives the price", () => {
    // Stored net 99.00 at 50 % cannot come from 2 × 100 (that would be 100):
    // rule 1 would put the allowance 1.00 off R040, so the gross is rebuilt.
    const pricing = linePricing(line({ lineNumber: 1, description: "a", quantity: 2, unitPrice: 100, discountPercent: 50, lineAmount: 99, vatAmount: 24.75, vatRate: 25 }));
    expect(pricing.allowance).toEqual({ percent: 50, baseCents: 19800, amountCents: 9900 });
    expect(pricing.priceAmount).toBe("99.00");
    expect(Math.abs(pricing.residual)).toBeLessThan(1e-9);
  });

  it("line pricing rule 3: without a discount the price is derived only when qty × price misses the stored net by more than the slack", () => {
    const kept = linePricing(line({ lineNumber: 1, description: "a", quantity: 1.5, unitPrice: 145.25, lineAmount: 217.88, vatAmount: 54.47, vatRate: 25 }));
    expect(kept.priceAmount).toBe("145.25");
    expect(Math.abs(kept.residual)).toBeLessThanOrEqual(0.02);
    const derived = linePricing(line({ lineNumber: 1, description: "a", quantity: 1000, unitPrice: 0.3333, lineAmount: 333.33, vatAmount: 83.33, vatRate: 25 }));
    expect(derived.priceAmount).toBe("0.33333");
    expect(Math.abs(derived.residual)).toBeLessThan(1e-9);
    // A quantity large enough to need more decimals still lands inside the slack.
    const big = linePricing(line({ lineNumber: 1, description: "a", quantity: 300000, unitPrice: 0.0033, lineAmount: 1000, vatAmount: 250, vatRate: 25 }));
    expect(Math.abs(big.residual)).toBeLessThanOrEqual(0.02);
  });

  it("100 % discount: base = qty × price, allowance = everything, no division by zero", () => {
    const pricing = linePricing(line({ lineNumber: 1, description: "a", quantity: 2, unitPrice: 50, discountPercent: 100, lineAmount: 0, vatAmount: 0, vatRate: 25 }));
    expect(pricing.allowance).toEqual({ percent: 100, baseCents: 10000, amountCents: 10000 });
    expect(Math.abs(pricing.residual)).toBeLessThan(1e-9);
  });

  it("per-row VAT rounding stays inside the ±1 category tolerance for a long invoice", () => {
    // 150 rows of 0.03 × 25 % = 0.0075 → stored 0.01 each: Σ 1.50 vs
    // round2(4.50 × 0.25) = 1.13 — inside the schematron's < 1 window.
    const lines = Array.from({ length: 150 }, (_, i) => line({ lineNumber: i + 1, description: `r${i}`, quantity: 1, unitPrice: 0.03, lineAmount: 0.03, vatAmount: 0.01, vatRate: 25 }));
    const input = { ...invoiceExemptRow(), lines };
    expect(checkUblInput(input)).toEqual([]);
    const totals = computeTotals(lines);
    expect(totals.subtotals[0]!.taxCents).toBe(150);
    assertSumRules(buildUblInvoice(input));
  });
});
