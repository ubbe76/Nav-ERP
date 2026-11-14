"use client";

import { useState, type ReactNode } from "react";
import { Button } from "../ui/Button";
import { Checkbox, Field, Input, Select, Toggle } from "../ui/Field";
import { FormActions, FormError, FormHint, FormRow } from "../ui/Form";
import { apiFetch } from "../../lib/api";
import { apiErrorMessage } from "../../lib/errorMessages";
import { BROKER_LABELS, FREIGHT_BROKERS, shippingErrorText } from "../../lib/shipping";
import type { FreightBroker, FreightProduct, FreightSettings } from "../../lib/types";
import cardStyles from "../system/SettingsForm.module.css";
import styles from "./BrokerSettings.module.css";

// Shipmondo's own-agreement products carry this suffix in the product
// register (the API's OWN_AGREEMENT_SUFFIX).
const OWN = "+eget";

// Förmedlare (0221): Förvald förmedlare, nShift and Shipmondo — each with
// its own credentials (write-only: blank keeps the stored one), Testa
// anslutning and Hämta transportörsprodukter, and the products it prices.
export function BrokerSettings({
  initial,
  products,
  onProducts,
}: {
  initial: FreightSettings;
  products: FreightProduct[];
  onProducts: (products: FreightProduct[]) => void;
}) {
  const [settings, setSettings] = useState(initial);
  const [defaultBroker, setDefaultBroker] = useState<FreightBroker>(initial.defaultBroker);
  const [defaultSaved, setDefaultSaved] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);

  async function saveDefault(next: FreightBroker) {
    setDefaultBroker(next);
    setDefaultSaved(false);
    setDefaultError(null);
    try {
      setSettings(await apiFetch<FreightSettings>("/api/v1/freight-settings", { method: "PATCH", body: JSON.stringify({ defaultBroker: next }) }));
      setDefaultSaved(true);
    } catch (err) {
      setDefaultError(apiErrorMessage(err, "Kunde inte spara förvald förmedlare"));
    }
  }

  return (
    <>
      <div className={cardStyles.card} style={{ marginTop: 18 }}>
        <div>
          <div className={cardStyles.label}>Förmedlare</div>
          <div className={cardStyles.description}>
            En ny försändelse bokas via förvald förmedlare, om inte orderns eller kundens fraktprodukt hör till en annan. Förmedlaren
            kan bytas på försändelsens utkast. Påslagen, fraktartikeln och upphämtningstiderna gäller alla förmedlare.
          </div>
        </div>
        <FormError>{defaultError}</FormError>
        <FormRow>
          <Field label="Förvald förmedlare" htmlFor="defaultBroker">
            <Select id="defaultBroker" value={defaultBroker} onChange={(e) => saveDefault(e.target.value as FreightBroker)}>
              {FREIGHT_BROKERS.map((b) => (
                <option key={b} value={b}>
                  {BROKER_LABELS[b]}
                </option>
              ))}
            </Select>
          </Field>
        </FormRow>
        <FormHint>
          {settings.enabledBrokers.length === 0
            ? "Ingen förmedlare är aktiverad med sina uppgifter."
            : `Aktiverade: ${settings.enabledBrokers.map((b) => BROKER_LABELS[b]).join(", ")}.`}
          {defaultSaved ? " Sparat." : ""}
        </FormHint>
      </div>

      <NshiftCard settings={settings} onSaved={setSettings} products={products} onProducts={onProducts} />
      <ShipmondoCard settings={settings} onSaved={setSettings} products={products} onProducts={onProducts} />
    </>
  );
}

// Testa anslutning and Hämta transportörsprodukter for one broker.
function useBrokerActions(broker: FreightBroker, onProducts: (products: FreightProduct[]) => void) {
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<string>, fallback: string) {
    setNotice(null);
    setNoticeError(null);
    setBusy(true);
    try {
      setNotice(await fn());
    } catch (err) {
      setNoticeError(shippingErrorText(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  const test = (credentials: Record<string, string>) =>
    act(async () => {
      const { team } = await apiFetch<{ team: string | null }>("/api/v1/freight-settings/test", {
        method: "POST",
        body: JSON.stringify({ broker, ...credentials }),
      });
      return `Anslutningen fungerar${team ? ` — ${team}` : ""}`;
    }, "Anslutningen misslyckades");

  const fetchProducts = () =>
    act(async () => {
      const result = await apiFetch<{ created: number; total: number }>("/api/v1/freight-settings/fetch-products", {
        method: "POST",
        body: JSON.stringify({ broker }),
      });
      onProducts(await apiFetch<FreightProduct[]>("/api/v1/freight-products"));
      return `${result.created} nya produkter från ${BROKER_LABELS[broker]}`;
    }, "Kunde inte hämta produkterna");

  return { notice, noticeError, busy, test, fetchProducts };
}

function BrokerCard({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <div className={cardStyles.card} style={{ marginTop: 18 }}>
      <div>
        <div className={cardStyles.label}>{title}</div>
        <div className={cardStyles.description}>{description}</div>
      </div>
      {children}
    </div>
  );
}

// The products to tick (nShift's services to price, Shipmondo's
// own-agreement products).
function ProductChecks({
  products,
  chosen,
  onChange,
  codeOf,
  empty,
}: {
  products: FreightProduct[];
  chosen: string[];
  onChange: (next: string[]) => void;
  codeOf: (p: FreightProduct) => string;
  empty: string;
}) {
  if (products.length === 0) return <FormHint>{empty}</FormHint>;
  return (
    <div className={styles.checks}>
      {products.map((p) => {
        const code = codeOf(p);
        return (
          <label key={p.id} className={styles.check}>
            <Checkbox
              checked={chosen.includes(code)}
              onChange={(e) => onChange(e.target.checked ? [...chosen, code] : chosen.filter((c) => c !== code))}
            />
            <span>
              {p.productName}
              <span className={styles.code}> {p.carrierName}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function NshiftCard({
  settings,
  onSaved,
  products,
  onProducts,
}: {
  settings: FreightSettings;
  onSaved: (s: FreightSettings) => void;
  products: FreightProduct[];
  onProducts: (products: FreightProduct[]) => void;
}) {
  const n = settings.nshift;
  const [enabled, setEnabled] = useState(n.enabled);
  const [testMode, setTestMode] = useState(n.testMode);
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [quickId, setQuickId] = useState(n.senderQuickId);
  const [services, setServices] = useState(n.services);
  const [priceEnquiry, setPriceEnquiry] = useState(n.priceEnquiry);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const actions = useBrokerActions("nshift", onProducts);
  const own = products.filter((p) => p.provider === "nshift");

  async function save() {
    setError(null);
    setSaved(false);
    try {
      const updated = await apiFetch<FreightSettings>("/api/v1/freight-settings", {
        method: "PATCH",
        body: JSON.stringify({
          nshift: { enabled, testMode, apiKeyId: keyId, apiSecret: secret, senderQuickId: quickId, services, priceEnquiry },
        }),
      });
      onSaved(updated);
      setKeyId("");
      setSecret("");
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara nShift"));
    }
  }

  return (
    <BrokerCard
      title="nShift"
      description={
        <>
          Bokning med era egna avtal hos DHL Freight, DB Schenker, PostNord m.fl. via nShift Delivery (tidigare Unifaun). Kundnumren
          läggs på avsändaren i nShift. API-nyckeln skapas i nShift under Underhåll → API-nycklar (typ Web Services REST) och kräver
          funktionen APIConnect. Uppgifterna visas aldrig här; lämna fälten tomma för att behålla de sparade.
        </>
      }
    >
      <FormError>{error}</FormError>
      <FormRow>
        <Field label="Aktiverad" htmlFor="nshiftEnabled">
          <Toggle id="nshiftEnabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </Field>
        <Field label="Testläge" htmlFor="nshiftTest">
          <Toggle id="nshiftTest" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
        </Field>
        <Field label="Prisfråga via API" htmlFor="nshiftPrice">
          <Toggle id="nshiftPrice" checked={priceEnquiry} onChange={(e) => setPriceEnquiry(e.target.checked)} />
        </Field>
      </FormRow>
      <FormHint attached>
        Testläge: bokningarna skickas inte till transportören och etiketterna märks TEST. Prisfrågan kräver nShift Professional och
        transportörens prisinloggning i nShift; utan den visas produkterna utan pris och kundpriset skrivs för hand.
      </FormHint>
      <FormRow>
        <Field label="Nyckel-id" htmlFor="nshiftKeyId">
          <Input id="nshiftKeyId" type="password" autoComplete="new-password" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder={n.apiKeyIdSet ? "Sparad" : ""} />
        </Field>
        <Field label="Hemlighet" htmlFor="nshiftSecret">
          <Input id="nshiftSecret" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={n.apiSecretSet ? "Sparad" : ""} />
        </Field>
        <Field label="Avsändar-ID i nShift" htmlFor="nshiftQuickId">
          <Input id="nshiftQuickId" size="sm" maxLength={40} value={quickId} onChange={(e) => setQuickId(e.target.value)} />
        </Field>
      </FormRow>
      <div className={styles.heading}>Tjänster att jämföra</div>
      <ProductChecks
        products={own}
        chosen={services}
        onChange={setServices}
        codeOf={(p) => p.carrierCode}
        empty="Hämta produkterna från nShift först (sparade uppgifter krävs)."
      />
      <FormActions>
        <Button type="button" variant="primary" onClick={save}>
          Spara nShift
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={actions.busy}
          onClick={() => actions.test({ ...(keyId.trim() ? { apiKey: keyId.trim() } : {}), ...(secret.trim() ? { apiSecret: secret.trim() } : {}) })}
        >
          Testa anslutning
        </Button>
        <Button type="button" variant="secondary" disabled={actions.busy || !n.apiKeyIdSet || !n.apiSecretSet} onClick={actions.fetchProducts}>
          Hämta produkter
        </Button>
        {saved && <span className={cardStyles.saved}>Sparat</span>}
      </FormActions>
      <FormError>{actions.noticeError}</FormError>
      {actions.notice && <FormHint>{actions.notice}</FormHint>}
    </BrokerCard>
  );
}

function ShipmondoCard({
  settings,
  onSaved,
  products,
  onProducts,
}: {
  settings: FreightSettings;
  onSaved: (s: FreightSettings) => void;
  products: FreightProduct[];
  onProducts: (products: FreightProduct[]) => void;
}) {
  const m = settings.shipmondo;
  const [enabled, setEnabled] = useState(m.enabled);
  const [environment, setEnvironment] = useState(m.environment);
  const [apiUser, setApiUser] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [shipmondoRates, setShipmondoRates] = useState(m.shipmondoRates);
  const [own, setOwn] = useState(m.ownAgreementProducts);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const actions = useBrokerActions("shipmondo", onProducts);
  const ownAgreementProducts = products.filter((p) => p.provider === "shipmondo" && p.carrierCode.endsWith(OWN));

  async function save() {
    setError(null);
    setSaved(false);
    try {
      const updated = await apiFetch<FreightSettings>("/api/v1/freight-settings", {
        method: "PATCH",
        body: JSON.stringify({ shipmondo: { enabled, environment, apiUser, apiKey, shipmondoRates, ownAgreementProducts: own } }),
      });
      onSaved(updated);
      setApiUser("");
      setApiKey("");
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Kunde inte spara Shipmondo"));
    }
  }

  return (
    <BrokerCard
      title="Shipmondo"
      description={
        <>
          Bokning till Shipmondos priser (bland annat DHL Freight paket och pall från Sverige) och med era egna avtal (DHL Freight, DSV
          Road/DB Schenker, PostNord) som aktiverats i Shipmondo. API-användaren och nyckeln skapas i Shipmondo under Inställningar →
          Integrationer → API. Uppgifterna visas aldrig här; lämna fälten tomma för att behålla de sparade.
        </>
      }
    >
      <FormError>{error}</FormError>
      <FormRow>
        <Field label="Aktiverad" htmlFor="shipmondoEnabled">
          <Toggle id="shipmondoEnabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </Field>
        <Field label="Miljö" htmlFor="shipmondoEnvironment">
          <Select id="shipmondoEnvironment" value={environment} onChange={(e) => setEnvironment(e.target.value as "sandbox" | "production")}>
            <option value="sandbox">Sandlåda</option>
            <option value="production">Produktion</option>
          </Select>
        </Field>
        <Field label="Shipmondos priser" htmlFor="shipmondoRates">
          <Toggle id="shipmondoRates" checked={shipmondoRates} onChange={(e) => setShipmondoRates(e.target.checked)} />
        </Field>
      </FormRow>
      <FormRow>
        <Field label="API-användare" htmlFor="shipmondoUser">
          <Input id="shipmondoUser" type="password" autoComplete="new-password" value={apiUser} onChange={(e) => setApiUser(e.target.value)} placeholder={m.apiUserSet ? "Sparad" : ""} />
        </Field>
        <Field label="API-nyckel" htmlFor="shipmondoKey">
          <Input id="shipmondoKey" type="password" autoComplete="new-password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={m.apiKeySet ? "Sparad" : ""} />
        </Field>
      </FormRow>
      <div className={styles.heading}>Egna avtal att prisfråga</div>
      <ProductChecks
        products={ownAgreementProducts}
        chosen={own}
        onChange={setOwn}
        codeOf={(p) => p.carrierCode.slice(0, -OWN.length)}
        empty="Hämta produkterna från Shipmondo först — produkter med eget avtal visas här."
      />
      <FormHint attached>Priset för ett eget avtal är transportörens, när den ger något; annars skrivs kundpriset för hand.</FormHint>
      <FormActions>
        <Button type="button" variant="primary" onClick={save}>
          Spara Shipmondo
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={actions.busy}
          onClick={() =>
            actions.test({ ...(apiUser.trim() ? { apiKey: apiUser.trim() } : {}), ...(apiKey.trim() ? { apiSecret: apiKey.trim() } : {}), environment })
          }
        >
          Testa anslutning
        </Button>
        <Button type="button" variant="secondary" disabled={actions.busy || !m.apiUserSet || !m.apiKeySet} onClick={actions.fetchProducts}>
          Hämta produkter
        </Button>
        {saved && <span className={cardStyles.saved}>Sparat</span>}
      </FormActions>
      <FormError>{actions.noticeError}</FormError>
      {actions.notice && <FormHint>{actions.notice}</FormHint>}
    </BrokerCard>
  );
}
