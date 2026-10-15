import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditLog, db, fixedAssetDepreciationRuns, fixedAssetDepreciations } from "@navet/db";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { missingMonths } from "../src/modules/economy/service/depreciation-schedule.js";
import {
  DepreciationMonthInFutureError,
  DepreciationRunNotLatestError,
  FixedAssetFieldLockedError,
  FixedAssetLifeTooShortError,
  NothingToDepreciateError,
  currentMonthStockholm,
  stockholmToday,
} from "../src/modules/economy/service/fixed-asset.service.js";
import {
  MissingPostingAccountError,
  NoAccountingPeriodForPostingError,
} from "../src/modules/economy/service/verification-poster.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { PLAN_YEAR, accountId, resetFixedAssets, setupFixedAssets, testFixedAssetService } from "./helpers/fixed-assets.js";

const service = testFixedAssetService;
const Y = PLAN_YEAR;

beforeEach(resetFixedAssets);
afterAll(resetFixedAssets);

async function createAsset(
  userId: string,
  categoryId: string,
  overrides: Partial<{
    name: string;
    acquisitionDate: string;
    acquisitionCost: number;
    residualValue: number;
    usefulLifeMonths: number;
    depreciationStartMonth: string;
  }> = {}
) {
  return service.createAsset(
    {
      name: "CNC-fräs",
      categoryId,
      acquisitionDate: `${Y}-02-14`,
      acquisitionCost: 120000,
      residualValue: 0,
      usefulLifeMonths: 60,
      ...overrides,
    },
    userId
  );
}

async function lockMonth(fiscalYearId: string, month: string, userId: string) {
  const year = await testEconomyService.findFiscalYearById(fiscalYearId);
  const period = year.periods.find((p) => p.startDate === `${month}-01`)!;
  await testEconomyService.lockPeriod(period.id, userId);
}

async function verificationRows(verificationId: string) {
  const verification = await testEconomyService.findVerificationById(verificationId);
  return {
    displayNumber: verification.displayNumber,
    date: verification.date,
    description: verification.description,
    rows: verification.rows.map((row) => ({ account: row.accountNumber, debit: Number(row.debit), credit: Number(row.credit) })),
  };
}

async function runCount() {
  const [row] = await db.select({ n: sql<string>`count(*)` }).from(fixedAssetDepreciationRuns);
  return Number(row!.n);
}

async function liveRows() {
  const rows = await db
    .select({ assetId: fixedAssetDepreciations.assetId, month: fixedAssetDepreciations.month, amount: fixedAssetDepreciations.amount })
    .from(fixedAssetDepreciations)
    .where(sql`${fixedAssetDepreciations.supersededByRunId} IS NULL`);
  return rows.map((row) => ({ month: row.month, amount: Number(row.amount) })).sort((a, b) => a.month.localeCompare(b.month));
}

describe("bokför avskrivningar", () => {
  it("books every month from the start month through the chosen month as one AV verification", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await createAsset(user.id, category.id);
    const result = await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);

    expect(result.rows.map((row) => row.month)).toEqual([`${Y}-02`, `${Y}-03`, `${Y}-04`, `${Y}-05`, `${Y}-06`]);
    expect(result.rows.every((row) => row.amount === 2000)).toBe(true);
    expect(result.total).toBe(10000);
    expect(result.byCategory).toEqual([
      expect.objectContaining({ categoryName: "Inventarier", expenseAccountNumber: "7830", accumulatedAccountNumber: "1229", amount: 10000 }),
    ]);

    const verification = await verificationRows(result.verification.id);
    expect(verification.displayNumber).toBe(`AV-${Y}-1`);
    expect(verification.date).toBe(`${Y}-06-30`);
    expect(verification.description).toBe(`Avskrivningar t.o.m. ${Y}-06`);
    expect(verification.rows).toEqual([
      { account: "7830", debit: 10000, credit: 0 },
      { account: "1229", debit: 0, credit: 10000 },
    ]);

    const detail = await service.getAsset(asset.id);
    expect(detail.accumulatedDepreciation).toBe(10000);
    expect(detail.bookValue).toBe(110000);
    expect(detail.depreciations).toHaveLength(5);
    expect(detail.depreciations[0]).toMatchObject({ month: `${Y}-02`, amount: 2000, displayNumber: `AV-${Y}-1`, reversed: false });
    expect(detail.plannedMonths[0]).toEqual({ month: `${Y}-07`, amount: 2000 });

    const audits = await db.select().from(auditLog).where(eq(auditLog.entityType, "fixed_asset_depreciation_run"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("booked");
  });

  it("is idempotent: a second run for the same month has nothing to book, a later month books only the new months", async () => {
    const { user, category } = await setupFixedAssets();
    await createAsset(user.id, category.id);
    await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    await expect(service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id)).rejects.toBeInstanceOf(NothingToDepreciateError);
    await expect(db.transaction((tx) => service.runDepreciation(tx, { throughMonth: `${Y}-06` }, user.id))).resolves.toBeNull();

    const later = await service.bookDepreciation({ throughMonth: `${Y}-09` }, user.id);
    expect(later.rows.map((row) => row.month)).toEqual([`${Y}-07`, `${Y}-08`, `${Y}-09`]);
    expect(later.verification.displayNumber).toBe(`AV-${Y}-2`);
    expect(await runCount()).toBe(2);
  });

  it("merges two categories on one expense account into one debit row and keeps one credit row per ack-konto", async () => {
    const { user, category } = await setupFixedAssets();
    const datorer = await service.createCategory({
      name: "Datorer",
      assetAccountId: await accountId("1250"),
      accumulatedDepreciationAccountId: await accountId("1259"),
      depreciationExpenseAccountId: await accountId("7830"),
      disposalGainAccountId: await accountId("3973"),
      disposalLossAccountId: await accountId("7970"),
      defaultUsefulLifeMonths: 36,
    });
    await createAsset(user.id, category.id);
    await createAsset(user.id, datorer.id, { name: "Server", acquisitionDate: `${Y}-01-10`, acquisitionCost: 54000, usefulLifeMonths: 36 });
    const result = await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    // 5 × 2 000 + 6 × 1 500
    expect(result.total).toBe(19000);
    expect((await verificationRows(result.verification.id)).rows).toEqual([
      { account: "7830", debit: 19000, credit: 0 },
      { account: "1229", debit: 0, credit: 10000 },
      { account: "1259", debit: 0, credit: 9000 },
    ]);
  });

  it("skips assets that start later, are fully depreciated, or have residual = cost", async () => {
    const { user, category } = await setupFixedAssets();
    await createAsset(user.id, category.id, { name: "Sen", depreciationStartMonth: `${Y}-09` });
    await createAsset(user.id, category.id, { name: "Mark", acquisitionCost: 500000, residualValue: 500000 });
    const short = await createAsset(user.id, category.id, { name: "Kort", acquisitionCost: 3000, usefulLifeMonths: 3 });
    const result = await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    expect(result.rows.map((row) => row.assetNumber)).toEqual(["AN-3", "AN-3", "AN-3"]);
    expect(result.rows.map((row) => row.month)).toEqual([`${Y}-02`, `${Y}-03`, `${Y}-04`]);
    expect((await service.getAsset(short.id)).plannedMonths).toEqual([]);
    await expect(service.bookDepreciation({ throughMonth: `${Y}-08` }, user.id)).rejects.toBeInstanceOf(NothingToDepreciateError);
  });

  it("puts the rounding remainder in the last month so the lifetime sum is exact", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await createAsset(user.id, category.id, {
      acquisitionDate: `${Y - 3}-02-01`,
      depreciationStartMonth: `${Y - 3}-02`,
      acquisitionCost: 100000,
      usefulLifeMonths: 36,
    });
    // 36 months from Feb Y-3 end in Jan Y; those earlier years have no
    // periods, so everything is caught up in one run dated Jan Y. The
    // amounts are whatever the plan rule says (recomputed per month), not a
    // hand-typed figure.
    const expected = missingMonths(
      { acquisitionCost: 100000, residualValue: 0, usefulLifeMonths: 36, depreciationStartMonth: `${Y - 3}-02`, bookedMonths: [] },
      `${Y}-01`
    );
    const result = await service.bookDepreciation({ throughMonth: `${Y}-01` }, user.id);
    expect(result.rows).toHaveLength(36);
    expect(result.rows.map((row) => ({ month: row.month, amount: row.amount }))).toEqual(expected);
    expect(result.rows[35]!.month).toBe(`${Y}-01`);
    // The last month absorbs the remainder: not the per-month figure.
    expect(result.rows[35]!.amount).not.toBe(result.rows[0]!.amount);
    expect(result.total).toBe(100000);
    expect((await service.getAsset(asset.id)).bookValue).toBe(0);
  });

  it("books the same live rows whether the months come in one run or one run per month", async () => {
    // A base that does not divide evenly, so the per-month recomputation is
    // exercised: 100 000 over 36 months.
    const overrides = { acquisitionDate: `${Y}-01-05`, acquisitionCost: 100000, usefulLifeMonths: 36 };

    const first = await setupFixedAssets();
    await createAsset(first.user.id, first.category.id, overrides);
    for (const month of ["01", "02", "03", "04", "05", "06"]) {
      await service.bookDepreciation({ throughMonth: `${Y}-${month}` }, first.user.id);
    }
    const monthByMonth = await liveRows();
    expect(await runCount()).toBe(6);

    await resetFixedAssets();
    const second = await setupFixedAssets();
    await createAsset(second.user.id, second.category.id, overrides);
    await service.bookDepreciation({ throughMonth: `${Y}-06` }, second.user.id);
    const oneRun = await liveRows();
    expect(await runCount()).toBe(1);

    expect(monthByMonth).toHaveLength(6);
    expect(oneRun).toEqual(monthByMonth);
  });

  // Final review, item 2 (controller ruling): an ordinary run needs the
  // month to have ENDED — the current month is refused, the previous month
  // is the latest bookable one. A disposal's catch-up is exempt: it is dated
  // on the disposal day and books through the disposal month, even today.
  it("refuses the current month for an ordinary run, accepts the previous month, and lets a disposal today catch up through this month", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await createAsset(user.id, category.id);
    const current = currentMonthStockholm();
    const [year, month] = current.split("-").map(Number);
    const previous = new Date(Date.UTC(year!, month! - 2, 1)).toISOString().slice(0, 7);

    await expect(service.bookDepreciation({ throughMonth: current }, user.id)).rejects.toBeInstanceOf(DepreciationMonthInFutureError);
    expect(await runCount()).toBe(0);
    expect((await service.previewDepreciation({ throughMonth: current })).warnings).toContain("month-in-future");
    expect((await service.previewDepreciation({ throughMonth: previous })).warnings).not.toContain("month-in-future");

    const run = await service.bookDepreciation({ throughMonth: previous }, user.id);
    expect(run.rows[run.rows.length - 1]!.month).toBe(previous);

    const disposed = await service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: stockholmToday() }, user.id);
    expect(disposed.depreciationRun).not.toBeNull();
    const detail = await service.getAsset(asset.id);
    expect(detail.depreciations.map((row) => row.month)).toContain(current);
    expect(detail.depreciations.every((row) => !row.reversed)).toBe(true);
  });

  it("refuses a future month, a locked month and a month without a period — and writes nothing", async () => {
    const { user, category, planYearId } = await setupFixedAssets();
    await createAsset(user.id, category.id);
    const nextYear = new Date().getFullYear() + 1;
    await expect(service.bookDepreciation({ throughMonth: `${nextYear}-01` }, user.id)).rejects.toBeInstanceOf(DepreciationMonthInFutureError);

    await lockMonth(planYearId, `${Y}-06`, user.id);
    await expect(service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id)).rejects.toBeInstanceOf(AccountingPeriodLockedError);

    // Review Focus 2: an asset whose run month has no accounting period at all.
    await createAsset(user.id, category.id, { name: "Gammal", acquisitionDate: `${Y - 1}-12-01`, depreciationStartMonth: `${Y - 1}-12` });
    await expect(service.bookDepreciation({ throughMonth: `${Y - 1}-12` }, user.id)).rejects.toBeInstanceOf(
      NoAccountingPeriodForPostingError
    );

    expect(await runCount()).toBe(0);
    expect(await db.select().from(fixedAssetDepreciations)).toEqual([]);
  });

  // Årsbokslut (delprojekt 3): a regular run dated on a chosen day — bookable
  // once that DAY has passed and only inside throughMonth; never with scope.
  it("dates a regular run on `date`, refusing today, another month and a combination with scope", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await createAsset(user.id, category.id);
    const today = stockholmToday();
    const run = (input: Parameters<typeof service.runDepreciation>[1]) =>
      db.transaction((tx) => service.runDepreciation(tx, input, user.id));

    await expect(run({ throughMonth: today.slice(0, 7), date: today })).rejects.toBeInstanceOf(DepreciationMonthInFutureError);
    await expect(run({ throughMonth: `${Y}-05`, date: `${Y}-06-20` })).rejects.toBeInstanceOf(DepreciationMonthInFutureError);
    await expect(
      run({ throughMonth: `${Y}-06`, date: `${Y}-06-20`, scope: { assetId: asset.id, date: `${Y}-06-20` } })
    ).rejects.toThrow("mutually exclusive");
    expect(await runCount()).toBe(0);

    const expected = (await service.previewDepreciation({ throughMonth: `${Y}-06` })).total;
    const result = await run({ throughMonth: `${Y}-06`, date: `${Y}-06-20` });
    expect(result!.total).toBe(expected);
    expect(result!.rows[result!.rows.length - 1]!.month).toBe(`${Y}-06`);
    expect((await verificationRows(result!.verification.id)).date).toBe(`${Y}-06-20`);
  });

  it("catches up months in locked or missing periods on the run's own open date and says so in the preview", async () => {
    const { user, category, planYearId } = await setupFixedAssets();
    await createAsset(user.id, category.id);
    // Started in a month with no accounting period at all (the year before
    // the first fiscal year): booked on the run date just like a locked month.
    await createAsset(user.id, category.id, {
      name: "Gammal",
      acquisitionDate: `${Y - 1}-12-01`,
      acquisitionCost: 70000,
      usefulLifeMonths: 70,
    });
    await lockMonth(planYearId, `${Y}-02`, user.id);
    await lockMonth(planYearId, `${Y}-03`, user.id);

    const preview = await service.previewDepreciation({ throughMonth: `${Y}-06` });
    expect(preview.periodStatus).toBe("open");
    expect(preview.warnings).toEqual([]);
    expect(preview.assets[0]!.catchUpMonths).toEqual([`${Y}-02`, `${Y}-03`]);
    expect(preview.assets[1]!.catchUpMonths).toEqual([`${Y - 1}-12`, `${Y}-02`, `${Y}-03`]);
    // 5 × 2 000 + 7 × 1 000
    expect(preview.total).toBe(17000);
    expect(preview.lastRun).toBeNull();

    const result = await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    expect(result.rows).toHaveLength(12);
    expect((await verificationRows(result.verification.id)).date).toBe(`${Y}-06-30`);

    const after = await service.previewDepreciation({ throughMonth: `${Y}-06` });
    expect(after.lastRun).toMatchObject({ throughMonth: `${Y}-06`, displayNumber: `AV-${Y}-1` });
    expect(after.assets).toEqual([]);
    const locked = await service.previewDepreciation({ throughMonth: `${Y}-03` });
    expect(locked.warnings).toEqual(["period-locked"]);
  });

  // Review Focus 1: the category's account was deactivated after assets existed.
  it("refuses to book on a deactivated category account and leaves no trace", async () => {
    const { user, category } = await setupFixedAssets();
    await createAsset(user.id, category.id);
    const ack = await testEconomyRepository.findAccountByNumber("1229");
    await testEconomyService.updateAccount(ack!.id, { active: false });
    // Final review, item 5: the preview says so before the 409 — with the
    // account and the group, so the user knows what to fix.
    const preview = await service.previewDepreciation({ throughMonth: `${Y}-06` });
    expect(preview.warnings).toEqual(["inactive-account"]);
    expect(preview.inactiveAccounts).toEqual([
      { accountNumber: "1229", accountName: "Ack avskrivningar inventarier", categoryName: "Inventarier", role: "accumulated" },
    ]);
    expect(preview.total).toBe(10000);
    await expect(service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id)).rejects.toBeInstanceOf(MissingPostingAccountError);
    expect(await runCount()).toBe(0);
    expect(await db.select().from(fixedAssetDepreciations)).toEqual([]);
  });

  it("serializes two parallel runs: exactly one books, the other finds nothing", async () => {
    const { user, category } = await setupFixedAssets();
    await createAsset(user.id, category.id);
    const results = await Promise.allSettled([
      service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id),
      service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(NothingToDepreciateError);
    expect(await runCount()).toBe(1);
    expect(await db.select().from(fixedAssetDepreciations)).toHaveLength(5);
  });

  it("locks the defining fields after the first run and re-spreads a prospective change", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await createAsset(user.id, category.id);
    await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);

    await expect(service.updateAsset(asset.id, { acquisitionCost: 130000 }, user.id)).rejects.toBeInstanceOf(FixedAssetFieldLockedError);
    await expect(service.updateAsset(asset.id, { depreciationStartMonth: `${Y}-03` }, user.id)).rejects.toBeInstanceOf(
      FixedAssetFieldLockedError
    );
    await expect(service.updateAsset(asset.id, { usefulLifeMonths: 5 }, user.id)).rejects.toBeInstanceOf(FixedAssetLifeTooShortError);

    // Spec section 6: 48 months and 6 000 residual after 5 × 2 000 booked —
    // 104 000 over the 43 remaining months.
    const updated = await service.updateAsset(asset.id, { usefulLifeMonths: 48, residualValue: 6000 }, user.id);
    expect(updated.plannedMonths).toHaveLength(43);
    expect(updated.plannedMonths[0]).toEqual({ month: `${Y}-07`, amount: 2418.6 });
    const next = await service.bookDepreciation({ throughMonth: `${Y}-07` }, user.id);
    expect(next.rows).toEqual([expect.objectContaining({ month: `${Y}-07`, amount: 2418.6 })]);
    // Name and note stay editable.
    expect((await service.updateAsset(asset.id, { name: "CNC-fräs B" }, user.id)).name).toBe("CNC-fräs B");
  });

  // Final review, item 4: "latest" is booking order = the AV verification
  // number (allocated under the advisory lock), not created_at (the
  // transaction's start time, which two overlapping transactions can invert).
  it("orders runs by their verification number, not created_at", async () => {
    const { user, category } = await setupFixedAssets();
    await createAsset(user.id, category.id);
    const first = await service.bookDepreciation({ throughMonth: `${Y}-03` }, user.id);
    const second = await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    expect(first.verification.displayNumber).toBe(`AV-${Y}-1`);
    expect(second.verification.displayNumber).toBe(`AV-${Y}-2`);
    // Invert the creation order: the earlier-numbered run now looks newest.
    await db
      .update(fixedAssetDepreciationRuns)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(fixedAssetDepreciationRuns.id, first.run.id));

    const runs = await service.listRuns({ limit: 50, offset: 0 });
    expect(runs.rows.map((run) => run.verification.displayNumber)).toEqual([`AV-${Y}-2`, `AV-${Y}-1`]);
    expect(runs.rows.map((run) => run.undoable)).toEqual([true, false]);
    const preview = await service.previewDepreciation({ throughMonth: `${Y}-06` });
    expect(preview.lastRun).toMatchObject({ id: second.run.id, displayNumber: `AV-${Y}-2` });
    await expect(service.undoRun(first.run.id, user.id)).rejects.toBeInstanceOf(DepreciationRunNotLatestError);
    await service.undoRun(second.run.id, user.id);
  });

  it("lists runs newest first and marks only the latest as undoable", async () => {
    const { user, category } = await setupFixedAssets();
    await createAsset(user.id, category.id);
    await service.bookDepreciation({ throughMonth: `${Y}-03` }, user.id);
    await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    const runs = await service.listRuns({ limit: 50, offset: 0 });
    expect(runs.total).toBe(2);
    expect(runs.rows.map((run) => run.throughMonth)).toEqual([`${Y}-06`, `${Y}-03`]);
    expect(runs.rows[0]).toMatchObject({ rowCount: 3, amount: 6000, undoable: true, reversalVerification: null });
    expect(runs.rows[1]!.undoable).toBe(false);
  });
});
