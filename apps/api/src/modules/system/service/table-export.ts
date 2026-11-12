// Table exports in two formats (#35): the ExportTable an export describes
// once (shared csv.ts — a CsvColumn list evaluated over its rows) rendered as
// the Swedish CSV or as an Excel workbook. Pure — no DB, no clock.
//
// The workbook is one sheet: a bold, frozen header row, column widths after
// the content (bounded), numbers as numbers, dates as dates, and the same
// values the CSV prints (exportCell). Text is written as typed — an inline
// string is never evaluated, so the CSV's formula guard is not applied.
import { exportCell, tableCsv, type ExportCell, type ExportTable } from "@navet/shared";
import { writeXlsx, type XlsxAnyCell } from "./xlsx-writer.js";

export type ExportFormat = "csv" | "xlsx";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["csv", "xlsx"];

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

const MIN_COLUMN_WIDTH = 8;
const MAX_COLUMN_WIDTH = 60;

// How wide the cell is shown, in characters: the text itself, a number as
// Excel prints it (money with two decimals and thousands grouping), a date
// as yyyy-mm-dd (hh:mm).
function shownLength(cell: ExportCell | null): number {
  if (cell === null) return 0;
  switch (cell.type) {
    case "text":
      return Math.max(...cell.text.split("\n").map((line) => line.length));
    case "number": {
      if (!cell.money) return String(cell.number).length;
      const fixed = cell.number.toFixed(2);
      return fixed.length + Math.floor((fixed.replace("-", "").length - 4) / 3);
    }
    case "date":
      return 10;
    case "datetime":
      return 16;
  }
}

function toXlsxCell(cell: ExportCell | null): XlsxAnyCell | null {
  if (cell === null) return null;
  switch (cell.type) {
    case "text":
      return { value: cell.text };
    case "number":
      return { number: cell.number, format: cell.money ? "money" : "general" };
    case "date":
      return { date: cell.date };
    case "datetime":
      return { dateTime: cell.dateTime };
  }
}

export function tableXlsx(table: ExportTable, sheetName = "Export"): Buffer {
  const cells = table.rows.map((row) => table.columns.map((column, i) => exportCell(column, row[i])));
  const columnWidths = table.columns.map((column, i) => {
    // The header is bold — a little wider than its character count.
    let width = Math.ceil(column.label.length * 1.1);
    for (const row of cells) width = Math.max(width, shownLength(row[i] ?? null));
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width + 2));
  });
  return writeXlsx({
    sheets: [
      {
        name: sheetName,
        freezeHeader: true,
        columnWidths,
        rows: [table.columns.map((column) => ({ value: column.label, bold: true })), ...cells.map((row) => row.map(toXlsxCell))],
      },
    ],
  });
}

// A table with its file name WITHOUT extension ("artiklar-2026-11-12") —
// what a service hands a route that serves both formats.
export interface NamedTable {
  basename: string;
  table: ExportTable;
}

export function csvFile({ basename, table }: NamedTable): { filename: string; content: string } {
  return { filename: `${basename}.csv`, content: tableCsv(table) };
}

export function xlsxFile({ basename, table }: NamedTable): { filename: string; content: Buffer } {
  return { filename: `${basename}.xlsx`, content: tableXlsx(table) };
}

export interface RenderedExport {
  filename: string;
  content: string | Buffer;
  contentType: string;
}

export function renderExport(table: ExportTable, basename: string, format: ExportFormat): RenderedExport {
  return format === "xlsx"
    ? { ...xlsxFile({ basename, table }), contentType: XLSX_CONTENT_TYPE }
    : { ...csvFile({ basename, table }), contentType: CSV_CONTENT_TYPE };
}

// "/articles/csv" → "/articles/xlsx": the Excel twin's path. Only a path
// whose last segment is "csv" has one.
export function xlsxTwinPath(csvPath: string): string {
  if (!csvPath.endsWith("/csv")) throw new Error(`Not a CSV export path: ${csvPath}`);
  return `${csvPath.slice(0, -"csv".length)}xlsx`;
}
