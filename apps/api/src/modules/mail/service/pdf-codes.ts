import QRCode from "qrcode";
import { CODE128_QUIET_ZONE, code128TotalModules, encodeCode128 } from "./code128.js";

// Machine-readable codes on a pdfkit page — shared by the pallet card
// (document-pdf.ts) and the labels (label-pdf.ts, #4) so a scanner reads
// both the same way.

type Doc = PDFKit.PDFDocument;

// Code 128 scaled to the width available (never wider than maxWidth,
// modules never thinner than 0.5 pt — below that a printer cannot hold the
// bars apart, and a 1 pt module is the widest anyone needs). Returns whether
// anything was drawn: false for text set B cannot encode (å/ä/ö) or too long
// to fit, so the caller can fall back to a QR code.
export function drawCode128(doc: Doc, text: string, x: number, y: number, maxWidth: number, height: number): boolean {
  const widths = encodeCode128(text);
  if (!widths) return false;
  const modules = code128TotalModules(widths);
  const moduleWidth = Math.min(1, maxWidth / modules);
  if (moduleWidth < 0.5) return false;
  let cursor = x + CODE128_QUIET_ZONE * moduleWidth;
  widths.forEach((w, i) => {
    if (i % 2 === 0) doc.rect(cursor, y, w * moduleWidth, height).fill("#000000");
    cursor += w * moduleWidth;
  });
  doc.fillColor("#000000");
  return true;
}

// The width drawCode128 would use, quiet zones included — for centring.
export function code128Width(text: string, maxWidth: number): number | null {
  const widths = encodeCode128(text);
  if (!widths) return null;
  const modules = code128TotalModules(widths);
  const moduleWidth = Math.min(1, maxWidth / modules);
  return moduleWidth < 0.5 ? null : modules * moduleWidth;
}

// QR code (error correction M) in a square of `size` pt including a
// 4-module quiet zone on each side. Byte mode carries å/ä/ö, so this never
// falls back.
export function drawQrCode(doc: Doc, text: string, x: number, y: number, size: number): void {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const cell = size / (modules.size + 8);
  const origin = 4 * cell;
  for (let row = 0; row < modules.size; row++) {
    for (let col = 0; col < modules.size; col++) {
      if (modules.get(row, col)) doc.rect(x + origin + col * cell, y + origin + row * cell, cell, cell).fill("#000000");
    }
  }
  doc.fillColor("#000000");
}
