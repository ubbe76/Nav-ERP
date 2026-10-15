"use client";

import { FormError, FormHint, FormNotice } from "../ui/Form";
import type { ImportFieldConfig } from "../../lib/importFields";
import { ACTION_LABELS, PREVIEW_ROW_LIMIT, REGISTER_LABELS, formatCodes, sortPreviewRows, type PreviewResponse } from "./importTypes";
import styles from "./ImportWizard.module.css";

interface PreviewTableProps {
  preview: PreviewResponse;
  /** The entity's identity field, shown per row (Artikelnummer, Kundnummer …). */
  keyField: ImportFieldConfig;
}

// The Förhandsgranska step's body: the summary line, the auto-created
// registers, the "fix the file" error and the capped row table. Shared by
// both wizards.
export function PreviewTable({ preview, keyField }: PreviewTableProps) {
  const rows = sortPreviewRows(preview.rows).slice(0, PREVIEW_ROW_LIMIT);
  const willCreateEntries = Object.entries(preview.willCreate).filter(([, codes]) => codes.length > 0);

  return (
    <>
      <p className={styles.summary}>
        <span>{preview.summary.create} nya</span>
        <span>{preview.summary.update} uppdateras</span>
        {preview.summary.skip > 0 && <span data-tone="skip">{preview.summary.skip} hoppas över</span>}
        <span data-tone="error">{preview.summary.error} fel</span>
        <span data-tone="warning">{preview.summary.warning} varningar</span>
      </p>

      {willCreateEntries.length > 0 && (
        <FormNotice>
          Skapas automatiskt:{" "}
          {willCreateEntries
            .map(([key, codes]) => `${REGISTER_LABELS[key] ?? key} (${codes.length}): ${formatCodes(codes)}`)
            .join(" · ")}
        </FormNotice>
      )}

      {preview.summary.error > 0 && (
        <FormError margin="below">
          Importen kan inte genomföras förrän raderna med fel är åtgärdade i filen. Rätta filen och börja om
          från steget Fil.
        </FormError>
      )}

      <div className={styles.previewTable}>
        <div className={styles.previewHead}>
          <span>Rad</span>
          <span>Åtgärd</span>
          <span>{keyField.label}</span>
          <span>Fel / varningar</span>
        </div>
        {rows.map((row) => (
          <div
            key={row.rowNumber}
            className={styles.previewRow}
            data-error={row.errors.length > 0}
            data-warning={row.errors.length === 0 && row.warnings.length > 0}
            data-skip={row.action === "skip"}
          >
            <span>{row.rowNumber}</span>
            <span>{ACTION_LABELS[row.action]}</span>
            <span>{String(row.values[keyField.field] ?? "")}</span>
            <span className={styles.messages}>
              {row.errors.map((message) => (
                <span key={message} className={styles.errorText}>
                  {message}
                </span>
              ))}
              {row.warnings.map((message) => (
                <span key={message} className={styles.warningText}>
                  {message}
                </span>
              ))}
              {row.skipReason && <span className={styles.skipText}>{row.skipReason}</span>}
            </span>
          </div>
        ))}
      </div>
      {preview.rows.length > PREVIEW_ROW_LIMIT && (
        <FormHint>
          Visar {PREVIEW_ROW_LIMIT} av {preview.rows.length.toLocaleString("sv-SE")} rader — rader med fel och
          varningar först.
        </FormHint>
      )}
    </>
  );
}
