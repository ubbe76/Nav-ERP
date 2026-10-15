import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { parcelKindEnum } from "./register";
import { customers, deliveries } from "./sales";

// Same local bytea helper as the other schema files (no built-in in drizzle).
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Frakt (Sendify) — PLANER punkt 1. See
// docs/superpowers/specs/2026-10-07-frakt-sendify-design.md.

// Transportörsprodukter: upserted from every rates answer and from
// "Hämta transportörsprodukter". Stable target for a shipment's chosen/booked
// product (and, in etapp 3, a customer's default product).
export const freightProducts = pgTable(
  "freight_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: varchar("provider", { length: 20 }).notNull(),
    carrierCode: varchar("carrier_code", { length: 50 }).notNull(),
    carrierName: varchar("carrier_name", { length: 100 }).notNull(),
    productName: varchar("product_name", { length: 150 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("freight_products_provider_carrier_product_unique").on(t.provider, t.carrierCode, t.productName)]
);

// Upphämtningstider per ISO weekday (1 = måndag … 7 = söndag). A weekday
// without a row has no pickup; full-day holidays never have one.
export const pickupTimes = pgTable(
  "pickup_times",
  {
    weekday: smallint("weekday").primaryKey(),
    timeFrom: time("time_from").notNull(),
    timeTo: time("time_to").notNull(),
  },
  (t) => [
    check("pickup_times_weekday_range", sql`${t.weekday} BETWEEN 1 AND 7`),
    check("pickup_times_order", sql`${t.timeFrom} < ${t.timeTo}`),
  ]
);

export const shipmentStatusEnum = pgEnum("shipment_status", ["draft", "booked", "delivered", "cancelled"]);

// One rate row as the shipping service stores it. bookingToken NEVER leaves
// the API — the GET view strips it; booking picks the row by id. Optional
// because a kundorder's freight_quote (a price probe, never booked) is stored
// WITHOUT it — the sales module returns that column raw; a försändelse's
// last_rates always carries it.
export interface StoredRate {
  id: string;
  bookingToken?: string;
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
}
export interface StoredRates {
  fetchedAt: string;
  rates: StoredRate[];
  warnings: string[];
}

// Försändelse (FR- number from number_series "shipment"). Status flow
// draft → booked → delivered, cancelled from draft/booked — validated in
// shipping.service.ts. Recipient/sender are snapshots: recipient editable in
// draft, sender refreshed from the settings at every rates fetch while draft.
export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentNumber: varchar("shipment_number", { length: 20 }).notNull().unique(),
    status: shipmentStatusEnum("status").notNull().default("draft"),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    recipientName: varchar("recipient_name", { length: 255 }).notNull(),
    recipientAddressLine1: varchar("recipient_address_line1", { length: 255 }),
    recipientAddressLine2: varchar("recipient_address_line2", { length: 255 }),
    recipientPostalCode: varchar("recipient_postal_code", { length: 20 }),
    recipientCity: varchar("recipient_city", { length: 100 }),
    recipientCountry: varchar("recipient_country", { length: 2 }).notNull().default("SE"),
    recipientContactName: varchar("recipient_contact_name", { length: 255 }),
    recipientPhone: varchar("recipient_phone", { length: 50 }),
    recipientEmail: varchar("recipient_email", { length: 255 }),
    recipientPrivatePerson: boolean("recipient_private_person").notNull().default(false),
    senderName: varchar("sender_name", { length: 255 }),
    senderAddressLine1: varchar("sender_address_line1", { length: 255 }),
    senderAddressLine2: varchar("sender_address_line2", { length: 255 }),
    senderPostalCode: varchar("sender_postal_code", { length: 20 }),
    senderCity: varchar("sender_city", { length: 100 }),
    senderCountry: varchar("sender_country", { length: 2 }).notNull().default("SE"),
    senderContactName: varchar("sender_contact_name", { length: 255 }),
    senderPhone: varchar("sender_phone", { length: 50 }),
    senderEmail: varchar("sender_email", { length: 255 }),
    senderReference: varchar("sender_reference", { length: 100 }),
    // True once the user typed their own avsändarreferens — following
    // delivery add/remove then leaves it alone ("manuellt vinner").
    senderReferenceManual: boolean("sender_reference_manual").notNull().default(false),
    receiverReference: varchar("receiver_reference", { length: 100 }),
    pickupDate: date("pickup_date").notNull(),
    pickupFrom: time("pickup_from").notNull(),
    pickupTo: time("pickup_to").notNull(),
    providerShipmentId: varchar("provider_shipment_id", { length: 100 }),
    lastRates: jsonb("last_rates").$type<StoredRates>(),
    ratesFetchedAt: timestamp("rates_fetched_at", { withTimezone: true }),
    freightProductId: uuid("freight_product_id").references(() => freightProducts.id, { onDelete: "restrict" }),
    carrierPrice: numeric("carrier_price", { precision: 14, scale: 2 }),
    carrierCurrency: varchar("carrier_currency", { length: 3 }),
    customerPrice: numeric("customer_price", { precision: 14, scale: 2 }),
    customerPriceManual: boolean("customer_price_manual").notNull().default(false),
    trackingNumber: varchar("tracking_number", { length: 100 }),
    trackingUrl: text("tracking_url"),
    // Etapp 2 — spårning. tracking_status is the raw status of the LATEST
    // event; tracking_exception mirrors that event's class (a normal event
    // after a deviation clears it). delivered_at = the DELIVERED event's time.
    trackingStatus: varchar("tracking_status", { length: 50 }),
    lastTrackingText: varchar("last_tracking_text", { length: 500 }),
    trackingException: boolean("tracking_exception").notNull().default(false),
    trackingCheckedAt: timestamp("tracking_checked_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // Sendify's available_document_types at booking ("waybill", "label").
    documentTypes: text("document_types").array().notNull().default(sql`'{}'::text[]`),
    // Booking reservation: set by an atomic UPDATE before Sendify is called,
    // so two concurrent "Boka" can never book twice. Older than 2 minutes =
    // abandoned. Cleared on success and on failure.
    bookingStartedAt: timestamp("booking_started_at", { withTimezone: true }),
    // Avbokningsreservation (frakt-uppföljning): set while the cancel call to
    // the broker is in flight; invoices refuse the freight meanwhile. Stale
    // after CANCEL_STALE_MS, like booking_started_at.
    cancelStartedAt: timestamp("cancel_started_at", { withTimezone: true }),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    bookedBy: uuid("booked_by").references(() => users.id, { onDelete: "set null" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_shipments_customer").on(t.customerId), index("idx_shipments_status").on(t.status)]
);

// Följesedlar in a shipment. `active` goes false when the shipment is
// cancelled — history kept, and the partial unique index lets the delivery be
// booked again. A delivery is in at most ONE live shipment.
export const shipmentDeliveries = pgTable(
  "shipment_deliveries",
  {
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => deliveries.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.shipmentId, t.deliveryId] }),
    uniqueIndex("shipment_deliveries_active_delivery_unique").on(t.deliveryId).where(sql`${t.active}`),
  ]
);

// Kollin — in cm (the carrier's unit), weight per parcel in kg, quantity of
// identical parcels, flakmeter per unit.
export const shipmentParcels = pgTable(
  "shipment_parcels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    parcelKind: parcelKindEnum("parcel_kind").notNull(),
    lengthCm: numeric("length_cm", { precision: 8, scale: 1 }).notNull().default("0"),
    widthCm: numeric("width_cm", { precision: 8, scale: 1 }).notNull().default("0"),
    heightCm: numeric("height_cm", { precision: 8, scale: 1 }).notNull().default("0"),
    weightKg: numeric("weight_kg", { precision: 10, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull(),
    stackable: boolean("stackable").notNull().default(false),
    loadingMeters: numeric("loading_meters", { precision: 8, scale: 2 }),
    description: varchar("description", { length: 100 }),
  },
  (t) => [
    index("idx_shipment_parcels_shipment").on(t.shipmentId),
    check("shipment_parcels_quantity_positive", sql`${t.quantity} > 0`),
  ]
);

// Fraktsedel/etikett PDFs (same bytea pattern as article_files — listings
// never select `data`). One per kind; "Hämta fraktsedel" replaces it.
export const shipmentFiles = pgTable(
  "shipment_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 20 }).notNull(),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("shipment_files_shipment_kind_unique").on(t.shipmentId, t.kind)]
);

// Spårningshändelser from the broker. status is NOT NULL ('' when the broker
// sent none) so the unique key can be a plain column index and re-runs insert
// with ON CONFLICT DO NOTHING — never a duplicate.
export const shipmentTrackingEvents = pgTable(
  "shipment_tracking_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 50 }).notNull().default(""),
    description: text("description"),
    location: varchar("location", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipment_tracking_events_unique").on(t.shipmentId, t.occurredAt, t.status),
    index("idx_shipment_tracking_events_shipment").on(t.shipmentId),
  ]
);
