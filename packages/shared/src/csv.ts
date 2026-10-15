// Generic CSV serialization (F2) — the one authority for Excel-friendly
// Swedish CSV: `;` separator (Excel's list separator in a Swedish locale,
// where `,` is the decimal mark), CRLF newlines, a UTF-8 BOM so Excel
// detects the encoding instead of mangling åäö, and RFC 4180 quoting only
// when a value would otherwise break the row. Same conventions as payroll's
// buildPayrollCsv, generalized to arbitrary column definitions.

export interface CsvColumn<T> {
  label: string; // Swedish header, matching the list page's column header
  value: (row: T) => string | number | null | undefined;
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

function formatValue(raw: string | number | null | undefined, format: CsvColumn<never>["format"]): string {
  if (raw === null || raw === undefined || raw === "") return "";
  switch (format) {
    case "money":
      return Number(raw).toFixed(2).replace(".", ",");
    case "number": {
      const trimmed = String(Number(Number(raw).toFixed(4)));
      return trimmed.replace(".", ",");
    }
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

export function buildCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const header = columns.map((c) => csvCell(c.label)).join(SEPARATOR);
  const body = rows.map((row) =>
    columns.map((c) => csvCell(formatValue(c.value(row), c.format))).join(SEPARATOR)
  );
  return BOM + [header, ...body].join(NEWLINE) + NEWLINE;
}
