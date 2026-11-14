import { TRACKING_INTERVALS, type PickupTimesInput, type TestFreightConnectionInput, type TrackingInterval, type UpdateFreightSettingsInput } from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { ShippingRepository } from "../repository/shipping.repository.js";
import { sendifyProviderFactory } from "./sendify-provider.js";
import { nshiftProviderFactory } from "./nshift-provider.js";
import { shipmondoProviderFactory } from "./shipmondo-provider.js";
import {
  BROKER_LABELS,
  BROKERS,
  type BrokerName,
  type FreightProvider,
  type FreightProviderConfig,
  type FreightProviderFactory,
  type ProviderParty,
  type ProviderShipment,
} from "./freight-provider.js";
import { addDays, nextPickup, pickupFor, PICKUP_SEARCH_DAYS, requestedPickupTime, stockholmNow, type PickupSlot } from "./pickup.js";
import { splitAddress } from "./recipient.js";
import { missingForBooking } from "./shipment-validation.js";
import { FreightNotConfiguredError, FreightPickupDayError, FreightValidationError, InvalidFreightArticleError } from "./shipping.errors.js";

// Fraktinställningar live as freight_* keys in system_settings (key–value, no
// migration per setting). The API key is write-only: never returned, never
// logged — the audit trail records changed KEY names only.

const KEYS = {
  enabled: "freight_enabled",
  environment: "freight_environment",
  apiKey: "freight_api_key",
  senderContactName: "freight_sender_contact_name",
  senderPhone: "freight_sender_phone",
  senderEmail: "freight_sender_email",
  markupPercent: "freight_markup_percent",
  markupAmount: "freight_markup_amount",
  freightArticleId: "freight_article_id",
  priceChangePercent: "freight_price_change_percent",
  // Etapp 2 — tracking. freight_tracking_lease_until and
  // freight_last_tracking_run_at are written by the tracking run only
  // (repository), never through update().
  trackingInterval: "freight_tracking_interval",
  lastTrackingRunAt: "freight_last_tracking_run_at",
  // Förmedlare (etapp 2). The keys above without a broker in the name are
  // Sendify's (and the shared ones).
  defaultBroker: "freight_default_broker",
  nshiftEnabled: "freight_nshift_enabled",
  nshiftTestMode: "freight_nshift_test_mode",
  nshiftApiKeyId: "freight_nshift_api_key_id",
  nshiftApiSecret: "freight_nshift_api_secret",
  nshiftSenderQuickId: "freight_nshift_sender_quick_id",
  nshiftServices: "freight_nshift_services",
  nshiftPriceEnquiry: "freight_nshift_price_enquiry",
  shipmondoEnabled: "freight_shipmondo_enabled",
  shipmondoEnvironment: "freight_shipmondo_environment",
  shipmondoApiUser: "freight_shipmondo_api_user",
  shipmondoApiKey: "freight_shipmondo_api_key",
  shipmondoRates: "freight_shipmondo_rates",
  shipmondoOwnAgreementProducts: "freight_shipmondo_own_agreement_products",
} as const;

export interface NshiftSettings {
  enabled: boolean;
  testMode: boolean;
  apiKeyId: string | null;
  apiSecret: string | null;
  senderQuickId: string;
  services: string[];
  priceEnquiry: boolean;
}

export interface ShipmondoSettings {
  enabled: boolean;
  environment: "sandbox" | "production";
  apiUser: string | null;
  apiKey: string | null;
  shipmondoRates: boolean;
  ownAgreementProducts: string[];
}

export interface FreightSettings {
  enabled: boolean;
  environment: "sandbox" | "production";
  apiKey: string | null;
  senderContactName: string;
  senderPhone: string;
  senderEmail: string;
  markupPercent: number;
  markupAmount: number;
  freightArticleId: string | null;
  priceChangePercent: number;
  trackingInterval: TrackingInterval;
  lastTrackingRunAt: Date | null;
  defaultBroker: BrokerName;
  nshift: NshiftSettings;
  shipmondo: ShipmondoSettings;
}

// Credentials never leave the API: the view says whether each is set.
export type FreightSettingsView = Omit<FreightSettings, "apiKey" | "nshift" | "shipmondo"> & {
  apiKeySet: boolean;
  // Any broker switched on with its credentials (Boka transport shows).
  anyEnabled: boolean;
  enabledBrokers: BrokerName[];
  nshift: Omit<NshiftSettings, "apiKeyId" | "apiSecret"> & { apiKeyIdSet: boolean; apiSecretSet: boolean };
  shipmondo: Omit<ShipmondoSettings, "apiUser" | "apiKey"> & { apiUserSet: boolean; apiKeySet: boolean };
};

export interface SenderParty {
  senderName: string | null;
  senderAddressLine1: string | null;
  senderAddressLine2: string | null;
  senderPostalCode: string | null;
  senderCity: string | null;
  senderCountry: string;
  senderContactName: string | null;
  senderPhone: string | null;
  senderEmail: string | null;
}

const numberOr = (raw: string | undefined, fallback: number) => {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const blankToNull = (v: string | null | undefined) => (v && v.trim() !== "" ? v.trim() : null);

// A stored JSON list of codes; anything else reads as none.
function codeList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v !== "") : [];
  } catch {
    return [];
  }
}

const isBroker = (v: string | undefined): v is BrokerName => (BROKERS as readonly string[]).includes(v ?? "");

export function createFreightSettingsService(deps: {
  repo: ShippingRepository;
  audit: AuditWriter;
  // Sendify's factory (the tests inject a fake), and the others per broker.
  providerFactory?: FreightProviderFactory;
  providerFactories?: Partial<Record<BrokerName, FreightProviderFactory>>;
  now?: () => Date;
}) {
  const { repo, audit } = deps;
  const providerFactory = deps.providerFactory ?? sendifyProviderFactory;
  const factories: Record<BrokerName, FreightProviderFactory> = {
    sendify: providerFactory,
    nshift: nshiftProviderFactory,
    shipmondo: shipmondoProviderFactory,
    ...deps.providerFactories,
  };
  const now = deps.now ?? (() => new Date());

  async function read(): Promise<FreightSettings> {
    const raw = await repo.readFreightSettings();
    const apiKey = raw.get(KEYS.apiKey);
    return {
      enabled: raw.get(KEYS.enabled) === "true",
      environment: raw.get(KEYS.environment) === "production" ? "production" : "sandbox",
      apiKey: apiKey && apiKey !== "" ? apiKey : null,
      senderContactName: raw.get(KEYS.senderContactName) ?? "",
      senderPhone: raw.get(KEYS.senderPhone) ?? "",
      senderEmail: raw.get(KEYS.senderEmail) ?? "",
      markupPercent: numberOr(raw.get(KEYS.markupPercent), 0),
      markupAmount: numberOr(raw.get(KEYS.markupAmount), 0),
      freightArticleId: blankToNull(raw.get(KEYS.freightArticleId)),
      priceChangePercent: numberOr(raw.get(KEYS.priceChangePercent), 5),
      trackingInterval: (TRACKING_INTERVALS as readonly string[]).includes(raw.get(KEYS.trackingInterval) ?? "")
        ? (raw.get(KEYS.trackingInterval) as TrackingInterval)
        : "hourly",
      lastTrackingRunAt: (() => {
        const v = raw.get(KEYS.lastTrackingRunAt);
        const t = v ? Date.parse(v) : NaN;
        return Number.isFinite(t) ? new Date(t) : null;
      })(),
      defaultBroker: isBroker(raw.get(KEYS.defaultBroker)) ? (raw.get(KEYS.defaultBroker) as BrokerName) : "sendify",
      nshift: {
        enabled: raw.get(KEYS.nshiftEnabled) === "true",
        testMode: raw.get(KEYS.nshiftTestMode) !== "false",
        apiKeyId: blankToNull(raw.get(KEYS.nshiftApiKeyId)),
        apiSecret: blankToNull(raw.get(KEYS.nshiftApiSecret)),
        senderQuickId: raw.get(KEYS.nshiftSenderQuickId) || "1",
        services: codeList(raw.get(KEYS.nshiftServices)),
        priceEnquiry: raw.get(KEYS.nshiftPriceEnquiry) === "true",
      },
      shipmondo: {
        enabled: raw.get(KEYS.shipmondoEnabled) === "true",
        environment: raw.get(KEYS.shipmondoEnvironment) === "production" ? "production" : "sandbox",
        apiUser: blankToNull(raw.get(KEYS.shipmondoApiUser)),
        apiKey: blankToNull(raw.get(KEYS.shipmondoApiKey)),
        shipmondoRates: raw.get(KEYS.shipmondoRates) !== "false",
        ownAgreementProducts: codeList(raw.get(KEYS.shipmondoOwnAgreementProducts)),
      },
    };
  }

  // Each broker's config, or null while its credentials are missing.
  function configFor(settings: FreightSettings, broker: BrokerName): FreightProviderConfig | null {
    switch (broker) {
      case "sendify":
        return settings.apiKey ? { environment: settings.environment, apiKey: settings.apiKey } : null;
      case "nshift": {
        const n = settings.nshift;
        if (!n.apiKeyId || !n.apiSecret) return null;
        return {
          environment: n.testMode ? "sandbox" : "production",
          apiKey: n.apiKeyId,
          apiSecret: n.apiSecret,
          options: { senderQuickId: n.senderQuickId, services: n.services, priceEnquiry: n.priceEnquiry, testMode: n.testMode },
        };
      }
      case "shipmondo": {
        const m = settings.shipmondo;
        if (!m.apiUser || !m.apiKey) return null;
        return {
          environment: m.environment,
          apiKey: m.apiUser,
          apiSecret: m.apiKey,
          options: { shipmondoRates: m.shipmondoRates, ownAgreementProducts: m.ownAgreementProducts },
        };
      }
    }
  }

  const brokerOn = (settings: FreightSettings, broker: BrokerName) =>
    broker === "sendify" ? settings.enabled : settings[broker].enabled;

  // The brokers switched on WITH their credentials, in BROKERS order.
  function enabledBrokersOf(settings: FreightSettings): BrokerName[] {
    return BROKERS.filter((b) => brokerOn(settings, b) && configFor(settings, b) !== null);
  }

  async function view(): Promise<FreightSettingsView> {
    const settings = await read();
    const { apiKey, nshift, shipmondo, ...rest } = settings;
    const { apiKeyId, apiSecret, ...nshiftRest } = nshift;
    const { apiUser, apiKey: shipmondoKey, ...shipmondoRest } = shipmondo;
    const enabledBrokers = enabledBrokersOf(settings);
    return {
      ...rest,
      apiKeySet: apiKey !== null,
      anyEnabled: enabledBrokers.length > 0,
      enabledBrokers,
      nshift: { ...nshiftRest, apiKeyIdSet: apiKeyId !== null, apiSecretSet: apiSecret !== null },
      shipmondo: { ...shipmondoRest, apiUserSet: apiUser !== null, apiKeySet: shipmondoKey !== null },
    };
  }

  // The broker's provider (Sendify when none is named). requireEnabled:
  // refused while that broker is switched off (cancel, documents and
  // tracking of a booked shipment work regardless).
  async function provider(opts: { requireEnabled: boolean; broker?: BrokerName }): Promise<FreightProvider> {
    const broker = opts.broker ?? "sendify";
    const settings = await read();
    if (opts.requireEnabled && !brokerOn(settings, broker)) throw new FreightNotConfiguredError("disabled", BROKER_LABELS[broker]);
    const config = configFor(settings, broker);
    if (!config) throw new FreightNotConfiguredError("no-key", BROKER_LABELS[broker]);
    // nShift names its rates after the product register (the services are
    // only ids in the settings).
    if (broker === "nshift") {
      const names: Record<string, { carrierName: string; productName: string }> = {};
      for (const p of await repo.listFreightProducts()) {
        if (p.provider === "nshift") names[p.carrierCode] = { carrierName: p.carrierName, productName: p.productName };
      }
      config.options = { ...config.options, serviceNames: names };
    }
    return factories[broker](config);
  }

  // The broker a new shipment (or an order's price probe) goes through: the
  // preferred one when it is switched on, else Förvald förmedlare, else the
  // first one switched on. null = none is.
  async function brokerFor(preferred: string | null | undefined): Promise<BrokerName | null> {
    const settings = await read();
    const on = enabledBrokersOf(settings);
    if (isBroker(preferred ?? undefined) && on.includes(preferred as BrokerName)) return preferred as BrokerName;
    if (on.includes(settings.defaultBroker)) return settings.defaultBroker;
    return on[0] ?? null;
  }

  async function sender(): Promise<SenderParty> {
    const [settings, company] = await Promise.all([read(), repo.getCompanyInfo()]);
    const [line1, line2] = splitAddress(company?.address ?? null);
    return {
      senderName: blankToNull(company?.name),
      senderAddressLine1: line1,
      senderAddressLine2: line2,
      senderPostalCode: blankToNull(company?.postalCode),
      senderCity: blankToNull(company?.city),
      senderCountry: "SE",
      senderContactName: blankToNull(settings.senderContactName),
      senderPhone: blankToNull(settings.senderPhone) ?? blankToNull(company?.phone),
      senderEmail: blankToNull(settings.senderEmail) ?? blankToNull(company?.email),
    };
  }

  const today = () => stockholmNow(now());

  async function offDaysFrom(date: string) {
    return repo.fullDayHolidays(date, addDays(date, PICKUP_SEARCH_DAYS));
  }

  // `current` = the wall clock the caller also asks requestedPickupTime
  // with (fetchProducts), so today's slot and its time are decided at one
  // instant.
  async function nextPickupSlot(current: { date: string; time: string } = today()): Promise<PickupSlot | null> {
    return nextPickup(current, await repo.listPickupTimes(), await offDaysFrom(current.date));
  }

  async function listPickupTimes() {
    const rows = await repo.listPickupTimes();
    return rows.map((r) => ({ weekday: r.weekday, timeFrom: r.timeFrom.slice(0, 5), timeTo: r.timeTo.slice(0, 5) }));
  }

  return {
    read,
    view,
    provider,
    brokerFor,
    enabledBrokers: async () => enabledBrokersOf(await read()),
    sender,
    today,
    listPickupTimes,

    // What the cards need: Boka transport shows when any broker is on.
    async status() {
      const on = enabledBrokersOf(await read());
      return { enabled: on.length > 0, brokers: on };
    },

    async update(input: UpdateFreightSettingsInput, userId: string | null) {
      if (input.freightArticleId && !(await repo.articleExists(input.freightArticleId))) {
        throw new InvalidFreightArticleError();
      }
      const changed: string[] = [];
      const set = async (key: string, value: string) => {
        changed.push(key);
        await repo.setSetting(key, value);
      };
      if (input.enabled !== undefined) await set(KEYS.enabled, String(input.enabled));
      if (input.environment !== undefined) await set(KEYS.environment, input.environment);
      // "" = leave the stored key (the form never sees it), null = remove.
      if (input.apiKey === null) {
        changed.push(KEYS.apiKey);
        await repo.deleteSetting(KEYS.apiKey);
      } else if (input.apiKey !== undefined && input.apiKey !== "") {
        await set(KEYS.apiKey, input.apiKey);
      }
      if (input.senderContactName !== undefined) await set(KEYS.senderContactName, input.senderContactName);
      if (input.senderPhone !== undefined) await set(KEYS.senderPhone, input.senderPhone);
      if (input.senderEmail !== undefined) await set(KEYS.senderEmail, input.senderEmail);
      if (input.markupPercent !== undefined) await set(KEYS.markupPercent, String(input.markupPercent));
      if (input.markupAmount !== undefined) await set(KEYS.markupAmount, String(input.markupAmount));
      if (input.freightArticleId !== undefined) await set(KEYS.freightArticleId, input.freightArticleId ?? "");
      if (input.priceChangePercent !== undefined) await set(KEYS.priceChangePercent, String(input.priceChangePercent));
      if (input.trackingInterval !== undefined) await set(KEYS.trackingInterval, input.trackingInterval);
      if (input.defaultBroker !== undefined) await set(KEYS.defaultBroker, input.defaultBroker);
      // A credential: "" keeps the stored one, null removes it.
      const secret = async (key: string, value: string | null | undefined) => {
        if (value === null) {
          changed.push(key);
          await repo.deleteSetting(key);
        } else if (value !== undefined && value !== "") {
          await set(key, value);
        }
      };
      const n = input.nshift;
      if (n) {
        if (n.enabled !== undefined) await set(KEYS.nshiftEnabled, String(n.enabled));
        if (n.testMode !== undefined) await set(KEYS.nshiftTestMode, String(n.testMode));
        await secret(KEYS.nshiftApiKeyId, n.apiKeyId);
        await secret(KEYS.nshiftApiSecret, n.apiSecret);
        if (n.senderQuickId !== undefined) await set(KEYS.nshiftSenderQuickId, n.senderQuickId);
        if (n.services !== undefined) await set(KEYS.nshiftServices, JSON.stringify([...new Set(n.services)]));
        if (n.priceEnquiry !== undefined) await set(KEYS.nshiftPriceEnquiry, String(n.priceEnquiry));
      }
      const m = input.shipmondo;
      if (m) {
        if (m.enabled !== undefined) await set(KEYS.shipmondoEnabled, String(m.enabled));
        if (m.environment !== undefined) await set(KEYS.shipmondoEnvironment, m.environment);
        await secret(KEYS.shipmondoApiUser, m.apiUser);
        await secret(KEYS.shipmondoApiKey, m.apiKey);
        if (m.shipmondoRates !== undefined) await set(KEYS.shipmondoRates, String(m.shipmondoRates));
        if (m.ownAgreementProducts !== undefined) {
          await set(KEYS.shipmondoOwnAgreementProducts, JSON.stringify([...new Set(m.ownAgreementProducts)]));
        }
      }
      if (changed.length > 0) {
        changed.sort();
        await audit.log({ entityType: "freight_settings", entityId: null, action: "updated", detail: { keys: changed }, userId });
      }
      return view();
    },

    async replacePickupTimes(input: PickupTimesInput, userId: string | null) {
      await repo.replacePickupTimes(input.pickupTimes);
      await audit.log({ entityType: "freight_settings", entityId: null, action: "pickup_times_updated", userId });
      return listPickupTimes();
    },

    nextPickup: nextPickupSlot,

    async pickupFor(date: string): Promise<PickupSlot | null> {
      return pickupFor(date, await repo.listPickupTimes(), await repo.fullDayHolidays(date, date));
    },

    // The key typed in the form when given, else the saved one — so a new
    // key can be checked before it is stored. Nothing is saved here.
    async testConnection(input: TestFreightConnectionInput = {}) {
      const saved = await read();
      const broker = input.broker ?? "sendify";
      const stored = configFor(saved, broker);
      const apiKey = input.apiKey ?? stored?.apiKey ?? null;
      const apiSecret = input.apiSecret ?? stored?.apiSecret ?? null;
      if (!apiKey || (broker !== "sendify" && !apiSecret)) throw new FreightNotConfiguredError("no-key", BROKER_LABELS[broker]);
      const environment =
        input.environment ?? stored?.environment ?? (broker === "shipmondo" ? saved.shipmondo.environment : saved.environment);
      // Sendify gets what it always got; the others their secret and options.
      return factories[broker](
        broker === "sendify" ? { environment, apiKey } : { environment, apiKey, apiSecret, options: stored?.options ?? {} }
      ).checkKey();
    },

    // "Hämta transportörsprodukter": a sample shipment (our address to itself,
    // one EUR pallet) priced and deleted again, so the register is filled
    // before the first real booking.
    async fetchProducts(userId: string | null, broker: BrokerName = "sendify") {
      const p = await provider({ requireEnabled: false, broker });
      // A broker with a catalogue lists it (nShift's services, Shipmondo's
      // products from Sweden) — no sample shipment needed.
      if (p.listProducts) {
        const { created } = await repo.upsertFreightProducts(p.name, await p.listProducts());
        await audit.log({ entityType: "freight_settings", entityId: null, action: "products_fetched", detail: { created, broker }, userId });
        return { created, total: (await repo.listFreightProducts()).length };
      }
      const s = await sender();
      const party: ProviderParty = {
        name: s.senderName ?? "",
        addressLine1: s.senderAddressLine1 ?? "",
        addressLine2: s.senderAddressLine2,
        postalCode: s.senderPostalCode ?? "",
        city: s.senderCity ?? "",
        countryCode: s.senderCountry,
        contactName: s.senderContactName,
        phone: s.senderPhone,
        email: s.senderEmail,
        privatePerson: false,
      };
      const missing = missingForBooking(
        {
          recipientName: party.name,
          recipientAddressLine1: party.addressLine1,
          recipientPostalCode: party.postalCode,
          recipientCity: party.city,
          recipientCountry: party.countryCode,
          recipientPhone: party.phone,
          recipientEmail: party.email,
          ...s,
        },
        [{ weightKg: 100 }]
      ).filter((m) => m.startsWith("Avsändare"));
      if (missing.length > 0) throw new FreightValidationError(missing);

      // The time asked of the broker is requestedPickupTime, as for every
      // other price fetch: today's window from now (rounded up to the
      // quarter), never a Från that has already passed. nextPickup only
      // offers today while such a time exists, so with the same clock the
      // time is never null; the guard is for the type (and a future rule).
      const current = today();
      const slot = (await nextPickupSlot(current)) ?? { date: addDays(current.date, 1), timeFrom: "09:00", timeTo: "16:00" };
      const time = requestedPickupTime(slot, current);
      if (time === null) throw new FreightPickupDayError("Dagens upphämtningstid har passerat — försök igen");

      const sample: ProviderShipment = {
        sender: party,
        recipient: party,
        parcels: [
          {
            kind: "pallet",
            lengthCm: 120,
            widthCm: 80,
            heightCm: 100,
            weightKg: 100,
            quantity: 1,
            stackable: false,
            loadingMeters: null,
            description: "Prisexempel",
          },
        ],
        referenceId: "nav-produkter",
        senderReference: null,
        receiverReference: null,
      };
      const id = p.remoteDrafts ? await p.createShipment(sample) : null;
      try {
        const { rates } = await p.getRates({ remoteId: id, shipment: sample, pickup: { date: slot.date, time } });
        const { created } = await repo.upsertFreightProducts(p.name, rates);
        await audit.log({ entityType: "freight_settings", entityId: null, action: "products_fetched", detail: { created }, userId });
        return { created, total: (await repo.listFreightProducts()).length };
      } finally {
        if (id) await p.deleteShipment(id).catch(() => undefined);
      }
    },

    async listProducts() {
      return repo.listFreightProducts();
    },
  };
}

export type FreightSettingsService = ReturnType<typeof createFreightSettingsService>;
