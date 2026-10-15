import { describe, expect, it } from "vitest";
import {
  addressLines,
  computePerRowVatGroups,
  createDocumentPdfService,
  type DocumentPdfRow,
} from "../src/modules/mail/service/document-pdf.js";
import { pdfText } from "./helpers/pdf.js";

// Unit-level tests against document-pdf.ts directly (no DB) — same pattern
// as document-footer.test.ts. Covers the B3 Task 2 fix: stored invoice row
// amounts (DocumentPdfRow.lineAmount/vatAmount) become the PDF's monetary
// authority, with a fallback to quantity × unitPrice for document types that
// never carry them (inquiry/PO/quote/order rows).

const company = { name: "Navet Verkstad AB" };
const fakeSystem = {
  getCompanyInfo: async () => company as never,
  getLogo: async () => null,
};
const pdf = createDocumentPdfService(fakeSystem);

// Mirrors document-pdf.ts's formatNumber (including its U+2212 -> '-'
// normalization), same helper as customer-invoice.service.test.ts's `sv`.
function sv(n: number): string {
  return n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace("−", "-");
}

const baseDocument = {
  title: "Faktura",
  documentNumber: "FA-1001",
  date: new Date("2026-07-30T12:00:00Z"),
  partnerLabel: "Fakturaadress",
  partner: { name: "Kund AB", address: null, postalCode: null, city: null },
  currency: "SEK",
  showTotal: true,
};

describe("computePerRowVatGroups", () => {
  // Arithmetic verified with `node -e` before writing this assertion:
  //   3 rows of qty=1 x unitPrice=0.10 @ 25 % VAT, resolveRow's own formula:
  //     lineAmount = round2(1 * 0.10)        = 0.10
  //     vatAmount  = round2(0.10 * 0.25)     = round2(0.025) = 0.03  (per row)
  //   Stored sum (what the ledger/API list already use):
  //     net = 0.10 + 0.10 + 0.10 = 0.30, vat = 0.03 + 0.03 + 0.03 = 0.09
  //   Recomputed on the SUMMED net instead (the old PDF behaviour):
  //     round2(0.30 * 0.25) = round2(0.075) = 0.08
  //   0.09 !== 0.08 — a real 1-öre divergence, not a rounding artifact of the test.
  it("sums stored per-row VAT rather than recomputing VAT on the summed net", () => {
    const rows: DocumentPdfRow[] = Array.from({ length: 3 }, (_, i) => ({
      articleNumber: `ART-${i}`,
      articleName: `Rad ${i}`,
      quantity: "1",
      unit: "st",
      unitPrice: "0.10",
      vatRate: 25,
      lineAmount: "0.10",
      vatAmount: "0.03",
    }));

    const groups = computePerRowVatGroups(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.rate).toBe(25);
    expect(groups[0]!.net).toBeCloseTo(0.3, 6);
    // The stored sum (0.09), NOT the recomputed-on-summed-net figure (0.08).
    expect(groups[0]!.vatAmount).toBeCloseTo(0.09, 6);
  });

  it("falls back to quantity × unitPrice when a row carries no stored amounts", () => {
    const rows: DocumentPdfRow[] = [
      { articleNumber: "ART-1", articleName: "Test", quantity: "2", unit: "st", unitPrice: "100", vatRate: 25 },
    ];

    const groups = computePerRowVatGroups(rows);

    expect(groups).toEqual([{ rate: 25, net: 200, vatAmount: 50 }]);
  });

  it("mixes stored and fallback rows within the same rate group", () => {
    const rows: DocumentPdfRow[] = [
      { articleNumber: "ART-1", articleName: "Stored", quantity: "1", unit: "st", unitPrice: "10", vatRate: 25, lineAmount: "10", vatAmount: "2.5" },
      { articleNumber: "ART-2", articleName: "Fallback", quantity: "1", unit: "st", unitPrice: "10", vatRate: 25 },
    ];

    const groups = computePerRowVatGroups(rows);

    expect(groups).toEqual([{ rate: 25, net: 20, vatAmount: 5 }]);
  });
});

describe("render(): the PDF's printed totals prefer stored line amounts", () => {
  it("three 0.10 kr rows at 25 % VAT: prints the stored VAT sum (0,09), not the recomputed 0,08", async () => {
    const rows: DocumentPdfRow[] = Array.from({ length: 3 }, (_, i) => ({
      articleNumber: `ART-${i}`,
      articleName: `Rad ${i}`,
      quantity: "1",
      unit: "st",
      unitPrice: "0.10",
      vatRate: 25,
      lineAmount: "0.10",
      vatAmount: "0.03",
    }));

    const buffer = await pdf.render({ ...baseDocument, rows, vat: { perRow: true } } as never);
    const text = pdfText(buffer);

    expect(text).toContain(sv(0.3)); // Summa exkl. moms
    expect(text).toContain(sv(0.09)); // Moms (25 %) — stored sum
    expect(text).not.toContain(sv(0.08)); // NOT the recomputed-on-summed-net figure
    expect(text).toContain(sv(0.39)); // Att betala = 0,30 + 0,09
  });

  it("per-row Summa column also prints the stored lineAmount, not quantity × unitPrice", async () => {
    // unitPrice/quantity are display-unit-converted upstream and can
    // legitimately diverge from the base-unit stored lineAmount by a tiny
    // rounding amount — the row's own Summa cell must still show the
    // authoritative stored figure.
    const rows: DocumentPdfRow[] = [
      {
        articleNumber: "ART-1",
        articleName: "Rad",
        quantity: "3",
        unit: "st",
        unitPrice: "33.34", // 3 * 33.34 = 100.02, but the stored amount is 100.00
        vatRate: 25,
        lineAmount: "100.00",
        vatAmount: "25.00",
      },
    ];

    const buffer = await pdf.render({ ...baseDocument, rows, vat: { perRow: true } } as never);
    const text = pdfText(buffer);

    expect(text).toContain(sv(100)); // stored lineAmount, both as row Summa and as the total
    expect(text).not.toContain(sv(100.02)); // NOT quantity × unitPrice
  });

  it("credit sign: negative stored lineAmount/vatAmount (already signed by buildPdf) print negated totals", async () => {
    // Mirrors what invoice.service.ts's buildPdf sends for a credit note:
    // unitPrice is already negated by `sign`, and so are the stored amounts.
    const rows: DocumentPdfRow[] = [
      {
        articleNumber: "ART-1",
        articleName: "Kreditrad",
        quantity: "2",
        unit: "st",
        unitPrice: "-50",
        vatRate: 25,
        lineAmount: "-100",
        vatAmount: "-25",
      },
    ];

    const buffer = await pdf.render({ ...baseDocument, title: "Kreditfaktura", rows, vat: { perRow: true } } as never);
    const text = pdfText(buffer);

    expect(text).toContain(sv(-100)); // Summa exkl. moms
    expect(text).toContain(sv(-25)); // Moms (25 %)
    expect(text).toContain(sv(-125)); // Att betala
  });

  it("rows without stored amounts (inquiry/PO/quote/order rows) keep the old quantity × unitPrice behaviour", async () => {
    const rows: DocumentPdfRow[] = [
      { articleNumber: "ART-1", articleName: "Fri rad", quantity: "3", unit: "st", unitPrice: "33.34" },
    ];

    const buffer = await pdf.render({ ...baseDocument, rows } as never);
    const text = pdfText(buffer);

    expect(text).toContain(sv(100.02)); // 3 * 33.34, unaffected — no lineAmount was supplied
  });
});

describe("Rabatt column visibility (uppföljningssvepet)", () => {
  const row = (discountPercent: string | null): DocumentPdfRow =>
    ({
      articleNumber: "A-1",
      articleName: "Skruv",
      quantity: "2",
      unit: "st",
      unitPrice: "10",
      discountPercent,
    }) as never;

  it("omits the Rabatt header entirely when no row has a discount (inquiry/PO case)", async () => {
    const buffer = await pdf.render({
      ...baseDocument,
      title: "Inköpsorder",
      rows: [row(null), row("0")],
    } as never);
    expect(pdfText(buffer)).not.toContain("Rabatt");
  });

  it("keeps the Rabatt column when any row has a discount", async () => {
    const buffer = await pdf.render({
      ...baseDocument,
      title: "Orderbekräftelse",
      rows: [row(null), row("10")],
    } as never);
    const text = pdfText(buffer);
    expect(text).toContain("Rabatt");
    expect(text).toContain("10 %");
  });
});

// Migration 0085: country lines on the partner/delivery-address blocks.
describe("addressLines() — pure function", () => {
  it("prints no country line for SE", () => {
    expect(addressLines({ address: "Gata 1", postalCode: "123 45", city: "Ort", country: "SE" })).toEqual([
      "Gata 1",
      "123 45 Ort",
    ]);
  });

  it("prints no country line when country is null", () => {
    expect(addressLines({ address: "Gata 1", postalCode: "123 45", city: "Ort", country: null })).toEqual([
      "Gata 1",
      "123 45 Ort",
    ]);
  });

  it("prints no country line when country is omitted entirely", () => {
    expect(addressLines({ address: "Gata 1", postalCode: "123 45", city: "Ort" })).toEqual(["Gata 1", "123 45 Ort"]);
  });

  it("maps DK to Danmark as a trailing line", () => {
    expect(addressLines({ address: "Gata 1", postalCode: "123 45", city: "Ort", country: "DK" })).toEqual([
      "Gata 1",
      "123 45 Ort",
      "Danmark",
    ]);
  });

  it("uppercases a lowercase country code before mapping (dk -> Danmark)", () => {
    expect(addressLines({ address: "Gata 1", postalCode: "123 45", city: "Ort", country: "dk" })).toEqual([
      "Gata 1",
      "123 45 Ort",
      "Danmark",
    ]);
  });

  it("prints the raw ISO code for a country not in the name table", () => {
    expect(addressLines({ address: "Gata 1", postalCode: "123 45", city: "Ort", country: "XX" })).toEqual([
      "Gata 1",
      "123 45 Ort",
      "XX",
    ]);
  });

  it("orders lines as address, then postnr + ort, then land — and omits blank parts", () => {
    expect(addressLines({ address: null, postalCode: "123 45", city: null, country: "NO" })).toEqual([
      "123 45",
      "Norge",
    ]);
  });

  it("splits a multi-row street (Adressrad 1–3 joined with newlines) into one line per row", () => {
    expect(
      addressLines({ address: "FLX 7365560134620\nBOX 171", postalCode: "83122", city: "ÖSTERSUND", country: "SE" })
    ).toEqual(["FLX 7365560134620", "BOX 171", "83122 ÖSTERSUND"]);
    // CRLF and blank rows are tolerated the same way.
    expect(addressLines({ address: "Rad 1\r\n\r\nRad 3", postalCode: null, city: null })).toEqual(["Rad 1", "Rad 3"]);
  });
});

describe("render(): partner and delivery-address country lines", () => {
  it("prints Danmark for a Danish customer but no country line for a Swedish one", async () => {
    const danishBuffer = await pdf.render({
      ...baseDocument,
      partner: { name: "Dansk Kund ApS", address: "Havnegade 1", postalCode: "1058", city: "København", country: "DK" },
      rows: [],
    } as never);
    expect(pdfText(danishBuffer)).toContain("Danmark");

    const swedishBuffer = await pdf.render({
      ...baseDocument,
      partner: { name: "Svensk Kund AB", address: "Storgatan 1", postalCode: "111 22", city: "Stockholm", country: "SE" },
      rows: [],
    } as never);
    expect(pdfText(swedishBuffer)).not.toContain("Sverige");
  });

  it("prints Norge in the delivery-address block for a Norwegian delivery address", async () => {
    const buffer = await pdf.render({
      ...baseDocument,
      rows: [],
      deliveryAddress: {
        label: "Norsk filial",
        address: "Karl Johans gate 1",
        postalCode: "0154",
        city: "Oslo",
        country: "NO",
      },
    } as never);
    const text = pdfText(buffer);
    expect(text).toContain("Norsk filial");
    expect(text).toContain("Norge");
  });
});
