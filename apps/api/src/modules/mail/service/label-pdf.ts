import PDFDocument from "pdfkit";
import { code128Width, drawCode128, drawQrCode } from "./pdf-codes.js";

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
  | { kind: "location"; labelCode: string; name: string; warehouseName: string };

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

function drawLabel(doc: PDFKit.PDFDocument, label: LabelInput, box: Box, large: boolean) {
  const pad = large ? 10 : 7;
  const inner = { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad, height: box.height - 2 * pad };
  const titleSize = large ? 20 : 13;
  const textSize = large ? 11 : 8;
  const smallSize = large ? 9 : 6.5;
  const codeHeight = large ? 44 : 28;

  const code = label.kind === "article" ? label.articleNumber : label.labelCode;
  const title = label.kind === "article" ? label.articleNumber : label.name;
  const caption = label.kind === "article" ? label.name : label.warehouseName;
  const eyebrow = label.kind === "location" ? "LAGERPLATS" : null;

  let y = inner.y;
  if (eyebrow) {
    doc.font("Helvetica-Bold").fontSize(smallSize).fillColor("#555555");
    doc.text(eyebrow, inner.x, y, { width: inner.width, lineBreak: false });
    doc.fillColor("#000000");
    y += smallSize + 2;
  }

  // The code's width decides the layout: Code 128 across the bottom, or a
  // QR square on the right with the text beside it.
  const barWidth = code128Width(code, inner.width);
  const qrSize = barWidth === null ? Math.min(inner.height - (eyebrow ? smallSize + 2 : 0), large ? 96 : 62) : 0;
  const textWidth = barWidth === null ? inner.width - qrSize - 6 : inner.width;

  doc.font("Helvetica-Bold").fontSize(titleSize).fillColor("#000000");
  doc.text(title, inner.x, y, { width: textWidth, height: titleSize * 1.2, ellipsis: true, lineBreak: false });
  y += titleSize * 1.15;
  doc.font("Helvetica").fontSize(textSize);
  doc.text(caption, inner.x, y, { width: textWidth, height: textSize * 1.2, ellipsis: true, lineBreak: false });
  y += textSize * 1.2;
  if (label.kind === "article" && label.barcode) {
    doc.fontSize(smallSize).fillColor("#555555");
    doc.text(`EAN ${label.barcode}`, inner.x, y, { width: textWidth, lineBreak: false });
    doc.fillColor("#000000");
  }

  if (barWidth !== null) {
    const codeY = inner.y + inner.height - codeHeight - (smallSize + 2);
    drawCode128(doc, code, inner.x + (inner.width - barWidth) / 2, codeY, inner.width, codeHeight);
    doc.font("Helvetica").fontSize(smallSize);
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
