import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { carriers } from "./register";
import { users } from "./auth";

// No built-in bytea helper in drizzle-orm/pg-core — a company logo is small
// and rarely changed, so it's stored directly in Postgres rather than
// standing up a file volume/static file server for one image.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Replaces the old per-module `pgSequence` + hardcoded prefix DEFAULT
// (purchase/sales/manufacturing.ts used to bake "IO-"/"KO-"/"PO-" directly
// into the column's DEFAULT SQL). Numbers are now issued from application
// code via number-series.ts's getNextOrderNumber, so admins can reconfigure
// prefix/next number/padding per series.
export const numberSeries = pgTable("number_series", {
  key: varchar("key", { length: 50 }).primaryKey(), // "purchase_order" | "sales_order" | "manufacturing_order"
  prefix: varchar("prefix", { length: 20 }).notNull(),
  nextNumber: integer("next_number").notNull(),
  digits: integer("digits").notNull().default(0), // 0 = no zero-padding
  // Artikelnummerserier (migration 0127): "article" is the default series
  // every new article without a number draws from; further article series
  // are created by the user (name set, key generated) and linked to article
  // groups. Only rows with for_articles can number an article.
  name: varchar("name", { length: 100 }).unique(),
  forArticles: boolean("for_articles").notNull().default(false),
});

// Free-form system-wide settings as key–value rows, so new toggles don't
// need a migration each. Known keys: "allow_multiple_stamps" ("true"/"false",
// absent = false). Typed accessors live in the system service.
export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 50 }).primaryKey(),
  value: text("value").notNull(),
});

// Singleton table — exactly one row, created by the migration. No create
// endpoint; only GET/PATCH.
export const companyInfo = pgTable("company_info", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull().default(""),
  orgNumber: varchar("org_number", { length: 20 }),
  address: varchar("address", { length: 255 }),
  postalCode: varchar("postal_code", { length: 20 }),
  city: varchar("city", { length: 100 }),
  phone: varchar("phone", { length: 50 }),
  email: varchar("email", { length: 255 }),
  website: varchar("website", { length: 255 }),
  // Payment/registration details printed in the footer of outgoing documents
  // (inquiry, purchase order, quote, order confirmation).
  bankgiro: varchar("bankgiro", { length: 20 }),
  plusgiro: varchar("plusgiro", { length: 20 }),
  bankName: varchar("bank_name", { length: 100 }),
  iban: varchar("iban", { length: 40 }),
  bic: varchar("bic", { length: 15 }),
  vatNumber: varchar("vat_number", { length: 30 }),
  // Företagets säte (registered office), e.g. "Stockholm".
  companySeat: varchar("company_seat", { length: 100 }),
  // "Godkänd för F-skatt" printed in the footer when true.
  fSkatt: boolean("f_skatt").notNull().default(false),
  logo: bytea("logo"),
  logoContentType: varchar("logo_content_type", { length: 100 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The company's own customer numbers/accounts at each carrier (e.g. "our DHL
// account 12345"), managed on the Företagsinformation page. Distinct from the
// per-partner carrierCustomerNumber. Singleton company → one row per carrier
// (unique), no companyInfoId needed.
export const companyCarriers = pgTable(
  "company_carriers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    carrierId: uuid("carrier_id")
      .notNull()
      .references(() => carriers.id, { onDelete: "restrict" }),
    customerNumber: varchar("customer_number", { length: 50 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("company_carriers_carrier_unique").on(table.carrierId)]
);

// Append-only audit trail. v1 writers: payroll actions (attest, lock,
// corrections). Other modules join in when block G1 is completed.
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: varchar("entity_type", { length: 50 }).notNull(), // e.g. "payroll_period", "absence", "attendance_session"
    entityId: varchar("entity_id", { length: 100 }),
    action: varchar("action", { length: 50 }).notNull(), // e.g. "locked", "attested", "deleted"
    detail: jsonb("detail"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_log_by_entity").on(table.entityType, table.entityId)]
);

// Valutakurser (migration 0143): SEK per 1 unit of a currency on a day, as
// fetched from Sveriges Riksbank (SWEA, source "riksbank") or entered by hand
// (source "manual", Ekonomi → Valutakurser). Reference data and a cache —
// every document snapshots its own rate, so rows may be changed freely. One
// row per (currency, day, source): a manual rate for a day sits next to
// Riksbanken's and wins in the lookup (system/service/exchange-rates.ts).
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    currency: varchar("currency", { length: 3 }).notNull(),
    date: date("date").notNull(),
    rate: numeric("rate", { precision: 14, scale: 6 }).notNull(),
    source: varchar("source", { length: 10 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("exchange_rates_currency_date_source_unique").on(table.currency, table.date, table.source),
    index("idx_exchange_rates_currency_date").on(table.currency, table.date),
    check("exchange_rates_rate_positive", sql`${table.rate} > 0`),
    check("exchange_rates_source_valid", sql`${table.source} IN ('riksbank', 'manual')`),
    check("exchange_rates_currency_format", sql`${table.currency} ~ '^[A-Z]{3}$' AND ${table.currency} <> 'SEK'`),
  ]
);

// Referensränta (migration 0151): Riksbankens referensränta per calendar
// half-year (räntelagen 9 §, fastställd 1 januari och 1 juli) — the base of
// the dröjsmålsränta (referensränta + 8 procentenheter, 6 §). One row per
// half-year (valid_from UNIQUE, CHECK 1 January or 1 July): fetched from
// Riksbanken (SWEA series SECBREFEFF, source "riksbank") or entered by hand
// (source "manual"). A manual row wins — Hämta från Riksbanken never
// overwrites one (system/service/exchange-rates.ts, the only file that knows
// SWEA). The rate may be zero or negative (it was 0,00 and −0,50 in the
// 2010s), unlike an exchange rate.
export const referenceRates = pgTable(
  "reference_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    validFrom: date("valid_from").notNull().unique(),
    rate: numeric("rate", { precision: 5, scale: 2 }).notNull(),
    source: varchar("source", { length: 10 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("reference_rates_source_valid", sql`${table.source} IN ('riksbank', 'manual')`),
    check(
      "reference_rates_half_year",
      sql`EXTRACT(DAY FROM ${table.validFrom}) = 1 AND EXTRACT(MONTH FROM ${table.validFrom}) IN (1, 7)`
    ),
  ]
);
