import { roundToDecimals } from "@navet/shared";
import { basicAuth, createBrokerHttp, num, str, stripEmpty, type BrokerHttpDeps } from "./broker-http.js";
import {
  FreightProviderError,
  type FreightProvider,
  type FreightProviderConfig,
  type FreightProviderFactory,
  type ProviderContext,
  type ProviderParty,
  type ProviderShipment,
  type Rate,
} from "./freight-provider.js";

// nShift Delivery (formerly Unifaun Online), REST API rs-extapi v1 — the ONLY
// file that knows nShift. Own carrier agreements only: the customer numbers
// live on the sender in nShift (quickId), and `service.id` picks the
// product. Docs: https://api.unifaun.com/rs-extapi/v1/documentation/ (RAML
// root-resource-v1.raml, CreatingShipments.md). Research:
// private/superpowers/specs/2026-11-14-research-nshift.md.
//
// Built from the documentation only — not yet tried against an account.
// Unconfirmed: the unit of length/width/height (sent in metres, volume in
// m³, as the docs' examples suggest — "volume": "0.12" with a 2.75 kg
// parcel) and the currency of a price (SEK assumed).
//
// No draft is kept at nShift (remoteDrafts false): the shipment is priced
// with POST /prices per configured service and booked with POST /shipments,
// whose PDFs (available for an hour only) come back inline and are stored.

export const NSHIFT_BASE_URL = "https://api.unifaun.com/rs-extapi/v1";

export const NSHIFT_MESSAGES = {
  unauthorized: "nShift godkände inte API-nyckeln eller saknar licensen — kontrollera under System → Frakt",
  unavailable: "nShift svarar inte, försök igen",
  bookingUnknown:
    "nShift svarade inte på bokningen. Försändelsen kan ha skapats – kontrollera i nShift innan du försöker igen.",
  unexpected: "nShift gav ett oväntat svar",
} as const;

// The A4 PDF, inline (returnFile=true).
const PRINT_CONFIG = { target1Media: "laser-a4", target1Type: "pdf", target1XOffset: 0, target1YOffset: 0 };

// "DHL Freight Pall" → "DHL Freight": the known carrier at the start of a
// service description, else its first word.
const CARRIER_PREFIXES = [
  "DHL Freight",
  "DHL Express",
  "DHL Paket",
  "DB Schenker",
  "Schenker",
  "PostNord",
  "Bring",
  "UPS",
  "DSV",
  "FedEx",
  "GLS",
  "Budbee",
  "Instabox",
  "Airmee",
  "DHL",
];
export function carrierFromDescription(description: string): string {
  const prefix = CARRIER_PREFIXES.find((p) => description.toLowerCase().startsWith(p.toLowerCase()));
  return prefix ?? description.split(/\s+/)[0] ?? description;
}

export interface NshiftOptions {
  senderQuickId: string;
  services: string[];
  // Names of the services from the product register (Hämta
  // transportörsprodukter), keyed by service id.
  serviceNames: Record<string, { carrierName: string; productName: string }>;
  priceEnquiry: boolean;
  testMode: boolean;
}

export function nshiftOptions(config: FreightProviderConfig): NshiftOptions {
  const o = config.options ?? {};
  return {
    senderQuickId: typeof o.senderQuickId === "string" && o.senderQuickId !== "" ? o.senderQuickId : "1",
    services: Array.isArray(o.services) ? o.services.filter((v): v is string => typeof v === "string") : [],
    serviceNames: (o.serviceNames as NshiftOptions["serviceNames"]) ?? {},
    priceEnquiry: o.priceEnquiry === true,
    testMode: o.testMode !== false,
  };
}

const metres = (cm: number) => (cm > 0 ? roundToDecimals(cm / 100, 2) : undefined);

function party(p: ProviderParty) {
  return {
    name: p.name,
    address1: p.addressLine1,
    address2: p.addressLine2,
    zipcode: p.postalCode,
    city: p.city,
    country: p.countryCode,
    contact: p.contactName,
    phone: p.phone,
    email: p.email,
    residential: p.privatePerson ? true : undefined,
  };
}

// The shipment body: the stored sender in nShift (quickId — its customer
// numbers are the own agreements) with our address on top, the service and
// pickup when booking, Testläge as test: true.
export function toNshiftShipment(s: ProviderShipment, opts: NshiftOptions, serviceId: string, pickup?: ProviderContext["pickup"]) {
  return stripEmpty({
    sender: { quickId: opts.senderQuickId, ...party(s.sender) },
    receiver: party(s.recipient),
    service: {
      id: serviceId,
      ...(pickup ? { pickupBooking: true, pickupDate: pickup.date, pickupTimeFrom: pickup.time } : {}),
    },
    parcels: s.parcels.map((p) => {
      const volume = p.lengthCm > 0 && p.widthCm > 0 && p.heightCm > 0 ? (p.lengthCm * p.widthCm * p.heightCm) / 1_000_000 : undefined;
      return {
        valuePerParcel: true,
        copies: p.quantity,
        weight: p.weightKg,
        length: metres(p.lengthCm),
        width: metres(p.widthCm),
        height: metres(p.heightCm),
        volume: volume === undefined ? undefined : roundToDecimals(volume, 3),
        loadingMeters: p.loadingMeters ?? undefined,
        stackable: p.stackable,
        contents: p.description ?? "Gods",
      };
    }),
    orderNo: s.referenceId,
    senderReference: s.senderReference,
    receiverReference: s.receiverReference,
    test: opts.testMode ? true : undefined,
  });
}

// 400 {code, message} or 422 [{message, field, type}] → a refusal with the
// messages that are errors (ignorable ones are left out).
function refused(text: string, status: number): FreightProviderError {
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  const fieldErrors: string[] = [];
  if (Array.isArray(data)) {
    for (const entry of data) {
      const e = (entry ?? {}) as Record<string, unknown>;
      if (e.type === "ignorable") continue;
      const message = str(e.message);
      if (!message) continue;
      const field = str(e.field);
      fieldErrors.push(field ? `${field}: ${message}` : message);
    }
  }
  const message =
    (data && !Array.isArray(data) && typeof data === "object" ? str((data as Record<string, unknown>).message) : null) ??
    (fieldErrors.length > 0 ? "nShift kunde inte behandla försändelsen" : `nShift avvisade anropet (HTTP ${status})`);
  return new FreightProviderError(message, "validation", fieldErrors);
}

interface NshiftPrint {
  type: string;
  description: string;
  data: string | null;
}

function printsOf(entry: Record<string, unknown>): NshiftPrint[] {
  const raw = Array.isArray(entry.prints) ? entry.prints : [];
  return raw.map((p) => {
    const print = (p ?? {}) as Record<string, unknown>;
    return { type: str(print.type) ?? "", description: str(print.description) ?? "", data: str(print.data) };
  });
}

// "Waybill"/"Fraktsedel" → waybill, anything else (Label …) → label.
const documentType = (description: string) => (/waybill|fraktsedel/i.test(description) ? "waybill" : "label");

export function createNshiftProvider(config: FreightProviderConfig, deps: BrokerHttpDeps = {}): FreightProvider {
  const opts = nshiftOptions(config);
  const { call } = createBrokerHttp({
    broker: "nShift",
    baseUrl: NSHIFT_BASE_URL,
    authorization: basicAuth(config.apiKey, config.apiSecret ?? ""),
    messages: NSHIFT_MESSAGES,
    refused,
    deps,
  });

  const nameOf = (serviceId: string) =>
    opts.serviceNames[serviceId] ?? { carrierName: carrierFromDescription(serviceId), productName: serviceId };

  const notKept = () => new FreightProviderError(NSHIFT_MESSAGES.unexpected, "unexpected");

  return {
    name: "nshift",
    remoteDrafts: false,
    tracks: false,

    // No "who am I": the stored sender (quickId) is read — it must exist for
    // the own agreements to apply.
    async checkKey() {
      const data = await call("GET", `/addresses/senders?quickId=${encodeURIComponent(opts.senderQuickId)}`);
      const list = Array.isArray(data) ? data : [];
      const first = (list[0] ?? null) as Record<string, unknown> | null;
      return { team: first ? str(first.name) : null };
    },

    async createShipment() {
      throw notKept();
    },
    async updateShipment() {
      throw notKept();
    },
    async deleteShipment() {
      throw notKept();
    },

    // One rate per configured service. With Prisfråga on, POST /prices per
    // service (Professional plan; DHL e-ID / Schenker e-services login in
    // nShift); a service nShift will not price is offered without a price
    // and its reason becomes a warning.
    async getRates({ shipment, pickup }) {
      if (opts.services.length === 0) {
        return { rates: [], warnings: ["Inga nShift-tjänster är valda — välj dem under System → Frakt"] };
      }
      const rates: Rate[] = [];
      const warnings: string[] = [];
      for (const serviceId of opts.services) {
        const { carrierName, productName } = nameOf(serviceId);
        let price: number | null = null;
        if (opts.priceEnquiry) {
          try {
            const data = (await call("POST", "/prices", { shipment: toNshiftShipment(shipment, opts, serviceId) })) as Record<string, unknown> | null;
            price = num(data?.price);
            if (price === null) warnings.push(`${productName}: nShift gav inget pris`);
          } catch (err) {
            if (err instanceof FreightProviderError && err.kind === "unauthorized") throw err;
            warnings.push(`${productName}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        rates.push({
          bookingToken: JSON.stringify({ serviceId }),
          carrierCode: serviceId,
          carrierName,
          productName,
          price,
          currency: "SEK",
          daysMin: null,
          daysMax: null,
          pickupDate: pickup.date,
          estimatedDeliveryDate: null,
          expiresAt: null,
        });
      }
      return { rates, warnings };
    },

    async book(bookingToken, { shipment, pickup }) {
      let serviceId: string | null = null;
      try {
        serviceId = str((JSON.parse(bookingToken) as Record<string, unknown>).serviceId);
      } catch {
        serviceId = null;
      }
      if (!serviceId) throw new FreightProviderError(NSHIFT_MESSAGES.unexpected, "unexpected");
      const data = await call(
        "POST",
        "/shipments?returnFile=true",
        { printConfig: PRINT_CONFIG, shipment: toNshiftShipment(shipment, opts, serviceId, pickup) },
        true
      );
      const list = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
      const first = (list[0] ?? null) as Record<string, unknown> | null;
      const id = first ? str(first.id) : null;
      if (!first || !id) throw new FreightProviderError(NSHIFT_MESSAGES.bookingUnknown, "booking-unknown");
      const parcels = Array.isArray(first.parcels) ? first.parcels : [];
      const firstParcel = (parcels[0] ?? {}) as Record<string, unknown>;
      const prints = printsOf(first);
      const documents = prints
        .filter((p) => p.data !== null && (p.type === "" || p.type === "pdf"))
        .map((p) => ({ type: documentType(p.description), content: Buffer.from(p.data!, "base64") }));
      return {
        trackingNumber: str(first.shipmentNo) ?? str(firstParcel.parcelNo),
        documentTypes: [...new Set(prints.map((p) => documentType(p.description)))],
        remoteId: id,
        documents,
      };
    },

    // The documents live an hour at nShift: new copies are made.
    async fetchDocument(id, type) {
      const data = await call("POST", `/shipments/${encodeURIComponent(id)}/prints?returnFile=true`, PRINT_CONFIG);
      const list = Array.isArray(data) ? data : [];
      const prints = list.map((p) => (p ?? {}) as Record<string, unknown>);
      const match = prints.find((p) => documentType(str(p.description) ?? "") === type) ?? prints[0];
      const content = match ? str(match.data) : null;
      if (!content) throw new FreightProviderError("nShift gav inget dokument", "unavailable");
      return Buffer.from(content, "base64");
    },

    async cancel(id) {
      await call("DELETE", `/shipments/${encodeURIComponent(id)}`);
    },

    async getTracking() {
      throw new FreightProviderError("nShift-försändelser spåras inte automatiskt", "validation");
    },

    // Hämta transportörsprodukter: the account's services
    // (GET /meta/lists/partners — id + description).
    async listProducts() {
      const data = await call("GET", "/meta/lists/partners?language=sv");
      const list = Array.isArray(data) ? data : [];
      const products: { carrierCode: string; carrierName: string; productName: string }[] = [];
      // The documented example is a flat list of services; a partner entry
      // that nests its services is flattened (the partner's name is then the
      // carrier).
      const add = (entry: unknown, carrier: string | null) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        const id = str(e.id);
        const description = str(e.description) ?? str(e.uniqueDescription);
        if (!id || !description) return;
        products.push({ carrierCode: id, carrierName: carrier ?? carrierFromDescription(description), productName: description });
      };
      for (const entry of list) {
        const e = (entry ?? {}) as Record<string, unknown>;
        if (Array.isArray(e.services)) {
          const carrier = str(e.description) ?? str(e.name);
          for (const service of e.services) add(service, carrier);
        } else {
          add(entry, null);
        }
      }
      return products;
    },
  };
}

export const nshiftProviderFactory: FreightProviderFactory = (config) => createNshiftProvider(config);
