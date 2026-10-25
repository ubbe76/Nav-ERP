import { sql } from "drizzle-orm";
import { auditLog, type Db, type Tx } from "@navet/db";
import {
  round2,
  type CreateFixedAssetCategoryInput,
  type CreateFixedAssetInput,
  type DisposeFixedAssetInput,
  type ListFixedAssetsQuery,
  type UpdateFixedAssetCategoryInput,
  type UpdateFixedAssetInput,
} from "@navet/shared";
import { getNextOrderNumber } from "../../system/service/number-series.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import * as repo from "../repository/fixed-asset.repository.js";
import { BAS_FIXED_ASSET_CATEGORIES } from "./bas-accounts.js";
import { AccountNotFoundError, AlreadyReversedError, InactiveAccountError } from "./economy.service.js";
import { resolveDimensions } from "./dimension-check.js";
import {
  disposalAmounts,
  disposalPostingRows,
  lastDepreciationMonth,
  missingMonths,
  monthEnd,
  monthKey,
  monthStart,
  openingDepreciationOf,
  withOpeningDepreciation,
  type BookedEntry,
  type DepreciationPlanInput,
  type OpeningDepreciationFields,
  type PlannedDepreciation,
} from "./depreciation-schedule.js";
import { formatNumber, type DocumentPdfService, type FixedAssetPlanPdfInput } from "../../mail/service/document-pdf.js";
import { readAccountBalances } from "./account-balances.js";
import { buildFixedAssetPlan, type FixedAssetPlan, type PlanAssetInput } from "./fixed-asset-plan.js";
import { buildFixedAssetPlanCsv } from "./fixed-asset-plan-csv.js";
import { assertPostablePeriod, type VerificationPoster } from "./verification-poster.js";

// Anläggningsregister (ekonomi etapp 2, delprojekt 2). Owns every status
// transition and every bookkeeping path of the register; the poster books,
// the repository reads/writes, depreciation-schedule.ts does the arithmetic.

// --- Errors (codes derived by errorBody; HTTP mapping in fixed-asset.routes.ts) ---

export class FixedAssetCategoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Fixed asset category ${id} not found`);
    this.name = "FixedAssetCategoryNotFoundError";
  }
}

export class DuplicateFixedAssetCategoryNameError extends Error {
  constructor(name: string) {
    super(`A fixed asset category named "${name}" already exists`);
    this.name = "DuplicateFixedAssetCategoryNameError";
  }
}

export class FixedAssetCategoryInUseError extends Error {
  constructor(id: string) {
    super(`Fixed asset category ${id} still has assets`);
    this.name = "FixedAssetCategoryInUseError";
  }
}

export class FixedAssetCategoryAccountsNotDistinctError extends Error {
  constructor() {
    super("The asset, accumulated depreciation and expense accounts must be three different accounts");
    this.name = "FixedAssetCategoryAccountsNotDistinctError";
  }
}

// The asset, accumulated-depreciation and expense accounts are what the
// group's depreciation (and its opening amounts) sit on in the ledger;
// pointing the group elsewhere after the fact would make the register's
// reconciliation read the wrong accounts. Gain/loss accounts, name and
// useful life stay editable.
export class FixedAssetCategoryAccountsLockedError extends Error {
  constructor(public field: string) {
    super(`${field} cannot be changed once the group has booked depreciation or opening depreciation`);
    this.name = "FixedAssetCategoryAccountsLockedError";
  }
}

export class FixedAssetBasAccountMissingError extends Error {
  constructor(public accountNumber: string) {
    super(`BAS account ${accountNumber} is missing or inactive — run Förifyll BAS-urval in the chart of accounts first`);
    this.name = "FixedAssetBasAccountMissingError";
  }
}

export class FixedAssetNotFoundError extends Error {
  constructor(id: string) {
    super(`Fixed asset ${id} not found`);
    this.name = "FixedAssetNotFoundError";
  }
}

export class SupplierInvoiceNotFoundError extends Error {
  constructor(id: string) {
    super(`Supplier invoice ${id} not found`);
    this.name = "SupplierInvoiceNotFoundError";
  }
}

// acquisitionDate/acquisitionCost/depreciationStartMonth/categoryId define
// what has already been booked — changing them would make booked rows and
// verifications wrong after the fact.
export class FixedAssetFieldLockedError extends Error {
  constructor(public field: string) {
    super(`${field} cannot be changed once a depreciation has been booked`);
    this.name = "FixedAssetFieldLockedError";
  }
}

export class FixedAssetNotActiveError extends Error {
  constructor(assetNumber: string) {
    super(`Fixed asset ${assetNumber} is disposed`);
    this.name = "FixedAssetNotActiveError";
  }
}

export class FixedAssetHasDepreciationError extends Error {
  constructor(assetNumber: string) {
    super(`Fixed asset ${assetNumber} has booked depreciations and cannot be deleted`);
    this.name = "FixedAssetHasDepreciationError";
  }
}

// Prospective useful-life/start edits must leave at least one month after the
// last booked one while a base remains — otherwise missingMonths() would
// return [] forever and the asset could never finish depreciating.
export class FixedAssetLifeTooShortError extends Error {
  constructor(public lastBookedMonth: string) {
    super(`The plan would end on or before ${lastBookedMonth}, the last booked month, while depreciable value remains`);
    this.name = "FixedAssetLifeTooShortError";
  }
}

export class InvalidFixedAssetValuesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFixedAssetValuesError";
  }
}

// Ingående avskrivning that contradicts the plan (see assertOpeningDepreciation).
export class InvalidOpeningDepreciationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOpeningDepreciationError";
  }
}

// Avskrivningar förbokas inte: the month must have ended (Stockholm time).
export class DepreciationMonthInFutureError extends Error {
  constructor(month: string) {
    super(`Depreciation cannot be booked for ${month}: the month has not ended`);
    this.name = "DepreciationMonthInFutureError";
  }
}

export class NothingToDepreciateError extends Error {
  constructor(month: string) {
    super(`No depreciation is missing through ${month}`);
    this.name = "NothingToDepreciateError";
  }
}

export class DepreciationRunNotFoundError extends Error {
  constructor(id: string) {
    super(`Depreciation run ${id} not found`);
    this.name = "DepreciationRunNotFoundError";
  }
}

export class DepreciationRunNotLatestError extends Error {
  constructor(id: string) {
    super(`Depreciation run ${id} is not the latest — undo later runs first`);
    this.name = "DepreciationRunNotLatestError";
  }
}

export class DisposalRunNotUndoableError extends Error {
  constructor(id: string) {
    super(`Depreciation run ${id} belongs to a disposal and cannot be undone`);
    this.name = "DisposalRunNotUndoableError";
  }
}

// An ordinary run whose rows belong to a since-disposed asset: the disposal
// verification took that asset's accumulated depreciation off the books, so
// superseding the rows would leave the ack-konto debit uncleared and the
// card, the plan and the ledger disagreeing forever. A disposal with
// nothing to catch up leaves no run row of its own, so the latest-run and
// disposal-run checks cannot see this case.
export class RunPrecedesDisposalError extends Error {
  constructor(id: string) {
    super(`Depreciation run ${id} has rows for a disposed asset and cannot be undone`);
    this.name = "RunPrecedesDisposalError";
  }
}

export class InvalidDisposalDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDisposalDateError";
  }
}

export interface FixedAssetServiceDeps {
  db: Db;
  poster: VerificationPoster;
  audit: AuditWriter;
  pdf: DocumentPdfService;
}

type CategoryAccountFields = Pick<
  CreateFixedAssetCategoryInput,
  | "assetAccountId"
  | "accumulatedDepreciationAccountId"
  | "depreciationExpenseAccountId"
  | "disposalGainAccountId"
  | "disposalLossAccountId"
>;

function assertDistinctCategoryAccounts(fields: CategoryAccountFields): void {
  const { assetAccountId, accumulatedDepreciationAccountId, depreciationExpenseAccountId } = fields;
  if (
    assetAccountId === accumulatedDepreciationAccountId ||
    depreciationExpenseAccountId === assetAccountId ||
    depreciationExpenseAccountId === accumulatedDepreciationAccountId
  ) {
    throw new FixedAssetCategoryAccountsNotDistinctError();
  }
}

export interface FixedAssetDetail extends repo.FixedAssetRow {
  category: repo.FixedAssetCategoryRow;
  depreciations: repo.AssetDepreciationRow[];
  // The remaining plan (next month → last month of the useful life); empty
  // once disposed or fully depreciated.
  plannedMonths: PlannedDepreciation[];
  accumulatedDepreciation: number;
  bookValue: number;
  bookedMonthCount: number;
  disposalVerification: { id: string; displayNumber: string; date: string } | null;
  supplierInvoice: { id: string; registrationNumber: string } | null;
}

// The opening amount and its through-month decide where the first run began
// and what it spread, so they are as locked as the cost once a row exists.
const LOCKED_AFTER_DEPRECIATION = [
  "acquisitionDate",
  "acquisitionCost",
  "depreciationStartMonth",
  "categoryId",
  "openingDepreciation",
  "openingDepreciationThroughMonth",
] as const;

// The group accounts that carry booked amounts (see
// FixedAssetCategoryAccountsLockedError); gain/loss are only touched by a
// disposal, which snapshots nothing and can use whatever they point at then.
const POSTING_ACCOUNT_KEYS = ["assetAccountId", "accumulatedDepreciationAccountId", "depreciationExpenseAccountId"] as const;

// Serializes runs, undos and disposals globally (B5's vat_settlements idiom).
// Without it two concurrent runs both read the same "missing months" and the
// second hits the unique index with a raw 23505; with it the second sees
// the first's rows and finds nothing to book. Asset edits and deletes take
// the same lock first, so a run can never commit between their checks and
// their writes (a locked-field change slipping past, or the has-depreciation
// 409 turning into a restrict-FK 500).
export const DEPRECIATION_LOCK_SQL = sql`SELECT pg_advisory_xact_lock(hashtext('fixed_asset_depreciations'))`;

export function currentMonthStockholm(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date()).slice(0, 7);
}

// Ordinary runs (dated the month's last day) need a month that has ended;
// a disposal's catch-up (dated on the disposal day, which validateDisposal
// keeps at or before today) may run through the current month.
export function isBookableMonth(throughMonth: string, disposalCatchUp: boolean): boolean {
  const current = currentMonthStockholm();
  return disposalCatchUp ? throughMonth <= current : throughMonth < current;
}

export function periodStatusFor(periods: repo.PeriodBounds[], date: string): "open" | "locked" | "none" {
  const period = periods.find((p) => p.startDate <= date && p.endDate >= date);
  return period ? period.status : "none";
}

export interface PlannedAssetDepreciation {
  assetId: string;
  assetNumber: string;
  name: string;
  categoryId: string;
  categoryName: string;
  months: PlannedDepreciation[];
  // Months whose own period is locked or missing — booked anyway, on the
  // run's date.
  catchUpMonths: string[];
  amount: number;
}

export interface DepreciationCategoryTotal {
  categoryId: string;
  categoryName: string;
  expenseAccountId: string;
  expenseAccountNumber: string;
  accumulatedAccountId: string;
  accumulatedAccountNumber: string;
  // Kostnadsställe (förval) of the group — on the expense row.
  costCenterId: string | null;
  amount: number;
}

export type DepreciationWarning = "period-locked" | "no-period" | "month-in-future" | "inactive-account";

// A group account the run would post to that has been deactivated in the
// chart of accounts (allowed there; the poster refuses with 409
// missing-posting-account). Surfaced in the preview so the user sees which
// account and group to fix before booking.
export interface InactiveAccountWarning {
  accountNumber: string;
  accountName: string;
  categoryName: string;
  role: "expense" | "accumulated";
}

export interface DepreciationPreview {
  throughMonth: string;
  date: string;
  periodStatus: "open" | "locked" | "none";
  lastRun: { id: string; throughMonth: string; displayNumber: string; date: string } | null;
  assets: PlannedAssetDepreciation[];
  byCategory: DepreciationCategoryTotal[];
  total: number;
  warnings: DepreciationWarning[];
  inactiveAccounts: InactiveAccountWarning[];
}

export interface DepreciationRunResult {
  run: { id: string; throughMonth: string; createdAt: Date };
  verification: { id: string; displayNumber: string };
  rows: { assetId: string; assetNumber: string; month: string; amount: number }[];
  byCategory: DepreciationCategoryTotal[];
  total: number;
}

export interface RunDepreciationInput {
  throughMonth: string; // "YYYY-MM"
  // A disposal's catch-up: only that asset, verification dated on the
  // disposal day. Omitted = a regular run over every active asset, dated
  // the month's last day.
  scope?: { assetId: string; date: string };
  // Årsbokslut (delprojekt 3): date the regular run on the closing date
  // instead of the month's last day. Bookable once that DAY has passed.
  date?: string;
}

export type DisposalWarning = "intermediate-account-not-box-05";

export interface DisposalPreview {
  asset: { id: string; assetNumber: string; name: string };
  disposalType: "sale" | "scrap";
  disposalDate: string;
  catchUpMonths: PlannedDepreciation[];
  accumulatedDepreciation: number;
  bookValue: number;
  disposalPrice: number;
  gain: number;
  loss: number;
  rows: { accountNumber: string; accountName: string; debit: number; credit: number }[];
  warnings: DisposalWarning[];
}

export function stockholmToday(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
}

// `booked` is the asset's LIVE rows; the opening amount (ingående
// avskrivning) is prepended here, so no caller of the plan rule can forget it.
export function planInput(asset: repo.FixedAssetRow, booked: repo.BookedMonth[]): DepreciationPlanInput {
  return {
    acquisitionCost: Number(asset.acquisitionCost),
    residualValue: Number(asset.residualValue),
    usefulLifeMonths: asset.usefulLifeMonths,
    depreciationStartMonth: monthKey(asset.depreciationStartMonth),
    bookedMonths: withOpeningDepreciation(asset, booked),
  };
}

// The stored value in the same shape the patch uses, so "changed" means
// changed (a PATCH re-sending 120000 for "120000.00" is not a change).
function currentValue(asset: repo.FixedAssetRow, key: keyof UpdateFixedAssetInput): unknown {
  switch (key) {
    case "acquisitionCost":
      return Number(asset.acquisitionCost);
    case "residualValue":
      return Number(asset.residualValue);
    case "openingDepreciation":
      return Number(asset.openingDepreciation);
    case "depreciationStartMonth":
      return monthKey(asset.depreciationStartMonth);
    case "openingDepreciationThroughMonth":
      return asset.openingDepreciationThroughMonth === null ? null : monthKey(asset.openingDepreciationThroughMonth);
    default:
      return asset[key];
  }
}

interface OpeningDepreciationCheck extends OpeningDepreciationFields {
  openingDepreciation: number;
  openingDepreciationThroughMonth: string | null; // "YYYY-MM"
  depreciationStartMonth: string; // "YYYY-MM"
  usefulLifeMonths: number;
  acquisitionCost: number;
  residualValue: number;
}

// The opening amount is history that the plan must be able to continue
// from: paired with its month, inside the plan's months, before the current
// month, within the base — and never leaving a remainder that no month can
// take (through-month = plan's last month while value remains would make
// missingMonths() return [] forever, the same dead end
// FixedAssetLifeTooShortError guards for live rows).
function assertOpeningDepreciation(values: OpeningDepreciationCheck): void {
  const { openingDepreciation: amount, openingDepreciationThroughMonth: through } = values;
  if ((amount > 0) !== (through !== null)) {
    throw new InvalidOpeningDepreciationError("openingDepreciation and openingDepreciationThroughMonth must be set together");
  }
  if (through === null) return;
  if (through < values.depreciationStartMonth) {
    throw new InvalidOpeningDepreciationError("openingDepreciationThroughMonth must not be before depreciationStartMonth");
  }
  const lastMonth = lastDepreciationMonth(values.depreciationStartMonth, values.usefulLifeMonths);
  if (through > lastMonth) {
    throw new InvalidOpeningDepreciationError(`openingDepreciationThroughMonth must not be after ${lastMonth}, the last month of the useful life`);
  }
  if (through >= currentMonthStockholm()) {
    throw new InvalidOpeningDepreciationError("openingDepreciationThroughMonth must be a past month");
  }
  const base = round2(values.acquisitionCost - values.residualValue);
  if (amount > base) {
    throw new InvalidOpeningDepreciationError("openingDepreciation must not exceed acquisitionCost − residualValue");
  }
  if (amount < base && through === lastMonth) {
    throw new InvalidOpeningDepreciationError(
      `openingDepreciationThroughMonth ${through} is the last month of the useful life while depreciable value remains`
    );
  }
}

export class FixedAssetPlanYearNotFoundError extends Error {
  constructor(id: string) {
    super(`Fiscal year ${id} not found`);
    this.name = "FixedAssetPlanYearNotFoundError";
  }
}

// "1220 Inventarier och verktyg: stämmer" / "…: huvudbok 220 000,00,
// register 200 000,00 (skillnad +20 000,00)" — the PDF's reconciliation
// lines; the web renders the structured rows itself.
export function reconciliationLine(row: FixedAssetPlan["reconciliation"][number]): string {
  const label = `${row.accountNumber} ${row.accountName}`;
  if (!row.mismatch) return `${label}: stämmer (${formatNumber(row.registerAmount)})`;
  const sign = row.difference > 0 ? "+" : "";
  return `${label}: huvudbok ${formatNumber(row.ledgerAmount)}, register ${formatNumber(row.registerAmount)} (skillnad ${sign}${formatNumber(row.difference)})`;
}

export function createFixedAssetService(deps: FixedAssetServiceDeps) {
  const { db, audit } = deps;

  async function requireActiveAccount(id: string): Promise<repo.AccountRef> {
    const account = await repo.findAccountRef(db, id);
    if (!account) throw new AccountNotFoundError(id);
    if (!account.active) throw new InactiveAccountError(id);
    return account;
  }

  // The plan for one run, computed from whatever executor the caller holds:
  // the preview reads through the plain db, the run through its own tx
  // (under the advisory lock, so what it reads is what it books).
  async function planRun(executor: Db | Tx, throughMonth: string, scopeAssetId?: string) {
    const candidates = await repo.listDepreciableAssets(executor, monthStart(throughMonth), scopeAssetId);
    const bookedByAsset = await repo.listActiveDepreciationsByAsset(
      executor,
      candidates.map((asset) => asset.id)
    );
    const periods = await repo.loadPeriods(executor);
    const assets: PlannedAssetDepreciation[] = [];
    const categories = new Map<string, DepreciationCategoryTotal>();
    const inactiveAccounts = new Map<string, InactiveAccountWarning>();
    for (const asset of candidates) {
      const months = missingMonths(planInput(asset, bookedByAsset.get(asset.id) ?? []), throughMonth);
      if (months.length === 0) continue;
      if (!asset.category.expenseAccountActive) {
        inactiveAccounts.set(`${asset.categoryId}:expense`, {
          accountNumber: asset.category.expenseAccountNumber,
          accountName: asset.category.expenseAccountName,
          categoryName: asset.category.name,
          role: "expense",
        });
      }
      if (!asset.category.accumulatedAccountActive) {
        inactiveAccounts.set(`${asset.categoryId}:accumulated`, {
          accountNumber: asset.category.accumulatedAccountNumber,
          accountName: asset.category.accumulatedAccountName,
          categoryName: asset.category.name,
          role: "accumulated",
        });
      }
      const amount = round2(months.reduce((sum, row) => sum + row.amount, 0));
      assets.push({
        assetId: asset.id,
        assetNumber: asset.assetNumber,
        name: asset.name,
        categoryId: asset.categoryId,
        categoryName: asset.category.name,
        months,
        catchUpMonths: months.filter((row) => periodStatusFor(periods, monthEnd(row.month)) !== "open").map((row) => row.month),
        amount,
      });
      const bucket = categories.get(asset.categoryId) ?? {
        categoryId: asset.categoryId,
        categoryName: asset.category.name,
        expenseAccountId: asset.category.depreciationExpenseAccountId,
        expenseAccountNumber: asset.category.expenseAccountNumber,
        accumulatedAccountId: asset.category.accumulatedDepreciationAccountId,
        accumulatedAccountNumber: asset.category.accumulatedAccountNumber,
        costCenterId: asset.category.defaultCostCenterId,
        amount: 0,
      };
      bucket.amount = round2(bucket.amount + amount);
      categories.set(asset.categoryId, bucket);
    }
    const byCategory = [...categories.values()];
    return {
      assets,
      byCategory,
      total: round2(byCategory.reduce((sum, row) => sum + row.amount, 0)),
      inactiveAccounts: [...inactiveAccounts.values()],
    };
  }

  // Σ accumulated depreciation = live rows + the opening amount (Task 4b).
  // Never the rows alone: a pre-Nav asset's opening amount would otherwise
  // stay on the ack account forever after the disposal.
  function accumulatedOf(asset: repo.FixedAssetRow, booked: repo.BookedMonth[], extra: PlannedDepreciation[] = []): number {
    return round2([...withOpeningDepreciation(asset, booked), ...extra].reduce((sum, row) => sum + row.amount, 0));
  }

  async function validateDisposal(
    executor: Db | Tx,
    asset: repo.FixedAssetRow,
    input: DisposeFixedAssetInput
  ): Promise<{ intermediate: repo.AccountRef | null; warnings: DisposalWarning[] }> {
    if (asset.status !== "active") throw new FixedAssetNotActiveError(asset.assetNumber);
    if (input.disposalDate < asset.acquisitionDate) throw new InvalidDisposalDateError("The disposal date cannot be before the acquisition date");
    if (input.disposalDate > stockholmToday()) throw new InvalidDisposalDateError("The disposal date cannot be in the future");
    if (input.disposalType !== "sale") return { intermediate: null, warnings: [] };
    const intermediate = await repo.findAccountRef(executor, input.intermediateAccountId);
    if (!intermediate) throw new AccountNotFoundError(input.intermediateAccountId);
    if (!intermediate.active) throw new InactiveAccountError(input.intermediateAccountId);
    // Spec 3.6a: non-blocking — a momsfri sale may legitimately use another box.
    return { intermediate, warnings: intermediate.vatBox === "05" ? [] : ["intermediate-account-not-box-05"] };
  }

  // The exact rows the poster will book: disposalPostingRows mapped to the
  // category's accounts, netted per account like the accumulator does.
  function previewRows(
    category: repo.FixedAssetCategoryRow,
    intermediate: repo.AccountRef | null,
    amounts: { acquisitionCost: number; accumulatedDepreciation: number; disposalPrice: number }
  ) {
    const byRole = {
      asset: category.accounts.asset,
      accumulated: category.accounts.accumulated,
      gain: category.accounts.gain,
      loss: category.accounts.loss,
      intermediate,
    };
    const net = new Map<string, { account: repo.AccountRef; amount: number }>();
    for (const row of disposalPostingRows(amounts)) {
      const account = byRole[row.role];
      if (!account) throw new Error("A disposal with a price needs an intermediate account");
      const current = net.get(account.id) ?? { account, amount: 0 };
      current.amount = round2(current.amount + row.amount);
      net.set(account.id, current);
    }
    return [...net.values()]
      .filter((row) => row.amount !== 0)
      .map((row) => ({
        accountNumber: row.account.number,
        accountName: row.account.name,
        debit: row.amount > 0 ? row.amount : 0,
        credit: row.amount < 0 ? -row.amount : 0,
      }));
  }

  const service = {
    // --- Tillgångsgrupper ---

    async listCategories() {
      return repo.listCategories(db);
    },

    async createCategory(input: CreateFixedAssetCategoryInput) {
      assertDistinctCategoryAccounts(input);
      // Kostnadsställe (förval): must exist and be active.
      await resolveDimensions(db, { costCenterId: input.defaultCostCenterId });
      for (const id of [
        input.assetAccountId,
        input.accumulatedDepreciationAccountId,
        input.depreciationExpenseAccountId,
        input.disposalGainAccountId,
        input.disposalLossAccountId,
      ]) {
        await requireActiveAccount(id);
      }
      let row;
      try {
        row = await repo.insertCategory(db, input);
      } catch (err) {
        if (isUniqueViolation(err)) throw new DuplicateFixedAssetCategoryNameError(input.name);
        throw err;
      }
      await audit.log({ entityType: "fixed_asset_category", entityId: row.name, action: "created", detail: input });
      return (await repo.findCategoryById(db, row.id))!;
    },

    // Check and write under the run lock (updateAsset's reasoning): a run
    // committing between "nothing booked yet" and the UPDATE could otherwise
    // repoint the posting accounts under freshly booked rows.
    async updateCategory(id: string, input: UpdateFixedAssetCategoryInput) {
      const existing = await db.transaction(async (tx) => {
        await tx.execute(DEPRECIATION_LOCK_SQL);
        const existing = await repo.findCategoryById(tx, id);
        if (!existing) throw new FixedAssetCategoryNotFoundError(id);
        const merged = { ...existing, ...input };
        assertDistinctCategoryAccounts(merged);
        const changedAccountKeys = (
          [
            "assetAccountId",
            "accumulatedDepreciationAccountId",
            "depreciationExpenseAccountId",
            "disposalGainAccountId",
            "disposalLossAccountId",
          ] as const
        ).filter((key) => input[key] !== undefined && input[key] !== existing[key]);
        if (existing.postingAccountsLocked) {
          const locked = changedAccountKeys.find((key) => (POSTING_ACCOUNT_KEYS as readonly string[]).includes(key));
          if (locked) throw new FixedAssetCategoryAccountsLockedError(locked);
        }
        for (const key of changedAccountKeys) {
          const account = await repo.findAccountRef(tx, input[key]!);
          if (!account) throw new AccountNotFoundError(input[key]!);
          if (!account.active) throw new InactiveAccountError(input[key]!);
        }
        // Kostnadsställe (förval): a new choice must be active; the kept one may stay.
        if (input.defaultCostCenterId !== undefined) {
          await resolveDimensions(tx, { costCenterId: input.defaultCostCenterId }, { existing: { costCenterId: existing.defaultCostCenterId, projectId: null } });
        }
        try {
          await repo.updateCategory(tx, id, input);
        } catch (err) {
          if (isUniqueViolation(err)) throw new DuplicateFixedAssetCategoryNameError(input.name ?? existing.name);
          throw err;
        }
        return existing;
      });
      await audit.log({ entityType: "fixed_asset_category", entityId: existing.name, action: "updated", detail: input });
      return (await repo.findCategoryById(db, id))!;
    },

    async deleteCategory(id: string) {
      const existing = await repo.findCategoryById(db, id);
      if (!existing) throw new FixedAssetCategoryNotFoundError(id);
      try {
        await repo.deleteCategory(db, id);
      } catch (err) {
        if (isForeignKeyViolation(err)) throw new FixedAssetCategoryInUseError(id);
        throw err;
      }
      await audit.log({ entityType: "fixed_asset_category", entityId: existing.name, action: "deleted" });
    },

    // Förifyll BAS-grupper: idempotent on name, all-or-nothing on accounts.
    async seedBasCategories(): Promise<{ created: string[]; skipped: string[] }> {
      return db.transaction(async (tx) => {
        const numbers = [
          ...new Set(
            BAS_FIXED_ASSET_CATEGORIES.flatMap((category) => [
              category.assetAccount,
              category.accumulatedAccount,
              category.expenseAccount,
              category.gainAccount,
              category.lossAccount,
            ])
          ),
        ];
        const refs = await repo.findAccountRefsByNumbers(tx, numbers);
        const resolve = (number: string) => {
          const ref = refs.get(number);
          if (!ref || !ref.active) throw new FixedAssetBasAccountMissingError(number);
          return ref.id;
        };
        const created: string[] = [];
        const skipped: string[] = [];
        for (const category of BAS_FIXED_ASSET_CATEGORIES) {
          if (await repo.findCategoryByName(tx, category.name)) {
            skipped.push(category.name);
            continue;
          }
          await repo.insertCategory(tx, {
            name: category.name,
            assetAccountId: resolve(category.assetAccount),
            accumulatedDepreciationAccountId: resolve(category.accumulatedAccount),
            depreciationExpenseAccountId: resolve(category.expenseAccount),
            disposalGainAccountId: resolve(category.gainAccount),
            disposalLossAccountId: resolve(category.lossAccount),
            defaultUsefulLifeMonths: category.usefulLifeMonths,
          });
          created.push(category.name);
        }
        return { created, skipped };
      });
    },

    // --- Anläggningar ---

    async listAssets(query: ListFixedAssetsQuery) {
      return repo.listAssets(db, query);
    },

    async getAsset(id: string): Promise<FixedAssetDetail> {
      const asset = await repo.findAssetById(db, id);
      if (!asset) throw new FixedAssetNotFoundError(id);
      const category = await repo.findCategoryById(db, asset.categoryId);
      if (!category) throw new FixedAssetCategoryNotFoundError(asset.categoryId);
      const depreciations = await repo.listAssetDepreciations(db, id);
      const live = depreciations.filter((row) => !row.reversed).map((row) => ({ month: row.month, amount: row.amount }));
      const accumulatedDepreciation = round2(withOpeningDepreciation(asset, live).reduce((sum, row) => sum + row.amount, 0));
      const plannedMonths =
        asset.status === "active"
          ? missingMonths(planInput(asset, live), lastDepreciationMonth(monthKey(asset.depreciationStartMonth), asset.usefulLifeMonths))
          : [];
      return {
        ...asset,
        category,
        depreciations,
        plannedMonths,
        accumulatedDepreciation,
        bookValue: round2(Number(asset.acquisitionCost) - accumulatedDepreciation),
        // Live rows only — the opening amount is not a row.
        bookedMonthCount: live.length,
        disposalVerification: asset.disposalVerificationId ? await repo.findVerificationDisplay(db, asset.disposalVerificationId) : null,
        supplierInvoice: asset.supplierInvoiceId ? await repo.supplierInvoiceRef(db, asset.supplierInvoiceId) : null,
      };
    },

    // residualValue/openingDepreciation are optional here: the zod defaults
    // only run in the route.
    async createAsset(
      input: Omit<CreateFixedAssetInput, "residualValue" | "openingDepreciation"> & { residualValue?: number; openingDepreciation?: number },
      userId: string
    ): Promise<FixedAssetDetail> {
      const category = await repo.findCategoryById(db, input.categoryId);
      if (!category) throw new FixedAssetCategoryNotFoundError(input.categoryId);
      if (input.supplierInvoiceId && !(await repo.supplierInvoiceRef(db, input.supplierInvoiceId))) {
        throw new SupplierInvoiceNotFoundError(input.supplierInvoiceId);
      }
      const startMonth = input.depreciationStartMonth ?? monthKey(input.acquisitionDate);
      const opening = {
        openingDepreciation: input.openingDepreciation ?? 0,
        openingDepreciationThroughMonth: input.openingDepreciationThroughMonth ?? null,
      };
      assertOpeningDepreciation({
        ...opening,
        depreciationStartMonth: startMonth,
        usefulLifeMonths: input.usefulLifeMonths ?? category.defaultUsefulLifeMonths,
        acquisitionCost: input.acquisitionCost,
        residualValue: input.residualValue ?? 0,
      });
      const asset = await db.transaction(async (tx) => {
        // Document-series convention: the number is allocated inside the
        // insert transaction so a failed insert never burns one.
        const assetNumber = await getNextOrderNumber(tx, "fixed_asset");
        return repo.insertAsset(tx, {
          assetNumber,
          name: input.name,
          note: input.note ?? null,
          categoryId: input.categoryId,
          acquisitionDate: input.acquisitionDate,
          acquisitionCost: String(input.acquisitionCost),
          residualValue: String(input.residualValue ?? 0),
          usefulLifeMonths: input.usefulLifeMonths ?? category.defaultUsefulLifeMonths,
          depreciationStartMonth: monthStart(startMonth),
          openingDepreciation: String(opening.openingDepreciation),
          openingDepreciationThroughMonth:
            opening.openingDepreciationThroughMonth === null ? null : monthStart(opening.openingDepreciationThroughMonth),
          supplierInvoiceId: input.supplierInvoiceId ?? null,
          createdBy: userId,
        });
      });
      await audit.log({
        entityType: "fixed_asset",
        entityId: asset.assetNumber,
        action: "created",
        detail: {
          category: category.name,
          acquisitionDate: asset.acquisitionDate,
          acquisitionCost: Number(asset.acquisitionCost),
          usefulLifeMonths: asset.usefulLifeMonths,
          depreciationStartMonth: startMonth,
          ...(opening.openingDepreciationThroughMonth !== null ? opening : {}),
        },
        userId,
      });
      return service.getAsset(asset.id);
    },

    // Checks and write in ONE transaction, behind the same advisory lock a
    // run takes (and in the same order: lock, then the asset row FOR
    // UPDATE): a run committing between "no booked rows yet" and the UPDATE
    // could otherwise let a locked field change under booked rows.
    async updateAsset(id: string, input: UpdateFixedAssetInput, userId: string): Promise<FixedAssetDetail> {
      const { existing, changed } = await db.transaction(async (tx) => {
        await tx.execute(DEPRECIATION_LOCK_SQL);
        const existing = await repo.findAssetForUpdate(tx, id);
        if (!existing) throw new FixedAssetNotFoundError(id);
        const changed = (Object.keys(input) as (keyof UpdateFixedAssetInput)[]).filter(
          (key) => input[key] !== undefined && input[key] !== currentValue(existing, key)
        );
        if (existing.status === "disposed" && changed.some((key) => key !== "note")) {
          throw new FixedAssetNotActiveError(existing.assetNumber);
        }
        const live = await repo.listActiveDepreciations(tx, id);
        if (live.length > 0) {
          const locked = changed.find((key) => (LOCKED_AFTER_DEPRECIATION as readonly string[]).includes(key));
          if (locked) throw new FixedAssetFieldLockedError(locked);
        }

        const merged = {
          acquisitionDate: input.acquisitionDate ?? existing.acquisitionDate,
          acquisitionCost: input.acquisitionCost ?? Number(existing.acquisitionCost),
          residualValue: input.residualValue ?? Number(existing.residualValue),
          usefulLifeMonths: input.usefulLifeMonths ?? existing.usefulLifeMonths,
          depreciationStartMonth: input.depreciationStartMonth ?? monthKey(existing.depreciationStartMonth),
          openingDepreciation: input.openingDepreciation ?? Number(existing.openingDepreciation),
          openingDepreciationThroughMonth:
            input.openingDepreciationThroughMonth !== undefined
              ? input.openingDepreciationThroughMonth
              : (currentValue(existing, "openingDepreciationThroughMonth") as string | null),
        };
        if (merged.residualValue > merged.acquisitionCost) {
          throw new InvalidFixedAssetValuesError("residualValue must not exceed acquisitionCost");
        }
        if (merged.depreciationStartMonth < monthKey(merged.acquisitionDate)) {
          throw new InvalidFixedAssetValuesError("depreciationStartMonth must not be before the acquisition month");
        }
        // Live rows + the (merged) opening amount: what the plan would resume from.
        const booked: BookedEntry[] = withOpeningDepreciation(merged, live);
        const bookedSum = round2(booked.reduce((sum, row) => sum + row.amount, 0));
        const remainingBase = round2(merged.acquisitionCost - merged.residualValue - bookedSum);
        // Live rows always lie after the opening through-month (runs start
        // there and the opening fields are locked once a row exists), so the
        // last live month is the last booked month. Checked before the opening
        // rules: a plan shortened under live rows is a "life too short", not a
        // misplaced opening month. Without live rows the opening rules below
        // own the same dead end (through-month on/after the plan's last month).
        const lastLive = live.reduce<string | null>((latest, row) => (latest === null || row.month > latest ? row.month : latest), null);
        if (
          remainingBase > 0 &&
          lastLive !== null &&
          lastDepreciationMonth(merged.depreciationStartMonth, merged.usefulLifeMonths) <= lastLive
        ) {
          throw new FixedAssetLifeTooShortError(lastLive);
        }
        assertOpeningDepreciation(merged);
        if (remainingBase < 0) {
          throw new InvalidFixedAssetValuesError("residualValue would exceed the remaining book value");
        }
        if (input.categoryId && input.categoryId !== existing.categoryId && !(await repo.findCategoryById(tx, input.categoryId))) {
          throw new FixedAssetCategoryNotFoundError(input.categoryId);
        }
        if (input.supplierInvoiceId && !(await repo.supplierInvoiceRef(tx, input.supplierInvoiceId))) {
          throw new SupplierInvoiceNotFoundError(input.supplierInvoiceId);
        }

        const patch: Parameters<typeof repo.updateAsset>[2] = {};
        if (input.name !== undefined) patch.name = input.name;
        if (input.note !== undefined) patch.note = input.note;
        if (input.categoryId !== undefined) patch.categoryId = input.categoryId;
        if (input.acquisitionDate !== undefined) patch.acquisitionDate = input.acquisitionDate;
        if (input.acquisitionCost !== undefined) patch.acquisitionCost = String(input.acquisitionCost);
        if (input.residualValue !== undefined) patch.residualValue = String(input.residualValue);
        if (input.usefulLifeMonths !== undefined) patch.usefulLifeMonths = input.usefulLifeMonths;
        if (input.depreciationStartMonth !== undefined) patch.depreciationStartMonth = monthStart(input.depreciationStartMonth);
        if (input.openingDepreciation !== undefined) patch.openingDepreciation = String(input.openingDepreciation);
        if (input.openingDepreciationThroughMonth !== undefined) {
          patch.openingDepreciationThroughMonth =
            input.openingDepreciationThroughMonth === null ? null : monthStart(input.openingDepreciationThroughMonth);
        }
        if (input.supplierInvoiceId !== undefined) patch.supplierInvoiceId = input.supplierInvoiceId;
        if (Object.keys(patch).length > 0) await repo.updateAsset(tx, id, patch);
        return { existing, changed };
      });

      if (changed.length > 0) {
        await audit.log({
          entityType: "fixed_asset",
          entityId: existing.assetNumber,
          action: "updated",
          detail: { changed: Object.fromEntries(changed.map((key) => [key, { from: currentValue(existing, key), to: input[key] }])) },
          userId,
        });
      }
      return service.getAsset(id);
    },

    // Same lock order as updateAsset: a run landing between the row count
    // and the DELETE would otherwise turn the 409 into a restrict-FK 500.
    async deleteAsset(id: string, userId: string): Promise<void> {
      const existing = await db.transaction(async (tx) => {
        await tx.execute(DEPRECIATION_LOCK_SQL);
        const existing = await repo.findAssetForUpdate(tx, id);
        if (!existing) throw new FixedAssetNotFoundError(id);
        if (existing.status !== "active") throw new FixedAssetNotActiveError(existing.assetNumber);
        if ((await repo.countDepreciations(tx, id)) > 0) throw new FixedAssetHasDepreciationError(existing.assetNumber);
        await repo.deleteAsset(tx, id);
        return existing;
      });
      await audit.log({ entityType: "fixed_asset", entityId: existing.assetNumber, action: "deleted", userId });
    },

    // --- Avskrivningskörningar ---

    // Advisory only (plain db, no lock) — the in-tx run below recomputes.
    async previewDepreciation(input: { throughMonth: string }): Promise<DepreciationPreview> {
      const date = monthEnd(input.throughMonth);
      const periodStatus = periodStatusFor(await repo.loadPeriods(db), date);
      const warnings: DepreciationWarning[] = [];
      if (!isBookableMonth(input.throughMonth, false)) warnings.push("month-in-future");
      if (periodStatus === "locked") warnings.push("period-locked");
      if (periodStatus === "none") warnings.push("no-period");
      const plan = await planRun(db, input.throughMonth);
      if (plan.inactiveAccounts.length > 0) warnings.push("inactive-account");
      const latest = await repo.findLatestActiveRun(db);
      const latestDisplay = latest ? await repo.findVerificationDisplay(db, latest.verificationId) : null;
      return {
        throughMonth: input.throughMonth,
        date,
        periodStatus,
        lastRun:
          latest && latestDisplay
            ? { id: latest.id, throughMonth: monthKey(latest.throughMonth), displayNumber: latestDisplay.displayNumber, date: latestDisplay.date }
            : null,
        ...plan,
        warnings,
      };
    },

    // THE depreciation routine — Tx-only so delprojekt 3's bokslutssteg can
    // call it inside its own transaction. Returns null when nothing is
    // missing (every asset fully depreciated); the HTTP route turns that
    // into NothingToDepreciateError.
    async runDepreciation(tx: Tx, input: RunDepreciationInput, userId: string): Promise<DepreciationRunResult | null> {
      await tx.execute(DEPRECIATION_LOCK_SQL);
      // An ordinary run is dated the month's last day, so the month must have
      // ended (no future-dated verification). A disposal's catch-up is dated
      // on the disposal day — never in the future (validateDisposal) — and
      // books through the disposal month even when that is this month. A
      // run dated on `date` (the year-end closing date) needs that day to
      // have passed and to lie in throughMonth.
      if (input.scope && input.date) throw new Error("runDepreciation: scope and date are mutually exclusive");
      const bookable =
        input.date !== undefined
          ? input.date < stockholmToday() && monthKey(input.date) === input.throughMonth
          : isBookableMonth(input.throughMonth, input.scope !== undefined);
      if (!bookable) throw new DepreciationMonthInFutureError(input.throughMonth);
      const date = input.scope?.date ?? input.date ?? monthEnd(input.throughMonth);
      // The poster re-checks inside insertBookedVerification; checking first
      // puts the period error ahead of the (pointless) plan computation.
      await assertPostablePeriod(tx, date);

      const plan = await planRun(tx, input.throughMonth, input.scope?.assetId);
      if (plan.assets.length === 0) return null;

      const description = input.scope
        ? `Avskrivning ${plan.assets[0]!.assetNumber} t.o.m. ${input.throughMonth} (avyttring)`
        : `Avskrivningar t.o.m. ${input.throughMonth}`;
      // Verification first: the run row's verification_id is NOT NULL.
      const verification = await deps.poster.postDepreciation(
        tx,
        {
          date,
          description,
          rows: plan.byCategory.map((category) => ({
            expenseAccountId: category.expenseAccountId,
            accumulatedAccountId: category.accumulatedAccountId,
            amount: category.amount,
            // Kostnadsställe (förval) of the group, on the expense row only.
            costCenterId: category.costCenterId,
          })),
        },
        userId
      );
      const run = await repo.insertRun(tx, {
        throughMonth: monthStart(input.throughMonth),
        verificationId: verification.verificationId,
        disposalAssetId: input.scope?.assetId ?? null,
        createdBy: userId,
      });
      const rows = plan.assets.flatMap((asset) =>
        asset.months.map((month) => ({ assetId: asset.assetId, assetNumber: asset.assetNumber, month: month.month, amount: month.amount }))
      );
      await repo.insertDepreciations(
        tx,
        rows.map((row) => ({ assetId: row.assetId, runId: run.id, month: monthStart(row.month), amount: String(row.amount) }))
      );
      // Audit through the caller's tx (the poster's reasoning): an entry for
      // a run that rolled back would be a lie.
      await tx.insert(auditLog).values({
        entityType: "fixed_asset_depreciation_run",
        entityId: run.id,
        action: "booked",
        detail: {
          throughMonth: input.throughMonth,
          verification: verification.displayNumber,
          assets: plan.assets.length,
          rows: rows.length,
          total: plan.total,
          scopeAssetNumber: input.scope ? plan.assets[0]!.assetNumber : null,
        },
        userId,
      });
      return {
        run: { id: run.id, throughMonth: input.throughMonth, createdAt: run.createdAt },
        verification: { id: verification.verificationId, displayNumber: verification.displayNumber },
        rows,
        byCategory: plan.byCategory,
        total: plan.total,
      };
    },

    async bookDepreciation(input: { throughMonth: string }, userId: string): Promise<DepreciationRunResult> {
      const result = await db.transaction((tx) => service.runDepreciation(tx, input, userId));
      if (!result) throw new NothingToDepreciateError(input.throughMonth);
      return result;
    },

    // Årsbokslut: how many assets still lack months ≤ throughMonth — the
    // closing's step 3 status and close gate. Same plan as a run (planRun).
    async missingDepreciation(executor: Db | Tx, throughMonth: string): Promise<{ assets: number; total: number }> {
      const plan = await planRun(executor, throughMonth);
      return { assets: plan.assets.length, total: plan.total };
    },

    async listRuns(query: { limit: number; offset: number }) {
      const runs = await repo.listRuns(db, query);
      const latest = await repo.findLatestActiveRun(db);
      // Same predicate as undoRun, so the web's Ångra senaste körning only
      // shows when the undo would succeed.
      const latestUndoable =
        latest !== null && latest.disposalAssetId === null && !(await repo.runTouchesDisposedAsset(db, latest.id));
      return {
        total: runs.total,
        rows: runs.rows.map((run) => ({ ...run, undoable: latestUndoable && latest!.id === run.id })),
      };
    },

    // Ångra senaste körning (spec 3.5): reversal dated on the run's own
    // date so the month nets to exactly zero and a re-run gives the right
    // monthly result; the run's rows get superseded_by_run_id in the same
    // transaction.
    async undoRun(runId: string, userId: string) {
      return db.transaction(async (tx) => {
        await tx.execute(DEPRECIATION_LOCK_SQL);
        const run = await repo.findRunById(tx, runId);
        if (!run) throw new DepreciationRunNotFoundError(runId);
        if (run.reversalVerificationId) throw new AlreadyReversedError(run.verificationId);
        const latest = await repo.findLatestActiveRun(tx);
        if (!latest || latest.id !== run.id) throw new DepreciationRunNotLatestError(runId);
        if (run.disposalAssetId) throw new DisposalRunNotUndoableError(runId);
        if (await repo.runTouchesDisposedAsset(tx, run.id)) throw new RunPrecedesDisposalError(runId);

        const source = await repo.findVerificationDisplay(tx, run.verificationId);
        if (!source) throw new Error(`Run ${runId} has no verification`);
        await assertPostablePeriod(tx, source.date);
        const reversal = await deps.poster.reverseBookedVerification(
          tx,
          run.verificationId,
          { date: source.date, description: `Omföring av ${source.displayNumber} (ångrad avskrivningskörning)` },
          userId
        );
        if ("alreadyReversed" in reversal) throw new AlreadyReversedError(run.verificationId);

        // A run always has rows (runDepreciation returns null otherwise), and
        // none of them can be superseded yet (the run was not reversed). Zero
        // here means the register and the ledger have drifted — stop before
        // the reversal commits against nothing.
        const superseded = await repo.supersedeDepreciations(tx, run.id);
        if (superseded === 0) throw new Error(`Run ${runId} has no live depreciation rows to supersede`);
        await repo.markRunReversed(tx, run.id, reversal.verificationId);
        const display = (await repo.findVerificationDisplay(tx, reversal.verificationId))!;
        await tx.insert(auditLog).values({
          entityType: "fixed_asset_depreciation_run",
          entityId: run.id,
          action: "undone",
          detail: { verification: source.displayNumber, reversalVerification: display.displayNumber },
          userId,
        });
        return { run: { id: run.id }, reversalVerification: { id: reversal.verificationId, displayNumber: display.displayNumber } };
      });
    },

    // --- Avyttring ---

    async disposalPreview(id: string, input: DisposeFixedAssetInput): Promise<DisposalPreview> {
      const asset = await repo.findAssetById(db, id);
      if (!asset) throw new FixedAssetNotFoundError(id);
      const { intermediate, warnings } = await validateDisposal(db, asset, input);
      const category = (await repo.findCategoryById(db, asset.categoryId))!;
      const booked = await repo.listActiveDepreciations(db, id);
      const catchUpMonths = missingMonths(planInput(asset, booked), monthKey(input.disposalDate));
      const accumulatedDepreciation = accumulatedOf(asset, booked, catchUpMonths);
      const disposalPrice = input.disposalType === "sale" ? round2(input.disposalPrice) : 0;
      const amounts = { acquisitionCost: Number(asset.acquisitionCost), accumulatedDepreciation, disposalPrice };
      return {
        asset: { id: asset.id, assetNumber: asset.assetNumber, name: asset.name },
        disposalType: input.disposalType,
        disposalDate: input.disposalDate,
        catchUpMonths,
        accumulatedDepreciation,
        disposalPrice,
        ...disposalAmounts(amounts),
        rows: previewRows(category, intermediate, amounts),
        warnings,
      };
    },

    // Spec 3.6: lock → row lock → validate → catch-up run (dated on the
    // disposal day, lower AV number) → disposal verification → status flip,
    // all in one transaction. The catch-up MUST run before the flip:
    // listDepreciableAssets only sees active assets.
    async disposeAsset(id: string, input: DisposeFixedAssetInput, userId: string) {
      const result = await db.transaction(async (tx) => {
        await tx.execute(DEPRECIATION_LOCK_SQL);
        const asset = await repo.findAssetForUpdate(tx, id);
        if (!asset) throw new FixedAssetNotFoundError(id);
        const { intermediate } = await validateDisposal(tx, asset, input);
        await assertPostablePeriod(tx, input.disposalDate);

        const run = await service.runDepreciation(
          tx,
          { throughMonth: monthKey(input.disposalDate), scope: { assetId: id, date: input.disposalDate } },
          userId
        );
        const booked = await repo.listActiveDepreciations(tx, id);
        const accumulatedDepreciation = accumulatedOf(asset, booked);
        const disposalPrice = input.disposalType === "sale" ? round2(input.disposalPrice) : 0;
        const category = (await repo.findCategoryById(tx, asset.categoryId))!;
        const amounts = { acquisitionCost: Number(asset.acquisitionCost), accumulatedDepreciation, disposalPrice };

        const verification = await deps.poster.postFixedAssetDisposal(
          tx,
          {
            date: input.disposalDate,
            assetNumber: asset.assetNumber,
            assetName: asset.name,
            disposalType: input.disposalType,
            accounts: {
              asset: category.assetAccountId,
              accumulated: category.accumulatedDepreciationAccountId,
              gain: category.disposalGainAccountId,
              loss: category.disposalLossAccountId,
              intermediate: intermediate?.id ?? null,
            },
            ...amounts,
          },
          userId
        );
        await repo.updateAsset(tx, id, {
          status: "disposed",
          disposalDate: input.disposalDate,
          disposalType: input.disposalType,
          disposalPrice: input.disposalType === "sale" ? String(disposalPrice) : null,
          disposalVerificationId: verification.verificationId,
        });
        const { bookValue, gain, loss } = disposalAmounts(amounts);
        await tx.insert(auditLog).values({
          entityType: "fixed_asset",
          entityId: asset.assetNumber,
          action: "disposed",
          detail: {
            disposalType: input.disposalType,
            disposalDate: input.disposalDate,
            disposalPrice,
            bookValue,
            gain,
            loss,
            depreciationVerification: run?.verification.displayNumber ?? null,
            disposalVerification: verification.displayNumber,
          },
          userId,
        });
        return { run, verification };
      });
      return {
        asset: await service.getAsset(id),
        depreciationRun: result.run ? result.run.verification : null,
        disposalVerification: { id: result.verification.verificationId, displayNumber: result.verification.displayNumber },
      };
    },

    // --- Avskrivningsplan ---

    async getPlan(query: { fiscalYearId: string }): Promise<FixedAssetPlan> {
      const fiscalYear = await repo.findFiscalYear(db, query.fiscalYearId);
      if (!fiscalYear) throw new FixedAssetPlanYearNotFoundError(query.fiscalYearId);
      const categories = (await repo.listCategories(db)).map((category) => ({
        id: category.id,
        name: category.name,
        assetAccount: category.accounts.asset,
        accumulatedAccount: category.accounts.accumulated,
      }));
      const dates = await repo.listActiveDepreciationDates(db);
      const byAsset = new Map<string, PlanAssetInput["depreciations"]>();
      for (const row of dates) {
        const list = byAsset.get(row.assetId) ?? [];
        list.push({ date: row.date, amount: Number(row.amount) });
        byAsset.set(row.assetId, list);
      }
      const assets = (await repo.listPlanAssets(db)).map((asset) => ({
        ...asset,
        acquisitionCost: Number(asset.acquisitionCost),
        openingDepreciation: openingDepreciationOf(asset)?.amount ?? 0,
        depreciations: byAsset.get(asset.id) ?? [],
      }));
      // Same reader as the balance sheet — the two can never disagree.
      const ledgerBalances = (await readAccountBalances(db, { from: null, to: fiscalYear.endDate })).map((row) => ({
        accountId: row.accountId,
        debit: row.periodDebit,
        credit: row.periodCredit,
      }));
      return buildFixedAssetPlan({ fiscalYear, categories, assets, ledgerBalances });
    },

    async getPlanPdf(query: { fiscalYearId: string }) {
      const plan = await service.getPlan(query);
      const input: FixedAssetPlanPdfInput = {
        title: "Avskrivningsplan",
        subtitle: `Räkenskapsår ${plan.fiscalYear.label} · ${plan.fiscalYear.startDate} – ${plan.fiscalYear.endDate}`,
        categories: plan.categories
          .filter((category) => category.assets.length > 0)
          .map((category) => ({
            heading: `${category.categoryName} (${category.assetAccountNumber} / ${category.accumulatedAccountNumber})`,
            rows: category.assets.map((row) => ({
              number: row.assetNumber,
              name: row.name,
              acquired: row.acquisitionDate,
              cost: formatNumber(row.acquisitionClosing),
              yearDepreciation: formatNumber(row.depreciationYear),
              accumulated: formatNumber(row.depreciationClosing),
              bookValue: formatNumber(row.bookValueClosing),
            })),
            movement: [
              `Anskaffningsvärde: IB ${formatNumber(category.totals.acquisitionOpening)} + anskaffningar ${formatNumber(category.totals.acquisitions)} - avyttringar ${formatNumber(Math.abs(category.totals.disposals))} = UB ${formatNumber(category.totals.acquisitionClosing)}`,
              `Ack. avskrivningar: IB ${formatNumber(category.totals.depreciationOpening)} + årets ${formatNumber(category.totals.depreciationYear)} - avyttrade ${formatNumber(Math.abs(category.totals.depreciationDisposed))} = UB ${formatNumber(category.totals.depreciationClosing)}`,
            ],
          })),
        totals: {
          cost: formatNumber(plan.totals.acquisitionClosing),
          yearDepreciation: formatNumber(plan.totals.depreciationYear),
          accumulated: formatNumber(plan.totals.depreciationClosing),
          bookValue: formatNumber(plan.totals.bookValueClosing),
        },
        reconciliation: plan.reconciliation.map(reconciliationLine),
        emptyText: "Inga anläggningar under räkenskapsåret.",
      };
      return { filename: `avskrivningsplan-${plan.fiscalYear.label}.pdf`, content: await deps.pdf.renderFixedAssetPlan(input) };
    },

    async getPlanCsv(query: { fiscalYearId: string }) {
      const plan = await service.getPlan(query);
      return { filename: `avskrivningsplan-${plan.fiscalYear.label}.csv`, content: buildFixedAssetPlanCsv(plan) };
    },
  };

  return service;
}

export type FixedAssetService = ReturnType<typeof createFixedAssetService>;
