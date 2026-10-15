// Excel (.xlsx) reading for the Monitor G5 import — the sibling of csv.ts.
// Unlike the CSV parser this one leans on a dependency (read-excel-file):
// an .xlsx is a zip container of OOXML parts, and hand-rolling that has a
// far worse effort/risk ratio than the CSV grammar did.
import readXlsxFile from "read-excel-file/node";
import {
  CsvRowLimitError,
  EmptyCsvError,
  MAX_IMPORT_ROWS,
  UnreadableImportFileError,
} from "./csv.js";

export type ParsedXlsx = {
  sheetName: string;
  sheetCount: number;
  headers: string[];
  rows: string[][];
};

// read-excel-file hands back typed cells; every planner downstream consumes
// string[][] and parses numbers with normalizeDecimal, so everything is
// stringified here — losslessly and locale-free.
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  // String(2.5) is "2.5" — a dot decimal, which normalizeDecimal handles.
  if (typeof value === "number") return String(value);
  // Matches the Ja/Nej/1/0/true/false vocabulary the boolean fields accept.
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export async function parseXlsxBuffer(buf: Buffer): Promise<ParsedXlsx> {
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    // One call returns every sheet with its name, so the sheet count for the
    // "only the first sheet was read" notice costs no second pass.
    sheets = (await readXlsxFile(buf)) as unknown as { sheet: string; data: unknown[][] }[];
  } catch {
    // The library's own errors are English and unhelpful to the user.
    throw new UnreadableImportFileError();
  }

  const first = sheets[0];
  if (!first) throw new EmptyCsvError();

  // Fully empty rows are dropped, matching parseRecords' blank-line handling
  // in csv.ts. Note that this shifts rowNumber away from Excel's own row
  // numbering when a file has blank rows in the middle — the same quirk the
  // CSV path already has, and the lesser evil compared with a blank spacer
  // row failing as "Artikelnummer saknas" and blocking the whole import.
  const records = first.data
    .map((row) => row.map(cellToString))
    .filter((row) => row.some((cell) => cell !== ""));

  if (records.length === 0) throw new EmptyCsvError();
  const [headers, ...rows] = records;
  if (rows.length > MAX_IMPORT_ROWS) throw new CsvRowLimitError();

  return {
    sheetName: first.sheet,
    sheetCount: sheets.length,
    // cellToString already trims; this mirrors parseCsvBuffer's explicit trim.
    headers: headers!.map((header) => header.trim()),
    rows,
  };
}
