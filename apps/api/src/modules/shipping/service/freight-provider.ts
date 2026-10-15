import type { ParcelKind } from "@navet/shared";

// The ONE seam between Nav and a transport broker (Sendify today). The
// shipping service only ever speaks this format; sendify-provider.ts is the
// only file that knows Sendify, and tests inject a fake.

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
  price: number;
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

export interface FreightProvider {
  readonly name: string; // freight_products.provider
  checkKey(): Promise<{ team: string | null }>;
  createShipment(shipment: ProviderShipment): Promise<string>;
  updateShipment(id: string, shipment: ProviderShipment): Promise<void>;
  deleteShipment(id: string): Promise<void>;
  // pickup: Swedish wall-clock date + "HH:MM".
  getRates(id: string, pickup: { date: string; time: string }): Promise<{ rates: Rate[]; warnings: string[] }>;
  book(bookingToken: string): Promise<{ trackingNumber: string | null; documentTypes: string[] }>;
  fetchDocument(id: string, type: string): Promise<Buffer>;
  cancel(id: string): Promise<void>;
  getTracking(id: string): Promise<TrackingEvent[]>; // etapp 2
}

export interface FreightProviderConfig {
  environment: "sandbox" | "production";
  apiKey: string;
}

export type FreightProviderFactory = (config: FreightProviderConfig) => FreightProvider;

// validation: the broker refused the data (4xx) → 400 with fieldErrors.
// unauthorized: the broker rejected our API key (401/403) → point at settings.
// unavailable: network/timeout/429/5xx → 502. booking-unknown: no answer, or
// a 5xx, on the BOOK call itself — it may have gone through → 502 with a
// warning text. unexpected: an answer we cannot read → 502.
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
