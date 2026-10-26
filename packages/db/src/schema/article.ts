import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  boolean,
} from "drizzle-orm/pg-core";
import { articleCodes, packageTypes, parcelKindEnum, units } from "./register";
import { users } from "./auth";
import { numberSeries } from "./system";
// Last on purpose: dimensions.ts reaches sales.ts, which cycles back here —
// everything above must be evaluated before that chain starts.
import { costCenters } from "./dimensions";

// Same pattern as the company logo in system.ts — no built-in bytea helper
// in drizzle-orm/pg-core.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const articleTypeEnum = pgEnum("article_type", [
  "manufactured",
  "purchased",
  "service",
]);

// Varugrupper (Monitor-style; called artikelgrupper in the code and the
// database, renamed in the UI in 0155): user-defined groups that steer the
// article's posting (posting_rules) and VAT rate (vatRate below), plus
// statistics/report breakdown — a small table the article references, not a
// hardcoded field. The free selection/grouping concept is the artikelkod
// (article_codes in register.ts).
export const articleGroups = pgTable(
  "article_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Numeric code, 1–4 digits (3–4 before 0155; Monitor's varugrupper are
    // single digits) — a flat register with no huvudgrupp level.
    code: varchar("code", { length: 4 }).notNull().unique(),
    name: varchar("name", { length: 100 }).notNull().unique(),
    // Free-text note on what the group covers (Beskrivning), max 500 chars.
    description: varchar("description", { length: 500 }),
    // The article number series a new article in this group draws from
    // (null = the default "article" series). Deleting the series falls the
    // group back to the default.
    numberSeriesKey: varchar("number_series_key", { length: 50 }).references(() => numberSeries.key, {
      onDelete: "set null",
    }),
    // Kostnadsställe (förval): what an invoice/supplier invoice row for an
    // article in this group gets when the document header has none.
    defaultCostCenterId: uuid("default_cost_center_id").references(() => costCenters.id, { onDelete: "restrict" }),
    // Momssats: the group's articles take this rate on sales/invoice rows
    // (an article without a group gets 25 %) — the article has no rate of
    // its own since 0155, see articleVatRateSql. Invoice rows snapshot it.
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull().default("25"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("article_groups_code_digits", sql`${table.code} ~ '^[0-9]{1,4}$'`),
    check("article_groups_vat_rate_check", sql`${table.vatRate} IN (25, 12, 6, 0)`),
  ]
);

export const articles = pgTable("articles", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleNumber: varchar("article_number", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  type: articleTypeEnum("type").notNull(),
  // Phantom BOM article (Monitor-style fantomartikel): never stocked, always
  // resolved into its own components at manufacturing/costing time instead
  // of being treated as a material line itself. Locked after creation, like
  // `type`.
  isPhantom: boolean("is_phantom").notNull().default(false),
  // Base unit (grundenhet) — all stored quantities (stock, order rows, BOM)
  // are in this unit. Locked while the article has alternative units in
  // article_units (changing it would silently change factor meanings).
  unitId: uuid("unit_id")
    .notNull()
    .references(() => units.id, { onDelete: "restrict" }),
  // Default units pre-filled on purchase/sales order rows — must be the base
  // unit or one of the article's alternative units (validated in the
  // service). Null = base unit.
  purchaseUnitId: uuid("purchase_unit_id").references(() => units.id, { onDelete: "restrict" }),
  salesUnitId: uuid("sales_unit_id").references(() => units.id, { onDelete: "restrict" }),
  standardCost: numeric("standard_cost", { precision: 14, scale: 4 }),
  // C3: the article's base sales price (SEK, per base unit) — the bottom of
  // the price chain (customer price → price list → this). Null = no base
  // price; never 0 as a stand-in.
  salesPrice: numeric("sales_price", { precision: 14, scale: 4 }),
  // Physical attributes for volume/shipping (used later for transport
  // booking). Nettovikt in kilograms; length/width/height in millimetres.
  weight: numeric("weight", { precision: 12, scale: 3 }),
  length: numeric("length", { precision: 10, scale: 2 }),
  width: numeric("width", { precision: 10, scale: 2 }),
  height: numeric("height", { precision: 10, scale: 2 }),
  // Standard packaging: how many base units fit in one kolli, and the kolli
  // type (e.g. EUR-pall). For volume/transport booking later.
  quantityPerPackage: numeric("quantity_per_package", { precision: 14, scale: 4 }),
  // "Ytbehandling" / "Färg" — free text, printed as an info line under the
  // article name on lego IO/RFQ rows and on quote/order confirmation rows
  // whenever set (never on invoices). Null = not filled in.
  surfaceTreatment: text("surface_treatment"),
  colour: text("colour"),
  // Planning fields (E1 behovsberäkning). Reorder point (beställningspunkt)
  // triggers a proposal when the projected balance falls below it; null = only
  // propose on negative projected balance. Order quantity (orderkvantitet)
  // rounds proposals up to the nearest multiple; also acts as a minimum.
  // Rounding (avrundning) is a second, independent step applied LAST — to
  // the proposal AND to the quantity typed on every order row (IO/RFQ/KO/TO),
  // always in the base unit: 1 = whole units, 5 = multiples of five, 7.38 =
  // whole 7.38 kg bars. Null = no rounding. See roundUpToMultiple in
  // packages/shared/src/units.ts. Positive by CHECK below.
  reorderPoint: numeric("reorder_point", { precision: 14, scale: 4 }),
  orderQuantity: numeric("order_quantity", { precision: 14, scale: 4 }),
  rounding: numeric("rounding", { precision: 14, scale: 3 }),
  packageTypeId: uuid("package_type_id").references(() => packageTypes.id, { onDelete: "restrict" }),
  // Frakt — "egna mått" (used when the article has no package type + antal
  // per kolli): kolliart (null = Paket), stapelbar, pallplatser and flakmeter.
  // The article service derives loading_meters = pallet_spaces × 0.4 when only
  // pallplatser is given (deriveLoadingMeters in @navet/shared).
  parcelKind: parcelKindEnum("parcel_kind"),
  stackable: boolean("stackable").notNull().default(false),
  palletSpaces: numeric("pallet_spaces", { precision: 8, scale: 2 }),
  loadingMeters: numeric("loading_meters", { precision: 8, scale: 2 }),
  groupId: uuid("group_id").references(() => articleGroups.id, { onDelete: "set null" }),
  // Artikelkod (Grunddata): selection/grouping in the lists only. restrict —
  // the register's delete moves the articles to a replacement first.
  articleCodeId: uuid("article_code_id").references(() => articleCodes.id, { onDelete: "restrict" }),
  // The article's default stock location — transactions without an explicit
  // location resolve here, and null falls through to the auto-created "***"
  // location (see stock's location-resolver.ts). FK declared in stock.ts to
  // avoid a circular import between the schema modules.
  defaultLocationId: uuid("default_location_id"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("articles_rounding_positive", sql`${table.rounding} > 0`)]
);

// Alternative units (alternativa enheter) with conversion factors. The
// factor direction is "1 base unit = quantity_per_base of this unit" — an
// article stocked in st weighing 5 kg apiece stores factor 5 on its kg row
// (so base qty = entered qty / factor). Quantities in the rest of the system
// stay in the base unit; rows that were entered in an alternative unit
// snapshot the factor for display (unit_id + unit_factor columns).
export const articleUnits = pgTable(
  "article_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    quantityPerBase: numeric("quantity_per_base", { precision: 16, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("quantity_per_base_positive", sql`${table.quantityPerBase} > 0`),
    unique().on(table.articleId, table.unitId),
    index("idx_article_units_article").on(table.articleId),
  ]
);

// Attached files (ritningar — drawings): PDF/JPEG/PNG stored directly in
// Postgres like the company logo (self-hosted, backup follows the database).
// Used by the article card's Filer tab, appended to the TO printout and
// optionally attached to outgoing order emails.
export const articleFiles = pgTable(
  "article_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    filename: varchar("filename", { length: 255 }).notNull(),
    contentType: varchar("content_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_article_files_article").on(table.articleId)]
);

// Artikelrevisioner — a manual revision register on the article (rev A, B,
// ...), at most one active (partial unique index). Pure metadata, no link to
// article_files. The active revision is optionally printed on external
// documents (see system setting "show_revisions_on_documents").
export const articleRevisions = pgTable(
  "article_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    revision: varchar("revision", { length: 20 }).notNull(),
    comment: text("comment"),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("article_revisions_article_revision_unique").on(table.articleId, table.revision),
    uniqueIndex("article_revisions_one_active").on(table.articleId).where(sql`${table.isActive}`),
  ]
);

// Ritningsnummer — optional drawing numbers on the article, each with its own
// revision register (same shape as article_revisions).
export const articleDrawings = pgTable(
  "article_drawings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    drawingNumber: varchar("drawing_number", { length: 50 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("article_drawings_article_number_unique").on(table.articleId, table.drawingNumber)]
);

export const articleDrawingRevisions = pgTable(
  "article_drawing_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => articleDrawings.id, { onDelete: "cascade" }),
    revision: varchar("revision", { length: 20 }).notNull(),
    comment: text("comment"),
    isActive: boolean("is_active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("article_drawing_revisions_drawing_revision_unique").on(table.drawingId, table.revision),
    uniqueIndex("article_drawing_revisions_one_active").on(table.drawingId).where(sql`${table.isActive}`),
  ]
);

// Append-only history of the article's standard cost (D1). articles.standard_cost
// itself stays the mutable "current value" every existing reader uses; this
// table makes "standardpris per datum" a lookup instead of a guess — the
// valuation report reads the latest row with valid_from <= X. Rows are written
// by the three standard-cost writers (article create, PATCH standard-cost,
// CSV import) in the same transaction as the change, and only when the value
// actually changes. The D1 migration backfills one row per article that has a
// standard cost, so history honestly starts at the migration — earlier values
// are unknown and never invented.
export const articleStandardCostHistory = pgTable(
  "article_standard_cost_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    cost: numeric("cost", { precision: 14, scale: 4 }).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [index("idx_std_cost_history_article_from").on(table.articleId, table.validFrom)]
);

// BOM = Bill of Materials / struktur — self-referencing: en artikel kan bestå av komponent-artiklar
export const bomComponents = pgTable(
  "bom_components",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentArticleId: uuid("parent_article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    componentArticleId: uuid("component_article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull().default("1"),
    // Display unit the row was entered in (null = the component's base unit).
    // quantity above is always in the base unit; unit_factor is the snapshotted
    // quantity_per_base at entry time, so later factor edits don't shift
    // existing rows.
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "restrict" }),
    unitFactor: numeric("unit_factor", { precision: 16, scale: 6 }),
    // Optional link to the routing operation that consumes this component —
    // the material is then drawn automatically when that operation is
    // reported complete. FK declared in manufacturing.ts to avoid a circular
    // import between the two schema modules.
    routingOperationId: uuid("routing_operation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("no_self_reference", sql`${table.parentArticleId} <> ${table.componentArticleId}`),
    unique().on(table.parentArticleId, table.componentArticleId),
    index("idx_bom_parent").on(table.parentArticleId),
    index("idx_bom_component").on(table.componentArticleId),
  ]
);
