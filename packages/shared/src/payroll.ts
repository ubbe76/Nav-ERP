import { z } from "zod";
import { clockTimeSchema, overtimeDispositions } from "./timereport.js";

export const obDayKinds = ["weekday", "saturday", "sunday", "holiday"] as const;
export type ObDayKind = (typeof obDayKinds)[number];

export const createAbsenceTypeSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
  paxmlCode: z.string().trim().min(1).max(20),
  active: z.boolean().optional(),
});
export const updateAbsenceTypeSchema = createAbsenceTypeSchema.partial()
  .refine((d) => Object.keys(d).length > 0, "At least one field must be provided");

export const createObRuleSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
  dayKind: z.enum(obDayKinds),
  startTime: clockTimeSchema,
  endTime: clockTimeSchema,
  paxmlCode: z.string().trim().min(1).max(20),
  active: z.boolean().optional(),
});
export const updateObRuleSchema = createObRuleSchema.partial()
  .refine((d) => Object.keys(d).length > 0, "At least one field must be provided");

export type CreateAbsenceTypeInput = z.infer<typeof createAbsenceTypeSchema>;
export type UpdateAbsenceTypeInput = z.infer<typeof updateAbsenceTypeSchema>;
export type CreateObRuleInput = z.infer<typeof createObRuleSchema>;
export type UpdateObRuleInput = z.infer<typeof updateObRuleSchema>;

// Frånvaroregistrering: a booked absence for one employee on one day. `date`
// as a date-only string (not datetime) — absences are whole calendar days,
// even when `minutes` covers only part of the scheduled day (e.g. half sick).
export const createAbsenceSchema = z.object({
  absenceTypeId: z.string().uuid(),
  date: z.string().date(),
  minutes: z.coerce.number().int().min(1).max(1440),
  note: z.string().max(2000).optional(),
});
export type CreateAbsenceInput = z.infer<typeof createAbsenceSchema>;

// Per-day override of an employee's default overtime compensation
// (övertidsersättning vs komptid).
export const setOvertimeDispositionSchema = z.object({
  disposition: z.enum(overtimeDispositions),
});
export type SetOvertimeDispositionInput = z.infer<typeof setOvertimeDispositionSchema>;
