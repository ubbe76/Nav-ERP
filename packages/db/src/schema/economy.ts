import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { articleGroups } from "./article";
import { users } from "./auth";

// Same pattern as article.ts/system.ts — no built-in bytea helper.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Economy module (B1 grundbokföring): chart of accounts, fiscal years with
// monthly period locking, manual verifications (utkast → bokförd) and the
// derived general ledger. Booked verifications are append-only — balances
// are ALWAYS derived, never stored (same philosophy as stock_transactions).

export const accountingPeriodStatusEnum = pgEnum("accounting_period_status", ["open", "locked"]);
export const verificationStatusEnum = pgEnum("verification_status", ["draft", "booked"]);

// Kontoplan. NOT the generic register family: BAS legitimately repeats
// names across accounts, so only the 4-digit number is unique.
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: varchar("number", { length: 4 }).notNull().unique(),
    name: varchar("name", { length: 100 }).notNull(),
    active: boolean("active").notNull().default(true),
    // Momsruta (ekonomi etapp 2). Values mirror @navet/shared's VAT_BOXES +
    // "none" — the db package does not depend on shared, so the list is
    // repeated in the CHECK. NULL = not classified (passes the CHECK).
    vatBox: varchar("vat_box", { length: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("account_number_four_digits", sql`${table.number} ~ '^[0-9]{4}$'`),
    check("account_vat_box_valid", sql`${table.vatBox} IN ('05', '10', '11', '12', '35', '36', '42', '48', 'none')`),
  ]
);

export const fiscalYearStatusEnum = pgEnum("fiscal_year_status", ["open", "closed"]);

// Räkenskapsår — arbitrary start/end (brutet år supported); overlap is
// validated in the service, not the schema. status is the authority for
// "the year is closed" (årsbokslut): the closed-year triggers of migration
// 0105 and assertPostablePeriod read it.
export const fiscalYears = pgTable(
  "fiscal_years",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: varchar("label", { length: 20 }).notNull().unique(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: fiscalYearStatusEnum("status").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("fiscal_year_closed_consistent", sql`(${table.status} = 'closed') = (${table.closedAt} IS NOT NULL)`)]
);

// Monthly periods generated when the fiscal year is created (first/last
// month clipped to the year's bounds). No JSONB snapshot: verifications are
// immutable, so the ledger is always reproducible — locking only needs the
// status columns (deliberate difference from payroll_periods).
export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "cascade" }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: accountingPeriodStatusEnum("status").notNull().default("open"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [uniqueIndex("accounting_periods_year_start_unique").on(table.fiscalYearId, table.startDate)]
);

// Verifikatserier (A = manuella; B2 adds more). Small register, code+name.
export const verificationSeries = pgTable("verification_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 10 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-(series, fiscal year) counters — verifikatnummer reset yearly
// (A-2026-1, A-2026-2, …). NOT number_series: that model has no year
// dimension and its admin UI assumes a closed key set. Rows materialize
// lazily at first booking; the allocator is Tx-only so a failed booking
// never burns a number (BFL: obruten serie).
export const verificationCounters = pgTable(
  "verification_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => verificationSeries.id, { onDelete: "restrict" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "restrict" }),
    nextNumber: integer("next_number").notNull().default(1),
  },
  (table) => [uniqueIndex("verification_counters_series_year_unique").on(table.seriesId, table.fiscalYearId)]
);

// Verifikat. Draft → booked mirrors the invoice's draft → issued: drafts are
// freely editable and burn no number; booking allocates the number inside
// the same transaction as the conditional status flip. Booked verifications
// are append-only — corrections go through a linked reversal (Omför).
export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => verificationSeries.id, { onDelete: "restrict" }),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "restrict" }),
    verificationNumber: integer("verification_number"),
    date: date("date").notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    status: verificationStatusEnum("status").notNull().default("draft"),
    // Reversal link (omföring) — at most one reversal per verification.
    reversesVerificationId: uuid("reverses_verification_id").references((): AnyPgColumn => verifications.id, {
      onDelete: "restrict",
    }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    bookedBy: uuid("booked_by").references(() => users.id, { onDelete: "set null" }),
    bookedAt: timestamp("booked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("verifications_series_year_number_unique")
      .on(table.seriesId, table.fiscalYearId, table.verificationNumber)
      .where(sql`${table.verificationNumber} IS NOT NULL`),
    uniqueIndex("verifications_reverses_unique")
      .on(table.reversesVerificationId)
      .where(sql`${table.reversesVerificationId} IS NOT NULL`),
    index("idx_verifications_year_status").on(table.fiscalYearId, table.status),
    index("idx_verifications_date").on(table.date),
  ]
);

// Rows: debit/credit as two always-positive columns with an XOR check —
// the sign convention lives in the column choice, never in a type flag.
export const verificationRows = pgTable(
  "verification_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    verificationId: uuid("verification_id")
      .notNull()
      .references(() => verifications.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    debit: numeric("debit", { precision: 14, scale: 2 }).notNull().default("0"),
    credit: numeric("credit", { precision: 14, scale: 2 }).notNull().default("0"),
    description: varchar("description", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_verification_rows_verification").on(table.verificationId),
    index("idx_verification_rows_account").on(table.accountId),
    check("verification_row_amounts_nonnegative", sql`${table.debit} >= 0 AND ${table.credit} >= 0`),
    check("verification_row_debit_xor_credit", sql`(${table.debit} = 0) <> (${table.credit} = 0)`),
  ]
);

// Konteringsregler (B2 automatkontering): which revenue/cost account an
// article group posts to, optionally split per VAT rate. vatRate = null
// means "all rates" (the catch-all rule for the group); a rate-specific rule
// takes precedence over it — the resolution order lives in the poster
// service, not here. At least one of revenueAccountId/costAccountId must be
// set (validated in zod/service) since a rule can be revenue-only or
// cost-only. onDelete cascade: article groups have no delete endpoint today,
// so this only fires from direct DB maintenance.
export const postingRules = pgTable(
  "posting_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleGroupId: uuid("article_group_id")
      .notNull()
      .references(() => articleGroups.id, { onDelete: "cascade" }),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    revenueAccountId: uuid("revenue_account_id").references(() => accounts.id, { onDelete: "restrict" }),
    costAccountId: uuid("cost_account_id").references(() => accounts.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Two partial indexes rather than one plain unique(articleGroupId, vatRate):
    // Postgres treats NULL as distinct in a unique index, so a plain index
    // would let a group collect unlimited null-rate ("all rates") rows. Each
    // index therefore owns one half of the space — rate-specific rows here.
    uniqueIndex("posting_rules_group_rate_unique")
      .on(table.articleGroupId, table.vatRate)
      .where(sql`${table.vatRate} IS NOT NULL`),
    // ...and the catch-all row per group here, capped at one via a
    // single-column partial index.
    uniqueIndex("posting_rules_group_norate_unique")
      .on(table.articleGroupId)
      .where(sql`${table.vatRate} IS NULL`),
  ]
);

// Momsrapport (B5): the declared-VAT-period fact — one row per booked
// momsomföring (settlement verification, series M). Append-only like
// invoice_reminders: no status column and no box snapshot, everything is
// derived. A settlement is ACTIVE iff no BOOKED verification reverses its
// verification (the verification card's Omför button is the undo path — the
// row itself is never deleted). The report's movement query excludes
// settlement verifications AND their reversals by identity, so declaration
// mechanics never leak into the boxes, and the settle path refuses ranges
// overlapping an active settlement.
export const vatSettlements = pgTable(
  "vat_settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fromDate: date("from_date").notNull(),
    toDate: date("to_date").notNull(),
    verificationId: uuid("verification_id")
      .notNull()
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_vat_settlements_range").on(table.fromDate, table.toDate),
    check("vat_settlement_range_valid", sql`${table.toDate} >= ${table.fromDate}`),
  ]
);

// Underlag on a verification — kvitto, kontoutdrag, avtal: the verifikation's
// supporting document (bokföringslagen 5 kap 6–7 §), kept 7 år (7 kap).
// Removable only while the verification is a draft; once booked it can be
// added to, never removed — enforced in the economy service under the
// verification's row lock. ON DELETE restrict, listing never selects data.
export const verificationFiles = pgTable(
  "verification_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    verificationId: uuid("verification_id")
      .notNull()
      .references(() => verifications.id, { onDelete: "restrict" }),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    data: bytea("data").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_verification_files_verification").on(table.verificationId)]
);
