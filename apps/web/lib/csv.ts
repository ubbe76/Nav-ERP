// Client-side CSV serialization for lists that only exist in the browser —
// today the import wizard's list of skipped rows, which is never persisted
// and therefore has no endpoint to download from.
//
// MIRROR of the text path in packages/shared/src/csv.ts. The web app cannot
// import @navet/shared (Turbopack vs .js-suffix imports), the same reason
// apps/web/lib/units.ts and importFields.ts are hand-synced — so keep the
// conventions here identical to the server's: `;` separator (Excel's list
// separator in a Swedish locale, where `,` is the decimal mark), CRLF
// newlines, a UTF-8 BOM so Excel detects the encoding instead of mangling
// åäö, and RFC 4180 quoting only when a value would otherwise break the row.
// The number/date formats are deliberately absent: everything the wizard
// exports is raw text straight out of the imported file.

const SEPARATOR = ";";
const NEWLINE = "\r\n";
const BOM = "﻿";

// RFC 4180 quoting — only when the value would otherwise break the row.
export function csvCell(value: string): string {
  if (!/[;"\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

// OWASP CSV-injection guard: free-text cells starting with a formula trigger
// get an apostrophe prefix so Excel renders them as text instead of executing
// them. Everything exported here is user-supplied text, so every cell passes
// through it.
export function guardFormulaInjection(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function buildCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((cells) =>
    cells.map((cell) => csvCell(guardFormulaInjection(cell))).join(SEPARATOR)
  );
  return BOM + lines.join(NEWLINE) + NEWLINE;
}

// Hands the browser a generated file. The artifact only exists in memory, so
// this is the one place in the app that builds a download instead of pointing
// an <a download> at an API endpoint.
export function downloadTextFile(fileName: string, contents: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
