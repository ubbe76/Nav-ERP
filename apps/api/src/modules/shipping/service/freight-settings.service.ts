import { TRACKING_INTERVALS, type PickupTimesInput, type TestFreightConnectionInput, type TrackingInterval, type UpdateFreightSettingsInput } from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import type { ShippingRepository } from "../repository/shipping.repository.js";
import { sendifyProviderFactory } from "./sendify-provider.js";
import type { FreightProvider, FreightProviderFactory, ProviderParty } from "./freight-provider.js";
import { addDays, nextPickup, pickupFor, PICKUP_SEARCH_DAYS, stockholmNow, type PickupSlot } from "./pickup.js";
import { splitAddress } from "./recipient.js";
import { missingForBooking } from "./shipment-validation.js";
import { FreightNotConfiguredError, FreightValidationError, InvalidFreightArticleError } from "./shipping.errors.js";

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
} as const;

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
}

export type FreightSettingsView = Omit<FreightSettings, "apiKey"> & { apiKeySet: boolean };

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

export function createFreightSettingsService(deps: {
  repo: ShippingRepository;
  audit: AuditWriter;
  providerFactory?: FreightProviderFactory;
  now?: () => Date;
}) {
  const { repo, audit } = deps;
  const providerFactory = deps.providerFactory ?? sendifyProviderFactory;
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
    };
  }

  async function view(): Promise<FreightSettingsView> {
    const { apiKey, ...rest } = await read();
    return { ...rest, apiKeySet: apiKey !== null };
  }

  async function provider(opts: { requireEnabled: boolean }): Promise<FreightProvider> {
    const settings = await read();
    if (opts.requireEnabled && !settings.enabled) throw new FreightNotConfiguredError("disabled");
    if (!settings.apiKey) throw new FreightNotConfiguredError("no-key");
    return providerFactory({ environment: settings.environment, apiKey: settings.apiKey });
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

  async function nextPickupSlot(): Promise<PickupSlot | null> {
    const current = today();
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
    sender,
    today,
    listPickupTimes,

    async status() {
      return { enabled: (await read()).enabled };
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
      const apiKey = input.apiKey ?? saved.apiKey;
      if (!apiKey) throw new FreightNotConfiguredError("no-key");
      return providerFactory({ environment: input.environment ?? saved.environment, apiKey }).checkKey();
    },

    // "Hämta transportörsprodukter": a sample shipment (our address to itself,
    // one EUR pallet) priced and deleted again, so the register is filled
    // before the first real booking.
    async fetchProducts(userId: string | null) {
      const p = await provider({ requireEnabled: false });
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

      const id = await p.createShipment({
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
      });
      try {
        const slot = (await nextPickupSlot()) ?? { date: addDays(today().date, 1), timeFrom: "09:00", timeTo: "16:00" };
        const { rates } = await p.getRates(id, { date: slot.date, time: slot.timeFrom });
        const { created } = await repo.upsertFreightProducts(p.name, rates);
        await audit.log({ entityType: "freight_settings", entityId: null, action: "products_fetched", detail: { created }, userId });
        return { created, total: (await repo.listFreightProducts()).length };
      } finally {
        await p.deleteShipment(id).catch(() => undefined);
      }
    },

    async listProducts() {
      return repo.listFreightProducts();
    },
  };
}

export type FreightSettingsService = ReturnType<typeof createFreightSettingsService>;
