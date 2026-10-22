"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { FormActions, FormError } from "../ui/Form";
import { API_URL, ApiError, apiFetch } from "../../lib/api";
import type { ImportFieldConfig } from "../../lib/importFields";
import buttonStyles from "../ui/Button.module.css";
import styles from "./ImportWizard.module.css";
import { MappingTable } from "./MappingTable";
import { IMPORT_TEMPLATE_FILES } from "../../lib/importEntities";
import {
  ImportOptionsPanel,
  initialOptionValues,
  optionsRequestFields,
  type ImportOptionConfig,
  type ImportOptionsState,
} from "./ImportOptionsPanel";
import { PreviewTable } from "./PreviewTable";
import { ResultSummary } from "./ResultSummary";
import {
  buildInitialMapping,
  isPreviewResponse,
  validateMapping,
  type CommitResponse,
  type ParseResponse,
  type PreviewResponse,
} from "./importTypes";

export type { ImportOptionConfig } from "./ImportOptionsPanel";

const STEPS = ["Fil", "Kolumner", "Förhandsgranska", "Resultat"] as const;
type Step = (typeof STEPS)[number];

export interface ImportWizardProps {
  entity: string;
  title: string;
  fields: ImportFieldConfig[];
  backHref: string;
  defaults?: Record<string, string>;
  // What "Hoppa över rader som redan finns" means for this entity — the
  // register imports leave the record unchanged, the create-only imports stop
  // treating it as an error. Falls back to a generic wording.
  skipExistingHint?: string;
  extraOptions?: ImportOptionConfig[];
}

// The single-file, single-entity wizard: Fil → Kolumner → Förhandsgranska →
// Resultat. Its step bodies are the shared MappingTable / ImportOptionsPanel /
// PreviewTable / ResultSummary components, which MultiFileImportWizard
// composes the same way for many files at once.
export function ImportWizard({
  entity,
  title,
  fields,
  backHref,
  defaults,
  skipExistingHint,
  extraOptions,
}: ImportWizardProps) {
  const [step, setStep] = useState<Step>("Fil");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [parsed, setParsed] = useState<ParseResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  // Pre-fill from each option's defaultChecked so the checkbox's visual
  // state and the value actually sent agree from the first render — without
  // this, an option whose API default is true (setAsDefault) would render
  // unticked until the user touched it.
  const [options, setOptions] = useState<ImportOptionsState>(() => ({
    defaultValues: defaults ?? {},
    skipExisting: false,
    optionValues: initialOptionValues(extraOptions),
  }));
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [result, setResult] = useState<CommitResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // The wizard's identity field: shown per preview row (Artikelnummer for
  // articles, Kundnummer/Leverantörsnummer for the later entities).
  const keyField = fields.find((f) => f.required) ?? fields[0]!;

  async function upload(file: File) {
    setError(null);
    setPending(true);
    try {
      const body = new FormData();
      body.append("file", file);
      // Multipart upload — apiFetch sets a JSON content type, so this one
      // goes through fetch directly (same as the article file upload).
      const res = await fetch(`${API_URL}/api/v1/imports/${entity}/parse`, {
        method: "POST",
        credentials: "include",
        body,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? "Filen kunde inte läsas");
      }
      const data: ParseResponse = await res.json();
      setParsed(data);
      setMapping(buildInitialMapping(data.headers, data.suggestedMapping));
      setPreview(null);
      setResult(null);
      setStep("Kolumner");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Filen kunde inte läsas");
    } finally {
      setPending(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function requestBody(): string {
    return JSON.stringify({
      mapping,
      rows: parsed?.rows ?? [],
      ...optionsRequestFields(options, extraOptions),
    });
  }

  async function runPreview() {
    const mappingError = validateMapping(mapping, fields);
    if (mappingError) {
      setError(mappingError);
      return;
    }
    setError(null);
    setPending(true);
    try {
      setPreview(
        await apiFetch<PreviewResponse>(`/api/v1/imports/${entity}/preview`, {
          method: "POST",
          body: requestBody(),
        })
      );
      setStep("Förhandsgranska");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Förhandsgranskningen misslyckades");
    } finally {
      setPending(false);
    }
  }

  async function runCommit() {
    setError(null);
    setPending(true);
    try {
      setResult(
        await apiFetch<CommitResponse>(`/api/v1/imports/${entity}/commit`, {
          method: "POST",
          body: requestBody(),
        })
      );
      setStep("Resultat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Importen misslyckades");
      // A row error on commit answers 400 with the whole preview payload
      // (ImportValidationError.payload). Render it instead of just the
      // message — commit re-plans server-side, so it can find rows the
      // preview did not when the data changed underneath.
      if (err instanceof ApiError && isPreviewResponse(err.body)) {
        setPreview(err.body);
        setStep("Förhandsgranska");
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label={title}>
      <ol className={styles.steps}>
        {STEPS.map((s, i) => (
          <li key={s} data-active={s === step} data-done={STEPS.indexOf(step) > i}>
            {s}
          </li>
        ))}
      </ol>

      <FormError margin="below">{error}</FormError>

      {step === "Fil" && (
        <div className={styles.stepBody}>
          <p>
            Välj CSV- eller Excel-filen (.xlsx). Första raden ska
            innehålla kolumnrubriker; filen läses in direkt när den valts. Max 10 000 rader. Av en
            arbetsbok läses bara det första bladet.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.txt,.xlsx"
            aria-label="Välj fil"
            disabled={pending}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          {pending && <span>Läser in…</span>}
          {IMPORT_TEMPLATE_FILES[entity] && (
            <p>
              <a
                href={`/importmallar/${IMPORT_TEMPLATE_FILES[entity]}`}
                download
                className={`${buttonStyles.button} ${buttonStyles.secondary}`}
              >
                Ladda ned mall
              </a>
            </p>
          )}
        </div>
      )}

      {step === "Kolumner" && parsed && (
        <div className={styles.stepBody}>
          <MappingTable
            entity={entity}
            parsed={parsed}
            fields={fields}
            mapping={mapping}
            onChange={(header, field) => setMapping((m) => ({ ...m, [header]: field }))}
          />

          <ImportOptionsPanel
            state={options}
            onChange={setOptions}
            skipExistingHint={skipExistingHint}
            extraOptions={extraOptions}
          />

          <FormActions>
            <Button type="button" variant="secondary" onClick={() => setStep("Fil")}>
              Tillbaka
            </Button>
            <Button type="button" variant="primary" disabled={pending} onClick={() => void runPreview()}>
              {pending ? "Granskar…" : "Förhandsgranska"}
            </Button>
          </FormActions>
        </div>
      )}

      {step === "Förhandsgranska" && preview && (
        <div className={styles.stepBody}>
          <PreviewTable preview={preview} keyField={keyField} />

          <FormActions>
            <Button type="button" variant="secondary" onClick={() => setStep("Kolumner")}>
              Tillbaka
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={pending || preview.summary.error > 0}
              onClick={() => void runCommit()}
            >
              {pending ? "Importerar…" : "Importera"}
            </Button>
          </FormActions>
        </div>
      )}

      {step === "Resultat" && result && (
        <div className={styles.stepBody}>
          <ResultSummary
            entity={entity}
            title={title}
            fields={fields}
            mapping={mapping}
            result={result}
            onError={setError}
          />

          <FormActions>
            <Link href={backHref} className={`${buttonStyles.button} ${buttonStyles.primary}`}>
              Klar
            </Link>
          </FormActions>
        </div>
      )}
    </section>
  );
}
