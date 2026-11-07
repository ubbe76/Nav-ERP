import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, numeric, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
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

// Where a calculation's price markup (generellt påslag, materialpåslag) came
// from (#16, migration 0194): the company (System → Kalkyler), the article's
// varugrupp, or Pröva påslag ("trial"). A calculation has no customer and no
// order, so those levels never appear here.
export const costingMarkupLevelEnum = pgEnum("costing_markup_level", ["company", "group", "trial"]);

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
  // Påslag per nivå (#16, migration 0194): the level each price markup above
  // was resolved on — varugrupp → företaget, or "trial" (Pröva påslag; the
  // list and the specification show prövat). The cost markups are always the
  // company's. Default company = every calculation saved before 0194.
  generalMarkupLevel: costingMarkupLevelEnum("general_markup_level").notNull().default("company"),
  materialMarkupLevel: costingMarkupLevelEnum("material_markup_level").notNull().default("company"),
  // The base the materialpåslag was taken on: dM + MO of this level plus
  // what the sub-assemblies lifted up (their material_markup_base), so
  // material_markup = material_markup_percent × this. Lets the Kalkylpris
  // (etapp 2) re-price the markup exactly at another percentage — on a
  // multi-level calculation dM + MO alone misses the sub-levels' material,
  // and with 0 % the markup amount says nothing. 0194 backfilled
  // material_cost + material_overhead where multi_level = false (exact);
  // null = a multi-level calculation saved before 0194.
  materialMarkupBase: numeric("material_markup_base", { precision: 14, scale: 4 }),
  type: costCalculationTypeEnum("type").notNull(),
  calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  // Avvikelseanalys (#14, migration 0187): what the efterkalkyl's base — the
  // order's own rows priced with the förkalkyl's rules at T₀ — was computed
  // for. output_quantity = N, the received quantity; preliminary = the order
  // was not Klar/Stängd (each operation's base then runs on its OK quantity);
  // base_priced_at = T₀ (the order's created_at); base_material_source = the
  // förkalkyl's source that applied. All four or none (CHECK), and only on a
  // post-calculation: null = a förkalkyl or an efterkalkyl saved before the
  // analysis, which then reads `analysis: null` — its base cannot be rebuilt
  // as it was when it was saved.
  outputQuantity: numeric("output_quantity", { precision: 14, scale: 4 }),
  preliminary: boolean("preliminary"),
  basePricedAt: timestamp("base_priced_at", { withTimezone: true }),
  baseMaterialSource: costingMaterialSourceEnum("base_material_source"),
}, (table) => [
  check(
    "cost_calculations_variance_base",
    sql`(${table.outputQuantity} is null and ${table.preliminary} is null and ${table.basePricedAt} is null and ${table.baseMaterialSource} is null) or (${table.outputQuantity} is not null and ${table.preliminary} is not null and ${table.basePricedAt} is not null and ${table.baseMaterialSource} is not null and ${table.baseMaterialSource} <> 'actual' and ${table.type} = 'post')`
  ),
]);

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
    // The sub-calculation's material_markup_base beside material_markup_amount
    // on a "semi" row (#16, 0194): the header's base = this level's dM + MO +
    // Σ this. 0 on material/lego rows and on rows saved before the column.
    materialMarkupBase: numeric("material_markup_base", { precision: 14, scale: 4 }).notNull().default("0"),
    // A supplier price in another currency (material source "supplier"):
    // the catalog price as stated, its currency and the rate (SEK per 1 unit,
    // the day's rate from getRate) unit_cost was converted at. All three or
    // none — null on SEK prices, on every other source and on rows saved
    // before the columns existed (those read foreign prices as kronor).
    supplierCurrency: varchar("supplier_currency", { length: 3 }),
    supplierUnitPrice: numeric("supplier_unit_price", { precision: 14, scale: 4 }),
    exchangeRate: numeric("exchange_rate", { precision: 14, scale: 6 }),
    // Efterkalkyl: the day the standard or supplier price (and rate) was
    // taken — the component's latest withdrawal on the order. Null on
    // pre-calculations, on Verklig kostnad (weighted per withdrawal) and on
    // rows saved before the column existed (those used the current price).
    priceDate: date("price_date"),
    // Avvikelseanalys (#14): the row's base on an efterkalkyl with an
    // analysis — base_quantity = SQ (planned ÷ order quantity × N for the
    // row), base_unit_cost = SP (the förkalkyl's rules at T₀, staffel on the
    // planned quantity) and the price source that gave it; scrap_quantity =
    // the planned share of the scrapped units (planned ÷ order quantity × K),
    // the basis of "varav kassation". All four or none (CHECK); null on
    // förkalkyler and on rows saved before the analysis.
    baseQuantity: numeric("base_quantity", { precision: 14, scale: 4 }),
    baseUnitCost: numeric("base_unit_cost", { precision: 14, scale: 4 }),
    basePriceSource: costPriceSourceEnum("base_price_source"),
    scrapQuantity: numeric("scrap_quantity", { precision: 14, scale: 4 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_cost_calculation_material_rows_calculation").on(table.costCalculationId),
    index("idx_cost_calculation_material_rows_article").on(table.componentArticleId),
    check(
      "cost_calculation_material_rows_foreign_price",
      sql`(${table.supplierCurrency} is null) = (${table.supplierUnitPrice} is null) and (${table.supplierCurrency} is null) = (${table.exchangeRate} is null)`
    ),
    check(
      "cost_calculation_material_rows_variance_base",
      sql`(${table.baseQuantity} is null) = (${table.baseUnitCost} is null) and (${table.baseQuantity} is null) = (${table.basePriceSource} is null) and (${table.baseQuantity} is null) = (${table.scrapQuantity} is null)`
    ),
  ]
);

// One row per costed operation — the specification behind laborCost and
// overhead (TO). `hours` makes pre and post comparable: the pre-calculation
// stores (setupTime + runTimePerUnit x quantity) / 60, the post-calculation
// the hours actually reported. `setup_hours` is the setup share of `hours`,
// snapshotted by the pre-calculation (the routing can change afterwards) so
// the specification can show the amortised setup cost per unit. On a
// post-calculation it is the hours reported as ställ (time_reports.kind,
// #14 etapp 3) — null while no report on the operation has a type — and it
// is null on rows saved before the column existed.
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
    // Avvikelseanalys (#14) on an efterkalkyl with an analysis. A time row:
    // base_setup_hours = Bs (the planned setup, once, when it counts),
    // base_run_hours = Br (run time × N for the operation) and
    // base_hourly_rate = R₀ (= hourly_rate until the rate has a history).
    // Bs and Br are minutes ÷ 60 — eight decimals, because at four 4 min
    // (0.0667 h) at 300 kr/h would be calculated at 20.01.
    // run_hours = the hours reported as produktion; with setup_hours (on an
    // efterkalkyl the hours reported as ställ) it is null while no report on
    // the operation has a type — hours not in either are "ej uppdelad".
    // A lego row: base_quantity = N for the operation, subcontract_quantity =
    // the quantity the cost was taken for (Σ received on the IO rows, else
    // the OK quantity), base_unit_price = P₀ and base_one_off = F₀ (ställpris
    // + transport when it counts, else 0). Each group all or none, never both
    // (CHECK); null on förkalkyler and on rows saved before the analysis.
    baseSetupHours: numeric("base_setup_hours", { precision: 16, scale: 8 }),
    baseRunHours: numeric("base_run_hours", { precision: 16, scale: 8 }),
    runHours: numeric("run_hours", { precision: 12, scale: 4 }),
    baseHourlyRate: numeric("base_hourly_rate", { precision: 10, scale: 2 }),
    baseQuantity: numeric("base_quantity", { precision: 14, scale: 4 }),
    subcontractQuantity: numeric("subcontract_quantity", { precision: 14, scale: 4 }),
    baseUnitPrice: numeric("base_unit_price", { precision: 12, scale: 4 }),
    baseOneOff: numeric("base_one_off", { precision: 12, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_cost_calculation_operation_rows_calculation").on(table.costCalculationId),
    check(
      "cost_calculation_operation_rows_variance_base",
      sql`(${table.baseSetupHours} is null) = (${table.baseRunHours} is null) and (${table.baseSetupHours} is null) = (${table.baseHourlyRate} is null) and (${table.baseQuantity} is null) = (${table.subcontractQuantity} is null) and (${table.baseQuantity} is null) = (${table.baseUnitPrice} is null) and (${table.baseQuantity} is null) = (${table.baseOneOff} is null) and (${table.baseSetupHours} is null or ${table.baseQuantity} is null)`
    ),
  ]
);
