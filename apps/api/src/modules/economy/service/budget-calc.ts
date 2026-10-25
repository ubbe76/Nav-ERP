// Budget (bokföringsgranskningen etapp 5 del B): the pure rules every budget
// reader shares — the sign of a budget amount, which accounts can be
// budgeted, how a budget month is apportioned over a report period, how a
// source year's periods map onto a target year's (Kopiera utfall), and the
// budgeted income statement builder. No database, no imports beyond the BAS
// line table and round2, so all of it is unit-testable in milliseconds —
// and there is exactly ONE implementation of each rule (CLAUDE.md: rena
// beräkningsfiler), used by the reports, the grid, Kopiera utfall and CSV.
import { round2 } from "@navet/shared";
import { INCOME_STATEMENT_ENTRIES, classifyAccount } from "./bas-report-lines.js";

// `budget_lines.amount` carries the account's NATURAL sign: positive = normal
// revenue on a revenue account, positive = normal cost on a cost account. The
// nature follows the income statement's line: these three lines are revenue,
// everything else in class 3–8 is cost. budgetSign turns a natural amount
// credit-positive (amount × sign), which is how the reports read.
export const BUDGET_REVENUE_LINE_KEYS: ReadonlySet<string> = new Set(["netSales", "otherOperatingIncome", "financialIncome"]);

export function budgetSign(accountNumber: string): 1 | -1 {
  const classification = classifyAccount(accountNumber);
  return classification.report === "incomeStatement" && BUDGET_REVENUE_LINE_KEYS.has(classification.lineKey) ? 1 : -1;
}

// Budgetable: class 3–8 except 8990–8999 (the booked year result).
export function isBudgetableAccount(accountNumber: string): boolean {
  if (!/^[3-8][0-9]{3}$/.test(accountNumber)) return false;
  return !(accountNumber >= "8990" && accountNumber <= "8999");
}

// A fiscal year's period (accounting_periods), YYYY-MM-DD inclusive at both
// ends. Index + 1 in the year's ordered list is the budget `month`.
export interface BudgetPeriod {
  startDate: string;
  endDate: string;
}

function dayNumber(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Math.round(Date.UTC(year!, month! - 1, day!) / 86_400_000);
}

// Inclusive day count of [from, to]; 0 when to < from.
export function inclusiveDays(from: string, to: string): number {
  const n = dayNumber(to) - dayNumber(from) + 1;
  return n > 0 ? n : 0;
}

// The share of a budget period that falls inside [from, to]: overlap days /
// period days. 1 for a whole month, 0 when the ranges do not meet.
export function periodShare(period: BudgetPeriod, from: string, to: string): number {
  const start = period.startDate > from ? period.startDate : from;
  const end = period.endDate < to ? period.endDate : to;
  const overlap = inclusiveDays(start, end);
  if (overlap === 0) return 0;
  return overlap / inclusiveDays(period.startDate, period.endDate);
}

export interface BudgetLineAmount {
  accountNumber: string;
  // 1-based period ordinal in the fiscal year.
  month: number;
  // Natural sign.
  amount: number;
}

// Periodens budget per account, CREDIT-POSITIVE, for the report window
// [from, to]: every budget month contributes amount × its share of the
// window, summed and round2:ed per account. Months outside the year's period
// list contribute nothing.
export function budgetedAmounts(lines: BudgetLineAmount[], periods: BudgetPeriod[], from: string, to: string): Map<string, number> {
  const shares = periods.map((period) => periodShare(period, from, to));
  const sums = new Map<string, number>();
  for (const line of lines) {
    const share = shares[line.month - 1];
    if (!share) continue;
    sums.set(line.accountNumber, (sums.get(line.accountNumber) ?? 0) + line.amount * budgetSign(line.accountNumber) * share);
  }
  return new Map([...sums].map(([account, sum]) => [account, round2(sum)]));
}

// Kopiera utfall: which SOURCE period feeds each TARGET month, matched on
// calendar month (the MM of the period's start date). Keys are 1-based
// target ordinals, values 1-based source ordinals. A source year with two
// periods of the same MM (a long first year) contributes the LATER one; a
// target month with no source counterpart is absent from the map.
export function calendarMonthMap(source: BudgetPeriod[], target: BudgetPeriod[]): Map<number, number> {
  const sourceByMonth = new Map<string, number>();
  source.forEach((period, index) => sourceByMonth.set(period.startDate.slice(5, 7), index + 1));
  const map = new Map<number, number>();
  target.forEach((period, index) => {
    const ordinal = sourceByMonth.get(period.startDate.slice(5, 7));
    if (ordinal !== undefined && !map.has(index + 1)) map.set(index + 1, ordinal);
  });
  return map;
}

// One row of the budget grid (GET /budgets/:id, PUT, actuals, CSV): one
// account on one cost center (null = Ej fördelat) with an amount per period
// of the year, natural sign, 0 where the budget has no line.
export interface BudgetGridLine {
  accountNumber: string;
  accountName: string | null;
  costCenterId: string | null;
  amounts: number[];
}

// Grid order: account number, then the cost center's code with null first.
export function compareGridLines(a: { accountNumber: string; costCenterCode: string | null }, b: { accountNumber: string; costCenterCode: string | null }): number {
  if (a.accountNumber !== b.accountNumber) return a.accountNumber < b.accountNumber ? -1 : 1;
  if (a.costCenterCode === b.costCenterCode) return 0;
  if (a.costCenterCode === null) return -1;
  if (b.costCenterCode === null) return 1;
  return a.costCenterCode.localeCompare(b.costCenterCode, "sv");
}

// --- Resultaträkningen med budget ---

// Period sums per account as account-balances.ts reads them (the opening
// columns are irrelevant here).
export interface BudgetedBalanceInput {
  accountId: string;
  accountNumber: string;
  accountName: string;
  periodDebit: number;
  periodCredit: number;
}

export interface BudgetedFigures {
  // The period: actual (credit-positive), budget, variance = actual − budget
  // (positive = better than budget for revenue and cost alike), and the
  // variance in percent of |budget| (one decimal, null when budget is 0).
  amount: number;
  budget: number;
  variance: number;
  variancePercent: number | null;
  // From the fiscal year's start through `to`.
  accumulated: number;
  accumulatedBudget: number;
  accumulatedVariance: number;
  accumulatedVariancePercent: number | null;
}

export interface BudgetedReportAccount extends BudgetedFigures {
  accountId: string;
  accountNumber: string;
  accountName: string;
}

export type BudgetedIncomeStatementEntry =
  | ({ kind: "line"; key: string; label: string; accounts: BudgetedReportAccount[]; total: number } & BudgetedFigures)
  | ({ kind: "subtotal"; key: string; label: string; total: number } & BudgetedFigures);

export interface BudgetedIncomeStatementBody {
  entries: BudgetedIncomeStatementEntry[];
  result: number;
  resultBudget: number;
  resultVariance: number;
  resultVariancePercent: number | null;
  resultAccumulated: number;
  resultAccumulatedBudget: number;
  resultAccumulatedVariance: number;
  resultAccumulatedVariancePercent: number | null;
}

export interface BudgetedIncomeStatementInput {
  period: BudgetedBalanceInput[];
  accumulated: BudgetedBalanceInput[];
  // Credit-positive per account number (budgetedAmounts).
  periodBudget: Map<string, number>;
  accumulatedBudget: Map<string, number>;
  // Names for the accounts that only the budget knows (no movement).
  accounts: Map<string, { accountId: string; accountName: string }>;
}

export function variancePercentOf(variance: number, budget: number): number | null {
  if (budget === 0) return null;
  return Math.round((variance / Math.abs(budget)) * 1000) / 10;
}

function figures(amount: number, budget: number, accumulated: number, accumulatedBudget: number): BudgetedFigures {
  const variance = round2(amount - budget);
  const accumulatedVariance = round2(accumulated - accumulatedBudget);
  return {
    amount,
    budget,
    variance,
    variancePercent: variancePercentOf(variance, budget),
    accumulated,
    accumulatedBudget,
    accumulatedVariance,
    accumulatedVariancePercent: variancePercentOf(accumulatedVariance, accumulatedBudget),
  };
}

// Same layout and running subtotals as buildIncomeStatement, with four
// measures side by side. An account is listed when ANY of them is non-zero —
// a budgeted account without movement shows with actual 0, an account with
// movement but no budget with budget 0.
export function buildBudgetedIncomeStatement(input: BudgetedIncomeStatementInput): BudgetedIncomeStatementBody {
  const names = new Map<string, { accountId: string; accountName: string }>(input.accounts);
  const periodActual = new Map<string, number>();
  const accumulatedActual = new Map<string, number>();
  const collect = (balances: BudgetedBalanceInput[], into: Map<string, number>) => {
    for (const balance of balances) {
      if (classifyAccount(balance.accountNumber).report !== "incomeStatement") continue;
      names.set(balance.accountNumber, { accountId: balance.accountId, accountName: balance.accountName });
      into.set(balance.accountNumber, round2(balance.periodCredit - balance.periodDebit));
    }
  };
  collect(input.period, periodActual);
  collect(input.accumulated, accumulatedActual);

  const numbers = new Set<string>([...periodActual.keys(), ...accumulatedActual.keys(), ...input.periodBudget.keys(), ...input.accumulatedBudget.keys()]);
  const accountsByLine = new Map<string, BudgetedReportAccount[]>();
  for (const accountNumber of [...numbers].sort()) {
    const classification = classifyAccount(accountNumber);
    if (classification.report !== "incomeStatement") continue;
    const amount = periodActual.get(accountNumber) ?? 0;
    const budget = input.periodBudget.get(accountNumber) ?? 0;
    const accumulated = accumulatedActual.get(accountNumber) ?? 0;
    const accumulatedBudget = input.accumulatedBudget.get(accountNumber) ?? 0;
    if (amount === 0 && budget === 0 && accumulated === 0 && accumulatedBudget === 0) continue;
    const name = names.get(accountNumber);
    const list = accountsByLine.get(classification.lineKey) ?? [];
    list.push({
      // An account the chart has lost since the budget was saved keeps its
      // number as the id — the reports never write, so nothing dereferences it.
      accountId: name?.accountId ?? accountNumber,
      accountNumber,
      accountName: name?.accountName ?? "",
      ...figures(amount, budget, accumulated, accumulatedBudget),
    });
    accountsByLine.set(classification.lineKey, list);
  }

  const entries: BudgetedIncomeStatementEntry[] = [];
  const running = { amount: 0, budget: 0, accumulated: 0, accumulatedBudget: 0 };
  for (const entryDef of INCOME_STATEMENT_ENTRIES) {
    if (entryDef.kind === "subtotal") {
      entries.push({
        kind: "subtotal",
        key: entryDef.key,
        label: entryDef.label,
        total: running.amount,
        ...figures(running.amount, running.budget, running.accumulated, running.accumulatedBudget),
      });
      continue;
    }
    const lineAccounts = accountsByLine.get(entryDef.key);
    if (!lineAccounts || lineAccounts.length === 0) continue;
    const sum = (pick: (account: BudgetedReportAccount) => number) => lineAccounts.reduce((total, account) => round2(total + pick(account)), 0);
    const line = {
      amount: sum((a) => a.amount),
      budget: sum((a) => a.budget),
      accumulated: sum((a) => a.accumulated),
      accumulatedBudget: sum((a) => a.accumulatedBudget),
    };
    running.amount = round2(running.amount + line.amount);
    running.budget = round2(running.budget + line.budget);
    running.accumulated = round2(running.accumulated + line.accumulated);
    running.accumulatedBudget = round2(running.accumulatedBudget + line.accumulatedBudget);
    entries.push({
      kind: "line",
      key: entryDef.key,
      label: entryDef.label,
      accounts: lineAccounts,
      total: line.amount,
      ...figures(line.amount, line.budget, line.accumulated, line.accumulatedBudget),
    });
  }

  const result = figures(running.amount, running.budget, running.accumulated, running.accumulatedBudget);
  return {
    entries,
    result: result.amount,
    resultBudget: result.budget,
    resultVariance: result.variance,
    resultVariancePercent: result.variancePercent,
    resultAccumulated: result.accumulated,
    resultAccumulatedBudget: result.accumulatedBudget,
    resultAccumulatedVariance: result.accumulatedVariance,
    resultAccumulatedVariancePercent: result.accumulatedVariancePercent,
  };
}
