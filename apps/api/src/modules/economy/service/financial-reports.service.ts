// Balansräkning + resultaträkning (B6a). The builders are pure and exported
// so the whole classification and all arithmetic is unit-testable without a
// database — same split as vat-report.service.ts's bucketMovements.
import { round2 } from "@navet/shared";
import type { Db } from "@navet/db";
import { readAccountBalances, type AccountBalance } from "./account-balances.js";
import { displayNumber } from "./economy.service.js";
import { formatNumber } from "../../mail/service/document-pdf.js";
import {
  buildBalanceSheetCsv,
  buildGeneralLedgerCsv,
  buildIncomeStatementCsv,
  buildVerificationListCsv,
} from "./financial-reports-csv.js";
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

export interface ReportAccount {
  accountId: string;
  accountNumber: string;
  accountName: string;
  amount: number;
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
  | { kind: "line"; key: string; label: string; accounts: ReportAccount[]; total: number }
  | { kind: "subtotal"; key: string; label: string; total: number };

export interface IncomeStatementBody {
  entries: IncomeStatementEntry[];
  result: number;
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
}

export interface ReportLedgerReader {
  getGeneralLedgerRows(
    from: string,
    to: string,
    accountFrom: string,
    accountTo: string
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

// Only the three report renderers — economy never touches the rest of the
// PDF service.
export interface ReportPdfRenderer {
  renderFinancialStatement(input: FinancialStatementPdfInput): Promise<Buffer>;
  renderGeneralLedger(input: GeneralLedgerPdfInput): Promise<Buffer>;
  renderVerificationList(input: VerificationListPdfInput): Promise<Buffer>;
}

export function createFinancialReportsService(deps: {
  db: Db;
  repo: ReportFiscalYearReader & ReportLedgerReader & ReportVerificationReader;
  pdf?: ReportPdfRenderer;
}) {
  const { db, repo } = deps;
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

    async getIncomeStatement(query: { from: string; to: string }): Promise<IncomeStatementResponse> {
      const balances = await readAccountBalances(db, { from: query.from, to: query.to });
      return { from: query.from, to: query.to, ...buildIncomeStatement(balances) };
    },

    // Two queries total: the per-account opening/period sums, and the rows.
    // The running balance is computed exactly like getLedger's — round2 on
    // every step, never an accumulated float.
    async getGeneralLedger(query: {
      from: string;
      to: string;
      accountFrom?: string;
      accountTo?: string;
      onlyWithMovement: boolean;
    }): Promise<GeneralLedgerResponse> {
      const accountFrom = query.accountFrom ?? "0000";
      const accountTo = query.accountTo ?? "9999";

      const balances = (await readAccountBalances(db, { from: query.from, to: query.to })).filter(
        (balance) => balance.accountNumber >= accountFrom && balance.accountNumber <= accountTo
      );
      const sourceRows = await repo.getGeneralLedgerRows(query.from, query.to, accountFrom, accountTo);
      // Result accounts (class 3–8) start every fiscal year at 0: their IB is
      // the movement from the start of the year containing `from`, i.e. the
      // all-history opening minus what was booked before that year started.
      // Balance accounts keep the cumulative IB. Outside any fiscal year the
      // IB stays cumulative for both.
      const fiscalYear = await repo.findFiscalYearForDate(query.from);
      const beforeYear = new Map<string, number>();
      if (fiscalYear) {
        for (const balance of await readAccountBalances(db, { from: fiscalYear.startDate, to: fiscalYear.startDate })) {
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

    async getIncomeStatementPdf(query: { from: string; to: string }) {
      const statement = await service.getIncomeStatement(query);
      const rows: FinancialStatementPdfInput["rows"] = [];

      for (const entry of statement.entries) {
        if (entry.kind === "subtotal") {
          rows.push({ kind: "subtotal", label: entry.label, amount: formatNumber(entry.total) });
          continue;
        }
        rows.push({ kind: "line", label: entry.label, amount: formatNumber(entry.total) });
        for (const account of entry.accounts) {
          rows.push({
            kind: "account",
            label: `${account.accountNumber} ${account.accountName}`,
            amount: formatNumber(account.amount),
          });
        }
      }

      const content = await renderer().renderFinancialStatement({
        title: "Resultaträkning",
        subtitle: `${statement.from} – ${statement.to}`,
        rows,
      });
      return { filename: `resultatrakning-${statement.from}--${statement.to}.pdf`, content };
    },

    async getIncomeStatementCsv(query: { from: string; to: string }) {
      const statement = await service.getIncomeStatement(query);
      return {
        filename: `resultatrakning-${statement.from}--${statement.to}.csv`,
        content: buildIncomeStatementCsv(statement),
      };
    },

    async getGeneralLedgerPdf(query: {
      from: string;
      to: string;
      accountFrom?: string;
      accountTo?: string;
      onlyWithMovement: boolean;
    }) {
      const ledger = await service.getGeneralLedger(query);
      const content = await renderer().renderGeneralLedger({
        title: "Huvudbok",
        subtitle: `${ledger.from} – ${ledger.to} · Konto ${ledger.accountFrom}–${ledger.accountTo}`,
        accounts: ledger.accounts.map((account) => ({
          heading: `${account.accountNumber} · ${account.accountName}`,
          openingAmount: formatNumber(account.openingBalance),
          closingAmount: formatNumber(account.closingBalance),
          rows: account.rows.map((row) => ({
            date: row.date,
            verification: row.displayNumber,
            text: row.description,
            debit: formatNumber(Number(row.debit)),
            credit: formatNumber(Number(row.credit)),
            balance: formatNumber(row.balance),
          })),
        })),
        emptyText: "Inga bokförda rader i intervallet.",
      });
      return { filename: `huvudbok-${ledger.from}--${ledger.to}.pdf`, content };
    },

    async getGeneralLedgerCsv(query: {
      from: string;
      to: string;
      accountFrom?: string;
      accountTo?: string;
      onlyWithMovement: boolean;
    }) {
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
        subtitle: range,
        verifications: list.verifications.map((verification) => ({
          heading: `${verification.displayNumber} · ${verification.date} · ${verification.description}`,
          rows: verification.rows.map((row) => ({
            account: `${row.accountNumber} ${row.accountName}`,
            text: row.description,
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
