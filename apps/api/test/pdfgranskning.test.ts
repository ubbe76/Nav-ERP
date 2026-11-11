import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import { describe, expect, it } from "vitest";
import { readUblInvoice } from "../src/modules/einvoice/service/ubl/ubl-reader.js";
import { createDocumentPdfService, formatNumber, formatQuantity, formatUnitPrice, formatVatRate, type DocumentPdfInput } from "../src/modules/mail/service/document-pdf.js";
import { renderEInvoiceCopy } from "../src/modules/mail/service/einvoice-copy-pdf.js";
import { renderLabelsPdf } from "../src/modules/mail/service/label-pdf.js";
import { documentFontDir, FONT, FONT_BOLD, FONT_ITALIC, registerDocumentFonts } from "../src/modules/mail/service/pdf-fonts.js";
import { pdfText, pdfTextRuns } from "./helpers/pdf.js";

// Granskningen av dokument-PDF:erna 2026-11-11: the embedded typeface
// (Liberation Sans instead of WinAnsi Helvetica), antal/à-pris with up to
// four decimals, the visningskopia's rabatt/tillägg/förskott, the IO's
// rounded VAT, wrapping names and article numbers, and the VAT base per rate.

const pdf = createDocumentPdfService({
  getCompanyInfo: async () => ({ name: "Navet Verkstad AB", orgNumber: "556000-0000", bankgiro: "123-4567" }) as never,
  getLogo: async () => null,
});

const base: DocumentPdfInput = {
  language: "sv",
  title: "Offert",
  documentNumber: "OF-1001",
  date: new Date("2026-11-10T12:00:00Z"),
  partnerLabel: "Kund",
  partner: { name: "Kund AB", address: "Gatan 1", postalCode: "111 22", city: "Stockholm" },
  currency: "SEK",
  rows: [{ articleNumber: "A-1", articleName: "Artikel", quantity: "1", unit: "st", unitPrice: "100" }],
  showTotal: true,
};

// An amount as the documents print it (sv-SE: no-break thousands separator,
// which the PDF's text keeps).
const sv = (value: number) => formatNumber(value, 2);

describe("the documents' typeface", () => {
  it("prints Polish names, Ω and ≤ intact, and the text after them whole", async () => {
    const text = pdfText(
      await pdf.render({
        ...base,
        partner: { name: "Łódź Meble Spółka z o.o.", address: "ul. Piłsudskiego 12", postalCode: "90-001", city: "Łódź", country: "PL" },
        rows: [{ articleNumber: "R-10K", articleName: "Motstånd 10 kΩ ≤ 0,25 W", quantity: "3", unit: "st", unitPrice: "2" }],
      })
    );
    expect(text).toContain("Łódź Meble Spółka z o.o.");
    expect(text).toContain("ul. Piłsudskiego 12");
    expect(text).toContain("90-001 Łódź");
    expect(text).toContain("Motstånd 10 kΩ ≤ 0,25 W");
    // The row's next cells came out after it, not swallowed by it.
    expect(text).toContain("Motstånd 10 kΩ ≤ 0,25 W3st2,006,00");
  });

  it("a character the font lacks (⌀) becomes the .notdef box — the rest of the call is untouched", async () => {
    const text = pdfText(await pdf.render({ ...base, rows: [{ ...base.rows[0]!, articleName: "Skruv ⌀ 6 mm, rostfri" }] }));
    expect(text).toContain("Skruv � 6 mm, rostfri");
  });

  it("every renderer embeds Liberation Sans and none falls back on Helvetica", async () => {
    const documents = [
      await pdf.render(base),
      await pdf.renderPickList({ documentNumber: "KO-1", printedAt: new Date("2026-11-10T12:00:00Z"), customerName: "Kund AB", expectedDeliveryDate: null, note: null, rows: [] }),
      await renderLabelsPdf([{ kind: "article", articleNumber: "A-1", name: "Łódź", barcode: null }], "single"),
      await renderEInvoiceCopy(readUblInvoice(readFileSync(new URL("./fixtures/ubl/invoice-two-rates-discount.xml", import.meta.url))), {}),
    ];
    for (const document of documents) {
      const raw = document.toString("latin1");
      expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+LiberationSans/);
      expect(raw).not.toContain("/BaseFont /Helvetica");
    }
    expect(pdfText(documents[2]!)).toContain("Łódź");
  });

  it("reads back the ordinary space and the no-break space as printed, whichever comes first", async () => {
    // Each has its own glyph in Liberation Sans 2.1.5; a font that shared
    // one would make pdfkit's ToUnicode map say the same for both.
    const first = createDocumentPdfService({ getCompanyInfo: async () => ({ name: `${formatNumber(1000)} Verkstad AB` }) as never, getLogo: async () => null });
    const text = pdfText(await first.render(base));
    expect(text).toContain("1\u00a0000,00 Verkstad AB");
    expect(text).toContain("Offert OF-1001");
    expect(text).toContain("Summa SEK");
  });

  it("control characters have no width and no mark, as with Helvetica (a CRLF text, a tab, the line break)", async () => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    registerDocumentFonts(doc);
    for (const [embedded, standard] of [
      [FONT, "Helvetica"],
      [FONT_BOLD, "Helvetica-Bold"],
    ] as const) {
      doc.font(standard).fontSize(10);
      const expected = doc.widthOfString("Rad 1\r\n\tRad 2\n");
      doc.font(embedded).fontSize(10);
      expect(doc.widthOfString("Rad 1\r\n\tRad 2\n"), embedded).toBeCloseTo(expected, 1);
      expect(doc.widthOfString("Rad 1\r\n\tRad 2\n"), embedded).toBeCloseTo(doc.widthOfString("Rad 1Rad 2"), 6);
    }
    const text = pdfText(await pdf.render({ ...base, rows: [{ ...base.rows[0]!, extraDescription: "Rad 1\r\nRad 2\tslut\r\n" }] }));
    expect(text).toContain("Rad 1Rad 2slut");
    expect(text).not.toContain("\ufffd");
  });

  it("keeps Helvetica's vertical metrics: same line height and baseline, so no layout moves", () => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    registerDocumentFonts(doc);
    // Explicit lines: the height then depends on the vertical metrics only
    // (kerning differs slightly between the AFM and the TrueType font).
    const paragraph = "Första raden\nAndra raden\nTredje raden";
    for (const [embedded, standard] of [
      [FONT, "Helvetica"],
      [FONT_BOLD, "Helvetica-Bold"],
      [FONT_ITALIC, "Helvetica-Oblique"],
    ] as const) {
      for (const size of [8, 9, 10, 18]) {
        doc.font(standard).fontSize(size);
        const expected = { line: doc.currentLineHeight(true), height: doc.heightOfString(paragraph, { width: 120 }) };
        doc.font(embedded).fontSize(size);
        expect(doc.currentLineHeight(true), `${embedded} ${size}`).toBeCloseTo(expected.line, 6);
        expect(doc.heightOfString(paragraph, { width: 120 }), `${embedded} ${size}`).toBeCloseTo(expected.height, 6);
      }
    }
  });

  it("draws the first baseline exactly where Helvetica did", async () => {
    const baseline = async (font: string | null) => {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      if (font) registerDocumentFonts(doc);
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
      doc.font(font ?? "Helvetica").fontSize(14).text("Rubrik", 50, 100);
      doc.end();
      return pdfTextRuns(await done)[0]!.y;
    };
    expect(await baseline(FONT)).toBeCloseTo(await baseline(null), 6);
  });

  it("finds the font files in apps/api/assets/fonts", () => {
    expect(documentFontDir()).toMatch(/apps\/api\/assets\/fonts\/$/);
  });
});

describe("antal and à-pris with up to four decimals", () => {
  it("formats quantities, prices and rates", () => {
    expect(formatQuantity("7")).toBe("7");
    expect(formatQuantity("2.125")).toBe("2,125");
    expect(formatQuantity("2.5")).toBe("2,50");
    expect(formatQuantity("1.33333")).toBe("1,3333");
    expect(formatQuantity("-2.125")).toBe("-2,125");
    expect(formatQuantity("2.125", "en")).toBe("2.125");
    expect(formatUnitPrice(1.4306)).toBe("1,4306");
    expect(formatUnitPrice(100)).toBe("100,00");
    expect(formatUnitPrice(1234.5, "en")).toBe("1,234.50");
    expect(formatVatRate(25)).toBe("25");
    expect(formatVatRate(25.5)).toBe("25,5");
  });

  it("prints antal 2,125 and à-pris 1,4306 on the document; the amount stays at two decimals", async () => {
    const text = pdfText(await pdf.render({ ...base, rows: [{ articleNumber: "A-1", articleName: "Plåt", quantity: "2.125", unit: "m2", unitPrice: "1.4306" }] }));
    expect(text).toContain("Plåt2,125m21,43063,04");
    const english = pdfText(await pdf.render({ ...base, language: "en", rows: [{ articleNumber: "A-1", articleName: "Plate", quantity: "2.125", unit: "m2", unitPrice: "1.4306" }] }));
    expect(english).toContain("Plate2.125m21.43063.04");
  });

  it("the pick list, delivery note and count sheet print 2,125 too", async () => {
    const pick = pdfText(
      await pdf.renderPickList({
        documentNumber: "KO-1",
        printedAt: new Date("2026-11-10T12:00:00Z"),
        customerName: "Kund AB",
        expectedDeliveryDate: null,
        note: null,
        rows: [{ articleNumber: "A-1", articleName: "Plåt", quantityToPick: 2.125, unit: "m2", locations: [] }],
      })
    );
    expect(pick).toContain("2,125");
    const note = pdfText(
      await pdf.renderDeliveryNote({
        language: "sv",
        documentNumber: "FS-1",
        orderNumber: "KO-1",
        deliveredAt: new Date("2026-11-10T12:00:00Z"),
        customerName: "Kund AB",
        rows: [{ articleNumber: "A-1", articleName: "Plåt", quantity: 2.125, unit: "m2", priorDelivered: 0.5 }],
      })
    );
    expect(note).toContain("2,125m20,50");
    const count = pdfText(
      await pdf.renderStockCountSheet({
        documentNumber: "IN-1",
        printedAt: new Date("2026-11-10T12:00:00Z"),
        warehouseName: "Huvudlager",
        locationName: "A1",
        locationLabelCode: "LP0001",
        blocksTransactions: false,
        note: null,
        showBalances: true,
        rows: [{ articleNumber: "A-1", articleName: "Plåt", unit: "m2", snapshotQuantity: 2.125 }],
      })
    );
    expect(count).toContain("2,125");
  });
});

describe("the purchase order's totals add up", () => {
  it("rounds the VAT to öre: 10,01 + 2,50 = 12,51", async () => {
    const text = pdfText(
      await pdf.render({
        ...base,
        title: "Inköpsorder",
        partnerLabel: "Leverantör",
        rows: [{ articleNumber: "SKRUV-M6", articleName: "Skruv M6", quantity: "7", unit: "st", unitPrice: "1.4306" }],
        vat: { rate: 25, grossLabel: "totalInclVat" },
      })
    );
    expect(text).toContain("Summa exkl. moms SEK10,01");
    expect(text).toContain("Moms (25 %)2,50");
    expect(text).toContain("Summa inkl. moms SEK12,51");
  });
});

describe("the invoice's VAT base per rate", () => {
  const invoice = (language: "sv" | "en", rows: DocumentPdfInput["rows"]): DocumentPdfInput => ({
    ...base,
    language,
    title: language === "sv" ? "Faktura" : "Invoice",
    documentNumber: "FA-1001",
    partnerLabel: language === "sv" ? "Fakturaadress" : "Invoice address",
    rows,
    vat: { perRow: true },
  });
  const row = (articleNumber: string, net: string, rate: number, vat: string, code: { code: string; name: string } | null = null) => ({
    articleNumber,
    articleName: articleNumber,
    quantity: "1",
    unit: "st",
    unitPrice: net,
    vatRate: rate,
    lineAmount: net,
    vatAmount: vat,
    vatCode: code,
  });

  it("prints Moms (25 %) på 200,00 and Moms (6 %) på 100,00 with their own VAT (ML 17 kap. 24 § p. 8)", async () => {
    const text = pdfText(await pdf.render(invoice("sv", [row("A", "200", 25, "50"), row("B", "100", 6, "6")])));
    expect(text).toContain(`Moms (25 %) på ${sv(200)}${sv(50)}`);
    expect(text).toContain(`Moms (6 %) på ${sv(100)}${sv(6)}`);
    expect(text).toContain(`Summa exkl. moms SEK${sv(300)}`);
    expect(text).toContain(`Att betala SEK${sv(356)}`);
  });

  it("in English, with a 0 % code's name, and with a single rate too", async () => {
    const english = pdfText(await pdf.render(invoice("en", [row("A", "1200", 25, "300"), row("B", "100", 12, "12")])));
    expect(english).toContain("VAT (25%) on 1,200.00300.00");
    expect(english).toContain("VAT (12%) on 100.0012.00");
    const exempt = pdfText(
      await pdf.render(invoice("sv", [row("A", "1000", 0, "0", { code: "EUV", name: "Varor till annat EU-land" }), row("B", "100", 25, "25")]))
    );
    expect(exempt).toContain(`Varor till annat EU-land på ${sv(1000)}${sv(0)}`);
    expect(exempt).toContain(`Moms (25 %) på ${sv(100)}${sv(25)}`);
    const single = pdfText(await pdf.render(invoice("sv", [row("A", "200", 25, "50")])));
    expect(single).toContain(`Moms (25 %) på ${sv(200)}${sv(50)}`);
  });
});

describe("the visningskopia adds up", () => {
  it("prints the line's rabatt, the document's rabatt/tillägg and the förskott, antal/à-pris as sent and 25,5 %", async () => {
    const doc = readUblInvoice(readFileSync(new URL("./fixtures/ubl/invoice-two-rates-discount.xml", import.meta.url)));
    doc.lines[1] = { ...doc.lines[1]!, quantity: 2.125, unitPrice: 1.4306, chargeAmount: 10, lineAmount: 13.04, vatRate: 25.5 };
    doc.vat = [...doc.vat, { category: "S", percent: 25.5, taxableAmount: 13.04, taxAmount: 3.33, exemptionReason: null }];
    doc.totals = { ...doc.totals, allowanceTotalAmount: 25, chargeTotalAmount: 100, prepaidAmount: 1000 };
    const text = pdfText(await renderEInvoiceCopy(doc, {}));
    // Line 1: 2 × 5 600,00 − 1 120,00 = 10 080,00.
    expect(text).toContain(`Rabatt ${sv(-1120)}`);
    // Line 2: 2,125 × 1,4306 + 10,00 tillägg = 13,04.
    expect(text).toContain(`2,125tim1,4306${sv(13.04)}25,5`);
    expect(text).toContain(`Tillägg ${sv(10)}`);
    expect(text).toContain(`Moms 25,5 % på ${sv(13.04)}`);
    for (const line of [`Summa rader${sv(13625)}`, `Rabatt${sv(-25)}`, `Tillägg${sv(100)}`, `Förskott${sv(-1000)}`]) expect(text).toContain(line);
  });

  it("prints no Summa rader/Rabatt/Tillägg/Förskott lines when the document has none", async () => {
    const text = pdfText(await renderEInvoiceCopy(readUblInvoice(readFileSync(new URL("./fixtures/ubl/invoice-two-rates-discount.xml", import.meta.url))), {}));
    expect(text).not.toContain("Summa rader");
    expect(text).not.toContain("Förskott");
    expect(text).not.toContain("Tillägg");
  });
});

describe("long names and article numbers wrap inside their column", () => {
  it("a long customer name beside LEVERANSADRESS wraps and pushes the address down", async () => {
    const name = "Norrlands Plåtbearbetnings- och Ytbehandlingsaktiebolag i Sundsvall";
    const runs = pdfTextRuns(
      await pdf.render({
        ...base,
        partner: { name, address: "Industrigatan 15", postalCode: "851 00", city: "Sundsvall" },
        deliveryAddress: { label: "Lagret", address: "Godsvägen 1", postalCode: "111 22", city: "Stockholm", country: "SE" },
      })
    );
    const nameRuns = runs.filter((run) => name.includes(run.text) && run.text.length > 3);
    expect(nameRuns.length).toBeGreaterThan(1);
    expect(nameRuns.map((run) => run.text.trim()).join(" ")).toBe(name);
    // Every piece fits in the partner column (250 pt at 11 pt bold).
    const doc = new PDFDocument();
    registerDocumentFonts(doc);
    doc.font(FONT_BOLD).fontSize(11);
    for (const run of nameRuns) expect(doc.widthOfString(run.text)).toBeLessThanOrEqual(250);
    // The street is a full line below the name's last line (y grows upwards).
    const street = runs.find((run) => run.text === "Industrigatan 15")!;
    expect(nameRuns.at(-1)!.y - street.y).toBeGreaterThanOrEqual(12);
  });

  it("a long article number takes the row height it needs, on every row table", async () => {
    const articleNumber = "MOTSTÅND-10KΩ-0,25W-METALLFILM-LÅNG";
    const below = (buffer: Buffer) => {
      const runs = pdfTextRuns(buffer);
      const pieces = runs.filter((run) => articleNumber.includes(run.text) && run.text.length > 2 && run.text !== "A-2");
      const next = runs.find((run) => run.text === "A-2")!;
      expect(pieces.length).toBeGreaterThan(1);
      return Math.min(...pieces.map((piece) => piece.y)) - next.y;
    };
    const rows = [
      { articleNumber, articleName: "Motstånd", quantity: "1", unit: "st", unitPrice: "1" },
      { articleNumber: "A-2", articleName: "Nästa", quantity: "1", unit: "st", unitPrice: "1" },
    ];
    expect(below(await pdf.render({ ...base, rows }))).toBeGreaterThanOrEqual(9);
    const pickRows = rows.map((r) => ({ articleNumber: r.articleNumber, articleName: r.articleName, quantityToPick: 1, unit: "st", locations: [] }));
    expect(
      below(await pdf.renderPickList({ documentNumber: "KO-1", printedAt: new Date("2026-11-10T12:00:00Z"), customerName: "Kund AB", expectedDeliveryDate: null, note: null, rows: pickRows }))
    ).toBeGreaterThanOrEqual(9);
    const noteRows = rows.map((r) => ({ articleNumber: r.articleNumber, articleName: r.articleName, quantity: 1, unit: "st", priorDelivered: 0 }));
    expect(
      below(
        await pdf.renderDeliveryNote({ language: "sv", documentNumber: "FS-1", orderNumber: "KO-1", deliveredAt: new Date("2026-11-10T12:00:00Z"), customerName: "Kund AB", rows: noteRows })
      )
    ).toBeGreaterThanOrEqual(9);
    const countRows = rows.map((r) => ({ articleNumber: r.articleNumber, articleName: r.articleName, unit: "st", snapshotQuantity: null }));
    expect(
      below(
        await pdf.renderStockCountSheet({
          documentNumber: "IN-1",
          printedAt: new Date("2026-11-10T12:00:00Z"),
          warehouseName: "Huvudlager",
          locationName: "A1",
          locationLabelCode: "LP0001",
          blocksTransactions: false,
          note: null,
          showBalances: false,
          rows: countRows,
        })
      )
    ).toBeGreaterThanOrEqual(9);
  });
});
