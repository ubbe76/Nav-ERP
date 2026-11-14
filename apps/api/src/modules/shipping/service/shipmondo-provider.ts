import { basicAuth, createBrokerHttp, num, str, stripEmpty, type BrokerHttpDeps } from "./broker-http.js";
import {
  FreightProviderError,
  type FreightProvider,
  type FreightProviderConfig,
  type FreightProviderFactory,
  type ProviderParty,
  type ProviderShipment,
  type Rate,
} from "./freight-provider.js";

// Shipmondo, public API v3 — the ONLY file that knows Shipmondo. Spec:
// https://app.shipmondo.com/api/public/v3/openapi.json (docs
// https://shipmondo.dev). Research:
// private/superpowers/specs/2026-11-14-research-shipmondo.md.
//
// Built from the documentation only — not yet tried against an account.
// Two kinds of rates: Shipmondos priser (POST /quotes/list, their own
// agreements, excl. VAT is used) and the company's own agreements on the
// products chosen in the settings (POST /shipments/quote with own_agreement
// — the carrier's price when the carrier gives one, else none).
//
// Shipmondo keeps no draft that the API can book (remoteDrafts false):
// POST /shipments books at once and returns the label (a4_pdf) inline.
// Tracking only comes by webhook, which needs a public address — not
// polled here (tracks false).

export const SHIPMONDO_BASE_URL = {
  sandbox: "https://sandbox.shipmondo.com/api/public/v3",
  production: "https://app.shipmondo.com/api/public/v3",
} as const;

export const SHIPMONDO_MESSAGES = {
  unauthorized: "Shipmondo godkände inte API-användaren och nyckeln — kontrollera dem under System → Frakt",
  unavailable: "Shipmondo svarar inte, försök igen",
  bookingUnknown:
    "Shipmondo svarade inte på bokningen. Försändelsen kan ha bokats – kontrollera i Shipmondo innan du försöker igen.",
  unexpected: "Shipmondo gav ett oväntat svar",
} as const;

// Own-agreement products get their own code and name beside the same
// product on Shipmondo's agreement (the product register keys on both).
export const OWN_AGREEMENT_SUFFIX = "+eget";
export const OWN_AGREEMENT_NAME = "eget avtal";

export interface ShipmondoOptions {
  shipmondoRates: boolean;
  ownAgreementProducts: string[];
}

export function shipmondoOptions(config: FreightProviderConfig): ShipmondoOptions {
  const o = config.options ?? {};
  return {
    shipmondoRates: o.shipmondoRates !== false,
    ownAgreementProducts: Array.isArray(o.ownAgreementProducts)
      ? o.ownAgreementProducts.filter((v): v is string => typeof v === "string")
      : [],
  };
}

function party(type: "sender" | "receiver", p: ProviderParty) {
  return {
    type,
    name: p.name,
    attention: p.contactName,
    address1: p.addressLine1,
    address2: p.addressLine2,
    postal_code: p.postalCode,
    city: p.city,
    country_code: p.countryCode,
    email: p.email,
    phone: p.phone,
  };
}

const quoteAddress = (p: ProviderParty) => ({
  address1: p.addressLine1,
  address2: p.addressLine2,
  zipcode: p.postalCode,
  city: p.city,
  country_code: p.countryCode,
});

// Weight in whole grams per parcel, dimensions in whole cm, loading metres
// as running_metre.
export function shipmondoParcels(s: ProviderShipment) {
  return s.parcels.map((p) =>
    stripEmpty({
      quantity: p.quantity,
      weight: Math.max(1, Math.round(p.weightKg * 1000)),
      length: p.lengthCm > 0 ? Math.round(p.lengthCm) : undefined,
      width: p.widthCm > 0 ? Math.round(p.widthCm) : undefined,
      height: p.heightCm > 0 ? Math.round(p.heightCm) : undefined,
      running_metre: p.loadingMeters ?? undefined,
      stackable: p.stackable,
      description: p.description ?? "Gods",
    })
  );
}

function refused(text: string, status: number): FreightProviderError {
  let message: string | null = null;
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    message = str(data.error) ?? str(data.message);
  } catch {
    // not JSON
  }
  return new FreightProviderError(message ?? `Shipmondo avvisade anropet (HTTP ${status})`, "validation", message ? [message] : []);
}

interface BookingToken {
  productCode: string;
  serviceCodes: string;
  ownAgreement: boolean;
  customerNumber?: string;
}

interface ProductInfo {
  name: string;
  carrierName: string;
  customerNumbers: string[];
}

export function createShipmondoProvider(config: FreightProviderConfig, deps: BrokerHttpDeps = {}): FreightProvider {
  const opts = shipmondoOptions(config);
  const { call } = createBrokerHttp({
    broker: "Shipmondo",
    baseUrl: SHIPMONDO_BASE_URL[config.environment],
    authorization: basicAuth(config.apiKey, config.apiSecret ?? ""),
    messages: SHIPMONDO_MESSAGES,
    refused,
    deps,
  });

  // The products from Sweden (to the receiver's country when given), keyed by
  // code — their names and carriers name the rates the same way as the
  // product register.
  async function products(receiverCountry: string | null): Promise<Map<string, ProductInfo>> {
    const map = new Map<string, ProductInfo>();
    for (let page = 1; page <= 10; page++) {
      const query = `sender_country_code=SE${receiverCountry ? `&receiver_country_code=${encodeURIComponent(receiverCountry)}` : ""}&per_page=100&page=${page}`;
      const data = await call("GET", `/products?${query}`);
      const list = Array.isArray(data) ? data : [];
      for (const entry of list) {
        const e = (entry ?? {}) as Record<string, unknown>;
        const code = str(e.code);
        const name = str(e.name);
        if (!code || !name || map.has(code)) continue;
        const carrier = (e.carrier ?? {}) as Record<string, unknown>;
        map.set(code, {
          name,
          carrierName: str(carrier.name) ?? str(carrier.code) ?? "Shipmondo",
          customerNumbers: Array.isArray(e.available_customer_numbers) ? e.available_customer_numbers.map(String) : [],
        });
      }
      if (list.length < 100) break;
    }
    return map;
  }

  return {
    name: "shipmondo",
    remoteDrafts: false,
    tracks: false,

    async checkKey() {
      const data = (await call("GET", "/account/")) as Record<string, unknown> | null;
      return { team: data ? (str(data.name) ?? str(data.company_name)) : null };
    },

    async createShipment() {
      throw new FreightProviderError(SHIPMONDO_MESSAGES.unexpected, "unexpected");
    },
    async updateShipment() {
      throw new FreightProviderError(SHIPMONDO_MESSAGES.unexpected, "unexpected");
    },
    async deleteShipment() {
      throw new FreightProviderError(SHIPMONDO_MESSAGES.unexpected, "unexpected");
    },

    async getRates({ shipment, pickup }) {
      const catalogue = await products(shipment.recipient.countryCode || null);
      const parcels = shipmondoParcels(shipment);
      const rates: Rate[] = [];
      const warnings: string[] = [];
      const base = { daysMin: null, daysMax: null, pickupDate: pickup.date, estimatedDeliveryDate: null, expiresAt: null };

      if (opts.shipmondoRates) {
        const data = await call("POST", "/quotes/list", {
          sender: stripEmpty(quoteAddress(shipment.sender)),
          receiver: stripEmpty(quoteAddress(shipment.recipient)),
          parcels,
        });
        for (const entry of Array.isArray(data) ? data : []) {
          const q = (entry ?? {}) as Record<string, unknown>;
          const code = str(q.product_code);
          if (!code) continue;
          const info = catalogue.get(code);
          const token: BookingToken = { productCode: code, serviceCodes: str(q.service_codes) ?? "", ownAgreement: false };
          rates.push({
            ...base,
            bookingToken: JSON.stringify(token),
            carrierCode: code,
            carrierName: info?.carrierName ?? str(q.carrier_code) ?? "Shipmondo",
            productName: info?.name ?? str(q.description) ?? code,
            // Excl. VAT, like Sendify's price.
            price: num(q.price_before_vat) ?? num(q.price),
            currency: str(q.currency_code) ?? "SEK",
          });
        }
      }

      for (const code of opts.ownAgreementProducts) {
        const info = catalogue.get(code);
        const name = `${info?.name ?? code} (${OWN_AGREEMENT_NAME})`;
        const customerNumber = info && info.customerNumbers.length > 1 ? info.customerNumbers[0] : undefined;
        const token: BookingToken = { productCode: code, serviceCodes: "", ownAgreement: true, ...(customerNumber ? { customerNumber } : {}) };
        let price: number | null = null;
        let currency = "SEK";
        try {
          const data = (await call("POST", "/shipments/quote", {
            own_agreement: true,
            product_code: code,
            service_codes: "",
            ...(customerNumber ? { customer_number: customerNumber } : {}),
            parties: [stripEmpty(party("sender", shipment.sender)), stripEmpty(party("receiver", shipment.recipient))],
            parcels,
          })) as Record<string, unknown> | null;
          const carrierPrice = (data?.carrier_price ?? null) as Record<string, unknown> | null;
          price = carrierPrice ? num(carrierPrice.price) : null;
          currency = (carrierPrice && str(carrierPrice.currency_code)) || "SEK";
          if (price === null) warnings.push(`${name}: transportören gav inget pris`);
        } catch (err) {
          if (err instanceof FreightProviderError && err.kind === "unauthorized") throw err;
          warnings.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
        rates.push({
          ...base,
          bookingToken: JSON.stringify(token),
          carrierCode: `${code}${OWN_AGREEMENT_SUFFIX}`,
          carrierName: info?.carrierName ?? "Shipmondo",
          productName: name,
          price,
          currency,
        });
      }
      if (!opts.shipmondoRates && opts.ownAgreementProducts.length === 0) {
        warnings.push("Varken Shipmondos priser eller egna avtal är valda — se System → Frakt");
      }
      return { rates, warnings };
    },

    async book(bookingToken, { shipment, pickup }) {
      let token: BookingToken;
      try {
        token = JSON.parse(bookingToken) as BookingToken;
      } catch {
        throw new FreightProviderError(SHIPMONDO_MESSAGES.unexpected, "unexpected");
      }
      if (!token.productCode) throw new FreightProviderError(SHIPMONDO_MESSAGES.unexpected, "unexpected");
      const data = (await call(
        "POST",
        "/shipments",
        stripEmpty({
          own_agreement: token.ownAgreement,
          product_code: token.productCode,
          service_codes: token.serviceCodes ?? "",
          customer_number: token.customerNumber,
          parties: [party("sender", shipment.sender), party("receiver", shipment.recipient)],
          parcels: shipmondoParcels(shipment),
          pickup_details: { date: pickup.date, from: `${pickup.time}:00` },
          reference: shipment.senderReference ?? shipment.referenceId,
          additional_reference: shipment.receiverReference,
          label_format: "a4_pdf",
        }),
        true
      )) as Record<string, unknown> | null;
      const id = data ? str(data.id) : null;
      if (!data || !id) throw new FreightProviderError(SHIPMONDO_MESSAGES.bookingUnknown, "booking-unknown");
      const labels = Array.isArray(data.labels) ? data.labels : [];
      const documents = labels
        .map((l) => (l ?? {}) as Record<string, unknown>)
        .filter((l) => str(l.base64) && (str(l.file_format) ?? "pdf").toLowerCase().includes("pdf"))
        .map((l) => ({ type: "label", content: Buffer.from(str(l.base64)!, "base64") }));
      return { trackingNumber: str(data.pkg_no), documentTypes: ["label"], remoteId: id, documents };
    },

    async fetchDocument(id, type) {
      const path =
        type === "waybill"
          ? `/shipments/${encodeURIComponent(id)}/waybills`
          : `/shipments/${encodeURIComponent(id)}/labels?label_format=a4_pdf`;
      const data = await call("GET", path);
      const first = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
      const content = first ? str(first.base64) : null;
      if (!content) throw new FreightProviderError("Shipmondo gav inget dokument", "unavailable");
      return Buffer.from(content, "base64");
    },

    async cancel(id) {
      const data = (await call("PUT", `/shipments/${encodeURIComponent(id)}/cancel`)) as Record<string, unknown> | null;
      if (data && data.cancelled === false) {
        throw new FreightProviderError("Shipmondo kunde inte avboka försändelsen", "validation");
      }
    },

    async getTracking() {
      throw new FreightProviderError("Shipmondo-försändelser spåras inte automatiskt", "validation");
    },

    // Hämta transportörsprodukter: the products from Sweden.
    async listProducts() {
      const catalogue = await products(null);
      return [...catalogue.entries()].flatMap(([code, info]) => [
        { carrierCode: code, carrierName: info.carrierName, productName: info.name },
        ...(info.customerNumbers.length > 0
          ? [{ carrierCode: `${code}${OWN_AGREEMENT_SUFFIX}`, carrierName: info.carrierName, productName: `${info.name} (${OWN_AGREEMENT_NAME})` }]
          : []),
      ]);
    },
  };
}

export const shipmondoProviderFactory: FreightProviderFactory = (config) => createShipmondoProvider(config);
