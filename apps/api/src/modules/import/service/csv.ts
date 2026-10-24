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

export class LegacyExcelFileError extends ImportFileError {
  constructor() {
    super("Gamla Excel-filer (.xls) stöds inte — spara om filen som .xlsx eller CSV");
    this.name = "LegacyExcelFileError";
  }
}

export function decodeBuffer(buf: Buffer): { text: string; encoding: "utf-8" | "windows-1252" } {
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
    if (ch === '"') {
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
  // field — drop them, they carry no data.
  return records.filter((record) => !(record.length === 1 && record[0] === ""));
}

export function parseCsvBuffer(buf: Buffer): ParsedCsv {
  const { text, encoding } = decodeBuffer(buf);
  const firstLineEnd = text.search(/[\r\n]/);
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const delimiter = detectDelimiter(firstLine);
  const records = parseRecords(text, delimiter);
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
