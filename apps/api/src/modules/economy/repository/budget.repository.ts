import { and, asc, count, desc, eq, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { accountingPeriods, accounts, budgetLines, budgets, costCenters, fiscalYears, verificationRows, verifications, type Db, type Tx } from "@navet/db";
import type { BudgetPeriod } from "../service/budget-calc.js";

// Budget (etapp 5 del B). The header/line storage, the per-year default
// flag, and the two readers the reports and Kopiera utfall stand on. Every
// multi-step write runs in one transaction under the FISCAL YEAR's row lock
// (create, default move, copy) or the budget's (line replacement), so two
// concurrent creates for an empty year cannot both become the default and
// two saves of the same grid serialize.

export interface BudgetFiscalYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  periods: BudgetPeriod[];
}

export interface BudgetHeaderRow {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  fiscalYearStart: string;
  name: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetLineRow {
  accountNumber: string;
  accountName: string | null;
  month: number;
  costCenterId: string | null;
  costCenterCode: string | null;
  amount: number;
}

export type BudgetLineWrite = { accountNumber: string; month: number; amount: number };

// The reports' slice: the budget's year, periods and every line.
export interface BudgetReportSource {
  id: string;
  name: string;
  fiscalYear: BudgetFiscalYear;
  lines: { accountNumber: string; month: number; costCenterId: string | null; amount: number }[];
  // id + name per budgeted account number the chart still has.
  accounts: Map<string, { accountId: string; accountName: string }>;
}

export type ActualsCostCenterFilter = "all" | "none" | { id: string };

export function createBudgetRepository(db: Db) {
  async function fiscalYearWithPeriods(executor: Db | Tx, where: SQL): Promise<BudgetFiscalYear | null> {
    const [year] = await executor.select().from(fiscalYears).where(where).orderBy(desc(fiscalYears.endDate)).limit(1);
    if (!year) return null;
    const periods = await executor
      .select({ startDate: accountingPeriods.startDate, endDate: accountingPeriods.endDate })
      .from(accountingPeriods)
      .where(eq(accountingPeriods.fiscalYearId, year.id))
      .orderBy(asc(accountingPeriods.startDate));
    return { id: year.id, label: year.label, startDate: year.startDate, endDate: year.endDate, periods };
  }

  const headerColumns = {
    id: budgets.id,
    fiscalYearId: budgets.fiscalYearId,
    fiscalYearLabel: fiscalYears.label,
    fiscalYearStart: fiscalYears.startDate,
    name: budgets.name,
    isDefault: budgets.isDefault,
    createdAt: budgets.createdAt,
    updatedAt: budgets.updatedAt,
  };

  async function header(executor: Db | Tx, id: string): Promise<BudgetHeaderRow | null> {
    const [row] = await executor.select(headerColumns).from(budgets).innerJoin(fiscalYears, eq(fiscalYears.id, budgets.fiscalYearId)).where(eq(budgets.id, id));
    return row ?? null;
  }

  // Serializes every default-flag decision for the year.
  async function lockFiscalYear(tx: Tx, fiscalYearId: string): Promise<boolean> {
    const rows = await tx.select({ id: fiscalYears.id }).from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).for("update");
    return rows.length > 0;
  }

  async function insertHeader(tx: Tx, input: { fiscalYearId: string; name: string; createdBy: string | null }): Promise<string> {
    const [existing] = await tx.select({ n: count() }).from(budgets).where(eq(budgets.fiscalYearId, input.fiscalYearId));
    const [row] = await tx
      .insert(budgets)
      .values({ fiscalYearId: input.fiscalYearId, name: input.name, isDefault: Number(existing?.n ?? 0) === 0, createdBy: input.createdBy })
      .returning({ id: budgets.id });
    return row!.id;
  }

  // id + name of the account numbers the chart has (inactive included — a
  // budget is a plan, not a booking).
  async function accountsByNumber(numbers: Iterable<string>): Promise<Map<string, { accountId: string; accountName: string }>> {
    const list = [...new Set(numbers)];
    if (list.length === 0) return new Map();
    const rows = await db.select({ id: accounts.id, number: accounts.number, name: accounts.name }).from(accounts).where(inArray(accounts.number, list));
    return new Map(rows.map((row) => [row.number, { accountId: row.id, accountName: row.name }]));
  }

  function costCenterCondition(filter: ActualsCostCenterFilter): SQL | undefined {
    if (filter === "all") return undefined;
    if (filter === "none") return isNull(verificationRows.costCenterId);
    return eq(verificationRows.costCenterId, filter.id);
  }

  return {
    async findFiscalYear(id: string): Promise<BudgetFiscalYear | null> {
      return fiscalYearWithPeriods(db, eq(fiscalYears.id, id));
    },

    // The latest year that ends before `startDate` — Kopiera utfall's default source.
    async findPreviousFiscalYear(startDate: string): Promise<BudgetFiscalYear | null> {
      return fiscalYearWithPeriods(db, lt(fiscalYears.endDate, startDate));
    },

    // Year descending, the default first, then name.
    async listHeaders(fiscalYearId?: string): Promise<BudgetHeaderRow[]> {
      return db
        .select(headerColumns)
        .from(budgets)
        .innerJoin(fiscalYears, eq(fiscalYears.id, budgets.fiscalYearId))
        .where(fiscalYearId ? eq(budgets.fiscalYearId, fiscalYearId) : undefined)
        .orderBy(desc(fiscalYears.startDate), desc(budgets.isDefault), asc(budgets.name));
    },

    // Σ amount per (budget, account) over every line — the list's totals.
    async sumsByBudget(budgetIds: string[]): Promise<{ budgetId: string; accountNumber: string; amount: number }[]> {
      if (budgetIds.length === 0) return [];
      const rows = await db
        .select({ budgetId: budgetLines.budgetId, accountNumber: budgetLines.accountNumber, amount: sql<string>`SUM(${budgetLines.amount})` })
        .from(budgetLines)
        .where(inArray(budgetLines.budgetId, budgetIds))
        .groupBy(budgetLines.budgetId, budgetLines.accountNumber);
      return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
    },

    async findHeader(id: string): Promise<BudgetHeaderRow | null> {
      return header(db, id);
    },

    async findLines(budgetId: string): Promise<BudgetLineRow[]> {
      const rows = await db
        .select({
          accountNumber: budgetLines.accountNumber,
          accountName: accounts.name,
          month: budgetLines.month,
          costCenterId: budgetLines.costCenterId,
          costCenterCode: costCenters.code,
          amount: budgetLines.amount,
        })
        .from(budgetLines)
        .leftJoin(accounts, eq(accounts.number, budgetLines.accountNumber))
        .leftJoin(costCenters, eq(costCenters.id, budgetLines.costCenterId))
        .where(eq(budgetLines.budgetId, budgetId))
        .orderBy(asc(budgetLines.accountNumber), asc(budgetLines.month));
      return rows.map((row) => ({ ...row, amount: Number(row.amount) }));
    },

    // null when the fiscal year does not exist. The first budget of a year
    // becomes the default.
    async create(input: { fiscalYearId: string; name: string; createdBy: string | null }): Promise<string | null> {
      return db.transaction(async (tx) => {
        if (!(await lockFiscalYear(tx, input.fiscalYearId))) return null;
        return insertHeader(tx, input);
      });
    },

    // `isDefault: true` moves the flag within the year; false clears it.
    async update(id: string, patch: { name?: string; isDefault?: boolean }): Promise<BudgetHeaderRow | null> {
      return db.transaction(async (tx) => {
        const [current] = await tx.select({ id: budgets.id, fiscalYearId: budgets.fiscalYearId }).from(budgets).where(eq(budgets.id, id)).for("update");
        if (!current) return null;
        if (patch.isDefault !== undefined) {
          await lockFiscalYear(tx, current.fiscalYearId);
          if (patch.isDefault) {
            await tx
              .update(budgets)
              .set({ isDefault: false, updatedAt: new Date() })
              .where(and(eq(budgets.fiscalYearId, current.fiscalYearId), eq(budgets.isDefault, true)));
          }
        }
        await tx
          .update(budgets)
          .set({ ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}), updatedAt: new Date() })
          .where(eq(budgets.id, id));
        return header(tx, id);
      });
    },

    async delete(id: string): Promise<boolean> {
      const rows = await db.delete(budgets).where(eq(budgets.id, id)).returning({ id: budgets.id });
      return rows.length > 0;
    },

    // Replace-the-set for ONE cost center under the budget's lock; false =
    // the budget does not exist.
    async replaceLines(budgetId: string, costCenterId: string | null, rows: BudgetLineWrite[]): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [current] = await tx.select({ id: budgets.id }).from(budgets).where(eq(budgets.id, budgetId)).for("update");
        if (!current) return false;
        await tx
          .delete(budgetLines)
          .where(and(eq(budgetLines.budgetId, budgetId), costCenterId === null ? isNull(budgetLines.costCenterId) : eq(budgetLines.costCenterId, costCenterId)));
        if (rows.length > 0) {
          await tx.insert(budgetLines).values(rows.map((row) => ({ budgetId, accountNumber: row.accountNumber, month: row.month, costCenterId, amount: String(row.amount) })));
        }
        await tx.update(budgets).set({ updatedAt: new Date() }).where(eq(budgets.id, budgetId));
        return true;
      });
    },

    // Kopiera budget: a new header in `fiscalYearId` (default rule as
    // create) plus every line of the source with month ≤ maxMonth, all
    // cost centers alike; `droppedMonths` = the distinct source months
    // beyond maxMonth that carried lines. null when the target year does
    // not exist.
    async copy(sourceId: string, input: { fiscalYearId: string; name: string; createdBy: string | null }, maxMonth: number): Promise<{ id: string; droppedMonths: number } | null> {
      return db.transaction(async (tx) => {
        if (!(await lockFiscalYear(tx, input.fiscalYearId))) return null;
        const id = await insertHeader(tx, input);
        await tx.execute(sql`
          INSERT INTO ${budgetLines} (budget_id, account_number, month, cost_center_id, amount)
          SELECT ${id}, account_number, month, cost_center_id, amount
          FROM ${budgetLines}
          WHERE budget_id = ${sourceId} AND month <= ${maxMonth}
        `);
        const [dropped] = await tx
          .select({ n: sql<string>`COUNT(DISTINCT ${budgetLines.month})` })
          .from(budgetLines)
          .where(and(eq(budgetLines.budgetId, sourceId), sql`${budgetLines.month} > ${maxMonth}`));
        return { id, droppedMonths: Number(dropped?.n ?? 0) };
      });
    },

    // Kopiera utfall: booked debit/credit per budgetable account and period
    // of the source year, optionally only the rows on one cost center or on
    // none. `periodStart` identifies the period (unique per year).
    async actuals(fiscalYearId: string, filter: ActualsCostCenterFilter): Promise<{ accountNumber: string; periodStart: string; debit: number; credit: number }[]> {
      const rows = await db
        .select({
          accountNumber: accounts.number,
          periodStart: accountingPeriods.startDate,
          debit: sql<string>`COALESCE(SUM(${verificationRows.debit}), 0)`,
          credit: sql<string>`COALESCE(SUM(${verificationRows.credit}), 0)`,
        })
        .from(verificationRows)
        .innerJoin(verifications, eq(verifications.id, verificationRows.verificationId))
        .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
        .innerJoin(
          accountingPeriods,
          and(eq(accountingPeriods.fiscalYearId, fiscalYearId), sql`${verifications.date} BETWEEN ${accountingPeriods.startDate} AND ${accountingPeriods.endDate}`)
        )
        .where(and(eq(verifications.status, "booked"), sql`${accounts.number} BETWEEN '3000' AND '8999'`, costCenterCondition(filter)))
        .groupBy(accounts.number, accountingPeriods.startDate);
      return rows.map((row) => ({ accountNumber: row.accountNumber, periodStart: row.periodStart, debit: Number(row.debit), credit: Number(row.credit) }));
    },

    accountsByNumber,

    // Every budgetable account of the chart (class 3–8), for the CSV parser.
    async budgetableAccountNames(): Promise<Map<string, string>> {
      const rows = await db.select({ number: accounts.number, name: accounts.name }).from(accounts).where(sql`${accounts.number} BETWEEN '3000' AND '8999'`);
      return new Map(rows.map((row) => [row.number, row.name]));
    },

    async listCostCenters(): Promise<{ id: string; code: string; name: string }[]> {
      return db.select({ id: costCenters.id, code: costCenters.code, name: costCenters.name }).from(costCenters);
    },

    async findCostCenter(id: string): Promise<{ id: string; code: string; name: string } | null> {
      const [row] = await db.select({ id: costCenters.id, code: costCenters.code, name: costCenters.name }).from(costCenters).where(eq(costCenters.id, id));
      return row ?? null;
    },

    // Resultaträkningen med budget.
    async findForReport(id: string): Promise<BudgetReportSource | null> {
      const head = await header(db, id);
      if (!head) return null;
      const fiscalYear = await fiscalYearWithPeriods(db, eq(fiscalYears.id, head.fiscalYearId));
      if (!fiscalYear) return null;
      const rows = await db
        .select({ accountNumber: budgetLines.accountNumber, month: budgetLines.month, costCenterId: budgetLines.costCenterId, amount: budgetLines.amount })
        .from(budgetLines)
        .where(eq(budgetLines.budgetId, id));
      const lines = rows.map((row) => ({ ...row, amount: Number(row.amount) }));
      return { id: head.id, name: head.name, fiscalYear, lines, accounts: await accountsByNumber(lines.map((line) => line.accountNumber)) };
    },
  };
}

export type BudgetRepository = ReturnType<typeof createBudgetRepository>;
