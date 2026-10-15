import { z } from "zod";
import { materialShortageOverrideSchema } from "./manufacturing.js";

export const createEmployeeSchema = z.object({
  employeeNumber: z.string().min(1).max(50),
  name: z.string().min(1).max(255),
  active: z.boolean().default(true),
});
export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;

// Personnummer, loosely validated (YYMMDD-XXXX or YYYYMMDD-XXXX, dash optional)
// — the register stores what payroll needs, it doesn't verify checksums.
const personalIdentityNumber = z.string().regex(/^\d{6,8}-?\d{4}$/, "Ogiltigt personnummer");

export const employmentTypes = ["hourly", "monthly"] as const;
export type EmploymentType = (typeof employmentTypes)[number];

// How overtime is compensated: paid out (övertidsersättning) or banked as
// comp time (komptid).
export const overtimeDispositions = ["payout", "comp"] as const;
export type OvertimeDisposition = (typeof overtimeDispositions)[number];

// ATF (arbetstidsförkortning): bank = tidbank, weekly = veckouttag.
export const atfModes = ["bank", "weekly"] as const;
export type AtfMode = (typeof atfModes)[number];

export const updateEmployeeSchema = z
  .object({
    employeeNumber: z.string().min(1).max(50).optional(),
    name: z.string().min(1).max(255).optional(),
    active: z.boolean().optional(),
    // Kontaktuppgifter
    phone: z.string().max(50).nullable().optional(),
    email: z.string().email().max(255).nullable().optional(),
    address: z.string().max(255).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    city: z.string().max(100).nullable().optional(),
    // Anställningsdata
    personalIdentityNumber: personalIdentityNumber.nullable().optional(),
    employedFrom: z.string().date().nullable().optional(),
    employedTo: z.string().date().nullable().optional(),
    // Löneuppgifter — wage is timlön or månadslön depending on employmentType.
    employmentType: z.enum(employmentTypes).nullable().optional(),
    overtimeCompensation: z.enum(overtimeDispositions).optional(),
    wage: z.coerce.number().nonnegative().nullable().optional(),
    weeklyHours: z.coerce.number().nonnegative().max(168).nullable().optional(),
    // Standardveckoschema — null clears it.
    defaultWeekScheduleId: z.string().uuid().nullable().optional(),
    // ATF: mode bank (tidbank) / weekly (veckouttag); minutesPerWeek null =
    // follow the system setting; startDate null = no accrual.
    atfMode: z.enum(atfModes).optional(),
    atfMinutesPerWeek: z.number().int().min(0).max(600).nullable().optional(),
    atfStartDate: z.string().date().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;

// --- ATF (arbetstidsförkortning) ---

export const atfTransactionTypes = ["withdrawal", "adjustment"] as const;
export type AtfTransactionType = (typeof atfTransactionTypes)[number];

// Withdrawal (uttag) = positive minutes taken from the balance; adjustment
// (justering) = signed correction, e.g. ingående saldo.
export const createAtfTransactionSchema = z
  .object({
    date: z.string().date(),
    type: z.enum(atfTransactionTypes),
    minutes: z.number().int().min(-100_000).max(100_000),
    note: z.string().max(2000).optional(),
  })
  .refine((data) => data.type !== "withdrawal" || (data.minutes > 0 && data.minutes <= 1440), {
    message: "Ett uttag måste vara 1–1440 minuter",
  })
  .refine((data) => data.type !== "adjustment" || data.minutes !== 0, {
    message: "En justering kan inte vara 0 minuter",
  });
export type CreateAtfTransactionInput = z.infer<typeof createAtfTransactionSchema>;

// --- Scheman & kalender ---

// Rast (unpaid — deducted from working time) vs paus (paid — included).
export const scheduleBreakTypes = ["unpaid", "paid"] as const;
export type ScheduleBreakType = (typeof scheduleBreakTypes)[number];

// "HH:MM" — Postgres `time` columns return "HH:MM:SS"; the repository layer
// normalizes responses back to "HH:MM".
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ogiltigt klockslag (HH:MM)");

const scheduleBreakSchema = z.object({
  type: z.enum(scheduleBreakTypes),
  startTime: clockTimeSchema,
  endTime: clockTimeSchema,
});
export type ScheduleBreakInput = z.infer<typeof scheduleBreakSchema>;

export const createDayScheduleSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  startTime: clockTimeSchema,
  endTime: clockTimeSchema,
  breaks: z.array(scheduleBreakSchema).default([]),
  active: z.boolean().default(true),
});
export type CreateDayScheduleInput = z.infer<typeof createDayScheduleSchema>;

// `breaks` is replaced wholesale when provided.
export const updateDayScheduleSchema = z
  .object({
    code: z.string().min(1).max(20).optional(),
    name: z.string().min(1).max(100).optional(),
    startTime: clockTimeSchema.optional(),
    endTime: clockTimeSchema.optional(),
    breaks: z.array(scheduleBreakSchema).optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateDayScheduleInput = z.infer<typeof updateDayScheduleSchema>;

// ISO weekday: 1 = Monday … 7 = Sunday. A weekday without an entry is a day
// off (ledig).
const weekScheduleDaySchema = z.object({
  weekday: z.number().int().min(1).max(7),
  dayScheduleId: z.string().uuid(),
});
export type WeekScheduleDayInput = z.infer<typeof weekScheduleDaySchema>;

export const createWeekScheduleSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  days: z.array(weekScheduleDaySchema).default([]),
  active: z.boolean().default(true),
});
export type CreateWeekScheduleInput = z.infer<typeof createWeekScheduleSchema>;

// `days` is replaced wholesale when provided.
export const updateWeekScheduleSchema = z
  .object({
    code: z.string().min(1).max(20).optional(),
    name: z.string().min(1).max(100).optional(),
    days: z.array(weekScheduleDaySchema).optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateWeekScheduleInput = z.infer<typeof updateWeekScheduleSchema>;

// Helgdag — dayScheduleId null/absent = fully off (röd dag), set = reduced
// day (e.g. halvdag).
export const createHolidaySchema = z.object({
  date: z.string().date(),
  name: z.string().min(1).max(100),
  dayScheduleId: z.string().uuid().nullable().optional(),
});
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;

// Seed the company calendar with Swedish holidays for a year; dates that
// already have a holiday are left untouched.
export const generateSwedishHolidaysSchema = z.object({
  year: z.number().int().min(2000).max(2100),
});
export type GenerateSwedishHolidaysInput = z.infer<typeof generateSwedishHolidaysSchema>;

// Upsert semantics: setting an override for a week that already has one
// replaces it.
export const setWeekOverrideSchema = z.object({
  isoYear: z.number().int().min(2000).max(2100),
  isoWeek: z.number().int().min(1).max(53),
  weekScheduleId: z.string().uuid(),
});
export type SetWeekOverrideInput = z.infer<typeof setWeekOverrideSchema>;

// Upsert semantics; dayScheduleId null = ledig (beats holidays and week
// overrides — the most specific statement wins).
export const setDayOverrideSchema = z.object({
  date: z.string().date(),
  dayScheduleId: z.string().uuid().nullable(),
});
export type SetDayOverrideInput = z.infer<typeof setDayOverrideSchema>;

const toMinutes = (clockTime: string) => {
  const [hours = 0, minutes = 0] = clockTime.split(":").map(Number);
  return hours * 60 + minutes;
};

// Net working minutes of a day schedule: start→end minus unpaid breaks
// (raster). Paid breaks (pauser) count as working time. Shared between API
// validation/resolution and the web's display.
export function computeDayScheduleNetMinutes(schedule: {
  startTime: string;
  endTime: string;
  breaks: { type: ScheduleBreakType; startTime: string; endTime: string }[];
}): number {
  const gross = toMinutes(schedule.endTime) - toMinutes(schedule.startTime);
  const unpaid = schedule.breaks
    .filter((b) => b.type === "unpaid")
    .reduce((sum, b) => sum + (toMinutes(b.endTime) - toMinutes(b.startTime)), 0);
  return gross - unpaid;
}

// Närvarostämpling (kom/gå) — clocking out needs no body.
export const attendanceInSchema = z.object({
  employeeId: z.string().uuid(),
  // Regel 8: when the employee went home on the day their still-open
  // attendance started (the terminal asks after a forgotten Gå hem).
  forgottenStoppedAt: z.string().datetime({ offset: true }).optional(),
});
export type AttendanceInInput = z.infer<typeof attendanceInSchema>;

export const createTimeReportSchema = z.object({
  employeeId: z.string().uuid(),
  moOperationId: z.string().uuid(),
  date: z.string().date(),
  hours: z.coerce.number().positive(),
  note: z.string().max(2000).optional(),
});
export type CreateTimeReportInput = z.infer<typeof createTimeReportSchema>;

// Supervisor corrections — a session/report must already exist, so every
// field here is optional and merged onto the existing row. `stoppedAt: null`
// re-opens an attendance session (see timereport.service.ts); `note: null`
// clears a time report's note.
export const updateAttendanceSessionSchema = z
  .object({
    startedAt: z.string().datetime({ offset: true }).optional(),
    stoppedAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "At least one field must be provided");
export type UpdateAttendanceSessionInput = z.infer<typeof updateAttendanceSessionSchema>;

export const updateTimeReportSchema = z
  .object({
    date: z.string().date().optional(),
    hours: z.coerce.number().positive().optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, "At least one field must be provided");
export type UpdateTimeReportInput = z.infer<typeof updateTimeReportSchema>;

// Stämpling — clock in on an MO operation at the stamp terminal.
export const stampInSchema = z.object({
  employeeId: z.string().uuid(),
  moOperationId: z.string().uuid(),
});
export type StampInInput = z.infer<typeof stampInSchema>;

// Every stamp-out reports quantities for the stint: OK units and scrapped
// units (both may be 0, e.g. a pause). Scrap requires a reason and also
// consumes the operation's linked material.
export const stampOutSchema = z
  .object({
    note: z.string().max(2000).optional(),
    quantityOk: z.coerce.number().nonnegative().default(0),
    quantityScrapped: z.coerce.number().nonnegative().default(0),
    scrapReason: z.string().trim().max(500).optional(),
    // Also mark the operation as done (operationen är klar) when clocking out.
    markOperationDone: z.boolean().optional(),
    // Materialbrist: report anyway after a 409 material-shortage in mode
    // "warn" — see materialShortageOverrideSchema in manufacturing.ts.
    allowMaterialShortage: materialShortageOverrideSchema,
    // Supervisor stamp-out on Pågående arbete: when the stint actually
    // ended (regel 6). Admin/supervisor only — the route refuses it for
    // everyone else; the terminal never sends it.
    stoppedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((data) => data.quantityScrapped === 0 || (data.scrapReason ?? "").length > 0, {
    message: "Ange en kassationsorsak när kasserat antal är större än 0",
    path: ["scrapReason"],
  });
export type StampOutInput = z.infer<typeof stampOutSchema>;
