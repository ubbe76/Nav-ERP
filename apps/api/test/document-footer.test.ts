import { describe, expect, it } from "vitest";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { pdfPageCount, pdfText } from "./helpers/pdf.js";

// Company info stub — payment/registration details set the way the footer
// should print them.
const company = {
  name: "Navet Verkstad AB",
  orgNumber: "556677-8899",
  address: "Verkstadsgatan 1",
  postalCode: "981 32",
  city: "Kiruna",
  phone: "0980-123 45",
  email: "info@navet.local",
  website: "www.navet.local",
  bankgiro: "123-4567",
  plusgiro: "12 34 56-7",
  bankName: "Handelsbanken",
  iban: "SE35 5000 0000 0549 1000 0003",
  bic: "HANDSESS",
  vatNumber: "SE556677889901",
  companySeat: "Kiruna",
  fSkatt: true,
};

const fakeSystem = {
  getCompanyInfo: async () => company as never,
  getLogo: async () => null,
};

const pdf = createDocumentPdfService(fakeSystem);

const documentInput = {
  title: "Inköpsorder",
  documentNumber: "IO-1001",
  date: new Date("2026-07-21T12:00:00Z"),
  partnerLabel: "Leverantör",
  partner: { name: "ACME AB", address: null, postalCode: null, city: null },
  currency: "SEK",
  rows: [
    {
      articleNumber: "ART-1",
      articleName: "Testartikel",
      quantity: "10",
      unit: "st",
      unitPrice: "100",
    },
  ],
  showTotal: true,
  deliveryTerm: null,
  paymentTerm: null,
  carrier: null,
};

describe("document PDF footer", () => {
  it("prints payment and registration details in the footer of outgoing documents", async () => {
    const buffer = await pdf.render(documentInput as never);
    const text = pdfText(buffer);

    expect(text).toContain("Bankgiro: 123-4567");
    expect(text).toContain("Plusgiro: 12 34 56-7");
    expect(text).toContain("Bank: Handelsbanken");
    expect(text).toContain("IBAN: SE35 5000 0000 0549 1000 0003");
    expect(text).toContain("BIC: HANDSESS");
    expect(text).toContain("VAT-nr: SE556677889901");
    expect(text).toContain("Org.nr: 556677-8899");
    expect(text).toContain("te: Kiruna"); // "Säte: Kiruna" — å/ä/ö pass through WinAnsi
    expect(text).toContain("F-skatt");
    // The contact line joins phone, email and website — the full sequence
    // only exists in the footer (the header prints phone · email alone).
    expect(text).toContain("0980-123 45 · info@navet.local · www.navet.local");
  });

  it("skips empty fields instead of printing bare labels", async () => {
    const sparse = createDocumentPdfService({
      getCompanyInfo: async () => ({ ...company, plusgiro: null, iban: null, bic: null, fSkatt: false }) as never,
      getLogo: async () => null,
    });
    const text = pdfText(await sparse.render(documentInput as never));

    expect(text).toContain("Bankgiro: 123-4567");
    expect(text).not.toContain("Plusgiro");
    expect(text).not.toContain("IBAN");
    expect(text).not.toContain("F-skatt");
  });

  it("keeps the pick list free of the payment footer (internal document)", async () => {
    const buffer = await pdf.renderPickList({
      documentNumber: "KO-2001",
      printedAt: new Date("2026-07-21T12:00:00Z"),
      customerName: "Kund AB",
      expectedDeliveryDate: null,
      note: null,
      customerOrderNumber: null,
      customerReference: null,
      deliveryAddress: null,
      rows: [
        { articleNumber: "ART-1", articleName: "Testartikel", quantityToPick: 5, unit: "st", locations: [] },
      ],
    } as never);
    const text = pdfText(buffer);

    expect(text).not.toContain("Bankgiro");
  });

  it("keeps outgoing documents free of page numbers even across pages", async () => {
    const buffer = await pdf.render({
      ...documentInput,
      rows: Array.from({ length: 80 }, (_, i) => ({
        articleNumber: `ART-${i + 1}`,
        articleName: "Testartikel",
        quantity: "10",
        unit: "st",
        unitPrice: "100",
      })),
    } as never);
    expect(pdfPageCount(buffer)).toBeGreaterThan(1);
    expect(pdfText(buffer)).not.toContain("Sida");
  });
});
