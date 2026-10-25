import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { budgetLines, budgets, costCenters, db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createBudgetRepository } from "../src/modules/economy/repository/budget.repository.js";
import { createDimensionRepository } from "../src/modules/economy/repository/dimension.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import {
  BudgetAccountInvalidError,
  BudgetDuplicateAccountError,
  BudgetMonthInvalidError,
  BudgetNameTakenError,
  BudgetNoPreviousYearError,
  BudgetNotFoundError,
  createBudgetService,
} from "../src/modules/economy/service/budget.service.js";
import { CostCenterNotFoundError } from "../src/modules/economy/service/dimension-check.js";
import { createDimensionService } from "../src/modules/economy/service/dimension.service.js";
import { FiscalYearNotFoundError, createEconomyService } from "../src/modules/economy/service/economy.service.js";
import {
  BudgetNotCombinableError,
  BudgetRangeOutsideYearError,
  createFinancialReportsService,
} from "../src/modules/economy/service/financial-reports.service.js";

// Budget (etapp 5 del B) against Postgres: CRUD and the per-year default,
// replace-the-set per cost center, validation, Kopiera budget, Kopiera
// utfall, resultaträkningen med budget and the cost center reassignment
// that sums colliding lines.

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
const audit = { log: async () => {} };
const economy = createEconomyService(repo, audit);
const budgetRepo = createBudgetRepository(db);
const service = createBudgetService({ repo: budgetRepo, audit });
const reports = createFinancialReportsService({ db, repo, budgets: budgetRepo });
const dimensions = createDimensionService(createDimensionRepository(db), audit);

const TRUNCATE = sql`TRUNCATE budget_lines, budgets, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, cost_centers, projects, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const PREVIOUS = 2026;
const YEAR = 2027;

async function setup() {
  const user = await authRepo.create({ email: `budget-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
  const previous = await economy.createFiscalYear({ label: String(PREVIOUS), startDate: `${PREVIOUS}-01-01`, endDate: `${PREVIOUS}-12-31` });
  const year = await economy.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await economy.createSeries({ code: "A", name: "Manuella verifikat" });
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  const [workshop] = await db.insert(costCenters).values({ code: "100", name: "Verkstad" }).returning();
  const [assembly] = await db.insert(costCenters).values({ code: "200", name: "Montering" }).returning();
  const account = async (number: string) => (await repo.findAccountByNumber(number))!.id;
  const book = async (date: string, rows: { number: string; net: number; costCenterId?: string }[]) =>
    economy.createVerification(
      {
        seriesId: series.id,
        date,
        description: "Test",
        rows: await Promise.all(
          rows.map(async (r) => ({
            accountId: await account(r.number),
            debit: r.net > 0 ? r.net : 0,
            credit: r.net < 0 ? -r.net : 0,
            ...(r.costCenterId ? { costCenterId: r.costCenterId } : {}),
          }))
        ),
        book: true,
      },
      user.id
    );
  return { user, previous, year, workshop: workshop!, assembly: assembly!, book };
}

const months = (fill: number, overrides: Record<number, number> = {}) => Array.from({ length: 12 }, (_, i) => overrides[i + 1] ?? fill);

describe("budgets — CRUD and the default flag", () => {
  it("the first budget of a year becomes the default, the name is unique per year, the list carries totals in natural sign", async () => {
    const { user, year, previous } = await setup();
    const first = await service.create({ fiscalYearId: year.id, name: "Budget 2027" }, user.id);
    expect(first).toMatchObject({ name: "Budget 2027", isDefault: true, fiscalYearLabel: "2027", fiscalYearStart: `${YEAR}-01-01`, fiscalYearEnd: `${YEAR}-12-31`, lines: [] });
    expect(first.months).toHaveLength(12);
    expect(first.months[0]).toEqual({ month: 1, startDate: `${YEAR}-01-01`, endDate: `${YEAR}-01-31`, label: `${YEAR}-01` });

    const second = await service.create({ fiscalYearId: year.id, name: "Alternativ" }, user.id);
    expect(second.isDefault).toBe(false);
    await expect(service.create({ fiscalYearId: year.id, name: "Budget 2027" }, user.id)).rejects.toBeInstanceOf(BudgetNameTakenError);
    await expect(service.create({ fiscalYearId: crypto.randomUUID(), name: "X" }, user.id)).rejects.toBeInstanceOf(FiscalYearNotFoundError);
    // The same name in another year is fine.
    const older = await service.create({ fiscalYearId: previous.id, name: "Budget 2027" }, user.id);
    expect(older.isDefault).toBe(true);

    await service.replaceLines(first.id, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(1000) }, { accountNumber: "5010", amounts: months(200) }] }, user.id);
    const list = await service.list({});
    expect(list.total).toBe(3);
    expect(list.rows.map((r) => [r.fiscalYearLabel, r.name, r.isDefault, r.revenue, r.costs, r.result])).toEqual([
      ["2027", "Budget 2027", true, 12000, 2400, 9600],
      ["2027", "Alternativ", false, 0, 0, 0],
      ["2026", "Budget 2027", true, 0, 0, 0],
    ]);
    expect((await service.list({ fiscalYearId: previous.id })).rows.map((r) => r.id)).toEqual([older.id]);
  });

  it("PATCH isDefault moves the flag within the year, false clears it; delete takes the lines with it", async () => {
    const { user, year } = await setup();
    const first = await service.create({ fiscalYearId: year.id, name: "A" }, user.id);
    const second = await service.create({ fiscalYearId: year.id, name: "B" }, user.id);

    const moved = await service.update(second.id, { isDefault: true }, user.id);
    expect(moved.isDefault).toBe(true);
    expect((await service.get(first.id)).isDefault).toBe(false);

    const cleared = await service.update(second.id, { isDefault: false, name: "B2" }, user.id);
    expect(cleared).toMatchObject({ isDefault: false, name: "B2" });
    expect((await service.list({ fiscalYearId: year.id })).rows.every((r) => !r.isDefault)).toBe(true);
    await expect(service.update(first.id, { name: "B2" }, user.id)).rejects.toBeInstanceOf(BudgetNameTakenError);
    await expect(service.update(crypto.randomUUID(), { name: "X" }, user.id)).rejects.toBeInstanceOf(BudgetNotFoundError);

    await service.replaceLines(first.id, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(1) }] }, user.id);
    await service.delete(first.id, user.id);
    await expect(service.get(first.id)).rejects.toBeInstanceOf(BudgetNotFoundError);
    expect(await db.select().from(budgetLines)).toHaveLength(0);
    await expect(service.delete(first.id, user.id)).rejects.toBeInstanceOf(BudgetNotFoundError);
  });
});

describe("budgets — the grid", () => {
  it("PUT replaces only its own cost center's lines, stores no zeros, and the grid lists (account, cost center) in order", async () => {
    const { user, year, workshop } = await setup();
    const budget = await service.create({ fiscalYearId: year.id, name: "B" }, user.id);

    await service.replaceLines(budget.id, { costCenterId: null, lines: [{ accountNumber: "5010", amounts: months(400, { 6: 0 }) }, { accountNumber: "3001", amounts: months(1000) }] }, user.id);
    const withWorkshop = await service.replaceLines(budget.id, { costCenterId: workshop.id, lines: [{ accountNumber: "3001", amounts: months(0, { 1: 500.004 }) }] }, user.id);
    expect(withWorkshop.lines).toEqual([
      { accountNumber: "3001", accountName: "Försäljning inom Sverige 25 %", costCenterId: null, amounts: months(1000) },
      { accountNumber: "3001", accountName: "Försäljning inom Sverige 25 %", costCenterId: workshop.id, amounts: months(0, { 1: 500 }) },
      { accountNumber: "5010", accountName: "Lokalhyra", costCenterId: null, amounts: months(400, { 6: 0 }) },
    ]);
    expect(await db.select().from(budgetLines)).toHaveLength(12 + 1 + 11);

    // Replacing Ej fördelat leaves the workshop's line alone; an empty set clears it.
    const replaced = await service.replaceLines(budget.id, { costCenterId: null, lines: [{ accountNumber: "4010", amounts: months(0, { 12: 7 }) }] }, user.id);
    expect(replaced.lines.map((l) => [l.accountNumber, l.costCenterId])).toEqual([["3001", workshop.id], ["4010", null]]);
    const cleared = await service.replaceLines(budget.id, { costCenterId: workshop.id, lines: [] }, user.id);
    expect(cleared.lines.map((l) => [l.accountNumber, l.costCenterId])).toEqual([["4010", null]]);
  });

  it("refuses the wrong month count, duplicate accounts, non-budgetable or unknown accounts and an unknown cost center", async () => {
    const { user, year } = await setup();
    const budget = await service.create({ fiscalYearId: year.id, name: "B" }, user.id);
    const put = (lines: { accountNumber: string; amounts: number[] }[], costCenterId: string | null = null) => service.replaceLines(budget.id, { costCenterId, lines }, user.id);

    await expect(put([{ accountNumber: "3001", amounts: months(1).slice(0, 11) }])).rejects.toBeInstanceOf(BudgetMonthInvalidError);
    await expect(put([{ accountNumber: "3001", amounts: months(1) }, { accountNumber: "3001", amounts: months(2) }])).rejects.toBeInstanceOf(BudgetDuplicateAccountError);
    await expect(put([{ accountNumber: "1930", amounts: months(1) }, { accountNumber: "8999", amounts: months(1) }, { accountNumber: "4711", amounts: months(1) }, { accountNumber: "3001", amounts: months(1) }])).rejects.toMatchObject({
      name: "BudgetAccountInvalidError",
      accounts: ["1930", "4711", "8999"],
    });
    await expect(put([{ accountNumber: "3001", amounts: months(1) }], crypto.randomUUID())).rejects.toBeInstanceOf(CostCenterNotFoundError);
    await expect(service.replaceLines(crypto.randomUUID(), { costCenterId: null, lines: [] }, user.id)).rejects.toBeInstanceOf(BudgetNotFoundError);
    expect(await db.select().from(budgetLines)).toHaveLength(0);
    expect(BudgetAccountInvalidError.name).toBe("BudgetAccountInvalidError");
  });

  it("an inactive cost center is allowed on the lines (a budget is a plan)", async () => {
    const { user, year, workshop } = await setup();
    await db.update(costCenters).set({ active: false }).where(eq(costCenters.id, workshop.id));
    const budget = await service.create({ fiscalYearId: year.id, name: "B" }, user.id);
    const detail = await service.replaceLines(budget.id, { costCenterId: workshop.id, lines: [{ accountNumber: "3001", amounts: months(1) }] }, user.id);
    expect(detail.lines[0]!.costCenterId).toBe(workshop.id);
  });
});

describe("budgets — Kopiera budget", () => {
  it("copies every line of every cost center by ordinal and drops the months the target year lacks", async () => {
    const { user, year, workshop } = await setup();
    const short = await economy.createFiscalYear({ label: "2028H1", startDate: "2028-01-01", endDate: "2028-06-30" });
    const source = await service.create({ fiscalYearId: year.id, name: "Källa" }, user.id);
    await service.replaceLines(source.id, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(100) }] }, user.id);
    await service.replaceLines(source.id, { costCenterId: workshop.id, lines: [{ accountNumber: "5010", amounts: months(0, { 2: 20, 8: 80, 12: 120 }) }] }, user.id);

    const whole = await service.copy(source.id, { fiscalYearId: year.id, name: "Kopia" }, user.id);
    expect(whole.droppedMonths).toBe(0);
    expect(whole.isDefault).toBe(false);
    expect(whole.lines).toEqual((await service.get(source.id)).lines);
    await expect(service.copy(source.id, { fiscalYearId: year.id, name: "Kopia" }, user.id)).rejects.toBeInstanceOf(BudgetNameTakenError);

    const toShort = await service.copy(source.id, { fiscalYearId: short.id, name: "Halvår" }, user.id);
    expect(toShort.droppedMonths).toBe(6); // months 7–12 carried lines (3001 every month, 5010 in 8 and 12)
    expect(toShort.months).toHaveLength(6);
    expect(toShort.isDefault).toBe(true); // first budget of that year
    expect(toShort.lines).toEqual([
      { accountNumber: "3001", accountName: "Försäljning inom Sverige 25 %", costCenterId: null, amounts: [100, 100, 100, 100, 100, 100] },
      { accountNumber: "5010", accountName: "Lokalhyra", costCenterId: workshop.id, amounts: [0, 20, 0, 0, 0, 0] },
    ]);
    await expect(service.copy(source.id, { fiscalYearId: crypto.randomUUID(), name: "X" }, user.id)).rejects.toBeInstanceOf(FiscalYearNotFoundError);
  });
});

describe("budgets — Kopiera utfall från föregående år", () => {
  it("reads the previous year's booked actuals per account and period in natural sign, scaled and rounded to whole kronor, per cost center or none", async () => {
    const { user, year, previous, workshop, book } = await setup();
    const budget = await service.create({ fiscalYearId: year.id, name: "B" }, user.id);
    await book(`${PREVIOUS}-02-10`, [{ number: "1930", net: 1000 }, { number: "3001", net: -1000, costCenterId: workshop.id }]);
    await book(`${PREVIOUS}-02-12`, [{ number: "5010", net: 300 }, { number: "1930", net: -300 }]);
    await book(`${PREVIOUS}-03-05`, [{ number: "5010", net: 200, costCenterId: workshop.id }, { number: "1930", net: -200 }]);
    await book(`${PREVIOUS}-03-06`, [{ number: "6110", net: 333.33 }, { number: "1930", net: -333.33 }]);
    // A credit note on revenue: natural sign goes negative.
    await book(`${PREVIOUS}-04-01`, [{ number: "3001", net: 50 }, { number: "1930", net: -50 }]);
    // The budget's own year must not leak into the source.
    await book(`${YEAR}-01-05`, [{ number: "5010", net: 9999 }, { number: "1930", net: -9999 }]);

    const all = await service.actuals(budget.id, { percent: 0 });
    expect(all.lines).toEqual([
      { accountNumber: "3001", accountName: "Försäljning inom Sverige 25 %", costCenterId: null, amounts: months(0, { 2: 1000, 4: -50 }) },
      { accountNumber: "5010", accountName: "Lokalhyra", costCenterId: null, amounts: months(0, { 2: 300, 3: 200 }) },
      { accountNumber: "6110", accountName: "Kontorsmaterial", costCenterId: null, amounts: months(0, { 3: 333 }) },
    ]);

    const scaled = await service.actuals(budget.id, { percent: 10, sourceFiscalYearId: previous.id });
    expect(scaled.lines.map((l) => [l.accountNumber, l.amounts[1], l.amounts[2], l.amounts[3]])).toEqual([
      ["3001", 1100, 0, -55],
      ["5010", 330, 220, 0],
      ["6110", 0, 367, 0],
    ]);

    const onWorkshop = await service.actuals(budget.id, { percent: 0, costCenterId: workshop.id });
    expect(onWorkshop.lines).toEqual([
      { accountNumber: "3001", accountName: "Försäljning inom Sverige 25 %", costCenterId: workshop.id, amounts: months(0, { 2: 1000 }) },
      { accountNumber: "5010", accountName: "Lokalhyra", costCenterId: workshop.id, amounts: months(0, { 3: 200 }) },
    ]);
    const none = await service.actuals(budget.id, { percent: 0, costCenterId: "none" });
    expect(none.lines.map((l) => [l.accountNumber, l.costCenterId, l.amounts[1], l.amounts[2], l.amounts[3]])).toEqual([
      ["3001", null, 0, 0, -50],
      ["5010", null, 300, 0, 0],
      ["6110", null, 0, 333, 0],
    ]);

    await expect(service.actuals(budget.id, { percent: 0, costCenterId: crypto.randomUUID() })).rejects.toBeInstanceOf(CostCenterNotFoundError);
    const onPrevious = await service.create({ fiscalYearId: previous.id, name: "Ingen föregångare" }, user.id);
    await expect(service.actuals(onPrevious.id, { percent: 0 })).rejects.toBeInstanceOf(BudgetNoPreviousYearError);
    expect((await service.actuals(onPrevious.id, { percent: 0, sourceFiscalYearId: year.id })).lines.map((l) => [l.accountNumber, l.amounts[0]])).toEqual([["5010", 9999]]);
  });

  it("maps a brutet år's actuals onto the budget's months by calendar month", async () => {
    const { user, book } = await setup();
    const broken = await economy.createFiscalYear({ label: "2028/29", startDate: "2028-05-01", endDate: "2029-04-30" });
    const budget = await service.create({ fiscalYearId: broken.id, name: "Brutet" }, user.id);
    await book(`${YEAR}-01-15`, [{ number: "5010", net: 100 }, { number: "1930", net: -100 }]);
    await book(`${YEAR}-05-15`, [{ number: "5010", net: 500 }, { number: "1930", net: -500 }]);
    const { lines } = await service.actuals(budget.id, { percent: 0 });
    expect(lines).toHaveLength(1);
    // Budget month 1 = May ← source May; budget month 9 = January ← source January.
    expect(lines[0]!.amounts).toEqual([500, 0, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0]);
  });
});

describe("resultaträkningen med budget", () => {
  async function fixture() {
    const f = await setup();
    const budget = await service.create({ fiscalYearId: f.year.id, name: "Huvudbudget" }, f.user.id);
    await service.replaceLines(budget.id, { costCenterId: null, lines: [{ accountNumber: "3001", amounts: months(1000) }, { accountNumber: "5010", amounts: months(200) }] }, f.user.id);
    await service.replaceLines(budget.id, { costCenterId: f.workshop.id, lines: [{ accountNumber: "3001", amounts: months(500) }] }, f.user.id);
    await f.book(`${YEAR}-01-10`, [{ number: "1930", net: 1800 }, { number: "3001", net: -1000, costCenterId: f.workshop.id }, { number: "3001", net: -800 }]);
    await f.book(`${YEAR}-01-20`, [{ number: "5010", net: 150 }, { number: "1930", net: -150 }]);
    await f.book(`${YEAR}-02-20`, [{ number: "5010", net: 100 }, { number: "1930", net: -100 }]);
    return { ...f, budget };
  }

  it("gives period and accumulated budget, variance and percent per account, line, subtotal and result", async () => {
    const { budget } = await fixture();
    const statement = await reports.getBudgetedIncomeStatement({ from: `${YEAR}-02-01`, to: `${YEAR}-02-28`, budgetId: budget.id });
    expect(statement.budget).toEqual({ id: budget.id, name: "Huvudbudget", fiscalYearId: expect.any(String) });
    expect(statement.accumulatedFrom).toBe(`${YEAR}-01-01`);

    const netSales = statement.entries.find((e) => e.key === "netSales")!;
    expect(netSales.kind).toBe("line");
    if (netSales.kind !== "line") throw new Error("unreachable");
    // Budgeted, no movement in February: shown with 0 — the whole company's
    // budget is every line (Ej fördelat 1000 + Verkstad 500).
    expect(netSales.accounts).toEqual([
      expect.objectContaining({ accountNumber: "3001", amount: 0, budget: 1500, variance: -1500, variancePercent: -100, accumulated: 1800, accumulatedBudget: 3000, accumulatedVariance: -1200, accumulatedVariancePercent: -40 }),
    ]);
    const external = statement.entries.find((e) => e.key === "otherExternalCosts")!;
    expect(external).toMatchObject({ total: -100, amount: -100, budget: -200, variance: 100, variancePercent: 50, accumulated: -250, accumulatedBudget: -400, accumulatedVariance: 150, accumulatedVariancePercent: 37.5 });
    expect(statement).toMatchObject({
      result: -100,
      resultBudget: 1300,
      resultVariance: -1400,
      resultVariancePercent: -107.7,
      resultAccumulated: 1550,
      resultAccumulatedBudget: 2600,
      resultAccumulatedVariance: -1050,
      resultAccumulatedVariancePercent: -40.4,
    });

    // Half of February: the budget month is apportioned by days.
    const half = await reports.getBudgetedIncomeStatement({ from: `${YEAR}-02-01`, to: `${YEAR}-02-14`, budgetId: budget.id });
    expect(half.entries.find((e) => e.key === "netSales")).toMatchObject({ budget: 750, accumulatedBudget: 2250 });

    // getIncomeStatement dispatches on budgetId; without it the shape is unchanged.
    const viaGeneric = await reports.getIncomeStatement({ from: `${YEAR}-02-01`, to: `${YEAR}-02-28`, budgetId: budget.id });
    expect("budget" in viaGeneric).toBe(true);
    const plain = await reports.getIncomeStatement({ from: `${YEAR}-02-01`, to: `${YEAR}-02-28` });
    expect("budget" in plain).toBe(false);
    expect(plain.entries.find((e) => e.key === "netSales")).toBeUndefined();
  });

  it("filters actuals AND budget lines on a cost center", async () => {
    const { budget, workshop } = await fixture();
    const statement = await reports.getBudgetedIncomeStatement({ from: `${YEAR}-01-01`, to: `${YEAR}-01-31`, budgetId: budget.id, costCenterId: workshop.id });
    expect(statement.entries.find((e) => e.key === "netSales")).toMatchObject({ amount: 1000, budget: 500, variance: 500, variancePercent: 100, accumulated: 1000, accumulatedBudget: 500 });
    // 5010 is neither booked nor budgeted on the workshop.
    expect(statement.entries.find((e) => e.key === "otherExternalCosts")).toBeUndefined();
    expect(statement.resultBudget).toBe(500);
  });

  it("refuses projectId/groupBy, a range outside the year and an unknown budget; the CSV and PDF carry the columns", async () => {
    const { budget, workshop } = await fixture();
    const base = { from: `${YEAR}-01-01`, to: `${YEAR}-01-31`, budgetId: budget.id };
    await expect(reports.getIncomeStatement({ ...base, projectId: crypto.randomUUID() })).rejects.toBeInstanceOf(BudgetNotCombinableError);
    await expect(reports.getIncomeStatement({ ...base, groupBy: "costCenter" })).rejects.toBeInstanceOf(BudgetNotCombinableError);
    await expect(reports.getIncomeStatement({ ...base, from: `${PREVIOUS}-12-01` })).rejects.toBeInstanceOf(BudgetRangeOutsideYearError);
    await expect(reports.getIncomeStatement({ ...base, to: `${YEAR + 1}-01-01` })).rejects.toBeInstanceOf(BudgetRangeOutsideYearError);
    await expect(reports.getIncomeStatement({ ...base, budgetId: crypto.randomUUID() })).rejects.toBeInstanceOf(BudgetNotFoundError);

    const csv = await reports.getIncomeStatementCsv({ ...base, costCenterId: workshop.id });
    const lines = csv.content.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Konto;Benämning;Utfall;Budget;Avvikelse;Avvikelse %;Utfall ack.;Budget ack.;Avvikelse ack.;Avvikelse ack. %");
    expect(lines[1]).toBe("3001;Försäljning inom Sverige 25 %;1000,00;500,00;500,00;100;1000,00;500,00;500,00;100");
    expect(csv.filename).toBe(`resultatrakning-${YEAR}-01-01--${YEAR}-01-31.csv`);
  });
});

describe("kostnadsställe — kopplingsflytt of budget lines", () => {
  it("counts the lines in the usage and sums colliding lines on the replacement (a zero sum removes the line)", async () => {
    const { user, year, workshop, assembly } = await setup();
    const budget = await service.create({ fiscalYearId: year.id, name: "B" }, user.id);
    await service.replaceLines(budget.id, { costCenterId: workshop.id, lines: [{ accountNumber: "3001", amounts: months(0, { 1: 100, 2: 50 }) }, { accountNumber: "4010", amounts: months(0, { 1: 10 }) }] }, user.id);
    await service.replaceLines(budget.id, { costCenterId: assembly.id, lines: [{ accountNumber: "3001", amounts: months(0, { 1: -100, 3: 70 }) }] }, user.id);

    const usage = await dimensions.costCenters.usage(workshop.id);
    expect(usage.references).toEqual([{ table: "budget_lines", label: "budgetrader", labelOne: "budgetrad", count: 3, blocksReplacement: false }]);

    const result = await dimensions.costCenters.remove(workshop.id, assembly.id, user.id);
    expect(result.moved).toEqual([{ table: "budget_lines", count: 3 }]);
    const detail = await service.get(budget.id);
    expect(detail.lines).toEqual([
      { accountNumber: "3001", accountName: expect.any(String), costCenterId: assembly.id, amounts: months(0, { 2: 50, 3: 70 }) },
      { accountNumber: "4010", accountName: expect.any(String), costCenterId: assembly.id, amounts: months(0, { 1: 10 }) },
    ]);
    expect(await db.select().from(budgetLines)).toHaveLength(3);
    expect(await db.select().from(budgets)).toHaveLength(1);
  });

  it("refuses to delete a cost center with budget lines and no replacement", async () => {
    const { user, year, workshop } = await setup();
    const budget = await service.create({ fiscalYearId: year.id, name: "B" }, user.id);
    await service.replaceLines(budget.id, { costCenterId: workshop.id, lines: [{ accountNumber: "3001", amounts: months(1) }] }, user.id);
    await expect(dimensions.costCenters.remove(workshop.id, null, user.id)).rejects.toMatchObject({ name: "RegisterEntryInUseError" });
    expect((await service.get(budget.id)).lines).toHaveLength(1);
  });
});
