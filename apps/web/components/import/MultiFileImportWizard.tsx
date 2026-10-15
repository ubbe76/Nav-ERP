"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { Select } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { API_URL, ApiError, apiFetch } from "../../lib/api";
import { IMPORT_ENTITIES, IMPORT_ENTITY_ORDER, type ImportEntityConfig } from "../../lib/importEntities";
import buttonStyles from "../ui/Button.module.css";
import wizardStyles from "./ImportWizard.module.css";
import styles from "./MultiFileImportWizard.module.css";
import { MappingTable } from "./MappingTable";
import { ImportOptionsPanel, initialOptionValues, optionsRequestFields, type ImportOptionsState } from "./ImportOptionsPanel";
import { PreviewTable } from "./PreviewTable";
import { ResultSummary } from "./ResultSummary";
import {
  buildInitialMapping,
  isPreviewResponse,
  validateMapping,
  type CommitResponse,
  type DetectResponse,
  type ParseResponse,
  type PreviewResponse,
} from "./importTypes";

const STEPS = ["Filer", "Kolumner", "Förhandsgranska", "Resultat"] as const;
type Step = (typeof STEPS)[number];

// Per-file outcome. "blocked" = never attempted because an earlier file in
// the dependency order failed — the later entities need the earlier ones.
type FileStatus = "pending" | "imported" | "failed" | "blocked";

interface FileState {
  id: string;
  name: string;
  file: File;
  // null = unrecognised (or deselected) — the file is left out entirely.
  entity: string | null;
  parsed: ParseResponse;
  mapping: Record<string, string | null>;
  options: ImportOptionsState;
  preview: PreviewResponse | null;
  result: CommitResponse | null;
  error: string | null;
  status: FileStatus;
}

interface MultiFileImportWizardProps {
  title: string;
  backHref: string;
}

function configFor(entity: string | null): ImportEntityConfig | null {
  return entity ? (IMPORT_ENTITIES[entity] ?? null) : null;
}

function freshOptions(config: ImportEntityConfig | null): ImportOptionsState {
  return {
    defaultValues: config?.defaults ?? {},
    skipExisting: false,
    optionValues: initialOptionValues(config?.extraOptions),
  };
}

// Dependency order (IMPORT_ENTITY_ORDER), unknown files last, ties by name.
function sortFiles(files: FileState[]): FileState[] {
  const rank = (entity: string | null) => {
    const index = entity ? IMPORT_ENTITY_ORDER.indexOf(entity) : -1;
    return index === -1 ? IMPORT_ENTITY_ORDER.length : index;
  };
  return [...files].sort((a, b) => rank(a.entity) - rank(b.entity) || a.name.localeCompare(b.name, "sv"));
}

async function uploadFile(url: string, file: File): Promise<Response> {
  const body = new FormData();
  body.append("file", file);
  // Multipart upload — apiFetch sets a JSON content type, so this one goes
  // through fetch directly (same as ImportWizard).
  return fetch(url, { method: "POST", credentials: "include", body });
}

// Every Monitor article export at once: drop the files, the server
// recognises each one from its header row (POST /imports/detect), the user
// checks the mappings per file, previews everything and imports in
// dependency order — each file through the same /preview and /commit
// endpoints the single-file wizard uses, one transaction per file. A failing
// file stops the run; the files after it are reported as not imported.
export function MultiFileImportWizard({ title, backHref }: MultiFileImportWizardProps) {
  const [step, setStep] = useState<Step>("Filer");
  const [files, setFiles] = useState<FileState[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function patchFile(id: string, patch: Partial<FileState> | ((file: FileState) => Partial<FileState>)) {
    setFiles((current) =>
      current.map((file) => (file.id === id ? { ...file, ...(typeof patch === "function" ? patch(file) : patch) } : file))
    );
  }

  async function addFiles(list: FileList) {
    setError(null);
    setPending("Läser in filer…");
    const added: FileState[] = [];
    const problems: string[] = [];
    try {
      for (const file of Array.from(list)) {
        const res = await uploadFile(`${API_URL}/api/v1/imports/detect`, file);
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          problems.push(`${file.name}: ${payload.error ?? "filen kunde inte läsas"}`);
          continue;
        }
        const data: DetectResponse = await res.json();
        const config = configFor(data.detectedEntity);
        added.push({
          id: `${file.name}-${Date.now()}-${added.length}`,
          name: file.name,
          file,
          entity: config ? data.detectedEntity : null,
          parsed: data,
          mapping: buildInitialMapping(data.headers, data.suggestedMapping),
          options: freshOptions(config),
          preview: null,
          result: null,
          error: null,
          status: "pending",
        });
      }
      setFiles((current) => sortFiles([...current, ...added]));
      if (problems.length > 0) setError(problems.join(" · "));
    } finally {
      setPending(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // Entity override: re-parse through /imports/:entity/parse so the mapping
  // is that entity's suggestion (rows and headers are the same file).
  async function changeEntity(fileState: FileState, entity: string) {
    if (entity === "") {
      patchFile(fileState.id, { entity: null, mapping: {}, options: freshOptions(null), preview: null, error: null });
      setFiles((current) => sortFiles(current));
      return;
    }
    setError(null);
    setPending(`Läser om ${fileState.name}…`);
    try {
      const res = await uploadFile(`${API_URL}/api/v1/imports/${entity}/parse`, fileState.file);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error ?? "Filen kunde inte läsas");
      }
      const data: ParseResponse = await res.json();
      const config = configFor(entity);
      patchFile(fileState.id, {
        entity,
        parsed: data,
        mapping: buildInitialMapping(data.headers, data.suggestedMapping),
        options: freshOptions(config),
        preview: null,
        error: null,
      });
      setFiles((current) => sortFiles(current));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Filen kunde inte läsas");
    } finally {
      setPending(null);
    }
  }

  function requestBody(fileState: FileState, config: ImportEntityConfig): string {
    return JSON.stringify({
      mapping: fileState.mapping,
      rows: fileState.parsed.rows,
      ...optionsRequestFields(fileState.options, config.extraOptions),
    });
  }

  const activeFiles = files.filter((file) => file.entity !== null);

  async function runPreviews() {
    setError(null);
    // Mapping problems are reported per file, before anything is sent.
    let blocked = false;
    for (const fileState of activeFiles) {
      const config = configFor(fileState.entity)!;
      const mappingError = validateMapping(fileState.mapping, config.fields);
      patchFile(fileState.id, { error: mappingError, preview: null });
      if (mappingError) blocked = true;
    }
    if (blocked) {
      setError("Mappningen är inte komplett för alla filer — se felen per fil nedan.");
      return;
    }
    for (const fileState of activeFiles) {
      const config = configFor(fileState.entity)!;
      setPending(`Granskar ${fileState.name}…`);
      try {
        const preview = await apiFetch<PreviewResponse>(`/api/v1/imports/${fileState.entity}/preview`, {
          method: "POST",
          body: requestBody(fileState, config),
        });
        patchFile(fileState.id, { preview, error: null });
      } catch (err) {
        patchFile(fileState.id, { preview: null, error: err instanceof Error ? err.message : "Förhandsgranskningen misslyckades" });
      }
    }
    setPending(null);
    setStep("Förhandsgranska");
  }

  async function runCommits() {
    setError(null);
    let failed = false;
    for (const fileState of activeFiles) {
      if (failed) {
        patchFile(fileState.id, { status: "blocked", result: null });
        continue;
      }
      const config = configFor(fileState.entity)!;
      setPending(`Importerar ${fileState.name}…`);
      try {
        const result = await apiFetch<CommitResponse>(`/api/v1/imports/${fileState.entity}/commit`, {
          method: "POST",
          body: requestBody(fileState, config),
        });
        patchFile(fileState.id, { result, status: "imported", error: null });
      } catch (err) {
        failed = true;
        // A row error on commit answers 400 with the whole preview payload —
        // show it so the user sees which rows blocked the file.
        patchFile(fileState.id, {
          status: "failed",
          result: null,
          error: err instanceof Error ? err.message : "Importen misslyckades",
          preview: err instanceof ApiError && isPreviewResponse(err.body) ? err.body : fileState.preview,
        });
      }
    }
    setPending(null);
    setStep("Resultat");
  }

  const previewsBlocked =
    activeFiles.length === 0 ||
    activeFiles.some((file) => file.error !== null || file.preview === null || file.preview.summary.error > 0);

  function entityLabel(entity: string | null): string {
    return configFor(entity)?.label ?? "Okänd fil";
  }

  return (
    <section aria-label={title}>
      <ol className={wizardStyles.steps}>
        {STEPS.map((s, i) => (
          <li key={s} data-active={s === step} data-done={STEPS.indexOf(step) > i}>
            {s}
          </li>
        ))}
      </ol>

      <FormError margin="below">{error}</FormError>

      {step === "Filer" && (
        <div className={wizardStyles.stepBody}>
          <p>
            Välj alla exportfiler på en gång — artikellistan och dess delexporter (planering, extra
            benämning, enheter), operationslistan, materiallistan och prislistorna. Varje fil känns igen
            på sina kolumnrubriker; en fil som inte känns igen hoppas över (eller ges en typ för hand i
            nästa steg). Filerna importeras i beroendeordning: artiklar → enheter → operationer →
            struktur → inköpspriser → kundpriser.
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".csv,.txt,.xlsx"
            aria-label="Välj filer"
            disabled={pending !== null}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void addFiles(e.target.files);
            }}
          />
          {pending && <span>{pending}</span>}

          {files.length > 0 && (
            <ul className={styles.fileList}>
              {files.map((file) => (
                <li key={file.id} className={styles.fileRow} data-unknown={file.entity === null}>
                  <span className={styles.fileName}>{file.name}</span>
                  <span className={styles.fileMeta}>
                    {file.parsed.meta.rowCount.toLocaleString("sv-SE")} rader · {entityLabel(file.entity)}
                    {file.entity === null ? " – hoppas över" : ""}
                  </span>
                  <Button
                    type="button"
                    size="small"
                    variant="ghost"
                    onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}
                  >
                    Ta bort
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <FormActions>
            <Button
              type="button"
              variant="primary"
              disabled={pending !== null || activeFiles.length === 0}
              onClick={() => setStep("Kolumner")}
            >
              Fortsätt
            </Button>
          </FormActions>
        </div>
      )}

      {step === "Kolumner" && (
        <div className={wizardStyles.stepBody}>
          <p>
            Kontrollera vilken typ varje fil känts igen som och hur kolumnerna mappas. Fält märkta * måste
            mappas; kolumner med <strong>Importera inte</strong> hoppas över.
          </p>
          {files.map((file) => {
            const config = configFor(file.entity);
            return (
              <div key={file.id} className={styles.fileCard} data-unknown={file.entity === null}>
                <div className={styles.fileCardHeader}>
                  <span className={styles.fileName}>{file.name}</span>
                  <span className={styles.fileMeta}>{file.parsed.meta.rowCount.toLocaleString("sv-SE")} rader</span>
                  <Select
                    aria-label={`Importtyp för ${file.name}`}
                    value={file.entity ?? ""}
                    disabled={pending !== null}
                    onChange={(e) => void changeEntity(file, e.target.value)}
                  >
                    <option value="">Hoppa över filen</option>
                    {IMPORT_ENTITY_ORDER.map((entity) => (
                      <option key={entity} value={entity}>
                        {IMPORT_ENTITIES[entity]!.label}
                      </option>
                    ))}
                  </Select>
                </div>
                {file.error && <FormError margin="below">{file.error}</FormError>}
                {config ? (
                  <>
                    {config.notice && <FormNotice>{config.notice}</FormNotice>}
                    <details className={styles.mappingDetails}>
                      <summary>
                        Kolumner ({file.parsed.headers.length}) —{" "}
                        {Object.values(file.mapping).filter((field) => field !== null).length} mappade
                      </summary>
                      <MappingTable
                        compact
                        parsed={file.parsed}
                        fields={config.fields}
                        mapping={file.mapping}
                        onChange={(header, field) =>
                          patchFile(file.id, (current) => ({ mapping: { ...current.mapping, [header]: field } }))
                        }
                      />
                    </details>
                    <ImportOptionsPanel
                      idPrefix={`${file.id}-`}
                      state={file.options}
                      onChange={(options) => patchFile(file.id, { options })}
                      skipExistingHint={config.skipExistingHint}
                      extraOptions={config.extraOptions}
                    />
                  </>
                ) : (
                  <FormHint>Filen känns inte igen och hoppas över. Välj en typ ovan för att importera den ändå.</FormHint>
                )}
              </div>
            );
          })}

          <FormActions>
            <Button type="button" variant="secondary" disabled={pending !== null} onClick={() => setStep("Filer")}>
              Tillbaka
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={pending !== null || activeFiles.length === 0}
              onClick={() => void runPreviews()}
            >
              {pending ?? "Förhandsgranska alla"}
            </Button>
          </FormActions>
        </div>
      )}

      {step === "Förhandsgranska" && (
        <div className={wizardStyles.stepBody}>
          {activeFiles.map((file) => {
            const config = configFor(file.entity)!;
            const keyField = config.fields.find((f) => f.required) ?? config.fields[0]!;
            const hasErrors = file.error !== null || (file.preview?.summary.error ?? 0) > 0;
            return (
              <div key={file.id} className={styles.fileCard} data-error={hasErrors}>
                <div className={styles.fileCardHeader}>
                  <span className={styles.fileName}>{file.name}</span>
                  <span className={styles.fileMeta}>{config.label}</span>
                </div>
                {file.error && <FormError margin="below">{file.error}</FormError>}
                {file.preview && (
                  <details className={styles.previewDetails} open={hasErrors}>
                    <summary>
                      {file.preview.summary.create} nya · {file.preview.summary.update} uppdateras ·{" "}
                      {file.preview.summary.skip} hoppas över · {file.preview.summary.error} fel ·{" "}
                      {file.preview.summary.warning} varningar
                    </summary>
                    <PreviewTable preview={file.preview} keyField={keyField} />
                  </details>
                )}
              </div>
            );
          })}

          {previewsBlocked && activeFiles.length > 0 && (
            <FormHint>
              Importen kan inte startas förrän alla filer förhandsgranskats utan fel. Rätta filen, ta bort
              den eller sätt den till <strong>Hoppa över filen</strong> i steget Kolumner.
            </FormHint>
          )}

          <FormActions>
            <Button type="button" variant="secondary" disabled={pending !== null} onClick={() => setStep("Kolumner")}>
              Tillbaka
            </Button>
            <Button type="button" variant="primary" disabled={pending !== null || previewsBlocked} onClick={() => void runCommits()}>
              {pending ?? "Importera alla"}
            </Button>
          </FormActions>
        </div>
      )}

      {step === "Resultat" && (
        <div className={wizardStyles.stepBody}>
          <p className={wizardStyles.resultHeadline}>
            {activeFiles.every((file) => file.status === "imported")
              ? "Importen är klar."
              : "Importen stoppades — filerna nedan visar vad som kom in och vad som inte gjorde det."}
          </p>
          {activeFiles.map((file) => {
            const config = configFor(file.entity)!;
            const keyField = config.fields.find((f) => f.required) ?? config.fields[0]!;
            return (
              <div key={file.id} className={styles.fileCard} data-error={file.status === "failed"} data-blocked={file.status === "blocked"}>
                <div className={styles.fileCardHeader}>
                  <span className={styles.fileName}>{file.name}</span>
                  <span className={styles.fileMeta}>
                    {config.label} ·{" "}
                    {file.status === "imported"
                      ? "importerad"
                      : file.status === "failed"
                        ? "misslyckades"
                        : "ej importerad – stoppad av felet ovan"}
                  </span>
                </div>
                {file.status === "imported" && file.result && (
                  <ResultSummary
                    compact
                    entity={file.entity!}
                    title={`${title} — ${file.name}`}
                    fields={config.fields}
                    mapping={file.mapping}
                    result={file.result}
                    onError={setError}
                  />
                )}
                {file.status === "failed" && (
                  <>
                    <FormError margin="below">{file.error}</FormError>
                    {file.preview && file.preview.summary.error > 0 && (
                      <details className={styles.previewDetails} open>
                        <summary>Raderna som stoppade filen</summary>
                        <PreviewTable preview={file.preview} keyField={keyField} />
                      </details>
                    )}
                  </>
                )}
                {file.status === "blocked" && (
                  <FormHint>
                    Filen importerades inte eftersom en tidigare fil misslyckades. Rätta felet och importera de
                    återstående filerna på nytt — det som redan importerats hoppas över eller uppdateras.
                  </FormHint>
                )}
              </div>
            );
          })}

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
