import { and, asc, count, desc, eq, getTableColumns, gt, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  accountingPeriods,
  accounts,
  fiscalYears,
  fixedAssetCategories,
  fixedAssetDepreciationRuns,
  fixedAssetDepreciations,
  fixedAssets,
  supplierInvoices,
  verificationSeries,
  verifications,
  type Db,
  type Tx,
} from "@navet/db";
import { ilikePattern, round2, type ListFixedAssetsQuery } from "@navet/shared";
import { monthKey } from "../service/depreciation-schedule.js";

// Anläggningsregister data access. Plain executor-based functions (Db | Tx),
// the same seam as vat-settlement.repository.ts: the service passes its own
// transaction on the write paths and the plain db on reads.

export type AccountRef = { id: string; number: string; name: string; active: boolean; vatBox: string | null };
export type CategoryAccountRole = "asset" | "accumulated" | "expense" | "gain" | "loss";

export type FixedAssetCategoryRow = typeof fixedAssetCategories.$inferSelect & {
  accounts: Record<CategoryAccountRole, AccountRef>;
  assetCount: number;
  // True once any asset in the group has live depreciation rows or an
  // opening depreciation — the asset/ack/expense accounts then carry booked
  // amounts and must not be repointed (FixedAssetCategoryAccountsLockedError).
  postingAccountsLocked: boolean;
};

export type CategoryWrite = {
  name: string;
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
  disposalGainAccountId: string;
  disposalLossAccountId: string;
  defaultUsefulLifeMonths: number;
};

export async function findAccountRef(executor: Db | Tx, id: string): Promise<AccountRef | null> {
  const [row] = await executor
    .select({ id: accounts.id, number: accounts.number, name: accounts.name, active: accounts.active, vatBox: accounts.vatBox })
    .from(accounts)
    .where(eq(accounts.id, id));
  return row ?? null;
}

export async function findAccountRefsByNumbers(executor: Db | Tx, numbers: string[]): Promise<Map<string, AccountRef>> {
  if (numbers.length === 0) return new Map();
  const rows = await executor
    .select({ id: accounts.id, number: accounts.number, name: accounts.name, active: accounts.active, vatBox: accounts.vatBox })
    .from(accounts)
    .where(inArray(accounts.number, numbers));
  return new Map(rows.map((row) => [row.number, row]));
}

function roleIds(row: typeof fixedAssetCategories.$inferSelect): Record<CategoryAccountRole, string> {
  return {
    asset: row.assetAccountId,
    accumulated: row.accumulatedDepreciationAccountId,
    expense: row.depreciationExpenseAccountId,
    gain: row.disposalGainAccountId,
    loss: row.disposalLossAccountId,
  };
}

// Joins the five account refs and the asset count onto raw category rows —
// two small queries instead of five self-joins on accounts.
async function decorateCategories(
  executor: Db | Tx,
  rows: (typeof fixedAssetCategories.$inferSelect)[]
): Promise<FixedAssetCategoryRow[]> {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.flatMap((row) => Object.values(roleIds(row))))];
  const refs = await executor
    .select({ id: accounts.id, number: accounts.number, name: accounts.name, active: accounts.active, vatBox: accounts.vatBox })
    .from(accounts)
    .where(inArray(accounts.id, ids));
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  const counts = await executor
    .select({ categoryId: fixedAssets.categoryId, total: count() })
    .from(fixedAssets)
    .where(
      inArray(
        fixedAssets.categoryId,
        rows.map((row) => row.id)
      )
    )
    .groupBy(fixedAssets.categoryId);
  const countById = new Map(counts.map((row) => [row.categoryId, Number(row.total)]));
  // Groups with something on the books: an asset with live rows or an
  // opening amount. Superseded rows do not count — their reversal netted
  // the accounts back to zero.
  const locked = await executor
    .selectDistinct({ categoryId: fixedAssets.categoryId })
    .from(fixedAssets)
    .where(
      and(
        inArray(
          fixedAssets.categoryId,
          rows.map((row) => row.id)
        ),
        or(
          gt(fixedAssets.openingDepreciation, "0"),
          sql`EXISTS (SELECT 1 FROM fixed_asset_depreciations d WHERE d.asset_id = ${fixedAssets.id} AND d.superseded_by_run_id IS NULL)`
        )
      )
    );
  const lockedIds = new Set(locked.map((row) => row.categoryId));

  return rows.map((row) => {
    const roles = roleIds(row);
    const resolved = Object.fromEntries(
      (Object.keys(roles) as CategoryAccountRole[]).map((role) => {
        const ref = byId.get(roles[role]);
        if (!ref) throw new Error(`fixed asset category ${row.id} references a missing account ${roles[role]}`);
        return [role, ref];
      })
    ) as Record<CategoryAccountRole, AccountRef>;
    return { ...row, accounts: resolved, assetCount: countById.get(row.id) ?? 0, postingAccountsLocked: lockedIds.has(row.id) };
  });
}

export async function listCategories(executor: Db | Tx): Promise<FixedAssetCategoryRow[]> {
  const rows = await executor.select().from(fixedAssetCategories).orderBy(asc(fixedAssetCategories.name));
  return decorateCategories(executor, rows);
}

export async function findCategoryById(executor: Db | Tx, id: string): Promise<FixedAssetCategoryRow | null> {
  const rows = await executor.select().from(fixedAssetCategories).where(eq(fixedAssetCategories.id, id));
  const [decorated] = await decorateCategories(executor, rows);
  return decorated ?? null;
}

export async function findCategoryByName(executor: Db | Tx, name: string) {
  const [row] = await executor.select().from(fixedAssetCategories).where(eq(fixedAssetCategories.name, name));
  return row ?? null;
}

export async function insertCategory(executor: Db | Tx, values: CategoryWrite) {
  const [row] = await executor.insert(fixedAssetCategories).values(values).returning();
  return row!;
}

export async function updateCategory(executor: Db | Tx, id: string, patch: Partial<CategoryWrite>) {
  const [row] = await executor
    .update(fixedAssetCategories)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(fixedAssetCategories.id, id))
    .returning();
  return row ?? null;
}

export async function deleteCategory(executor: Db | Tx, id: string): Promise<boolean> {
  const rows = await executor.delete(fixedAssetCategories).where(eq(fixedAssetCategories.id, id)).returning({ id: fixedAssetCategories.id });
  return rows.length > 0;
}

// --- Anläggningar ---

export type FixedAssetRow = typeof fixedAssets.$inferSelect;
export type FixedAssetListRow = FixedAssetRow & {
  categoryName: string;
  accumulatedDepreciation: number;
  bookValue: number;
};

export type AssetWrite = {
  assetNumber: string;
  name: string;
  note: string | null;
  categoryId: string;
  acquisitionDate: string;
  acquisitionCost: string; // numeric(14,2) as string, repo convention
  residualValue: string;
  usefulLifeMonths: number;
  depreciationStartMonth: string; // "YYYY-MM-01"
  openingDepreciation: string; // numeric(14,2) as string; "0" when acquired in Nav's time
  openingDepreciationThroughMonth: string | null; // "YYYY-MM-01"
  supplierInvoiceId: string | null;
  createdBy: string | null;
};

// Σ live rows per asset plus the opening amount (ingående avskrivning),
// correlated — the register never stores a balance. The SQL twin of
// withOpeningDepreciation in depreciation-schedule.ts.
const activeDepreciationSum = sql<string>`COALESCE((SELECT SUM(d.amount) FROM fixed_asset_depreciations d WHERE d.asset_id = ${fixedAssets.id} AND d.superseded_by_run_id IS NULL), 0) + ${fixedAssets.openingDepreciation}`;

export async function listAssets(
  executor: Db | Tx,
  query: ListFixedAssetsQuery
): Promise<{ rows: FixedAssetListRow[]; total: number }> {
  const conditions = [];
  if (query.search) {
    const pattern = ilikePattern(query.search);
    conditions.push(or(ilike(fixedAssets.assetNumber, pattern), ilike(fixedAssets.name, pattern)));
  }
  if (query.status) conditions.push(eq(fixedAssets.status, query.status));
  if (query.categoryId) conditions.push(eq(fixedAssets.categoryId, query.categoryId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await executor
    .select({
      ...getTableColumns(fixedAssets),
      categoryName: fixedAssetCategories.name,
      accumulated: activeDepreciationSum,
    })
    .from(fixedAssets)
    .innerJoin(fixedAssetCategories, eq(fixedAssetCategories.id, fixedAssets.categoryId))
    .where(where)
    // Created order = AN-number order ("AN-10" would sort before "AN-2" as text).
    .orderBy(asc(fixedAssets.createdAt))
    .limit(query.limit)
    .offset(query.offset);
  const [totalRow] = await executor.select({ total: count() }).from(fixedAssets).where(where);

  return {
    rows: rows.map(({ accumulated, ...row }) => ({
      ...row,
      accumulatedDepreciation: Number(accumulated),
      bookValue: round2(Number(row.acquisitionCost) - Number(accumulated)),
    })),
    total: Number(totalRow?.total ?? 0),
  };
}

export async function findAssetById(executor: Db | Tx, id: string): Promise<FixedAssetRow | null> {
  const [row] = await executor.select().from(fixedAssets).where(eq(fixedAssets.id, id));
  return row ?? null;
}

// Row lock for the disposal transition — same FOR UPDATE idiom as the
// shipping module's draft edits.
export async function findAssetForUpdate(tx: Tx, id: string): Promise<FixedAssetRow | null> {
  const [row] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, id)).for("update");
  return row ?? null;
}

export async function insertAsset(tx: Tx, values: AssetWrite): Promise<FixedAssetRow> {
  const [row] = await tx.insert(fixedAssets).values(values).returning();
  return row!;
}

export async function updateAsset(
  executor: Db | Tx,
  id: string,
  patch: Partial<Omit<AssetWrite, "assetNumber" | "createdBy">> & {
    status?: "active" | "disposed";
    disposalDate?: string | null;
    disposalType?: "sale" | "scrap" | null;
    disposalPrice?: string | null;
    disposalVerificationId?: string | null;
  }
): Promise<FixedAssetRow | null> {
  const [row] = await executor
    .update(fixedAssets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(fixedAssets.id, id))
    .returning();
  return row ?? null;
}

export async function deleteAsset(executor: Db | Tx, id: string): Promise<boolean> {
  const rows = await executor.delete(fixedAssets).where(eq(fixedAssets.id, id)).returning({ id: fixedAssets.id });
  return rows.length > 0;
}

// Every row, superseded ones included — a superseded row still points at a
// booked verification, so an asset with any row can never be deleted.
export async function countDepreciations(executor: Db | Tx, assetId: string): Promise<number> {
  const [row] = await executor
    .select({ total: count() })
    .from(fixedAssetDepreciations)
    .where(eq(fixedAssetDepreciations.assetId, assetId));
  return Number(row?.total ?? 0);
}

export type BookedMonth = { month: string; amount: number };

export async function listActiveDepreciationsByAsset(
  executor: Db | Tx,
  assetIds: string[]
): Promise<Map<string, BookedMonth[]>> {
  const result = new Map<string, BookedMonth[]>();
  if (assetIds.length === 0) return result;
  const rows = await executor
    .select({ assetId: fixedAssetDepreciations.assetId, month: fixedAssetDepreciations.month, amount: fixedAssetDepreciations.amount })
    .from(fixedAssetDepreciations)
    .where(and(inArray(fixedAssetDepreciations.assetId, assetIds), isNull(fixedAssetDepreciations.supersededByRunId)))
    .orderBy(asc(fixedAssetDepreciations.month));
  for (const row of rows) {
    const list = result.get(row.assetId) ?? [];
    list.push({ month: monthKey(row.month), amount: Number(row.amount) });
    result.set(row.assetId, list);
  }
  return result;
}

export async function listActiveDepreciations(executor: Db | Tx, assetId: string): Promise<BookedMonth[]> {
  return (await listActiveDepreciationsByAsset(executor, [assetId])).get(assetId) ?? [];
}

export type AssetDepreciationRow = {
  id: string;
  month: string; // "YYYY-MM"
  amount: number;
  runId: string;
  verificationId: string;
  displayNumber: string;
  date: string;
  reversed: boolean;
};

// The asset card's depreciation table: every row (superseded ones flagged),
// with its run's AV verification. Runs only ever write booked verifications,
// so displayNumber never needs the "Utkast" fallback.
export async function listAssetDepreciations(executor: Db | Tx, assetId: string): Promise<AssetDepreciationRow[]> {
  const rows = await executor
    .select({
      id: fixedAssetDepreciations.id,
      month: fixedAssetDepreciations.month,
      amount: fixedAssetDepreciations.amount,
      runId: fixedAssetDepreciations.runId,
      supersededByRunId: fixedAssetDepreciations.supersededByRunId,
      verificationId: verifications.id,
      date: verifications.date,
      seriesCode: verificationSeries.code,
      yearLabel: fiscalYears.label,
      verificationNumber: verifications.verificationNumber,
    })
    .from(fixedAssetDepreciations)
    .innerJoin(fixedAssetDepreciationRuns, eq(fixedAssetDepreciationRuns.id, fixedAssetDepreciations.runId))
    .innerJoin(verifications, eq(verifications.id, fixedAssetDepreciationRuns.verificationId))
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .where(eq(fixedAssetDepreciations.assetId, assetId))
    .orderBy(asc(fixedAssetDepreciations.month), asc(fixedAssetDepreciations.createdAt));
  return rows.map((row) => ({
    id: row.id,
    month: monthKey(row.month),
    amount: Number(row.amount),
    runId: row.runId,
    verificationId: row.verificationId,
    displayNumber: `${row.seriesCode}-${row.yearLabel}-${row.verificationNumber}`,
    date: row.date,
    reversed: row.supersededByRunId !== null,
  }));
}

export async function supplierInvoiceRef(executor: Db | Tx, id: string) {
  const [row] = await executor
    .select({ id: supplierInvoices.id, registrationNumber: supplierInvoices.registrationNumber })
    .from(supplierInvoices)
    .where(eq(supplierInvoices.id, id));
  return row ?? null;
}

export async function findVerificationDisplay(executor: Db | Tx, id: string) {
  const [row] = await executor
    .select({
      id: verifications.id,
      date: verifications.date,
      seriesCode: verificationSeries.code,
      yearLabel: fiscalYears.label,
      verificationNumber: verifications.verificationNumber,
    })
    .from(verifications)
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .where(eq(verifications.id, id));
  if (!row) return null;
  return { id: row.id, date: row.date, displayNumber: `${row.seriesCode}-${row.yearLabel}-${row.verificationNumber}` };
}

// --- Avskrivningskörningar ---

export type DepreciableAsset = FixedAssetRow & {
  category: {
    id: string;
    name: string;
    depreciationExpenseAccountId: string;
    accumulatedDepreciationAccountId: string;
    expenseAccountNumber: string;
    expenseAccountName: string;
    expenseAccountActive: boolean;
    accumulatedAccountNumber: string;
    accumulatedAccountName: string;
    accumulatedAccountActive: boolean;
  };
};

// Active assets whose plan has started by `throughMonthStart` (a month's
// first day), optionally one asset (a disposal's catch-up run).
export async function listDepreciableAssets(
  executor: Db | Tx,
  throughMonthStart: string,
  assetId?: string
): Promise<DepreciableAsset[]> {
  const expense = alias(accounts, "expense_account");
  const accumulated = alias(accounts, "accumulated_account");
  const conditions = [eq(fixedAssets.status, "active"), lte(fixedAssets.depreciationStartMonth, throughMonthStart)];
  if (assetId) conditions.push(eq(fixedAssets.id, assetId));
  const rows = await executor
    .select({
      ...getTableColumns(fixedAssets),
      categoryName: fixedAssetCategories.name,
      depreciationExpenseAccountId: fixedAssetCategories.depreciationExpenseAccountId,
      accumulatedDepreciationAccountId: fixedAssetCategories.accumulatedDepreciationAccountId,
      expenseAccountNumber: expense.number,
      expenseAccountName: expense.name,
      expenseAccountActive: expense.active,
      accumulatedAccountNumber: accumulated.number,
      accumulatedAccountName: accumulated.name,
      accumulatedAccountActive: accumulated.active,
    })
    .from(fixedAssets)
    .innerJoin(fixedAssetCategories, eq(fixedAssetCategories.id, fixedAssets.categoryId))
    .innerJoin(expense, eq(expense.id, fixedAssetCategories.depreciationExpenseAccountId))
    .innerJoin(accumulated, eq(accumulated.id, fixedAssetCategories.accumulatedDepreciationAccountId))
    .where(and(...conditions))
    .orderBy(asc(fixedAssets.createdAt));
  return rows.map(
    ({
      categoryName,
      depreciationExpenseAccountId,
      accumulatedDepreciationAccountId,
      expenseAccountNumber,
      expenseAccountName,
      expenseAccountActive,
      accumulatedAccountNumber,
      accumulatedAccountName,
      accumulatedAccountActive,
      ...asset
    }) => ({
      ...asset,
      category: {
        id: asset.categoryId,
        name: categoryName,
        depreciationExpenseAccountId,
        accumulatedDepreciationAccountId,
        expenseAccountNumber,
        expenseAccountName,
        expenseAccountActive,
        accumulatedAccountNumber,
        accumulatedAccountName,
        accumulatedAccountActive,
      },
    })
  );
}

export type PeriodBounds = { startDate: string; endDate: string; status: "open" | "locked" };

// The whole (small) period table — the plan classifies every month of a
// run against it in memory.
export async function loadPeriods(executor: Db | Tx): Promise<PeriodBounds[]> {
  return executor
    .select({ startDate: accountingPeriods.startDate, endDate: accountingPeriods.endDate, status: accountingPeriods.status })
    .from(accountingPeriods);
}

export type RunRow = typeof fixedAssetDepreciationRuns.$inferSelect;

export async function insertRun(
  tx: Tx,
  values: { throughMonth: string; verificationId: string; disposalAssetId: string | null; createdBy: string }
): Promise<RunRow> {
  const [row] = await tx.insert(fixedAssetDepreciationRuns).values(values).returning();
  return row!;
}

export async function insertDepreciations(
  tx: Tx,
  rows: { assetId: string; runId: string; month: string; amount: string }[]
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(fixedAssetDepreciations).values(rows);
}

export async function findRunById(executor: Db | Tx, id: string): Promise<RunRow | null> {
  const [row] = await executor.select().from(fixedAssetDepreciationRuns).where(eq(fixedAssetDepreciationRuns.id, id));
  return row ?? null;
}

// Booking order of runs = their AV verification: fiscal year, then the
// number allocated under the advisory lock. NOT created_at — that is the
// transaction's start time, which two overlapping transactions can invert
// relative to the order in which they actually booked. listRuns and
// findLatestActiveRun share this so "newest first" and "undoable" agree.
const RUN_BOOKING_ORDER = [desc(fiscalYears.startDate), desc(verifications.verificationNumber)];

// "Senaste körning" = the latest-booked run without a reversal.
export async function findLatestActiveRun(executor: Db | Tx): Promise<RunRow | null> {
  const [row] = await executor
    .select(getTableColumns(fixedAssetDepreciationRuns))
    .from(fixedAssetDepreciationRuns)
    .innerJoin(verifications, eq(verifications.id, fixedAssetDepreciationRuns.verificationId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .where(isNull(fixedAssetDepreciationRuns.reversalVerificationId))
    .orderBy(...RUN_BOOKING_ORDER)
    .limit(1);
  return row ?? null;
}

export type DepreciationRunRow = {
  id: string;
  throughMonth: string; // "YYYY-MM"
  createdAt: Date;
  disposalAssetId: string | null;
  disposalAssetNumber: string | null;
  verification: { id: string; displayNumber: string; date: string };
  reversalVerification: { id: string; displayNumber: string } | null;
  rowCount: number;
  amount: number;
};

export async function listRuns(
  executor: Db | Tx,
  query: { limit: number; offset: number }
): Promise<{ rows: DepreciationRunRow[]; total: number }> {
  const reversal = alias(verifications, "reversal");
  const reversalSeries = alias(verificationSeries, "reversal_series");
  const reversalYear = alias(fiscalYears, "reversal_year");
  const rows = await executor
    .select({
      id: fixedAssetDepreciationRuns.id,
      throughMonth: fixedAssetDepreciationRuns.throughMonth,
      createdAt: fixedAssetDepreciationRuns.createdAt,
      disposalAssetId: fixedAssetDepreciationRuns.disposalAssetId,
      disposalAssetNumber: fixedAssets.assetNumber,
      verificationId: verifications.id,
      date: verifications.date,
      seriesCode: verificationSeries.code,
      yearLabel: fiscalYears.label,
      verificationNumber: verifications.verificationNumber,
      reversalId: reversal.id,
      reversalSeriesCode: reversalSeries.code,
      reversalYearLabel: reversalYear.label,
      reversalNumber: reversal.verificationNumber,
      rowCount: sql<string>`(SELECT count(*) FROM fixed_asset_depreciations d WHERE d.run_id = ${fixedAssetDepreciationRuns.id})`,
      amount: sql<string>`COALESCE((SELECT SUM(d.amount) FROM fixed_asset_depreciations d WHERE d.run_id = ${fixedAssetDepreciationRuns.id}), 0)`,
    })
    .from(fixedAssetDepreciationRuns)
    .innerJoin(verifications, eq(verifications.id, fixedAssetDepreciationRuns.verificationId))
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .innerJoin(fiscalYears, eq(fiscalYears.id, verifications.fiscalYearId))
    .leftJoin(fixedAssets, eq(fixedAssets.id, fixedAssetDepreciationRuns.disposalAssetId))
    .leftJoin(reversal, eq(reversal.id, fixedAssetDepreciationRuns.reversalVerificationId))
    .leftJoin(reversalSeries, eq(reversalSeries.id, reversal.seriesId))
    .leftJoin(reversalYear, eq(reversalYear.id, reversal.fiscalYearId))
    .orderBy(...RUN_BOOKING_ORDER)
    .limit(query.limit)
    .offset(query.offset);
  const [totalRow] = await executor.select({ total: count() }).from(fixedAssetDepreciationRuns);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      throughMonth: monthKey(row.throughMonth),
      createdAt: row.createdAt,
      disposalAssetId: row.disposalAssetId,
      disposalAssetNumber: row.disposalAssetNumber,
      verification: { id: row.verificationId, date: row.date, displayNumber: `${row.seriesCode}-${row.yearLabel}-${row.verificationNumber}` },
      reversalVerification:
        row.reversalId !== null
          ? { id: row.reversalId, displayNumber: `${row.reversalSeriesCode}-${row.reversalYearLabel}-${row.reversalNumber}` }
          : null,
      rowCount: Number(row.rowCount),
      amount: Number(row.amount),
    })),
    total: Number(totalRow?.total ?? 0),
  };
}

// True when any of the run's rows belongs to an asset that has since been
// disposed. A disposal with nothing to catch up leaves no run row, so this
// is the only trace that the run lies before a disposal — see
// RunPrecedesDisposalError.
export async function runTouchesDisposedAsset(executor: Db | Tx, runId: string): Promise<boolean> {
  const [row] = await executor
    .select({ total: count() })
    .from(fixedAssetDepreciations)
    .innerJoin(fixedAssets, eq(fixedAssets.id, fixedAssetDepreciations.assetId))
    .where(and(eq(fixedAssetDepreciations.runId, runId), eq(fixedAssets.status, "disposed")));
  return Number(row?.total ?? 0) > 0;
}

// Undo: the run's live rows stop counting. Never a DELETE — the rows keep
// pointing at the booked verification.
export async function supersedeDepreciations(tx: Tx, runId: string): Promise<number> {
  const rows = await tx
    .update(fixedAssetDepreciations)
    .set({ supersededByRunId: runId })
    .where(and(eq(fixedAssetDepreciations.runId, runId), isNull(fixedAssetDepreciations.supersededByRunId)))
    .returning({ id: fixedAssetDepreciations.id });
  return rows.length;
}

export async function markRunReversed(tx: Tx, runId: string, reversalVerificationId: string): Promise<void> {
  await tx
    .update(fixedAssetDepreciationRuns)
    .set({ reversalVerificationId })
    .where(eq(fixedAssetDepreciationRuns.id, runId));
}

// --- Avskrivningsplan ---

export async function findFiscalYear(executor: Db | Tx, id: string) {
  const [row] = await executor
    .select({ id: fiscalYears.id, label: fiscalYears.label, startDate: fiscalYears.startDate, endDate: fiscalYears.endDate })
    .from(fiscalYears)
    .where(eq(fiscalYears.id, id));
  return row ?? null;
}

export async function listPlanAssets(executor: Db | Tx) {
  return executor
    .select({
      id: fixedAssets.id,
      assetNumber: fixedAssets.assetNumber,
      name: fixedAssets.name,
      categoryId: fixedAssets.categoryId,
      acquisitionDate: fixedAssets.acquisitionDate,
      acquisitionCost: fixedAssets.acquisitionCost,
      disposalDate: fixedAssets.disposalDate,
      openingDepreciation: fixedAssets.openingDepreciation,
      openingDepreciationThroughMonth: fixedAssets.openingDepreciationThroughMonth,
    })
    .from(fixedAssets)
    .orderBy(asc(fixedAssets.createdAt));
}

// Every live row with its run's verification date — the plan's date key.
export async function listActiveDepreciationDates(executor: Db | Tx) {
  return executor
    .select({ assetId: fixedAssetDepreciations.assetId, date: verifications.date, amount: fixedAssetDepreciations.amount })
    .from(fixedAssetDepreciations)
    .innerJoin(fixedAssetDepreciationRuns, eq(fixedAssetDepreciationRuns.id, fixedAssetDepreciations.runId))
    .innerJoin(verifications, eq(verifications.id, fixedAssetDepreciationRuns.verificationId))
    .where(isNull(fixedAssetDepreciations.supersededByRunId));
}
