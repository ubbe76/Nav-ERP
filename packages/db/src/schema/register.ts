import { boolean, numeric, pgEnum, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

// Small shared base-data registers (Monitor-style grunddata): terms and
// carriers referenced by both customers and suppliers. Code + name + an
// optional free-text description — no delete in v1, so referencing rows use
// onDelete: "restrict". The description is on every register to keep the
// generic repository/route machinery shape-identical; the web only surfaces
// it where it carries meaning (delivery terms today).

// Leveransvillkor (e.g. DAP / "Delivered at Place")
export const deliveryTerms = pgTable("delivery_terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Betalningsvillkor (e.g. 30 / "30 dagar netto")
export const paymentTerms = pgTable("payment_terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Speditörer (e.g. DHL / "DHL Freight")
export const carriers = pgTable("carriers", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Enheter (e.g. st / "Styck", kg / "Kilogram") — referenced by articles
// (base/purchase/sales unit) and per-article alternative units with
// conversion factors (article_units in article.ts).
export const units = pgTable("units", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Kolliart (frakt): Sendify's PACKAGE / PALLET / UNSPECIFIED. "other" is only
// produced by the kolliförslag (weight without any freight description).
export const parcelKindEnum = pgEnum("parcel_kind", ["package", "pallet", "other"]);

// Kollityper (e.g. EUR / "EUR-pall") — the package type an article ships in,
// referenced by articles.package_type_id. The freight columns describe a FULL
// package for the shipping module's kolliförslag: dimensions in mm (same unit
// as the article), egenvikt in kg, stapelbar, and optional flakmeter (null =
// the carrier derives it from the dimensions).
export const packageTypes = pgTable("package_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  parcelKind: parcelKindEnum("parcel_kind").notNull().default("package"),
  lengthMm: numeric("length_mm", { precision: 10, scale: 2 }),
  widthMm: numeric("width_mm", { precision: 10, scale: 2 }),
  heightMm: numeric("height_mm", { precision: 10, scale: 2 }),
  tareWeight: numeric("tare_weight", { precision: 12, scale: 3 }),
  stackable: boolean("stackable").notNull().default(false),
  loadingMeters: numeric("loading_meters", { precision: 8, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
