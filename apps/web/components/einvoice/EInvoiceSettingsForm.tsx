"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button } from "../ui/Button";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatStockholmDateTime } from "../../lib/date";
import { einvoiceErrorText, type EInvoiceCompany, type EInvoiceEnvironment, type EInvoiceSettings } from "../../lib/einvoice";
import cardStyles from "../system/SettingsForm.module.css";

// E-fakturainställningar (admin). Like the freight form the API key is
// write-only: blank keeps the stored key, "Ta bort nyckel" removes it. The
// account is never typed — Testa anslutning asks B2Brouter which account the
// key belongs to (saving nothing) and Spara stores that account's id and
// name together, so the two can never drift apart.
// Uppercase, no spaces — how both Nav and B2Brouter print a VAT id.
const normalizeVat = (value: string | null | undefined) => (value ?? "").replace(/\s/g, "").toUpperCase() || null;

export function EInvoiceSettingsForm({ initial }: { initial: EInvoiceSettings }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [environment, setEnvironment] = useState<EInvoiceEnvironment>(initial.environment);
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(initial.apiKeySet);
  const [accountId, setAccountId] = useState(initial.accountId);
  const [accountName, setAccountName] = useState(initial.accountName);
  const [interval, setIntervalMinutes] = useState(String(initial.statusIntervalMinutes));
  const [lastRun, setLastRun] = useState(initial.lastStatusRunAt);
  const [company, setCompany] = useState<EInvoiceCompany>(initial.company);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [vatWarning, setVatWarning] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  function apply(updated: EInvoiceSettings) {
    setEnabled(updated.enabled);
    setEnvironment(updated.environment);
    setApiKeySet(updated.apiKeySet);
    setAccountId(updated.accountId);
    setAccountName(updated.accountName);
    setIntervalMinutes(String(updated.statusIntervalMinutes));
    setLastRun(updated.lastStatusRunAt);
    setCompany(updated.company);
  }

  // A different key or environment belongs to another B2Brouter account, so
  // the stored one no longer applies until Testa anslutning has run again.
  function forgetAccount() {
    setAccountId(null);
    setAccountName(null);
    setNotice(null);
    setVatWarning(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const minutes = Number(interval);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
      setError("Statusintervallet måste vara ett heltal mellan 5 och 1440 minuter");
      return;
    }
    setPending(true);
    try {
      const updated = await apiFetch<EInvoiceSettings>("/api/v1/einvoice-settings", {
        method: "PATCH",
        body: JSON.stringify({ enabled, environment, apiKey, accountId, accountName, statusIntervalMinutes: minutes }),
      });
      apply(updated);
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara inställningarna"));
    } finally {
      setPending(false);
    }
  }

  async function removeKey() {
    setError(null);
    try {
      const updated = await apiFetch<EInvoiceSettings>("/api/v1/einvoice-settings", {
        method: "PATCH",
        body: JSON.stringify({ apiKey: null, accountId: null }),
      });
      apply(updated);
      setVatWarning(null);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort nyckeln"));
    }
  }

  async function testConnection() {
    setNotice(null);
    setVatWarning(null);
    setTesting(true);
    try {
      const result = await apiFetch<{ accountId: string; accountName: string; vatNumber: string | null; environment: EInvoiceEnvironment }>(
        "/api/v1/einvoice-settings/test",
        { method: "POST", body: JSON.stringify({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), environment }) }
      );
      setAccountId(result.accountId);
      setAccountName(result.accountName);
      setNotice(`Anslutningen fungerar — konto: ${result.accountName}. Spara för att använda kontot.`);
      // B2Brouter refuses an import whose seller VAT id is not the
      // account's own — say so now rather than at the first send.
      const accountVat = normalizeVat(result.vatNumber);
      const companyVat = normalizeVat(company.vatNumber);
      if (accountVat && companyVat && accountVat !== companyVat) {
        setVatWarning(
          `Momsnumret på B2Brouter-kontot (${accountVat}) skiljer sig från Företagsuppgifter (${companyVat}) — B2Brouter vägrar då fakturorna.`
        );
      }
    } catch (err) {
      setNotice(einvoiceErrorText(err, "Anslutningen misslyckades"));
    } finally {
      setTesting(false);
    }
  }

  const companyRows: [string, string | null][] = [
    ["Företag", company.name],
    ["Organisationsnummer", company.orgNumber],
    ["VAT-nummer", company.vatNumber],
    ["Adress", [company.address, [company.postalCode, company.city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null],
    ["Bankgiro", company.bankgiro],
    ["Plusgiro", company.plusgiro],
    ["IBAN", company.iban],
    ["BIC", company.bic],
  ];

  return (
    <>
      <div className={cardStyles.card}>
        <Form onSubmit={save}>
          <div>
            <div className={cardStyles.label}>B2Brouter</div>
            <div className={cardStyles.description}>
              E-faktura via Peppol skickas genom B2Brouter. API-nyckeln skapas i B2Brouter och visas aldrig här; lämna
              fältet tomt för att behålla den sparade.
            </div>
          </div>
          <FormError>{error}</FormError>
          <FormRow>
            <Field label="Aktiverad" htmlFor="einvoiceEnabled">
              <Toggle id="einvoiceEnabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            </Field>
            <Field label="Miljö" htmlFor="einvoiceEnvironment">
              <Select
                id="einvoiceEnvironment"
                value={environment}
                onChange={(e) => {
                  setEnvironment(e.target.value as EInvoiceEnvironment);
                  forgetAccount();
                }}
              >
                <option value="sandbox">Sandbox</option>
                <option value="production">Produktion</option>
              </Select>
            </Field>
          </FormRow>
          <FormRow>
            <Field label="API-nyckel" htmlFor="einvoiceApiKey">
              <Input
                id="einvoiceApiKey"
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  forgetAccount();
                }}
                placeholder={apiKeySet ? "Nyckel sparad" : ""}
                autoComplete="new-password"
              />
            </Field>
            {apiKeySet && (
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <Button type="button" variant="ghost" size="small" onClick={removeKey}>
                  Ta bort nyckel
                </Button>
              </div>
            )}
          </FormRow>
          <FormRow>
            <Field label="Konto" htmlFor="einvoiceAccount">
              <Input
                id="einvoiceAccount"
                readOnly
                value={accountName ?? (accountId ? `Konto ${accountId}` : "")}
                placeholder="Välj genom Testa anslutning"
              />
            </Field>
            {/* Bottom-aligned at its natural size, not stretched by the grid row. */}
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <Button type="button" variant="secondary" disabled={testing} onClick={testConnection}>
                {testing ? "Testar…" : "Testa anslutning"}
              </Button>
            </div>
          </FormRow>
          {notice && <FormHint>{notice}</FormHint>}
          {vatWarning && <FormNotice>{vatWarning}</FormNotice>}
          <Field label="Statusintervall (minuter)" htmlFor="einvoiceInterval">
            <Input
              id="einvoiceInterval"
              type="number"
              size="xs"
              min="5"
              max="1440"
              step="1"
              value={interval}
              onChange={(e) => setIntervalMinutes(e.target.value)}
            />
          </Field>
          <FormHint>
            {lastRun ? `Senaste statuskörning: ${formatStockholmDateTime(lastRun)}` : "Statusjobbet har inte körts ännu"}
          </FormHint>
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {saved && <span className={cardStyles.saved}>Sparat</span>}
          </FormActions>
        </Form>
      </div>

      <div className={cardStyles.card} style={{ marginTop: 18 }}>
        <SectionHeading>Företagsuppgifter som skickas</SectionHeading>
        <FormHint>
          Uppgifterna hämtas från{" "}
          <Link href="/system/foretagsinfo">Företagsinformation</Link> och skrivs i e-fakturan som säljare.
        </FormHint>
        {company.problems.map((problem) => (
          <FormNotice key={problem} style={{ marginTop: 8 }}>
            {problem}
          </FormNotice>
        ))}
        <dl style={{ margin: "12px 0 0", display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 16px" }}>
          {companyRows.map(([label, value]) => (
            <div key={label} style={{ display: "contents" }}>
              <dt style={{ color: "var(--color-text-secondary)" }}>{label}</dt>
              <dd style={{ margin: 0 }}>{value || "–"}</dd>
            </div>
          ))}
        </dl>
      </div>
    </>
  );
}
