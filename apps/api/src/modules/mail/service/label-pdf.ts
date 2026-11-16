import PDFDocument from "pdfkit";
import { code128Width, drawCode128, drawQrCode } from "./pdf-codes.js";
import { FONT, FONT_BOLD, registerDocumentFonts } from "./pdf-fonts.js";

// Etiketter (#4; spec 2026-10-29-skanning-design.md) — article and lagerplats
// labels for scanning. Two formats (user decision): an A4 sheet of 24 labels
// 70 × 37 mm (3 × 8, starting at any position so a half-used sheet can be
// fed again) and a label printer, one 100 × 50 mm label per page. No company
// header — a label is a code with its caption, nothing else. Rendered on its
// own (no settings, no logo), so the modules that print labels import this
// directly.
//
// The code carries what a scan resolves (GET /scan): the article number,
// or the location's label code (LP0042). Code 128 when set B encodes the
// text and it fits, else a QR code — å/ä/ö in an article number would
// otherwise print nothing scannable.

export type LabelFormat = "a4" | "single";

export type LabelInput =
  | { kind: "article"; articleNumber: string; name: string; barcode: string | null }
  // warehouseName null = Flera lager off: the label says the place only.
  | { kind: "location"; labelCode: string; name: string; warehouseName: string | null }
  // Batch- and serienummeretiketter (#8 etapp 2): the number is the code a
  // scan resolves; the article it belongs to is the caption.
  | { kind: "batch"; sort: "batch" | "serial"; number: string; articleNumber: string; name: string }
  // Inleveransetikett: what one receipt put on the shelf. The article number
  // is the code (as the article label); the rest is pre-formatted by the
  // purchase service — quantity with the row's unit, the received Stockholm
  // day, the place (null = no stock row) and "Batch …"/"Serienummer …".
  | {
      kind: "receipt";
      articleNumber: string;
      name: string;
      quantity: string;
      orderNumber: string;
      supplierName: string;
      receivedOn: string;
      location: string | null;
      tracking: string | null;
    };

const MM = 72 / 25.4;
const A4 = { width: 595.28, height: 841.89 };
const SHEET = { columns: 3, rows: 8, labelWidth: 70 * MM, labelHeight: 37 * MM };
export const LABELS_PER_SHEET = SHEET.columns * SHEET.rows;
const SINGLE = { width: 100 * MM, height: 50 * MM };

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The inleveransetikett: the article number with the quantity beside it,
// the name, then the receipt's facts in small lines and the code at the
// bottom — Code 128 across, else a QR square in the bottom right corner. The
// number, quantity and name lie above the square and keep the full width;
// only the small lines run beside it. Every line is one line with an
// ellipsis, so nothing can push past the label.
function drawReceiptLabel(doc: PDFKit.PDFDocument, label: Extract<LabelInput, { kind: "receipt" }>, box: Box, large: boolean) {
  const pad = large ? 10 : 7;
  const inner = { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad };
  const titleSize = large ? 18 : 12;
  const nameSize = large ? 10 : 7.5;
  const smallSize = large ? 8.5 : 6.5;
  const codeHeight = large ? 34 : 22;

  const barWidth = code128Width(label.articleNumber, inner.width);
  // The square starts below the number and the name (31 resp. 38 pt down).
  const qrSize = barWidth === null ? (large ? 84 : 60) : 0;
  const factWidth = barWidth === null ? inner.width - qrSize - 6 : inner.width;
  const line = (text: string, y: number, size: number, width = inner.width) => {
    doc.text(text, inner.x, y, { width, height: size * 1.2, ellipsis: true, lineBreak: false });
  };

  let y = inner.y;
  // Article number left, quantity right on the same line — the quantity
  // keeps its width (at most 45 %), the number takes an ellipsis.
  doc.font(FONT_BOLD).fontSize(titleSize).fillColor("#000000");
  // A box exactly as wide as the text makes pdfkit wrap the unit away — a
  // couple of points of slack keep "400 st" whole.
  const quantityWidth = Math.min(doc.widthOfString(label.quantity) + 2, inner.width * 0.45);
  line(label.articleNumber, y, titleSize, inner.width - quantityWidth - 6);
  doc.text(label.quantity, inner.x + inner.width - quantityWidth, y, {
    width: quantityWidth,
    height: titleSize * 1.2,
    ellipsis: true,
    lineBreak: false,
    align: "right",
  });
  y += titleSize * 1.15;
  doc.font(FONT).fontSize(nameSize);
  line(label.name, y, nameSize);
  y += nameSize * 1.25;
  doc.fontSize(smallSize);
  const facts = [
    `${label.orderNumber} · ${label.supplierName}`,
    `Mottagen ${label.receivedOn}${label.location ? ` · ${label.location}` : ""}`,
    ...(label.tracking ? [label.tracking] : []),
  ];
  for (const fact of facts) {
    line(fact, y, smallSize, factWidth);
    y += smallSize * 1.2;
  }

  if (barWidth !== null) {
    const codeY = inner.y + inner.height - codeHeight - (smallSize + 2);
    drawCode128(doc, label.articleNumber, inner.x + (inner.width - barWidth) / 2, codeY, inner.width, codeHeight);
    doc.font(FONT).fontSize(smallSize);
    doc.text(label.articleNumber, inner.x, codeY + codeHeight + 1, { width: inner.width, align: "center", lineBreak: false });
  } else {
    drawQrCode(doc, label.articleNumber, inner.x + inner.width - qrSize, inner.y + inner.height - qrSize, qrSize);
  }
}

function drawLabel(doc: PDFKit.PDFDocument, label: LabelInput, box: Box, large: boolean) {
  if (label.kind === "receipt") {
    drawReceiptLabel(doc, label, box, large);
    return;
  }
  const pad = large ? 10 : 7;
  const inner = { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad };
  const titleSize = large ? 20 : 13;
  const textSize = large ? 11 : 8;
  const smallSize = large ? 9 : 6.5;
  const codeHeight = large ? 44 : 28;

  const code = label.kind === "article" ? label.articleNumber : label.kind === "batch" ? label.number : label.labelCode;
  const title = label.kind === "article" ? label.articleNumber : label.kind === "batch" ? label.number : label.name;
  const caption =
    label.kind === "article" ? label.name : label.kind === "batch" ? `${label.articleNumber} · ${label.name}` : label.warehouseName;
  const eyebrow = label.kind === "location" ? "LAGERPLATS" : label.kind === "batch" ? (label.sort === "serial" ? "SERIENUMMER" : "BATCH") : null;

  let y = inner.y;
  if (eyebrow) {
    doc.font(FONT_BOLD).fontSize(smallSize).fillColor("#555555");
    doc.text(eyebrow, inner.x, y, { width: inner.width, lineBreak: false });
    doc.fillColor("#000000");
    y += smallSize + 2;
  }

  // The code's width decides the layout: Code 128 across the bottom, or a
  // QR square on the right with the text beside it.
  const barWidth = code128Width(code, inner.width);
  const qrSize = barWidth === null ? Math.min(inner.height - (eyebrow ? smallSize + 2 : 0), large ? 96 : 62) : 0;
  const textWidth = barWidth === null ? inner.width - qrSize - 6 : inner.width;

  doc.font(FONT_BOLD).fontSize(titleSize).fillColor("#000000");
  doc.text(title, inner.x, y, { width: textWidth, height: titleSize * 1.2, ellipsis: true, lineBreak: false });
  y += titleSize * 1.15;
  doc.font(FONT).fontSize(textSize);
  if (caption) {
    doc.text(caption, inner.x, y, { width: textWidth, height: textSize * 1.2, ellipsis: true, lineBreak: false });
    y += textSize * 1.2;
  }
  if (label.kind === "article" && label.barcode) {
    doc.fontSize(smallSize).fillColor("#555555");
    doc.text(`EAN ${label.barcode}`, inner.x, y, { width: textWidth, lineBreak: false });
    doc.fillColor("#000000");
  }

  if (barWidth !== null) {
    const codeY = inner.y + inner.height - codeHeight - (smallSize + 2);
    drawCode128(doc, code, inner.x + (inner.width - barWidth) / 2, codeY, inner.width, codeHeight);
    doc.font(FONT).fontSize(smallSize);
    doc.text(code, inner.x, codeY + codeHeight + 1, { width: inner.width, align: "center", lineBreak: false });
  } else {
    drawQrCode(doc, code, inner.x + inner.width - qrSize, inner.y + inner.height - qrSize, qrSize);
  }
}

// `start` (A4 only) is the 1-based position of the first label on the first
// sheet — 1..24, left to right, top to bottom.
export async function renderLabelsPdf(labels: LabelInput[], format: LabelFormat, start = 1): Promise<Buffer> {
  const doc =
    format === "a4"
      ? new PDFDocument({ size: "A4", margin: 0, autoFirstPage: false })
      : new PDFDocument({ size: [SINGLE.width, SINGLE.height], margin: 0, autoFirstPage: false });
  registerDocumentFonts(doc);
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  if (format === "single") {
    for (const label of labels) {
      doc.addPage();
      drawLabel(doc, label, { x: 0, y: 0, width: SINGLE.width, height: SINGLE.height }, true);
    }
  } else {
    const top = (A4.height - SHEET.rows * SHEET.labelHeight) / 2;
    let position = Math.min(Math.max(Math.trunc(start), 1), LABELS_PER_SHEET) - 1;
    labels.forEach((label, i) => {
      if (i === 0 || position === 0) doc.addPage();
      const column = position % SHEET.columns;
      const row = Math.floor(position / SHEET.columns);
      drawLabel(
        doc,
        label,
        { x: column * SHEET.labelWidth, y: top + row * SHEET.labelHeight, width: SHEET.labelWidth, height: SHEET.labelHeight },
        false
      );
      position = (position + 1) % LABELS_PER_SHEET;
    });
  }
  if (labels.length === 0) doc.addPage();
  doc.end();
  return finished;
}
