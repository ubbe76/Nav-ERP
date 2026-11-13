import { sql } from "drizzle-orm";
import {
  check,
  customType,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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

// Spårning (#8, 0214): antingen eller.
export const articleTrackingEnum = pgEnum("article_tracking", ["none", "batch", "serial"]);

// Serienummer skapas (#8, beslut 16): vid inleverans (förval) or vid
// utleverans — then the stock is untracked and the number is given at the
// delivery. Carried from 0214; used from the serienummer step.
export const articleSerialAssignedAtEnum = pgEnum("article_serial_assigned_at", ["receipt", "delivery"]);

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
    // Påslag per varugrupp (#16, migration 0194): the group's price markups
    // in the förkalkyl, efterkalkyl and the configurator's preview — field by
    // field, null = inherit the company's (System → Kalkyler), 0 = explicitly
    // 0 % (costing/service/markup-levels.ts). The cost markups (MO, LO, Affo)
    // are never set per group. numeric(6,2) like the calculation's snapshot.
    generalMarkupPercent: numeric("general_markup_percent", { precision: 6, scale: 2 }),
    materialMarkupPercent: numeric("material_markup_percent", { precision: 6, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("article_groups_code_digits", sql`${table.code} ~ '^[0-9]{1,4}$'`),
    check("article_groups_vat_rate_check", sql`${table.vatRate} IN (25, 12, 6, 0)`),
    check(
      "article_groups_markups_range",
      sql`(${table.generalMarkupPercent} is null or ${table.generalMarkupPercent} between 0 and 1000) and (${table.materialMarkupPercent} is null or ${table.materialMarkupPercent} between 0 and 1000)`
    ),
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
  // "Extra benämning" — multi-line free text beside the name (Monitor's
  // Artikellista, Extra fält). Printed under the name on the documents the
  // system setting extra_description_documents lists. Null = none.
  extraDescription: text("extra_description"),
  // Benämning (engelska) / Extra benämning (engelska) (Dokument på engelska
  // #7, migration 0175): printed on English documents when filled in, else
  // the Swedish text (localized in @navet/shared). Never on Swedish ones.
  nameEn: varchar("name_en", { length: 255 }),
  extraDescriptionEn: text("extra_description_en"),
  // Streckkod (EAN/GTIN, #4): the manufacturer's code on the package, so a
  // scan finds the article. Digits only, 8/12/13/14 long with a valid check
  // digit (packages/shared/src/gtin.ts); unique when set.
  barcode: varchar("barcode", { length: 14 }),
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
  // Säkerhetslager — the behovsberäkning proposes when the projected balance
  // falls below it and fills up to it (the threshold is the larger of this
  // and the reorder point). Base unit; null = none.
  safetyStock: numeric("safety_stock", { precision: 14, scale: 4 }),
  // Ledtid (dagar) — tillverkningsledtid for a manufactured article in WORKING
  // days, a total throughput time independent of quantity (#13). It wins over
  // the routing's time when set; null = not given, the behovsberäkning and
  // the färdigdatumsförslag then sum the routing's operations instead
  // (planning/service/manufacturing-lead-time.ts). Non-negative by CHECK.
  manufacturingLeadTimeDays: integer("manufacturing_lead_time_days"),
  // Styrning (Monitor's Lagerstyrd/Orderstyrd) — information only; the
  // behovsberäkning reads the reorder point and safety stock, not this flag.
  stockControlled: boolean("stock_controlled").notNull().default(false),
  // Prognosstyrd (#10, migration 0198): the behovsberäkning and the
  // artikelöversikt add a forecast demand per month in the horizon — the
  // average consumption over the history window, or the article's own
  // quantity in article_forecasts — consumed by the month's real demand
  // (planning/service/forecast.ts). Every other article behaves as before.
  forecastControlled: boolean("forecast_controlled").notNull().default(false),
  // Spårning (#8; migration 0213 as the boolean batch_tracked, an enum since
  // 0214): none | batch | serial — "antingen eller". With batch, inflows of
  // the article carry a batch (stock_batches) and outflows are allocated per
  // batch (FEFO, outflow-allocation.ts). Only while the system setting
  // "Använd batch- och serienummer" is on; never a Tjänst or a phantom.
  // Switching it off keeps the batches in the log — they are just no longer
  // asked for or shown (stock.md, Batch). `serial` exists in the type but
  // cannot be chosen until the serienummer step is built.
  tracking: articleTrackingEnum("tracking").notNull().default("none"),
  // Hållbarhet (dagar): a manufactured batch gets utgångsdatum = the day it
  // is received + this (null = no date).
  shelfLifeDays: integer("shelf_life_days"),
  // Serienummer skapas: only meaningful with tracking = serial.
  serialAssignedAt: articleSerialAssignedAtEnum("serial_assigned_at").notNull().default("receipt"),
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
  (table) => [
    check("articles_rounding_positive", sql`${table.rounding} > 0`),
    check("articles_manufacturing_lead_time_days_nonnegative", sql`${table.manufacturingLeadTimeDays} >= 0`),
    uniqueIndex("articles_barcode_unique").on(table.barcode).where(sql`${table.barcode} is not null`),
    // The check digit is the application's (gtin.ts); the database pins the shape.
    check("articles_barcode_format", sql`${table.barcode} ~ '^([0-9]{8}|[0-9]{12,14})$'`),
    check("articles_shelf_life_days_range", sql`${table.shelfLifeDays} IS NULL OR ${table.shelfLifeDays} BETWEEN 1 AND 36500`),
  ]
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
// drawing_revision_id (0200): the file is that drawing revision's (at most
// one per revision); null = a loose file. Only the active revisions' files
// and the loose ones ride along on their own — see
// article/repository/drawing-files.ts.
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
    drawingRevisionId: uuid("drawing_revision_id").references(() => articleDrawingRevisions.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_article_files_article").on(table.articleId),
    uniqueIndex("article_files_one_per_drawing_revision").on(table.drawingRevisionId),
  ]
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

// Append-only history of the article's försäljningspris, the counterpart of
// the standard cost history above. Written by a trigger on articles
// (migration 0169), not by the application — the sales price has some eight
// writers (the card, Sätt försäljningspris, the article and price imports,
// batch edit, copy, demo data, configurator variants). One row per
// transaction that changes the value; null = the price was cleared. History
// starts at the migration (backfill), like D1.
export const articleSalesPriceHistory = pgTable(
  "article_sales_price_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    price: numeric("price", { precision: 14, scale: 4 }),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_sales_price_history_article_from").on(table.articleId, table.validFrom)]
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
    // "Pos." — the row's position on the drawing (Monitor's Materiallista),
    // free text. Null = none.
    position: varchar("position", { length: 20 }),
    // "Kalkyl" (Monitor's "End. kal." — endast kalkyl): the row is priced in
    // the pre-calculation but never reaches a manufacturing order and creates
    // no dependent demand — the material twin of routing_operations.costing_only.
    costingOnly: boolean("costing_only").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // No unique (parent, component) since migration 0176: the same material may
  // sit on several rows of one structure (other Pos., other operation) — the
  // card and the import warn instead. explodeBom sums such rows per
  // (component, operation), so the MO still gets one material line each.
  (table) => [
    check("no_self_reference", sql`${table.parentArticleId} <> ${table.componentArticleId}`),
    index("idx_bom_parent").on(table.parentArticleId),
    index("idx_bom_component").on(table.componentArticleId),
  ]
);

// Prognos (#10, migration 0198): the article's OWN forecast quantity for one
// month — it wins over the average (forecast.ts). A missing row means the
// average applies; null is never stored (PUT /articles/:id/forecast deletes
// the row instead). `month` is always the first of the month (CHECK), the
// quantity never negative.
export const articleForecasts = pgTable(
  "article_forecasts",
  {
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    month: date("month").notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.articleId, table.month] }),
    check("article_forecasts_month_first_of_month", sql`extract(day from ${table.month}) = 1`),
    check("article_forecasts_quantity_nonnegative", sql`${table.quantity} >= 0`),
  ]
);

// Kopierat (#28, migration 0199): the user's own working list of articles —
// filled from the register, the behovsberäkning and an article's structure,
// read back by the register's `copied=true` filter and by Förkalkylera
// flera. Personal, never business data: one row per (user, article), in the
// order the articles were copied (`position`, dense per user; appended after
// the user's max). Capped at COPIED_ARTICLES_MAX (@navet/shared) in the
// article repository, under a per-user advisory lock. Cascades with both the
// user and the article.
export const userCopiedArticles = pgTable(
  "user_copied_articles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.articleId] }),
    index("user_copied_articles_user_position_idx").on(table.userId, table.position),
  ]
);
