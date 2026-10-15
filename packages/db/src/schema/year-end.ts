import { sql } from "drizzle-orm";
import { check, date, index, integer, numeric, pgEnum, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { accounts, fiscalYears, verifications } from "./economy";

// Årsbokslut (ekonomi etapp 2, delprojekt 3). The link columns on
// year_end_closings say what is LIVE; year_end_closing_verifications logs
// everything the guide ever booked (Omför is refused for those, and the VAT
// report excludes them by identity). No stored balances anywhere.

export const yearEndClosingStatusEnum = pgEnum("year_end_closing_status", ["in_progress", "closed"]);
export const yearEndStepEnum = pgEnum("year_end_step", ["inventory", "accruals", "result_transfer", "profit_disposition"]);
export const yearEndVerificationRoleEnum = pgEnum("year_end_verification_role", ["booking", "accrual_reversal", "cancellation"]);
export const yearEndAccrualKindEnum = pgEnum("year_end_accrual_kind", [
  "prepaid_expense",
  "accrued_income",
  "accrued_expense",
  "prepaid_income",
]);

export const yearEndClosings = pgTable(
  "year_end_closings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .unique()
      .references(() => fiscalYears.id, { onDelete: "restrict" }),
    closingDate: date("closing_date").notNull(),
    status: yearEndClosingStatusEnum("status").notNull().default("in_progress"),
    inventoryMethod: varchar("inventory_method", { length: 20 }),
    inventoryValue: numeric("inventory_value", { precision: 14, scale: 2 }),
    inventoryVerificationId: uuid("inventory_verification_id")
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    inventoryBookedAt: timestamp("inventory_booked_at", { withTimezone: true }),
    accrualsVerificationId: uuid("accruals_verification_id")
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    accrualsReversalVerificationId: uuid("accruals_reversal_verification_id")
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    accrualsBookedAt: timestamp("accruals_booked_at", { withTimezone: true }),
    resultTransferVerificationId: uuid("result_transfer_verification_id")
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("year_end_inventory_method_valid", sql`${table.inventoryMethod} IN ('standard', 'latest_purchase', 'moving_average')`),
    check(
      "year_end_inventory_consistent",
      sql`(${table.inventoryBookedAt} IS NULL) = (${table.inventoryMethod} IS NULL) AND (${table.inventoryBookedAt} IS NULL) = (${table.inventoryValue} IS NULL) AND (${table.inventoryVerificationId} IS NULL OR ${table.inventoryBookedAt} IS NOT NULL)`
    ),
    check(
      "year_end_accruals_pair",
      sql`(${table.accrualsVerificationId} IS NULL) = (${table.accrualsReversalVerificationId} IS NULL) AND (${table.accrualsVerificationId} IS NULL OR ${table.accrualsBookedAt} IS NOT NULL)`
    ),
  ]
);

export const yearEndClosingVerifications = pgTable(
  "year_end_closing_verifications",
  {
    verificationId: uuid("verification_id")
      .primaryKey()
      .references(() => verifications.id, { onDelete: "restrict" }),
    closingId: uuid("closing_id")
      .notNull()
      .references(() => yearEndClosings.id, { onDelete: "restrict" }),
    step: yearEndStepEnum("step").notNull(),
    role: yearEndVerificationRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_year_end_closing_verifications_closing").on(table.closingId)]
);

// Append-only: the live rows are those whose verification_id is the
// closing's accruals_verification_id; rows of a re-run step stay as the
// specification of their (reversed) verification.
export const yearEndAccruals = pgTable(
  "year_end_accruals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    closingId: uuid("closing_id")
      .notNull()
      .references(() => yearEndClosings.id, { onDelete: "restrict" }),
    verificationId: uuid("verification_id")
      .notNull()
      .references(() => verifications.id, { onDelete: "restrict" }),
    kind: yearEndAccrualKindEnum("kind").notNull(),
    balanceAccountId: uuid("balance_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    resultAccountId: uuid("result_account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_year_end_accruals_verification").on(table.verificationId),
    index("idx_year_end_accruals_closing").on(table.closingId),
    check("year_end_accrual_amount_positive", sql`${table.amount} > 0`),
    check("year_end_accrual_accounts_distinct", sql`${table.balanceAccountId} <> ${table.resultAccountId}`),
  ]
);

export const profitDispositions = pgTable(
  "profit_dispositions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    closingId: uuid("closing_id")
      .notNull()
      .references(() => yearEndClosings.id, { onDelete: "restrict" }),
    agmDate: date("agm_date").notNull(),
    resultAmount: numeric("result_amount", { precision: 14, scale: 2 }).notNull(),
    dividendAmount: numeric("dividend_amount", { precision: 14, scale: 2 }).notNull().default("0"),
    verificationId: uuid("verification_id")
      .notNull()
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    reversalVerificationId: uuid("reversal_verification_id")
      .unique()
      .references(() => verifications.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("profit_dispositions_one_active")
      .on(table.closingId)
      .where(sql`${table.reversalVerificationId} IS NULL`),
    check("profit_disposition_dividend_nonnegative", sql`${table.dividendAmount} >= 0`),
    check("profit_disposition_nonzero", sql`${table.resultAmount} <> 0 OR ${table.dividendAmount} > 0`),
  ]
);
