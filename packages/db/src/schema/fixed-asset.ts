import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { accounts, verifications } from "./economy";
import { supplierInvoices } from "./purchase";

// Anläggningsregister (ekonomi etapp 2, delprojekt 2). The register never
// books the acquisition — that is the supplier invoice's or a manual
// verification's job — and never stores a balance: accumulated depreciation
// and book value are ALWAYS derived from fixed_asset_depreciations rows with
// superseded_by_run_id IS NULL (same philosophy as stock_transactions).

export const fixedAssetStatusEnum = pgEnum("fixed_asset_status", ["active", "disposed"]);
export const fixedAssetDisposalTypeEnum = pgEnum("fixed_asset_disposal_type", ["sale", "scrap"]);

// Tillgångsgrupp: which accounts a category posts against plus the default
// useful life. Gain/loss accounts live here (BAS splits them per asset kind:
// 3972/3973, 7972/7973) rather than in posting settings.
export const fixedAssetCategories = pgTable(
  "fixed_asset_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull().unique(),
    assetAccountId: uuid("asset_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    accumulatedDepreciationAccountId: uuid("accumulated_depreciation_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    depreciationExpenseAccountId: uuid("depreciation_expense_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    disposalGainAccountId: uuid("disposal_gain_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    disposalLossAccountId: uuid("disposal_loss_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    defaultUsefulLifeMonths: integer("default_useful_life_months").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("fixed_asset_category_life_positive", sql`${table.defaultUsefulLifeMonths} > 0`),
    // A depreciation or disposal posting would net itself away otherwise
    // (same failure as PaymentBankAccountConflictError). Gain and loss MAY
    // share one account.
    check(
      "fixed_asset_category_accounts_distinct",
      sql`${table.assetAccountId} <> ${table.accumulatedDepreciationAccountId} AND ${table.depreciationExpenseAccountId} NOT IN (${table.assetAccountId}, ${table.accumulatedDepreciationAccountId})`
    ),
  ]
);

// Anläggning. Month columns hold the month's FIRST day (CHECKed); the API
// speaks "YYYY-MM". status active → disposed is the only transition, made by
// the service's disposeAsset in the same transaction as the AV verification.
export const fixedAssets = pgTable(
  "fixed_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // AN-1, AN-2, … — number_series key "fixed_asset", allocated inside the
    // insert transaction (document-series convention in number-series.ts).
    assetNumber: varchar("asset_number", { length: 20 }).notNull().unique(),
    name: varchar("name", { length: 200 }).notNull(),
    note: text("note"),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => fixedAssetCategories.id, { onDelete: "restrict" }),
    acquisitionDate: date("acquisition_date").notNull(),
    acquisitionCost: numeric("acquisition_cost", { precision: 14, scale: 2 }).notNull(),
    residualValue: numeric("residual_value", { precision: 14, scale: 2 }).notNull().default("0"),
    usefulLifeMonths: integer("useful_life_months").notNull(),
    depreciationStartMonth: date("depreciation_start_month").notNull(),
    // Ingående avskrivning: depreciation accumulated BEFORE the company kept
    // its books in Nav (already in the SIE-imported opening balance), valid
    // through this month. The plan treats it as a booked month (see
    // withOpeningDepreciation in depreciation-schedule.ts); no row is ever
    // written for it. 0 + null = acquired in Nav's time.
    openingDepreciation: numeric("opening_depreciation", { precision: 14, scale: 2 }).notNull().default("0"),
    openingDepreciationThroughMonth: date("opening_depreciation_through_month"),
    status: fixedAssetStatusEnum("status").notNull().default("active"),
    disposalDate: date("disposal_date"),
    disposalType: fixedAssetDisposalTypeEnum("disposal_type"),
    // null for a scrap — never 0, so a price can't be mistaken for "no price".
    disposalPrice: numeric("disposal_price", { precision: 14, scale: 2 }),
    disposalVerificationId: uuid("disposal_verification_id").references(() => verifications.id, {
      onDelete: "restrict",
    }),
    supplierInvoiceId: uuid("supplier_invoice_id").references(() => supplierInvoices.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fixed_assets_disposal_verification_unique")
      .on(table.disposalVerificationId)
      .where(sql`${table.disposalVerificationId} IS NOT NULL`),
    index("idx_fixed_assets_category").on(table.categoryId),
    index("idx_fixed_assets_status").on(table.status),
    index("idx_fixed_assets_supplier_invoice").on(table.supplierInvoiceId),
    check("fixed_asset_cost_positive", sql`${table.acquisitionCost} > 0`),
    check(
      "fixed_asset_residual_range",
      sql`${table.residualValue} >= 0 AND ${table.residualValue} <= ${table.acquisitionCost}`
    ),
    check("fixed_asset_life_positive", sql`${table.usefulLifeMonths} > 0`),
    check("fixed_asset_start_month_first_day", sql`extract(day from ${table.depreciationStartMonth}) = 1`),
    check(
      "fixed_asset_start_after_acquisition",
      sql`${table.depreciationStartMonth} >= date_trunc('month', ${table.acquisitionDate}::timestamp)::date`
    ),
    check("fixed_asset_opening_nonnegative", sql`${table.openingDepreciation} >= 0`),
    check(
      "fixed_asset_opening_consistent",
      sql`(${table.openingDepreciation} = 0 AND ${table.openingDepreciationThroughMonth} IS NULL) OR (${table.openingDepreciation} > 0 AND ${table.openingDepreciationThroughMonth} IS NOT NULL)`
    ),
    check(
      "fixed_asset_opening_month_first_day",
      sql`${table.openingDepreciationThroughMonth} IS NULL OR extract(day from ${table.openingDepreciationThroughMonth}) = 1`
    ),
    check(
      "fixed_asset_opening_within_base",
      sql`${table.openingDepreciation} <= ${table.acquisitionCost} - ${table.residualValue}`
    ),
    check(
      "fixed_asset_disposal_date_after_acquisition",
      sql`${table.disposalDate} IS NULL OR ${table.disposalDate} >= ${table.acquisitionDate}`
    ),
    check("fixed_asset_disposal_price_nonnegative", sql`${table.disposalPrice} IS NULL OR ${table.disposalPrice} >= 0`),
    // disposed ⇔ date + type + verification set; sale ⇔ price set (COALESCE
    // because `NULL = 'sale'` is NULL, which would fail every active row).
    check(
      "fixed_asset_disposal_consistent",
      sql`(${table.status} = 'disposed') = (${table.disposalDate} IS NOT NULL AND ${table.disposalType} IS NOT NULL AND ${table.disposalVerificationId} IS NOT NULL) AND COALESCE(${table.disposalType} = 'sale', false) = (${table.disposalPrice} IS NOT NULL)`
    ),
  ]
);

// One run = one AV verification. disposal_asset_id marks the catch-up run a
// disposal books for a single asset. reversal_verification_id is set by
// "Ångra senaste körning" (the register, not the generic Omför, owns it).
export const fixedAssetDepreciationRuns = pgTable(
  "fixed_asset_depreciation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    throughMonth: date("through_month").notNull(),
    verificationId: uuid("verification_id")
      .notNull()
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    disposalAssetId: uuid("disposal_asset_id").references(() => fixedAssets.id, { onDelete: "restrict" }),
    reversalVerificationId: uuid("reversal_verification_id")
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_fixed_asset_runs_created").on(table.createdAt),
    check("fixed_asset_run_month_first_day", sql`extract(day from ${table.throughMonth}) = 1`),
  ]
);

// One row per (asset, month). Append-only in substance: amount/month/asset
// never change and no row is deleted; the only later write is
// superseded_by_run_id := run_id when the run is undone. The partial unique
// index is the database's own guarantee of one LIVE depreciation per month.
export const fixedAssetDepreciations = pgTable(
  "fixed_asset_depreciations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => fixedAssets.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => fixedAssetDepreciationRuns.id, { onDelete: "restrict" }),
    month: date("month").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    supersededByRunId: uuid("superseded_by_run_id").references(() => fixedAssetDepreciationRuns.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("fixed_asset_depreciations_asset_month_active")
      .on(table.assetId, table.month)
      .where(sql`${table.supersededByRunId} IS NULL`),
    index("idx_fixed_asset_depreciations_run").on(table.runId),
    check("fixed_asset_depreciation_amount_positive", sql`${table.amount} > 0`),
    check("fixed_asset_depreciation_month_first_day", sql`extract(day from ${table.month}) = 1`),
  ]
);
