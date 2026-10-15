import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, db } from "@navet/db";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { AlreadyReversedError, FixedAssetVerificationError } from "../src/modules/economy/service/economy.service.js";
import {
  DepreciationRunNotFoundError,
  DepreciationRunNotLatestError,
  FixedAssetHasDepreciationError,
  RunPrecedesDisposalError,
} from "../src/modules/economy/service/fixed-asset.service.js";
import { testEconomyService } from "./helpers/services.js";
import { PLAN_YEAR, resetFixedAssets, setupFixedAssets, testFixedAssetService } from "./helpers/fixed-assets.js";

const service = testFixedAssetService;
const Y = PLAN_YEAR;

beforeEach(resetFixedAssets);
afterAll(resetFixedAssets);

async function setupWithRuns() {
  const base = await setupFixedAssets();
  const asset = await service.createAsset(
    { name: "CNC-fräs", categoryId: base.category.id, acquisitionDate: `${Y}-02-14`, acquisitionCost: 120000, usefulLifeMonths: 60 },
    base.user.id
  );
  const first = await service.bookDepreciation({ throughMonth: `${Y}-03` }, base.user.id);
  const second = await service.bookDepreciation({ throughMonth: `${Y}-06` }, base.user.id);
  return { ...base, asset, first, second };
}

describe("ångra senaste körning", () => {
  it("reverses the latest run on its own date, supersedes its rows and lets the next run rebook them", async () => {
    const { user, asset, second } = await setupWithRuns();
    const undone = await service.undoRun(second.run.id, user.id);
    expect(undone.reversalVerification.displayNumber).toBe(`AV-${Y}-3`);

    const reversal = await testEconomyService.findVerificationById(undone.reversalVerification.id);
    expect(reversal.date).toBe(`${Y}-06-30`);
    expect(reversal.reversesVerificationId).toBe(second.verification.id);
    expect(reversal.rows.map((row) => ({ account: row.accountNumber, debit: Number(row.debit), credit: Number(row.credit) }))).toEqual([
      { account: "7830", debit: 0, credit: 6000 },
      { account: "1229", debit: 6000, credit: 0 },
    ]);

    const detail = await service.getAsset(asset.id);
    expect(detail.accumulatedDepreciation).toBe(4000);
    expect(detail.depreciations.filter((row) => row.reversed).map((row) => row.month)).toEqual([`${Y}-04`, `${Y}-05`, `${Y}-06`]);
    expect(detail.plannedMonths[0]).toEqual({ month: `${Y}-04`, amount: 2000 });

    const runs = await service.listRuns({ limit: 50, offset: 0 });
    expect(runs.rows[0]).toMatchObject({ undoable: false, reversalVerification: { displayNumber: `AV-${Y}-3` } });
    expect(runs.rows[1]!.undoable).toBe(true);

    const rebooked = await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    expect(rebooked.rows.map((row) => row.month)).toEqual([`${Y}-04`, `${Y}-05`, `${Y}-06`]);
    expect((await service.getAsset(asset.id)).accumulatedDepreciation).toBe(10000);

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "undone"));
    expect(audits).toHaveLength(1);
  });

  it("refuses a run that is not the latest, a second undo, an unknown run and a locked period", async () => {
    const { user, first, second, planYearId } = await setupWithRuns();
    await expect(service.undoRun(first.run.id, user.id)).rejects.toBeInstanceOf(DepreciationRunNotLatestError);
    await expect(service.undoRun(crypto.randomUUID(), user.id)).rejects.toBeInstanceOf(DepreciationRunNotFoundError);

    const year = await testEconomyService.findFiscalYearById(planYearId);
    await testEconomyService.lockPeriod(year.periods.find((p) => p.startDate === `${Y}-06-01`)!.id, user.id);
    await expect(service.undoRun(second.run.id, user.id)).rejects.toBeInstanceOf(AccountingPeriodLockedError);
    await testEconomyService.unlockPeriod(year.periods.find((p) => p.startDate === `${Y}-06-01`)!.id, "Testet låser upp", user.id);

    await service.undoRun(second.run.id, user.id);
    await expect(service.undoRun(second.run.id, user.id)).rejects.toBeInstanceOf(AlreadyReversedError);
    // After the undo the first run is the latest again.
    await service.undoRun(first.run.id, user.id);
    expect((await service.listRuns({ limit: 50, offset: 0 })).rows.every((run) => run.reversalVerification !== null)).toBe(true);
  });

  it("blocks the generic Omför on the register's verifications and links them from the detail", async () => {
    const { user, second } = await setupWithRuns();
    await expect(testEconomyService.reverse(second.verification.id, user.id)).rejects.toBeInstanceOf(FixedAssetVerificationError);
    const detail = await testEconomyService.findVerificationById(second.verification.id);
    expect(detail.fixedAsset).toEqual({ kind: "depreciation_run", runId: second.run.id, assetId: null });

    const undone = await service.undoRun(second.run.id, user.id);
    const reversalDetail = await testEconomyService.findVerificationById(undone.reversalVerification.id);
    expect(reversalDetail.fixedAsset).toEqual({ kind: "reversal", runId: second.run.id, assetId: null });
    await expect(testEconomyService.reverse(undone.reversalVerification.id, user.id)).rejects.toBeInstanceOf(FixedAssetVerificationError);
  });

  // Final review, item 1: a disposal whose months were already booked leaves
  // no catch-up run row, so the ordinary pre-disposal run stays "latest".
  // Undoing it would supersede the disposed asset's rows after the disposal
  // verification already cleared them off the ack-konto.
  it("refuses to undo a run that has rows for a since-disposed asset (disposal without a catch-up run)", async () => {
    const { user, asset, category } = await setupWithRuns();
    // Through June is booked; a disposal in May has nothing to catch up.
    const disposed = await service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: `${Y}-05-20` }, user.id);
    expect(disposed.depreciationRun).toBeNull();
    const runs = await service.listRuns({ limit: 50, offset: 0 });
    expect(runs.total).toBe(2);
    expect(runs.rows.every((run) => run.undoable === false)).toBe(true);
    const latest = runs.rows[0]!;
    await expect(service.undoRun(latest.id, user.id)).rejects.toBeInstanceOf(RunPrecedesDisposalError);
    expect((await service.getAsset(asset.id)).accumulatedDepreciation).toBe(10000);

    // Variant: a later ordinary run over ANOTHER asset is undone first, which
    // makes the pre-disposal run the latest again — still refused.
    await service.createAsset(
      { name: "Truck", categoryId: category.id, acquisitionDate: `${Y}-07-01`, acquisitionCost: 90000, usefulLifeMonths: 60 },
      user.id
    );
    const later = await service.bookDepreciation({ throughMonth: `${Y}-08` }, user.id);
    expect(later.rows.every((row) => row.assetNumber === "AN-2")).toBe(true);
    expect((await service.listRuns({ limit: 50, offset: 0 })).rows[0]).toMatchObject({ id: later.run.id, undoable: true });
    await service.undoRun(later.run.id, user.id);
    const afterUndo = await service.listRuns({ limit: 50, offset: 0 });
    expect(afterUndo.rows.find((run) => run.id === latest.id)!.undoable).toBe(false);
    await expect(service.undoRun(latest.id, user.id)).rejects.toBeInstanceOf(RunPrecedesDisposalError);
    expect((await service.getAsset(asset.id)).accumulatedDepreciation).toBe(10000);
  });

  it("undoes a run on an asset with an opening depreciation and leaves the opening untouched", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await service.createAsset(
      {
        name: "Gammal svarv",
        categoryId: category.id,
        acquisitionDate: `${Y - 2}-03-15`,
        acquisitionCost: 120000,
        usefulLifeMonths: 60,
        openingDepreciation: 44000,
        openingDepreciationThroughMonth: `${Y - 1}-12`,
      },
      user.id
    );
    const run = await service.bookDepreciation({ throughMonth: `${Y}-03` }, user.id);
    expect(run.rows.map((row) => row.month)).toEqual([`${Y}-01`, `${Y}-02`, `${Y}-03`]);
    const undone = await service.undoRun(run.run.id, user.id);
    expect(undone.reversalVerification.displayNumber).toBe(`AV-${Y}-2`);
    const detail = await service.getAsset(asset.id);
    expect(detail.accumulatedDepreciation).toBe(44000);
    expect(detail.bookValue).toBe(76000);
    expect(detail.openingDepreciation).toBe("44000.00");
    expect(detail.openingDepreciationThroughMonth).toBe(`${Y - 1}-12-01`);
    expect(detail.depreciations.every((row) => row.reversed)).toBe(true);
    expect(detail.plannedMonths[0]!.month).toBe(`${Y}-01`);
  });

  // Review Focus 5: superseded rows still point at booked verifications.
  it("still refuses to delete an asset whose only run was undone", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await service.createAsset(
      { name: "Fel", categoryId: category.id, acquisitionDate: `${Y}-02-14`, acquisitionCost: 1200 },
      user.id
    );
    const run = await service.bookDepreciation({ throughMonth: `${Y}-02` }, user.id);
    await service.undoRun(run.run.id, user.id);
    await expect(service.deleteAsset(asset.id, user.id)).rejects.toBeInstanceOf(FixedAssetHasDepreciationError);
  });
});
