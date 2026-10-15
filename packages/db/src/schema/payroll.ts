import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { employees, overtimeCompensationEnum } from "./timereport";
import { users } from "./auth";

// Which kind of day an OB window applies to. A date present in `holidays`
// is always `holiday`, otherwise Sat/Sun/weekday by the calendar.
export const obDayKindEnum = pgEnum("ob_day_kind", ["weekday", "saturday", "sunday", "holiday"]);

// Löneperiod (calendar month). Locking freezes the payroll basis: a JSONB
// snapshot of the full per-day computation is stored and all writes that
// feed the basis are rejected for dates inside the period.
export const payrollPeriodStatusEnum = pgEnum("payroll_period_status", ["open", "locked"]);

// Frånvarokoder (sjuk, semester, VAB, ...). paxml_code is the tidkod
// written to the PAXml export for this absence type.
export const absenceTypes = pgTable("absence_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  paxmlCode: varchar("paxml_code", { length: 20 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Registered absence: employee + date + type + extent in minutes.
// Heldag = the day schedule's net minutes (UI prefills). Several types on
// the same day are allowed (e.g. half sick + half VAB), same type twice is not.
export const absences = pgTable(
  "absences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    absenceTypeId: uuid("absence_type_id")
      .notNull()
      .references(() => absenceTypes.id, { onDelete: "restrict" }),
    date: date("date").notNull(),
    minutes: integer("minutes").notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("absences_employee_date_type_unique").on(table.employeeId, table.date, table.absenceTypeId),
    index("absences_by_employee_date").on(table.employeeId, table.date),
  ]
);

// OB-tillägg windows. Windows must not cross midnight (same v1 rule as
// day_schedules) — night OB is entered as two rows (22–24 and 00–06).
export const obRules = pgTable("ob_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  dayKind: obDayKindEnum("day_kind").notNull(),
  startTime: time("start_time").notNull(),
  endTime: time("end_time").notNull(),
  paxmlCode: varchar("paxml_code", { length: 20 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const payrollPeriods = pgTable(
  "payroll_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    year: smallint("year").notNull(),
    month: smallint("month").notNull(), // 1-12
    status: payrollPeriodStatusEnum("status").notNull().default("open"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => users.id, { onDelete: "set null" }),
    // Full PeriodSummary (incl. per-day detail) captured at lock; null while open.
    summary: jsonb("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("payroll_periods_year_month_unique").on(table.year, table.month)]
);

// Per-day override of the employee's overtime_compensation default. Only
// deviations are stored: no row = follow the personalkort default. An
// explicit choice is always stored, even when it equals the current default,
// so a later default change never silently flips a day an attestor already
// decided on.
export const overtimeDispositions = pgTable(
  "overtime_dispositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    disposition: overtimeCompensationEnum("disposition").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("overtime_dispositions_employee_date_unique").on(table.employeeId, table.date),
  ]
);

export const payrollAttestations = pgTable(
  "payroll_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    periodId: uuid("period_id")
      .notNull()
      .references(() => payrollPeriods.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    attestedBy: uuid("attested_by").references(() => users.id, { onDelete: "set null" }),
    attestedAt: timestamp("attested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("payroll_attestations_period_employee_unique").on(table.periodId, table.employeeId)]
);
