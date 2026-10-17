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
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Same pattern as article_files/system.ts — no built-in bytea helper.
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
import { articles } from "./article";
import { users } from "./auth";
// Safe import direction: purchase.ts does not import from this file (the
// purchase_order_rows → mo_operations FK is declared by hand in its
// migration, same precedent as workCenters.weekScheduleId below).
import { purchaseOrders, suppliers } from "./purchase";
import { units } from "./register";
import { salesOrderRows } from "./sales";
import { stockLocations } from "./stock";

export const manufacturingOrderStatusEnum = pgEnum("manufacturing_order_status", [
  "planned",
  "released",
  "in_progress",
  "done",
  "closed",
  "cancelled",
]);

export const moOperationStatusEnum = pgEnum("mo_operation_status", ["pending", "done"]);

// A resource is a machine, a person (classification only in v1 — no link to
// the employee register) or a subcontractor (legoresurs): an external
// supplier performing an operation. Subcontract resources have no schedule/
// hourly rate — their operations are priced (setup + unit price) and bought
// via purchase orders instead of stamped in the terminal.
export const workCenterTypeEnum = pgEnum("work_center_type", ["machine", "personnel", "subcontract"]);

// Display preference only — runTimePerUnit is always stored/returned in
// minutes per unit (canonical). "units_per_hour" (st/h) is a pure
// presentation toggle converted at the edges (OperationModal, BeredningView,
// ManufacturingOrderDetail, the TO PDF) via packages/shared/src/units.ts's
// conversion helpers — costing, capacity planning, import and the external
// configurator API all keep reading/writing minutes untouched.
export const operationTimeUnitEnum = pgEnum("operation_time_unit", ["minutes_per_unit", "units_per_hour"]);

// Produktionsgrupper — group resources (work centers) for planning. A resource
// belongs to at most one group via work_centers.production_group_id.
export const productionGroups = pgTable("production_groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Work center = resurs (Monitor-term in the UI).
export const workCenters = pgTable(
  "work_centers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Resource number: exactly 3 digits, freely chosen — the digits carry no
    // grouping meaning; grouping happens via productionGroupId.
    code: varchar("code", { length: 3 }).notNull().unique(),
    name: varchar("name", { length: 100 }).notNull(),
    type: workCenterTypeEnum("type").notNull().default("machine"),
    productionGroupId: uuid("production_group_id").references(() => productionGroups.id, { onDelete: "set null" }),
    hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }).notNull().default("0"),
    overheadPercent: numeric("overhead_percent", { precision: 5, scale: 2 }).notNull().default("0"),
    // E2 beläggning: available time per week = this week schedule's resolved
    // net hours (holidays included) × capacityFactor. FK to week_schedules is
    // declared by hand in the migration — timereport.ts imports from this
    // file, so importing weekSchedules here would create an import cycle
    // (same precedent as moOperationScrap.employeeId below). ON DELETE set
    // null: a deleted schedule degrades to "no capacity", never breaks the
    // register.
    weekScheduleId: uuid("week_schedule_id"),
    capacityFactor: numeric("capacity_factor", { precision: 6, scale: 2 }).notNull().default("1"),
    // Kapacitet (timmar per dag): a simpler alternative to the week schedule —
    // these hours Monday–Friday (× capacityFactor), a full-day holiday off,
    // a shortened holiday on its own day schedule. The week schedule wins
    // when both are set. null = none.
    hoursPerDay: numeric("hours_per_day", { precision: 5, scale: 2 }),
    // Legoresurs (type "subcontract") only: the resource's default supplier,
    // prefilled on new lego operations in the beredning. set null — deleting
    // a supplier degrades to "no default", never breaks the register.
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    active: boolean("active").notNull().default(true),
    // --- Monitor G5 resource defaults (NOTES.md #7) ---
    // Imported from Monitor's Produktionsgruppslista and editable on the
    // card; stored as DEFAULTS for the beredning (not yet consumed by it).
    // All nullable: null = "not given", never a behavioural default.
    // Förvald ställtid — same unit as routing_operations.setup_time.
    defaultSetupTime: numeric("default_setup_time", { precision: 10, scale: 2 }),
    // Op. benämning — prefill for a new operation's name on this resource.
    defaultOperationName: varchar("default_operation_name", { length: 100 }),
    // Kostnader: whether hourlyRate applies to setup / run time (Monitor's
    // "Förv. ställ"/"Förv. styck"), and the alternative calculation rate
    // "Aktuell, K.pris 1" (SEK/h) kept beside hourlyRate for future costing.
    rateAppliesToSetup: boolean("rate_applies_to_setup"),
    rateAppliesToRun: boolean("rate_applies_to_run"),
    calcRate1: numeric("calc_rate_1", { precision: 10, scale: 2 }),
    // Legoresurs only: lead/queue times in days from Monitor's Lego export.
    leadTimeDays: numeric("lead_time_days", { precision: 6, scale: 1 }),
    queueTimeDays: numeric("queue_time_days", { precision: 6, scale: 1 }),
    orderLeadTimeDays: numeric("order_lead_time_days", { precision: 6, scale: 1 }),
  },
  (table) => [
    check("work_center_code_three_digits", sql`${table.code} ~ '^[0-9]{3}$'`),
    check("work_centers_hours_per_day", sql`${table.hoursPerDay} > 0 and ${table.hoursPerDay} <= 24`),
  ]
);

// Routing = an article's operation list. No separate "routing" header table —
// the operation rows themselves ARE the routing for an article (one version,
// no versioning/history need in v1).
export const routingOperations = pgTable(
  "routing_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    sequenceNo: integer("sequence_no").notNull(),
    // "Beskrivning" — what the step IS (Kapning, Svarvning), as opposed to the
    // machine it runs on. Monitor G5 heads the column "Operationens
    // benämning". varchar, not text: this is a heading that has to stay
    // readable in every table cell, not a free-text note like `comment`.
    description: varchar("description", { length: 255 }),
    workCenterId: uuid("work_center_id")
      .notNull()
      .references(() => workCenters.id, { onDelete: "restrict" }),
    setupTime: numeric("setup_time", { precision: 10, scale: 2 }).notNull(),
    runTimePerUnit: numeric("run_time_per_unit", { precision: 10, scale: 4 }).notNull(),
    // Display preference for runTimePerUnit — see operationTimeUnitEnum above.
    timeUnit: operationTimeUnitEnum("time_unit").notNull().default("minutes_per_unit"),
    // "Kalkyl" — the row exists only to carry time into the pre-calculation
    // (standard price and sales price). It is skipped when the routing is
    // snapshotted at release, so it never reaches mo_operations and is
    // therefore invisible to the terminal, the capacity view, the
    // post-calculation and the MO printout.
    costingOnly: boolean("costing_only").notNull().default(false),
    // "Kommentar" — free text the beredare writes on the operation
    // (information och instruktioner). Monitor G5 calls the column
    // "Instruktion" in its Operationslista.
    comment: text("comment"),
    // Whether the comment is printed on the work card (utskriften
    // "Skriv ut TO (PDF)"). Off by default — a note meant for the beredare
    // alone must not leak onto the shop floor paper.
    printOnWorkCard: boolean("print_on_work_card").notNull().default(false),
    // "Packinstruktion" — free text on how the articles are packed ahead of
    // the next operation/shipment. Unlike `comment` it is shop-floor
    // information, not a note for the beredare: it always prints on the work
    // card, independent of `printOnWorkCard` (which governs `comment` only).
    packingInstructions: text("packing_instructions"),
    // --- Lego (subcontract) fields — set only when the operation's work
    // center is a legoresurs (type "subcontract"); null otherwise. ---
    // The supplier the lego purchase order goes to (defaults from the
    // resource's supplierId, editable per operation). restrict — an
    // operation pointing at a supplier keeps it alive.
    subcontractSupplierId: uuid("subcontract_supplier_id").references(() => suppliers.id, {
      onDelete: "restrict",
    }),
    // Ställpris — one-off setup charge per lego order (SEK-scale money).
    setupPrice: numeric("setup_price", { precision: 12, scale: 2 }),
    // Styckpris — price per unit, same scale as purchase_order_rows.unit_price.
    unitPrice: numeric("unit_price", { precision: 12, scale: 4 }),
    // Print "Nettovikt" (articles.weight × quantity) on the lego IO PDF.
    showNetWeight: boolean("show_net_weight").notNull().default(false),
    // true = the lego IO email attaches the article's own drawings
    // (article_files); false = the single file uploaded on the operation
    // (routing_operation_files) is used instead.
    useArticleDrawing: boolean("use_article_drawing").notNull().default(true),
  },
  (table) => [unique().on(table.articleId, table.sequenceNo)]
);

// One optional drawing per lego operation (routing_operations UNIQUE) — used
// when the operation's useArticleDrawing is off. Stored in Postgres like
// article_files (PDF/JPEG/PNG, max 20 MB); list queries must never select
// `data`. Read live via mo_operations.routingOperationId, like the TO
// printout reads article drawings.
export const routingOperationFiles = pgTable("routing_operation_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  routingOperationId: uuid("routing_operation_id")
    .notNull()
    .unique()
    .references(() => routingOperations.id, { onDelete: "cascade" }),
  filename: varchar("filename", { length: 255 }).notNull(),
  contentType: varchar("content_type", { length: 100 }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  data: bytea("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const manufacturingOrders = pgTable(
  "manufacturing_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // PO-2044, PO-2045, ... — issued by number-series.ts's getNextOrderNumber
    // (key "manufacturing_order") at insert time.
    orderNumber: varchar("order_number", { length: 20 }).notNull().unique(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    // Inlevererat — finished goods received into stock so far (delinleverans
    // from the last operation's OK reports, plus Slutför). Mirrors
    // purchase_order_rows.quantity_received: kept in step with the order's
    // mo_receipt stock_transactions in the same transaction that writes them.
    quantityReceived: numeric("quantity_received", { precision: 14, scale: 4 }).notNull().default("0"),
    status: manufacturingOrderStatusEnum("status").notNull().default("planned"),
    note: text("note"),
    // Planerat färdigdatum (E2 beläggning) — the week this order's remaining
    // operation time is loaded into. Null = "Odaterat" in the capacity view.
    dueDate: date("due_date"),
    // E3: optional back-link to the sales order row this MO was created for
    // (KO→TO-koppling). Restrict — a row with linked MOs cannot be deleted;
    // coverage ("varav i tillverkning") is always derived at read time from
    // these links, never stored. Import salesOrderRows from ./sales (safe
    // direction: sales.ts does not import manufacturing).
    salesOrderRowId: uuid("sales_order_row_id").references(() => salesOrderRows.id, {
      onDelete: "restrict",
    }),
    // Konfigurator 4c: a beställningsvara's TO — the row's (or the free TO's)
    // choices, key and the förkalkyl TVK/st at the TO quantity
    // (ManufacturingOrderConfiguration in @navet/shared). Its derived
    // structure is written into mo_operations/mo_material_consumptions at
    // CREATION, so release snapshots nothing for it. null = ordinary TO.
    configuration: jsonb("configuration"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_manufacturing_orders_sales_order_row").on(table.salesOrderRowId)]
);

// Snapshot of the article's routing, taken at release — later Routing edits
// don't retroactively change an already-released MO.
export const moOperations = pgTable(
  "mo_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    manufacturingOrderId: uuid("manufacturing_order_id")
      .notNull()
      .references(() => manufacturingOrders.id, { onDelete: "cascade" }),
    sequenceNo: integer("sequence_no").notNull(),
    // Which routing operation this snapshot came from — lets material rows
    // be mapped to their operation at release. Null for MOs released before
    // the link existed, or if the routing row is later deleted.
    routingOperationId: uuid("routing_operation_id").references(() => routingOperations.id, {
      onDelete: "set null",
    }),
    // Snapshot of the routing operation's "Beskrivning" — same reason as the
    // times and the comment: the work card shows what applied at release.
    description: varchar("description", { length: 255 }),
    workCenterId: uuid("work_center_id")
      .notNull()
      .references(() => workCenters.id, { onDelete: "restrict" }),
    setupTime: numeric("setup_time", { precision: 10, scale: 2 }).notNull(),
    runTimePerUnit: numeric("run_time_per_unit", { precision: 10, scale: 4 }).notNull(),
    // Snapshot of the routing operation's display preference at release — see
    // operationTimeUnitEnum above.
    timeUnit: operationTimeUnitEnum("time_unit").notNull().default("minutes_per_unit"),
    status: moOperationStatusEnum("status").notNull().default("pending"),
    actualTime: numeric("actual_time", { precision: 10, scale: 2 }),
    // Accumulated OK quantity from stamp-out/completion reports — drives the
    // automatic material draw and may exceed the order quantity.
    quantityCompleted: numeric("quantity_completed", { precision: 14, scale: 4 }),
    // Accumulated scrapped quantity — scrapped units also consume the
    // operation's linked components. Each scrap event is logged in
    // mo_operation_scrap with its reason.
    quantityScrapped: numeric("quantity_scrapped", { precision: 14, scale: 4 }).notNull().default("0"),
    // Snapshot of the routing operation's Kommentar and its print flag —
    // copied at release for the same reason as the times: the work card must
    // show what applied when the order was released, not what someone wrote
    // into the routing afterwards.
    comment: text("comment"),
    printOnWorkCard: boolean("print_on_work_card").notNull().default(false),
    // Snapshot of the routing operation's Packinstruktion — copied at
    // release for the same reason as the comment/times. Always printed on
    // the work card when set, independent of printOnWorkCard.
    packingInstructions: text("packing_instructions"),
    // --- Lego snapshot (from the routing operation at release). The drawing
    // is deliberately NOT snapshotted — it is read live via
    // routingOperationId, like the TO printout reads article drawings. ---
    subcontractSupplierId: uuid("subcontract_supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    setupPrice: numeric("setup_price", { precision: 12, scale: 2 }),
    unitPrice: numeric("unit_price", { precision: 12, scale: 4 }),
    showNetWeight: boolean("show_net_weight").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.manufacturingOrderId, table.sequenceNo)]
);

// One row per scrap report on an operation — quantity, mandatory reason and
// who reported it (employee via the stamp terminal, user via the MO card).
export const moOperationScrap = pgTable("mo_operation_scrap", {
  id: uuid("id").primaryKey().defaultRandom(),
  moOperationId: uuid("mo_operation_id")
    .notNull()
    .references(() => moOperations.id, { onDelete: "cascade" }),
  quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
  reason: text("reason").notNull(),
  // FK to employees declared in the migration by hand — timereport.ts already
  // imports from this module, so importing employees here would be circular.
  employeeId: uuid("employee_id"),
  // The report that logged this scrap — Ångra rapportering removes the
  // report's scrap rows. Null for rows written before the report log.
  moReportId: uuid("mo_report_id").references(() => moReports.id, { onDelete: "set null" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Rapporteringslogg: one row per reporting event on a TO — a stamp-out in
// the terminal (also a time-only one), the card's Slutför operation, a lego
// receipt on an IO, Slutför order and a manual material draw. Each row
// records exactly what the event booked (quantities, the operation flipped
// to done, the finished goods received and where, the material drawn in
// mo_report_materials, the stamp's time report), so Ångra rapportering can
// reverse precisely that event. An undone row stays as history.
export const moReportKindEnum = pgEnum("mo_report_kind", ["operation", "completion", "material"]);
export const moReportSourceEnum = pgEnum("mo_report_source", ["terminal", "card", "purchase_receipt", "migration", "auto_close"]);

export const moReports = pgTable(
  "mo_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    manufacturingOrderId: uuid("manufacturing_order_id")
      .notNull()
      .references(() => manufacturingOrders.id, { onDelete: "cascade" }),
    // Set for kind "operation"; null for Slutför order and manual draws.
    moOperationId: uuid("mo_operation_id").references(() => moOperations.id, { onDelete: "cascade" }),
    kind: moReportKindEnum("kind").notNull(),
    source: moReportSourceEnum("source").notNull(),
    quantityOk: numeric("quantity_ok", { precision: 14, scale: 4 }).notNull().default("0"),
    quantityScrapped: numeric("quantity_scrapped", { precision: 14, scale: 4 }).notNull().default("0"),
    // This report flipped its operation from pending to done.
    markedDone: boolean("marked_done").notNull().default(false),
    // Finished goods this report received into stock, and where.
    quantityReceived: numeric("quantity_received", { precision: 14, scale: 4 }).notNull().default("0"),
    receiptLocationId: uuid("receipt_location_id").references(() => stockLocations.id, { onDelete: "restrict" }),
    // This report flipped the order to done.
    completedOrder: boolean("completed_order").notNull().default(false),
    // The stamp-out's time report — undone together with the quantities.
    // FK declared by hand in the migration (timereport.ts imports this file).
    timeReportId: uuid("time_report_id"),
    // Who did the work (terminal) — FK by hand, same reason.
    employeeId: uuid("employee_id"),
    // Lego: the IO whose receipt reported the operation (not undoable here).
    purchaseOrderId: uuid("purchase_order_id").references(() => purchaseOrders.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: uuid("undone_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [index("mo_reports_by_order").on(table.manufacturingOrderId, table.createdAt)]
);

// Material a report drew, per material row and stock location — Ångra
// returns exactly these quantities to the same place.
export const moReportMaterials = pgTable("mo_report_materials", {
  id: uuid("id").primaryKey().defaultRandom(),
  moReportId: uuid("mo_report_id")
    .notNull()
    .references(() => moReports.id, { onDelete: "cascade" }),
  materialConsumptionId: uuid("material_consumption_id")
    .notNull()
    .references(() => moMaterialConsumptions.id, { onDelete: "cascade" }),
  quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
  locationId: uuid("location_id")
    .notNull()
    .references(() => stockLocations.id, { onDelete: "restrict" }),
});

// Snapshot of BOM quantity x MO quantity, taken at release.
export const moMaterialConsumptions = pgTable(
  "mo_material_consumptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    manufacturingOrderId: uuid("manufacturing_order_id")
      .notNull()
      .references(() => manufacturingOrders.id, { onDelete: "cascade" }),
    componentArticleId: uuid("component_article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    // The operation that consumes this material (snapshot of the BOM row's
    // link). Null = not tied to an operation; drawn at final completion.
    moOperationId: uuid("mo_operation_id").references(() => moOperations.id, { onDelete: "set null" }),
    quantityPlanned: numeric("quantity_planned", { precision: 14, scale: 4 }).notNull(),
    quantityConsumed: numeric("quantity_consumed", { precision: 14, scale: 4 }).notNull().default("0"),
    // Display unit snapshotted from the BOM row at release (null = base
    // unit) — consumption math stays in the base unit; this only drives how
    // the TO card/printout renders the quantity.
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "restrict" }),
    unitFactor: numeric("unit_factor", { precision: 16, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // The same article can appear once per operation. NULLS NOT DISTINCT keeps
  // the old "once per article" guarantee for unlinked material (Postgres 15+).
  (table) => [
    unique("mo_material_unique_per_operation")
      .on(table.manufacturingOrderId, table.componentArticleId, table.moOperationId)
      .nullsNotDistinct(),
  ]
);
