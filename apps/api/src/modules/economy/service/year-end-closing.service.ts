// Årsbokslut (ekonomi etapp 2, delprojekt 3) — the closing guide. Every
// writing path takes the closing row FOR UPDATE first (repo.lockClosing) and
// writes its audit entry inside the same transaction.
import { auditLog, type Db, type Tx } from "@navet/db";
import {
  ACCRUAL_KIND_BALANCE_SIDE,
  round2,
  type BookAccrualsInput,
  type BookInventoryInput,
  type CreateFiscalYearInput,
  type ListYearEndClosingsQuery,
  type ProfitDispositionInput,
  type StartYearEndClosingInput,
  type ValuationMethod,
} from "@navet/shared";
import { formatNumber } from "../../mail/service/document-pdf.js";
import { METHOD_LABELS } from "../../stock/service/valuation.service.js";
import { isUniqueViolation } from "../../system/service/db-errors.js";
import { findSettlementsOverlapping } from "../repository/vat-settlement.repository.js";
import * as repo from "../repository/year-end.repository.js";
import { FiscalYearClosedError } from "./accounting-period-lock.js";
import { readAccountBalances } from "./account-balances.js";
import { classifyAccount } from "./bas-report-lines.js";
import {
  AccountNotFoundError,
  DuplicateFiscalYearLabelError,
  FiscalYearNotFoundError,
  InactiveAccountError,
  OverlappingFiscalYearError,
} from "./economy.service.js";
import type { FixedAssetPlan } from "./fixed-asset-plan.js";
import { reconciliationLine, stockholmToday, type DepreciationRunResult, type RunDepreciationInput } from "./fixed-asset.service.js";
import { readVatAccountMovements } from "./vat-account-movements.js";
import { findUnassignedAccounts } from "./vat-report.service.js";
import {
  MissingPostingAccountError,
  assertPostablePeriod,
  type PostingSettingsReader,
  type VerificationPoster,
} from "./verification-poster.js";
import {
  accrualAmounts,
  inventoryAmounts,
  mirrorAmounts,
  nextFiscalYearBounds,
  profitDispositionAmounts,
  resultTransferAmounts,
  sameAccrualSet,
  toDebitCredit,
  type AccrualSpec,
  type SignedAmount,
} from "./year-end-calc.js";
import { DIVIDEND_PAYABLE_ACCOUNT, RETAINED_EARNINGS_ACCOUNT, YEAR_RESULT_ACCOUNT, YEAR_RESULT_EQUITY_ACCOUNT } from "./year-end-accounts.js";
import { evaluateCloseBlockers, evaluateStepBlockers, evaluateWarnings, type StepGateInput, type YearEndCheck } from "./year-end-checks.js";

export class YearEndClosingNotFoundError extends Error {
  constructor(id: string) {
    super(`Year-end closing ${id} not found`);
    this.name = "YearEndClosingNotFoundError";
  }
}

export class YearEndClosingExistsError extends Error {
  constructor(label: string) {
    super(`Fiscal year ${label} already has a year-end closing`);
    this.name = "YearEndClosingExistsError";
  }
}

export class InvalidClosingDateError extends Error {
  constructor(date: string, from: string, to: string) {
    super(`The closing date ${date} must lie in the year's last period (${from} – ${to})`);
    this.name = "InvalidClosingDateError";
  }
}

export class ClosingDateLockedError extends Error {
  constructor() {
    super("The closing date cannot change after a step has been booked");
    this.name = "ClosingDateLockedError";
  }
}

export class YearEndClosingClosedError extends Error {
  constructor(label: string) {
    super(`The year-end closing for ${label} is closed — reopen it first`);
    this.name = "YearEndClosingClosedError";
  }
}

export class YearEndBlockedError extends Error {
  constructor(messages: string[]) {
    super(`The year-end closing is blocked: ${messages.join("; ")}`);
    this.name = "YearEndBlockedError";
  }
}

export class InventoryAccountConflictError extends Error {
  constructor(number: string) {
    super(`The inventory account and the inventory change account are both ${number}`);
    this.name = "InventoryAccountConflictError";
  }
}

export class InvalidAccrualAccountError extends Error {
  constructor(accountNumber: string, kind: string) {
    super(`Account ${accountNumber} cannot be used for an accrual of kind ${kind}`);
    this.name = "InvalidAccrualAccountError";
  }
}

export class NextFiscalYearMissingError extends Error {
  constructor(label: string) {
    super(`The fiscal year after ${label} could not be created automatically — create it under Räkenskapsår`);
    this.name = "NextFiscalYearMissingError";
  }
}

export class YearEndStepOrderError extends Error {
  constructor(step: string) {
    super(`Do step "${step}" before the result transfer`);
    this.name = "YearEndStepOrderError";
  }
}

export class YearEndClosingNotClosedError extends Error {
  constructor(label: string) {
    super(`The year-end closing for ${label} is not closed`);
    this.name = "YearEndClosingNotClosedError";
  }
}

export class NextFiscalYearClosedError extends Error {
  constructor(label: string) {
    super(`The next fiscal year (${label}) is closed — reopen it first`);
    this.name = "NextFiscalYearClosedError";
  }
}

export class ProfitDispositionActiveError extends Error {
  constructor(label: string) {
    super(`The profit disposition for ${label} is booked — undo it first`);
    this.name = "ProfitDispositionActiveError";
  }
}

export class InvalidAgmDateError extends Error {
  constructor(date: string, yearEnd: string) {
    super(`The AGM date ${date} must be after the fiscal year's end (${yearEnd}) and not in the future`);
    this.name = "InvalidAgmDateError";
  }
}

export class ProfitDispositionExistsError extends Error {
  constructor(label: string) {
    super(`A profit disposition for ${label} is already booked — undo it first`);
    this.name = "ProfitDispositionExistsError";
  }
}

export class NothingToDisposeError extends Error {
  constructor(label: string) {
    super(`Account 2099 has no balance to dispose for ${label}`);
    this.name = "NothingToDisposeError";
  }
}

export class ProfitDispositionNotFoundError extends Error {
  constructor(label: string) {
    super(`No active profit disposition for ${label}`);
    this.name = "ProfitDispositionNotFoundError";
  }
}

export interface InventoryValuation {
  totalValue: number;
  unvaluedCount: number;
  groups: { rows: { articleNumber: string; articleName: string; unit: string; quantity: number; value: number | null }[] }[];
}

// D1's valuation service satisfies this structurally (app.ts passes it).
export interface InventoryValuationReader {
  getValuation(query: { asOf: string; method: ValuationMethod }): Promise<InventoryValuation>;
}

export interface YearEndClosingServiceDeps {
  db: Db;
  poster: VerificationPoster;
  settings: PostingSettingsReader;
  receivables: { totalAsOf(executor: Db | Tx, date: string): Promise<number> };
  payables: { totalAsOf(executor: Db | Tx, date: string): Promise<number> };
  fixedAssets: {
    getPlan(query: { fiscalYearId: string }): Promise<FixedAssetPlan>;
    runDepreciation(tx: Tx, input: RunDepreciationInput, userId: string): Promise<DepreciationRunResult | null>;
    missingDepreciation(executor: Db | Tx, throughMonth: string): Promise<{ assets: number; total: number }>;
  };
  inventory: InventoryValuationReader;
  // economyService satisfies this (app.ts passes it): steg 4 creates the
  // next fiscal year through the ordinary path, before its transaction.
  fiscalYears: { createFiscalYear(input: CreateFiscalYearInput): Promise<{ id: string }> };
}

export function createYearEndClosingService(deps: YearEndClosingServiceDeps) {
  const { db } = deps;

  async function requireClosing(executor: Db | Tx, id: string): Promise<repo.ClosingRow> {
    const closing = await repo.findClosing(executor, id);
    if (!closing) throw new YearEndClosingNotFoundError(id);
    return closing;
  }

  async function requireYear(executor: Db | Tx, id: string): Promise<repo.FiscalYearRow> {
    const year = await repo.findFiscalYear(executor, id);
    if (!year) throw new FiscalYearNotFoundError(id);
    return year;
  }

  // The period containing the year's end date — the only one a closing date
  // may lie in.
  async function lastPeriod(executor: Db | Tx, year: repo.FiscalYearRow): Promise<repo.PeriodRow> {
    const period = await repo.findPeriodForDate(executor, year.endDate);
    if (!period) throw new Error(`Fiscal year ${year.label} has no period covering ${year.endDate}`);
    return period;
  }

  async function assertClosingDate(executor: Db | Tx, year: repo.FiscalYearRow, closingDate: string): Promise<void> {
    const period = await lastPeriod(executor, year);
    if (closingDate < period.startDate || closingDate > year.endDate) {
      throw new InvalidClosingDateError(closingDate, period.startDate, year.endDate);
    }
  }

  // The date locks after the first booked step (2–5), steg 3's AV run included.
  async function closingDateLocked(executor: Db | Tx, closing: repo.ClosingRow): Promise<boolean> {
    if (closing.inventoryBookedAt || closing.accrualsBookedAt || closing.resultTransferVerificationId) return true;
    return repo.hasDepreciationRunOn(executor, closing.closingDate);
  }

  async function writeAudit(tx: Tx, label: string, action: string, detail: Record<string, unknown>, userId: string): Promise<void> {
    await tx.insert(auditLog).values({ entityType: "year_end_closing", entityId: label, action, detail, userId });
  }

  async function loadStepGate(executor: Db | Tx, closing: repo.ClosingRow, year: repo.FiscalYearRow): Promise<StepGateInput> {
    const previous = await repo.findPreviousFiscalYear(executor, year.startDate);
    const period = await repo.findPeriodForDate(executor, closing.closingDate);
    return {
      today: stockholmToday(),
      closingDate: closing.closingDate,
      draftCount: await repo.countDrafts(executor, year.id),
      previousYear: previous ? { label: previous.label, status: previous.status } : null,
      closingPeriodStatus: period?.status ?? "locked",
    };
  }

  // The start of every writing step: the row lock, the status, and the
  // step blockers evaluated INSIDE the transaction.
  async function lockOpenClosing(tx: Tx, id: string): Promise<{ closing: repo.ClosingRow; year: repo.FiscalYearRow }> {
    const closing = await repo.lockClosing(tx, id);
    if (!closing) throw new YearEndClosingNotFoundError(id);
    const year = await requireYear(tx, closing.fiscalYearId);
    if (closing.status !== "in_progress") throw new YearEndClosingClosedError(year.label);
    const blockers = evaluateStepBlockers(await loadStepGate(tx, closing, year));
    if (blockers.length > 0) throw new YearEndBlockedError(blockers.map((check) => check.message));
    return { closing, year };
  }

  async function loadWarnings(executor: Db | Tx, closing: repo.ClosingRow, year: repo.FiscalYearRow): Promise<YearEndCheck[]> {
    const settings = await deps.settings.read(executor);
    // The reskontror are measured at the YEAR'S END, the same date the
    // fixed-asset reconciliation (getPlan) uses — activity dated between an
    // earlier closing date and year end cannot slip past the check.
    const balances = await readAccountBalances(executor, { from: null, to: year.endDate });
    const debitBalance = (number: string) => {
      const row = balances.find((balance) => balance.accountNumber === number);
      return row ? round2(row.periodDebit - row.periodCredit) : 0;
    };
    const periods = await repo.listPeriods(executor, year.id);
    const settlements = (await findSettlementsOverlapping(executor, year.startDate, year.endDate)).filter((s) => !s.reversed);
    const plan = await deps.fixedAssets.getPlan({ fiscalYearId: year.id });
    const movements = await readVatAccountMovements(executor, year.startDate, year.endDate);
    const inventoryStep = await inventoryStepView(executor, closing);
    return evaluateWarnings({
      unsettledVatMonths: periods
        .filter((period) => !settlements.some((s) => s.fromDate <= period.startDate && s.toDate >= period.endDate))
        .map((period) => period.startDate.slice(0, 7)),
      receivables: {
        accountNumber: settings.postingAccountsReceivable,
        ledger: debitBalance(settings.postingAccountsReceivable),
        register: await deps.receivables.totalAsOf(executor, year.endDate),
      },
      payables: {
        accountNumber: settings.postingAccountsPayable,
        ledger: round2(-debitBalance(settings.postingAccountsPayable)),
        register: await deps.payables.totalAsOf(executor, year.endDate),
      },
      fixedAssetMismatches: plan.reconciliation.filter((row) => row.mismatch).map(reconciliationLine),
      revenueWithoutVatBox: findUnassignedAccounts(movements).filter((account) => account.accountNumber.startsWith("3")),
      inventoryStale:
        inventoryStep.status === "stale" ? { ledger: inventoryStep.ledger ?? 0, value: inventoryStep.value ?? 0 } : null,
    });
  }

  async function requireAccountByNumber(executor: Db | Tx, number: string, role: string): Promise<repo.AccountRow> {
    const account = await repo.findAccountByNumber(executor, number);
    if (!account || !account.active) throw new MissingPostingAccountError(number, role);
    return account;
  }

  async function inventoryAccounts(executor: Db | Tx) {
    const settings = await deps.settings.read(executor);
    const inventory = await requireAccountByNumber(executor, settings.postingInventory, "inventory");
    const change = await requireAccountByNumber(executor, settings.postingInventoryChange, "inventory change");
    if (inventory.id === change.id) throw new InventoryAccountConflictError(settings.postingInventory);
    return { inventory, change };
  }

  async function defaultInventoryMethod(executor: Db | Tx, year: repo.FiscalYearRow): Promise<ValuationMethod> {
    return (await repo.latestClosedInventoryMethod(executor, year.startDate)) ?? "moving_average";
  }

  // Valuation for a PASSED closing date is deterministic (D1 only reads rows
  // created on or before it), so it is safe to compute it inside the step's
  // transaction even though the reader uses its own connection.
  async function computeInventory(executor: Db | Tx, closing: repo.ClosingRow, method: ValuationMethod) {
    const valuation = await deps.inventory.getValuation({ asOf: closing.closingDate, method });
    const value = round2(valuation.totalValue);
    // A company without stock (no 1460/4990 in its chart): nothing valued,
    // nothing on the inventory account and no live step booking — the step
    // completes with nothing to book, without requiring either account.
    if (value === 0 && !closing.inventoryVerificationId) {
      const settings = await deps.settings.read(executor);
      const account = await repo.findAccountByNumber(executor, settings.postingInventory);
      const ledger = account ? await repo.accountBalance(executor, account.id, closing.closingDate) : 0;
      if (ledger === 0) {
        const unchanged = closing.inventoryBookedAt !== null && closing.inventoryMethod === method && Number(closing.inventoryValue) === 0;
        return { valuation, ledger, ledgerExcludingStep: 0, value, difference: 0, amounts: [] as SignedAmount[], unchanged };
      }
    }
    const { inventory, change } = await inventoryAccounts(executor);
    const ledger = await repo.accountBalance(executor, inventory.id, closing.closingDate);
    const live = closing.inventoryVerificationId
      ? await repo.verificationAmountOnAccount(executor, closing.inventoryVerificationId, inventory.id)
      : 0;
    const ledgerExcludingStep = round2(ledger - live);
    const { difference, amounts } = inventoryAmounts({
      inventoryAccountId: inventory.id,
      changeAccountId: change.id,
      value,
      ledgerBalance: ledgerExcludingStep,
    });
    const unchanged =
      closing.inventoryBookedAt !== null && closing.inventoryMethod === method && Number(closing.inventoryValue) === value && ledger === value;
    return { valuation, ledger, ledgerExcludingStep, value, difference, amounts, unchanged };
  }

  async function accountRows(executor: Db | Tx, amounts: SignedAmount[]) {
    const rows = [];
    for (const row of toDebitCredit(amounts)) {
      const account = await repo.findAccountById(executor, row.accountId);
      rows.push({ accountNumber: account?.number ?? "", accountName: account?.name ?? "", debit: row.debit, credit: row.credit });
    }
    return rows;
  }

  // Omföring of a guide verification on ITS OWN date, logged as the step's
  // cancellation. alreadyReversed cannot happen (generic Omför is refused for
  // guide verifications); if it does, the guide and the ledger have drifted.
  async function cancelGuideVerification(
    tx: Tx,
    closingId: string,
    verificationId: string,
    step: repo.YearEndStep,
    userId: string
  ): Promise<repo.VerificationRef> {
    const source = await repo.verificationRef(tx, verificationId);
    if (!source) throw new Error(`Guide verification ${verificationId} not found`);
    const reversal = await deps.poster.reverseBookedVerification(
      tx,
      verificationId,
      { date: source.date, description: `Omföring av ${source.displayNumber}` },
      userId
    );
    if ("alreadyReversed" in reversal) throw new Error(`Guide verification ${source.displayNumber} was reversed outside the guide`);
    await repo.insertOwnership(tx, { verificationId: reversal.verificationId, closingId, step, role: "cancellation" });
    return (await repo.verificationRef(tx, reversal.verificationId))!;
  }

  async function inventoryStepView(executor: Db | Tx, closing: repo.ClosingRow) {
    const settings = await deps.settings.read(executor);
    const account = await repo.findAccountByNumber(executor, settings.postingInventory);
    const ledger = account ? await repo.accountBalance(executor, account.id, closing.closingDate) : null;
    const value = closing.inventoryValue === null ? null : Number(closing.inventoryValue);
    const status: "not_done" | "done" | "stale" =
      closing.inventoryBookedAt === null ? "not_done" : ledger !== null && ledger !== value ? "stale" : "done";
    return {
      status,
      method: closing.inventoryMethod as ValuationMethod | null,
      value,
      verification: closing.inventoryVerificationId ? await repo.verificationRef(executor, closing.inventoryVerificationId) : null,
      bookedAt: closing.inventoryBookedAt,
      ledger,
    };
  }

  // Steg 3 is done when the register has nothing left through the closing
  // month — read live, so an undo in Anläggningsregistret shows here.
  async function depreciationStepView(executor: Db | Tx, closing: repo.ClosingRow) {
    const throughMonth = closing.closingDate.slice(0, 7);
    const missing = await deps.fixedAssets.missingDepreciation(executor, throughMonth);
    return {
      status: (missing.assets === 0 ? "done" : "missing") as "done" | "missing",
      throughMonth,
      missingAssets: missing.assets,
      missingAmount: missing.total,
    };
  }

  async function requireActiveAccountId(executor: Db | Tx, id: string): Promise<repo.AccountRow> {
    const account = await repo.findAccountById(executor, id);
    if (!account) throw new AccountNotFoundError(id);
    if (!account.active) throw new InactiveAccountError(id);
    return account;
  }

  // Balance side per kind (assets for prepaid expense / accrued income,
  // equity & liabilities for the other two); the result account must be
  // class 3–8. classifyAccount is the same table the reports use. The
  // active check runs here — BEFORE the poster, whose own in-tx check would
  // turn a since-deactivated account into a 409 missing-posting-account.
  async function validateAccrualRows(executor: Db | Tx, rows: BookAccrualsInput["rows"]): Promise<void> {
    for (const row of rows) {
      const balance = await requireActiveAccountId(executor, row.balanceAccountId);
      const result = await requireActiveAccountId(executor, row.resultAccountId);
      const balanceClass = classifyAccount(balance.number);
      const wanted = ACCRUAL_KIND_BALANCE_SIDE[row.kind] === "debit" ? "assets" : "equityAndLiabilities";
      if (balanceClass.report !== "balanceSheet" || balanceClass.section !== wanted) {
        throw new InvalidAccrualAccountError(balance.number, row.kind);
      }
      if (classifyAccount(result.number).report !== "incomeStatement") throw new InvalidAccrualAccountError(result.number, row.kind);
    }
  }

  // Creates the next fiscal year (its own transaction, the ordinary
  // createFiscalYear path) when none covers the day after year end. A
  // concurrent creator wins the label/overlap race; then we re-read.
  async function ensureNextFiscalYear(year: repo.FiscalYearRow): Promise<boolean> {
    if (await repo.findNextFiscalYear(db, year.endDate)) return false;
    try {
      await deps.fiscalYears.createFiscalYear(nextFiscalYearBounds(year));
      return true;
    } catch (err) {
      if (err instanceof OverlappingFiscalYearError || err instanceof DuplicateFiscalYearLabelError) {
        if (await repo.findNextFiscalYear(db, year.endDate)) return false;
        throw new NextFiscalYearMissingError(year.label);
      }
      throw err;
    }
  }

  async function accrualsStepView(executor: Db | Tx, closing: repo.ClosingRow) {
    return {
      status: (closing.accrualsBookedAt ? "done" : "not_done") as "done" | "not_done",
      rows: closing.accrualsVerificationId ? await repo.listAccruals(executor, closing.accrualsVerificationId) : [],
      verification: closing.accrualsVerificationId ? await repo.verificationRef(executor, closing.accrualsVerificationId) : null,
      reversalVerification: closing.accrualsReversalVerificationId
        ? await repo.verificationRef(executor, closing.accrualsReversalVerificationId)
        : null,
      bookedAt: closing.accrualsBookedAt,
    };
  }

  // Σ (kredit − debet) over the WHOLE fiscal year's class 3–8 — classified by
  // the same table as the income statement, so the two can never disagree.
  async function incomeStatementNet(executor: Db | Tx, year: repo.FiscalYearRow): Promise<number> {
    const balances = await readAccountBalances(executor, { from: year.startDate, to: year.endDate });
    return round2(
      balances.reduce(
        (sum, b) => (classifyAccount(b.accountNumber).report === "incomeStatement" ? sum + b.periodCredit - b.periodDebit : sum),
        0
      )
    );
  }

  // UB_N vs IB_N+1 per BALANCE account (spec 4.7). Balances are derived
  // from all history, so the only possible difference is an opening-balance
  // (I) verification in the next year that no reversal in that year cancels.
  async function ibCheck(executor: Db | Tx, year: repo.FiscalYearRow) {
    const next = await repo.findNextFiscalYear(executor, year.endDate);
    if (!next) return null;
    const isBalanceAccount = (number: string) => classifyAccount(number).report === "balanceSheet";
    const rows = (await repo.openingBalanceRows(executor, next.id)).filter((row) => isBalanceAccount(row.accountNumber));
    // Listed in the blocker: neither an omföring itself nor omförd anywhere.
    const imports = [
      ...new Set(
        rows
          .filter((row) => row.reversesVerificationId === null && !row.reversed)
          .map((row) => `${row.seriesCode}-${row.yearLabel}-${row.number}`)
      ),
    ];
    const net = new Map<string, { accountNumber: string; accountName: string; amount: number }>();
    for (const row of rows) {
      const entry = net.get(row.accountId) ?? { accountNumber: row.accountNumber, accountName: row.accountName, amount: 0 };
      entry.amount = round2(entry.amount + Number(row.debit) - Number(row.credit));
      net.set(row.accountId, entry);
    }
    const ub = await readAccountBalances(executor, { from: null, to: year.endDate });
    const compared = new Set([
      ...ub.filter((b) => isBalanceAccount(b.accountNumber)).map((b) => b.accountId),
      ...rows.map((row) => row.accountId),
    ]);
    const differences = [...net.entries()]
      .filter(([, entry]) => entry.amount !== 0)
      .map(([accountId, entry]) => {
        const balance = ub.find((b) => b.accountId === accountId);
        const ubAmount = balance ? round2(balance.periodDebit - balance.periodCredit) : 0;
        return {
          accountNumber: entry.accountNumber,
          accountName: entry.accountName,
          ub: ubAmount,
          ib: round2(ubAmount + entry.amount),
          difference: entry.amount,
        };
      })
      .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));
    return { nextFiscalYearLabel: next.label, accounts: compared.size, imports: differences.length > 0 ? imports : [], differences };
  }

  // The steg 6 gate. Depreciation uses the same live register check as the
  // step view and steg 5's order check, so they can never disagree.
  async function loadCloseBlockers(executor: Db | Tx, closing: repo.ClosingRow, year: repo.FiscalYearRow) {
    const gate = await loadStepGate(executor, closing, year);
    const depreciation = await depreciationStepView(executor, closing);
    const ib = await ibCheck(executor, year);
    return {
      gate,
      ib,
      blockers: evaluateCloseBlockers({
        ...gate,
        yearEndDate: year.endDate,
        inventoryDone: closing.inventoryBookedAt !== null,
        missingDepreciationAssets: depreciation.missingAssets,
        accrualsDone: closing.accrualsBookedAt !== null,
        resultNet: await incomeStatementNet(executor, year),
        openingBalanceImports: ib?.imports ?? [],
        openingBalanceDifferences: ib?.differences.length ?? 0,
      }),
    };
  }

  // Steg 5's derived status (spec 4.6): done when class 3–8 nets to 0,00,
  // stale when a live transfer exists but the net moved, else not done.
  async function resultTransferView(executor: Db | Tx, closing: repo.ClosingRow, year: repo.FiscalYearRow) {
    const net = await incomeStatementNet(executor, year);
    const resultAccount = await repo.findAccountByNumber(executor, YEAR_RESULT_ACCOUNT);
    // 8999 debit of the live transfer, added back = the result before it.
    const live =
      closing.resultTransferVerificationId && resultAccount
        ? await repo.verificationAmountOnAccount(executor, closing.resultTransferVerificationId, resultAccount.id)
        : 0;
    const status: "not_done" | "done" | "stale" = net === 0 ? "done" : closing.resultTransferVerificationId ? "stale" : "not_done";
    return {
      status,
      net,
      yearResult: round2(net + live),
      verification: closing.resultTransferVerificationId ? await repo.verificationRef(executor, closing.resultTransferVerificationId) : null,
    };
  }

  async function resultTransferAccounts(executor: Db | Tx) {
    return {
      result: await requireAccountByNumber(executor, YEAR_RESULT_ACCOUNT, "year result"),
      equity: await requireAccountByNumber(executor, YEAR_RESULT_EQUITY_ACCOUNT, "year result equity"),
    };
  }

  // 2099's credit balance per the AGM date is what is disposed; free equity
  // (the balance sheet's unrestrictedEquity line) only feeds a warning.
  async function dispositionPlan(executor: Db | Tx, year: repo.FiscalYearRow, input: ProfitDispositionInput) {
    if (input.agmDate <= year.endDate || input.agmDate > stockholmToday()) throw new InvalidAgmDateError(input.agmDate, year.endDate);
    const resultEquity = await requireAccountByNumber(executor, YEAR_RESULT_EQUITY_ACCOUNT, "year result equity");
    const retained = await requireAccountByNumber(executor, RETAINED_EARNINGS_ACCOUNT, "retained earnings");
    const dividendAccount = await requireAccountByNumber(executor, DIVIDEND_PAYABLE_ACCOUNT, "dividend payable");
    const resultAmount = round2(-(await repo.accountBalance(executor, resultEquity.id, input.agmDate)));
    const dividend = round2(input.dividendAmount);
    if (resultAmount === 0 && dividend === 0) throw new NothingToDisposeError(year.label);
    const balances = await readAccountBalances(executor, { from: null, to: input.agmDate });
    const freeEquity = round2(
      balances.reduce((sum, b) => {
        const c = classifyAccount(b.accountNumber);
        return c.report === "balanceSheet" && c.lineKey === "unrestrictedEquity" ? sum + b.periodCredit - b.periodDebit : sum;
      }, 0)
    );
    const amounts = profitDispositionAmounts({
      resultAmount,
      dividend,
      resultEquityAccountId: resultEquity.id,
      retainedAccountId: retained.id,
      dividendAccountId: dividendAccount.id,
    });
    // D1: only a real dividend can exceed free equity.
    const warnings =
      dividend > 0 && dividend > freeEquity ? [`Utdelningen överstiger fritt eget kapital (${formatNumber(freeEquity)}) — ABL 17 kap 3 §`] : [];
    return { resultAmount, dividend, freeEquity, amounts, warnings };
  }

  async function requireClosedClosing(tx: Tx, id: string) {
    const closing = await repo.lockClosing(tx, id);
    if (!closing) throw new YearEndClosingNotFoundError(id);
    const year = await requireYear(tx, closing.fiscalYearId);
    if (closing.status !== "closed") throw new YearEndClosingNotClosedError(year.label);
    return { closing, year };
  }

  async function dispositionView(executor: Db | Tx, closing: repo.ClosingRow) {
    const row = await repo.findActiveDisposition(executor, closing.id);
    if (!row) return null;
    return {
      id: row.id,
      agmDate: row.agmDate,
      resultAmount: Number(row.resultAmount),
      dividendAmount: Number(row.dividendAmount),
      verification: await repo.verificationRef(executor, row.verificationId),
    };
  }

  // Detail sections that grow with each step.
  async function views(executor: Db | Tx, closing: repo.ClosingRow, year: repo.FiscalYearRow) {
    const close = await loadCloseBlockers(executor, closing, year);
    return {
      history: await repo.listHistory(executor, closing.id),
      defaultInventoryMethod: await defaultInventoryMethod(executor, year),
      steps: {
        inventory: await inventoryStepView(executor, closing),
        depreciation: await depreciationStepView(executor, closing),
        accruals: await accrualsStepView(executor, closing),
        resultTransfer: await resultTransferView(executor, closing, year),
      },
      checks: {
        stepBlockers: evaluateStepBlockers(close.gate),
        closeBlockers: close.blockers,
        warnings: await loadWarnings(executor, closing, year),
        draftVerifications: await repo.listDrafts(executor, year.id, 20),
      },
      ibCheck: close.ib,
      profitDisposition: await dispositionView(executor, closing),
    };
  }

  async function detail(executor: Db | Tx, closing: repo.ClosingRow) {
    const year = await requireYear(executor, closing.fiscalYearId);
    const period = await lastPeriod(executor, year);
    const next = await repo.findNextFiscalYear(executor, year.endDate);
    const nextFirstPeriod = next ? await repo.findPeriodForDate(executor, next.startDate) : null;
    return {
      id: closing.id,
      fiscalYearId: closing.fiscalYearId,
      status: closing.status,
      closingDate: closing.closingDate,
      closingDateLocked: await closingDateLocked(executor, closing),
      createdAt: closing.createdAt,
      fiscalYear: {
        id: year.id,
        label: year.label,
        startDate: year.startDate,
        endDate: year.endDate,
        status: year.status,
        closedAt: year.closedAt,
      },
      closingPeriod: { id: period.id, startDate: period.startDate, endDate: period.endDate, status: period.status },
      nextFiscalYear: next
        ? {
            id: next.id,
            label: next.label,
            startDate: next.startDate,
            endDate: next.endDate,
            status: next.status,
            firstPeriodStatus: nextFirstPeriod?.status ?? null,
          }
        : null,
      ...(await views(executor, closing, year)),
    };
  }

  const service = {
    async listClosings(query: ListYearEndClosingsQuery) {
      return repo.listClosings(db, query);
    },

    async getClosing(id: string) {
      return detail(db, await requireClosing(db, id));
    },

    async startClosing(input: StartYearEndClosingInput, userId: string) {
      const year = await requireYear(db, input.fiscalYearId);
      if (year.status === "closed") throw new FiscalYearClosedError(year.label);
      const closingDate = input.closingDate ?? year.endDate;
      await assertClosingDate(db, year, closingDate);
      let id: string;
      try {
        id = await db.transaction(async (tx) => {
          const row = await repo.insertClosing(tx, { fiscalYearId: year.id, closingDate, createdBy: userId });
          await writeAudit(tx, year.label, "started", { closingDate }, userId);
          return row.id;
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new YearEndClosingExistsError(year.label);
        throw err;
      }
      return service.getClosing(id);
    },

    async updateClosingDate(id: string, closingDate: string, userId: string) {
      await db.transaction(async (tx) => {
        const closing = await repo.lockClosing(tx, id);
        if (!closing) throw new YearEndClosingNotFoundError(id);
        const year = await requireYear(tx, closing.fiscalYearId);
        if (closing.status !== "in_progress") throw new YearEndClosingClosedError(year.label);
        if (await closingDateLocked(tx, closing)) throw new ClosingDateLockedError();
        await assertClosingDate(tx, year, closingDate);
        await repo.updateClosing(tx, id, { closingDate });
        await writeAudit(tx, year.label, "closing_date_changed", { from: closing.closingDate, to: closingDate }, userId);
      });
      return service.getClosing(id);
    },

    async previewInventory(id: string, requestedMethod?: ValuationMethod) {
      const closing = await requireClosing(db, id);
      const year = await requireYear(db, closing.fiscalYearId);
      const method = requestedMethod ?? (await defaultInventoryMethod(db, year));
      const calc = await computeInventory(db, closing, method);
      return {
        asOf: closing.closingDate,
        method,
        value: calc.value,
        unvaluedCount: calc.valuation.unvaluedCount,
        unvaluedArticles: calc.valuation.groups
          .flatMap((group) => group.rows)
          .filter((row) => row.value === null)
          .slice(0, 20)
          .map((row) => ({ articleNumber: row.articleNumber, articleName: row.articleName, quantity: row.quantity, unit: row.unit })),
        ledgerBalance: calc.ledger,
        ledgerExcludingStep: calc.ledgerExcludingStep,
        difference: calc.difference,
        rows: await accountRows(db, calc.amounts),
        unchanged: calc.unchanged,
        live: closing.inventoryBookedAt
          ? {
              value: Number(closing.inventoryValue),
              method: closing.inventoryMethod as ValuationMethod,
              verification: closing.inventoryVerificationId ? await repo.verificationRef(db, closing.inventoryVerificationId) : null,
            }
          : null,
      };
    },

    // Steg 3: the register's own run, inside this transaction, dated on the
    // closing date. The AV verification stays the register's (not logged as
    // a guide verification); undo goes through Anläggningsregistret.
    async bookDepreciation(id: string, userId: string) {
      return db.transaction(async (tx) => {
        const { closing, year } = await lockOpenClosing(tx, id);
        const run = await deps.fixedAssets.runDepreciation(
          tx,
          { throughMonth: closing.closingDate.slice(0, 7), date: closing.closingDate },
          userId
        );
        if (run) await writeAudit(tx, year.label, "depreciation_booked", { verification: run.verification.displayNumber }, userId);
        return { unchanged: run === null, run };
      });
    },

    // Steg 4: replace-the-set. V (closing date) and R (next year's first
    // day) are booked in ONE transaction and stored as a pair; a re-run
    // cancels both with linked omföringar and books a new pair.
    async bookAccruals(id: string, input: BookAccrualsInput, userId: string) {
      const pre = await requireClosing(db, id);
      const year = await requireYear(db, pre.fiscalYearId);
      // Validated before the next year is created (no year for a bad request)
      // and again under the row lock below, before anything is posted.
      await validateAccrualRows(db, input.rows);
      const nextFiscalYearCreated = input.rows.length > 0 ? await ensureNextFiscalYear(year) : false;

      return db.transaction(async (tx) => {
        const { closing } = await lockOpenClosing(tx, id);
        await validateAccrualRows(tx, input.rows);
        const wanted: AccrualSpec[] = input.rows.map((row) => ({ ...row, amount: round2(row.amount) }));
        const live: AccrualSpec[] = closing.accrualsVerificationId ? await repo.listAccruals(tx, closing.accrualsVerificationId) : [];
        if (closing.accrualsBookedAt && sameAccrualSet(live, wanted)) {
          return {
            unchanged: true,
            verification: closing.accrualsVerificationId ? await repo.verificationRef(tx, closing.accrualsVerificationId) : null,
            reversalVerification: closing.accrualsReversalVerificationId
              ? await repo.verificationRef(tx, closing.accrualsReversalVerificationId)
              : null,
            cancelled: [],
            nextFiscalYearCreated,
          };
        }

        // R (and the omföring of a live R) lands on the next year's first
        // day: check that period before anything is posted.
        const next = await repo.findNextFiscalYear(tx, year.endDate);
        if (closing.accrualsVerificationId || wanted.length > 0) {
          if (!next) throw new NextFiscalYearMissingError(year.label);
          await assertPostablePeriod(tx, next.startDate);
        }

        const cancelled: repo.VerificationRef[] = [];
        if (closing.accrualsVerificationId && closing.accrualsReversalVerificationId) {
          cancelled.push(await cancelGuideVerification(tx, closing.id, closing.accrualsVerificationId, "accruals", userId));
          cancelled.push(await cancelGuideVerification(tx, closing.id, closing.accrualsReversalVerificationId, "accruals", userId));
        }

        let verification: repo.VerificationRef | null = null;
        let reversalVerification: repo.VerificationRef | null = null;
        if (wanted.length > 0) {
          const amounts = accrualAmounts(wanted);
          const document = `Bokslut ${year.label}`;
          const v = await deps.poster.postClosingEntry(
            tx,
            { date: closing.closingDate, description: `Periodiseringar bokslut ${year.label}`, amounts, source: "year_end_accruals", document },
            userId
          );
          // R is an ordinary booking in the next year — NOT linked through
          // reverses_verification_id (that would make it an omföring of V).
          const r = await deps.poster.postClosingEntry(
            tx,
            {
              date: next!.startDate,
              description: `Återföring av periodiseringar bokslut ${year.label} (${v.displayNumber})`,
              amounts: mirrorAmounts(amounts),
              source: "year_end_accrual_reversal",
              document,
            },
            userId
          );
          await repo.insertOwnership(tx, { verificationId: v.verificationId, closingId: closing.id, step: "accruals", role: "booking" });
          await repo.insertOwnership(tx, { verificationId: r.verificationId, closingId: closing.id, step: "accruals", role: "accrual_reversal" });
          await repo.insertAccruals(tx, closing.id, v.verificationId, wanted);
          verification = await repo.verificationRef(tx, v.verificationId);
          reversalVerification = await repo.verificationRef(tx, r.verificationId);
        }

        await repo.updateClosing(tx, closing.id, {
          accrualsVerificationId: verification?.id ?? null,
          accrualsReversalVerificationId: reversalVerification?.id ?? null,
          accrualsBookedAt: new Date(),
        });
        await writeAudit(
          tx,
          year.label,
          "accruals_booked",
          {
            rows: wanted,
            verification: verification?.displayNumber ?? null,
            reversal: reversalVerification?.displayNumber ?? null,
            cancelled: cancelled.map((ref) => ref.displayNumber),
            nextFiscalYearCreated,
          },
          userId
        );
        return { unchanged: false, verification, reversalVerification, cancelled, nextFiscalYearCreated };
      });
    },

    // The booking steg 5 would make now: the rows of resultTransferAmounts
    // (the one place the sign rule lives) for the result before any live
    // transfer — the same rows a done step booked.
    async previewResultTransfer(id: string) {
      const closing = await requireClosing(db, id);
      const year = await requireYear(db, closing.fiscalYearId);
      const view = await resultTransferView(db, closing, year);
      let rows: Awaited<ReturnType<typeof accountRows>> = [];
      if (view.yearResult !== 0) {
        const accounts = await resultTransferAccounts(db);
        rows = await accountRows(
          db,
          resultTransferAmounts({ net: view.yearResult, resultAccountId: accounts.result.id, equityAccountId: accounts.equity.id })
        );
      }
      return { ...view, rows };
    },

    // Steg 5: one verification 8999/2099 for the year's net. Re-run after a
    // change = omföring of the live transfer + a new one.
    async bookResultTransfer(id: string, userId: string) {
      return db.transaction(async (tx) => {
        const { closing, year } = await lockOpenClosing(tx, id);
        if (!closing.inventoryBookedAt) throw new YearEndStepOrderError("Lagerförändring");
        if ((await depreciationStepView(tx, closing)).missingAssets > 0) throw new YearEndStepOrderError("Avskrivningar");
        if (!closing.accrualsBookedAt) throw new YearEndStepOrderError("Periodiseringar");

        let net = await incomeStatementNet(tx, year);
        if (net === 0) {
          return {
            unchanged: true,
            verification: closing.resultTransferVerificationId ? await repo.verificationRef(tx, closing.resultTransferVerificationId) : null,
            cancelled: null,
            net: 0,
          };
        }
        // Resolved before the omföring so a missing account writes nothing.
        const accounts = await resultTransferAccounts(tx);
        const cancelled = closing.resultTransferVerificationId
          ? await cancelGuideVerification(tx, closing.id, closing.resultTransferVerificationId, "result_transfer", userId)
          : null;
        if (cancelled) net = await incomeStatementNet(tx, year);

        const amounts = resultTransferAmounts({ net, resultAccountId: accounts.result.id, equityAccountId: accounts.equity.id });
        let verification: repo.VerificationRef | null = null;
        if (amounts.length > 0) {
          const posted = await deps.poster.postClosingEntry(
            tx,
            {
              date: closing.closingDate,
              description: `Resultatöverföring bokslut ${year.label}`,
              amounts,
              source: "year_end_result_transfer",
              document: `Bokslut ${year.label}`,
            },
            userId
          );
          await repo.insertOwnership(tx, { verificationId: posted.verificationId, closingId: closing.id, step: "result_transfer", role: "booking" });
          verification = await repo.verificationRef(tx, posted.verificationId);
        }
        await repo.updateClosing(tx, closing.id, { resultTransferVerificationId: verification?.id ?? null });
        await writeAudit(
          tx,
          year.label,
          "result_transferred",
          { net, verification: verification?.displayNumber ?? null, cancelled: cancelled?.displayNumber ?? null },
          userId
        );
        return { unchanged: false, verification, cancelled, net };
      });
    },

    // Steg 6 (spec 4.7). The fiscal year row is updated BEFORE the checks:
    // the closed-year trigger takes FOR SHARE on it, so a booking in flight
    // finishes first and the checks below see it. Any blocker rolls the
    // status back with everything else.
    async closeYear(id: string, userId: string) {
      await db.transaction(async (tx) => {
        const closing = await repo.lockClosing(tx, id);
        if (!closing) throw new YearEndClosingNotFoundError(id);
        const year = await requireYear(tx, closing.fiscalYearId);
        if (closing.status !== "in_progress") throw new YearEndClosingClosedError(year.label);
        if (!(await repo.markFiscalYearClosed(tx, year.id, userId))) throw new FiscalYearClosedError(year.label);
        // Every check below is a later statement than that UPDATE, so under
        // READ COMMITTED it sees whatever the UPDATE waited for — a booking
        // in the year (the trigger's FOR SHARE) or a reopen of the previous
        // year (which holds this row FOR UPDATE): previous-year-open then
        // reads the reopened year.

        const close = await loadCloseBlockers(tx, closing, year);
        if (close.blockers.length > 0) throw new YearEndBlockedError(close.blockers.map((check) => check.message));

        const periodsLocked = await repo.lockAllPeriods(tx, year.id, userId);
        await repo.updateClosing(tx, closing.id, { status: "closed" });
        const warnings = await loadWarnings(tx, closing, year);
        const ref = async (verificationId: string | null) =>
          verificationId ? ((await repo.verificationRef(tx, verificationId))?.displayNumber ?? null) : null;
        await writeAudit(
          tx,
          year.label,
          "closed",
          {
            periodsLocked,
            warnings: warnings.map((check) => check.code),
            ibCheck: close.ib
              ? { nextFiscalYear: close.ib.nextFiscalYearLabel, accounts: close.ib.accounts, differences: close.ib.differences.length }
              : null,
            verifications: {
              inventory: await ref(closing.inventoryVerificationId),
              accruals: await ref(closing.accrualsVerificationId),
              accrualReversal: await ref(closing.accrualsReversalVerificationId),
              resultTransfer: await ref(closing.resultTransferVerificationId),
            },
          },
          userId
        );
      });
      return service.getClosing(id);
    },

    // Öppna igen (spec 4.8): year open → closing month unlocked → result
    // transfer reversed. Steps 2–4 stay; other months stay locked.
    async reopenYear(id: string, reason: string, userId: string) {
      await db.transaction(async (tx) => {
        const closing = await repo.lockClosing(tx, id);
        if (!closing) throw new YearEndClosingNotFoundError(id);
        const year = await requireYear(tx, closing.fiscalYearId);
        if (closing.status !== "closed") throw new YearEndClosingNotClosedError(year.label);
        // N+1's row FOR UPDATE, read under the lock: a close of N+1 in flight
        // finishes first and is seen; one that starts later waits for this
        // transaction and then sees N open (previous-year-open).
        const nextCovering = await repo.findNextFiscalYear(tx, year.endDate);
        const next = nextCovering ? await repo.lockFiscalYear(tx, nextCovering.id) : null;
        if (next?.status === "closed") throw new NextFiscalYearClosedError(next.label);
        if (await repo.findActiveDisposition(tx, closing.id)) throw new ProfitDispositionActiveError(year.label);

        // Open first: both closed-year triggers then allow the unlock and the omföring.
        await repo.markFiscalYearOpen(tx, year.id);
        const period = await repo.findPeriodForDate(tx, closing.closingDate);
        if (!period) throw new Error(`No period covers ${closing.closingDate}`);
        await repo.unlockPeriodById(tx, period.id);
        const cancelled = closing.resultTransferVerificationId
          ? await cancelGuideVerification(tx, closing.id, closing.resultTransferVerificationId, "result_transfer", userId)
          : null;
        await repo.updateClosing(tx, closing.id, { status: "in_progress", resultTransferVerificationId: null });
        const month = period.startDate.slice(0, 7);
        await writeAudit(
          tx,
          year.label,
          "reopened",
          { reason, cancelledResultTransfer: cancelled?.displayNumber ?? null, unlockedPeriod: month },
          userId
        );
        // The period's own history shows the unlock too (same entity id as
        // economyService.unlockPeriod).
        await tx.insert(auditLog).values({
          entityType: "accounting_period",
          entityId: `${year.label}-${month}`,
          action: "unlocked",
          detail: { reason: `Bokslut öppnat igen: ${reason}` },
          userId,
        });
      });
      return service.getClosing(id);
    },

    async previewProfitDisposition(id: string, input: ProfitDispositionInput) {
      const closing = await requireClosing(db, id);
      const year = await requireYear(db, closing.fiscalYearId);
      const plan = await dispositionPlan(db, year, input);
      return {
        resultAmount: plan.resultAmount,
        dividend: plan.dividend,
        freeEquity: plan.freeEquity,
        rows: await accountRows(db, plan.amounts),
        warnings: plan.warnings,
      };
    },

    // Vinstdisposition (spec 4.9): on a CLOSED closing, in the AGM year, once
    // (lock + partial unique index profit_dispositions_one_active).
    async bookProfitDisposition(id: string, input: ProfitDispositionInput, userId: string) {
      return db.transaction(async (tx) => {
        const { closing, year } = await requireClosedClosing(tx, id);
        if (await repo.findActiveDisposition(tx, closing.id)) throw new ProfitDispositionExistsError(year.label);
        const plan = await dispositionPlan(tx, year, input);
        await assertPostablePeriod(tx, input.agmDate);
        const posted = await deps.poster.postClosingEntry(
          tx,
          {
            date: input.agmDate,
            description: `Vinstdisposition ${year.label} (stämma ${input.agmDate})`,
            amounts: plan.amounts,
            source: "year_end_profit_disposition",
            document: `Bokslut ${year.label}`,
          },
          userId
        );
        await repo.insertOwnership(tx, { verificationId: posted.verificationId, closingId: closing.id, step: "profit_disposition", role: "booking" });
        let row: repo.DispositionRow;
        try {
          row = await repo.insertDisposition(tx, {
            closingId: closing.id,
            agmDate: input.agmDate,
            resultAmount: plan.resultAmount,
            dividendAmount: plan.dividend,
            verificationId: posted.verificationId,
            createdBy: userId,
          });
        } catch (err) {
          if (isUniqueViolation(err)) throw new ProfitDispositionExistsError(year.label);
          throw err;
        }
        const verification = (await repo.verificationRef(tx, posted.verificationId))!;
        await writeAudit(
          tx,
          year.label,
          "profit_disposition_booked",
          { agmDate: input.agmDate, resultAmount: plan.resultAmount, dividend: plan.dividend, verification: verification.displayNumber },
          userId
        );
        return {
          disposition: { id: row.id, agmDate: row.agmDate, resultAmount: plan.resultAmount, dividendAmount: plan.dividend, verification },
          verification,
          warnings: plan.warnings,
        };
      });
    },

    async undoProfitDisposition(id: string, userId: string) {
      return db.transaction(async (tx) => {
        const closing = await repo.lockClosing(tx, id);
        if (!closing) throw new YearEndClosingNotFoundError(id);
        const year = await requireYear(tx, closing.fiscalYearId);
        const disposition = await repo.findActiveDisposition(tx, closing.id);
        if (!disposition) throw new ProfitDispositionNotFoundError(year.label);
        const reversal = await cancelGuideVerification(tx, closing.id, disposition.verificationId, "profit_disposition", userId);
        await repo.markDispositionReversed(tx, disposition.id, reversal.id);
        await writeAudit(tx, year.label, "profit_disposition_undone", { reversal: reversal.displayNumber }, userId);
        return { reversalVerification: reversal };
      });
    },

    async bookInventory(id: string, input: BookInventoryInput, userId: string) {
      return db.transaction(async (tx) => {
        const { closing, year } = await lockOpenClosing(tx, id);
        const calc = await computeInventory(tx, closing, input.method);
        if (calc.unchanged) {
          return {
            unchanged: true,
            verification: closing.inventoryVerificationId ? await repo.verificationRef(tx, closing.inventoryVerificationId) : null,
            cancelled: null,
            value: calc.value,
            difference: 0,
          };
        }
        const cancelled = closing.inventoryVerificationId
          ? await cancelGuideVerification(tx, closing.id, closing.inventoryVerificationId, "inventory", userId)
          : null;
        let verification: repo.VerificationRef | null = null;
        if (calc.amounts.length > 0) {
          const posted = await deps.poster.postClosingEntry(
            tx,
            {
              date: closing.closingDate,
              description: `Lagerförändring bokslut ${year.label} (${METHOD_LABELS[input.method]})`,
              amounts: calc.amounts,
              source: "year_end_inventory",
              document: `Bokslut ${year.label}`,
            },
            userId
          );
          await repo.insertOwnership(tx, { verificationId: posted.verificationId, closingId: closing.id, step: "inventory", role: "booking" });
          verification = await repo.verificationRef(tx, posted.verificationId);
        }
        await repo.updateClosing(tx, closing.id, {
          inventoryMethod: input.method,
          inventoryValue: String(calc.value),
          inventoryVerificationId: verification?.id ?? null,
          inventoryBookedAt: new Date(),
        });
        await writeAudit(
          tx,
          year.label,
          "inventory_booked",
          {
            method: input.method,
            value: calc.value,
            ledgerBefore: calc.ledgerExcludingStep,
            difference: calc.difference,
            verification: verification?.displayNumber ?? null,
            cancelled: cancelled?.displayNumber ?? null,
          },
          userId
        );
        return { unchanged: false, verification, cancelled, value: calc.value, difference: calc.difference };
      });
    },
  };

  return service;
}

export type YearEndClosingService = ReturnType<typeof createYearEndClosingService>;
