"use client";

import { useState, type FormEvent } from "react";
import { Button } from "../ui/Button";
import { ArticlePicker, type ArticlePickerValue } from "../ui/ArticlePicker";
import { Field, Input, Select, Toggle } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { SectionHeading } from "../ui/SectionHeading";
import { Table } from "../ui/Table";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { formatDateTime, shippingErrorText, WEEKDAYS } from "../../lib/shipping";
import type { FreightProduct, FreightSettings, PickupTime } from "../../lib/types";
import cardStyles from "../system/SettingsForm.module.css";

// Fraktinställningar (admin). The API key is write-only: blank keeps the
// stored key, "Ta bort nyckel" removes it.
export function FreightSettingsForm({
  initial,
  pickupTimes: initialPickupTimes,
  products: initialProducts,
  freightArticle,
}: {
  initial: FreightSettings;
  pickupTimes: PickupTime[];
  products: FreightProduct[];
  freightArticle: ArticlePickerValue | null;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [environment, setEnvironment] = useState(initial.environment);
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(initial.apiKeySet);
  const [contactName, setContactName] = useState(initial.senderContactName);
  const [phone, setPhone] = useState(initial.senderPhone);
  const [email, setEmail] = useState(initial.senderEmail);
  const [markupPercent, setMarkupPercent] = useState(String(initial.markupPercent));
  const [markupAmount, setMarkupAmount] = useState(String(initial.markupAmount));
  const [priceChange, setPriceChange] = useState(String(initial.priceChangePercent));
  const [trackingInterval, setTrackingInterval] = useState(initial.trackingInterval);
  const [lastRun, setLastRun] = useState(initial.lastTrackingRunAt);
  const [article, setArticle] = useState<ArticlePickerValue | null>(freightArticle);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const byDay = new Map(initialPickupTimes.map((t) => [t.weekday, t]));
  const [days, setDays] = useState(
    WEEKDAYS.map((d) => ({
      weekday: d.weekday,
      on: byDay.has(d.weekday),
      timeFrom: byDay.get(d.weekday)?.timeFrom ?? "08:00",
      timeTo: byDay.get(d.weekday)?.timeTo ?? "16:00",
    }))
  );
  const [daysError, setDaysError] = useState<string | null>(null);
  const [daysSaved, setDaysSaved] = useState(false);

  const [products, setProducts] = useState(initialProducts);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const updated = await apiFetch<FreightSettings>("/api/v1/freight-settings", {
        method: "PATCH",
        body: JSON.stringify({
          enabled,
          environment,
          apiKey,
          senderContactName: contactName,
          senderPhone: phone,
          senderEmail: email,
          markupPercent: Number(markupPercent),
          markupAmount: Number(markupAmount),
          priceChangePercent: Number(priceChange),
          freightArticleId: article?.id ?? null,
          trackingInterval,
        }),
      });
      setApiKeySet(updated.apiKeySet);
      setLastRun(updated.lastTrackingRunAt);
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
      const updated = await apiFetch<FreightSettings>("/api/v1/freight-settings", { method: "PATCH", body: JSON.stringify({ apiKey: null }) });
      setApiKeySet(updated.apiKeySet);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte ta bort nyckeln"));
    }
  }

  async function saveDays() {
    setDaysError(null);
    setDaysSaved(false);
    try {
      await apiFetch<PickupTime[]>("/api/v1/freight-settings/pickup-times", {
        method: "PUT",
        body: JSON.stringify({
          pickupTimes: days.filter((d) => d.on).map(({ weekday, timeFrom, timeTo }) => ({ weekday, timeFrom, timeTo })),
        }),
      });
      setDaysSaved(true);
    } catch (err) {
      setDaysError(apiErrorMessage(err, "Kunde inte spara upphämtningstiderna"));
    }
  }

  async function testConnection() {
    setNotice(null);
    setBusy(true);
    try {
      const { team } = await apiFetch<{ team: string | null }>("/api/v1/freight-settings/test", {
        method: "POST",
        body: JSON.stringify({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), environment }),
      });
      setNotice(`Anslutningen fungerar${team ? ` — konto: ${team}` : ""}`);
    } catch (err) {
      setNotice(shippingErrorText(err, "Anslutningen misslyckades"));
    } finally {
      setBusy(false);
    }
  }

  async function fetchProducts() {
    setNotice(null);
    setBusy(true);
    try {
      const result = await apiFetch<{ created: number; total: number }>("/api/v1/freight-settings/fetch-products", { method: "POST" });
      setProducts(await apiFetch<FreightProduct[]>("/api/v1/freight-products"));
      setNotice(`${result.created} nya transportörsprodukter, ${result.total} totalt`);
    } catch (err) {
      setNotice(shippingErrorText(err, "Kunde inte hämta transportörsprodukter"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={cardStyles.card}>
        <Form onSubmit={save}>
          <div>
            <div className={cardStyles.label}>Sendify</div>
            <div className={cardStyles.description}>
              Transportbokning via Sendify. API-nyckeln skapas i Sendify under Settings → API och visas aldrig här;
              lämna fältet tomt för att behålla den sparade.
            </div>
          </div>
          <FormError>{error}</FormError>
          <FormRow>
            <Field label="Aktiverad" htmlFor="freightEnabled">
              <Toggle id="freightEnabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            </Field>
            <Field label="Miljö" htmlFor="freightEnvironment">
              <Select id="freightEnvironment" value={environment} onChange={(e) => setEnvironment(e.target.value as "sandbox" | "production")}>
                <option value="sandbox">Sandlåda</option>
                <option value="production">Produktion</option>
              </Select>
            </Field>
          </FormRow>
          <FormRow>
            <Field label="API-nyckel" htmlFor="freightApiKey">
              <Input
                id="freightApiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiKeySet ? "Nyckel sparad" : ""}
                autoComplete="new-password"
              />
            </Field>
            {apiKeySet && (
              <Button type="button" variant="ghost" size="small" onClick={removeKey}>
                Ta bort nyckel
              </Button>
            )}
          </FormRow>
          <FormRow>
            <Field label="Avsändarkontakt" htmlFor="freightContact">
              <Input id="freightContact" value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </Field>
            <Field label="Telefon" htmlFor="freightPhone">
              <Input id="freightPhone" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="E-post" htmlFor="freightEmail">
              <Input id="freightEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </FormRow>
          <FormHint>Avsändarens adress hämtas från Företagsinformation. Tom telefon/e-post = företagets.</FormHint>
          <FormRow>
            <Field label="Påslag (%)" htmlFor="freightMarkupPercent">
              <Input id="freightMarkupPercent" type="number" size="xs" min="0" step="0.01" value={markupPercent} onChange={(e) => setMarkupPercent(e.target.value)} />
            </Field>
            <Field label="Påslag (kr)" htmlFor="freightMarkupAmount">
              <Input id="freightMarkupAmount" type="number" size="xs" min="0" step="0.01" value={markupAmount} onChange={(e) => setMarkupAmount(e.target.value)} />
            </Field>
            <Field label="Bekräfta prisändring över (%)" htmlFor="freightPriceChange">
              <Input id="freightPriceChange" type="number" size="xs" min="0" step="0.01" value={priceChange} onChange={(e) => setPriceChange(e.target.value)} />
            </Field>
          </FormRow>
          <Field label="Fraktartikel" htmlFor="freightArticle">
            <ArticlePicker id="freightArticle" value={article} onChange={setArticle} />
          </Field>
          <FormHint>Artikeln som frakten faktureras som — på fakturans fraktrader och vid Lägg till frakt.</FormHint>
          <Field label="Spårningsintervall" htmlFor="freightTrackingInterval">
            <Select id="freightTrackingInterval" value={trackingInterval} onChange={(e) => setTrackingInterval(e.target.value as FreightSettings["trackingInterval"])}>
              <option value="hourly">Varje timme</option>
              <option value="every_4h">Var fjärde timme</option>
              <option value="daily">Dagligen</option>
            </Select>
          </Field>
          <FormHint>{lastRun ? `Senaste spårningskörning: ${formatDateTime(lastRun)}` : "Spårningen har inte körts ännu"}</FormHint>
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {saved && <span className={cardStyles.saved}>Sparat</span>}
          </FormActions>
        </Form>
      </div>

      <div className={cardStyles.card} style={{ marginTop: 18 }}>
        <SectionHeading>Upphämtningstider</SectionHeading>
        <FormHint>
          En dag utan kryss har ingen upphämtning. Röda dagar i helgdagslistan har aldrig upphämtning.
        </FormHint>
        <FormError>{daysError}</FormError>
        {days.map((d, i) => (
          <FormRow key={d.weekday}>
            <Field label={WEEKDAYS[i]!.label} htmlFor={`pickupOn${d.weekday}`}>
              <Toggle
                id={`pickupOn${d.weekday}`}
                checked={d.on}
                onChange={(e) => setDays(days.map((x) => (x.weekday === d.weekday ? { ...x, on: e.target.checked } : x)))}
              />
            </Field>
            <Field label="Från" htmlFor={`pickupFrom${d.weekday}`}>
              <Input id={`pickupFrom${d.weekday}`} type="time" size="sm" disabled={!d.on} value={d.timeFrom} onChange={(e) => setDays(days.map((x) => (x.weekday === d.weekday ? { ...x, timeFrom: e.target.value } : x)))} />
            </Field>
            <Field label="Till" htmlFor={`pickupTo${d.weekday}`}>
              <Input id={`pickupTo${d.weekday}`} type="time" size="sm" disabled={!d.on} value={d.timeTo} onChange={(e) => setDays(days.map((x) => (x.weekday === d.weekday ? { ...x, timeTo: e.target.value } : x)))} />
            </Field>
          </FormRow>
        ))}
        <FormActions>
          <Button type="button" variant="primary" onClick={saveDays}>
            Spara upphämtningstider
          </Button>
          {daysSaved && <span className={cardStyles.saved}>Sparat</span>}
        </FormActions>
      </div>

      <div className={cardStyles.card} style={{ marginTop: 18 }}>
        <SectionHeading
          actions={
            <>
              <Button type="button" variant="secondary" disabled={busy} onClick={testConnection}>
                Testa anslutning
              </Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={fetchProducts}>
                Hämta transportörsprodukter
              </Button>
            </>
          }
        >
          Fraktprodukter
        </SectionHeading>
        {notice && <FormHint>{notice}</FormHint>}
        <Table<FreightProduct>
          columns={[
            { key: "carrierName", label: "Transportör", width: "1fr" },
            { key: "productName", label: "Produkt", width: "2fr" },
          ]}
          rows={products}
          emptyText="Inga fraktprodukter ännu — hämta dem eller hämta priser på en försändelse"
          renderCell={(p, key) => (key === "carrierName" ? p.carrierName : p.productName)}
        />
      </div>
    </>
  );
}
