// Reads a workbook the export wrote back through the import's own reader
// (read-excel-file) and compares it with the CSV of the same export: the
// Excel twin must carry the same rows and the same values, only typed.
import readXlsxFile from "read-excel-file/node";
import { expect } from "vitest";
import { unguardFormulaInjection } from "@navet/shared";
import { parseCsvBuffer } from "../../src/modules/import/service/csv.js";

export type XlsxValue = string | number | boolean | Date | null;

// The first sheet's rows, header first, with the reader's typed values: a
// number cell is a number, a date cell a Date (its UTC parts are the
// calendar day / wall clock the cell shows), text a string, empty null.
export async function readXlsxRows(workbook: Buffer): Promise<XlsxValue[][]> {
  const sheets = (await readXlsxFile(workbook)) as unknown as { sheet: string; data: XlsxValue[][] }[];
  return sheets[0]?.data ?? [];
}

const pad = (n: number) => String(n).padStart(2, "0");

// A cell as the CSV prints it — numbers are compared as numbers instead.
function shownAsCsv(value: XlsxValue): string {
  if (value === null) return "";
  if (value instanceof Date) {
    // A time of day is a binary fraction of a day — the reader can land a
    // millisecond short of the minute Excel shows; round to the second.
    value = new Date(Math.round(value.getTime() / 1000) * 1000);
    const day = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    const midnight = value.getUTCHours() === 0 && value.getUTCMinutes() === 0;
    return midnight ? day : `${day} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
  }
  return String(value);
}

// Same header, same number of rows, and every cell the same value as the
// CSV's: a number cell equals the CSV's decimal-comma number, a date cell
// its YYYY-MM-DD (HH:mm), a text cell the CSV text without the formula
// guard. Returns the workbook rows for further assertions.
export async function expectXlsxMatchesCsv(workbook: Buffer, csv: string): Promise<XlsxValue[][]> {
  const rows = await readXlsxRows(workbook);
  const parsed = parseCsvBuffer(Buffer.from(csv, "utf8"));
  const csvRows = [parsed.headers, ...parsed.rows];
  expect(rows.length).toBe(csvRows.length);
  rows.forEach((row, r) => {
    const csvRow = csvRows[r]!;
    csvRow.forEach((text, c) => {
      const value = row[c] ?? null;
      const where = `row ${r + 1}, column ${c + 1}`;
      if (typeof value === "number") {
        expect(value, where).toBe(Number(text.replace(",", ".")));
      } else {
        expect(shownAsCsv(value), where).toBe(unguardFormulaInjection(text).trim());
      }
    });
  });
  return rows;
}
