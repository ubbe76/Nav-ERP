import type { ParcelKind } from "@navet/shared";

// The ONE seam between Nav and a transport broker (förmedlare): Sendify,
// nShift (Delivery) and Shipmondo. The shipping service only ever speaks
// this format; each <broker>-provider.ts is the only file that knows its
// broker, and tests inject a fake.

// The brokers a shipment can be booked through (shipments.provider, beside
// "manual" = Eget fraktsätt).
export const BROKERS = ["sendify", "nshift", "shipmondo"] as const;
export type BrokerName = (typeof BROKERS)[number];

export const BROKER_LABELS: Record<BrokerName, string> = { sendify: "Sendify", nshift: "nShift", shipmondo: "Shipmondo" };

export interface ProviderParty {
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string;
  city: string;
  countryCode: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  privatePerson?: boolean;
}

export interface ProviderParcel {
  kind: ParcelKind;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  weightKg: number; // per parcel
  quantity: number;
  stackable: boolean;
  loadingMeters: number | null; // per unit
  description: string | null;
}

export interface ProviderShipment {
  sender: ProviderParty;
  recipient: ProviderParty;
  parcels: ProviderParcel[];
  referenceId: string; // our shipment number
  senderReference: string | null; // printed on the label
  receiverReference: string | null; // printed on the label
}

export interface Rate {
  bookingToken: string;
  carrierCode: string;
  carrierName: string;
  productName: string;
  // null = the broker gives no price for it (an own agreement without a
  // price enquiry) — bookable, the kundpris is typed by hand.
  price: number | null;
  currency: string;
  daysMin: number | null;
  daysMax: number | null;
  pickupDate: string | null;
  estimatedDeliveryDate: string | null;
  expiresAt: string | null; // ISO 8601
}

export interface TrackingEvent {
  occurredAt: string; // ISO 8601
  status: string | null;
  description: string | null;
  location: string | null;
  url: string | null;
}

// What a price fetch and a booking get: the broker's draft (null when the
// broker keeps none — remoteDrafts false — or none is made yet), the
// shipment as it stands and the pickup asked for (Swedish wall-clock date +
// "HH:MM").
export interface ProviderContext {
  remoteId: string | null;
  shipment: ProviderShipment;
  pickup: { date: string; time: string };
}

export interface BookResult {
  trackingNumber: string | null;
  // Document types the broker offers for fetchDocument ("waybill", "label").
  documentTypes: string[];
  // The booked shipment's id at the broker when it is not the draft's
  // (nShift books a stored shipment into a new one; Shipmondo has no draft).
  remoteId?: string | null;
  // Documents that came with the booking — stored at once (nShift's PDFs
  // live only an hour at nShift).
  documents?: { type: string; content: Buffer }[];
}

export interface FreightProvider {
  readonly name: BrokerName; // freight_products.provider
  // Whether the broker keeps a draft of the shipment (Sendify, nShift) that
  // createShipment/updateShipment/deleteShipment maintain. Without one the
  // draft lives only in Nav and those three are never called.
  readonly remoteDrafts: boolean;
  // Whether getTracking can be asked per shipment (Sendify).
  readonly tracks: boolean;
  checkKey(): Promise<{ team: string | null }>;
  createShipment(shipment: ProviderShipment): Promise<string>;
  updateShipment(id: string, shipment: ProviderShipment): Promise<void>;
  deleteShipment(id: string): Promise<void>;
  getRates(ctx: ProviderContext): Promise<{ rates: Rate[]; warnings: string[] }>;
  book(bookingToken: string, ctx: ProviderContext): Promise<BookResult>;
  fetchDocument(id: string, type: string): Promise<Buffer>;
  cancel(id: string): Promise<void>;
  getTracking(id: string): Promise<TrackingEvent[]>; // etapp 2
  // The broker's product catalogue for Hämta transportörsprodukter, when it
  // has one to list (nShift, Shipmondo); otherwise a sample shipment is
  // priced (Sendify).
  listProducts?(): Promise<{ carrierCode: string; carrierName: string; productName: string }[]>;
}

// One shape for every broker: apiKey/apiSecret are the credentials as the
// broker names them (Sendify: the key; nShift: key id + secret; Shipmondo:
// API user + API key), `options` the broker's own settings.
export interface FreightProviderConfig {
  environment: "sandbox" | "production";
  apiKey: string;
  apiSecret?: string | null;
  options?: Record<string, unknown>;
}

export type FreightProviderFactory = (config: FreightProviderConfig) => FreightProvider;

// validation: the broker refused the data (4xx) → 400 with fieldErrors.
// unauthorized: the broker rejected our API key (401/403) → point at settings.
// unavailable: network/timeout/429/5xx → 502. booking-unknown: no answer, a
// 5xx, or a 2xx we cannot read, on the BOOK call itself — it may have gone
// through → 502 with a warning text. unexpected: an answer we cannot read
// (any other call) → 502.
export type FreightProviderErrorKind = "validation" | "unauthorized" | "unavailable" | "booking-unknown" | "unexpected";

export class FreightProviderError extends Error {
  constructor(
    message: string,
    readonly kind: FreightProviderErrorKind,
    readonly fieldErrors: string[] = [],
    readonly requestId: string | null = null
  ) {
    super(message);
    this.name = "FreightProviderError";
  }
}
