import type { StoredRates } from "@navet/db";
import type { ShipmentRow } from "../repository/shipping.repository.js";
import { customerPriceFor } from "./pricing.js";
import { trackingStatusLabel } from "./tracking-status.js";

// What the web sees of a rates answer: sorted by price, booking tokens
// stripped, customer price per SEK row.
export interface RateView {
  id: string;
  carrierCode: string;
  carrierName: string;
  productName: string;
  price: number;
  currency: string;
  daysMin: number | null;
  daysMax: number | null;
  pickupDate: string | null;
  estimatedDeliveryDate: string | null;
  expiresAt: string | null;
  customerPrice: number | null;
}

export interface RatesView {
  fetchedAt: string;
  warnings: string[];
  rates: RateView[];
}

export function toRatesView(stored: StoredRates, markup: { markupPercent: number; markupAmount: number }): RatesView {
  return {
    fetchedAt: stored.fetchedAt,
    warnings: stored.warnings,
    rates: [...stored.rates]
      .sort((a, b) => a.price - b.price)
      .map(({ bookingToken: _token, ...rate }) => ({
        ...rate,
        customerPrice: rate.currency === "SEK" ? customerPriceFor(rate.price, markup.markupPercent, markup.markupAmount) : null,
      })),
  };
}

export interface ShipmentDetailView {
  id: string;
  shipmentNumber: string;
  status: ShipmentRow["status"];
  customerId: string;
  customerName: string;
  recipientName: string;
  recipientAddressLine1: string | null;
  recipientAddressLine2: string | null;
  recipientPostalCode: string | null;
  recipientCity: string | null;
  recipientCountry: string;
  recipientContactName: string | null;
  recipientPhone: string | null;
  recipientEmail: string | null;
  recipientPrivatePerson: boolean;
  senderName: string | null;
  senderAddressLine1: string | null;
  senderAddressLine2: string | null;
  senderPostalCode: string | null;
  senderCity: string | null;
  senderCountry: string;
  senderContactName: string | null;
  senderPhone: string | null;
  senderEmail: string | null;
  senderReference: string | null;
  senderReferenceManual: boolean;
  receiverReference: string | null;
  pickupDate: string;
  pickupFrom: string;
  pickupTo: string;
  freightProduct: { id: string; carrierCode: string; carrierName: string; productName: string } | null;
  carrierPrice: number | null;
  carrierCurrency: string | null;
  customerPrice: number | null;
  customerPriceManual: boolean;
  trackingNumber: string | null;
  trackingUrl: string | null;
  bookedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  bookingInProgress: boolean;
  pickupWarning: string | null;
  rates: RatesView | null;
  deliveries: { id: string; deliveryNumber: string; orderId: string; orderNumber: string; deliveredAt: Date; active: boolean }[];
  parcels: {
    id: string;
    position: number;
    parcelKind: "package" | "pallet" | "other";
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    weightKg: number;
    quantity: number;
    stackable: boolean;
    loadingMeters: number | null;
    description: string | null;
  }[];
  files: { id: string; kind: string; filename: string; sizeBytes: number; createdAt: Date }[];
  // Etapp 2 — the latest tracking state plus the event log, newest first.
  tracking: {
    status: string | null;
    text: string | null;
    exception: boolean;
    checkedAt: Date | null;
    deliveredAt: Date | null;
    events: { occurredAt: Date; status: string; statusLabel: string; description: string | null; location: string | null }[];
  };
  // Etapp 2 — the invoice billing this shipment's freight (null until one
  // does; a cancelled draft releases it). invoiceNumber is null for a draft.
  invoice: { invoiceId: string; invoiceNumber: string | null; status: "draft" | "issued" | "paid" } | null;
}

const num = (v: string | null) => (v === null ? null : Number(v));

export function toDetailView(
  s: ShipmentRow,
  extras: {
    customerName: string;
    product: { id: string; carrierCode: string; carrierName: string; productName: string } | null;
    links: { deliveryId: string; deliveryNumber: string; orderId: string; orderNumber: string; deliveredAt: Date; active: boolean }[];
    parcels: {
      id: string;
      position: number;
      parcelKind: "package" | "pallet" | "other";
      lengthCm: string;
      widthCm: string;
      heightCm: string;
      weightKg: string;
      quantity: number;
      stackable: boolean;
      loadingMeters: string | null;
      description: string | null;
    }[];
    files: { id: string; kind: string; filename: string; sizeBytes: number; createdAt: Date }[];
    trackingEvents: { occurredAt: Date; status: string; description: string | null; location: string | null }[];
    invoice: { invoiceId: string; invoiceNumber: string | null; status: "draft" | "issued" | "paid" } | null;
    bookingInProgress: boolean;
    pickupWarning: string | null;
    markup: { markupPercent: number; markupAmount: number };
  }
): ShipmentDetailView {
  return {
    id: s.id,
    shipmentNumber: s.shipmentNumber,
    status: s.status,
    customerId: s.customerId,
    customerName: extras.customerName,
    recipientName: s.recipientName,
    recipientAddressLine1: s.recipientAddressLine1,
    recipientAddressLine2: s.recipientAddressLine2,
    recipientPostalCode: s.recipientPostalCode,
    recipientCity: s.recipientCity,
    recipientCountry: s.recipientCountry,
    recipientContactName: s.recipientContactName,
    recipientPhone: s.recipientPhone,
    recipientEmail: s.recipientEmail,
    recipientPrivatePerson: s.recipientPrivatePerson,
    senderName: s.senderName,
    senderAddressLine1: s.senderAddressLine1,
    senderAddressLine2: s.senderAddressLine2,
    senderPostalCode: s.senderPostalCode,
    senderCity: s.senderCity,
    senderCountry: s.senderCountry,
    senderContactName: s.senderContactName,
    senderPhone: s.senderPhone,
    senderEmail: s.senderEmail,
    senderReference: s.senderReference,
    senderReferenceManual: s.senderReferenceManual,
    receiverReference: s.receiverReference,
    pickupDate: s.pickupDate,
    pickupFrom: s.pickupFrom.slice(0, 5),
    pickupTo: s.pickupTo.slice(0, 5),
    freightProduct: extras.product
      ? { id: extras.product.id, carrierCode: extras.product.carrierCode, carrierName: extras.product.carrierName, productName: extras.product.productName }
      : null,
    carrierPrice: num(s.carrierPrice),
    carrierCurrency: s.carrierCurrency,
    customerPrice: num(s.customerPrice),
    customerPriceManual: s.customerPriceManual,
    trackingNumber: s.trackingNumber,
    trackingUrl: s.trackingUrl,
    bookedAt: s.bookedAt,
    cancelledAt: s.cancelledAt,
    createdAt: s.createdAt,
    bookingInProgress: extras.bookingInProgress,
    pickupWarning: extras.pickupWarning,
    rates: s.lastRates ? toRatesView(s.lastRates, extras.markup) : null,
    deliveries: extras.links.map((l) => ({
      id: l.deliveryId,
      deliveryNumber: l.deliveryNumber,
      orderId: l.orderId,
      orderNumber: l.orderNumber,
      deliveredAt: l.deliveredAt,
      active: l.active,
    })),
    parcels: extras.parcels.map((p) => ({
      id: p.id,
      position: p.position,
      parcelKind: p.parcelKind,
      lengthCm: Number(p.lengthCm),
      widthCm: Number(p.widthCm),
      heightCm: Number(p.heightCm),
      weightKg: Number(p.weightKg),
      quantity: p.quantity,
      stackable: p.stackable,
      loadingMeters: num(p.loadingMeters),
      description: p.description,
    })),
    files: extras.files,
    tracking: {
      status: s.trackingStatus,
      text: s.lastTrackingText,
      exception: s.trackingException,
      checkedAt: s.trackingCheckedAt,
      deliveredAt: s.deliveredAt,
      // A broker event without a status is stored as "" and shown as is.
      events: extras.trackingEvents.map((e) => ({ occurredAt: e.occurredAt, status: e.status, statusLabel: trackingStatusLabel(e.status) ?? "–", description: e.description, location: e.location })),
    },
    invoice: extras.invoice,
  };
}
