import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";
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
