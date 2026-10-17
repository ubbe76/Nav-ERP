import { z } from "zod";

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
