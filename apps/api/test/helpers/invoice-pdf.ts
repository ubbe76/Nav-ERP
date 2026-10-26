import { deflateSync } from "node:zlib";
import PDFDocument from "pdfkit";

// Fakturaskanning test invoices — generated with pdfkit so the text layer is
// real (what pdfjs reads in production). ALL DATA IS MADE UP: the companies,
// organisationsnummer, giro and IBAN numbers below are invented and only
// chosen to pass their check digits (Luhn / mod 97).

export const FAKE_BUYER = {
  name: "Navtest Tillverkning AB",
  orgNumber: "559911-4567",
  vatNumber: "SE559911456701",
  bankgiro: "123-4566",
  address: "Testgatan 1",
  postalCode: "111 11",
  city: "Exempelstad",
} as const;

export const FAKE_SUPPLIER = {
  name: "Plåtgrossisten Exempel AB",
  orgNumber: "559900-1236",
  vatNumber: "SE559900123601",
  bankgiro: "5550-1233",
  plusgiro: "1234566",
  iban: "SE3599990000001234567890",
  bic: "TESTSESS",
  address: "Verkstadsvägen 12",
  postalCode: "222 22",
  city: "Påhittby",
} as const;

export const FAKE_OTHER_SUPPLIER = {
  name: "Annan Leverantör Exempel AB",
  orgNumber: "559922-7898",
  bankgiro: "5559-8767",
} as const;

// OCR with a valid mod 10 check digit.
export const FAKE_OCR = "471100016";

export interface InvoicePdfOptions {
  title?: string;
  seller?: { name: string; orgNumber?: string; vatNumber?: string; bankgiro?: string; plusgiro?: string; iban?: string; bic?: string; address?: string; postalCode?: string; city?: string };
  buyer?: { name: string; orgNumber?: string; vatNumber?: string; address?: string; postalCode?: string; city?: string };
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  ocr?: string | null;
  orderReference?: string | null;
  // Printed as given ("1 000,00").
  net?: string | null;
  vat?: string | null;
  gross?: string | null;
  currencyText?: string;
  // Replace a standard label: { invoiceNumber: "Fakt.nr" }.
  labels?: Partial<Record<"invoiceNumber" | "invoiceDate" | "dueDate" | "ocr" | "orderReference" | "net" | "vat" | "gross", string>>;
  // Labels above the values (a header row) instead of beside them.
  headerRow?: boolean;
  extraLines?: string[];
  pages?: number;
}

function render(build: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: "Testfaktura", Producer: "test", Creator: "test" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  build(doc);
  doc.end();
  return done;
}

// A one-page Swedish supplier invoice: the seller's block top left, the
// buyer's top right, the header fields with their labels, the summary and
// the payment footer.
export function invoicePdf(opts: InvoicePdfOptions = {}): Promise<Buffer> {
  const seller = opts.seller ?? FAKE_SUPPLIER;
  const buyer = opts.buyer ?? FAKE_BUYER;
  const label = (key: keyof NonNullable<InvoicePdfOptions["labels"]>, fallback: string) => opts.labels?.[key] ?? fallback;
  const currency = opts.currencyText ?? "kr";
  return render((doc) => {
    doc.font("Helvetica-Bold").fontSize(14).text(seller.name, 40, 40);
    doc.font("Helvetica").fontSize(10);
    if (seller.address) doc.text(seller.address, 40, 60);
    if (seller.postalCode && seller.city) doc.text(`${seller.postalCode} ${seller.city}`, 40, 74);

    doc.font("Helvetica-Bold").fontSize(18).text(opts.title ?? "Faktura", 360, 40);
    doc.font("Helvetica").fontSize(10);
    doc.text(buyer.name, 360, 80);
    if (buyer.address) doc.text(buyer.address, 360, 94);
    if (buyer.postalCode && buyer.city) doc.text(`${buyer.postalCode} ${buyer.city}`, 360, 108);
    if (buyer.orgNumber) doc.text(`Er org.nr ${buyer.orgNumber}`, 360, 122);

    const fields: [string, string | null | undefined][] = [
      [label("invoiceNumber", "Fakturanummer:"), opts.invoiceNumber ?? "10045"],
      [label("invoiceDate", "Fakturadatum:"), opts.invoiceDate ?? "2026-10-01"],
      [label("dueDate", "Förfallodatum:"), opts.dueDate ?? "2026-10-31"],
      [label("ocr", "OCR-nummer:"), opts.ocr === undefined ? FAKE_OCR : opts.ocr],
      [label("orderReference", "Er order:"), opts.orderReference ?? null],
    ];
    let y = 160;
    if (opts.headerRow) {
      let x = 40;
      for (const [name, value] of fields) {
        if (value === null || value === undefined) continue;
        doc.text(name, x, y);
        doc.text(value, x, y + 14);
        x += 105;
      }
      y += 40;
    } else {
      for (const [name, value] of fields) {
        if (value === null || value === undefined) continue;
        doc.text(name, 40, y);
        doc.text(value, 180, y);
        y += 16;
      }
    }

    y += 20;
    doc.text("Benämning", 40, y);
    doc.text("Antal", 300, y);
    doc.text("Belopp", 460, y);
    y += 16;
    doc.text("Plåt 2 mm rostfri", 40, y);
    doc.text("4", 300, y);
    doc.text(opts.net ?? "1 000,00", 460, y);
    y += 30;
    for (const line of opts.extraLines ?? []) {
      doc.text(line, 40, y);
      y += 16;
    }

    const summary: [string, string | null | undefined][] = [
      [label("net", "Summa exkl. moms"), opts.net === undefined ? "1 000,00" : opts.net],
      [label("vat", "Moms 25 %"), opts.vat === undefined ? "250,00" : opts.vat],
      [label("gross", "Att betala"), opts.gross === undefined ? "1 250,00" : opts.gross],
    ];
    for (const [name, value] of summary) {
      if (value === null || value === undefined) continue;
      doc.text(name, 300, y);
      doc.text(`${value} ${currency}`, 460, y);
      y += 16;
    }

    const footer = [
      seller.name,
      seller.orgNumber ? `Org.nr ${seller.orgNumber}` : null,
      seller.vatNumber ? `Momsreg.nr ${seller.vatNumber}` : null,
    ].filter(Boolean).join("   ");
    doc.text(footer, 40, 740);
    const payment = [
      seller.bankgiro ? `Bankgiro ${seller.bankgiro}` : null,
      seller.plusgiro ? `Plusgiro ${seller.plusgiro.slice(0, -1)}-${seller.plusgiro.slice(-1)}` : null,
    ].filter(Boolean).join("   ");
    if (payment) doc.text(payment, 40, 754);
    if (seller.iban) doc.text(`IBAN ${seller.iban.replace(/(.{4})/g, "$1 ").trim()}   BIC ${seller.bic ?? ""}`, 40, 768);

    for (let page = 2; page <= (opts.pages ?? 1); page++) {
      doc.addPage();
      doc.text(`Sida ${page} — villkor och övrig information om leveransen`, 40, 40);
    }
  });
}

// A tiny valid PNG (grey square) — CRC'd chunks, deflated scanlines.
export function pngImage(size = 64): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows = Buffer.alloc((size + 1) * size, 0x80);
  for (let r = 0; r < size; r++) rows[r * (size + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// A "scanned" PDF: one page with an embedded image and no text at all.
export function imageOnlyPdf(): Promise<Buffer> {
  return render((doc) => {
    doc.image(pngImage(), 40, 40, { width: 400 });
  });
}

// Starts like a PDF, is not one.
export function brokenPdf(): Buffer {
  return Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\ntrailer garbage, no xref\n%%EOF", "latin1");
}

// JPEG magic bytes and filler — accepted as a JPEG by the inbox (images are
// never decoded locally).
export function jpegImage(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 0x11), Buffer.from([0xff, 0xd9])]);
}
