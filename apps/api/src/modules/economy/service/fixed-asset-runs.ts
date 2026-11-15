// apps/api/src/modules/economy/service/fixed-asset-runs.ts
// Anläggningsregister — avskrivningskörningarna, out of fixed-asset.service.ts
// (kodkvalitet 2026-11-15): the run lock and the rules every run and the
// register share, the plan (planRun) and the routine's entry points. The
// service spreads them in and re-exports this file, so callers and tests are
// unchanged. Beloppsregeln itself is depreciation-schedule.ts (missingMonths).
import { sql } from "drizzle-orm";
import { auditLog, type Db, type Tx } from "@navet/db";
import { round2 } from "@navet/shared";
import { stockholmToday } from "../../system/service/delivery-days.js";
import * as repo from "../repository/fixed-asset.repository.js";
import { AlreadyReversedError } from "./economy.service.js";
import {
  missingMonths,
  monthEnd,
  monthKey,
  monthStart,
  withOpeningDepreciation,
  type DepreciationPlanInput,
  type PlannedDepreciation,
} from "./depreciation-schedule.js";
import { assertPostablePeriod, type VerificationPoster } from "./verification-poster.js";
import {
  DepreciationMonthInFutureError,
  DepreciationRunNotFoundError,
  DepreciationRunNotLatestError,
  DisposalRunNotUndoableError,
  NothingToDepreciateError,
  RunPrecedesDisposalError,
} from "./fixed-asset.errors.js";

// Serializes runs, undos and disposals globally (B5's vat_settlements idiom).
// Without it two concurrent runs both read the same "missing months" and the
// second hits the unique index with a raw 23505; with it the second sees
// the first's rows and finds nothing to book. Asset edits and deletes take
// the same lock first, so a run can never commit between their checks and
// their writes (a locked-field change slipping past, or the has-depreciation
// 409 turning into a restrict-FK 500).
export const DEPRECIATION_LOCK_SQL = sql`SELECT pg_advisory_xact_lock(hashtext('fixed_asset_depreciations'))`;

export function currentMonthStockholm(): string {
  return stockholmToday().slice(0, 7);
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

export function createDepreciationRuns(deps: { db: Db; poster: VerificationPoster }) {
  const { db } = deps;

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

  const runs = {
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
      const result = await db.transaction((tx) => runs.runDepreciation(tx, input, userId));
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
  };
  return runs;
}
