import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { verificationSeries, verifications } from "./economy";

// Snabbare manuell bokföring (bokföringsgranskningen etapp 3, migration
// 0147): verifikatmallar, återkommande verifikat (incl. fördelning över
// perioder) and the dubblettspärr for the SIE verification import. Nothing
// here changes how a verification is stored — a template run and an import
// both produce ordinary verifications through the ordinary create/book path.

// A template's rows carry account NUMBERS, not FKs (same model as the
// posting_* settings and the momskoder): a template outlives chart edits and
// an empty chart never blocks saving one. The number is resolved to an
// active account when a verification is actually created from the template.
export const verificationTemplates = pgTable("verification_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  seriesId: uuid("series_id")
    .notNull()
    .references(() => verificationSeries.id, { onDelete: "restrict" }),
  description: varchar("description", { length: 255 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Amounts are optional — a template may leave them blank to be filled in on
// the verification (a recurring post requires them, validated in the service).
// Never both sides on one row, same XOR idea as verification_rows but
// allowing "neither".
export const verificationTemplateRows = pgTable(
  "verification_template_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => verificationTemplates.id, { onDelete: "cascade" }),
    accountNumber: varchar("account_number", { length: 4 }).notNull(),
    description: varchar("description", { length: 255 }),
    debit: numeric("debit", { precision: 14, scale: 2 }),
    credit: numeric("credit", { precision: 14, scale: 2 }),
    sortOrder: integer("sort_order").notNull(),
  },
  (table) => [
    index("idx_verification_template_rows_template").on(table.templateId),
    check("verification_template_row_account_number", sql`${table.accountNumber} ~ '^[0-9]{4}$'`),
    check(
      "verification_template_row_amounts",
      sql`(${table.debit} IS NULL OR ${table.debit} > 0) AND (${table.credit} IS NULL OR ${table.credit} > 0) AND NOT (${table.debit} IS NOT NULL AND ${table.credit} IS NOT NULL)`
    ),
  ]
);

export const recurringVerificationModeEnum = pgEnum("recurring_verification_mode", ["draft", "book"]);

// The amounts a fördelning books per month — index 0 = start_month. Pure
// output of allocationAmounts(); stored so every month books exactly its
// share even if the rounding rule ever changes.
export type RecurringScheduleAmounts = number[];

// What the fördelning was made from, for the card; the template rows carry
// the accounts and the schedule the amounts.
export type RecurringAllocation = {
  amount: number;
  kind: "cost" | "revenue";
  balanceAccount: string;
  resultAccount: string;
  months: number;
};

// Months are stored as "YYYY-MM" text: they compare lexicographically, the
// API speaks the same shape and nothing ever needs day arithmetic on them
// (the run date is derived from day_of_month at run time). day_of_month null
// = the month's last day ("last").
export const recurringVerifications = pgTable(
  "recurring_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => verificationTemplates.id, { onDelete: "restrict" }),
    dayOfMonth: smallint("day_of_month"),
    startMonth: varchar("start_month", { length: 7 }).notNull(),
    endMonth: varchar("end_month", { length: 7 }),
    mode: recurringVerificationModeEnum("mode").notNull().default("draft"),
    active: boolean("active").notNull().default(true),
    scheduleAmounts: jsonb("schedule_amounts").$type<RecurringScheduleAmounts>(),
    allocation: jsonb("allocation").$type<RecurringAllocation>(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_recurring_verifications_template").on(table.templateId),
    check("recurring_verification_day", sql`${table.dayOfMonth} IS NULL OR (${table.dayOfMonth} BETWEEN 1 AND 28)`),
    check("recurring_verification_start_month", sql`${table.startMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "recurring_verification_end_month",
      sql`${table.endMonth} IS NULL OR (${table.endMonth} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND ${table.endMonth} >= ${table.startMonth})`
    ),
    // A fördelning has both, a plain recurring post neither.
    check("recurring_verification_allocation_pair", sql`(${table.scheduleAmounts} IS NULL) = (${table.allocation} IS NULL)`),
    check("recurring_verification_allocation_ends", sql`${table.scheduleAmounts} IS NULL OR ${table.endMonth} IS NOT NULL`),
  ]
);

export const recurringRunStatusEnum = pgEnum("recurring_run_status", ["created", "failed"]);

// One row per (post, month) — the unique index IS the reservation: the row is
// inserted in the same transaction as the verification it creates (ON
// CONFLICT DO NOTHING, so a second process or tick gets nothing), and a
// failure writes a `failed` row afterwards that blocks automatic retries
// until Kör nu replaces it. recurring_id is nullable with ON DELETE SET NULL:
// deleting the post keeps the rows that point at a verification (the
// verification's only link to its origin), the service removes the failed
// ones first.
export const recurringVerificationRuns = pgTable(
  "recurring_verification_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recurringId: uuid("recurring_id").references(() => recurringVerifications.id, { onDelete: "set null" }),
    month: varchar("month", { length: 7 }).notNull(),
    status: recurringRunStatusEnum("status").notNull(),
    error: varchar("error", { length: 500 }),
    verificationId: uuid("verification_id").references(() => verifications.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("recurring_verification_runs_recurring_month_unique").on(table.recurringId, table.month),
    index("idx_recurring_verification_runs_verification").on(table.verificationId),
    check("recurring_run_month", sql`${table.month} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      "recurring_run_outcome",
      sql`(${table.status} = 'created' AND ${table.verificationId} IS NOT NULL AND ${table.error} IS NULL) OR (${table.status} = 'failed' AND ${table.verificationId} IS NULL AND ${table.error} IS NOT NULL)`
    ),
  ]
);

// Dubblettspärr for the SIE verification import: the same file (sha256)
// twice would duplicate every verification. Inserted first in the import's
// own transaction, so two concurrent imports of one file serialize on the
// unique index.
export const sieVerificationImports = pgTable("sie_verification_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  sha256: varchar("sha256", { length: 64 }).notNull().unique(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  verificationCount: integer("verification_count").notNull(),
  importedBy: uuid("imported_by").references(() => users.id, { onDelete: "set null" }),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});
