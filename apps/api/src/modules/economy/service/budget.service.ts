import {
  round2,
  type BudgetActualsQuery,
  type BudgetCsvQuery,
  type CopyBudgetInput,
  type CreateBudgetInput,
  type ListBudgetsQuery,
  type ReplaceBudgetLinesInput,
  type UpdateBudgetInput,
} from "@navet/shared";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { parseCsvBuffer } from "../../import/service/csv.js";
import type { ActualsCostCenterFilter, BudgetFiscalYear, BudgetHeaderRow, BudgetLineRow, BudgetRepository } from "../repository/budget.repository.js";
import { budgetSign, calendarMonthMap, compareGridLines, isBudgetableAccount, type BudgetGridLine } from "./budget-calc.js";
import { buildBudgetCsv, parseBudgetCsv, type BudgetCsvParseResult } from "./budget-csv.js";
import { CostCenterNotFoundError } from "./dimension-check.js";
import { FiscalYearNotFoundError } from "./economy.service.js";

// Budget (bokföringsgranskningen etapp 5 del B): a budget per räkenskapsår
// with a grid of (account × period) per cost center. Planning data, not
// räkenskapsinformation — nothing here minds closed years or locked
// periods. The arithmetic lives in budget-calc.ts / budget-csv.ts (pure);
// this file validates, orchestrates and shapes the responses of the
// contract (private/superpowers/specs/2026-10-25-etapp5b-kontrakt.md).

export class BudgetNotFoundError extends Error {
  constructor(id: string) {
    super(`Budget ${id} not found`);
    this.name = "BudgetNotFoundError";
  }
}

export class BudgetNameTakenError extends Error {
  constructor(name: string) {
    super(`Det finns redan en budget med namnet "${name}" för räkenskapsåret`);
    this.name = "BudgetNameTakenError";
  }
}

// Accounts the chart lacks or that lie outside class 3–8 / inside 8990–8999.
export class BudgetAccountInvalidError extends Error {
  constructor(public readonly accounts: string[]) {
    super(`Kontot ${accounts.join(", ")} kan inte budgeteras`);
    this.name = "BudgetAccountInvalidError";
  }
}

export class BudgetMonthInvalidError extends Error {
  constructor(expected: number, got: number) {
    super(`Budgeten har ${got} månader men räkenskapsåret ${expected}`);
    this.name = "BudgetMonthInvalidError";
  }
}

export class BudgetDuplicateAccountError extends Error {
  constructor(accountNumber: string) {
    super(`Kontot ${accountNumber} förekommer flera gånger`);
    this.name = "BudgetDuplicateAccountError";
  }
}

export class BudgetNoPreviousYearError extends Error {
  constructor(label: string) {
    super(`Det finns inget räkenskapsår före ${label}`);
    this.name = "BudgetNoPreviousYearError";
  }
}

export interface BudgetMonth {
  month: number;
  startDate: string;
  endDate: string;
  // "YYYY-MM" of the period's start.
  label: string;
}

export interface BudgetSummary {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  name: string;
  isDefault: boolean;
  // Natural sign, over every line (all cost centers and Ej fördelat).
  revenue: number;
  costs: number;
  result: number;
  updatedAt: Date;
}

export interface BudgetDetail {
  id: string;
  fiscalYearId: string;
  fiscalYearLabel: string;
  fiscalYearStart: string;
  fiscalYearEnd: string;
  name: string;
  isDefault: boolean;
  months: BudgetMonth[];
  lines: BudgetGridLine[];
}

export function budgetMonthsOf(year: BudgetFiscalYear): BudgetMonth[] {
  return year.periods.map((period, index) => ({ month: index + 1, startDate: period.startDate, endDate: period.endDate, label: period.startDate.slice(0, 7) }));
}

// Lines → grid rows: one per (account, cost center) with an amount per
// period, in grid order.
export function gridLinesOf(rows: BudgetLineRow[], monthCount: number): (BudgetGridLine & { costCenterCode: string | null })[] {
  const byKey = new Map<string, BudgetGridLine & { costCenterCode: string | null }>();
  for (const row of rows) {
    if (row.month < 1 || row.month > monthCount) continue;
    const key = `${row.accountNumber}|${row.costCenterId ?? ""}`;
    let line = byKey.get(key);
    if (!line) {
      line = { accountNumber: row.accountNumber, accountName: row.accountName, costCenterId: row.costCenterId, costCenterCode: row.costCenterCode, amounts: Array<number>(monthCount).fill(0) };
      byKey.set(key, line);
    }
    line.amounts[row.month - 1] = round2((line.amounts[row.month - 1] ?? 0) + row.amount);
  }
  return [...byKey.values()].sort(compareGridLines);
}

function costCenterFilterOf(costCenterId: string | undefined): ActualsCostCenterFilter {
  if (costCenterId === undefined) return "all";
  if (costCenterId === "none") return "none";
  return { id: costCenterId };
}

export function createBudgetService(deps: { repo: BudgetRepository; audit: AuditWriter }) {
  const { repo, audit } = deps;

  async function requireHeader(id: string): Promise<BudgetHeaderRow> {
    const head = await repo.findHeader(id);
    if (!head) throw new BudgetNotFoundError(id);
    return head;
  }

  async function requireFiscalYear(id: string): Promise<BudgetFiscalYear> {
    const year = await repo.findFiscalYear(id);
    if (!year) throw new FiscalYearNotFoundError(id);
    return year;
  }

  async function detail(id: string): Promise<BudgetDetail> {
    const head = await requireHeader(id);
    const year = await requireFiscalYear(head.fiscalYearId);
    const months = budgetMonthsOf(year);
    const lines = gridLinesOf(await repo.findLines(id), months.length).map(({ costCenterCode: _code, ...line }) => line);
    return {
      id: head.id,
      fiscalYearId: head.fiscalYearId,
      fiscalYearLabel: year.label,
      fiscalYearStart: year.startDate,
      fiscalYearEnd: year.endDate,
      name: head.name,
      isDefault: head.isDefault,
      months,
      lines,
    };
  }

  // A cost center on a PUT/actuals/CSV must exist; inactive is fine (the
  // budget is a plan, not a booking).
  async function requireCostCenter(id: string) {
    const costCenter = await repo.findCostCenter(id);
    if (!costCenter) throw new CostCenterNotFoundError(id);
    return costCenter;
  }

  function withNameTaken<T>(name: string, run: () => Promise<T>): Promise<T> {
    return run().catch((err: unknown) => {
      if (isUniqueViolation(err, "budgets_year_name_unique")) throw new BudgetNameTakenError(name);
      throw err;
    });
  }

  const service = {
    async list(query: ListBudgetsQuery): Promise<{ rows: BudgetSummary[]; total: number }> {
      const heads = await repo.listHeaders(query.fiscalYearId);
      const sums = await repo.sumsByBudget(heads.map((head) => head.id));
      const totals = new Map<string, { revenue: number; costs: number }>();
      for (const sum of sums) {
        const current = totals.get(sum.budgetId) ?? { revenue: 0, costs: 0 };
        if (budgetSign(sum.accountNumber) === 1) current.revenue = round2(current.revenue + sum.amount);
        else current.costs = round2(current.costs + sum.amount);
        totals.set(sum.budgetId, current);
      }
      const rows = heads.map((head): BudgetSummary => {
        const total = totals.get(head.id) ?? { revenue: 0, costs: 0 };
        return {
          id: head.id,
          fiscalYearId: head.fiscalYearId,
          fiscalYearLabel: head.fiscalYearLabel,
          name: head.name,
          isDefault: head.isDefault,
          revenue: total.revenue,
          costs: total.costs,
          result: round2(total.revenue - total.costs),
          updatedAt: head.updatedAt,
        };
      });
      return { rows, total: rows.length };
    },

    get: detail,

    async create(input: CreateBudgetInput, userId: string | null): Promise<BudgetDetail> {
      await requireFiscalYear(input.fiscalYearId);
      const id = await withNameTaken(input.name, () => repo.create({ fiscalYearId: input.fiscalYearId, name: input.name, createdBy: userId }));
      if (!id) throw new FiscalYearNotFoundError(input.fiscalYearId);
      await audit.log({ entityType: "budget", entityId: id, action: "created", detail: { name: input.name }, userId });
      return detail(id);
    },

    async update(id: string, input: UpdateBudgetInput, userId: string | null): Promise<BudgetDetail> {
      await requireHeader(id);
      const updated = await withNameTaken(input.name ?? "", () => repo.update(id, input));
      if (!updated) throw new BudgetNotFoundError(id);
      await audit.log({ entityType: "budget", entityId: id, action: "updated", detail: { fields: Object.keys(input) }, userId });
      return detail(id);
    },

    async delete(id: string, userId: string | null): Promise<void> {
      const head = await requireHeader(id);
      if (!(await repo.delete(id))) throw new BudgetNotFoundError(id);
      await audit.log({ entityType: "budget", entityId: id, action: "deleted", detail: { name: head.name }, userId });
    },

    // Spara: replaces the lines of ONE cost center (null = Ej fördelat).
    async replaceLines(id: string, input: ReplaceBudgetLinesInput, userId: string | null): Promise<BudgetDetail> {
      const head = await requireHeader(id);
      const year = await requireFiscalYear(head.fiscalYearId);
      const monthCount = year.periods.length;
      if (input.costCenterId !== null) await requireCostCenter(input.costCenterId);

      const seen = new Set<string>();
      for (const line of input.lines) {
        if (line.amounts.length !== monthCount) throw new BudgetMonthInvalidError(monthCount, line.amounts.length);
        if (seen.has(line.accountNumber)) throw new BudgetDuplicateAccountError(line.accountNumber);
        seen.add(line.accountNumber);
      }
      const known = await repo.accountsByNumber(seen);
      const invalid = [...seen].filter((number) => !isBudgetableAccount(number) || !known.has(number)).sort();
      if (invalid.length > 0) throw new BudgetAccountInvalidError(invalid);

      const rows = input.lines.flatMap((line) =>
        line.amounts.map((amount, index) => ({ accountNumber: line.accountNumber, month: index + 1, amount: round2(amount) })).filter((row) => row.amount !== 0)
      );
      if (!(await repo.replaceLines(id, input.costCenterId, rows))) throw new BudgetNotFoundError(id);
      await audit.log({ entityType: "budget", entityId: id, action: "updated", detail: { lines: rows.length, costCenterId: input.costCenterId }, userId });
      return detail(id);
    },

    // Kopiera budget: every line, month by ordinal; months beyond the
    // target year's period count are dropped and counted.
    async copy(id: string, input: CopyBudgetInput, userId: string | null): Promise<BudgetDetail & { droppedMonths: number }> {
      await requireHeader(id);
      const target = await requireFiscalYear(input.fiscalYearId);
      const result = await withNameTaken(input.name, () => repo.copy(id, { fiscalYearId: input.fiscalYearId, name: input.name, createdBy: userId }, target.periods.length));
      if (!result) throw new FiscalYearNotFoundError(input.fiscalYearId);
      await audit.log({ entityType: "budget", entityId: result.id, action: "created", detail: { name: input.name, copiedFrom: id, droppedMonths: result.droppedMonths }, userId });
      return { ...(await detail(result.id)), droppedMonths: result.droppedMonths };
    },

    // Kopiera utfall från föregående år: the source year's booked actuals
    // per budgetable account and period, natural sign, × (1 + percent/100),
    // whole kronor, mapped onto the budget's months by calendar month.
    // Saves nothing.
    async actuals(id: string, query: BudgetActualsQuery): Promise<{ lines: BudgetGridLine[] }> {
      const head = await requireHeader(id);
      const year = await requireFiscalYear(head.fiscalYearId);
      let source: BudgetFiscalYear;
      if (query.sourceFiscalYearId) source = await requireFiscalYear(query.sourceFiscalYearId);
      else {
        const previous = await repo.findPreviousFiscalYear(year.startDate);
        if (!previous) throw new BudgetNoPreviousYearError(year.label);
        source = previous;
      }
      const filter = costCenterFilterOf(query.costCenterId);
      if (filter !== "all" && filter !== "none") await requireCostCenter(filter.id);
      const costCenterId = filter === "all" || filter === "none" ? null : filter.id;

      const rows = await repo.actuals(source.id, filter);
      const sourceOrdinal = new Map(source.periods.map((period, index) => [period.startDate, index + 1] as const));
      const monthMap = calendarMonthMap(source.periods, year.periods);
      const factor = 1 + query.percent / 100;

      const byAccount = new Map<string, Map<number, number>>();
      for (const row of rows) {
        if (!isBudgetableAccount(row.accountNumber)) continue;
        const ordinal = sourceOrdinal.get(row.periodStart);
        if (ordinal === undefined) continue;
        const perPeriod = byAccount.get(row.accountNumber) ?? new Map<number, number>();
        perPeriod.set(ordinal, (perPeriod.get(ordinal) ?? 0) + (row.credit - row.debit) * budgetSign(row.accountNumber));
        byAccount.set(row.accountNumber, perPeriod);
      }
      const names = await repo.accountsByNumber(byAccount.keys());
      const lines: BudgetGridLine[] = [];
      for (const accountNumber of [...byAccount.keys()].sort()) {
        const perPeriod = byAccount.get(accountNumber)!;
        const amounts = year.periods.map((_, index) => {
          const from = monthMap.get(index + 1);
          const natural = from === undefined ? 0 : (perPeriod.get(from) ?? 0);
          return Math.round(natural * factor);
        });
        if (amounts.every((amount) => amount === 0)) continue;
        lines.push({ accountNumber, accountName: names.get(accountNumber)?.accountName ?? null, costCenterId, amounts });
      }
      return { lines };
    },

    // Exportera CSV: omitted = every line, "none" = Ej fördelat, id = that
    // cost center.
    async csv(id: string, query: BudgetCsvQuery): Promise<{ filename: string; content: string }> {
      const head = await requireHeader(id);
      const year = await requireFiscalYear(head.fiscalYearId);
      const filter = costCenterFilterOf(query.costCenterId);
      if (filter !== "all" && filter !== "none") await requireCostCenter(filter.id);
      const months = budgetMonthsOf(year);
      const lines = gridLinesOf(await repo.findLines(id), months.length).filter((line) => {
        if (filter === "all") return true;
        if (filter === "none") return line.costCenterId === null;
        return line.costCenterId === filter.id;
      });
      const safeName = head.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").toLowerCase();
      return { filename: `budget-${year.label}-${safeName}.csv`, content: buildBudgetCsv(months.map((month) => month.label), lines) };
    },

    // Importera CSV: parses into grid lines for the web to fill the grid
    // with; nothing is saved. File-level problems throw ImportFileError
    // (400 in the route); row-level ones come back in `errors`.
    async parseCsv(id: string, file: Buffer): Promise<BudgetCsvParseResult> {
      const head = await requireHeader(id);
      const year = await requireFiscalYear(head.fiscalYearId);
      const { headers, rows } = parseCsvBuffer(file);
      const [accountNames, costCenters] = await Promise.all([repo.budgetableAccountNames(), repo.listCostCenters()]);
      const byCode = new Map(costCenters.map((costCenter) => [costCenter.code, costCenter.id] as const));
      const byId = new Map(costCenters.map((costCenter) => [costCenter.id, costCenter.code] as const));
      return parseBudgetCsv([headers, ...rows], year.periods.length, {
        accountName: (number) => accountNames.get(number) ?? null,
        costCenterId: (code) => byCode.get(code) ?? null,
        costCenterCode: (costCenterId) => byId.get(costCenterId) ?? null,
      });
    },
  };

  return service;
}

export type BudgetService = ReturnType<typeof createBudgetService>;
