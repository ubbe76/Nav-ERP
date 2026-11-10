"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Field";
import { FormActions, FormError, FormHint, FormNotice } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { GatedLink } from "../ui/GatedLink";
import { ApiError, apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { formatStockholmDateTime } from "../../lib/date";
import { formatMoney } from "../../lib/format";
import {
  EINVOICE_DOCUMENT_TYPE_LABELS,
  EINVOICE_PUBLISH_LABELS,
  EINVOICE_RECEIVE_OUTCOME_LABELS,
  einvoiceErrorText,
  type EInvoiceEnvironment,
  type EInvoiceReceiveResult,
  type EInvoiceReception,
  type EInvoiceReceptionLogRow,
  type EInvoiceSettings,
} from "../../lib/einvoice";
import cardStyles from "../system/SettingsForm.module.css";

// Mottagning: receive supplier e-invoices through B2Brouter into the
// Fakturainkorg. Av/på goes through POST /einvoice-settings/reception, the
// interval is saved with PATCH, Hämta nu runs the job once.
const publishText = (status: EInvoiceReception["smlStatus"]) => (status ? EINVOICE_PUBLISH_LABELS[status] : "–");

export function EInvoiceReceptionSection({
  reception,
  onChange: setReception,
  configured,
  environment,
}: {
  // Owned by the settings form so Spara / Ta bort nyckel refresh it too.
  reception: EInvoiceReception;
  onChange: (next: EInvoiceReception) => void;
  // An API key and an account are saved — nothing can be switched on or fetched without them.
  configured: boolean;
  environment: EInvoiceEnvironment;
}) {
  const [migrationCode, setMigrationCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [interval, setIntervalMinutes] = useState(String(reception.intervalMinutes));
  const [savingInterval, setSavingInterval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intervalError, setIntervalError] = useState<string | null>(null);
  const [intervalSaved, setIntervalSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchResult, setFetchResult] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [log, setLog] = useState<EInvoiceReceptionLogRow[]>([]);
  const [logError, setLogError] = useState<string | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);

  const loadLog = useCallback(async () => {
    try {
      const res = await apiFetch<{ rows: EInvoiceReceptionLogRow[] }>("/api/v1/einvoice-settings/reception-log?limit=50");
      setLog(res.rows);
      setLogError(null);
    } catch (err) {
      setLogError(einvoiceErrorText(err, "Kunde inte hämta mottagningsloggen"));
    }
  }, []);

  useEffect(() => {
    void loadLog();
  }, [loadLog]);

  useEffect(() => {
    setIntervalMinutes(String(reception.intervalMinutes));
  }, [reception.intervalMinutes]);

  async function refreshReception() {
    const settings = await apiFetch<EInvoiceSettings>("/api/v1/einvoice-settings");
    setReception(settings.reception);
  }

  async function setEnabled(enabled: boolean) {
    setError(null);
    if (enabled) {
      const ok = await confirmDialog(
        "Företaget publiceras i Peppol-katalogen som mottagare av e-faktura, och leverantörer som skickar via Peppol kan då nå er. " +
          "B2Brouter räknar mottagna fakturor som transaktioner — kontrollera att er plan hos B2Brouter räcker. Slå på mottagning?",
        { confirmLabel: "Ta emot e-faktura" }
      );
      if (!ok) return;
    } else {
      const ok = await confirmDialog(
        "Mottagningen stängs av hos B2Brouter. Fakturor som redan finns i Fakturainkorgen påverkas inte. Stäng av mottagning?",
        { confirmLabel: "Stäng av", danger: true }
      );
      if (!ok) return;
    }
    setPending(true);
    try {
      const code = migrationCode.trim();
      const updated = await apiFetch<EInvoiceReception>("/api/v1/einvoice-settings/reception", {
        method: "POST",
        body: JSON.stringify({ enabled, ...(enabled && code ? { migrationCode: code } : {}) }),
      });
      setReception(updated);
      setNeedsCode(false);
      setMigrationCode("");
    } catch (err) {
      // A migration code only exists in production — the sandbox just shows the server's message.
      if (err instanceof ApiError && err.code === "einvoice-reception-registered-elsewhere" && environment === "production") {
        setNeedsCode(true);
      }
      setError(einvoiceErrorText(err, enabled ? "Kunde inte slå på mottagningen" : "Kunde inte stänga av mottagningen"));
    } finally {
      setPending(false);
    }
  }

  async function saveInterval() {
    setIntervalError(null);
    setIntervalSaved(false);
    const minutes = Number(interval);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
      setIntervalError("Hämtningsintervallet måste vara ett heltal mellan 5 och 1440 minuter");
      return;
    }
    setSavingInterval(true);
    try {
      const updated = await apiFetch<EInvoiceSettings>("/api/v1/einvoice-settings", {
        method: "PATCH",
        body: JSON.stringify({ receiveIntervalMinutes: minutes }),
      });
      setReception(updated.reception);
      setIntervalSaved(true);
    } catch (err) {
      setIntervalError(einvoiceErrorText(err, "Kunde inte spara intervallet"));
    } finally {
      setSavingInterval(false);
    }
  }

  // Markera som hanterad: closes an unreadable document (acknowledged at
  // B2Brouter); the invoice must then be registered by hand.
  async function dismiss(row: EInvoiceReceptionLogRow) {
    const ok = await confirmDialog(
      "Dokumentet kvitteras hos B2Brouter och hämtas inte igen. Fakturan måste då registreras för hand — till exempel genom att ladda upp leverantörens PDF i Fakturainkorgen. Markera som hanterad?",
      { confirmLabel: "Markera som hanterad" }
    );
    if (!ok) return;
    setLogError(null);
    setDismissing(row.id);
    try {
      await apiFetch(`/api/v1/einvoice-settings/reception-log/${row.id}/dismiss`, { method: "POST" });
      await loadLog();
    } catch (err) {
      setLogError(einvoiceErrorText(err, "Kunde inte markera raden som hanterad"));
    } finally {
      setDismissing(null);
    }
  }

  async function receiveNow() {
    setFetchError(null);
    setFetchResult(null);
    setFetching(true);
    try {
      const res = await apiFetch<EInvoiceReceiveResult>("/api/v1/einvoice-settings/receive-now", { method: "POST" });
      setFetchResult(`${res.imported} inlästa, ${res.duplicates} dubbletter, ${res.unreadable} kunde inte läsas`);
    } catch (err) {
      setFetchError(einvoiceErrorText(err, "Kunde inte hämta e-fakturor"));
      setFetching(false);
      return;
    }
    // The pickup worked; a failed refresh is the log's problem, not the fetch's.
    try {
      await refreshReception();
    } catch (err) {
      setLogError(einvoiceErrorText(err, "Kunde inte uppdatera mottagningsstatus"));
    }
    await loadLog();
    setFetching(false);
  }

  const rows: [string, string][] = [
    ["Peppol-id", reception.participantId ?? "–"],
    ["Publicering", publishText(reception.smlStatus)],
    ["Peppol-katalogen", publishText(reception.directoryStatus)],
    ["Dokumenttyper", reception.documentTypes.length > 0 ? reception.documentTypes.map((c) => EINVOICE_DOCUMENT_TYPE_LABELS[c] ?? c).join(", ") : "–"],
  ];

  return (
    <div className={cardStyles.card} style={{ marginTop: 18 }}>
      <SectionHeading>Mottagning</SectionHeading>
      <FormHint>
        Leverantörers e-fakturor som kommer via Peppol hämtas från B2Brouter och hamnar i{" "}
        <GatedLink href="/inkop/fakturainkorg">Fakturainkorgen</GatedLink> färdigtolkade, redo att granskas.
      </FormHint>
      <FormError>{error}</FormError>
      <p style={{ margin: "12px 0 0" }}>
        <strong>{reception.enabled ? "Mottagning på" : "Mottagning av"}</strong>
      </p>
      {reception.migrationPending && (
        <FormNotice style={{ marginTop: 8 }}>
          Flytten från er tidigare leverantör pågår — mottagningen börjar när den är klar.
        </FormNotice>
      )}
      {needsCode && (
        <Field label="Migreringskod" htmlFor="einvoiceMigrationCode">
          <Input
            id="einvoiceMigrationCode"
            value={migrationCode}
            onChange={(e) => setMigrationCode(e.target.value)}
            autoComplete="off"
          />
        </Field>
      )}
      <details style={{ marginTop: 12 }}>
        <summary>Har ni redan en annan e-fakturaleverantör?</summary>
        <FormHint>
          Då tar den leverantören emot för ert organisationsnummer. Be dem om en migreringskod och skriv den här innan du slår på
          mottagningen.
        </FormHint>
        {!needsCode && (
          <Field label="Migreringskod" htmlFor="einvoiceMigrationCodeOpt">
            <Input
              id="einvoiceMigrationCodeOpt"
              value={migrationCode}
              onChange={(e) => setMigrationCode(e.target.value)}
              autoComplete="off"
            />
          </Field>
        )}
      </details>
      <FormActions>
        <Button
          type="button"
          variant={reception.enabled ? "secondary" : "primary"}
          disabled={pending || !configured}
          onClick={() => void setEnabled(!reception.enabled)}
        >
          {pending ? "Vänta…" : reception.enabled ? "Stäng av mottagning" : "Ta emot e-faktura"}
        </Button>
      </FormActions>
      {!configured && <FormHint>Spara en API-nyckel och testa anslutningen ovan innan mottagning kan slås på.</FormHint>}

      <dl style={{ margin: "16px 0 0", display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "6px 16px" }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <dt style={{ color: "var(--color-text-secondary)" }}>{label}</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{value}</dd>
          </div>
        ))}
        <dt style={{ color: "var(--color-text-secondary)" }}>Senaste hämtning</dt>
        <dd style={{ margin: 0 }}>{reception.lastRunAt ? formatStockholmDateTime(reception.lastRunAt) : "Har inte körts ännu"}</dd>
        <dt style={{ color: "var(--color-text-secondary)" }}>Senaste fel</dt>
        <dd style={{ margin: 0, overflowWrap: "anywhere" }}>{reception.lastError ?? "–"}</dd>
      </dl>

      <div style={{ marginTop: 16 }}>
        <Field label="Hämtningsintervall (minuter)" htmlFor="einvoiceReceiveInterval">
          <Input
            id="einvoiceReceiveInterval"
            type="number"
            size="xs"
            min="5"
            max="1440"
            step="1"
            value={interval}
            onChange={(e) => setIntervalMinutes(e.target.value)}
          />
        </Field>
        <FormError>{intervalError}</FormError>
        <FormActions>
          <Button type="button" variant="secondary" disabled={savingInterval} onClick={() => void saveInterval()}>
            Spara intervall
          </Button>
          {intervalSaved && <span className={cardStyles.saved}>Sparat</span>}
          <Button type="button" variant="secondary" disabled={fetching || !configured} onClick={() => void receiveNow()}>
            {fetching ? "Hämtar…" : "Hämta nu"}
          </Button>
        </FormActions>
        {fetchResult && <FormHint>{fetchResult}</FormHint>}
        <FormError>{fetchError}</FormError>
      </div>

      <SectionHeading spaced>Mottagningslogg</SectionHeading>
      <FormError>{logError}</FormError>
      <Table<EInvoiceReceptionLogRow>
        columns={[
          // The card is narrow (about 590 px of content at desktop width):
          // few fixed columns, the inbox link inside Utfall.
          { key: "receivedAt", label: "Mottagen", width: "115px" },
          { key: "sender", label: "Avsändare", width: "minmax(0, 1.5fr)" },
          { key: "documentNumber", label: "Fakturanr", width: "minmax(0, 1fr)" },
          { key: "payableAmount", label: "Belopp", width: "105px", align: "right" },
          { key: "outcome", label: "Utfall", width: "minmax(0, 1.2fr)" },
        ]}
        rows={log}
        emptyText="Inga e-fakturor har tagits emot än"
        renderCell={(row, key) => {
          switch (key) {
            case "receivedAt":
              return formatStockholmDateTime(row.receivedAt);
            case "sender":
              return (
                <span title={row.senderEndpoint ?? undefined} style={{ overflowWrap: "anywhere" }}>
                  {row.senderName ?? row.senderEndpoint ?? "–"}
                  {row.environment === "sandbox" && (
                    <span style={{ display: "block", color: "var(--color-text-secondary)" }}>Testläge (sandlåda)</span>
                  )}
                </span>
              );
            case "documentNumber":
              return <span style={{ overflowWrap: "anywhere" }}>{row.documentNumber ?? "–"}</span>;
            case "payableAmount":
              return row.payableAmount === null ? "–" : `${formatMoney(row.payableAmount)}${row.currency ? ` ${row.currency}` : ""}`;
            case "outcome":
              return (
                <span title={row.detail ?? undefined}>
                  {EINVOICE_RECEIVE_OUTCOME_LABELS[row.outcome]}
                  {row.invoiceScanId && (
                    <>
                      {" · "}
                      <GatedLink href={`/inkop/fakturainkorg/${row.invoiceScanId}`}>{row.scanNumber ?? "Öppna"}</GatedLink>
                    </>
                  )}
                  {row.outcome === "unreadable" ? " — öppna i B2Brouter " : ""}
                  {/* The ack goes with the saved key: only the selected environment's rows. */}
                  {row.outcome === "unreadable" && row.environment === environment ? (
                    <Button type="button" variant="secondary" size="small" disabled={dismissing === row.id} onClick={() => void dismiss(row)}>
                      Markera som hanterad
                    </Button>
                  ) : null}
                </span>
              );
            default:
              return null;
          }
        }}
      />
    </div>
  );
}
