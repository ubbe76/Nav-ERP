"use client";

import type { ConfiguratorEvaluation, ConfiguratorGroupDetail } from "../../lib/configurator";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import type { RawConfiguration } from "./selectionFromRaw";
import styles from "./TestConfigurationPanel.module.css";

function range(min: number | undefined, max: number | undefined, unit: string | null): string | null {
  if (min === undefined || max === undefined) return null;
  return `${min}–${max}${unit ? ` ${unit}` : ""}`;
}

// The group form (listval / ja-nej / mått) with per-group errors from the evaluation.
export function ConfigurationGroupFields({
  groups,
  raw,
  onChange,
  result,
  idPrefix,
}: {
  groups: ConfiguratorGroupDetail[];
  raw: RawConfiguration;
  onChange: (code: string, value: string | boolean) => void;
  result: ConfiguratorEvaluation | null;
  idPrefix: string;
}) {
  const byCode = new Map(result?.groups.map((g) => [g.code, g]));
  return (
    <div className={styles.fields}>
      {groups.map((g) => {
        const res = byCode.get(g.code);
        const id = `${idPrefix}-${g.code}`;
        const label = g.required && g.kind !== "boolean" ? `${g.name} *` : g.name;
        return (
          <div key={g.id}>
            {g.kind === "boolean" ? (
              <label className={styles.inline}>
                <Checkbox id={id} checked={raw[g.code] === true} onChange={(e) => onChange(g.code, e.target.checked)} />
                {g.name}
              </label>
            ) : g.kind === "choice" ? (
              <Field label={label} htmlFor={id}>
                <Select
                  id={id}
                  value={
                    typeof raw[g.code] === "string"
                      ? (raw[g.code] as string)
                      : res?.defaulted && typeof res.value === "string"
                        ? res.value
                        : ""
                  }
                  onChange={(e) => onChange(g.code, e.target.value)}
                >
                  <option value="">— Välj —</option>
                  {g.values
                    .filter((v) => v.active)
                    .map((v) => {
                      const unavailable = res?.availableValueCodes !== undefined && !res.availableValueCodes.includes(v.code);
                      return (
                        <option key={v.id} value={v.code} disabled={unavailable} title={unavailable ? "Utesluts av en regel" : undefined}>
                          {v.name}
                          {unavailable ? " (ej valbart)" : ""}
                        </option>
                      );
                    })}
                </Select>
              </Field>
            ) : (
              <Field label={g.unit ? `${label} (${g.unit})` : label} htmlFor={id}>
                <Input
                  id={id}
                  inputMode="decimal"
                  value={typeof raw[g.code] === "string" ? (raw[g.code] as string) : ""}
                  placeholder={res?.defaulted && res.value !== null ? String(res.value) : undefined}
                  onChange={(e) => onChange(g.code, e.target.value)}
                />
                {range(res?.min, res?.max, g.unit) && <span className={styles.key}>{range(res?.min, res?.max, g.unit)}</span>}
              </Field>
            )}
            {res && res.errors.length > 0 && (
              <ul className={styles.fieldErrors}>
                {res.errors.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
