import { FreightProviderError, type FreightProvider, type ProviderContext, type ProviderShipment, type Rate, type TrackingEvent } from "../../src/modules/shipping/service/freight-provider.js";

// In-memory FreightProvider for the shipping tests. Every getRates issues
// FRESH tokens (like Sendify) so a stale token is detectable; `state` lets a
// test script failures and delays.
export interface FakeFreight {
  provider: FreightProvider;
  factory: () => FreightProvider;
  calls: { method: string; args: unknown[] }[];
  state: {
    prices: { carrierCode: string; carrierName: string; productName: string; price: number; currency: string }[];
    expiresInMs: number;
    createDelayMs: number;
    ratesDelayMs: number;
    ratesError: Error | null;
    bookError: Error | null;
    bookDelayMs: number;
    cancelError: Error | null;
    cancelDelayMs: number;
    documentError: Error | null;
    documentTypes: string[];
    round: number;
    created: ProviderShipment[];
    // Etapp 2 — tracking events per broker shipment id.
    tracking: Record<string, TrackingEvent[]>;
    trackingError: Error | null;
  };
}

export const SANDBOX_PRICES = [
  { carrierCode: "dhl", carrierName: "DHL Freight", productName: "DHL Paket", price: 412.4, currency: "SEK" },
  { carrierCode: "ups", carrierName: "UPS", productName: "UPS Express", price: 520, currency: "SEK" },
];

export function createFakeFreightProvider(): FakeFreight {
  const calls: FakeFreight["calls"] = [];
  const state: FakeFreight["state"] = {
    prices: SANDBOX_PRICES.map((p) => ({ ...p })),
    expiresInMs: 60 * 60 * 1000,
    createDelayMs: 0,
    ratesDelayMs: 0,
    ratesError: null,
    bookError: null,
    bookDelayMs: 0,
    cancelError: null,
    cancelDelayMs: 0,
    documentError: null,
    documentTypes: ["label", "waybill"],
    round: 0,
    created: [],
    tracking: {},
    trackingError: null,
  };
  let nextId = 1;
  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const provider: FreightProvider = {
    name: "sendify",
    remoteDrafts: true,
    tracks: true,
    async checkKey() {
      record("checkKey");
      return { team: "Testteam" };
    },
    async createShipment(s) {
      record("createShipment", s);
      if (state.createDelayMs > 0) await new Promise((r) => setTimeout(r, state.createDelayMs));
      state.created.push(s);
      return `fake-${nextId++}`;
    },
    async updateShipment(id, s) {
      record("updateShipment", id, s);
    },
    async deleteShipment(id) {
      record("deleteShipment", id);
    },
    // Recorded as (remote id, pickup) — the shape the tests read.
    async getRates({ remoteId: id, pickup }) {
      record("getRates", id, pickup);
      if (state.ratesDelayMs > 0) await new Promise((r) => setTimeout(r, state.ratesDelayMs));
      if (state.ratesError) throw state.ratesError;
      state.round++;
      const expiresAt = new Date(Date.now() + state.expiresInMs).toISOString();
      const rates: Rate[] = state.prices.map((p) => ({
        bookingToken: `tok-${p.carrierCode}-${state.round}`,
        ...p,
        daysMin: 1,
        daysMax: 2,
        pickupDate: pickup.date,
        estimatedDeliveryDate: null,
        expiresAt,
      }));
      return { rates, warnings: ["Schenker: för tungt"] };
    },
    async book(token) {
      record("book", token);
      if (state.bookDelayMs > 0) await new Promise((r) => setTimeout(r, state.bookDelayMs));
      if (state.bookError) throw state.bookError;
      return { trackingNumber: `TRK-${token}`, documentTypes: state.documentTypes };
    },
    async fetchDocument(id, type) {
      record("fetchDocument", id, type);
      if (state.documentError) throw state.documentError;
      return Buffer.from(`%PDF-1.4 ${type} ${id}`);
    },
    async cancel(id) {
      record("cancel", id);
      if (state.cancelDelayMs > 0) await new Promise((r) => setTimeout(r, state.cancelDelayMs));
      if (state.cancelError) throw state.cancelError;
    },
    async getTracking(id) {
      record("getTracking", id);
      if (state.trackingError) throw state.trackingError;
      return state.tracking[id] ?? [];
    },
  };
  return { provider, factory: () => provider, calls, state };
}

export const refused = (message: string) => new FreightProviderError(message, "validation");

// A whole ProviderContext for calling a provider directly (Sendify ignores
// all but the remote id; the brokers without drafts book from the shipment).
const SAMPLE_PARTY = {
  name: "Exempel AB",
  addressLine1: "Gatan 1",
  addressLine2: null,
  postalCode: "12345",
  city: "Staden",
  countryCode: "SE",
  contactName: "Anna",
  phone: "0123-45 67 00",
  email: "frakt@exempel.invalid",
};
export function sampleContext(remoteId: string | null, pickup = { date: "2030-07-02", time: "09:00" }): ProviderContext {
  return {
    remoteId,
    pickup,
    shipment: {
      sender: SAMPLE_PARTY,
      recipient: { ...SAMPLE_PARTY, name: "Kund AB" },
      parcels: [{ kind: "package", lengthCm: 40, widthCm: 30, heightCm: 20, weightKg: 5, quantity: 1, stackable: true, loadingMeters: null, description: null }],
      referenceId: "FR-1",
      senderReference: null,
      receiverReference: null,
    },
  };
}
