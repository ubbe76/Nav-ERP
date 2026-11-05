import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildUblDocument } from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import { base64DecodedLength, decodeXmlBytes, looksLikeUblInvoice, readUblInvoice, UBL_READ_LIMITS, UblReadError } from "../src/modules/einvoice/service/ubl/ubl-reader.js";
import { parseXml, XmlParseError } from "../src/modules/system/service/xml-reader.js";
import { FAKE_PDF, invoiceTwoRatesDiscount, line } from "./helpers/ubl-fixtures.js";

// The pure UBL reader (spec 2026-11-05-e-faktura-mottagning): Nav's own
// golden files read back, a credit note, BaseQuantity/rounding/several
// rates, the refusals and the limits. All data is invented.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/ubl/${name}`, import.meta.url));

describe("readUblInvoice on Nav's golden files", () => {
  it("reads the two-rate invoice back: parties, totals, rows, payment and the attachment", () => {
    const doc = readUblInvoice(fixture("invoice-two-rates-discount.xml"));
    expect(doc).toMatchObject({
      type: "invoice",
      number: "FA-1001",
      issueDate: "2026-10-21",
      dueDate: "2026-11-20",
      currency: "SEK",
      buyerReference: "Anna Andersson",
      orderReference: "PO-4711",
      note: "Leverans enligt orderbekräftelse.",
    });
    expect(doc.seller).toMatchObject({
      name: "Exempel Verkstad AB",
      endpoint: { scheme: "0007", value: "5566778899" },
      companyId: { scheme: "0007", value: "5566778899" },
      vatNumber: "SE556677889901",
      address: { lines: ["Industrigatan 12"], postalCode: "802 22", city: "Gävle", country: "SE" },
      email: "faktura@exempelverkstad.example",
      phone: "026-12 34 56",
    });
    expect(doc.buyer).toMatchObject({ name: "Kund & Son AB", address: { lines: ["Storgatan 1", "Box 44"] }, vatNumber: "SE559000123501" });
    expect(doc.payment).toEqual({
      meansCode: "30",
      account: { kind: "bankgiro", account: "5512348" },
      accounts: [{ kind: "bankgiro", account: "5512348" }],
      paymentId: "10012345673",
      termsNote: "30 dagar netto",
    });
    expect(doc.vat).toEqual([
      { category: "S", percent: 25, taxableAmount: 12630, taxAmount: 3157.5, exemptionReason: null },
      { category: "S", percent: 12, taxableAmount: 995, taxAmount: 119.4, exemptionReason: null },
    ]);
    expect(doc.totals).toMatchObject({ lineExtensionAmount: 13625, taxExclusiveAmount: 13625, taxInclusiveAmount: 16901.9, payableAmount: 16901.9, taxAmount: 3276.9 });
    expect(doc.lines).toHaveLength(3);
    // The discount is a line AllowanceCharge: the price is gross, the
    // allowance sums beside it, the line amount is net.
    expect(doc.lines[0]).toMatchObject({
      id: "1",
      description: "Arbetsbord 1200×600",
      quantity: 2,
      unitCode: "C62",
      unitPrice: 5600,
      allowanceAmount: 1120,
      chargeAmount: 0,
      lineAmount: 10080,
      vatRate: 25,
      vatCategory: "S",
      sellerItemNumber: "3001",
      buyerItemNumber: null,
      orderLineReference: "KO-2001:1",
    });
    expect(doc.lines[1]).toMatchObject({ unitCode: "HUR", quantity: 3, unitPrice: 850, lineAmount: 2550 });
    expect(doc.attachments).toHaveLength(1);
    expect(doc.attachments[0]).toMatchObject({ index: 0, filename: "Faktura-FA-1001.pdf", mimeCode: "application/pdf", description: "Faktura (PDF)", sizeBytes: FAKE_PDF.length });
    expect(doc.attachments[0]!.content().equals(FAKE_PDF)).toBe(true);
  });

  it("reads a credit note with its credited invoice and no due date", () => {
    const doc = readUblInvoice(fixture("credit-note.xml"));
    expect(doc).toMatchObject({ type: "credit_note", number: "FA-1003", dueDate: null, creditedInvoiceNumber: "FA-1001" });
    expect(doc.totals.payableAmount).toBe(6300);
    expect(doc.lines[0]).toMatchObject({ quantity: 1, lineAmount: 5040 });
    expect(doc.payment.account).toBeNull();
  });

  it("reads an EUR invoice with an IBAN, a SEPA code and an exemption reason", () => {
    const doc = readUblInvoice(fixture("invoice-eu-goods-eur.xml"));
    expect(doc.currency).toBe("EUR");
    expect(doc.payment).toMatchObject({ meansCode: "58", account: { kind: "iban", iban: "SE3550000000054910000003", bic: "ESSESESS" } });
    expect(doc.vat[0]).toMatchObject({ category: "K", percent: 0, exemptionReason: expect.stringContaining("Intra-Community") });
  });

  it("every golden file reads", () => {
    for (const name of [
      "invoice-collective-two-orders.xml",
      "invoice-configured-row.xml",
      "invoice-eu-services-dkk.xml",
      "invoice-exempt-row.xml",
      "invoice-export-goods-nok.xml",
      "invoice-iban.xml",
      "invoice-no-payment-account.xml",
      "invoice-plusgiro-gln.xml",
      "invoice-reverse-charge.xml",
      "invoice-services-outside-eu-usd.xml",
      "invoice-swedish-vat-in-eur.xml",
    ]) {
      const doc = readUblInvoice(fixture(name));
      expect(doc.number, name).toMatch(/^FA-/);
      expect(doc.lines.length, name).toBeGreaterThan(0);
    }
  });

  it("the Swedish VAT-in-EUR file keeps the document currency's tax only", () => {
    const doc = readUblInvoice(fixture("invoice-swedish-vat-in-eur.xml"));
    expect(doc.currency).toBe("EUR");
    // The second TaxTotal (SEK, BT-111) has no subtotals and is not the
    // document's tax amount.
    expect(doc.vat.every((v) => v.taxableAmount > 0)).toBe(true);
    expect(doc.totals.taxAmount).not.toBeNull();
  });
});

describe("readUblInvoice on hand-written documents", () => {
  const minimal = (extra = "", lines = "") =>
    `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:ID>INV-7</cbc:ID><cbc:IssueDate>2026-11-01</cbc:IssueDate><cbc:DocumentCurrencyCode>SEK</cbc:DocumentCurrencyCode>${extra}
<cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Leverantören</cbc:Name></cac:PartyName><cac:PostalAddress><cac:AddressLine><cbc:Line>Box 9</cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>se</cbc:IdentificationCode></cac:Country></cac:PostalAddress></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Köparen</cbc:Name></cac:PartyName></cac:Party></cac:AccountingCustomerParty>
<cac:PaymentMeans><cbc:PaymentMeansCode>30</cbc:PaymentMeansCode><cbc:PaymentDueDate>2026-12-01</cbc:PaymentDueDate><cac:PayeeFinancialAccount><cbc:ID>5512-348</cbc:ID><cac:FinancialInstitutionBranch><cbc:ID>SE:BANKGIRO</cbc:ID></cac:FinancialInstitutionBranch></cac:PayeeFinancialAccount></cac:PaymentMeans>
<cac:TaxTotal><cbc:TaxAmount currencyID="SEK">25.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="SEK">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="SEK">25.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>25</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="SEK">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="SEK">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="SEK">125.00</cbc:TaxInclusiveAmount><cbc:PayableRoundingAmount currencyID="SEK">-0.40</cbc:PayableRoundingAmount><cbc:PayableAmount currencyID="SEK">124.60</cbc:PayableAmount></cac:LegalMonetaryTotal>
${lines}
</Invoice>`;

  it("takes BaseQuantity, the payment due date, the rounding amount, the buyer's item number and address lines", () => {
    const doc = readUblInvoice(
      minimal(
        "",
        `<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="KGM">250</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SEK">100.00</cbc:LineExtensionAmount><cac:Item><cbc:Name>Stålband</cbc:Name><cac:BuyersItemIdentification><cbc:ID>ART-1</cbc:ID></cac:BuyersItemIdentification><cac:SellersItemIdentification><cbc:ID>S-9</cbc:ID></cac:SellersItemIdentification><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>25</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="SEK">40.00</cbc:PriceAmount><cbc:BaseQuantity unitCode="KGM">100</cbc:BaseQuantity></cac:Price></cac:InvoiceLine>`
      )
    );
    expect(doc.dueDate).toBe("2026-12-01");
    expect(doc.totals.payableRoundingAmount).toBe(-0.4);
    expect(doc.totals.payableAmount).toBe(124.6);
    expect(doc.seller.address).toEqual({ lines: ["Box 9"], postalCode: null, city: null, country: "SE" });
    expect(doc.seller.endpoint).toBeNull();
    expect(doc.payment.account).toEqual({ kind: "bankgiro", account: "5512348" });
    expect(doc.lines[0]).toMatchObject({ quantity: 250, unitCode: "KGM", unitPrice: 0.4, buyerItemNumber: "ART-1", sellerItemNumber: "S-9" });
  });

  it("reads several VAT rates and a category without a rate (O)", () => {
    const doc = readUblInvoice(buildUblDocument(invoiceTwoRatesDiscount()));
    expect(doc.vat.map((v) => v.percent)).toEqual([25, 12]);
    const o = minimal().replace("<cbc:Percent>25</cbc:Percent>", "");
    expect(readUblInvoice(o).vat[0]).toMatchObject({ category: "S", percent: null });
  });

  it("refuses DOCTYPE and entities, the wrong root, the wrong namespace and a missing required field", () => {
    expect(() => readUblInvoice(`<!DOCTYPE x [<!ENTITY e "x">]>${minimal()}`)).toThrow(UblReadError);
    expect(() => readUblInvoice(`<!DOCTYPE x [<!ENTITY e "x">]>${minimal()}`)).toThrow(/DTD/);
    expect(() => readUblInvoice('<Order xmlns="urn:oasis:names:specification:ubl:schema:xsd:Order-2"><ID>1</ID></Order>')).toThrow(/ingen UBL-faktura/);
    expect(() => readUblInvoice('<Invoice xmlns="urn:something:else"><ID>1</ID></Invoice>')).toThrow(/namnrymden/);
    expect(() => readUblInvoice(minimal().replace("<cbc:ID>INV-7</cbc:ID>", ""))).toThrow(/fakturanummer/);
    expect(() => readUblInvoice(minimal().replace('<cbc:PayableAmount currencyID="SEK">124.60</cbc:PayableAmount>', ""))).toThrow(/att betala/);
    expect(() => readUblInvoice(minimal().replace("2026-11-01", "1 nov 2026"))).toThrow(/datum/);
    expect(() => readUblInvoice(minimal().replace(">124.60<", ">tolv<"))).toThrow(/belopp/);
    expect(() => readUblInvoice("not xml at all")).toThrow(UblReadError);
  });

  it("refuses a date that is no calendar date and an amount the database could not hold", () => {
    expect(() => readUblInvoice(minimal().replace("2026-11-01", "2026-02-30"))).toThrow(/giltigt datum/);
    expect(() => readUblInvoice(minimal().replace("2026-11-01", "2026-13-01"))).toThrow(/giltigt datum/);
    expect(() => readUblInvoice(minimal().replace("2026-12-01", "2026-11-31"))).toThrow(/giltigt datum/);
    expect(readUblInvoice(minimal().replace("2026-11-01", "2028-02-29")).issueDate).toBe("2028-02-29");
    expect(() => readUblInvoice(minimal().replace(">124.60<", ">10000000000000000000<"))).toThrow(/orimligt stort belopp/);
    expect(() => readUblInvoice(minimal().replace(">124.60<", ">1e21<"))).toThrow(/orimligt stort belopp/);
    expect(() => readUblInvoice(minimal().replace(">124.60<", ">-1000000000000.00<"))).toThrow(/orimligt stort belopp/);
    expect(readUblInvoice(minimal().replace(">124.60<", ">999999999999.99<")).totals.payableAmount).toBe(999999999999.99);
  });

  it("reads PrepaidAmount and every PaymentMeans; the OCR comes from the first PaymentID", () => {
    const two = minimal()
      .replace(
        "</cac:PaymentMeans>",
        '</cac:PaymentMeans><cac:PaymentMeans><cbc:PaymentMeansCode>58</cbc:PaymentMeansCode><cbc:PaymentID>10012345673</cbc:PaymentID><cac:PayeeFinancialAccount><cbc:ID>SE35 5000 0000 0549 1000 0003</cbc:ID><cac:FinancialInstitutionBranch><cbc:ID>ESSESESS</cbc:ID></cac:FinancialInstitutionBranch></cac:PayeeFinancialAccount></cac:PaymentMeans>'
      )
      .replace('<cbc:PayableRoundingAmount currencyID="SEK">-0.40</cbc:PayableRoundingAmount>', '<cbc:PrepaidAmount currencyID="SEK">100.00</cbc:PrepaidAmount><cbc:PayableRoundingAmount currencyID="SEK">-0.40</cbc:PayableRoundingAmount>');
    const doc = readUblInvoice(two);
    expect(doc.payment.accounts).toEqual([
      { kind: "bankgiro", account: "5512348" },
      { kind: "iban", iban: "SE3550000000054910000003", bic: "ESSESESS" },
    ]);
    expect(doc.payment.account).toEqual({ kind: "bankgiro", account: "5512348" });
    expect(doc.payment.meansCode).toBe("30");
    expect(doc.payment.paymentId).toBe("10012345673");
    expect(doc.totals.prepaidAmount).toBe(100);
  });

  it("decodes the bytes by BOM or declared encoding and keeps the original untouched", () => {
    const latin1 = Buffer.from(minimal().replace('encoding="UTF-8"', 'encoding="ISO-8859-1"').replace("Leverantören", "Leverantören Gävle"), "latin1");
    expect(latin1.includes(Buffer.from("Gävle", "utf8"))).toBe(false);
    expect(readUblInvoice(latin1).seller.name).toBe("Leverantören Gävle");
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(minimal(), "utf8")]);
    expect(readUblInvoice(bom).number).toBe("INV-7");
    expect(decodeXmlBytes(Buffer.from('<?xml version="1.0" encoding="windows-1252"?><a>\xe5</a>', "latin1"))).toContain("å");
    expect(decodeXmlBytes(Buffer.from("<a>å</a>", "utf8"))).toBe("<a>å</a>");
    expect(looksLikeUblInvoice(latin1)).toBe(true);
  });

  it("clips what it echoes from the document", () => {
    const long = "A".repeat(300);
    try {
      readUblInvoice(`<${long} xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>`);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message.length).toBeLessThan(120);
    }
  });

  it("has its own limits: 60 MB and 200 000 nodes", () => {
    expect(UBL_READ_LIMITS).toEqual({ maxBytes: 60 * 1024 * 1024, maxNodes: 200_000 });
    const many = minimal("", "<cac:Note/>".repeat(200_001));
    expect(() => readUblInvoice(many)).toThrow(/för många element/);
    // The bank file's default limit still refuses the same document at its
    // own ceiling (the shared reader takes the limits as parameters).
    expect(() => parseXml("<r>" + "<a/>".repeat(500_001) + "</r>")).toThrow(XmlParseError);
    expect(() => parseXml("<r>" + "<a/>".repeat(1000) + "</r>", { maxBytes: 100, maxNodes: 10 })).toThrow(/större än 0 MB/);
  });

  it("looksLikeUblInvoice and base64DecodedLength", () => {
    expect(looksLikeUblInvoice(Buffer.from(minimal()))).toBe(true);
    expect(looksLikeUblInvoice(fixture("credit-note.xml"))).toBe(true);
    expect(looksLikeUblInvoice(Buffer.from('<CrossIndustryInvoice xmlns="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"/>'))).toBe(false);
    expect(looksLikeUblInvoice(Buffer.from("%PDF-1.4"))).toBe(false);
    expect(base64DecodedLength(Buffer.from("abc").toString("base64"))).toBe(3);
    expect(base64DecodedLength(Buffer.from("abcd").toString("base64"))).toBe(4);
    expect(base64DecodedLength(Buffer.from("abcde").toString("base64"))).toBe(5);
    expect(base64DecodedLength("")).toBe(0);
  });

  it("reads a line without a price or quantity, and one with a charge", () => {
    const doc = readUblInvoice(
      buildUblDocument({
        ...invoiceTwoRatesDiscount(),
        lines: [line({ lineNumber: 1, description: "Frakt", quantity: 1, unitPrice: 100, lineAmount: 100, vatAmount: 25, vatRate: 25 })],
      }).replace('<cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>', "")
    );
    expect(doc.lines[0]).toMatchObject({ quantity: 1, unitCode: null, lineAmount: 100 });
  });
});
