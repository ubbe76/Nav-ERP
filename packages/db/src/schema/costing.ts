import { sql } from "drizzle-orm";
import { boolean, check, index, integer, numeric, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { articles } from "./article";
import { manufacturingOrders, workCenters } from "./manufacturing";
import { units } from "./register";

export const costCalculationTypeEnum = pgEnum("cost_calculation_type", ["pre", "post"]);

// Where the calculation was told to read component prices from
// (System → Kalkyler). Snapshotted per calculation. "actual" is the moving
// average at the consumption date and applies to post-calculations only.
export const costingMaterialSourceEnum = pgEnum("costing_material_source", ["supplier", "standard", "actual"]);

// Which price a material row ACTUALLY used — "standard" when the supplier
// source fell back because the component has no primary supplier price,
// "none" when neither price existed and the row was costed at 0,
// "calculated" when a sub-assembly was costed from its own structure and
// routing, and "moving_average" for the derived actual cost at consumption.
export const costPriceSourceEnum = pgEnum("cost_price_source", [
  "supplier",
  "standard",
  "none",
  "calculated",
  "moving_average",
]);

// Service articles in the structure are subcontracted work (lego) and carry
// the LO markup; everything else is direct material and carries MO. A "semi"
// row is a manufactured sub-assembly costed from its OWN structure and routing
// (multi-level): it carries no markup here, because the markups are already
// inside its calculated manufacturing cost.
export const costMaterialRowKindEnum = pgEnum("cost_material_row_kind", ["material", "subcontract", "semi"]);

export const costCalculations = pgTable("cost_calculations", {
  id: uuid("id").primaryKey().defaultRandom(),
  articleId: uuid("article_id")
    .notNull()
    .references(() => articles.id, { onDelete: "restrict" }),
  // Null for a standalone pre-calculation (article + quantity, no MO yet).
  manufacturingOrderId: uuid("manufacturing_order_id").references(() => manufacturingOrders.id, { onDelete: "restrict" }),
  quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
  // Monitor's påläggskalkyl, one column per step. The markup percentages come
  // from System → Kalkyler (system_settings) except TO, which sits per work
  // center on work_centers.overhead_percent:
  //   dM (materialCost) + MO (materialOverhead)
  // + dL (laborCost)
  // + Lego (subcontractCost) + LO (subcontractOverhead)
  // + Halvfabrikat (semiFinishedCost — no markup of its own)
  // = TVK, + Affo (businessOverhead) = SVK,
  // + generalMarkup + TO (overhead) = salesPrice.
  // TO is outside TVK and SVK: it is added last, towards the sales price, and
  // carries no profit markup. TVK and SVK are plain sums and are derived on
  // read, never stored — a calculation saved under the earlier chain (TO inside
  // TVK) still sums to its stored salesPrice, only the lines read differently.
  materialCost: numeric("material_cost", { precision: 14, scale: 4 }).notNull(),
  materialOverhead: numeric("material_overhead", { precision: 14, scale: 4 }).notNull().default("0"),
  laborCost: numeric("labor_cost", { precision: 14, scale: 4 }).notNull(),
  overhead: numeric("overhead", { precision: 14, scale: 4 }).notNull(),
  subcontractCost: numeric("subcontract_cost", { precision: 14, scale: 4 }).notNull().default("0"),
  subcontractOverhead: numeric("subcontract_overhead", { precision: 14, scale: 4 }).notNull().default("0"),
  // Manufactured sub-assemblies costed from their own structure and routing
  // (multi-level). Enters TVK directly, WITHOUT a markup: MO/LO are already
  // inside the figure, so Affo and the general markup are applied exactly once,
  // at the top. The sub-assemblies' TO is not in here — it is lifted into
  // `overhead` (see cost_calculation_material_rows.overhead_amount). Default 0
  // means every calculation saved before multi-level existed reads back
  // unchanged.
  semiFinishedCost: numeric("semi_finished_cost", { precision: 14, scale: 4 }).notNull().default("0"),
  businessOverhead: numeric("business_overhead", { precision: 14, scale: 4 }).notNull().default("0"),
  generalMarkup: numeric("general_markup", { precision: 14, scale: 4 }).notNull().default("0"),
  // Materialpåslag — a sales markup on dM + MO (plus what the sub-assemblies
  // lifted up, see cost_calculation_material_rows.material_markup_amount).
  // Like TO it is outside TVK and SVK and goes to the sales price only, so the
  // self cost stays the real cost. Default 0 means every calculation saved
  // before the markup existed still sums to its stored sales price.
  materialMarkup: numeric("material_markup", { precision: 14, scale: 4 }).notNull().default("0"),
  salesPrice: numeric("sales_price", { precision: 14, scale: 4 }).notNull().default("0"),
  // The System → Kalkyler configuration this calculation ran under, so an old
  // calculation stays explainable after the settings change. numeric(6,2)
  // rather than work_centers.overhead_percent's (5,2): the markups validate up
  // to 1000 and (5,2) tops out at 999.99.
  materialSource: costingMaterialSourceEnum("material_source").notNull().default("standard"),
  // Whether this run resolved manufactured sub-assemblies recursively. Same
  // snapshot rationale as materialSource: an old calculation stays explainable
  // after the setting changes. Post-calculations are always false — a consumed
  // sub-assembly is a real stocked article, and the actual-cost material source
  // is the post-calculation's answer to the same question.
  multiLevel: boolean("multi_level").notNull().default(false),
  moPercent: numeric("mo_percent", { precision: 6, scale: 2 }).notNull().default("0"),
  loPercent: numeric("lo_percent", { precision: 6, scale: 2 }).notNull().default("0"),
  affoPercent: numeric("affo_percent", { precision: 6, scale: 2 }).notNull().default("0"),
  generalMarkupPercent: numeric("general_markup_percent", { precision: 6, scale: 2 }).notNull().default("0"),
  materialMarkupPercent: numeric("material_markup_percent", { precision: 6, scale: 2 }).notNull().default("0"),
  type: costCalculationTypeEnum("type").notNull(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per costed component — the specification behind materialCost and
// subcontractCost. Calculations saved before this table existed simply have
// no rows.
export const costCalculationMaterialRows = pgTable(
  "cost_calculation_material_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    costCalculationId: uuid("cost_calculation_id")
      .notNull()
      .references(() => costCalculations.id, { onDelete: "cascade" }),
    componentArticleId: uuid("component_article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    kind: costMaterialRowKindEnum("kind").notNull(),
    // Always in the component's base unit; unitId/unitFactor are for display
    // only, same convention as bom_components and mo_material_consumptions.
    quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull(),
    unitId: uuid("unit_id").references(() => units.id, { onDelete: "restrict" }),
    unitFactor: numeric("unit_factor", { precision: 16, scale: 6 }),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }).notNull(),
    priceSource: costPriceSourceEnum("price_source").notNull(),
    amount: numeric("amount", { precision: 14, scale: 4 }).notNull(),
    // TO lifted up from a "semi" row's sub-calculation (its own operations'
    // TO plus what its sub-assemblies lifted up). TO is outside TVK, so it is
    // not in `amount`; the header's overhead = the operation rows' TO + this.
    // 0 on material/lego rows and on every row saved before the column existed
    // — those calculations carried the sub-level's TO inside `amount`.
    overheadAmount: numeric("overhead_amount", { precision: 14, scale: 4 }).notNull().default("0"),
    // Materialpåslag lifted up from a "semi" row's sub-calculation, the same
    // way as overheadAmount: outside TVK, so not in `amount`; the header's
    // material_markup = the markup on this level's dM + MO + this. 0 on
    // material/lego rows and on rows saved before the column existed.
    materialMarkupAmount: numeric("material_markup_amount", { precision: 14, scale: 4 }).notNull().default("0"),
    // A supplier price in another currency (material source "supplier"):
    // the catalog price as stated, its currency and the rate (SEK per 1 unit,
    // the day's rate from getRate) unit_cost was converted at. All three or
    // none — null on SEK prices, on every other source and on rows saved
    // before the columns existed (those read foreign prices as kronor).
    supplierCurrency: varchar("supplier_currency", { length: 3 }),
    supplierUnitPrice: numeric("supplier_unit_price", { precision: 14, scale: 4 }),
    exchangeRate: numeric("exchange_rate", { precision: 14, scale: 6 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_cost_calculation_material_rows_calculation").on(table.costCalculationId),
    index("idx_cost_calculation_material_rows_article").on(table.componentArticleId),
    check(
      "cost_calculation_material_rows_foreign_price",
      sql`(${table.supplierCurrency} is null) = (${table.supplierUnitPrice} is null) and (${table.supplierCurrency} is null) = (${table.exchangeRate} is null)`
    ),
  ]
);

// One row per costed operation — the specification behind laborCost and
// overhead (TO). `hours` makes pre and post comparable: the pre-calculation
// stores (setupTime + runTimePerUnit x quantity) / 60, the post-calculation
// the hours actually reported. `setup_hours` is the setup share of `hours`,
// snapshotted by the pre-calculation (the routing can change afterwards) so
// the specification can show the amortised setup cost per unit; null on
// post-calculations (reported time has no setup/run split) and on rows saved
// before the column existed.
export const costCalculationOperationRows = pgTable(
  "cost_calculation_operation_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    costCalculationId: uuid("cost_calculation_id")
      .notNull()
      .references(() => costCalculations.id, { onDelete: "cascade" }),
    sequenceNo: integer("sequence_no").notNull(),
    workCenterId: uuid("work_center_id")
      .notNull()
      .references(() => workCenters.id, { onDelete: "restrict" }),
    hours: numeric("hours", { precision: 12, scale: 4 }).notNull(),
    setupHours: numeric("setup_hours", { precision: 12, scale: 4 }),
    hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }).notNull(),
    overheadPercent: numeric("overhead_percent", { precision: 5, scale: 2 }).notNull(),
    laborAmount: numeric("labor_amount", { precision: 14, scale: 4 }).notNull(),
    overheadAmount: numeric("overhead_amount", { precision: 14, scale: 4 }).notNull(),
    // Lego operation (subcontract work center): setupPrice + unitPrice ×
    // quantity, feeding the header's subcontractCost (LO markup) instead of
    // laborCost — hours/rate/labor/overhead are 0 on such rows. Null on
    // time-priced rows and on rows saved before the column existed.
    subcontractAmount: numeric("subcontract_amount", { precision: 14, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_cost_calculation_operation_rows_calculation").on(table.costCalculationId)]
);
