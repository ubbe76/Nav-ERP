// Generic CSV serialization (F2) — the one authority for Excel-friendly
// Swedish CSV: `;` separator (Excel's list separator in a Swedish locale,
// where `,` is the decimal mark), CRLF newlines, a UTF-8 BOM so Excel
// detects the encoding instead of mangling åäö, and RFC 4180 quoting only
// when a value would otherwise break the row. Same conventions as payroll's
// buildPayrollCsv, generalized to arbitrary column definitions.

// What a column's cells are in a spreadsheet (#35). The CSV text never
// depends on it — it only decides the Excel cell:
//   text     — a string as written (no formula guard: an inline string is
//              never evaluated)
//   number   — a real number, rounded like the CSV's "number" (4 decimals)
//   money    — a real number with two decimals
//   percent  — a real number, the percentage AS SHOWN (95,5 under a "%"
//              heading, not the fraction 0,955), rounded like "number"
//   date     — an Excel date shown as yyyy-mm-dd
//   datetime — an Excel date-time shown as yyyy-mm-dd hh:mm, Stockholm time
export type ExportCellType = "text" | "number" | "money" | "percent" | "date" | "datetime";

export interface CsvColumn<T> {
  label: string; // Swedish header, matching the list page's column header
  value: (row: T) => string | number | null | undefined;
  // The Excel cell type, when it is not the one `format` implies (money →
  // money, number → number, date → date, datetime → datetime; no format or
  // "text" → number for a JS number, otherwise text). Set it to "text" for
  // a numeric identifier that must not become a number, or to "percent".
  cell?: ExportCellType;
  // How the raw value is rendered: money = 2 decimals, number = up to 4
  // decimals with trailing zeros trimmed (both with a decimal COMMA and no
  // thousands separator — spaces break Excel's number parsing), date =
  // YYYY-MM-DD passthrough, datetime = YYYY-MM-DD HH:mm in Europe/Stockholm.
  format?: "text" | "money" | "number" | "date" | "datetime";
}

// Exports refuse (400) rather than silently truncate beyond this.
export const CSV_EXPORT_MAX_ROWS = 10_000;

// The primitives are exported so bespoke builders (payroll's buildPayrollCsv)
// share ONE authority for the conventions instead of drifting copies.
export const CSV_SEPARATOR = ";";
export const CSV_NEWLINE = "\r\n";
export const CSV_BOM = "﻿";

// RFC 4180 quoting — only when the value would otherwise break the row.
export function csvCell(value: string): string {
  if (!/[;"\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

const SEPARATOR = CSV_SEPARATOR;
const NEWLINE = CSV_NEWLINE;
const BOM = CSV_BOM;

const stockholmDateTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

// OWASP CSV-injection guard: free-text cells starting with a formula trigger
// get an apostrophe prefix so Excel renders them as text instead of executing
// them. Only user-entered text needs this — our own numeric/date renderings
// are trusted (and a prefixed "-12,50" would break number parsing).
export function guardFormulaInjection(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// The way back for an import that reads our own export: drops the guard's
// apostrophe again (only in front of a trigger character, so a value that
// really starts with an apostrophe is left alone).
export function unguardFormulaInjection(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

// The "number" rendering on its own, for a cell that puts numbers in a text
// (the lagerplatsregister's "35,5 kg · 120 st"): up to 4 decimals, trailing
// zeros trimmed, decimal comma, no thousands separator.
export function formatCsvNumber(raw: string | number): string {
  return String(Number(Number(raw).toFixed(4))).replace(".", ",");
}

function formatValue(raw: string | number | null | undefined, format: CsvColumn<never>["format"]): string {
  if (raw === null || raw === undefined || raw === "") return "";
  switch (format) {
    case "money":
      return Number(raw).toFixed(2).replace(".", ",");
    case "number":
      return formatCsvNumber(raw);
    case "datetime":
      // sv-SE formats as "YYYY-MM-DD HH:mm"; the char between date and time
      // is a regular space with this format set.
      return stockholmDateTime.format(new Date(raw)).replace(",", "");
    case "date":
      return String(raw);
    case "text":
    default:
      return guardFormulaInjection(String(raw));
  }
}

// --- ONE table, two renderings (#35) ------------------------------------------
//
// An export is described once — a CsvColumn list and its rows — and
// evaluated once into an ExportTable: the labels and every cell's RAW value.
// tableCsv renders that as the CSV, exportCell gives the typed cell the
// Excel writer needs (apps/api system/service/table-export.ts). buildCsv is
// tableCsv over exportTable, so there is no second column list and no second
// rounding rule.

export type ExportRawValue = string | number | null | undefined;

export interface ExportTableColumn {
  label: string;
  format?: CsvColumn<never>["format"];
  cell?: ExportCellType;
}

export interface ExportTable {
  columns: ExportTableColumn[];
  rows: ExportRawValue[][];
}

export function exportTable<T>(columns: CsvColumn<T>[], rows: T[]): ExportTable {
  return {
    columns: columns.map(({ label, format, cell }) => ({ label, format, cell })),
    rows: rows.map((row) => columns.map((c) => c.value(row))),
  };
}

export function tableCsv(table: ExportTable): string {
  const header = table.columns.map((c) => csvCell(c.label)).join(SEPARATOR);
  const body = table.rows.map((row) =>
    table.columns.map((c, i) => csvCell(formatValue(row[i], c.format))).join(SEPARATOR)
  );
  return BOM + [header, ...body].join(NEWLINE) + NEWLINE;
}

export function buildCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  return tableCsv(exportTable(columns, rows));
}

// A typed cell: what a spreadsheet writer puts in the cell. null = empty.
export type ExportCell =
  | { type: "text"; text: string }
  | { type: "number"; number: number; money: boolean }
  | { type: "date"; date: string } // YYYY-MM-DD
  | { type: "datetime"; dateTime: string }; // YYYY-MM-DD HH:mm, Stockholm wall clock

export function exportCellType(column: ExportTableColumn, raw: ExportRawValue): ExportCellType {
  if (column.cell) return column.cell;
  switch (column.format) {
    case "money":
    case "number":
    case "date":
    case "datetime":
      return column.format;
    default:
      return typeof raw === "number" ? "number" : "text";
  }
}

// The same values as the CSV: money is the two-decimal number the CSV
// prints, number/percent the four-decimal one, a date the same YYYY-MM-DD
// day, a date-time the same Stockholm reading. A value that does not fit its
// type (a non-numeric text in a number column, a date that is not a day) is
// written as the text it is, never as a wrong number or date.
export function exportCell(column: ExportTableColumn, raw: ExportRawValue): ExportCell | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const asText = (): ExportCell => ({ type: "text", text: String(raw) });
  switch (exportCellType(column, raw)) {
    case "money": {
      const n = Number(raw);
      return Number.isFinite(n) ? { type: "number", number: Number(n.toFixed(2)), money: true } : asText();
    }
    case "number":
    case "percent": {
      const n = typeof raw === "string" ? Number(raw.trim().replace(",", ".")) : Number(raw);
      if (!Number.isFinite(n) || (typeof raw === "string" && raw.trim() === "")) return asText();
      return { type: "number", number: Number(n.toFixed(4)), money: false };
    }
    case "date": {
      const text = String(raw);
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { type: "date", date: text } : asText();
    }
    case "datetime": {
      const instant = new Date(raw);
      if (Number.isNaN(instant.getTime())) return asText();
      return { type: "datetime", dateTime: stockholmDateTime.format(instant).replace(",", "") };
    }
    case "text":
    default:
      return asText();
  }
}
