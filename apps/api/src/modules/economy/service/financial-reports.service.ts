// Balansräkning + resultaträkning (B6a). The builders are pure and exported
// so the whole classification and all arithmetic is unit-testable without a
// database — same split as vat-report.service.ts's bucketMovements.
import { round2, type DimensionRef, type IncomeStatementGroupBy } from "@navet/shared";
import type { Db } from "@navet/db";
import {
  readAccountBalances,
  readAccountBalancesGrouped,
  type AccountBalance,
  type DimensionFilter,
  type GroupedAccountBalance,
} from "./account-balances.js";
import { dimensionText, loadDimensionRefs } from "./dimension-check.js";
import { displayNumber } from "./economy.service.js";
import { formatNumber } from "../../mail/service/document-pdf.js";
import {
  buildBalanceSheetCsv,
  buildBudgetedIncomeStatementCsv,
  buildGeneralLedgerCsv,
  buildGroupedIncomeStatementCsv,
  buildIncomeStatementCsv,
  buildVerificationListCsv,
} from "./financial-reports-csv.js";
import { budgetedAmounts, buildBudgetedIncomeStatement, type BudgetedIncomeStatementBody } from "./budget-calc.js";
import { BudgetNotFoundError } from "./budget.service.js";
import type { BudgetReportSource } from "../repository/budget.repository.js";
import type {
  FinancialStatementPdfInput,
  GeneralLedgerPdfInput,
  VerificationListPdfInput,
} from "../../mail/service/document-pdf.js";
import {
  BALANCE_SHEET_GROUPS,
  INCOME_STATEMENT_ENTRIES,
  classifyAccount,
} from "./bas-report-lines.js";

export class ReportFiscalYearNotFoundError extends Error {
  constructor(date: string) {
    super(`Inget räkenskapsår täcker datumet ${date}`);
    this.name = "ReportFiscalYearNotFoundError";
  }
}

// Budget on the income statement: never together with a project filter or
// Per kostnadsställe/Per projekt (project budgets and budget per column are
// outside v1).
export class BudgetNotCombinableError extends Error {
  constructor() {
    super("Budget kan inte kombineras med projekt eller gruppering");
    this.name = "BudgetNotCombinableError";
  }
}

export class BudgetRangeOutsideYearError extends Error {
  constructor(from: string, to: string, label: string) {
    super(`Perioden ${from} – ${to} ligger utanför budgetens räkenskapsår ${label}`);
    this.name = "BudgetRangeOutsideYearError";
  }
}

export interface ReportAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  amount: number;
  // Resultaträkningen per objekt: the amount per column (column order).
  amounts?: number[];
}

export interface BalanceSheetLine {
  key: string;
  label: string;
  computed: boolean;
  accounts: ReportAccount[];
  total: number;
}

export interface BalanceSheetGroup {
  key: string;
  label: string;
  lines: BalanceSheetLine[];
  total: number;
}

export interface BalanceSheetBody {
  assets: { groups: BalanceSheetGroup[]; total: number };
  equityAndLiabilities: { groups: BalanceSheetGroup[]; total: number };
  // Always 0 — double-entry guarantees it. Surfaced so the UI can shout if a
  // future change ever breaks the invariant.
  difference: number;
}

export type IncomeStatementEntry =
  | { kind: "line"; key: string; label: string; accounts: ReportAccount[]; total: number; amounts?: number[] }
  | { kind: "subtotal"; key: string; label: string; total: number; amounts?: number[] };

// One column of Per kostnadsställe / Per projekt: an object, or the rows
// without one (id and code null, name "Utan").
export interface IncomeStatementColumn {
  id: string | null;
  code: string | null;
  name: string;
}

export const WITHOUT_OBJECT_LABEL = "Utan";

export interface IncomeStatementBody {
  entries: IncomeStatementEntry[];
  result: number;
  columns?: IncomeStatementColumn[];
}

// Why this balances without a bokslut: double-entry gives
//   Σ_all(D−C) = 0
//   ⟺ Σ_{class 0,1,9}(D−C) = Σ_{class 2}(C−D) + Σ_{class 3-8}(C−D)
//      └── assets ────────┘   └─ equity+liab ┘   └──── result ────┘
// so presenting the class 3–8 net as two computed equity lines makes
// Tillgångar = Eget kapital + Skulder exact. The split into retained/current
// also keeps the report correct if someone DOES book a closing entry
// (8999 → 2099): class 3–8 then nets to zero for the year, Årets resultat
// becomes 0, and the result shows up on 2099 under Fritt eget kapital.
export function buildBalanceSheet(balances: AccountBalance[]): BalanceSheetBody {
  const accountsByLine = new Map<string, ReportAccount[]>();
  let retainedResult = 0;
  let yearResult = 0;

  for (const balance of balances) {
    const classification = classifyAccount(balance.accountNumber);

    if (classification.report === "incomeStatement") {
      // Credit-positive: a profit is a credit balance on class 3–8.
      retainedResult = round2(retainedResult + (balance.openingCredit - balance.openingDebit));
      yearResult = round2(yearResult + (balance.periodCredit - balance.periodDebit));
      continue;
    }

    const debit = balance.openingDebit + balance.periodDebit;
    const credit = balance.openingCredit + balance.periodCredit;
    const amount = round2(
      classification.section === "assets" ? debit - credit : credit - debit
    );
    if (amount === 0) continue;

    const existing = accountsByLine.get(classification.lineKey) ?? [];
    existing.push({
      accountId: balance.accountId,
      accountNumber: balance.accountNumber,
      accountName: balance.accountName,
      amount,
    });
    accountsByLine.set(classification.lineKey, existing);
  }

  const sections = { assets: [] as BalanceSheetGroup[], equityAndLiabilities: [] as BalanceSheetGroup[] };

  for (const groupDef of BALANCE_SHEET_GROUPS) {
    const lines: BalanceSheetLine[] = [];

    for (const lineDef of groupDef.lines) {
      if (lineDef.computed) {
        // Rendered even at zero: "Årets resultat: 0,00" is information.
        const total = lineDef.key === "retainedResult" ? retainedResult : yearResult;
        lines.push({ key: lineDef.key, label: lineDef.label, computed: true, accounts: [], total });
        continue;
      }
      const lineAccounts = accountsByLine.get(lineDef.key);
      if (!lineAccounts || lineAccounts.length === 0) continue;
      const total = lineAccounts.reduce((sum, account) => round2(sum + account.amount), 0);
      lines.push({
        key: lineDef.key,
        label: lineDef.label,
        computed: false,
        accounts: lineAccounts,
        total,
      });
    }

    if (lines.length === 0) continue;
    const groupTotal = lines.reduce((sum, line) => round2(sum + line.total), 0);
    sections[groupDef.section].push({
      key: groupDef.key,
      label: groupDef.label,
      lines,
      total: groupTotal,
    });
  }

  const assetsTotal = sections.assets.reduce((sum, group) => round2(sum + group.total), 0);
  const equityTotal = sections.equityAndLiabilities.reduce((sum, group) => round2(sum + group.total), 0);

  return {
    assets: { groups: sections.assets, total: assetsTotal },
    equityAndLiabilities: { groups: sections.equityAndLiabilities, total: equityTotal },
    difference: round2(assetsTotal - equityTotal),
  };
}

// Credit-positive throughout: revenue positive, costs negative, so the
// running subtotal reads directly as the result and no per-row sign flag is
// needed. Uses ONLY the period window — class 3–8 is never closed, so
// accumulating would make year 2 show year 1's revenue.
export function buildIncomeStatement(balances: AccountBalance[]): IncomeStatementBody {
  const accountsByLine = new Map<string, ReportAccount[]>();

  for (const balance of balances) {
    const classification = classifyAccount(balance.accountNumber);
    if (classification.report !== "incomeStatement") continue;

    const amount = round2(balance.periodCredit - balance.periodDebit);
    if (amount === 0) continue;

    const existing = accountsByLine.get(classification.lineKey) ?? [];
    existing.push({
      accountId: balance.accountId,
      accountNumber: balance.accountNumber,
      accountName: balance.accountName,
      amount,
    });
    accountsByLine.set(classification.lineKey, existing);
  }

  const entries: IncomeStatementEntry[] = [];
  let running = 0;

  for (const entryDef of INCOME_STATEMENT_ENTRIES) {
    if (entryDef.kind === "subtotal") {
      entries.push({ kind: "subtotal", key: entryDef.key, label: entryDef.label, total: running });
      continue;
    }
    const lineAccounts = accountsByLine.get(entryDef.key);
    if (!lineAccounts || lineAccounts.length === 0) continue;
    const total = lineAccounts.reduce((sum, account) => round2(sum + account.amount), 0);
    running = round2(running + total);
    entries.push({
      kind: "line",
      key: entryDef.key,
      label: entryDef.label,
      accounts: lineAccounts,
      total,
    });
  }

  return { entries, result: running };
}

// Resultaträkningen per objekt (pure): one income statement per column plus
// the total — the total is buildIncomeStatement over the summed balances, so
// it equals the ungrouped report exactly, and every line/subtotal/account
// gets `amounts` in column order (0 where the column has nothing). Columns:
// the objects with movement, in the caller's order, then "Utan" when some
// rows carry none.
// A grouped balance that puts something on the income statement: a result
// account with movement in the period.
export function hasResultMovement(balance: GroupedAccountBalance): boolean {
  return classifyAccount(balance.accountNumber).report === "incomeStatement" && (balance.periodDebit !== 0 || balance.periodCredit !== 0);
}

export function buildGroupedIncomeStatement(
  balances: GroupedAccountBalance[],
  objects: DimensionRef[]
): IncomeStatementBody & { columns: IncomeStatementColumn[] } {
  // Only the result accounts count, for the objects and for "Utan" alike —
  // a bank row without an object is not an "Utan" column on the income
  // statement, and an object carried only by balance-sheet rows gets no
  // (empty) column of its own.
  const movingObjectIds = new Set(balances.filter(hasResultMovement).map((balance) => balance.objectId));
  const hasWithout = movingObjectIds.has(null);
  const columns: IncomeStatementColumn[] = [
    ...objects.filter((object) => movingObjectIds.has(object.id)).map((object) => ({ id: object.id, code: object.code, name: object.name })),
    ...(hasWithout ? [{ id: null, code: null, name: WITHOUT_OBJECT_LABEL }] : []),
  ];

  // Per account totals (the ungrouped figures) and per column.
  const totalsByAccount = new Map<string, AccountBalance>();
  const perColumn = columns.map(() => new Map<string, AccountBalance>());
  const columnIndex = new Map<string | null, number>(columns.map((column, index) => [column.id, index] as const));
  for (const balance of balances) {
    const add = (map: Map<string, AccountBalance>) => {
      const current = map.get(balance.accountId) ?? {
        accountId: balance.accountId,
        accountNumber: balance.accountNumber,
        accountName: balance.accountName,
        openingDebit: 0,
        openingCredit: 0,
        periodDebit: 0,
        periodCredit: 0,
      };
      map.set(balance.accountId, {
        ...current,
        openingDebit: round2(current.openingDebit + balance.openingDebit),
        openingCredit: round2(current.openingCredit + balance.openingCredit),
        periodDebit: round2(current.periodDebit + balance.periodDebit),
        periodCredit: round2(current.periodCredit + balance.periodCredit),
      });
    };
    add(totalsByAccount);
    const index = columnIndex.get(balance.objectId);
    if (index !== undefined) add(perColumn[index]!);
  }
  const sorted = (map: Map<string, AccountBalance>) => [...map.values()].sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  const total = buildIncomeStatement(sorted(totalsByAccount));
  const columnStatements = perColumn.map((map) => buildIncomeStatement(sorted(map)));

  const entries: IncomeStatementEntry[] = total.entries.map((entry) => {
    const amounts = columnStatements.map((statement) => statement.entries.find((e) => e.key === entry.key)?.total ?? 0);
    if (entry.kind === "subtotal") return { ...entry, amounts };
    return {
      ...entry,
      amounts,
      accounts: entry.accounts.map((account) => ({
        ...account,
        amounts: columnStatements.map((statement) => {
          const line = statement.entries.find((e) => e.key === entry.key);
          return line && line.kind === "line" ? (line.accounts.find((a) => a.accountId === account.accountId)?.amount ?? 0) : 0;
        }),
      })),
    };
  });

  return { entries, result: total.result, columns };
}

export interface ReportFiscalYear {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
}

// Narrow slice of the economy repository — the consumer declares what it
// needs (B3/B4 precedent) instead of importing the whole repository type.
export interface ReportFiscalYearReader {
  findFiscalYearForDate(date: string): Promise<ReportFiscalYear | null>;
}

export interface GeneralLedgerSourceRow {
  accountId: string;
  accountNumber: string;
  date: string;
  seriesCode: string;
  yearLabel: string;
  verificationNumber: number | null;
  description: string;
  debit: string;
  credit: string;
  verificationId: string;
  // Kostnadsställen och projekt on the row.
  costCenter: DimensionRef | null;
  project: DimensionRef | null;
}

export interface ReportLedgerReader {
  getGeneralLedgerRows(
    from: string,
    to: string,
    accountFrom: string,
    accountTo: string,
    filter?: DimensionFilter
  ): Promise<GeneralLedgerSourceRow[]>;
}

export interface GeneralLedgerRow {
  date: string;
  seriesCode: string;
  yearLabel: string;
  verificationNumber: number | null;
  displayNumber: string;
  description: string;
  // Raw row amounts stay strings, same convention as GET /ledger.
  debit: string;
  credit: string;
  verificationId: string;
  balance: number;
  costCenter: DimensionRef | null;
  project: DimensionRef | null;
}

export interface GeneralLedgerAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  rows: GeneralLedgerRow[];
}

export interface GeneralLedgerResponse {
  from: string;
  to: string;
  accountFrom: string;
  accountTo: string;
  accounts: GeneralLedgerAccount[];
  totalDebit: number;
  totalCredit: number;
}

export interface VerificationListFilters {
  from?: string;
  to?: string;
  fiscalYearId?: string;
  seriesId?: string;
  status?: ("draft" | "booked")[];
  search?: string;
  // Kostnadsställen och projekt: verifications with at least one row on the
  // object(s); every row of those verifications is listed.
  costCenterId?: string;
  projectId?: string;
}

export interface VerificationListSourceHeader {
  id: string;
  date: string;
  description: string;
  status: string;
  verificationNumber: number | null;
  seriesCode: string;
  yearLabel: string;
}

export interface VerificationListSourceRow {
  verificationId: string;
  accountNumber: string;
  accountName: string;
  debit: string;
  credit: string;
  description: string | null;
  costCenter: DimensionRef | null;
  project: DimensionRef | null;
}

export interface ReportVerificationReader {
  listVerificationsForReport(filters: VerificationListFilters): Promise<{
    headers: VerificationListSourceHeader[];
    rows: VerificationListSourceRow[];
  }>;
}

export interface VerificationListRow {
  accountNumber: string;
  accountName: string;
  description: string;
  debit: string;
  credit: string;
  costCenter: DimensionRef | null;
  project: DimensionRef | null;
}

export interface VerificationListEntry {
  id: string;
  date: string;
  displayNumber: string;
  description: string;
  status: string;
  rows: VerificationListRow[];
  totalDebit: number;
  totalCredit: number;
}

export interface VerificationListResponse {
  verifications: VerificationListEntry[];
}

// Pure builder so the printout's structure is testable without pdfkit.
export function buildVerificationList(
  headers: VerificationListSourceHeader[],
  rows: VerificationListSourceRow[]
): VerificationListResponse {
  const rowsByVerification = new Map<string, VerificationListSourceRow[]>();
  for (const row of rows) {
    const existing = rowsByVerification.get(row.verificationId) ?? [];
    existing.push(row);
    rowsByVerification.set(row.verificationId, existing);
  }

  const verifications = headers.map((header) => {
    const sourceRows = rowsByVerification.get(header.id) ?? [];
    let totalDebit = 0;
    let totalCredit = 0;
    const listRows = sourceRows.map((row) => {
      totalDebit = round2(totalDebit + Number(row.debit));
      totalCredit = round2(totalCredit + Number(row.credit));
      return {
        accountNumber: row.accountNumber,
        accountName: row.accountName,
        // Row text falls back to the header's, same rule as the ledger.
        description: row.description ?? header.description,
        debit: row.debit,
        credit: row.credit,
        costCenter: row.costCenter,
        project: row.project,
      };
    });

    return {
      id: header.id,
      date: header.date,
      displayNumber: displayNumber(header),
      description: header.description,
      status: header.status,
      rows: listRows,
      totalDebit,
      totalCredit,
    };
  });

  return { verifications };
}

export interface BalanceSheetResponse extends BalanceSheetBody {
  asOf: string;
  fiscalYear: ReportFiscalYear;
}

export interface IncomeStatementResponse extends IncomeStatementBody {
  from: string;
  to: string;
}

// With `budgetId`: the same entries with budget/variance figures for the
// period and accumulated from the fiscal year's start (budget-calc.ts).
export interface BudgetedIncomeStatementResponse extends BudgetedIncomeStatementBody {
  from: string;
  to: string;
  budget: { id: string; name: string; fiscalYearId: string };
  accumulatedFrom: string;
}

// The budget's slice of the budget repository.
export interface BudgetReportReader {
  findForReport(id: string): Promise<BudgetReportSource | null>;
}

// Only the three report renderers — economy never touches the rest of the
// PDF service.
export interface ReportPdfRenderer {
  renderFinancialStatement(input: FinancialStatementPdfInput): Promise<Buffer>;
  renderGeneralLedger(input: GeneralLedgerPdfInput): Promise<Buffer>;
  renderVerificationList(input: VerificationListPdfInput): Promise<Buffer>;
}

export type IncomeStatementQueryInput = {
  from: string;
  to: string;
  costCenterId?: string;
  projectId?: string;
  groupBy?: IncomeStatementGroupBy;
  budgetId?: string;
};

export type GeneralLedgerQueryInput = {
  from: string;
  to: string;
  accountFrom?: string;
  accountTo?: string;
  onlyWithMovement: boolean;
  costCenterId?: string;
  projectId?: string;
};

function dimensionFilterOf(query: { costCenterId?: string; projectId?: string }): DimensionFilter | undefined {
  if (!query.costCenterId && !query.projectId) return undefined;
  return {
    ...(query.costCenterId ? { costCenterId: query.costCenterId } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
  };
}

// "Kostnadsställe 100 Verkstad" / "Utan kostnadsställe" — the PDF's column
// heading per objekt.
function columnLabel(groupBy: IncomeStatementGroupBy, column: IncomeStatementColumn): string {
  const dimension = groupBy === "costCenter" ? "Kostnadsställe" : "Projekt";
  return column.id === null ? `Utan ${dimension.toLowerCase()}` : `${dimension} ${column.code} ${column.name}`;
}

// The objects of a row appended to its text on the PDFs, whose row layouts
// have no column of their own: "Hyra [100 Verkstad · P1 Storkök]".
function withObjects(text: string, row: { costCenter: DimensionRef | null; project: DimensionRef | null }): string {
  const parts = [dimensionText(row.costCenter), dimensionText(row.project)].filter((part) => part !== "");
  return parts.length === 0 ? text : `${text} [${parts.join(" · ")}]`;
}


export function createFinancialReportsService(deps: {
  db: Db;
  repo: ReportFiscalYearReader & ReportLedgerReader & ReportVerificationReader;
  pdf?: ReportPdfRenderer;
  // Budget on the income statement; without it `budgetId` is a 404.
  budgets?: BudgetReportReader;
}) {
  const { db, repo, budgets } = deps;
  // The PDF subtitles name the filtered object(s) — "… · Kostnadsställe 100
  // Verkstad" — resolved right before the render, never for JSON/CSV.
  async function subtitleFor(base: string, query: { costCenterId?: string; projectId?: string }): Promise<string> {
    if (!query.costCenterId && !query.projectId) return base;
    const refs = await loadDimensionRefs(db, { costCenterIds: [query.costCenterId], projectIds: [query.projectId] });
    const parts = [base];
    if (query.costCenterId) parts.push(`Kostnadsställe ${dimensionText(refs.costCenters.get(query.costCenterId)) || query.costCenterId}`);
    if (query.projectId) parts.push(`Projekt ${dimensionText(refs.projects.get(query.projectId)) || query.projectId}`);
    return parts.join(" · ");
  }
  // The PDF renderer is optional so the report tests can construct the
  // service without dragging pdfkit in; the routes always pass it.
  const pdf = deps.pdf;
  function renderer(): ReportPdfRenderer {
    if (!pdf) throw new Error("financial reports service was created without a PDF renderer");
    return pdf;
  }

  // Named object (economy.service.ts's pattern) so the PDF wrappers can call
  // the JSON builders without relying on `this` — the service survives being
  // destructured.
  const service = {
    // Point-in-time: every booked row up to and including asOf, no lower
    // bound. The fiscal year is only needed to split the result into
    // retained/current — the balance-sheet accounts themselves sum over all
    // of history, which is the only correct reading without a year-end
    // closing (and stays correct once B6b imports opening balances as
    // ordinary verifications).
    async getBalanceSheet(query: { asOf: string }): Promise<BalanceSheetResponse> {
      const fiscalYear = await repo.findFiscalYearForDate(query.asOf);
      if (!fiscalYear) throw new ReportFiscalYearNotFoundError(query.asOf);

      const balances = await readAccountBalances(db, { from: fiscalYear.startDate, to: query.asOf });
      return { asOf: query.asOf, fiscalYear, ...buildBalanceSheet(balances) };
    },

    // Kostnadsställen och projekt: `costCenterId`/`projectId` keep only the
    // rows carrying the object(s) (same shape as before); `groupBy` adds the
    // columns and per-column amounts (buildGroupedIncomeStatement).
    async getIncomeStatement(query: IncomeStatementQueryInput): Promise<IncomeStatementResponse | BudgetedIncomeStatementResponse> {
      if (query.budgetId) return service.getBudgetedIncomeStatement({ ...query, budgetId: query.budgetId });
      const filter = dimensionFilterOf(query);
      if (!query.groupBy) {
        const balances = await readAccountBalances(db, { from: query.from, to: query.to }, filter);
        return { from: query.from, to: query.to, ...buildIncomeStatement(balances) };
      }
      const grouped = await readAccountBalancesGrouped(db, { from: query.from, to: query.to }, query.groupBy, filter);
      // Columns = the objects with result-account movement — the same rule
      // as the Utan column, so no column is ever empty.
      const ids = grouped.filter(hasResultMovement).map((balance) => balance.objectId);
      const refs = await loadDimensionRefs(db, {
        costCenterIds: query.groupBy === "costCenter" ? ids : [],
        projectIds: query.groupBy === "project" ? ids : [],
      });
      const objects = [...(query.groupBy === "costCenter" ? refs.costCenters : refs.projects).values()].sort((a, b) =>
        a.code.localeCompare(b.code, "sv")
      );
      return { from: query.from, to: query.to, ...buildGroupedIncomeStatement(grouped, objects) };
    },

    // Resultaträkningen med budget: the period's actuals against the budget
    // apportioned over the same window (budgetedAmounts), plus both
    // accumulated from the fiscal year's start. A `costCenterId` filters
    // actuals AND budget lines to that cost center; without one the whole
    // company's budget (every line, Ej fördelat included) meets the whole
    // company's actuals.
    async getBudgetedIncomeStatement(query: IncomeStatementQueryInput & { budgetId: string }): Promise<BudgetedIncomeStatementResponse> {
      if (query.projectId || query.groupBy) throw new BudgetNotCombinableError();
      const budget = budgets ? await budgets.findForReport(query.budgetId) : null;
      if (!budget) throw new BudgetNotFoundError(query.budgetId);
      const { fiscalYear } = budget;
      if (query.from < fiscalYear.startDate || query.to > fiscalYear.endDate) {
        throw new BudgetRangeOutsideYearError(query.from, query.to, fiscalYear.label);
      }
      const filter = dimensionFilterOf(query);
      const lines = query.costCenterId ? budget.lines.filter((line) => line.costCenterId === query.costCenterId) : budget.lines;
      const [period, accumulated] = await Promise.all([
        readAccountBalances(db, { from: query.from, to: query.to }, filter),
        readAccountBalances(db, { from: fiscalYear.startDate, to: query.to }, filter),
      ]);
      const body = buildBudgetedIncomeStatement({
        period,
        accumulated,
        periodBudget: budgetedAmounts(lines, fiscalYear.periods, query.from, query.to),
        accumulatedBudget: budgetedAmounts(lines, fiscalYear.periods, fiscalYear.startDate, query.to),
        accounts: budget.accounts,
      });
      return {
        from: query.from,
        to: query.to,
        budget: { id: budget.id, name: budget.name, fiscalYearId: fiscalYear.id },
        accumulatedFrom: fiscalYear.startDate,
        ...body,
      };
    },

    // Two queries total: the per-account opening/period sums, and the rows.
    // The running balance is computed exactly like getLedger's — round2 on
    // every step, never an accumulated float.
    // Kostnadsställen och projekt: the object filter applies to the opening
    // balances, the rows and the before-year correction alike, so the running
    // balance is the object's own.
    async getGeneralLedger(query: GeneralLedgerQueryInput): Promise<GeneralLedgerResponse> {
      const accountFrom = query.accountFrom ?? "0000";
      const accountTo = query.accountTo ?? "9999";
      const filter = dimensionFilterOf(query);

      const balances = (await readAccountBalances(db, { from: query.from, to: query.to }, filter)).filter(
        (balance) => balance.accountNumber >= accountFrom && balance.accountNumber <= accountTo
      );
      const sourceRows = await repo.getGeneralLedgerRows(query.from, query.to, accountFrom, accountTo, filter);
      // Result accounts (class 3–8) start every fiscal year at 0: their IB is
      // the movement from the start of the year containing `from`, i.e. the
      // all-history opening minus what was booked before that year started.
      // Balance accounts keep the cumulative IB. Outside any fiscal year the
      // IB stays cumulative for both.
      const fiscalYear = await repo.findFiscalYearForDate(query.from);
      const beforeYear = new Map<string, number>();
      if (fiscalYear) {
        for (const balance of await readAccountBalances(db, { from: fiscalYear.startDate, to: fiscalYear.startDate }, filter)) {
          beforeYear.set(balance.accountId, balance.openingDebit - balance.openingCredit);
        }
      }

      const rowsByAccount = new Map<string, GeneralLedgerSourceRow[]>();
      for (const row of sourceRows) {
        const existing = rowsByAccount.get(row.accountId) ?? [];
        existing.push(row);
        rowsByAccount.set(row.accountId, existing);
      }

      const ledgerAccounts: GeneralLedgerAccount[] = [];
      let totalDebit = 0;
      let totalCredit = 0;

      for (const balance of balances) {
        const accountRows = rowsByAccount.get(balance.accountId) ?? [];
        // "Rörelse eller saldo": a BALANCE account with an opening balance but
        // no movement in the interval is not an empty account (B1 follow-up).
        // A result account (class 3–8) carries no balance across the year, so
        // it is listed only when it moved in the interval.
        const carriesBalance = classifyAccount(balance.accountNumber).report === "balanceSheet";
        const openingBalance = round2(
          balance.openingDebit - balance.openingCredit - (carriesBalance ? 0 : (beforeYear.get(balance.accountId) ?? 0))
        );
        if (query.onlyWithMovement && accountRows.length === 0 && !(carriesBalance && openingBalance !== 0)) continue;
        let running = openingBalance;
        const rows = accountRows.map((row) => {
          running = round2(running + Number(row.debit) - Number(row.credit));
          return {
            date: row.date,
            seriesCode: row.seriesCode,
            yearLabel: row.yearLabel,
            verificationNumber: row.verificationNumber,
            // Every row here is booked by construction — the query filters
            // on status — so displayNumber never returns "Utkast".
            displayNumber: displayNumber({
              status: "booked",
              seriesCode: row.seriesCode,
              yearLabel: row.yearLabel,
              verificationNumber: row.verificationNumber,
            }),
            description: row.description,
            debit: row.debit,
            credit: row.credit,
            verificationId: row.verificationId,
            balance: running,
            costCenter: row.costCenter,
            project: row.project,
          };
        });

        totalDebit = round2(totalDebit + balance.periodDebit);
        totalCredit = round2(totalCredit + balance.periodCredit);

        ledgerAccounts.push({
          accountId: balance.accountId,
          accountNumber: balance.accountNumber,
          accountName: balance.accountName,
          openingBalance,
          closingBalance: running,
          totalDebit: round2(balance.periodDebit),
          totalCredit: round2(balance.periodCredit),
          rows,
        });
      }

      return {
        from: query.from,
        to: query.to,
        accountFrom,
        accountTo,
        accounts: ledgerAccounts,
        totalDebit,
        totalCredit,
      };
    },

    async getVerificationList(filters: VerificationListFilters): Promise<VerificationListResponse> {
      const { headers, rows } = await repo.listVerificationsForReport(filters);
      return buildVerificationList(headers, rows);
    },

    // --- PDF ---
    // Economy formats every amount and Swedish label; the mail module's
    // renderers only lay the result out on the shared A4 template.

    async getBalanceSheetPdf(query: { asOf: string }) {
      const sheet = await service.getBalanceSheet(query);
      const rows: FinancialStatementPdfInput["rows"] = [];

      for (const [section, heading] of [
        [sheet.assets, "TILLGÅNGAR"],
        [sheet.equityAndLiabilities, "EGET KAPITAL OCH SKULDER"],
      ] as const) {
        rows.push({ kind: "total", label: heading, amount: null });
        for (const group of section.groups) {
          rows.push({ kind: "group", label: group.label, amount: null });
          for (const line of group.lines) {
            rows.push({ kind: "line", label: line.label, amount: formatNumber(line.total) });
            for (const account of line.accounts) {
              rows.push({
                kind: "account",
                label: `${account.accountNumber} ${account.accountName}`,
                amount: formatNumber(account.amount),
              });
            }
          }
          rows.push({ kind: "subtotal", label: `Summa ${group.label.toLowerCase()}`, amount: formatNumber(group.total) });
        }
        rows.push({ kind: "total", label: `SUMMA ${heading}`, amount: formatNumber(section.total) });
      }

      if (sheet.difference !== 0) {
        rows.push({ kind: "total", label: "DIFFERENS", amount: formatNumber(sheet.difference) });
      }

      const content = await renderer().renderFinancialStatement({
        title: "Balansräkning",
        subtitle: `Per ${sheet.asOf} · Räkenskapsår ${sheet.fiscalYear.label}`,
        rows,
      });
      return { filename: `balansrakning-${sheet.asOf}.pdf`, content };
    },

    // --- CSV (F2) ---
    // Same numbers as the JSON/PDF variants, flattened by the pure builders
    // in financial-reports-csv.ts — no separate query path.

    async getBalanceSheetCsv(query: { asOf: string }) {
      const sheet = await service.getBalanceSheet(query);
      return { filename: `balansrakning-${sheet.asOf}.csv`, content: buildBalanceSheetCsv(sheet) };
    },

    // Per objekt the A4 template has one amount column, so the PDF prints
    // one section per column (the object's name as a group heading, its own
    // lines and subtotals) and the total last.
    // With a budget: Utfall, Budget, Avvikelse, Avvikelse % for the period
    // and, when the period does not start on the year's first day, the three
    // accumulated columns too (the renderer goes landscape for seven).
    async getBudgetedIncomeStatementPdf(query: IncomeStatementQueryInput & { budgetId: string }) {
      const statement = await service.getBudgetedIncomeStatement(query);
      const withAccumulated = statement.from !== statement.accumulatedFrom;
      const columns = ["Utfall", "Budget", "Avvikelse", "Avvikelse %", ...(withAccumulated ? ["Utfall ack.", "Budget ack.", "Avvikelse ack."] : [])];
      const percent = (value: number | null) => (value === null ? "" : formatNumber(value, 1));
      const amountsOf = (f: { amount: number; budget: number; variance: number; variancePercent: number | null; accumulated: number; accumulatedBudget: number; accumulatedVariance: number }) => [
        formatNumber(f.amount),
        formatNumber(f.budget),
        formatNumber(f.variance),
        percent(f.variancePercent),
        ...(withAccumulated ? [formatNumber(f.accumulated), formatNumber(f.accumulatedBudget), formatNumber(f.accumulatedVariance)] : []),
      ];
      const rows: FinancialStatementPdfInput["rows"] = [];
      for (const entry of statement.entries) {
        if (entry.kind === "subtotal") {
          rows.push({ kind: "subtotal", label: entry.label, amount: null, amounts: amountsOf(entry) });
          continue;
        }
        rows.push({ kind: "line", label: entry.label, amount: null, amounts: amountsOf(entry) });
        for (const account of entry.accounts) {
          rows.push({ kind: "account", label: `${account.accountNumber} ${account.accountName}`, amount: null, amounts: amountsOf(account) });
        }
      }
      const content = await renderer().renderFinancialStatement({
        title: "Resultaträkning",
        subtitle: await subtitleFor(`${statement.from} – ${statement.to} · Budget ${statement.budget.name}`, query),
        columns,
        rows,
      });
      return { filename: `resultatrakning-${statement.from}--${statement.to}.pdf`, content };
    },

    async getIncomeStatementPdf(query: IncomeStatementQueryInput) {
      if (query.budgetId) return service.getBudgetedIncomeStatementPdf({ ...query, budgetId: query.budgetId });
      const statement = await service.getIncomeStatement(query);
      if ("budget" in statement) throw new Error("unreachable: budgeted statement without budgetId");
      const rows: FinancialStatementPdfInput["rows"] = [];

      const pushSection = (amountOf: (entry: IncomeStatementEntry) => number, accountAmountOf: (account: ReportAccount) => number) => {
        for (const entry of statement.entries) {
          if (entry.kind === "subtotal") {
            rows.push({ kind: "subtotal", label: entry.label, amount: formatNumber(amountOf(entry)) });
            continue;
          }
          rows.push({ kind: "line", label: entry.label, amount: formatNumber(amountOf(entry)) });
          for (const account of entry.accounts) {
            const amount = accountAmountOf(account);
            if (amount === 0 && statement.columns) continue;
            rows.push({ kind: "account", label: `${account.accountNumber} ${account.accountName}`, amount: formatNumber(amount) });
          }
        }
      };

      if (statement.columns) {
        statement.columns.forEach((column, index) => {
          rows.push({ kind: "group", label: columnLabel(query.groupBy!, column), amount: null });
          pushSection(
            (entry) => entry.amounts?.[index] ?? 0,
            (account) => account.amounts?.[index] ?? 0
          );
        });
        rows.push({ kind: "group", label: "Totalt", amount: null });
      }
      pushSection(
        (entry) => entry.total,
        (account) => account.amount
      );

      const content = await renderer().renderFinancialStatement({
        title: "Resultaträkning",
        subtitle: await subtitleFor(`${statement.from} – ${statement.to}`, query),
        rows,
      });
      return { filename: `resultatrakning-${statement.from}--${statement.to}.pdf`, content };
    },

    async getIncomeStatementCsv(query: IncomeStatementQueryInput) {
      if (query.budgetId) {
        const statement = await service.getBudgetedIncomeStatement({ ...query, budgetId: query.budgetId });
        return { filename: `resultatrakning-${statement.from}--${statement.to}.csv`, content: buildBudgetedIncomeStatementCsv(statement) };
      }
      const statement = await service.getIncomeStatement(query);
      if ("budget" in statement) throw new Error("unreachable: budgeted statement without budgetId");
      return {
        filename: `resultatrakning-${statement.from}--${statement.to}.csv`,
        content: statement.columns ? buildGroupedIncomeStatementCsv(statement, statement.columns) : buildIncomeStatementCsv(statement),
      };
    },

    async getGeneralLedgerPdf(query: GeneralLedgerQueryInput) {
      const ledger = await service.getGeneralLedger(query);
      const content = await renderer().renderGeneralLedger({
        title: "Huvudbok",
        subtitle: await subtitleFor(`${ledger.from} – ${ledger.to} · Konto ${ledger.accountFrom}–${ledger.accountTo}`, query),
        accounts: ledger.accounts.map((account) => ({
          heading: `${account.accountNumber} · ${account.accountName}`,
          openingAmount: formatNumber(account.openingBalance),
          closingAmount: formatNumber(account.closingBalance),
          rows: account.rows.map((row) => ({
            date: row.date,
            verification: row.displayNumber,
            text: withObjects(row.description, row),
            debit: formatNumber(Number(row.debit)),
            credit: formatNumber(Number(row.credit)),
            balance: formatNumber(row.balance),
          })),
        })),
        emptyText: "Inga bokförda rader i intervallet.",
      });
      return { filename: `huvudbok-${ledger.from}--${ledger.to}.pdf`, content };
    },

    async getGeneralLedgerCsv(query: GeneralLedgerQueryInput) {
      const ledger = await service.getGeneralLedger(query);
      return { filename: `huvudbok-${ledger.from}--${ledger.to}.csv`, content: buildGeneralLedgerCsv(ledger) };
    },

    async getVerificationListPdf(filters: VerificationListFilters) {
      const list = await service.getVerificationList(filters);
      // from and to are independently optional, so a one-sided filter must
      // not print "Alla datum" — the list really is filtered.
      const range =
        filters.from && filters.to
          ? `${filters.from} – ${filters.to}`
          : filters.from
            ? `Från ${filters.from}`
            : filters.to
              ? `Till och med ${filters.to}`
              : "Alla datum";
      const content = await renderer().renderVerificationList({
        title: "Verifikatlista",
        subtitle: await subtitleFor(range, filters),
        verifications: list.verifications.map((verification) => ({
          heading: `${verification.displayNumber} · ${verification.date} · ${verification.description}`,
          rows: verification.rows.map((row) => ({
            account: `${row.accountNumber} ${row.accountName}`,
            text: withObjects(row.description, row),
            debit: formatNumber(Number(row.debit)),
            credit: formatNumber(Number(row.credit)),
          })),
          totalDebit: formatNumber(verification.totalDebit),
          totalCredit: formatNumber(verification.totalCredit),
        })),
        emptyText: "Inga verifikat matchar filtret.",
      });
      const suffix = filters.from && filters.to ? `-${filters.from}--${filters.to}` : "";
      return { filename: `verifikatlista${suffix}.pdf`, content };
    },

    async getVerificationListCsv(filters: VerificationListFilters) {
      const list = await service.getVerificationList(filters);
      const suffix = filters.from && filters.to ? `-${filters.from}--${filters.to}` : "";
      return { filename: `verifikatlista${suffix}.csv`, content: buildVerificationListCsv(list) };
    },
  };

  return service;
}

export type FinancialReportsService = ReturnType<typeof createFinancialReportsService>;
