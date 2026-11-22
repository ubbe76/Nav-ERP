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
import { confirmDialog } from "../../lib/confirm";
import { BROKER_LABELS, formatDateTime, shippingErrorText, WEEKDAYS } from "../../lib/shipping";
import { BrokerChoice, NshiftCard, ShipmondoCard, brokersOn } from "./BrokerSettings";
import type { FreightProduct, FreightSettings, PickupTime } from "../../lib/types";
import cardStyles from "../system/SettingsForm.module.css";

// Fraktinställningar (admin). Förmedlare first: only the brokers switched on
// there get their cards (Sendify, nShift, Shipmondo); Gemensamt holds what all
// of them share (sender, markups) and the fraktartikel, which Eget fraktsätt
// invoices too, so it is always there. Upphämtningstider and Fraktprodukter
// only matter with a broker on. The API keys are write-only: blank keeps the
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
  // The stored settings as the API last answered — which brokers are on, the
  // keys' …Set flags, the last tracking run.
  const [settings, setSettings] = useState(initial);
  const on = brokersOn(settings);
  const anyOn = on.length > 0;

  // Sendify
  const [environment, setEnvironment] = useState(initial.environment);
  // The test and the product fetch use the saved values on the server, so a
  // changed field has to be saved first.
  const [apiKey, setApiKey] = useState("");
  const [trackingInterval, setTrackingInterval] = useState(initial.trackingInterval);
  const [sendifyError, setSendifyError] = useState<string | null>(null);
  const [sendifySaved, setSendifySaved] = useState(false);
  const [sendifyPending, setSendifyPending] = useState(false);

  // Gemensamt
  const [contactName, setContactName] = useState(initial.senderContactName);
  const [phone, setPhone] = useState(initial.senderPhone);
  const [email, setEmail] = useState(initial.senderEmail);
  const [markupPercent, setMarkupPercent] = useState(String(initial.markupPercent));
  const [markupAmount, setMarkupAmount] = useState(String(initial.markupAmount));
  const [priceChange, setPriceChange] = useState(String(initial.priceChangePercent));
  const [article, setArticle] = useState<ArticlePickerValue | null>(freightArticle);
  const [commonError, setCommonError] = useState<string | null>(null);
  const [commonSaved, setCommonSaved] = useState(false);
  const [commonPending, setCommonPending] = useState(false);

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
  const [daysBusy, setDaysBusy] = useState(false);

  const [products, setProducts] = useState(initialProducts);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveSendify(e: FormEvent) {
    e.preventDefault();
    setSendifyError(null);
    setSendifySaved(false);
    setSendifyPending(true);
    try {
      setSettings(
        await apiFetch<FreightSettings>("/api/v1/freight-settings", {
          method: "PATCH",
          body: JSON.stringify({ environment, apiKey, trackingInterval }),
        })
      );
      setApiKey("");
      setSendifySaved(true);
    } catch (err) {
      setSendifyError(apiErrorMessage(err, "Kunde inte spara Sendify"));
    } finally {
      setSendifyPending(false);
    }
  }

  async function removeKey() {
    if (!(await confirmDialog("API-nyckeln tas bort och frakten slutar fungera tills en ny nyckel sparas.", { confirmLabel: "Ta bort nyckel", danger: true }))) return;
    setSendifyError(null);
    try {
      setSettings(await apiFetch<FreightSettings>("/api/v1/freight-settings", { method: "PATCH", body: JSON.stringify({ apiKey: null }) }));
    } catch (err) {
      setSendifyError(apiErrorMessage(err, "Kunde inte ta bort nyckeln"));
    }
  }

  async function saveCommon(e: FormEvent) {
    e.preventDefault();
    setCommonError(null);
    setCommonSaved(false);
    setCommonPending(true);
    try {
      setSettings(
        await apiFetch<FreightSettings>("/api/v1/freight-settings", {
          method: "PATCH",
          body: JSON.stringify({
            senderContactName: contactName,
            senderPhone: phone,
            senderEmail: email,
            markupPercent: Number(markupPercent),
            markupAmount: Number(markupAmount),
            priceChangePercent: Number(priceChange),
            freightArticleId: article?.id ?? null,
          }),
        })
      );
      setCommonSaved(true);
    } catch (err) {
      setCommonError(apiErrorMessage(err, "Kunde inte spara inställningarna"));
    } finally {
      setCommonPending(false);
    }
  }

  async function saveDays() {
    setDaysError(null);
    setDaysSaved(false);
    setDaysBusy(true);
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
    } finally {
      setDaysBusy(false);
    }
  }

  async function testConnection() {
    setNotice(null);
    setNoticeError(null);
    setBusy(true);
    try {
      const { team } = await apiFetch<{ team: string | null }>("/api/v1/freight-settings/test", {
        method: "POST",
        body: JSON.stringify({ ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), environment }),
      });
      setNotice(`Anslutningen fungerar${team ? ` — konto: ${team}` : ""}`);
    } catch (err) {
      setNoticeError(shippingErrorText(err, "Anslutningen misslyckades"));
    } finally {
      setBusy(false);
    }
  }

  async function fetchProducts() {
    setNotice(null);
    setNoticeError(null);
    setBusy(true);
    try {
      const result = await apiFetch<{ created: number; total: number }>("/api/v1/freight-settings/fetch-products", { method: "POST" });
      setProducts(await apiFetch<FreightProduct[]>("/api/v1/freight-products"));
      setNotice(`${result.created} nya transportörsprodukter, ${result.total} totalt`);
    } catch (err) {
      setNoticeError(shippingErrorText(err, "Kunde inte hämta transportörsprodukter"));
    } finally {
      setBusy(false);
    }
  }


  // Sendify's Hämta produkter always uses the stored key and environment.
  const unsavedConnection = apiKey.trim() !== "" || environment !== settings.environment;

  return (
    <>
      <BrokerChoice settings={settings} onSaved={setSettings} />

      {on.includes("sendify") && (
        <div className={cardStyles.card} style={{ marginTop: 18 }}>
          <Form onSubmit={saveSendify}>
            <div>
              <div className={cardStyles.label}>Sendify</div>
              <div className={cardStyles.description}>
                API-nyckeln skapas i Sendify under Settings → API och visas aldrig här; lämna fältet tomt för att behålla den sparade.
              </div>
            </div>
            <FormError>{sendifyError}</FormError>
            <FormRow>
              <Field label="Miljö" htmlFor="freightEnvironment">
                <Select id="freightEnvironment" value={environment} onChange={(e) => setEnvironment(e.target.value as "sandbox" | "production")}>
                  <option value="sandbox">Sandlåda</option>
                  <option value="production">Produktion</option>
                </Select>
              </Field>
              <Field label="API-nyckel" htmlFor="freightApiKey">
                <Input
                  id="freightApiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={settings.apiKeySet ? "Nyckel sparad" : ""}
                  autoComplete="new-password"
                />
              </Field>
              {settings.apiKeySet && (
                <Button type="button" variant="ghost" size="small" onClick={removeKey}>
                  Ta bort nyckel
                </Button>
              )}
            </FormRow>
            <Field label="Spårningsintervall" htmlFor="freightTrackingInterval">
              <Select id="freightTrackingInterval" value={trackingInterval} onChange={(e) => setTrackingInterval(e.target.value as FreightSettings["trackingInterval"])}>
                <option value="hourly">Varje timme</option>
                <option value="every_4h">Var fjärde timme</option>
                <option value="daily">Dagligen</option>
              </Select>
            </Field>
            <FormHint>
              {settings.lastTrackingRunAt ? `Senaste spårningskörning: ${formatDateTime(settings.lastTrackingRunAt)}` : "Spårningen har inte körts ännu"}
            </FormHint>
            <FormActions>
              <Button type="submit" variant="primary" disabled={sendifyPending}>
                {sendifyPending ? "Sparar…" : "Spara Sendify"}
              </Button>
              <Button type="button" variant="secondary" disabled={busy} onClick={testConnection}>
                Testa anslutning
              </Button>
              <Button type="button" variant="secondary" disabled={busy || unsavedConnection || !settings.apiKeySet} onClick={fetchProducts}>
                Hämta produkter
              </Button>
              {sendifySaved && <span className={cardStyles.saved}>Sparat</span>}
            </FormActions>
            {(unsavedConnection || !settings.apiKeySet) && (
              <FormHint>
                {!settings.apiKeySet
                  ? "Spara en API-nyckel för att hämta transportörsprodukter."
                  : "Hämta produkter använder den sparade nyckeln och miljön — spara ändringarna först."}
              </FormHint>
            )}
            <FormError>{noticeError}</FormError>
            {notice && <FormHint>{notice}</FormHint>}
          </Form>
        </div>
      )}

      {on.includes("nshift") && <NshiftCard settings={settings} onSaved={setSettings} products={products} onProducts={setProducts} />}
      {on.includes("shipmondo") && <ShipmondoCard settings={settings} onSaved={setSettings} products={products} onProducts={setProducts} />}

      <div className={cardStyles.card} style={{ marginTop: 18 }}>
        <Form onSubmit={saveCommon}>
          <div>
            <div className={cardStyles.label}>Gemensamt</div>
            <div className={cardStyles.description}>
              {anyOn ? "Gäller alla förmedlare. Fraktartikeln gäller även Eget fraktsätt." : "Fraktartikeln gäller Eget fraktsätt och fraktrader på fakturan."}
            </div>
          </div>
          <FormError>{commonError}</FormError>
          {anyOn && (
            <>
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
            </>
          )}
          <Field label="Fraktartikel" htmlFor="freightArticle">
            <ArticlePicker id="freightArticle" value={article} onChange={setArticle} />
          </Field>
          <FormHint>Artikeln som frakten faktureras som — på fakturans fraktrader och vid Lägg till frakt.</FormHint>
          <FormActions>
            <Button type="submit" variant="primary" disabled={commonPending}>
              {commonPending ? "Sparar…" : "Spara"}
            </Button>
            {commonSaved && <span className={cardStyles.saved}>Sparat</span>}
          </FormActions>
        </Form>
      </div>

      {anyOn && (
        <div className={cardStyles.card} style={{ marginTop: 18 }}>
          <SectionHeading>Upphämtningstider</SectionHeading>
          <FormHint>En dag utan kryss har ingen upphämtning. Röda dagar i helgdagslistan har aldrig upphämtning.</FormHint>
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
            <Button type="button" variant="primary" onClick={saveDays} disabled={daysBusy}>
              Spara upphämtningstider
            </Button>
            {daysSaved && <span className={cardStyles.saved}>Sparat</span>}
          </FormActions>
        </div>
      )}

      {anyOn && (
        <div className={cardStyles.card} style={{ marginTop: 18 }}>
          <SectionHeading>Fraktprodukter</SectionHeading>
          <Table<FreightProduct>
            columns={[
              { key: "provider", label: "Förmedlare", width: "120px" },
              { key: "carrierName", label: "Transportör", width: "1fr" },
              { key: "productName", label: "Produkt", width: "2fr" },
            ]}
            rows={products}
            emptyText="Inga fraktprodukter ännu — hämta dem under förmedlaren eller hämta priser på en försändelse"
            renderCell={(p, key) =>
              key === "provider"
                ? (BROKER_LABELS[p.provider as keyof typeof BROKER_LABELS] ?? p.provider)
                : key === "carrierName"
                  ? p.carrierName
                  : p.productName
            }
          />
        </div>
      )}
    </>
  );
}
