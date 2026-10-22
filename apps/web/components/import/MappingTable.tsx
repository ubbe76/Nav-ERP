"use client";

import { useEffect, useId, useState } from "react";
import { Select } from "../ui/Field";
import { FormHint } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import type { ImportFieldConfig } from "../../lib/importFields";
import type { ParseResponse } from "./importTypes";
import styles from "./ImportWizard.module.css";

interface FieldHelp {
  field: string;
  description: string;
}

// One fetch per entity per page load; a failed fetch is forgotten so the next
// mount retries, and the table works without help meanwhile.
const helpCache = new Map<string, Promise<Record<string, string>>>();

function loadFieldHelp(entity: string): Promise<Record<string, string>> {
  let promise = helpCache.get(entity);
  if (!promise) {
    promise = apiFetch<FieldHelp[]>(`/api/v1/imports/${entity}/fields`)
      .then((rows) => Object.fromEntries(rows.map((r) => [r.field, r.description])))
      .catch(() => {
        helpCache.delete(entity);
        return {};
      });
    helpCache.set(entity, promise);
  }
  return promise;
}

interface MappingTableProps {
  /** The import entity — its field explanations are fetched for the help text. */
  entity: string;
  parsed: ParseResponse;
  fields: ImportFieldConfig[];
  mapping: Record<string, string | null>;
  onChange: (header: string, field: string | null) => void;
  /** Hide the "N rader inlästa …" intro (the multi-file wizard has its own). */
  compact?: boolean;
}

// The Kolumner step's mapping grid: one Select per column in the file, with
// the first data row as a sample. Shared by both wizards.
export function MappingTable({ entity, parsed, fields, mapping, onChange, compact = false }: MappingTableProps) {
  const [help, setHelp] = useState<Record<string, string>>({});
  // Explanations default to on for desktop and off on a phone, where they
  // would make the table very long.
  const [showHelp, setShowHelp] = useState(true);
  // Prefix for the help texts' ids, so each Select can point at its own.
  const helpIdPrefix = useId();

  useEffect(() => {
    let cancelled = false;
    void loadFieldHelp(entity).then((h) => {
      if (!cancelled) setHelp(h);
    });
    return () => {
      cancelled = true;
    };
  }, [entity]);

  useEffect(() => {
    if (window.matchMedia("(max-width: 640px)").matches) setShowHelp(false);
  }, []);

  const hasHelp = Object.keys(help).length > 0;

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
      {hasHelp && (
        <label className={styles.checkbox}>
          <input type="checkbox" checked={showHelp} onChange={(e) => setShowHelp(e.target.checked)} />
          Visa förklaringar
        </label>
      )}
      <div className={styles.mappingTable}>
        <div className={styles.mappingHead}>
          <span>Kolumn i filen</span>
          <span>Exempel (rad 1)</span>
          <span>Importeras som</span>
        </div>
        {parsed.headers.map((header, index) => {
          const helpText = showHelp && mapping[header] ? help[mapping[header]!] : undefined;
          const helpId = `${helpIdPrefix}-help-${index}`;
          return (
            <div key={header} className={styles.mappingRow}>
              <span className={styles.mappingHeader}>{header}</span>
              <span className={styles.mappingSample}>{parsed.rows[0]?.[index] ?? ""}</span>
              <Select
                aria-label={`Mappning för kolumnen ${header}`}
                aria-describedby={helpText ? helpId : undefined}
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
              {helpText && (
                <span id={helpId} className={styles.mappingHelp}>
                  {helpText}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
