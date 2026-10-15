"use client";

import { Select } from "../ui/Field";
import { FormHint } from "../ui/Form";
import type { ImportFieldConfig } from "../../lib/importFields";
import type { ParseResponse } from "./importTypes";
import styles from "./ImportWizard.module.css";

interface MappingTableProps {
  parsed: ParseResponse;
  fields: ImportFieldConfig[];
  mapping: Record<string, string | null>;
  onChange: (header: string, field: string | null) => void;
  /** Hide the "N rader inlästa …" intro (the multi-file wizard has its own). */
  compact?: boolean;
}

// The Kolumner step's mapping grid: one Select per column in the file, with
// the first data row as a sample. Shared by both wizards.
export function MappingTable({ parsed, fields, mapping, onChange, compact = false }: MappingTableProps) {
  return (
    <>
      {!compact && (
        <p>
          {parsed.meta.rowCount.toLocaleString("sv-SE")} rader inlästa
          {parsed.meta.sheetName ? ` från bladet ”${parsed.meta.sheetName}”` : ""}. Välj vilket fält varje
          kolumn ska importeras som — kolumner med <strong>Importera inte</strong> hoppas över. Fält märkta *
          måste mappas.
        </p>
      )}
      {parsed.meta.sheetCount !== null && parsed.meta.sheetCount > 1 && (
        <FormHint>
          Arbetsboken har {parsed.meta.sheetCount} blad — bara ”{parsed.meta.sheetName}” lästes in.
        </FormHint>
      )}
      <div className={styles.mappingTable}>
        <div className={styles.mappingHead}>
          <span>Kolumn i filen</span>
          <span>Exempel (rad 1)</span>
          <span>Importeras som</span>
        </div>
        {parsed.headers.map((header, index) => (
          <div key={header} className={styles.mappingRow}>
            <span className={styles.mappingHeader}>{header}</span>
            <span className={styles.mappingSample}>{parsed.rows[0]?.[index] ?? ""}</span>
            <Select
              aria-label={`Mappning för kolumnen ${header}`}
              value={mapping[header] ?? ""}
              onChange={(e) => onChange(header, e.target.value === "" ? null : e.target.value)}
            >
              <option value="">Importera inte</option>
              {fields.map((f) => (
                <option key={f.field} value={f.field}>
                  {f.label}
                  {f.required ? " *" : ""}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>
    </>
  );
}
