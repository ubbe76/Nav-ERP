import { z } from "zod";
import { businessDateSchema } from "./business-date.js";

// Fasta leveransdagar — the partner fields on suppliers and customers and
// the system defaults. The date rules live in the API's delivery-days.ts.
export const DELIVERY_DAY_MODES = ["arrival", "dispatch"] as const;
export const deliveryDayModeSchema = z.enum(DELIVERY_DAY_MODES);
export type DeliveryDayMode = z.infer<typeof deliveryDayModeSchema>;

export const transitDaysSchema = z.number().int().min(0).max(60);

// ISO weekdays (Monday = 1), stored sorted without duplicates.
export const deliveryWeekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .max(7)
  .transform((v) => [...new Set(v)].sort((a, b) => a - b));

// Spread into the create/update schemas of both suppliers and customers.
// Mode and transit days null = the system default for the side.
export const partnerDeliveryFields = {
  deliveryWeekdays: deliveryWeekdaysSchema.optional(),
  deliveryDayMode: deliveryDayModeSchema.nullable().optional(),
  transitDays: transitDaysSchema.nullable().optional(),
};

// A partner's effective settings (own values, else the system default).
export interface DeliverySettingsView {
  weekdays: number[];
  mode: DeliveryDayMode;
  transitDays: number;
}

// GET /supplier-delivery-date-suggestion — without articleId the order
// header's suggestion, with it the row's (catalog lead time). `date` is
// checked against the supplier's days for `warning`. Both `date` fields
// feed date arithmetic, hence businessDateSchema (1900–2999).
export const supplierDeliveryDateQuerySchema = z.object({
  supplierId: z.string().uuid(),
  articleId: z.string().uuid().optional(),
  date: businessDateSchema.optional(),
});
export type SupplierDeliveryDateQuery = z.infer<typeof supplierDeliveryDateQuerySchema>;

export interface SupplierDeliveryDateSuggestion {
  date: string | null; // null = nothing to suggest (no fixed days, lead time or transit)
  leadTimeDays: number | null;
  settings: DeliverySettingsView;
  summary: string | null;
  warning: string | null;
}

// GET /customer-delivery-date-suggestion — the earliest delivery date (the
// day the customer gets the goods) and the warning for `date`.
export const customerDeliveryDateQuerySchema = z.object({
  customerId: z.string().uuid(),
  date: businessDateSchema.optional(),
});
export type CustomerDeliveryDateQuery = z.infer<typeof customerDeliveryDateQuerySchema>;

export interface CustomerDeliveryDateSuggestion {
  date: string | null; // null = the customer has no fixed days
  settings: DeliverySettingsView;
  summary: string | null;
  warning: string | null;
}
