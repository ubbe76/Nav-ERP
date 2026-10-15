"use client";

import { Button } from "../ui/Button";
import { Table } from "../ui/Table";
import { FormActions, FormHint } from "../ui/Form";
import { buildCsv, downloadTextFile } from "../../lib/csv";
import type { ImportFieldConfig } from "../../lib/importFields";
import {
  ENTITY_FILE_STEMS,
  PREVIEW_ROW_LIMIT,
  REGISTER_LABELS,
  escapeHtml,
  formatCodes,
  type CommitResponse,
} from "./importTypes";
import styles from "./ImportWizard.module.css";

interface ResultSummaryProps {
  entity: string;
  title: string;
  fields: ImportFieldConfig[];
  mapping: Record<string, string | null>;
  result: CommitResponse;
  /** Popup-blocked printouts are reported here (the wizard's error slot). */
  onError: (message: string) => void;
  /** Skip the "Importen är klar." headline (the multi-file wizard has one per file). */
  compact?: boolean;
}

// The Resultat step's body: the counts, the auto-created registers and the
// skipped-rows table with Spara som fil / Skriv ut. Shared by both wizards.
export function ResultSummary({ entity, title, fields, mapping, result, onError, compact = false }: ResultSummaryProps) {
  // Which of the entity's fields the skipped list shows. The saved file gets
  // every MAPPED field (so it can be corrected and re-imported); the screen
  // and the printout get only the identifying required ones — the customer
  // import maps fourteen columns, which no A4 page holds.
  function skippedColumns(full: boolean): { field: string; label: string }[] {
    const names = full
      ? Object.values(mapping).filter((field): field is string => field !== null)
      : fields.filter((field) => field.required).map((field) => field.field);
    return names.map((field) => ({
      field,
      label: fields.find((f) => f.field === field)?.label ?? field,
    }));
  }

  // The same list as a plain string matrix, for the CSV and the printout.
  function skippedMatrix(full: boolean): { headers: string[]; rows: string[][] } {
    const columns = skippedColumns(full);
    return {
      headers: ["Rad", ...columns.map((column) => column.label), "Orsak"],
      rows: result.skippedRows.map((row) => [
        String(row.rowNumber),
        ...columns.map((column) => String(row.values[column.field] ?? "")),
        row.reason,
      ]),
    };
  }

  function saveSkipped() {
    const { headers, rows } = skippedMatrix(true);
    const stem = ENTITY_FILE_STEMS[entity] ?? entity;
    // Local date, not toISOString — a late-evening export must not be stamped
    // with tomorrow's date.
    const stamp = new Date().toLocaleDateString("sv-SE");
    downloadTextFile(`overhoppade-${stem}-${stamp}.csv`, buildCsv(headers, rows), "text/csv;charset=utf-8");
  }

  function printSkipped() {
    const { headers, rows } = skippedMatrix(false);
    // A separate window rather than a print stylesheet: the wizard sits inside
    // the app shell (sidebar, topbar, theme toggle), and the printout should
    // be the list alone — uncapped, unlike the table on screen.
    const win = window.open("", "_blank");
    if (!win) {
      onError("Utskriften blockerades av webbläsaren — tillåt popup-fönster för den här sidan.");
      return;
    }
    const heading = `${title} — överhoppade rader`;
    win.document.write(`<!doctype html><html lang="sv"><head><meta charset="utf-8">
<title>${escapeHtml(heading)}</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; font-size: 11pt; margin: 24px; color: #000; }
  h1 { font-size: 14pt; margin: 0 0 4px; }
  p { margin: 0 0 16px; color: #444; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  @page { size: A4; margin: 15mm; }
</style></head><body>
<h1>${escapeHtml(heading)}</h1>
<p>${rows.length} rader · ${escapeHtml(new Date().toLocaleString("sv-SE"))}</p>
<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
<tbody>${rows
      .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>
</body></html>`);
    win.document.close();
    win.focus();
    win.print();
  }

  // The on-screen list reuses the shared Table (mobile stacking included).
  const skippedTableColumns = [
    { key: "rowNumber", label: "Rad", width: "70px" },
    ...skippedColumns(false).map((column) => ({
      key: column.field,
      label: column.label,
      width: "minmax(110px, 1fr)",
    })),
    { key: "reason", label: "Orsak", width: "minmax(220px, 2fr)" },
  ];
  const skippedTableRows = result.skippedRows
    .slice(0, PREVIEW_ROW_LIMIT)
    .map((row) => ({ ...row, id: String(row.rowNumber) }));

  return (
    <>
      {!compact && <p className={styles.resultHeadline}>Importen är klar.</p>}
      <p>
        {result.created.toLocaleString("sv-SE")} skapade · {result.updated.toLocaleString("sv-SE")} uppdaterade ·{" "}
        {result.skipped.toLocaleString("sv-SE")} överhoppade
      </p>
      {Object.entries(result.registersCreated)
        .filter(([, codes]) => codes.length > 0)
        .map(([key, codes]) => (
          <p key={key}>
            {REGISTER_LABELS[key] ?? key} som skapades ({codes.length.toLocaleString("sv-SE")}): {formatCodes(codes)}
          </p>
        ))}

      {result.skipped > 0 && (
        <>
          <h2 className={styles.skippedHeadline}>Överhoppade rader</h2>
          <Table
            columns={skippedTableColumns}
            rows={skippedTableRows}
            renderCell={(row, columnKey) => {
              if (columnKey === "rowNumber") return row.rowNumber;
              if (columnKey === "reason") return row.reason;
              return String(row.values[columnKey] ?? "");
            }}
          />
          {result.skippedRows.length > PREVIEW_ROW_LIMIT && (
            <FormHint>
              Visar {PREVIEW_ROW_LIMIT} av {result.skippedRows.length.toLocaleString("sv-SE")} rader — hela listan
              följer med när du sparar eller skriver ut den.
            </FormHint>
          )}
          <FormActions>
            <Button type="button" variant="secondary" onClick={saveSkipped}>
              Spara som fil
            </Button>
            <Button type="button" variant="secondary" onClick={printSkipped}>
              Skriv ut
            </Button>
          </FormActions>
        </>
      )}
    </>
  );
}
