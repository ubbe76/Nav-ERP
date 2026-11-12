// Picks the parser for an uploaded import file. The service only ever gets a
// Buffer — the routes hand over `await file.toBuffer()` and never the
// filename — so the format is detected from the CONTENT, which is the better
// signal anyway: a workbook renamed to .csv still reads correctly, and a CSV
// renamed to .xlsx does not silently fail.
import {
  LegacyExcelFileError,
  UnreadableImportFileError,
  parseCsvBuffer,
} from "./csv.js";
import { parseXlsxBuffer } from "./xlsx.js";
import { unguardFormulaInjection } from "@navet/shared";

export type ImportFileFormat = "csv" | "xlsx";

export interface ParsedImportFile {
  format: ImportFileFormat;
  /** null for xlsx. */
  delimiter: ";" | "," | "\t" | null;
  /** null for xlsx. */
  encoding: "utf-8" | "windows-1252" | null;
  /** null for csv. */
  sheetName: string | null;
  /** null for csv. */
  sheetCount: number | null;
  headers: string[];
  rows: string[][];
}

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((byte, i) => buf[i] === byte);
}

// PK\x03\x04 — every .xlsx is a zip archive.
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
// The OLE2 compound-file header of a pre-2007 .xls.
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
// "%PDF" — a common mis-upload, worth its own message rather than a parse
// failure that reads as "your Excel file is broken".
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46];

// Nav's own CSV exports guard a text that starts with a formula character
// (= + - @) with an apostrophe, so Excel shows it instead of running it
// (shared csv.ts). An import file may be such an export — the registers'
// import files (#35), edited and read back — so the apostrophe is dropped
// again here, in both formats (a CSV saved from Excel as .xlsx keeps it):
// "'+46 70 …" is the phone number +46 70 …. Only in front of a formula
// character; any other apostrophe is the cell's own.
function unguardRows(rows: string[][]): string[][] {
  return rows.map((row) => row.map(unguardFormulaInjection));
}

export async function parseImportFile(buf: Buffer): Promise<ParsedImportFile> {
  if (startsWith(buf, OLE2_MAGIC)) throw new LegacyExcelFileError();
  if (startsWith(buf, PDF_MAGIC)) throw new UnreadableImportFileError();

  if (startsWith(buf, ZIP_MAGIC)) {
    const parsed = await parseXlsxBuffer(buf);
    return {
      format: "xlsx",
      delimiter: null,
      encoding: null,
      sheetName: parsed.sheetName,
      sheetCount: parsed.sheetCount,
      headers: parsed.headers,
      rows: unguardRows(parsed.rows),
    };
  }

  const parsed = parseCsvBuffer(buf);
  return {
    format: "csv",
    delimiter: parsed.delimiter,
    encoding: parsed.encoding,
    sheetName: null,
    sheetCount: null,
    headers: parsed.headers,
    rows: unguardRows(parsed.rows),
  };
}
