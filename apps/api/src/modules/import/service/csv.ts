import { businessDateSchema } from "@navet/shared";
// Hand-rolled CSV parser for the Monitor G5 import — deliberately no
// dependency. RFC 4180 quoting ("" escape, quoted delimiters/newlines),
// CRLF/LF/CR line endings, UTF-8 with windows-1252 fallback, and delimiter
// sniffing on the header line.

export type ParsedCsv = {
  delimiter: ";" | "," | "\t";
  encoding: "utf-8" | "windows-1252";
  headers: string[];
  rows: string[][];
};

export const MAX_IMPORT_ROWS = 10_000;

// Base for every "the uploaded file itself is unusable" failure. The routes
// answer 400 for the whole family, so a new file-level failure needs no
// route change — only a new subclass here. The row-limit and empty-file
// cases predate the xlsx support; the two format errors came with it.
export class ImportFileError extends Error {}

export class CsvRowLimitError extends ImportFileError {
  constructor() {
    super("Filen är för stor — max 10 000 rader");
    this.name = "CsvRowLimitError";
  }
}

export class EmptyCsvError extends ImportFileError {
  constructor() {
    super("Filen är tom eller saknar rubrikrad");
    this.name = "EmptyCsvError";
  }
}

export class UnreadableImportFileError extends ImportFileError {
  constructor() {
    super("Filen kunde inte läsas som Excel-fil (.xlsx) — spara om den i Excel eller exportera som CSV");
    this.name = "UnreadableImportFileError";
  }
}

export class Utf16ImportFileError extends ImportFileError {
  constructor() {
    super("Filen är sparad som UTF-16 (Unicode-text) — spara om den som CSV UTF-8 eller .xlsx");
    this.name = "Utf16ImportFileError";
  }
}

// An .xlsx whose parts unpack to more than this (a "zip bomb", or a workbook
// far beyond the 10 000-row limit) is refused before it is unpacked — the
// 20 MB upload limit only bounds the compressed file.
export const MAX_XLSX_UNPACKED_BYTES = 200 * 1024 * 1024;
export class XlsxTooLargeError extends ImportFileError {
  constructor() {
    super("Excel-filen är för stor uppackad — dela upp den eller exportera som CSV");
    this.name = "XlsxTooLargeError";
  }
}

// Control characters a cell must not carry: Postgres refuses NUL in text
// (the commit failed with a 500 and took the whole batch preview with it),
// and the rest are invisible noise. Tab, LF and CR are text.
export function stripControlCharacters(value: string): string {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    : value;
}

export class LegacyExcelFileError extends ImportFileError {
  constructor() {
    super("Gamla Excel-filer (.xls) stöds inte — spara om filen som .xlsx eller CSV");
    this.name = "LegacyExcelFileError";
  }
}

export function decodeBuffer(buf: Buffer): { text: string; encoding: "utf-8" | "windows-1252" } {
  // Excel's "Unicode-text" is UTF-16 with a BOM: read as windows-1252 it put a
  // NUL between every character.
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    throw new Utf16ImportFileError();
  }
  // A UTF-8 BOM (EF BB BF) is authoritative: strip it and trust the encoding.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString("utf-8"), encoding: "utf-8" };
  }
  try {
    // fatal: true throws on invalid byte sequences instead of emitting U+FFFD
    // — that throw IS the windows-1252 detection (Excel "spara som CSV").
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(buf), encoding: "windows-1252" };
  }
}

// Counts candidate delimiters OUTSIDE quoted regions on the header line;
// most wins, ties resolve ; then , then tab (semicolon is the Swedish/
// Monitor default).
export function detectDelimiter(firstLine: string): ";" | "," | "\t" {
  const counts: Record<";" | "," | "\t", number> = { ";": 0, ",": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === ";" || ch === "," || ch === "\t")) counts[ch]++;
  }
  let best: ";" | "," | "\t" = ";";
  for (const candidate of [";", ",", "\t"] as const) {
    if (counts[candidate] > counts[best]) best = candidate;
  }
  return best;
}

export function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // "" escape
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    // A quote opens a quoted field only at the field's start (RFC 4180): a
    // quote inside an unquoted field ('Rör 2" AB') is an ordinary character —
    // it used to open quote mode and swallow the delimiters and line breaks
    // up to the next quote, shifting every row after it.
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      field = "";
      records.push(row);
      row = [];
      // CRLF counts as one line break; lone CR (old Mac) and LF also end lines.
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  // Last record without a trailing newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  // Blank lines (including the common trailing one) parse as a single empty
  // field — drop them, they carry no data. A row of nothing but delimiters is
  // kept here (the bank statement reader numbers its rows by it) and dropped
  // by the import's parseCsvBuffer.
  return records
    .filter((record) => !(record.length === 1 && record[0] === ""))
    .map((record) => record.map(stripControlCharacters));
}

export function parseCsvBuffer(buf: Buffer): ParsedCsv {
  const { text, encoding } = decodeBuffer(buf);
  const firstLineEnd = text.search(/[\r\n]/);
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = detectDelimiter(firstLine);
  // The ";;;;" rows Excel's "Spara som CSV" writes for formatted but empty
  // rows carry no data — they failed as "Kundnummer saknas" and blocked the
  // import (the xlsx path drops fully empty rows the same way).
  const records = parseRecords(text, delimiter).filter((record) => record.some((cell) => cell.trim() !== ""));
  if (records.length === 0) throw new EmptyCsvError();
  const [headers, ...rows] = records;
  if (rows.length > MAX_IMPORT_ROWS) throw new CsvRowLimitError();
  return { delimiter, encoding, headers: headers!.map((h) => h.trim()), rows };
}

// "1 234,56" -> 1234.56. Strips ordinary, non-breaking (U+00A0) and narrow
// non-breaking (U+202F) spaces — Excel and Monitor both use them as
// thousands separators. Empty/garbage -> null (the caller decides whether
// that is a row error or "leave the field unset").
export function normalizeDecimal(input: string): number | null {
  const cleaned = input.replace(/[\s  ]/g, "");
  if (cleaned === "") return null;
  let normalized = cleaned;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the LAST one is the decimal mark, the other thousands.
    normalized =
      lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (lastComma !== -1) {
    // Swedish decimal comma. Two commas ("1,2,3") survive as garbage and
    // fall out as NaN below.
    normalized = cleaned.replace(",", ".");
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

// A day cell: YYYY-MM-DD (what an Excel date cell becomes, parse-file.ts),
// also with / or . between the parts, or YYYYMMDD. null = not a date the
// system can reason about (businessDateSchema's range).
export function normalizeDay(input: string): string | null {
  const text = input.trim();
  const match = /^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})$/.exec(text);
  if (!match) return null;
  const day = `${match[1]}-${match[2]}-${match[3]}`;
  return businessDateSchema.safeParse(day).success ? day : null;
}
