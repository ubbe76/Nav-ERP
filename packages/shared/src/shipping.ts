import { z } from "zod";
import { blankSafe } from "./coerce.js";
import { listQuerySchema } from "./list.js";

// Frakt (Sendify) — see docs/superpowers/specs/2026-10-07-frakt-sendify-design.md.

export const parcelKindSchema = z.enum(["package", "pallet", "other"]);
export type ParcelKind = z.infer<typeof parcelKindSchema>;

export const shipmentStatusSchema = z.enum(["draft", "booked", "delivered", "cancelled"]);
export type ShipmentStatus = z.infer<typeof shipmentStatusSchema>;

const nonNegative = blankSafe(z.coerce.number().nonnegative());
const optionalNonNegative = nonNegative.nullable();

// Kollitypens fraktfält (PATCH /package-types/:id/freight) — the whole set.
// Only Paket/Pall are offered for a package type; "other" is internal.
export const packageTypeFreightSchema = z.object({
  parcelKind: z.enum(["package", "pallet"]),
  lengthMm: optionalNonNegative,
  widthMm: optionalNonNegative,
  heightMm: optionalNonNegative,
  tareWeight: optionalNonNegative,
  stackable: z.boolean(),
  loadingMeters: optionalNonNegative,
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
    return Math.round(palletSpaces * PALLET_SPACE_LOADING_METERS * 100) / 100;
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

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const optionalLine = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullable());

// PATCH /shipments/:id. Recipient/references/pickup only in draft; the
// customer price also once booked (etapp 2 invoices from it). null on
// customerPrice/senderReference = back to the derived value.
export const updateShipmentSchema = z
  .object({
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
    pickupDate: isoDate.optional(),
    pickupFrom: hhmm.optional(),
    pickupTo: hhmm.optional(),
    customerPrice: optionalNonNegative.optional(),
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
  loadingMeters: optionalNonNegative,
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

// PATCH /freight-settings. apiKey: "" = leave the stored key, null = remove it.
// The key goes straight into an HTTP header, so anything outside printable
// ASCII is refused here rather than by fetch's header validation.
// Frakt etapp 2 — how often the scheduler asks the broker for tracking.
export const TRACKING_INTERVALS = ["hourly", "every_4h", "daily"] as const;
export type TrackingInterval = (typeof TRACKING_INTERVALS)[number];

export const updateFreightSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    environment: z.enum(["sandbox", "production"]).optional(),
    apiKey: z
      .string()
      .trim()
      .max(500)
      .regex(/^[\x20-\x7E]*$/, "API-nyckeln får bara innehålla vanliga tecken")
      .nullable()
      .optional(),
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
export const testFreightConnectionSchema = z
  .object({ apiKey: z.string().trim().min(1).optional(), environment: z.enum(["sandbox", "production"]).optional() })
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
