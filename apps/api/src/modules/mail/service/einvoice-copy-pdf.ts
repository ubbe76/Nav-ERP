import PDFDocument from "pdfkit";
import type { ReceivedEInvoice, ReceivedEInvoiceParty } from "../../einvoice/service/ubl/received-einvoice.js";
import { formatNumber, formatQuantity, formatUnitPrice, formatVatRate } from "./document-pdf.js";
import { FONT, FONT_BOLD, registerDocumentFonts } from "./pdf-fonts.js";

// Visningskopia av e-faktura (spec 2026-11-05-e-faktura-mottagning): a
// readable PDF drawn from the received UBL when the e-invoice carries no PDF
// of its own, so the inbox (and later the supplier invoice's underlag) has
// something to show. It is the SUPPLIER's invoice: no logo, no company
// template, always Swedish, and the title band says what it is — the
// original is the XML in einvoice_receptions.
//
// DETERMINISTIC on purpose: the inbox's duplicate guard is the file's
// sha256, so the same document must give the same bytes. pdfkit's
// CreationDate is pinned to the invoice date and the file id derives from
// the info dictionary — no clock, no random id (einvoice-copy-pdf.test.ts
// renders twice and compares).

// No reception date on the copy (review 2026-11-10): the same document
// received on another day must give the same bytes, or the inbox's sha256
// duplicate check holds only within one day. The post carries the date.
export interface EInvoiceCopyOptions {
  // Remarks printed under the title (the embedded PDF was too large …).
  remarks?: string[];
}

export const EINVOICE_COPY_TITLE = "VISNINGSKOPIA AV E-FAKTURA";

const MARGIN = 40;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
const BOTTOM = PAGE_HEIGHT - MARGIN;
const LINE = 12;

const money = (value: number | null) => (value === null ? "" : formatNumber(value, 2));

// UN/ECE Rec 20/21 codes the Swedish reader expects to see as words (the
// reverse of unit-codes.ts for the common ones; anything else as written).
const UNIT_LABELS: Record<string, string> = {
  C62: "st", KGM: "kg", GRM: "g", TNE: "ton", MMT: "mm", CMT: "cm", MTR: "m", KMT: "km", MTK: "m2", MTQ: "m3", LTR: "l", MLT: "ml",
  HUR: "tim", MIN: "min", DAY: "dag", XPK: "förp", XCT: "krt", XBX: "låda", XPX: "pall", SET: "sats", E48: "tjänst", LS: "klumpsumma",
};
export const unitLabel = (code: string | null) => (code === null ? "" : (UNIT_LABELS[code.toUpperCase()] ?? code));

function partyLines(party: ReceivedEInvoiceParty): string[] {
  const lines = [party.name, ...party.address.lines];
  const place = [party.address.postalCode, party.address.city].filter((v): v is string => v !== null).join(" ");
  if (place) lines.push(place);
  if (party.address.country && party.address.country !== "SE") lines.push(party.address.country);
  if (party.companyId) lines.push(`Org.nr ${party.companyId.value}`);
  if (party.vatNumber) lines.push(`Momsreg.nr ${party.vatNumber}`);
  if (party.endpoint) lines.push(`Peppol-id ${party.endpoint.scheme ? `${party.endpoint.scheme}:` : ""}${party.endpoint.value}`);
  return lines;
}

function paymentLines(doc: ReceivedEInvoice): string[] {
  const out: string[] = [];
  const account = doc.payment.account;
  if (account?.kind === "bankgiro") out.push(`Bankgiro ${account.account.slice(0, -4)}-${account.account.slice(-4)}`);
  else if (account?.kind === "plusgiro") out.push(`Plusgiro ${account.account.slice(0, -1)}-${account.account.slice(-1)}`);
  else if (account?.kind === "iban") out.push(`IBAN ${account.iban}${account.bic ? ` · BIC ${account.bic}` : ""}`);
  else if (account?.kind === "other") out.push(`Konto ${account.account}${account.bic ? ` · ${account.bic}` : ""}`);
  if (doc.payment.paymentId) out.push(`${/^\d+$/.test(doc.payment.paymentId) ? "OCR" : "Meddelande"} ${doc.payment.paymentId}`);
  if (doc.payment.termsNote) out.push(doc.payment.termsNote);
  return out;
}

export async function renderEInvoiceCopy(doc: ReceivedEInvoice, options: EInvoiceCopyOptions): Promise<Buffer> {
  const credit = doc.type === "credit_note";
  const pdf = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    bufferPages: true,
    info: {
      Title: `${credit ? "Kreditfaktura" : "Faktura"} ${doc.number}`,
      Producer: "Nav ERP",
      Creator: "Nav ERP",
      CreationDate: new Date(`${doc.issueDate}T00:00:00Z`),
    },
  });
  registerDocumentFonts(pdf);
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });

  let y = MARGIN;
  const ensure = (height: number) => {
    if (y + height > BOTTOM) {
      pdf.addPage();
      y = MARGIN;
    }
  };
  const textLine = (text: string, x: number, width: number, opts: { bold?: boolean; size?: number; align?: "left" | "right" } = {}) => {
    pdf.font(opts.bold ? FONT_BOLD : FONT).fontSize(opts.size ?? 9);
    const height = pdf.heightOfString(text, { width });
    ensure(height);
    pdf.text(text, x, y, { width, align: opts.align ?? "left" });
    return height;
  };

  // Title band
  pdf.rect(MARGIN, y, CONTENT_WIDTH, 26).fill("#333333");
  pdf.fillColor("#ffffff").font(FONT_BOLD).fontSize(12).text(EINVOICE_COPY_TITLE, MARGIN + 8, y + 7, { width: CONTENT_WIDTH - 16 });
  pdf.fillColor("#000000");
  y += 32;
  textLine("Originalet är e-fakturan (XML) som mottogs via Peppol", MARGIN, CONTENT_WIDTH, { size: 8 });
  y += LINE;
  for (const remark of options.remarks ?? []) {
    y += textLine(remark, MARGIN, CONTENT_WIDTH, { size: 8, bold: true });
  }
  y += 10;

  // Document head: title + number, dates, references
  textLine(`${credit ? "KREDITFAKTURA" : "FAKTURA"} ${doc.number}`, MARGIN, CONTENT_WIDTH, { bold: true, size: 16 });
  y += 22;
  const head: [string, string | null][] = [
    ["Fakturadatum", doc.issueDate],
    ["Förfallodatum", doc.dueDate],
    ["Valuta", doc.currency],
    ["Er referens", doc.buyerReference],
    ["Ordernummer", doc.orderReference],
    [credit ? "Krediterar faktura" : "", credit ? doc.creditedInvoiceNumber : null],
  ];
  const col = CONTENT_WIDTH / 2;
  const partyTop = y;
  for (const [label, value] of head) {
    if (!label || value === null) continue;
    textLine(label, MARGIN + col, 90, { bold: true });
    textLine(value, MARGIN + col + 95, col - 95);
    y += LINE;
  }
  const headBottom = y;
  y = partyTop;
  textLine("Säljare", MARGIN, col - 10, { bold: true });
  y += LINE;
  for (const line of partyLines(doc.seller)) {
    y += textLine(line, MARGIN, col - 10);
  }
  y = Math.max(y, headBottom) + 8;
  textLine("Köpare", MARGIN, col - 10, { bold: true });
  y += LINE;
  for (const line of partyLines(doc.buyer)) {
    y += textLine(line, MARGIN, col - 10);
  }
  y += 14;

  // Rows
  const columns = [
    { label: "Artikelnr", width: 60, align: "left" as const },
    { label: "Benämning", width: 175, align: "left" as const },
    { label: "Antal", width: 50, align: "right" as const },
    { label: "Enhet", width: 35, align: "left" as const },
    { label: "À-pris", width: 65, align: "right" as const },
    { label: "Belopp", width: 75, align: "right" as const },
    { label: "Moms %", width: 55, align: "right" as const },
  ];
  const drawRowHeader = () => {
    ensure(LINE + 4);
    let x = MARGIN;
    for (const c of columns) {
      pdf.font(FONT_BOLD).fontSize(8).text(c.label, x + (c.align === "right" ? 0 : 2), y, { width: c.width - 4, align: c.align });
      x += c.width;
    }
    y += LINE;
    pdf.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).lineWidth(0.5).stroke("#000000");
    y += 3;
  };
  drawRowHeader();
  for (const line of doc.lines) {
    const cells = [
      line.sellerItemNumber ?? "",
      line.description,
      // Antal and à-pris as sent (up to four decimals), the rate as sent
      // (25,5 %) — rounded figures that did not multiply out to Belopp made
      // the copy impossible to check (granskning 2026-11-11).
      formatQuantity(line.quantity),
      unitLabel(line.unitCode),
      line.unitPrice === null ? "" : formatUnitPrice(line.unitPrice),
      money(line.lineAmount),
      line.vatRate === null ? "" : formatVatRate(line.vatRate),
    ];
    pdf.font(FONT).fontSize(8);
    const height = Math.max(...cells.map((cell, i) => pdf.heightOfString(cell || " ", { width: columns[i]!.width - 4 })));
    if (y + height > BOTTOM) {
      pdf.addPage();
      y = MARGIN;
      drawRowHeader();
    }
    let x = MARGIN;
    for (const [i, c] of columns.entries()) {
      pdf.text(cells[i]!, x + (c.align === "right" ? 0 : 2), y, { width: c.width - 4, align: c.align });
      x += c.width;
    }
    y += height + 2;
    // The line's own AllowanceCharge: Belopp = antal × à-pris − rabatt +
    // tillägg, so the reader can follow the arithmetic.
    const adjustments = [
      line.allowanceAmount !== 0 ? `Rabatt ${money(-line.allowanceAmount)}` : null,
      line.chargeAmount !== 0 ? `Tillägg ${money(line.chargeAmount)}` : null,
    ].filter((part): part is string => part !== null);
    if (adjustments.length > 0) {
      y += textLine(adjustments.join(" · "), MARGIN + 62, 300, { size: 7 }) + 2;
    }
    if (line.note) {
      y += textLine(line.note, MARGIN + 62, 300, { size: 7 }) + 2;
    }
  }
  y += 6;
  pdf.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT_WIDTH, y).lineWidth(0.5).stroke("#000000");
  y += 8;

  // VAT breakdown + totals
  const labelX = MARGIN + CONTENT_WIDTH - 260;
  const valueX = MARGIN + CONTENT_WIDTH - 110;
  const totalLine = (label: string, value: string, bold = false) => {
    textLine(label, labelX, 145, { bold });
    textLine(value, valueX, 110, { bold, align: "right" });
    y += LINE;
  };
  for (const v of doc.vat) {
    const rate = v.percent === null ? v.category : `${formatVatRate(v.percent)} %`;
    totalLine(`Moms ${rate} på ${money(v.taxableAmount)}`, money(v.taxAmount));
  }
  // The column adds up to Att betala (granskning 2026-11-11): the
  // document-level rabatt/tillägg between the rows' sum and Netto (BT-106 −
  // BT-107 + BT-108 = BT-109), the förskott (BT-113) after Moms — signed as
  // the deductions they are.
  const nonZero = (value: number | null): value is number => value !== null && value !== 0;
  const { allowanceTotalAmount, chargeTotalAmount, prepaidAmount, payableRoundingAmount } = doc.totals;
  if (nonZero(allowanceTotalAmount) || nonZero(chargeTotalAmount)) {
    totalLine("Summa rader", money(doc.totals.lineExtensionAmount));
    if (nonZero(allowanceTotalAmount)) totalLine("Rabatt", money(-allowanceTotalAmount));
    if (nonZero(chargeTotalAmount)) totalLine("Tillägg", money(chargeTotalAmount));
  }
  totalLine("Netto", money(doc.totals.taxExclusiveAmount ?? doc.totals.lineExtensionAmount));
  totalLine("Moms", money(doc.totals.taxAmount ?? (doc.vat.length > 0 ? doc.vat.reduce((s, v) => s + v.taxAmount, 0) : null)));
  if (nonZero(prepaidAmount)) totalLine("Förskott", money(-prepaidAmount));
  if (nonZero(payableRoundingAmount)) totalLine("Öresavrundning", money(payableRoundingAmount));
  totalLine(`${credit ? "Att kreditera" : "Att betala"} ${doc.currency}`, money(doc.totals.payableAmount), true);
  y += 10;

  // Payment and note
  const payment = paymentLines(doc);
  if (payment.length > 0) {
    textLine("Betalning", MARGIN, CONTENT_WIDTH, { bold: true });
    y += LINE;
    for (const line of payment) y += textLine(line, MARGIN, CONTENT_WIDTH);
    y += 8;
  }
  if (doc.note) {
    textLine("Anteckning", MARGIN, CONTENT_WIDTH, { bold: true });
    y += LINE;
    y += textLine(doc.note, MARGIN, CONTENT_WIDTH);
  }

  // Footer on every page. Zeroed bottom margin so writing inside it does
  // not trigger a new page (the same trick as document-pdf's drawPageNumbers).
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const previousBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.font(FONT).fontSize(7).fillColor("#444444");
    pdf.text(`Visningskopia av e-faktura ${doc.number} · sida ${i - range.start + 1} av ${range.count}`, MARGIN, PAGE_HEIGHT - 30, {
      width: CONTENT_WIDTH,
      align: "center",
      lineBreak: false,
    });
    pdf.fillColor("#000000");
    pdf.page.margins.bottom = previousBottom;
  }
  pdf.end();
  return finished;
}
