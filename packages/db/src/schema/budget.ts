import { sql } from "drizzle-orm";
import { boolean, check, index, numeric, pgTable, smallint, timestamp, unique, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { costCenters } from "./dimensions";
import { fiscalYears } from "./economy";

// Budget (bokföringsgranskningen etapp 5 del B, migration 0150): a budget
// per räkenskapsår with lines per (account, period, cost center). The budget
// is planning data, not räkenskapsinformation — no lock follows a closed year
// or a locked period, and the lines are freely replaced.
//
// At most one budget per year is the default (partial unique index); the
// first budget of a year becomes it and PATCH moves the flag under the
// year's budgets' FOR UPDATE.
export const budgets = pgTable(
  "budgets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fiscalYearId: uuid("fiscal_year_id")
      .notNull()
      .references(() => fiscalYears.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 100 }).notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("budgets_year_name_unique").on(table.fiscalYearId, table.name),
    uniqueIndex("budgets_year_default_unique")
      .on(table.fiscalYearId)
      .where(sql`${table.isDefault}`),
  ]
);

// `amount` carries the account's NATURAL sign (revenue positive on a revenue
// account, cost positive on a cost account — budgetSign() in the API turns it
// credit-positive for the reports); zero is never stored. `month` is the
// period's ordinal 1..N within the fiscal year's accounting_periods (N up to
// 18 for a long first year; the CHECK is a loose upper bound, the service
// validates against the year). The account is a NUMBER, not a FK, like the
// template rows. NULLS NOT DISTINCT so the lines without a cost center are
// unique too.
export const budgetLines = pgTable(
  "budget_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    budgetId: uuid("budget_id")
      .notNull()
      .references(() => budgets.id, { onDelete: "cascade" }),
    accountNumber: varchar("account_number", { length: 4 }).notNull(),
    month: smallint("month").notNull(),
    costCenterId: uuid("cost_center_id").references(() => costCenters.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
  },
  (table) => [
    unique("budget_lines_budget_account_month_cost_center_unique").on(table.budgetId, table.accountNumber, table.month, table.costCenterId).nullsNotDistinct(),
    index("idx_budget_lines_budget").on(table.budgetId),
    index("idx_budget_lines_cost_center").on(table.costCenterId),
    check("budget_line_account_number", sql`${table.accountNumber} ~ '^[0-9]{4}$'`),
    check("budget_line_month", sql`${table.month} BETWEEN 1 AND 24`),
    check("budget_line_amount_nonzero", sql`${table.amount} <> 0`),
  ]
);
