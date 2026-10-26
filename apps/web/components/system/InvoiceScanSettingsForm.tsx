"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { StatusPill } from "../ui/StatusPill";
import { Table } from "../ui/Table";
import { ApiError, apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDateTime } from "../../lib/date";
import {
  INVOICE_SCAN_AI_MODE_LABELS,
  INVOICE_SCAN_AI_MODEL_LABELS,
  INVOICE_SCAN_MAIL_OUTCOME_LABELS,
  INVOICE_SCAN_MAIL_OUTCOME_PILL,
  type InvoiceScanAiMode,
  type InvoiceScanAiModel,
  type InvoiceScanMailLogRow,
  type InvoiceScanSettings,
} from "../../lib/invoiceScan";
import cardStyles from "./SettingsForm.module.css";
import styles from "./InvoiceScanSettingsForm.module.css";

// System → Fakturaskanning (admin). Like the e-invoice and freight forms the
// secrets are write-only: the API key and the mailbox password are never sent
// back, a blank field keeps the stored one and the Ta bort buttons remove it.

// A test route that the API of this version does not have yet answers 404.
function testErrorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 404 && !err.code) {
    return "Testet finns inte i den här versionen av Nav.";
  }
  return apiErrorMessage(err, fallback);
}

// Mapp and Mapp för inlästa must differ (the API refuses it too, 400
// invoice-scan-mail-folders-equal) — compared as the API does: level by
// level, trimmed, case-insensitive.
const FOLDERS_EQUAL_TEXT = "Mapp för inlästa får inte vara samma mapp som den som läses.";
function sameFolder(a: string, b: string): boolean {
  const canon = (path: string) =>
    path
      .split("/")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part !== "")
      .join("/");
  return canon(a) === canon(b);
}

export function InvoiceScanSettingsForm({ initial }: { initial: InvoiceScanSettings }) {
  const [aiMode, setAiMode] = useState<InvoiceScanAiMode>(initial.aiMode);
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiApiKeySet, setAiApiKeySet] = useState(initial.aiApiKeySet);
  const [aiModel, setAiModel] = useState<InvoiceScanAiModel>(initial.aiModel);
  const [poMatching, setPoMatching] = useState(initial.poMatching);
  const [mailEnabled, setMailEnabled] = useState(initial.mailEnabled);
  const [mailHost, setMailHost] = useState(initial.mailHost ?? "");
  const [mailPort, setMailPort] = useState(String(initial.mailPort));
  const [mailTls, setMailTls] = useState(initial.mailTls);
  const [mailUser, setMailUser] = useState(initial.mailUser ?? "");
  const [mailPassword, setMailPassword] = useState("");
  const [mailPasswordSet, setMailPasswordSet] = useState(initial.mailPasswordSet);
  const [mailFolder, setMailFolder] = useState(initial.mailFolder);
  const [mailProcessedFolder, setMailProcessedFolder] = useState(initial.mailProcessedFolder);
  const [mailInterval, setMailInterval] = useState(String(initial.mailIntervalMinutes));
  const [lastRunAt, setLastRunAt] = useState(initial.mailLastRunAt);
  const [lastError, setLastError] = useState(initial.mailLastError);

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [aiTestNotice, setAiTestNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [aiTesting, setAiTesting] = useState(false);
  const [mailTestNotice, setMailTestNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const [mailTesting, setMailTesting] = useState(false);

  function apply(updated: InvoiceScanSettings) {
    setAiMode(updated.aiMode);
    setAiApiKeySet(updated.aiApiKeySet);
    setAiModel(updated.aiModel);
    setPoMatching(updated.poMatching);
    setMailEnabled(updated.mailEnabled);
    setMailHost(updated.mailHost ?? "");
    setMailPort(String(updated.mailPort));
    setMailTls(updated.mailTls);
    setMailUser(updated.mailUser ?? "");
    setMailPasswordSet(updated.mailPasswordSet);
    setMailFolder(updated.mailFolder);
    setMailProcessedFolder(updated.mailProcessedFolder);
    setMailInterval(String(updated.mailIntervalMinutes));
    setLastRunAt(updated.mailLastRunAt);
    setLastError(updated.mailLastError);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const port = Number(mailPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("Porten måste vara ett heltal mellan 1 och 65535");
      return;
    }
    const minutes = Number(mailInterval);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
      setError("Intervallet måste vara ett heltal mellan 1 och 60 minuter");
      return;
    }
    if (sameFolder(mailFolder, mailProcessedFolder)) {
      setError(FOLDERS_EQUAL_TEXT);
      return;
    }
    setPending(true);
    try {
      const updated = await apiFetch<InvoiceScanSettings>("/api/v1/settings/invoice-scan", {
        method: "PATCH",
        body: JSON.stringify({
          aiMode,
          // "" keeps the stored key / password.
          aiApiKey: aiApiKey.trim(),
          aiModel,
          poMatching,
          mailEnabled,
          mailHost: mailHost.trim() || null,
          mailPort: port,
          mailTls,
          mailUser: mailUser.trim() || null,
          mailPassword,
          mailFolder: mailFolder.trim() || undefined,
          mailProcessedFolder: mailProcessedFolder.trim() || undefined,
          mailIntervalMinutes: minutes,
        }),
      });
      apply(updated);
      setAiApiKey("");
      setMailPassword("");
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara inställningarna"));
    } finally {
      setPending(false);
    }
  }

  async function removeSecret(field: "aiApiKey" | "mailPassword") {
    setError(null);
    try {
      apply(
        await apiFetch<InvoiceScanSettings>("/api/v1/settings/invoice-scan", {
          method: "PATCH",
          body: JSON.stringify({ [field]: null }),
        })
      );
    } catch (err) {
      setError(apiErrorMessage(err, field === "aiApiKey" ? "Kunde inte ta bort nyckeln" : "Kunde inte ta bort lösenordet"));
    }
  }

  async function testAi() {
    setAiTestNotice(null);
    setAiTesting(true);
    try {
      const res = await apiFetch<{ ok: boolean; model?: string }>("/api/v1/settings/invoice-scan/test-ai", {
        method: "POST",
        body: JSON.stringify({ ...(aiApiKey.trim() ? { apiKey: aiApiKey.trim() } : {}), model: aiModel }),
      });
      setAiTestNotice({ ok: true, text: `Anslutningen fungerar${res.model ? ` — modell: ${res.model}` : ""}.` });
    } catch (err) {
      setAiTestNotice({ ok: false, text: testErrorText(err, "Anslutningen misslyckades") });
    } finally {
      setAiTesting(false);
    }
  }

  async function testMail() {
    setMailTestNotice(null);
    if (sameFolder(mailFolder, mailProcessedFolder)) {
      setMailTestNotice({ ok: false, text: FOLDERS_EQUAL_TEXT });
      return;
    }
    setMailTesting(true);
    try {
      const res = await apiFetch<{ ok: boolean; unseen: number; processedFolderExists: boolean }>(
        "/api/v1/settings/invoice-scan/test-mail",
        {
          method: "POST",
          body: JSON.stringify({
            mailHost: mailHost.trim() || null,
            mailPort: Number(mailPort),
            mailTls,
            mailUser: mailUser.trim() || null,
            // Blank = the stored password.
            ...(mailPassword ? { mailPassword } : {}),
            mailFolder: mailFolder.trim() || undefined,
            mailProcessedFolder: mailProcessedFolder.trim() || undefined,
          }),
        }
      );
      const unseen = `${res.unseen} ${res.unseen === 1 ? "oläst brev" : "olästa brev"} i ${mailFolder}`;
      const processed = res.processedFolderExists
        ? `Mappen ${mailProcessedFolder} finns.`
        : `Mappen ${mailProcessedFolder} skapas vid första körningen.`;
      setMailTestNotice({ ok: true, text: `Anslutningen fungerar — ${unseen}. ${processed}` });
    } catch (err) {
      setMailTestNotice({ ok: false, text: testErrorText(err, "Anslutningen misslyckades") });
    } finally {
      setMailTesting(false);
    }
  }

  return (
    <div className={styles.sections}>
      <div className={cardStyles.card}>
        <Form onSubmit={save}>
          <FormError>{error}</FormError>

          <div>
            <div className={cardStyles.label}>AI-tolkning</div>
            <div className={cardStyles.description}>
              Reglerna läser alltid PDF:ens textlager lokalt. AI-tolkning är ett tillägg som läser fakturor reglerna inte
              klarar, foton och inskannade PDF utan textlager. Utan en API-nyckel lämnar ingen fil Nav.
            </div>
          </div>
          <FormRow>
            <Field label="Läge" htmlFor="scanAiMode">
              <Select id="scanAiMode" value={aiMode} onChange={(e) => setAiMode(e.target.value as InvoiceScanAiMode)}>
                {(Object.keys(INVOICE_SCAN_AI_MODE_LABELS) as InvoiceScanAiMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {INVOICE_SCAN_AI_MODE_LABELS[mode]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Modell" htmlFor="scanAiModel">
              <Select id="scanAiModel" value={aiModel} onChange={(e) => setAiModel(e.target.value as InvoiceScanAiModel)}>
                {(Object.keys(INVOICE_SCAN_AI_MODEL_LABELS) as InvoiceScanAiModel[]).map((model) => (
                  <option key={model} value={model}>
                    {INVOICE_SCAN_AI_MODEL_LABELS[model]}
                  </option>
                ))}
              </Select>
            </Field>
          </FormRow>
          <FormRow>
            <Field label="API-nyckel" htmlFor="scanAiKey">
              <Input
                id="scanAiKey"
                type="password"
                value={aiApiKey}
                onChange={(e) => {
                  setAiApiKey(e.target.value);
                  setAiTestNotice(null);
                }}
                placeholder={aiApiKeySet ? "Nyckel sparad" : ""}
                autoComplete="new-password"
              />
            </Field>
            <div className={styles.actionsRow}>
              <Button type="button" variant="secondary" disabled={aiTesting} onClick={testAi}>
                {aiTesting ? "Testar…" : "Testa anslutning"}
              </Button>
              {aiApiKeySet && (
                <Button type="button" variant="ghost" size="small" onClick={() => removeSecret("aiApiKey")}>
                  Ta bort nyckel
                </Button>
              )}
            </div>
          </FormRow>
          {aiTestNotice &&
            (aiTestNotice.ok ? <FormHint>{aiTestNotice.text}</FormHint> : <FormNotice>{aiTestNotice.text}</FormNotice>)}
          <FormHint>
            I läget Automatiskt när reglerna inte räcker tolkas fakturor från e-postlådan bara när avsändaren är känd —
            en leverantörs eller dess kontakters domän, eller en användares exakta adress — och e-postservern har
            verifierat avsändarens domän (DKIM eller DMARC godkänd). Andra brev väntar på knappen Tolka med AI. Högst 100
            automatiska AI-tolkningar görs per dag; därefter väntar fakturorna på knappen.
          </FormHint>
          <FormHint>
            Nyckeln är företagets egen nyckel hos Anthropic och visas aldrig här; lämna fältet tomt för att behålla den
            sparade. Testet sparar ingenting.
          </FormHint>
          <FormNotice>
            Det som skickas till AI-tjänsten (Anthropic) är fakturafilen och företagets namn och organisationsnummer —
            inget annat. Leverantörsregistret och inköpsordrarna lämnar aldrig Nav; leverantören och inköpsordern
            matchas lokalt på svaret. Inget skickas utan företagets egen API-nyckel, och inget skickas i läget Av.
          </FormNotice>

          <SectionHeading spaced>Inköpsorder</SectionHeading>
          <Field label="Matcha mot inköpsorder" htmlFor="scanPoMatching">
            <Toggle id="scanPoMatching" checked={poMatching} onChange={(e) => setPoMatching(e.target.checked)} />
          </Field>
          <FormHint>
            Med matchning föreslår tolkningen vilken inlevererad inköpsorder fakturan hör till och kopplar raderna till
            orderraderna. Av ger fria rader utan koppling.
          </FormHint>

          <SectionHeading spaced>E-postlåda</SectionHeading>
          <FormHint>
            Nav kan läsa en IMAP-låda och lägga bifogade fakturor (PDF, och JPEG/PNG när brevet saknar PDF) i
            Fakturainkorgen, högst 10 bilagor per brev. Lästa brev flyttas till mappen för inlästa, som inte får vara
            samma mapp som den som läses. Använd en egen låda för fakturor.
          </FormHint>
          <FormRow>
            <Field label="Aktiverad" htmlFor="scanMailEnabled">
              <Toggle id="scanMailEnabled" checked={mailEnabled} onChange={(e) => setMailEnabled(e.target.checked)} />
            </Field>
            <Field label="TLS" htmlFor="scanMailTls">
              <Toggle id="scanMailTls" checked={mailTls} onChange={(e) => setMailTls(e.target.checked)} />
            </Field>
          </FormRow>
          <FormHint>
            Med TLS av krävs STARTTLS — en server som inte erbjuder kryptering får aldrig lösenordet i klartext.
          </FormHint>
          <FormRow>
            <Field label="Server" htmlFor="scanMailHost">
              <Input id="scanMailHost" value={mailHost} maxLength={255} placeholder="imap.example.se" onChange={(e) => setMailHost(e.target.value)} />
            </Field>
            <Field label="Port" htmlFor="scanMailPort">
              <Input id="scanMailPort" type="number" size="xs" min="1" max="65535" step="1" value={mailPort} onChange={(e) => setMailPort(e.target.value)} />
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Användare" htmlFor="scanMailUser">
              <Input id="scanMailUser" value={mailUser} maxLength={320} autoComplete="off" onChange={(e) => setMailUser(e.target.value)} />
            </Field>
            <Field label="Lösenord" htmlFor="scanMailPassword">
              <Input
                id="scanMailPassword"
                type="password"
                value={mailPassword}
                onChange={(e) => setMailPassword(e.target.value)}
                placeholder={mailPasswordSet ? "Lösenord sparat" : ""}
                autoComplete="new-password"
              />
            </Field>
          </FormRow>
          {mailPasswordSet && (
            <FormHint>
              Byter du server eller användare måste lösenordet skrivas in igen — det sparade lösenordet skickas aldrig till
              en annan server eller användare.
            </FormHint>
          )}
          {mailPasswordSet && (
            <div>
              <Button type="button" variant="ghost" size="small" onClick={() => removeSecret("mailPassword")}>
                Ta bort lösenord
              </Button>
            </div>
          )}
          <FormRow>
            <Field label="Mapp" htmlFor="scanMailFolder">
              <Input id="scanMailFolder" value={mailFolder} maxLength={200} onChange={(e) => setMailFolder(e.target.value)} />
            </Field>
            <Field label="Mapp för inlästa" htmlFor="scanMailProcessed">
              <Input id="scanMailProcessed" value={mailProcessedFolder} maxLength={200} onChange={(e) => setMailProcessedFolder(e.target.value)} />
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Intervall (minuter)" htmlFor="scanMailInterval">
              <Input id="scanMailInterval" type="number" size="xs" min="1" max="60" step="1" value={mailInterval} onChange={(e) => setMailInterval(e.target.value)} />
            </Field>
            <div className={styles.actionsRow}>
              <Button type="button" variant="secondary" disabled={mailTesting} onClick={testMail}>
                {mailTesting ? "Testar…" : "Testa anslutning"}
              </Button>
            </div>
          </FormRow>
          {mailTestNotice &&
            (mailTestNotice.ok ? <FormHint>{mailTestNotice.text}</FormHint> : <FormNotice>{mailTestNotice.text}</FormNotice>)}
          <FormHint>
            {lastRunAt ? `Senaste körning: ${formatStockholmDateTime(lastRunAt)}` : "E-postlådan har inte lästs ännu"}
          </FormHint>
          {lastError && <FormNotice>Senaste körningen misslyckades: {lastError}</FormNotice>}

          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {saved && <span className={cardStyles.saved}>Sparat</span>}
          </FormActions>
        </Form>
      </div>

      <MailLogCard />
    </div>
  );
}

function MailLogCard() {
  const [rows, setRows] = useState<InvoiceScanMailLogRow[] | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "unavailable" | "error">("loading");

  async function load() {
    setState("loading");
    try {
      const res = await apiFetch<{ rows: InvoiceScanMailLogRow[] }>("/api/v1/settings/invoice-scan/mail-log?limit=50");
      setRows(res.rows);
      setState("ok");
    } catch (err) {
      // The log route is built after the settings; an older API answers 404.
      setState(err instanceof ApiError && err.status === 404 && !err.code ? "unavailable" : "error");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className={cardStyles.card} style={{ maxWidth: "none" }}>
      <SectionHeading
        actions={
          <Button type="button" variant="secondary" size="small" disabled={state === "loading"} onClick={() => void load()}>
            Uppdatera
          </Button>
        }
      >
        Senast lästa brev
      </SectionHeading>
      {state === "loading" && <FormHint>Hämtar loggen…</FormHint>}
      {state === "unavailable" && <FormHint>Loggen över lästa brev finns inte i den här versionen av Nav.</FormHint>}
      {state === "error" && <FormError>Kunde inte hämta loggen</FormError>}
      {state === "ok" && rows && (
        <div className={styles.logTable}>
          <Table<InvoiceScanMailLogRow>
            columns={[
              { key: "runAt", label: "Körd", width: "150px" },
              { key: "emailFrom", label: "Avsändare", width: "minmax(0, 1fr)" },
              { key: "emailSubject", label: "Ämne", width: "minmax(0, 1.2fr)" },
              { key: "outcome", label: "Resultat", width: "minmax(130px, 0.8fr)" },
              { key: "detail", label: "Detalj", width: "minmax(0, 1fr)" },
            ]}
            rows={rows}
            emptyText="Inga brev har lästs ännu"
            renderCell={(row, key) => {
              switch (key) {
                case "runAt":
                  return formatStockholmDateTime(row.runAt);
                case "emailFrom":
                  return <span className={styles.logCell}>{row.emailFrom ?? "–"}</span>;
                case "emailSubject":
                  return <span className={styles.logCell}>{row.emailSubject ?? "–"}</span>;
                case "outcome":
                  return (
                    <StatusPill
                      status={INVOICE_SCAN_MAIL_OUTCOME_PILL[row.outcome]}
                      label={INVOICE_SCAN_MAIL_OUTCOME_LABELS[row.outcome]}
                      compact
                    />
                  );
                case "detail":
                  return (
                    <span className={styles.logCell}>
                      {row.detail ?? ""}
                      {row.scanIds.map((id, i) => (
                        <span key={id}>
                          {row.detail || i > 0 ? " " : ""}
                          <Link href={`/inkop/fakturainkorg/${id}`}>
                            {row.scanIds.length > 1 ? `Öppna faktura ${i + 1}` : "Öppna faktura"}
                          </Link>
                        </span>
                      ))}
                      {!row.detail && row.scanIds.length === 0 ? "–" : ""}
                    </span>
                  );
                default:
                  return null;
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
