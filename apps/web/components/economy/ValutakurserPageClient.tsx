"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { SectionHeading } from "../ui/SectionHeading";
import { Field, Input, Select } from "../ui/Field";
import { Form, FormActions, FormError, FormHint, FormNotice, FormRow, FormSaved } from "../ui/Form";
import { HelpLink } from "../ui/HelpLink";
import { ListFilterSelect, ListToolbar, Pagination, useListNavigation } from "../ui/ListControls";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { COMMON_CURRENCIES, formatRate } from "../../lib/currency";
import { addDaysIso, formatStockholmDate, stockholmToday } from "../../lib/date";
import { apiErrorMessage } from "../../lib/errorMessages";
import type { ExchangeRateEntry, ExchangeRateFetchResult, ExchangeRateSettings, Paged } from "../../lib/types";
import shellStyles from "../AppShell.module.css";

const SOURCE_LABELS: Record<ExchangeRateEntry["source"], string> = {
  riksbank: "Riksbanken",
  manual: "Manuell",
};

// Riksbankens villkor: a rate fetched from them is shown with its source.
const RIKSBANK_CREDIT = "Källa: Sveriges Riksbank";

// The most days one Hämta från Riksbanken may cover (the API refuses more).
const MAX_FETCH_DAYS = 93;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// Date-range filter bound to ?from=&to= — same idiom as the Händelselogg.
function DateRangeFilter() {
  const { params, setFilter } = useListNavigation();
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
      <Field label="Från" htmlFor="ratesFrom">
        <Input id="ratesFrom" type="date" size="sm" value={params.get("from") ?? ""} onChange={(e) => setFilter("from", e.target.value || null)} />
      </Field>
      <Field label="Till" htmlFor="ratesTo">
        <Input id="ratesTo" type="date" size="sm" value={params.get("to") ?? ""} onChange={(e) => setFilter("to", e.target.value || null)} />
      </Field>
    </div>
  );
}

export function ValutakurserPageClient({
  rates,
  settings,
  pageSize,
}: {
  rates: Paged<ExchangeRateEntry>;
  // null for anyone but an administrator (the settings are admin-only).
  settings: ExchangeRateSettings | null;
  pageSize: number;
}) {
  const router = useRouter();
  const [fetchOpen, setFetchOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const hasRiksbankRates = rates.rows.some((rate) => rate.source === "riksbank");

  return (
    <>
      <datalist id="currencySuggestions">
        {COMMON_CURRENCIES.map((code) => (
          <option key={code} value={code} />
        ))}
      </datalist>

      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Valutakurser</div>
          <div className={shellStyles.meta}>{rates.total.toLocaleString("sv-SE")} kurser</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <Button type="button" variant="secondary" onClick={() => setFetchOpen(true)}>
            Hämta från Riksbanken
          </Button>
          <Button type="button" variant="primary" onClick={() => setNewOpen(true)}>
            + Ny kurs
          </Button>
          <HelpLink chapter="ekonomi" anchor="valutakurser" label="Hjälp om valutakurser" />
        </div>
      </div>

      {notice && <FormNotice style={{ marginBottom: 14 }}>{notice}</FormNotice>}

      <ListToolbar placeholder="Valuta, t.ex. EUR…">
        <ListFilterSelect
          param="source"
          allLabel="Alla källor"
          ariaLabel="Filtrera på källa"
          options={Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label }))}
        />
        <DateRangeFilter />
      </ListToolbar>

      <Table<ExchangeRateEntry>
        columns={[
          { key: "date", label: "Datum", width: "120px" },
          { key: "currency", label: "Valuta", width: "90px" },
          { key: "rate", label: "Kurs (SEK per enhet)", width: "170px", align: "right" },
          { key: "source", label: "Källa", width: "120px" },
          { key: "createdByName", label: "Inlagd av", width: "1fr" },
          { key: "updatedAt", label: "Ändrad", width: "120px" },
        ]}
        rows={rates.rows}
        emptyText="Inga kurser matchar sökningen — hämta kurser från Riksbanken eller lägg in en egen kurs."
        renderCell={(rate, key) => {
          switch (key) {
            case "date":
              return rate.date;
            case "currency":
              return rate.currency;
            case "rate":
              return formatRate(rate.rate);
            case "source":
              return SOURCE_LABELS[rate.source];
            case "createdByName":
              return rate.createdByName ?? "–";
            case "updatedAt":
              return formatStockholmDate(rate.updatedAt);
            default:
              return null;
          }
        }}
      />
      {hasRiksbankRates && (
        <FormHint style={{ marginTop: 10 }}>
          {RIKSBANK_CREDIT}. Kurserna märkta Riksbanken är Riksbankens dagskurser (SEK per 1 enhet av valutan, senaste
          bankdag).
        </FormHint>
      )}

      <Pagination total={rates.total} pageSize={pageSize} />

      {settings && <SettingsCard settings={settings} />}

      <Modal open={fetchOpen} onClose={() => setFetchOpen(false)} title="Hämta från Riksbanken">
        <FetchForm
          onDone={(message) => {
            setFetchOpen(false);
            setNotice(message);
            router.refresh();
          }}
        />
      </Modal>
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="Ny kurs">
        <NewRateForm
          onDone={(message) => {
            setNewOpen(false);
            setNotice(message);
            router.refresh();
          }}
        />
      </Modal>
    </>
  );
}

function FetchForm({ onDone }: { onDone: (message: string) => void }) {
  const [currency, setCurrency] = useState("EUR");
  const [from, setFrom] = useState(() => addDaysIso(stockholmToday(), -30));
  const [to, setTo] = useState(() => stockholmToday());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (from > to) {
      setError("Från-datumet får inte vara efter till-datumet.");
      return;
    }
    if (daysBetween(from, to) > MAX_FETCH_DAYS) {
      setError(`Högst ${MAX_FETCH_DAYS} dagar åt gången.`);
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await apiFetch<ExchangeRateFetchResult>("/api/v1/exchange-rates/fetch", {
        method: "POST",
        body: JSON.stringify({ currency: currency.trim().toUpperCase(), from, to }),
      });
      onDone(
        result.fetched === 0
          ? `Riksbanken har inga kurser för ${result.currency} ${from} – ${to} (inga bankdagar i perioden, eller så publicerar Riksbanken inte valutan) — lägg in en egen kurs med Ny kurs.`
          : `${result.fetched.toLocaleString("sv-SE")} kurser för ${result.currency} hämtade (${from} – ${to}). ${RIKSBANK_CREDIT}.`
      );
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte hämta kurserna"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <Field label="Valuta" htmlFor="fetchCurrency">
        <Input
          id="fetchCurrency"
          size="sm"
          required
          maxLength={3}
          pattern="[A-Za-z]{3}"
          list="currencySuggestions"
          autoComplete="off"
          value={currency}
          onChange={(e) => setCurrency(e.target.value.toUpperCase())}
        />
      </Field>
      <FormRow>
        <Field label="Från" htmlFor="fetchFrom">
          <Input id="fetchFrom" type="date" size="sm" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="Till" htmlFor="fetchTo">
          <Input id="fetchTo" type="date" size="sm" required value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </FormRow>
      <FormHint>
        Hämtar Riksbankens dagskurser för alla bankdagar i perioden, högst {MAX_FETCH_DAYS} dagar åt gången. Dagens kurs
        publiceras ungefär klockan 16.15 — före dess gäller gårdagens. {RIKSBANK_CREDIT}.
      </FormHint>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Hämtar…" : "Hämta kurser"}
        </Button>
      </FormActions>
    </Form>
  );
}

function NewRateForm({ onDone }: { onDone: (message: string) => void }) {
  const [currency, setCurrency] = useState("");
  const [date, setDate] = useState(() => stockholmToday());
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const code = currency.trim().toUpperCase();
    if (code === "SEK") {
      setError("SEK har alltid kurs 1 — ange en annan valuta.");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await apiFetch<ExchangeRateEntry>("/api/v1/exchange-rates", {
        method: "POST",
        body: JSON.stringify({ currency: code, date, rate: Number(rate.replace(",", ".")) }),
      });
      onDone(`Kursen för ${code} ${date} sparades.`);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara kursen"));
      setPending(false);
    }
  }

  return (
    <Form onSubmit={submit}>
      <FormError>{error}</FormError>
      <FormRow>
        <Field label="Valuta" htmlFor="newRateCurrency">
          <Input
            id="newRateCurrency"
            size="sm"
            required
            maxLength={3}
            pattern="[A-Za-z]{3}"
            list="currencySuggestions"
            autoComplete="off"
            placeholder="EUR"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </Field>
        <Field label="Datum" htmlFor="newRateDate">
          <Input id="newRateDate" type="date" size="sm" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </FormRow>
      <Field label="Kurs (SEK per 1 enhet)" htmlFor="newRateRate">
        <Input
          id="newRateRate"
          type="number"
          min="0"
          step="any"
          size="sm"
          required
          value={rate}
          onChange={(e) => setRate(e.target.value)}
        />
        <FormHint>
          Kronor per 1 enhet av valutan — 11,131 för EUR betyder att 1 EUR kostar 11,131 kr. Högst sex decimaler. En egen
          kurs för en dag går före Riksbankens kurs för samma dag och ersätter en tidigare egen kurs den dagen.
        </FormHint>
      </Field>
      <FormActions>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Sparar…" : "Spara kurs"}
        </Button>
      </FormActions>
    </Form>
  );
}

// Källa för valutakurser + the optional Riksbanken API key (admin). The key is
// write-only: the API only says whether one is set, "" keeps it and null
// removes it.
function SettingsCard({ settings }: { settings: ExchangeRateSettings }) {
  const router = useRouter();
  const [source, setSource] = useState(settings.source);
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(settings.apiKeySet);
  const [savedSource, setSavedSource] = useState(settings.source);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const dirty = source !== savedSource || apiKey.trim() !== "";

  async function patch(body: { source?: ExchangeRateSettings["source"]; apiKey?: string | null }) {
    setError(null);
    setSaved(false);
    setPending(true);
    try {
      const updated = await apiFetch<ExchangeRateSettings>("/api/v1/exchange-rate-settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSource(updated.source);
      setSavedSource(updated.source);
      setApiKeySet(updated.apiKeySet);
      setApiKey("");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara inställningarna"));
    } finally {
      setPending(false);
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    await patch({
      ...(source !== savedSource ? { source } : {}),
      // "" keeps the stored key.
      apiKey: apiKey.trim() === "" ? "" : apiKey.trim(),
    });
  }

  async function removeKey() {
    if (!(await confirmDialog("Ta bort Riksbankens API-nyckel? Nav hämtar då kurser utan nyckel (5 anrop per minut).", { confirmLabel: "Ta bort", danger: true }))) {
      return;
    }
    await patch({ apiKey: null });
  }

  return (
    <div style={{ marginTop: 28 }}>
      <SectionHeading spaced>Inställningar</SectionHeading>
      <Card maxWidth={620}>
        <Form onSubmit={save}>
          <FormError>{error}</FormError>
          <Field label="Källa för valutakurser" htmlFor="rateSource">
            <Select id="rateSource" value={source} onChange={(e) => { setSaved(false); setSource(e.target.value as ExchangeRateSettings["source"]); }}>
              <option value="riksbank">Riksbanken</option>
              <option value="manual">Bara manuella</option>
            </Select>
            <FormHint>
              Riksbanken: Nav slår upp kursen för fakturadatumet hos Riksbanken (senaste bankdag), och en egen kurs för
              exakt den dagen går före. Bara manuella: Nav använder bara kurserna som lagts in med Ny kurs (den senaste
              inom tio dagar före datumet).
            </FormHint>
          </Field>
          <Field label="API-nyckel (Riksbanken, valfri)" htmlFor="riksbankApiKey">
            <Input
              id="riksbankApiKey"
              type="password"
              autoComplete="off"
              maxLength={200}
              placeholder={apiKeySet ? "Nyckel sparad — skriv en ny för att byta" : "Ingen nyckel"}
              value={apiKey}
              onChange={(e) => { setSaved(false); setApiKey(e.target.value); }}
            />
            <FormHint>
              Utan nyckel tar Riksbanken emot 5 anrop per minut och 1 000 per dag och IP-adress — räcker för vardagsbruk,
              eftersom Nav sparar kurserna. Nyckeln visas aldrig igen efter att den sparats.
              {apiKeySet ? " En nyckel är sparad." : ""}
            </FormHint>
          </Field>
          <FormActions>
            <Button type="submit" variant="primary" disabled={pending || !dirty}>
              {pending ? "Sparar…" : "Spara"}
            </Button>
            {apiKeySet && (
              <Button type="button" variant="ghost" disabled={pending} onClick={removeKey}>
                Ta bort nyckel
              </Button>
            )}
            {saved && <FormSaved>Sparat</FormSaved>}
          </FormActions>
        </Form>
      </Card>
    </div>
  );
}
