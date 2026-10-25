"use client";

import { useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  cleanCsvMapping,
  csvMappingComplete,
  initialCsvMapping,
  postMultipart,
} from "../../lib/bankReconciliation";
import { formatMoney } from "../../lib/format";
import type {
  BankAccount,
  BankCsvMapping,
  BankStatementImportResult,
  BankStatementPreview,
  BankStatementPreviewEntry,
} from "../../lib/types";

const SHOWN_ENTRIES = 100;

// Importera kontoutdrag: pick a camt.053 file from the bank (or a CSV export
// from the internet bank), read the preview, then Importera. Nothing is
// written before Importera; the same file twice only gives duplicates.
export function BankImportDialog({
  open,
  bankAccounts,
  defaultBankAccountId,
  onClose,
  onImported,
}: {
  open: boolean;
  bankAccounts: BankAccount[];
  defaultBankAccountId: string | null;
  onClose: () => void;
  onImported: (result: BankStatementImportResult) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Importera kontoutdrag" wide>
      <ImportForm
        bankAccounts={bankAccounts}
        defaultBankAccountId={defaultBankAccountId}
        onClose={onClose}
        onImported={onImported}
      />
    </Modal>
  );
}

function ImportForm({
  bankAccounts,
  defaultBankAccountId,
  onClose,
  onImported,
}: {
  bankAccounts: BankAccount[];
  defaultBankAccountId: string | null;
  onClose: () => void;
  onImported: (result: BankStatementImportResult) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [bankAccountId, setBankAccountId] = useState("");
  const [mapping, setMapping] = useState<BankCsvMapping | null>(null);
  const [preview, setPreview] = useState<BankStatementPreview | null>(null);
  const [autoMatch, setAutoMatch] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);

  const activeAccounts = bankAccounts.filter((a) => a.active);
  const account = (id: string) => bankAccounts.find((a) => a.id === id);

  async function runPreview(next: File, accountId: string, map: BankCsvMapping | null) {
    setBusy("preview");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", next);
      if (accountId) form.append("bankAccountId", accountId);
      if (map) form.append("csvMapping", JSON.stringify(cleanCsvMapping(map)));
      const result = await postMultipart<BankStatementPreview>("/api/v1/bank-statements/preview", form);
      setPreview(result);
      if (result.format === "csv" && result.csvHeaders) {
        // First look at a CSV: start from the account the page is showing —
        // its saved mapping or a guess from the header names. Later previews
        // keep what the user set.
        const startAccount = accountId || defaultBankAccountId || "";
        if (!accountId && startAccount) setBankAccountId(startAccount);
        setMapping((current) => current ?? initialCsvMapping(result.csvHeaders!, account(startAccount)?.csvMapping ?? null));
      }
    } catch (err) {
      setPreview(null);
      setError(apiErrorMessage(err, "Filen kunde inte läsas."));
    } finally {
      setBusy(null);
    }
  }

  function pickFile(next: File | null) {
    setFile(next);
    setPreview(null);
    setMapping(null);
    setError(null);
    // A camt.053 names its own account; a CSV needs one chosen (preselected
    // below, once the preview shows it is a CSV).
    if (next) void runPreview(next, bankAccountId, null);
  }

  function pickAccount(id: string) {
    setBankAccountId(id);
    if (!file || !preview) return;
    if (preview.format === "camt.053") {
      void runPreview(file, id, null);
    } else if (preview.csvHeaders) {
      // The account's saved mapping, when it fits these headers.
      setMapping(initialCsvMapping(preview.csvHeaders, account(id)?.csvMapping ?? null));
    }
  }

  const isCsv = preview?.format === "csv";
  // A CSV always needs the account; a camt.053 only when exactly ONE of its
  // accounts is unknown — the API assigns the chosen account to that one and
  // learns its identifier. With several unknown accounts nothing can be
  // chosen: the blocker says to create them under Bankkonton first.
  const needsAccount = preview !== null && (isCsv || preview.unknownAccounts.length === 1);
  const newTotal = preview?.statements.reduce((sum, s) => sum + s.newEntryCount, 0) ?? 0;
  const duplicateTotal = preview?.statements.reduce((sum, s) => sum + s.duplicateCount, 0) ?? 0;
  const canImport =
    preview !== null &&
    !preview.needsMapping &&
    preview.blockers.length === 0 &&
    preview.statements.length > 0 &&
    newTotal > 0 &&
    (!needsAccount || bankAccountId !== "") &&
    busy === null;

  async function runImport() {
    if (!file || !canImport) return;
    setBusy("import");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (bankAccountId && needsAccount) form.append("bankAccountId", bankAccountId);
      if (isCsv && mapping) form.append("csvMapping", JSON.stringify(cleanCsvMapping(mapping)));
      form.append("autoMatch", autoMatch ? "true" : "false");
      const result = await postMultipart<BankStatementImportResult>("/api/v1/bank-statements/import", form);
      onImported(result);
    } catch (err) {
      setError(apiErrorMessage(err, "Kontoutdraget kunde inte importeras."));
      setBusy(null);
    }
  }

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        void runImport();
      }}
    >
      <FormError>{error}</FormError>

      <Field label="Kontoutdrag" htmlFor="bankImportFile">
        <input
          id="bankImportFile"
          ref={fileInput}
          type="file"
          accept=".xml,.csv,.txt,application/xml,text/xml,text/csv,text/plain"
          disabled={busy !== null}
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <FormHint attached>
        En camt.053-fil från banken (XML) eller en CSV-export från internetbanken. Poster som redan är importerade hoppas över.
      </FormHint>
      {busy === "preview" && <p>Läser filen…</p>}

      {preview && (
        <>
          {needsAccount && (
            <>
              <Field label="Bankkonto" htmlFor="bankImportAccount">
                <Select
                  id="bankImportAccount"
                  value={bankAccountId}
                  disabled={busy !== null}
                  onChange={(e) => pickAccount(e.target.value)}
                >
                  <option value="">— Välj bankkonto —</option>
                  {activeAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.identifier})
                    </option>
                  ))}
                </Select>
              </Field>
              <FormHint attached>
                {isCsv
                  ? "En CSV-fil saknar kontonummer — välj vilket bankkonto den gäller. Mappningen sparas på kontot."
                  : `Kontoutdraget gäller ett konto som Nav inte känner igen (${preview.unknownAccounts.join(", ")}). Välj vilket bankkonto det är — numret sparas på kontot.`}
              </FormHint>
            </>
          )}

          {isCsv && preview.csvHeaders && mapping && (
            <CsvMappingForm
              headers={preview.csvHeaders}
              mapping={mapping}
              onChange={setMapping}
              busy={busy !== null}
              open={preview.needsMapping}
              onPreview={() => file && void runPreview(file, bankAccountId, mapping)}
              onReread={() =>
                file &&
                void runPreview(file, bankAccountId, {
                  delimiter: mapping.delimiter,
                  skipRows: mapping.skipRows,
                  dateColumn: "",
                  amountColumn: "",
                  textColumn: "",
                }).then(() => setMapping((current) => (current ? { ...current, dateColumn: "", amountColumn: "", textColumn: "" } : current)))
              }
              requireAccount={bankAccountId === ""}
            />
          )}

          {preview.blockers.length > 0 && (
            <FormError>
              {preview.blockers.map((b) => (
                <div key={b}>{b}</div>
              ))}
            </FormError>
          )}
          {preview.warnings.length > 0 && (
            <FormNotice>
              {preview.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </FormNotice>
          )}

          {!preview.needsMapping &&
            preview.statements.map((s, i) => (
              <div key={`${s.accountIdentifier ?? "csv"}-${i}`}>
                <SectionHeading spaced>
                  {s.accountIdentifier ? `Konto ${s.accountIdentifier}` : "Kontoutdrag"}
                  {s.from && s.to ? ` · ${s.from} – ${s.to}` : ""}
                </SectionHeading>
                <p style={{ margin: "0 0 8px" }}>
                  {s.openingBalance !== null && <>Ingående saldo {formatMoney(s.openingBalance)} kr · </>}
                  {s.closingBalance !== null && <>Utgående saldo {formatMoney(s.closingBalance)} kr · </>}
                  {s.entryCount} poster, {s.newEntryCount} nya, {s.duplicateCount} dubbletter
                </p>
                <Table<BankStatementPreviewEntry & { id: string }>
                  columns={[
                    { key: "date", label: "Datum", width: "100px" },
                    { key: "text", label: "Text", width: "1.6fr" },
                    { key: "amount", label: "Belopp", width: "110px", align: "right" },
                    { key: "status", label: "Status", width: "120px" },
                  ]}
                  rows={s.entries.slice(0, SHOWN_ENTRIES).map((entry, index) => ({ ...entry, id: String(index) }))}
                  emptyText="Inga poster"
                  renderCell={(entry, key) => {
                    switch (key) {
                      case "date":
                        return entry.bookingDate;
                      case "text":
                        return (
                          <>
                            {entry.text}
                            {entry.counterparty ? ` · ${entry.counterparty}` : ""}
                          </>
                        );
                      case "amount":
                        return formatMoney(entry.amount);
                      case "status":
                        return entry.duplicate ? (
                          <StatusPill status="draft" label="Dubblett" compact />
                        ) : (
                          <StatusPill status="running" label={entry.ruleId ? "Ny · regel" : "Ny"} compact />
                        );
                      default:
                        return null;
                    }
                  }}
                />
                {s.entries.length > SHOWN_ENTRIES && (
                  <FormHint>Visar de första {SHOWN_ENTRIES} av {s.entries.length} posterna.</FormHint>
                )}
              </div>
            ))}

          {!preview.needsMapping && preview.statements.length > 0 && (
            <>
              {newTotal === 0 && duplicateTotal > 0 && <FormNotice>Alla posterna är redan importerade.</FormNotice>}
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <Checkbox checked={autoMatch} onChange={(e) => setAutoMatch(e.target.checked)} />
                Matcha automatiskt efter import
              </label>
            </>
          )}
        </>
      )}

      <FormActions>
        <Button type="submit" variant="primary" disabled={!canImport}>
          {busy === "import" ? "Importerar…" : "Importera"}
        </Button>
        <Button type="button" variant="ghost" disabled={busy === "import"} onClick={onClose}>
          Avbryt
        </Button>
      </FormActions>
    </Form>
  );
}

function CsvMappingForm({
  headers,
  mapping,
  onChange,
  busy,
  open,
  onPreview,
  onReread,
  requireAccount,
}: {
  headers: string[];
  mapping: BankCsvMapping;
  onChange: (mapping: BankCsvMapping) => void;
  busy: boolean;
  open: boolean;
  onPreview: () => void;
  onReread: () => void;
  requireAccount: boolean;
}) {
  const set = (patch: Partial<BankCsvMapping>) => onChange({ ...mapping, ...patch });
  const columnSelect = (
    id: string,
    label: string,
    key: "dateColumn" | "amountColumn" | "textColumn" | "balanceColumn" | "valueDateColumn" | "referenceColumn",
    required: boolean
  ) => (
    <Field label={required ? label : `${label} (valfri)`} htmlFor={id}>
      <Select id={id} value={mapping[key] ?? ""} disabled={busy} onChange={(e) => set({ [key]: e.target.value } as Partial<BankCsvMapping>)}>
        <option value="">{required ? "— Välj kolumn —" : "— Ingen —"}</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
    </Field>
  );

  return (
    <details open={open} style={{ marginTop: 4 }}>
      <summary style={{ cursor: "pointer", marginBottom: 12 }}>Kolumnmappning för CSV-filen</summary>
      <FormHint>
        Välj vilka kolumner i filen som är bokföringsdag, belopp och text. Ett positivt belopp är en insättning, ett negativt ett uttag.
      </FormHint>
      <FormRow>
        <Field label="Avgränsare" htmlFor="bankImportDelimiter">
          <Select
            id="bankImportDelimiter"
            value={mapping.delimiter ?? ";"}
            disabled={busy}
            onChange={(e) => set({ delimiter: e.target.value as BankCsvMapping["delimiter"] })}
          >
            <option value=";">Semikolon (;)</option>
            <option value=",">Komma (,)</option>
            <option value={"\t"}>Tabb</option>
          </Select>
        </Field>
        <Field label="Rader att hoppa över överst" htmlFor="bankImportSkipRows">
          <Input
            id="bankImportSkipRows"
            type="number"
            min="0"
            step="1"
            size="sm"
            value={mapping.skipRows ?? 0}
            disabled={busy}
            onChange={(e) => set({ skipRows: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </Field>
      </FormRow>
      <div style={{ margin: "8px 0 12px" }}>
        <Button type="button" size="small" variant="ghost" disabled={busy} onClick={onReread}>
          Läs om rubriker
        </Button>
      </div>
      <FormRow>
        {columnSelect("bankImportDate", "Bokföringsdag", "dateColumn", true)}
        {columnSelect("bankImportAmount", "Belopp", "amountColumn", true)}
      </FormRow>
      <FormRow>
        {columnSelect("bankImportText", "Text", "textColumn", true)}
        {columnSelect("bankImportBalance", "Saldo", "balanceColumn", false)}
      </FormRow>
      <FormRow>
        {columnSelect("bankImportValueDate", "Valutadag", "valueDateColumn", false)}
        {columnSelect("bankImportReference", "Referens", "referenceColumn", false)}
      </FormRow>
      <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}>
        <Checkbox checked={mapping.decimalComma ?? true} disabled={busy} onChange={(e) => set({ decimalComma: e.target.checked })} />
        Belopp med decimalkomma (1 234,56)
      </label>
      <Button
        type="button"
        variant="secondary"
        disabled={busy || requireAccount || !csvMappingComplete(mapping)}
        title={requireAccount ? "Välj bankkonto först" : undefined}
        onClick={onPreview}
      >
        Förhandsgranska
      </Button>
    </details>
  );
}
