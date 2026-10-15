import {
  FreightProviderError,
  type FreightProvider,
  type FreightProviderConfig,
  type FreightProviderFactory,
  type ProviderParcel,
  type ProviderParty,
  type ProviderShipment,
  type Rate,
  type TrackingEvent,
} from "./freight-provider.js";

// Sendify (https://api.sendify.com/docs) — the ONLY file that knows Sendify.
// Ported from ERPNext Sverige Frakt's sendify.py. The API key travels in the
// x-api-key header only: it is never logged and never part of an error.

export const SENDIFY_BASE_URL = {
  sandbox: "https://app.dev.sendify.se/external/v1",
  production: "https://app.sendify.se/external/v1",
} as const;

const TIMEOUT_MS = 30_000;

export const SENDIFY_MESSAGES = {
  unauthorized: "Sendify godkände inte API-nyckeln — kontrollera den under System → Frakt",
  unavailable: "Sendify svarar inte, försök igen",
  bookingUnknown:
    "Sendify svarade inte på bokningen. Bokningen kan ha genomförts – kontrollera i Sendify innan du försöker igen.",
  unexpected: "Sendify gav ett oväntat svar",
} as const;

const PARCEL_TYPE = { package: "PACKAGE", pallet: "PALLET", other: "UNSPECIFIED" } as const;
const PARTY_LABEL: Record<string, string> = { from: "Avsändare", to: "Mottagare" };
const FIELD_LABEL: Record<string, string> = {
  weight_kg: "vikt",
  width_cm: "bredd",
  height_cm: "höjd",
  depth_cm: "längd",
  quantity: "antal",
  type: "kollityp",
  loading_meters: "flakmeter",
  address_line_1: "adress",
  postal_code: "postnummer",
  city: "ort",
  country_code: "land",
  name: "namn",
  phone: "telefon",
  email: "e-post",
  requested_pickup_time: "upphämtningstid",
};

// packages[0].weight_kg → "Kolli 1: vikt", to.contact.email → "Mottagare: e-post".
export function fieldLabel(field: string): string {
  const leaf = field.split(".").pop() ?? field;
  const label = FIELD_LABEL[leaf] ?? leaf;
  const parcel = /^packages\[(\d+)\]/.exec(field);
  if (parcel) return `Kolli ${Number(parcel[1]) + 1}: ${label}`;
  const party = PARTY_LABEL[field.split(".")[0] ?? ""];
  if (party && field.includes(".")) return `${party}: ${label}`;
  return label;
}

// Drops null/""/[]/{} recursively — Sendify validates present-but-empty fields.
function stripEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripEmpty);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const cleaned = stripEmpty(v);
      const empty =
        cleaned === null ||
        cleaned === undefined ||
        cleaned === "" ||
        (Array.isArray(cleaned) && cleaned.length === 0) ||
        (typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned as object).length === 0);
      if (!empty) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

function party(p: ProviderParty, opts: { privateIndividual?: boolean } = {}) {
  return {
    name: p.name,
    address: {
      address_line_1: p.addressLine1,
      address_line_2: p.addressLine2,
      postal_code: p.postalCode,
      city: p.city,
      country_code: p.countryCode,
    },
    // Sendify requires contact.name on both parties (422 "The field is
    // required" otherwise) — without a kontaktperson the party's own name
    // stands in, the same field-by-field fallback as phone/e-mail.
    contact: { name: p.contactName || p.name, phone: p.phone, email: p.email },
    // false is meaningful here — always sent on the recipient, never stripped.
    ...(opts.privateIndividual !== undefined ? { is_private_individual: opts.privateIndividual } : {}),
  };
}

function parcel(p: ProviderParcel) {
  return {
    depth_cm: p.lengthCm,
    width_cm: p.widthCm,
    height_cm: p.heightCm,
    weight_kg: p.weightKg,
    quantity: p.quantity,
    type: PARCEL_TYPE[p.kind],
    // Sendify's rule: a PACKAGE is always stackable (422 "must be true for
    // package type PACKAGE" otherwise). Our own flag still applies to pallets
    // and övrigt, where it decides whether the carrier may stack on top.
    stackable: p.kind === "package" ? true : p.stackable,
    description: p.description,
    loading_meters: p.loadingMeters,
  };
}

export function toSendifyShipment(s: ProviderShipment): Record<string, unknown> {
  return stripEmpty({
    enable_bookable_validation: true,
    from: party(s.sender),
    to: party(s.recipient, { privateIndividual: s.recipient.privatePerson === true }),
    reference_id: s.referenceId,
    sender_reference: s.senderReference,
    receiver_reference: s.receiverReference,
    packages: s.parcels.map(parcel),
    system: "Nav ERP",
  }) as Record<string, unknown>;
}

// What we log about a transport failure: the error's name and the cause's
// code, nothing else. Node's fetch echoes the offending header VALUE — our
// API key — in the TypeError message when it contains a control character,
// so err.message is never logged and the error is never attached as cause.
function transportSummary(err: unknown): string {
  const e = (err ?? {}) as { name?: unknown; cause?: { code?: unknown } | null };
  return [e.name, e.cause?.code].filter((v): v is string => typeof v === "string" && v !== "").join(" ");
}

const OFFSET_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Stockholm", timeZoneName: "longOffset" });

// "2030-07-02" + "09:00" (Swedish wall clock) → "2030-07-02T09:00:00+02:00".
export function stockholmIso(date: string, time: string): string {
  const hhmm = time.slice(0, 5);
  const probe = new Date(`${date}T${hhmm}:00Z`);
  const name = OFFSET_FORMAT.formatToParts(probe).find((p) => p.type === "timeZoneName")?.value ?? "GMT+01:00";
  const offset = name === "GMT" ? "+00:00" : name.replace("GMT", "");
  return `${date}T${hhmm}:00${offset}`;
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseRate(r: Record<string, unknown>, requestId: string | null): Rate {
  const token = str(r.booking_token);
  const carrierName = str(r.carrier_name);
  const productName = str(r.product_name);
  const price = num(typeof r.price === "string" ? Number(r.price) : r.price);
  if (!token || !carrierName || !productName || price === null) {
    throw new FreightProviderError(SENDIFY_MESSAGES.unexpected, "unexpected", [], requestId);
  }
  const pickup = (r.pickup ?? {}) as Record<string, unknown>;
  const delivery = (r.estimated_delivery ?? {}) as Record<string, unknown>;
  return {
    bookingToken: token,
    carrierCode: str(r.carrier_code) ?? carrierName,
    carrierName,
    productName,
    price,
    currency: str(r.currency) ?? "SEK",
    daysMin: num(r.transport_business_days_min),
    daysMax: num(r.transport_business_days_max),
    pickupDate: str(pickup.date),
    estimatedDeliveryDate: str(delivery.earliest_date),
    expiresAt: str(r.expires_at),
  };
}

function errorFromBody(text: string, status: number, requestId: string | null): FreightProviderError {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
  } catch {
    // not JSON — falls through to the generic message
  }
  const fieldErrors: string[] = [];
  const errors = data.errors;
  if (errors && typeof errors === "object" && !Array.isArray(errors)) {
    for (const [field, messages] of Object.entries(errors as Record<string, unknown>)) {
      for (const m of Array.isArray(messages) ? messages : [messages]) fieldErrors.push(`${fieldLabel(field)}: ${String(m)}`);
    }
  } else if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        const text = str(e.message) ?? str(e.error);
        if (!text) continue;
        const field = str(e.field);
        fieldErrors.push(field ? `${fieldLabel(field)}: ${text}` : text);
      } else if (entry !== null && entry !== undefined) {
        fieldErrors.push(String(entry));
      }
    }
  }
  const message =
    str(data.message) ??
    str(data.error) ??
    (fieldErrors.length > 0 ? "Sendify kunde inte behandla sändningen" : `Sendify avvisade anropet (HTTP ${status})`);
  return new FreightProviderError(message, "validation", fieldErrors, requestId);
}

export interface SendifyDeps {
  fetch?: typeof fetch;
  log?: (entry: { method: string; path: string; status: number; requestId: string | null; body: string }) => void;
}

export function createSendifyProvider(config: FreightProviderConfig, deps: SendifyDeps = {}): FreightProvider {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? ((entry) => console.warn("Sendify request failed", entry));
  const baseUrl = SENDIFY_BASE_URL[config.environment];

  async function call(method: string, path: string, body?: unknown, booking = false): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(baseUrl + path, {
        method,
        headers: {
          "x-api-key": config.apiKey,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      log({ method, path, status: 0, requestId: null, body: transportSummary(err) });
      throw booking
        ? new FreightProviderError(SENDIFY_MESSAGES.bookingUnknown, "booking-unknown")
        : new FreightProviderError(SENDIFY_MESSAGES.unavailable, "unavailable");
    }
    const requestId = res.headers.get("x-sendify-request-id");
    if (res.status >= 400) {
      const text = await res.text().catch(() => "");
      log({ method, path, status: res.status, requestId, body: text.slice(0, 2000) });
      if (res.status === 401 || res.status === 403) {
        throw new FreightProviderError(SENDIFY_MESSAGES.unauthorized, "unauthorized", [], requestId);
      }
      // A 5xx on BOOK is ambiguous — Sendify may have booked before failing —
      // so it must not read as "försök igen" (that invites a double booking).
      if (res.status >= 500 && booking) {
        throw new FreightProviderError(SENDIFY_MESSAGES.bookingUnknown, "booking-unknown", [], requestId);
      }
      if (res.status === 429 || res.status >= 500) {
        throw new FreightProviderError(SENDIFY_MESSAGES.unavailable, "unavailable", [], requestId);
      }
      throw errorFromBody(text, res.status, requestId);
    }
    const text = await res.text().catch(() => "");
    if (res.status === 204 || text === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new FreightProviderError(SENDIFY_MESSAGES.unexpected, "unexpected", [], requestId);
    }
  }

  async function object(method: string, path: string, body?: unknown, booking = false) {
    const data = await call(method, path, body, booking);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new FreightProviderError(SENDIFY_MESSAGES.unexpected, "unexpected");
    }
    return data as Record<string, unknown>;
  }

  return {
    name: "sendify",

    async checkKey() {
      const data = await object("GET", "/status");
      return { team: str(data.team) };
    },

    async createShipment(shipment) {
      const data = await object("POST", "/shipments", toSendifyShipment(shipment));
      const id = str(data.id);
      if (!id) throw new FreightProviderError(SENDIFY_MESSAGES.unexpected, "unexpected");
      return id;
    },

    async updateShipment(id, shipment) {
      await call("PUT", `/shipments/${encodeURIComponent(id)}`, toSendifyShipment(shipment));
    },

    async deleteShipment(id) {
      await call("DELETE", `/shipments/${encodeURIComponent(id)}`);
    },

    async getRates(id, pickup) {
      const data = await object("POST", "/shipments/rates", {
        shipment_id: id,
        requested_pickup_time: stockholmIso(pickup.date, pickup.time),
      });
      const rates = (Array.isArray(data.rates) ? data.rates : []).map((r) => parseRate(r as Record<string, unknown>, null));
      const warnings = (Array.isArray(data.warnings) ? data.warnings : []).map((w) => {
        const entry = (w ?? {}) as Record<string, unknown>;
        const texts = Array.isArray(entry.warnings) ? entry.warnings.map(String) : [];
        return `${str(entry.carrier_name) ?? "Okänd transportör"}: ${texts.join("; ")}`;
      });
      return { rates, warnings };
    },

    async book(bookingToken) {
      const data = await object("POST", "/shipments/book", { booking_token: bookingToken }, true);
      return {
        trackingNumber: str(data.main_tracking_id),
        documentTypes: Array.isArray(data.available_document_types) ? data.available_document_types.map(String) : [],
      };
    },

    async fetchDocument(id, type) {
      const data = await object("POST", "/shipments/print", {
        shipment_ids: [id],
        document_type: type,
        label_layout: "a4",
        output_format: "url",
      });
      const url = str(data.output_url);
      if (!url) throw new FreightProviderError(SENDIFY_MESSAGES.unexpected, "unexpected");
      let res: Response;
      try {
        res = await doFetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        // The signed url is not logged either — it is a bearer of its own.
        log({ method: "GET", path: "output_url", status: 0, requestId: null, body: transportSummary(err) });
        throw new FreightProviderError(SENDIFY_MESSAGES.unavailable, "unavailable");
      }
      if (res.status >= 400) {
        throw new FreightProviderError(`Dokumentet kunde inte hämtas från Sendify (HTTP ${res.status})`, "unavailable");
      }
      return Buffer.from(await res.arrayBuffer());
    },

    async cancel(id) {
      try {
        await call("POST", "/shipments/cancel", { shipment_id: id });
      } catch (err) {
        if (!(err instanceof FreightProviderError) || err.kind !== "validation") throw err;
        // A refused cancel of a shipment Sendify already reports as cancelled
        // (e.g. cancelled in Sendify's own UI) counts as done. Decided from the
        // status, never the error text; any lookup failure keeps the refusal.
        let status = "";
        try {
          status = String((await object("GET", `/shipments/${encodeURIComponent(id)}`)).status ?? "");
        } catch {
          throw err;
        }
        if (!/^cancel/i.test(status)) throw err;
      }
    },

    async getTracking(id) {
      const data = await call("GET", `/shipments/${encodeURIComponent(id)}/tracking`);
      const events: TrackingEvent[] = [];
      for (const e of Array.isArray(data) ? data : []) {
        const entry = (e ?? {}) as Record<string, unknown>;
        const occurredAt = str(entry.created_at);
        // No time, or one Date can't parse: the event can't be ordered or
        // stored (occurred_at is a timestamp) — skipped rather than failing
        // the whole poll forever.
        if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) continue;
        events.push({
          occurredAt,
          status: str(entry.status),
          description: str(entry.description),
          location: str(entry.location_name),
          url: str(entry.url),
        });
      }
      return events;
    },
  };
}

export const sendifyProviderFactory: FreightProviderFactory = (config) => createSendifyProvider(config);
