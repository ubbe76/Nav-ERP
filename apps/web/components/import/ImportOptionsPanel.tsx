"use client";

import { Field, Select } from "../ui/Field";
import { FormHint } from "../ui/Form";
import { DEFAULT_SELECTS } from "./importTypes";
import styles from "./ImportWizard.module.css";

// An extra per-entity checkbox in the Kolumner step, sent as a top-level field
// in the request body. Kept generic because every entity shares this panel.
export interface ImportOptionConfig {
  /** The request-body field name, e.g. "createMissingArticles". */
  key: string;
  label: string;
  hint: string;
  /** Keys in `defaults` that are only relevant while this option is ticked. */
  revealsDefaults?: string[];
  /**
   * Renders the checkbox pre-ticked — for an option whose API default is
   * `true` when the field is omitted (e.g. setAsDefault on the delivery
   * address import), so the box matches what actually happens when the
   * user never touches it. Unticking it still sends an explicit `false`.
   */
  defaultChecked?: boolean;
  /**
   * The option cannot be combined with "Hoppa över rader som redan finns"
   * (the API answers 400 for both): ticking either one unticks the other.
   * Used by the routing import's "Uppdatera befintliga operationer".
   */
  exclusiveWithSkipExisting?: boolean;
}

export interface ImportOptionsState {
  defaultValues: Record<string, string>;
  skipExisting: boolean;
  optionValues: Record<string, boolean>;
}

interface ImportOptionsPanelProps {
  state: ImportOptionsState;
  onChange: (next: ImportOptionsState) => void;
  skipExistingHint?: string;
  extraOptions?: ImportOptionConfig[];
  /** Prefix for the select ids so several panels can sit on one page. */
  idPrefix?: string;
}

// The pre-ticked values every option starts with (see defaultChecked).
export function initialOptionValues(extraOptions: ImportOptionConfig[] | undefined): Record<string, boolean> {
  return Object.fromEntries((extraOptions ?? []).map((option) => [option.key, option.defaultChecked ?? false]));
}

// A default that only matters while its option is ticked (Standardtyp on the
// structure import) is neither shown nor sent while it is not — otherwise a
// value the user never saw would ride along in the request.
export function visibleDefaultValues(
  state: ImportOptionsState,
  extraOptions: ImportOptionConfig[] | undefined
): Record<string, string> {
  const hidden = new Set(
    (extraOptions ?? [])
      .filter((option) => !state.optionValues[option.key])
      .flatMap((option) => option.revealsDefaults ?? [])
  );
  return Object.fromEntries(Object.entries(state.defaultValues).filter(([key]) => !hidden.has(key)));
}

// The request-body fields the options contribute — shared by both wizards so
// they can never send different shapes.
export function optionsRequestFields(
  state: ImportOptionsState,
  extraOptions: ImportOptionConfig[] | undefined
): Record<string, unknown> {
  const defaults = visibleDefaultValues(state, extraOptions);
  return {
    defaults: Object.keys(defaults).length > 0 ? defaults : undefined,
    skipExisting: state.skipExisting,
    ...state.optionValues,
  };
}

// The Kolumner step's options: the entity's default selects, "Hoppa över
// rader som redan finns" and the entity's extra checkboxes.
export function ImportOptionsPanel({ state, onChange, skipExistingHint, extraOptions, idPrefix = "" }: ImportOptionsPanelProps) {
  const defaults = visibleDefaultValues(state, extraOptions);

  function setSkipExisting(checked: boolean) {
    const optionValues = { ...state.optionValues };
    if (checked) {
      // Mutually exclusive options give way — see exclusiveWithSkipExisting.
      for (const option of extraOptions ?? []) {
        if (option.exclusiveWithSkipExisting) optionValues[option.key] = false;
      }
    }
    onChange({ ...state, skipExisting: checked, optionValues });
  }

  function setOption(option: ImportOptionConfig, checked: boolean) {
    onChange({
      ...state,
      skipExisting: checked && option.exclusiveWithSkipExisting ? false : state.skipExisting,
      optionValues: { ...state.optionValues, [option.key]: checked },
    });
  }

  return (
    <>
      {Object.entries(defaults).map(([key, value]) => {
        const config = DEFAULT_SELECTS[key];
        if (!config) return null;
        return (
          <div key={key} className={styles.defaultsRow}>
            <Field label={config.label} htmlFor={`${idPrefix}default-${key}`}>
              <Select
                id={`${idPrefix}default-${key}`}
                value={value}
                onChange={(e) => onChange({ ...state, defaultValues: { ...state.defaultValues, [key]: e.target.value } })}
              >
                {config.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <FormHint attached>{config.hint}</FormHint>
          </div>
        );
      })}

      <div className={styles.optionRow}>
        <label className={styles.checkbox}>
          <input type="checkbox" checked={state.skipExisting} onChange={(e) => setSkipExisting(e.target.checked)} />
          Hoppa över rader som redan finns
        </label>
        <FormHint attached>
          {skipExistingHint ??
            "Rader vars post redan finns rörs inte alls. De listas som överhoppade i resultatet och avbryter inte importen."}
        </FormHint>
      </div>

      {(extraOptions ?? []).map((option) => (
        <div key={option.key} className={styles.optionRow}>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={state.optionValues[option.key] ?? false}
              onChange={(e) => setOption(option, e.target.checked)}
            />
            {option.label}
          </label>
          <FormHint attached>{option.hint}</FormHint>
        </div>
      ))}
    </>
  );
}
