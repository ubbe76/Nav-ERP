import { sql } from "drizzle-orm";
import {
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
  varchar,
  boolean,
} from "drizzle-orm/pg-core";
import { moOperations, workCenters } from "./manufacturing";
import { users } from "./auth";

// Anställningsform — determines how `employees.wage` is read (hourly rate vs
// monthly salary) when payroll bases (löneunderlag) are generated later.
export const employmentTypeEnum = pgEnum("employment_type", ["hourly", "monthly"]);

// How the employee's overtime is compensated by default: paid out (övertids-
// ersättning) or banked as comp time (komptid). Per-day overrides live in
// payroll's overtime_dispositions table.
export const overtimeCompensationEnum = pgEnum("overtime_compensation", ["payout", "comp"]);

// ATF (arbetstidsförkortning) — collective-agreement working time reduction.
// bank = accrual builds a saldo (tidbank); weekly = veckouttag, everything
// earned is taken out continuously (shorter scheduled weeks), so accrual
// never reaches the balance.
export const atfModeEnum = pgEnum("atf_mode", ["bank", "weekly"]);

// withdrawal = uttag (stored as positive minutes, subtracted from the
// balance); adjustment = signed correction, e.g. ingående saldo.
export const atfTransactionTypeEnum = pgEnum("atf_transaction_type", ["withdrawal", "adjustment"]);

// Avbrott på ett dagsschema: rast (unpaid — deducted from working time, e.g.
// lunch) or paus (paid — counts as working time, e.g. fika). The distinction
// matters when payroll bases (löneunderlag) are generated later.
export const scheduleBreakTypeEnum = pgEnum("schedule_break_type", ["unpaid", "paid"]);

// Dagsschema — a named working day shape: start/end plus breaks. Net working
// time = start→end minus unpaid breaks. v1 requires start < end (no
// over-midnight night shifts).
export const daySchedules = pgTable("day_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dayScheduleBreaks = pgTable("day_schedule_breaks", {
  id: uuid("id").primaryKey().defaultRandom(),
  dayScheduleId: uuid("day_schedule_id")
    .notNull()
    .references(() => daySchedules.id, { onDelete: "cascade" }),
  type: scheduleBreakTypeEnum("type").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
});

// Veckoschema — picks a day schedule per weekday. A weekday without a row is
// a day off (ledig).
export const weekSchedules = pgTable("week_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const weekScheduleDays = pgTable(
  "week_schedule_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weekScheduleId: uuid("week_schedule_id")
      .notNull()
      .references(() => weekSchedules.id, { onDelete: "cascade" }),
    // ISO weekday: 1 = Monday … 7 = Sunday.
    weekday: smallint("weekday").notNull(),
    dayScheduleId: uuid("day_schedule_id")
      .notNull()
      .references(() => daySchedules.id, { onDelete: "restrict" }),
  },
  (table) => [unique("week_schedule_days_weekday_unique").on(table.weekScheduleId, table.weekday)]
);

// Helgdagar — company-wide calendar. Overrides week schedules for everyone:
// day_schedule_id null = fully off (röd dag), set = reduced day (halvdag).
// An employee's own day override still wins over a holiday.
export const holidays = pgTable("holidays", {
  id: uuid("id").primaryKey().defaultRandom(),
  date: date("date").notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  dayScheduleId: uuid("day_schedule_id").references(() => daySchedules.id, { onDelete: "restrict" }),
});

// Separate from `users` (system login accounts) — shop-floor employees who
// report time don't necessarily have their own system accounts.
// Contact/employment/wage fields are all nullable: the register grows into
// payroll use without forcing data on existing rows.
export const employees = pgTable("employees", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeNumber: varchar("employee_number", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  active: boolean("active").notNull().default(true),
  // Kontaktuppgifter
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  address: varchar("address", { length: 255 }),
  postalCode: varchar("postal_code", { length: 20 }),
  city: varchar("city", { length: 100 }),
  // Anställningsdata
  personalIdentityNumber: varchar("personal_identity_number", { length: 13 }), // personnummer
  employedFrom: date("employed_from"),
  employedTo: date("employed_to"),
  // Löneuppgifter — wage is timlön or månadslön depending on employmentType.
  employmentType: employmentTypeEnum("employment_type"),
  wage: numeric("wage", { precision: 10, scale: 2 }),
  weeklyHours: numeric("weekly_hours", { precision: 5, scale: 2 }),
  // Default övertidsersättning vs komptid — per-day overrides live in
  // payroll's overtime_dispositions table.
  overtimeCompensation: overtimeCompensationEnum("overtime_compensation").notNull().default("payout"),
  // Standardveckoschema — the schedule that applies to every week unless the
  // employee's calendar overrides it (employee_week_overrides / _day_overrides).
  defaultWeekScheduleId: uuid("default_week_schedule_id").references(() => weekSchedules.id, {
    onDelete: "restrict",
  }),
  // ATF: accrual is computed (completed weeks since atfStartDate × rate), not
  // materialized. atfMinutesPerWeek null = follow the atf_minutes_per_week
  // system setting; atfStartDate null = no accrual for this employee.
  atfMode: atfModeEnum("atf_mode").notNull().default("bank"),
  atfMinutesPerWeek: integer("atf_minutes_per_week"),
  atfStartDate: date("atf_start_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Förvalda stationer: the work centers an employee usually works at — the
// stamp terminal preselects them when the employee identifies. Everyone may
// still pick any station; this only sets the starting filter.
export const employeeWorkCenters = pgTable(
  "employee_work_centers",
  {
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    workCenterId: uuid("work_center_id")
      .notNull()
      .references(() => workCenters.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.employeeId, table.workCenterId] })]
);

// ATF-transaktioner: withdrawals and manual adjustments, append-only-style
// (accrual is derived, so no periodic accrual rows are ever written). Balance
// = computed accrual + adjustments − withdrawals.
export const atfTransactions = pgTable(
  "atf_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    type: atfTransactionTypeEnum("type").notNull(),
    // withdrawal: positive minutes taken out; adjustment: signed minutes.
    minutes: integer("minutes").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("atf_transactions_by_employee").on(table.employeeId)]
);

// Kalenderavvikelse per vecka: this ISO week follows another week schedule
// instead of the employee's standard one.
export const employeeWeekOverrides = pgTable(
  "employee_week_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    isoYear: smallint("iso_year").notNull(),
    isoWeek: smallint("iso_week").notNull(),
    weekScheduleId: uuid("week_schedule_id")
      .notNull()
      .references(() => weekSchedules.id, { onDelete: "restrict" }),
  },
  (table) => [unique("employee_week_overrides_week_unique").on(table.employeeId, table.isoYear, table.isoWeek)]
);

// Kalenderavvikelse per dag: this date follows another day schedule, or is
// off entirely (day_schedule_id null = ledig). Beats week overrides AND the
// company holiday calendar — it is the most specific statement available.
export const employeeDayOverrides = pgTable(
  "employee_day_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    dayScheduleId: uuid("day_schedule_id").references(() => daySchedules.id, { onDelete: "restrict" }),
  },
  (table) => [unique("employee_day_overrides_date_unique").on(table.employeeId, table.date)]
);

// Närvarostämpling (kom/gå) — the raw material for löneunderlag. Independent
// of work stamps, except that stopping attendance also stops the employee's
// open stamp_sessions (service-layer rule).
export const attendanceSessions = pgTable(
  "attendance_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    index("attendance_sessions_open_by_employee").on(table.employeeId).where(sql`${table.stoppedAt} is null`),
    index("attendance_sessions_by_employee_started").on(table.employeeId, table.startedAt),
  ]
);

export const timeReports = pgTable("time_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  employeeId: uuid("employee_id")
    .notNull()
    .references(() => employees.id, { onDelete: "restrict" }),
  moOperationId: uuid("mo_operation_id")
    .notNull()
    .references(() => moOperations.id, { onDelete: "restrict" }),
  date: date("date").notNull(),
  hours: numeric("hours", { precision: 10, scale: 2 }).notNull(),
  note: text("note"),
  // Who entered this report in the system — distinct from employeeId (who did the work).
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Stämpling: a shop-floor clock-in on an MO operation, made at the stamp
// terminal. Stopping the session computes hours and materializes a
// time_reports row — time_report_id links the two, and doubles as the
// "this report came from the terminal" marker (null = manually entered).
// "One open stamp per employee" is enforced in the service layer, not here:
// the rule is a runtime system setting (allow_multiple_stamps).
export const stampSessions = pgTable(
  "stamp_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "restrict" }),
    moOperationId: uuid("mo_operation_id")
      .notNull()
      .references(() => moOperations.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    // Going home pauses open work instead of force-stopping it: pausedAt is
    // set at attendance-out and cleared (accumulating into pausedSeconds) at
    // the next attendance-in. Paused time is excluded from reported hours.
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedSeconds: numeric("paused_seconds", { precision: 12, scale: 2 }).notNull().default("0"),
    timeReportId: uuid("time_report_id").references(() => timeReports.id, { onDelete: "set null" }),
    // The terminal's logged-in session user — not who did the work.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [index("stamp_sessions_open_by_employee").on(table.employeeId).where(sql`${table.stoppedAt} is null`)]
);
