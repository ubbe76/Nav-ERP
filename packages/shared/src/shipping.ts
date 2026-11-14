import { z } from "zod";
import { round2 } from "./money.js";
import { blankSafe, numericMax } from "./coerce.js";
import { businessDateSchema } from "./business-date.js";
import { listQuerySchema } from "./list.js";

// Frakt (Sendify) — see docs/superpowers/specs/2026-10-07-frakt-sendify-design.md.

export const parcelKindSchema = z.enum(["package", "pallet", "other"]);
export type ParcelKind = z.infer<typeof parcelKindSchema>;

export const shipmentStatusSchema = z.enum(["draft", "booked", "delivered", "cancelled"]);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;

// A non-negative number within its column numeric(precision, scale); null clears.
const optionalNonNegative = (precision: number, scale: number) =>
  blankSafe(z.coerce.number().nonnegative().max(numericMax(precision, scale))).nullable();

// Kollitypens fraktfält (PATCH /package-types/:id/freight) — the whole set.
// Only Paket/Pall are offered for a package type; "other" is internal.
export const packageTypeFreightSchema = z.object({
  parcelKind: z.enum(["package", "pallet"]),
  lengthMm: optionalNonNegative(10, 2),
  widthMm: optionalNonNegative(10, 2),
  heightMm: optionalNonNegative(10, 2),
  tareWeight: optionalNonNegative(12, 3),
  stackable: z.boolean(),
  loadingMeters: optionalNonNegative(8, 2),
});
export type PackageTypeFreightInput = z.infer<typeof packageTypeFreightSchema>;

// One pallet space (pallplats) = 0.4 flakmeter (loading meters).
export const PALLET_SPACE_LOADING_METERS = 0.4;

// Flakmeter to store when pallplatser is given: an explicit loadingMeters
// (number) always wins; otherwise pallet spaces > 0 derive it. `undefined`
// = leave the stored value alone (nothing to derive).
export function deriveLoadingMeters(
  palletSpaces: number | null | undefined,
  loadingMeters: number | null | undefined
): number | null | undefined {
  if (typeof loadingMeters === "number") return loadingMeters;
  if (typeof palletSpaces === "number" && palletSpaces > 0) {
    return round2(palletSpaces * PALLET_SPACE_LOADING_METERS);
  }
  return loadingMeters;
}

export const listShipmentsQuerySchema = listQuerySchema.extend({
  status: shipmentStatusSchema.optional(),
  customerId: z.string().uuid().optional(),
});
export type ListShipmentsQuery = z.infer<typeof listShipmentsQuerySchema>;

export const openDeliveriesQuerySchema = z.object({ customerId: z.string().uuid() });

export const createShipmentSchema = z.object({
  deliveryIds: z.array(z.string().uuid()).min(1).max(50),
});
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

// Egna fraktsätt (migration 0220): "sendify" is booked through the broker,
// "manual" is an own freight method (Egen bil, Kunden hämtar, an own
// agreement with a carrier) — registered as sent, never booked anywhere.
// Förmedlare (etapp 2, migration 0221): nShift and Shipmondo beside Sendify.
export const FREIGHT_BROKERS = ["sendify", "nshift", "shipmondo"] as const;
export type FreightBroker = (typeof FREIGHT_BROKERS)[number];
export const freightBrokerSchema = z.enum(FREIGHT_BROKERS);
export const SHIPMENT_PROVIDERS = [...FREIGHT_BROKERS, "manual"] as const;
export type ShipmentProvider = (typeof SHIPMENT_PROVIDERS)[number];

// The fraktsedelsnummer as typed (an own agreement's waybill); blank = none.
const waybillNumber = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().max(100).nullable()
);

// POST /shipments/manual — Eget fraktsätt for one or more följesedlar.
// carrierId omitted = the order's Speditör, else the customer's (400
// shipment-carrier-required when neither has one). shippedDate omitted =
// today. customerPrice (kr) is what the invoice's freight row charges; null =
// no freight on the invoice.
export const createManualShipmentSchema = z.object({
  deliveryIds: z.array(z.string().uuid()).min(1).max(50),
  carrierId: z.string().uuid().optional(),
  trackingNumber: waybillNumber.optional(),
  customerPrice: optionalNonNegative(14, 2).optional(),
  shippedDate: businessDateSchema.optional(),
});
export type CreateManualShipmentInput = z.infer<typeof createManualShipmentSchema>;

// PATCH /shipments/:id/manual — only on a manual shipment that is sent or
// delivered and on no invoice.
export const updateManualShipmentSchema = z
  .object({
    carrierId: z.string().uuid().optional(),
    trackingNumber: waybillNumber.optional(),
    customerPrice: optionalNonNegative(14, 2).optional(),
    shippedDate: businessDateSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Inget att ändra");
export type UpdateManualShipmentInput = z.infer<typeof updateManualShipmentSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
const optionalLine = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullable());

// PATCH /shipments/:id. Recipient/references/pickup only in draft; the
// customer price also once booked (etapp 2 invoices from it). null on
// customerPrice/senderReference = back to the derived value.
export const updateShipmentSchema = z
  .object({
    // Förmedlare of a draft: a change drops its rates, chosen product and the
    // old broker's draft.
    broker: freightBrokerSchema.optional(),
    recipientName: z.string().trim().min(1).max(255).optional(),
    recipientAddressLine1: optionalLine(255).optional(),
    recipientAddressLine2: optionalLine(255).optional(),
    recipientPostalCode: optionalLine(20).optional(),
    recipientCity: optionalLine(100).optional(),
    recipientCountry: z
      .string()
      .trim()
      .length(2)
      .transform((c) => c.toUpperCase())
      .optional(),
    recipientContactName: optionalLine(255).optional(),
    recipientPhone: optionalLine(50).optional(),
    recipientEmail: optionalLine(255).optional(),
    recipientPrivatePerson: z.boolean().optional(),
    senderReference: optionalLine(100).optional(),
    receiverReference: optionalLine(100).optional(),
    // A real calendar day (2030-02-30 is a 400, not a Postgres error = 500).
    pickupDate: businessDateSchema.optional(),
    pickupFrom: hhmm.optional(),
    pickupTo: hhmm.optional(),
    customerPrice: optionalNonNegative(14, 2).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "At least one field must be provided");
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;

export const parcelInputSchema = z.object({
  parcelKind: parcelKindSchema,
  lengthCm: blankSafe(z.coerce.number().nonnegative().max(10000)),
  widthCm: blankSafe(z.coerce.number().nonnegative().max(10000)),
  heightCm: blankSafe(z.coerce.number().nonnegative().max(10000)),
  weightKg: blankSafe(z.coerce.number().nonnegative().max(100000)),
  quantity: blankSafe(z.coerce.number().int().positive().max(999)),
  stackable: z.boolean(),
  loadingMeters: optionalNonNegative(8, 2),
  description: optionalLine(100),
});
export type ParcelInput = z.infer<typeof parcelInputSchema>;

export const replaceParcelsSchema = z.object({ parcels: z.array(parcelInputSchema).max(100) });

export const addShipmentDeliverySchema = z.object({ deliveryId: z.string().uuid() });

export const saveSelectionSchema = z.object({ rateId: z.string().uuid() });

export const bookShipmentSchema = z.union([
  z.object({ rateId: z.string().uuid() }).strict(),
  z.object({ useSelection: z.literal(true), confirmPriceChange: z.boolean().optional() }).strict(),
]);
export type BookShipmentInput = z.infer<typeof bookShipmentSchema>;

// The key goes straight into an HTTP header, so anything outside printable
// ASCII is refused here rather than by fetch's header validation (which
// would surface as "Sendify svarar inte"). One rule for the saved key and
// the key typed into Testa anslutning.
const apiKeyText = z
  .string()
  .trim()
  .max(500)
  .regex(/^[\x20-\x7E]*$/, "API-nyckeln får bara innehålla vanliga tecken");

// Frakt etapp 2 — how often the scheduler asks the broker for tracking.
export const TRACKING_INTERVALS = ["hourly", "every_4h", "daily"] as const;
export type TrackingInterval = (typeof TRACKING_INTERVALS)[number];

// A broker's product codes chosen in the settings (nShift's service ids to
// price, Shipmondo's own-agreement products).
const productCodeList = z.array(z.string().trim().min(1).max(40)).max(60);

// nShift (Delivery) — own carrier agreements only: the key id + secret
// (write-only like Sendify's key: "" keeps, null removes), the sender in
// nShift that carries the customer numbers, the services to price, whether
// prices are asked (Professional plan), and Testläge (test: true).
export const nshiftSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    testMode: z.boolean().optional(),
    apiKeyId: apiKeyText.nullable().optional(),
    apiSecret: apiKeyText.nullable().optional(),
    senderQuickId: z.string().trim().max(40).optional(),
    services: productCodeList.optional(),
    priceEnquiry: z.boolean().optional(),
  })
  .strict();

// Shipmondo — its own rates (Shipmondos priser) and/or own agreements on the
// chosen products; API user + API key (write-only).
export const shipmondoSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    environment: z.enum(["sandbox", "production"]).optional(),
    apiUser: apiKeyText.nullable().optional(),
    apiKey: apiKeyText.nullable().optional(),
    shipmondoRates: z.boolean().optional(),
    ownAgreementProducts: productCodeList.optional(),
  })
  .strict();

// PATCH /freight-settings. apiKey: "" = leave the stored key, null = remove it.
export const updateFreightSettingsSchema = z
  .object({
    // Förvald förmedlare for a new shipment without a chosen product.
    defaultBroker: freightBrokerSchema.optional(),
    nshift: nshiftSettingsSchema.optional(),
    shipmondo: shipmondoSettingsSchema.optional(),
    enabled: z.boolean().optional(),
    environment: z.enum(["sandbox", "production"]).optional(),
    apiKey: apiKeyText.nullable().optional(),
    senderContactName: z.string().trim().max(255).optional(),
    senderPhone: z.string().trim().max(50).optional(),
    senderEmail: z.string().trim().max(255).optional(),
    markupPercent: blankSafe(z.coerce.number().min(0).max(1000)).optional(),
    markupAmount: blankSafe(z.coerce.number().min(0).max(1_000_000)).optional(),
    freightArticleId: z.string().uuid().nullable().optional(),
    priceChangePercent: blankSafe(z.coerce.number().min(0).max(100)).optional(),
    trackingInterval: z.enum(TRACKING_INTERVALS).optional(),
  })
  .strict();
export type UpdateFreightSettingsInput = z.infer<typeof updateFreightSettingsSchema>;

// "Testa anslutning": the key typed in the form (not yet saved) and the
// environment selected there; both optional — omitted = the saved values.
// broker omitted = Sendify (as before). apiSecret: nShift's secret /
// Shipmondo's API key, with apiKey as the key id / API user.
export const testFreightConnectionSchema = z
  .object({
    broker: freightBrokerSchema.optional(),
    apiKey: apiKeyText.min(1).optional(),
    apiSecret: apiKeyText.min(1).optional(),
    environment: z.enum(["sandbox", "production"]).optional(),
  })
  .strict();
export type TestFreightConnectionInput = z.infer<typeof testFreightConnectionSchema>;

export const pickupTimesSchema = z.object({
  pickupTimes: z
    .array(
      z
        .object({ weekday: z.number().int().min(1).max(7), timeFrom: hhmm, timeTo: hhmm })
        .refine((r) => r.timeFrom < r.timeTo, "Från måste vara före Till")
    )
    .max(7)
    .refine((rows) => new Set(rows.map((r) => r.weekday)).size === rows.length, "En rad per veckodag"),
});
export type PickupTimesInput = z.infer<typeof pickupTimesSchema>;

// Frakt på offert och kundorder.
export const orderFreightRatesSchema = z.object({ parcels: z.array(parcelInputSchema).min(1).max(100) });
export type OrderFreightRatesInput = z.infer<typeof orderFreightRatesSchema>;

export const addOrderFreightSchema = z.object({ rateId: z.string().uuid() });
