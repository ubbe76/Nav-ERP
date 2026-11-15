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
import { stockholmToday } from "../../system/service/delivery-days.js";
import type { AuditWriter } from "../../system/repository/audit.repository.js";
import { isForeignKeyViolation, isUniqueViolation } from "../../system/service/db-errors.js";
import * as repo from "../repository/fixed-asset.repository.js";
import { BAS_FIXED_ASSET_CATEGORIES } from "./bas-accounts.js";
import { AccountNotFoundError, InactiveAccountError } from "./economy.service.js";
import { resolveDimensions } from "./dimension-check.js";
import {
  disposalAmounts,
  disposalPostingRows,
  lastDepreciationMonth,
  missingMonths,
  monthKey,
  monthStart,
  openingDepreciationOf,
  withOpeningDepreciation,
  type BookedEntry,
  type PlannedDepreciation,
} from "./depreciation-schedule.js";
import { formatNumber, type DocumentPdfService, type FixedAssetPlanPdfInput } from "../../mail/service/document-pdf.js";
import { readAccountBalances } from "./account-balances.js";
import { buildFixedAssetPlan, type FixedAssetPlan, type PlanAssetInput } from "./fixed-asset-plan.js";
import { buildFixedAssetPlanTable } from "./fixed-asset-plan-csv.js";
import { csvFile, type NamedTable } from "../../system/service/table-export.js";
import { assertPostablePeriod, createAmountAccumulator, type VerificationPoster } from "./verification-poster.js";
import { DEPRECIATION_LOCK_SQL, createDepreciationRuns, currentMonthStockholm, planInput } from "./fixed-asset-runs.js";
import {
  FixedAssetCategoryNotFoundError,
  DuplicateFixedAssetCategoryNameError,
  FixedAssetCategoryInUseError,
  FixedAssetCategoryAccountsNotDistinctError,
  type CategoryAccountRole,
  FixedAssetCategoryAccountRoleConflictError,
  FixedAssetCategoryAccountsLockedError,
  FixedAssetBasAccountMissingError,
  FixedAssetNotFoundError,
  SupplierInvoiceNotFoundError,
  FixedAssetFieldLockedError,
  FixedAssetNotActiveError,
  FixedAssetHasDepreciationError,
  FixedAssetLifeTooShortError,
  InvalidFixedAssetValuesError,
  InvalidOpeningDepreciationError,
  InvalidDisposalDateError,
} from "./fixed-asset.errors.js";

// Anläggningsregister (ekonomi etapp 2, delprojekt 2). Owns every status
// transition and every bookkeeping path of the register; the poster books,
// the repository reads/writes, depreciation-schedule.ts does the arithmetic.

// --- Errors: fixed-asset.errors.ts (re-exported for the importers) ---
export * from "./fixed-asset.errors.js";
export * from "./fixed-asset-runs.js";

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

const ROLE_KEYS: [CategoryAccountRole, keyof CategoryAccountFields][] = [
  ["asset", "assetAccountId"],
  ["accumulated", "accumulatedDepreciationAccountId"],
  ["expense", "depreciationExpenseAccountId"],
  ["gain", "disposalGainAccountId"],
  ["loss", "disposalLossAccountId"],
];
const BALANCE_ROLES = new Set<CategoryAccountRole>(["asset", "accumulated"]);

// The asset and ack accounts are reconciled per account against the ledger
// (Avskrivningsplan, the year-end warning). An account in either role — in
// any group — may have no other role in any group: group A's expense account
// as group B's ack account nets A's depreciation against B's accumulated
// depreciation. The same role in several groups is fine. Run under the
// depreciation lock with the write, so two saves cannot cross.
async function assertAccountRolesAcrossCategories(
  executor: Db | Tx,
  fields: CategoryAccountFields,
  self: { id: string | null; name: string }
): Promise<void> {
  const groups = [
    { name: self.name, fields },
    ...(await repo.listCategoryAccounts(executor)).filter((c) => c.id !== self.id).map((c) => ({ name: c.name, fields: c })),
  ];
  for (const [role, key] of ROLE_KEYS) {
    for (const group of groups) {
      for (const [otherRole, otherKey] of ROLE_KEYS) {
        if (otherRole === role || group.fields[otherKey] !== fields[key]) continue;
        if (!BALANCE_ROLES.has(role) && !BALANCE_ROLES.has(otherRole)) continue;
        const account = await repo.findAccountRef(executor, fields[key]);
        // Within the group itself the balance role is the one the account
        // "already has" — the message then names the other as the mistake.
        const [mine, theirs] = group.fields === fields && BALANCE_ROLES.has(role) ? [otherRole, role] : [role, otherRole];
        throw new FixedAssetCategoryAccountRoleConflictError(account?.number ?? "", mine, group.name, theirs);
      }
    }
  }
}

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

// The opening fields as numbers plus the plan fields they are checked
// against (the row's OpeningDepreciationFields carry strings).
interface OpeningDepreciationCheck {
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
  // Avskrivningskörningar: preview, the Tx-only run (the bokslut calls it),
  // book, the closing's missing months, the list and Ångra senaste.
  const runs = createDepreciationRuns({ db, poster: deps.poster });

  async function requireActiveAccount(id: string): Promise<repo.AccountRef> {
    const account = await repo.findAccountRef(db, id);
    if (!account) throw new AccountNotFoundError(id);
    if (!account.active) throw new InactiveAccountError(id);
    return account;
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
    // The poster's own netting (postFixedAssetDisposal), so the preview is
    // the verifikat's rows.
    const accumulator = createAmountAccumulator();
    const accounts = new Map<string, repo.AccountRef>();
    for (const row of disposalPostingRows(amounts)) {
      const account = byRole[row.role];
      if (!account) throw new Error("A disposal with a price needs an intermediate account");
      accounts.set(account.id, account);
      accumulator.add(account.id, row.amount);
    }
    return accumulator.toRows().map((row) => ({
      accountNumber: accounts.get(row.accountId)!.number,
      accountName: accounts.get(row.accountId)!.name,
      debit: row.debit,
      credit: row.credit,
    }));
  }

  // Avskrivningsplanen's reads, on whatever executor getPlan hands in.
  async function readPlan(ex: Db | Tx, query: { fiscalYearId: string }): Promise<FixedAssetPlan> {
    const fiscalYear = await repo.findFiscalYear(ex, query.fiscalYearId);
    if (!fiscalYear) throw new FixedAssetPlanYearNotFoundError(query.fiscalYearId);
    const categories = (await repo.listCategories(ex)).map((category) => ({
      id: category.id,
      name: category.name,
      assetAccount: category.accounts.asset,
      accumulatedAccount: category.accounts.accumulated,
    }));
    const dates = await repo.listActiveDepreciationDates(ex);
    const byAsset = new Map<string, PlanAssetInput["depreciations"]>();
    for (const row of dates) {
      const list = byAsset.get(row.assetId) ?? [];
      list.push({ date: row.date, amount: Number(row.amount) });
      byAsset.set(row.assetId, list);
    }
    const assets = (await repo.listPlanAssets(ex)).map((asset) => ({
      ...asset,
      acquisitionCost: Number(asset.acquisitionCost),
      openingDepreciation: openingDepreciationOf(asset)?.amount ?? 0,
      depreciations: byAsset.get(asset.id) ?? [],
    }));
    // Same reader as the balance sheet — the two can never disagree.
    const ledgerBalances = (await readAccountBalances(ex, { from: null, to: fiscalYear.endDate })).map((row) => ({
      accountId: row.accountId,
      debit: row.periodDebit,
      credit: row.periodCredit,
    }));
    return buildFixedAssetPlan({ fiscalYear, categories, assets, ledgerBalances });
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
      const row = await db.transaction(async (tx) => {
        await tx.execute(DEPRECIATION_LOCK_SQL);
        await assertAccountRolesAcrossCategories(tx, input, { id: null, name: input.name });
        try {
          return await repo.insertCategory(tx, input);
        } catch (err) {
          if (isUniqueViolation(err)) throw new DuplicateFixedAssetCategoryNameError(input.name);
          throw err;
        }
      });
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
        // Only when an account changes: a name, life or cost-center change
        // must not be refused over a combination saved before the check
        // existed. An account change validates the whole set, so such a
        // group gets its old conflict named before it can change accounts.
        if (changedAccountKeys.length > 0) await assertAccountRolesAcrossCategories(tx, merged, { id, name: merged.name });
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
    // Under the run lock like every other category writer: a double click
    // runs the second seed after the first has committed, so it skips the
    // names instead of hitting the unique index (500) mid-transaction.
    async seedBasCategories(): Promise<{ created: string[]; skipped: string[] }> {
      const result = await db.transaction(async (tx) => {
        await tx.execute(DEPRECIATION_LOCK_SQL);
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
      for (const name of result.created) {
        await audit.log({ entityType: "fixed_asset_category", entityId: name, action: "created", detail: { source: "bas" } });
      }
      return result;
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
        // An opening amount locks the group's posting accounts (it is booked
        // on them in IB): taken under the run lock, as updateCategory checks
        // that flag under it — an account change can then never slip in
        // between its check and this insert.
        if (opening.openingDepreciation > 0) await tx.execute(DEPRECIATION_LOCK_SQL);
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
        // An opening amount already sits in IB on THIS group's accounts
        // (postingAccountsLocked counts it): moving the asset would shift it
        // between groups in the reconciliation. The opening fields themselves
        // stay editable until the first run (above).
        if (Number(existing.openingDepreciation) > 0 && changed.includes("categoryId")) throw new FixedAssetFieldLockedError("categoryId");

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
        // On every PATCH, not just when an opening field is sent: cost,
        // residual value and life are the check's other inputs (a lower
        // cost may not undercut the opening amount). Pure and cheap.
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

    previewDepreciation: runs.previewDepreciation,
    runDepreciation: runs.runDepreciation,
    bookDepreciation: runs.bookDepreciation,
    missingDepreciation: runs.missingDepreciation,
    listRuns: runs.listRuns,
    undoRun: runs.undoRun,

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
        // Before the catch-up run below: the disposal verifikat is dated the
        // disposal day, and a locked period there must refuse the whole
        // disposal before the run books its catch-up (runDepreciation books
        // months in locked periods on its own date, so it would not stop it).
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

    // Register and ledger are read from ONE snapshot (repeatable read, read
    // only): a depreciation run committing between the two reads would
    // otherwise show as a deviation that is gone on the next load. With an
    // executor (the year-end close's own transaction, which already holds a
    // consistent view and locks) the plan is read through it instead.
    async getPlan(query: { fiscalYearId: string }, executor?: Db | Tx): Promise<FixedAssetPlan> {
      if (executor) return readPlan(executor, query);
      return db.transaction((tx) => readPlan(tx, query), { isolationLevel: "repeatable read", accessMode: "read only" });
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

    // The export table — the CSV and the Excel twin render the same one.
    async getPlanTable(query: { fiscalYearId: string }): Promise<NamedTable> {
      const plan = await service.getPlan(query);
      return { basename: `avskrivningsplan-${plan.fiscalYear.label}`, table: buildFixedAssetPlanTable(plan) };
    },

    async getPlanCsv(query: { fiscalYearId: string }) {
      return csvFile(await service.getPlanTable(query));
    },
  };

  return service;
}

export type FixedAssetService = ReturnType<typeof createFixedAssetService>;
