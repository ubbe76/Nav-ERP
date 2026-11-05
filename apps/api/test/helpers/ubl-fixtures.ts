import type { UblInvoiceInput, UblLine } from "../../src/modules/einvoice/service/ubl/ubl-types.js";

// Invented data for the UBL golden files (the repo is public): the seller is
// the same fictional "Exempel Verkstad AB" as the bank-file tests, the
// organisation numbers are Luhn-valid (Peppol SE-R-013 is fatal), the
// bankgiro/plusgiro are Luhn-valid and the GLN carries a correct GS1 check
// digit. The "PDF" is a stub — the builder only base64-encodes bytes.
export const FAKE_PDF = Buffer.from("%PDF-1.4\n% Nav ERP test stub - not a real document\n%%EOF\n", "ascii");

export const SELLER: UblInvoiceInput["seller"] = {
  name: "Exempel Verkstad AB",
  orgNumber: "5566778899",
  vatNumber: "SE556677889901",
  address: { addressLines: ["Industrigatan 12"], postalCode: "802 22", city: "Gävle", country: "SE" },
  email: "faktura@exempelverkstad.example",
  phone: "026-12 34 56",
  fSkatt: true,
};

export const BUYER: UblInvoiceInput["buyer"] = {
  endpoint: { scheme: "0007", value: "5590001235" },
  name: "Kund & Son AB",
  address: { addressLines: ["Storgatan 1", "Box 44"], postalCode: "753 20", city: "Uppsala", country: "SE" },
  orgNumber: "559000-1235",
  orgNumberScheme: "0007",
  vatNumber: "SE559000123501",
  customerNumber: "1001",
};

export function line(overrides: Partial<UblLine> & Pick<UblLine, "lineNumber" | "description" | "quantity" | "unitPrice" | "lineAmount" | "vatAmount" | "vatRate">): UblLine {
  return {
    articleNumber: null,
    unitCode: "st",
    discountPercent: 0,
    orderLineReference: null,
    properties: [],
    ...overrides,
  };
}

function base(overrides: Partial<UblInvoiceInput> = {}): UblInvoiceInput {
  return {
    type: "invoice",
    invoiceNumber: "FA-1001",
    issueDate: "2026-10-21",
    dueDate: "2026-11-20",
    currency: "SEK",
    language: "sv",
    taxCurrency: null,
    delivery: null,
    buyerReference: "Anna Andersson",
    orderReference: "PO-4711",
    creditedInvoiceNumber: null,
    note: null,
    paymentTermsNote: "30 dagar netto",
    seller: SELLER,
    buyer: BUYER,
    payment: { account: { kind: "bankgiro", account: "5512-348" }, ocrNumber: "10012345673" },
    lines: [],
    attachment: { filename: "Faktura-FA-1001.pdf", description: "Faktura (PDF)", mimeCode: "application/pdf", content: FAKE_PDF },
    ...overrides,
  };
}

// Two VAT rates (25 and 12 %) and a 10 % discount on the first row.
export function invoiceTwoRatesDiscount(): UblInvoiceInput {
  return base({
    note: "Leverans enligt orderbekräftelse.",
    lines: [
      line({ lineNumber: 1, description: "Arbetsbord 1200×600", articleNumber: "3001", quantity: 2, unitPrice: 5600, discountPercent: 10, lineAmount: 10080, vatAmount: 2520, vatRate: 25, orderLineReference: "KO-2001:1" }),
      line({ lineNumber: 2, description: "Montering på plats", unitCode: "tim", quantity: 3, unitPrice: 850, lineAmount: 2550, vatAmount: 637.5, vatRate: 25, orderLineReference: "KO-2001:2" }),
      line({ lineNumber: 3, description: "Handbok storkök", articleNumber: "9001", quantity: 5, unitPrice: 199, lineAmount: 995, vatAmount: 119.4, vatRate: 12, orderLineReference: "KO-2001:3" }),
    ],
  });
}

// A 0 % row ⇒ category E with the exemption reason.
export function invoiceExemptRow(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1002",
    orderReference: null,
    attachment: { filename: "Faktura-FA-1002.pdf", description: "Faktura (PDF)", mimeCode: "application/pdf", content: FAKE_PDF },
    lines: [
      line({ lineNumber: 1, description: "Underrede 1200", articleNumber: "2002", quantity: 1, unitPrice: 2400, lineAmount: 2400, vatAmount: 600, vatRate: 25 }),
      line({ lineNumber: 2, description: "Försäkringspremie transport", quantity: 1, unitPrice: 180, lineAmount: 180, vatAmount: 0, vatRate: 0 }),
    ],
  });
}

// Credit note for FA-1001: positive amounts, no due date, no payment means.
export function creditNote(): UblInvoiceInput {
  return base({
    type: "credit",
    invoiceNumber: "FA-1003",
    dueDate: null,
    creditedInvoiceNumber: "FA-1001",
    paymentTermsNote: null,
    payment: { account: null, ocrNumber: null },
    attachment: { filename: "Kreditfaktura-FA-1003.pdf", description: "Kreditfaktura (PDF)", mimeCode: "application/pdf", content: FAKE_PDF },
    lines: [line({ lineNumber: 1, description: "Arbetsbord 1200×600 — retur", articleNumber: "3001", quantity: 1, unitPrice: 5600, discountPercent: 10, lineAmount: 5040, vatAmount: 1260, vatRate: 25, orderLineReference: "KO-2001:1" })],
  });
}

// Collective invoice: rows from two orders, the first order's references win.
export function collectiveInvoice(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1004",
    buyerReference: "Anna Andersson",
    orderReference: "PO-4711",
    attachment: { filename: "Faktura-FA-1004.pdf", description: "Faktura (PDF)", mimeCode: "application/pdf", content: FAKE_PDF },
    lines: [
      line({ lineNumber: 1, description: "Hyllplan 1200 (Order KO-2001 · Ert ordernr PO-4711)", articleNumber: "2003", quantity: 4, unitPrice: 1250, lineAmount: 5000, vatAmount: 1250, vatRate: 25, orderLineReference: "KO-2001:1" }),
      line({ lineNumber: 2, description: "Bänkskiva 1200×600 (Order KO-2002 · Ert ordernr PO-4712)", articleNumber: "2001", quantity: 2, unitPrice: 2100, discountPercent: 5, lineAmount: 3990, vatAmount: 997.5, vatRate: 25, orderLineReference: "KO-2002:1" }),
      line({ lineNumber: 3, description: "Frakt (Order KO-2002 · Ert ordernr PO-4712)", articleNumber: "FRAKT", quantity: 1, unitPrice: 495, lineAmount: 495, vatAmount: 123.75, vatRate: 25, orderLineReference: "KO-2002:2" }),
    ],
  });
}

// A configured row: the configuration lines become AdditionalItemProperty,
// and a 1.5 m row whose quantity × price (217.875) rounds to the stored
// 217.88 — R120's slack at work.
export function configuredRowInvoice(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1005",
    attachment: { filename: "Faktura-FA-1005.pdf", description: "Faktura (PDF)", mimeCode: "application/pdf", content: FAKE_PDF },
    lines: [
      line({
        lineNumber: 1,
        description: "Diskbänk konfigurerad",
        articleNumber: "63000",
        quantity: 1,
        unitPrice: 12850,
        lineAmount: 12850,
        vatAmount: 3212.5,
        vatRate: 25,
        orderLineReference: "KO-2003:1",
        properties: [
          { name: "Bredd", value: "1200 mm" },
          { name: "Material", value: "Rostfritt 1,5 mm" },
          { name: "Ho", value: "Höger" },
        ],
      }),
      line({ lineNumber: 2, description: "Fyrkantrör rostfritt 40×40×1,5", articleNumber: "1010", unitCode: "m", quantity: 1.5, unitPrice: 145.25, lineAmount: 217.88, vatAmount: 54.47, vatRate: 25 }),
    ],
  });
}

// Plusgiro and a GLN (0088) recipient.
export function plusgiroInvoice(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1006",
    buyer: { ...BUYER, endpoint: { scheme: "0088", value: "7350000000009" }, vatNumber: null },
    payment: { account: { kind: "plusgiro", account: "489 21 62" }, ocrNumber: "10012345673" },
    attachment: { filename: "Faktura-FA-1006.pdf", description: "Faktura (PDF)", mimeCode: "application/pdf", content: FAKE_PDF },
    lines: [line({ lineNumber: 1, description: "Rostfri plåt 1,0 mm 1000×2000", articleNumber: "1001", quantity: 10, unitPrice: 780, lineAmount: 7800, vatAmount: 1950, vatRate: 25, orderLineReference: "KO-2004:1" })],
  });
}

// IBAN + BIC (payment means 58), no customer number/order reference — the
// buyer reference is Nav's customer-number fallback — units kg and m2, and
// a row whose display conversion drifted (1000 × 0.3333 = 333.30 ≠ 333.33),
// so the builder derives the price from the stored amount.
export function ibanInvoice(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1007",
    buyerReference: "1001",
    orderReference: null,
    buyer: { ...BUYER, customerNumber: null, vatNumber: null, orgNumber: null },
    payment: { account: { kind: "iban", iban: "SE35 5000 0000 0549 1000 0003", bic: "ESSESESS" }, ocrNumber: "10012345673" },
    attachment: null,
    lines: [
      line({ lineNumber: 1, description: "Svetstråd 1,0 mm", articleNumber: "1040", unitCode: "kg", quantity: 12.5, unitPrice: 96.4, lineAmount: 1205, vatAmount: 301.25, vatRate: 25 }),
      line({ lineNumber: 2, description: "Plåt 2 mm", articleNumber: "1003", unitCode: "m2", quantity: 3.25, unitPrice: 412, lineAmount: 1339, vatAmount: 334.75, vatRate: 25 }),
      line({ lineNumber: 3, description: "Specialmutter M8", articleNumber: "1050", quantity: 1000, unitPrice: 0.3333, lineAmount: 333.33, vatAmount: 83.33, vatRate: 25 }),
    ],
  });
}

// No payment account in Företagsuppgifter: the invoice goes without
// PaymentMeans (and so without the OCR number) — allowed by Peppol BIS.
export function noPaymentAccountInvoice(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1008",
    payment: { account: null, ocrNumber: "10012345673" },
    attachment: null,
    lines: [line({ lineNumber: 1, description: "Montering", articleNumber: "9001", unitCode: "tim", quantity: 4, unitPrice: 850, lineAmount: 3400, vatAmount: 850, vatRate: 25 })],
  });
}

// Momskoder: omvänd betalningsskyldighet in Sverige (OB ⇒ AE, BT-120 = the
// code's text) next to svensk moms (MP25 ⇒ S) and a momsfri row (MF ⇒ E) —
// AE and E are two 0 % subtotals. The buyer's VAT number is on the document
// (BR-AE-02).
export function invoiceReverseCharge(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1009",
    attachment: { filename: "Faktura-FA-1009.pdf", description: "Faktura (PDF)", mimeCode: "application/pdf", content: FAKE_PDF },
    lines: [
      line({ lineNumber: 1, description: "Montage av storköksbänk", unitCode: "tim", quantity: 8, unitPrice: 750, lineAmount: 6000, vatAmount: 0, vatRate: 0, vatCode: "OB", vatExemptionText: "Omvänd betalningsskyldighet" }),
      line({ lineNumber: 2, description: "Bänkskiva 1200×600", articleNumber: "2001", quantity: 1, unitPrice: 2100, lineAmount: 2100, vatAmount: 525, vatRate: 25, vatCode: "MP25" }),
      line({ lineNumber: 3, description: "Försäkringspremie transport", quantity: 1, unitPrice: 180, lineAmount: 180, vatAmount: 0, vatRate: 0, vatCode: "MF", vatExemptionText: "Momsfri omsättning" }),
    ],
  });
}

// ---- Utländska kunder och valuta (spec 2026-11-05) ------------------------
// Invented foreign customers; the register numbers carry valid check digits
// (PEPPOL-COMMON-R041/R043 are fatal): 987654325 is a mod-11-valid Norwegian
// number, 0412345614 a mod-97-valid Belgian one, 0614141000012 a GS1-valid GLN.

const EN_PDF = (number: string) => ({ filename: `Invoice-${number}.pdf`, description: "Invoice (PDF)", mimeCode: "application/pdf" as const, content: FAKE_PDF });

// Export of goods to Norway in NOK, English: EXV ⇒ G (VATEX-EU-G), the
// buyer addressed by 0192 + organisasjonsnummer, paid to the IBAN (code 30
// outside the euro), no VAT and therefore no VAT in SEK.
export function exportGoodsNok(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1010",
    currency: "NOK",
    language: "en",
    buyerReference: "Kari Nordmann",
    orderReference: "NO-PO-88",
    paymentTermsNote: "30 days net",
    buyer: {
      endpoint: { scheme: "0192", value: "987654325" },
      name: "Fjordverk AS",
      address: { addressLines: ["Bryggen 3"], postalCode: "5003", city: "Bergen", country: "NO" },
      orgNumber: "987654325",
      orgNumberScheme: "0192",
      vatNumber: null,
      customerNumber: "2001",
    },
    payment: { account: { kind: "iban", iban: "SE35 5000 0000 0549 1000 0003", bic: "ESSESESS" }, ocrNumber: "10012345673" },
    attachment: EN_PDF("FA-1010"),
    lines: [
      line({ lineNumber: 1, description: "Stainless worktop 1200", articleNumber: "2001", quantity: 2, unitPrice: 2650, lineAmount: 5300, vatAmount: 0, vatRate: 0, vatCode: "EXV", vatExemptionText: "Export of goods, exempt from VAT (Article 146 of the VAT Directive)" }),
      line({ lineNumber: 2, description: "Freight", articleNumber: "FRAKT", quantity: 1, unitPrice: 890, lineAmount: 890, vatAmount: 0, vatRate: 0, vatCode: "EXV", vatExemptionText: "Export of goods, exempt from VAT (Article 146 of the VAT Directive)" }),
    ],
  });
}

// Goods to a German company in EUR: EUV ⇒ K (VATEX-EU-IC) with the buyer's
// VAT number, the delivery date and the deliver-to country (BR-IC-02/11/12),
// IBAN with SEPA code 58. Germany has no derived scheme: the Peppol-id is
// the customer's own (9930 = German VAT number), the registration number is
// left out.
export function euGoodsEur(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1011",
    currency: "EUR",
    language: "en",
    buyerReference: "Max Mustermann",
    orderReference: "4500012345",
    paymentTermsNote: "30 days net",
    delivery: { date: "2026-11-03", country: "DE" },
    buyer: {
      endpoint: { scheme: "9930", value: "DE123456789" },
      name: "Beispiel Metall GmbH",
      address: { addressLines: ["Hafenstraße 7"], postalCode: "20457", city: "Hamburg", country: "DE" },
      orgNumber: null,
      orgNumberScheme: null,
      vatNumber: "DE123456789",
      customerNumber: "2002",
    },
    payment: { account: { kind: "iban", iban: "SE35 5000 0000 0549 1000 0003", bic: "ESSESESS" }, ocrNumber: "10012345673" },
    attachment: EN_PDF("FA-1011"),
    lines: [
      line({ lineNumber: 1, description: "Sink module 800", articleNumber: "2004", quantity: 3, unitPrice: 412.5, discountPercent: 5, lineAmount: 1175.63, vatAmount: 0, vatRate: 0, vatCode: "EUV", vatExemptionText: "Intra-Community supply (Article 138 of the VAT Directive)", orderLineReference: "KO-2010:1" }),
    ],
  });
}

// Services to a Danish company in DKK: EUT ⇒ AE (reverse charge, article
// 196) with the buyer's VAT number; the buyer by 0184 + CVR, also as its
// registration number.
export function euServicesDkk(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1012",
    currency: "DKK",
    language: "en",
    buyerReference: "Mette Jensen",
    orderReference: null,
    paymentTermsNote: "30 days net",
    buyer: {
      endpoint: { scheme: "0184", value: "12345674" },
      name: "Eksempel ApS",
      address: { addressLines: ["Havnegade 12"], postalCode: "1058", city: "København K", country: "DK" },
      orgNumber: "12345674",
      orgNumberScheme: "0184",
      vatNumber: "DK12345674",
      customerNumber: "2003",
    },
    payment: { account: { kind: "iban", iban: "SE35 5000 0000 0549 1000 0003", bic: "ESSESESS" }, ocrNumber: "10012345673" },
    attachment: EN_PDF("FA-1012"),
    lines: [
      line({ lineNumber: 1, description: "Installation of kitchen line", unitCode: "tim", quantity: 6, unitPrice: 725, lineAmount: 4350, vatAmount: 0, vatRate: 0, vatCode: "EUT", vatExemptionText: "Reverse charge (Article 196 of the VAT Directive)" }),
    ],
  });
}

// Services to a company outside the EU in USD: EXT ⇒ O (not subject to
// VAT) — no rate on the category and NEITHER party's VAT number (BR-O-02),
// the buyer addressed by GLN.
export function servicesOutsideEuUsd(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1013",
    currency: "USD",
    language: "en",
    buyerReference: "John Smith",
    orderReference: null,
    paymentTermsNote: "30 days net",
    buyer: {
      endpoint: { scheme: "0088", value: "0614141000012" },
      name: "Example Industries Inc.",
      address: { addressLines: ["100 Main Street"], postalCode: "02110", city: "Boston", country: "US" },
      orgNumber: null,
      orgNumberScheme: null,
      vatNumber: "US123456789",
      customerNumber: "2004",
    },
    payment: { account: { kind: "iban", iban: "SE35 5000 0000 0549 1000 0003", bic: "ESSESESS" }, ocrNumber: "10012345673" },
    attachment: EN_PDF("FA-1013"),
    lines: [
      line({ lineNumber: 1, description: "Design review, stainless kitchen", unitCode: "tim", quantity: 10, unitPrice: 140, lineAmount: 1400, vatAmount: 0, vatRate: 0, vatCode: "EXT", vatExemptionText: "Service supplied outside Sweden" }),
    ],
  });
}

// A Swedish customer invoiced in EUR with Swedish VAT: the VAT is also
// stated in SEK (TaxCurrencyCode + a second TaxTotal without subtotals) —
// 250.00 EUR at 11.2 = 2 800.00 SEK.
export function swedishVatInEur(): UblInvoiceInput {
  return base({
    invoiceNumber: "FA-1014",
    currency: "EUR",
    taxCurrency: { currency: "SEK", vatAmount: 2800 },
    payment: { account: { kind: "iban", iban: "SE35 5000 0000 0549 1000 0003", bic: "ESSESESS" }, ocrNumber: "10012345673" },
    attachment: { filename: "Faktura-FA-1014.pdf", description: "Faktura (PDF)", mimeCode: "application/pdf", content: FAKE_PDF },
    lines: [line({ lineNumber: 1, description: "Bänkskiva 1200×600", articleNumber: "2001", quantity: 4, unitPrice: 250, lineAmount: 1000, vatAmount: 250, vatRate: 25, vatCode: "MP25" })],
  });
}

export const GOLDEN_CASES: { name: string; input: () => UblInvoiceInput }[] = [
  { name: "invoice-two-rates-discount", input: invoiceTwoRatesDiscount },
  { name: "invoice-exempt-row", input: invoiceExemptRow },
  { name: "credit-note", input: creditNote },
  { name: "invoice-collective-two-orders", input: collectiveInvoice },
  { name: "invoice-configured-row", input: configuredRowInvoice },
  { name: "invoice-plusgiro-gln", input: plusgiroInvoice },
  { name: "invoice-iban", input: ibanInvoice },
  { name: "invoice-no-payment-account", input: noPaymentAccountInvoice },
  { name: "invoice-reverse-charge", input: invoiceReverseCharge },
  { name: "invoice-export-goods-nok", input: exportGoodsNok },
  { name: "invoice-eu-goods-eur", input: euGoodsEur },
  { name: "invoice-eu-services-dkk", input: euServicesDkk },
  { name: "invoice-services-outside-eu-usd", input: servicesOutsideEuUsd },
  { name: "invoice-swedish-vat-in-eur", input: swedishVatInEur },
];
