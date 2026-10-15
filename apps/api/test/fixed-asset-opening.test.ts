import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, fixedAssetDepreciations } from "@navet/db";
import { addMonths, missingMonths } from "../src/modules/economy/service/depreciation-schedule.js";
import {
  FixedAssetFieldLockedError,
  FixedAssetLifeTooShortError,
  InvalidOpeningDepreciationError,
  NothingToDepreciateError,
  currentMonthStockholm,
} from "../src/modules/economy/service/fixed-asset.service.js";
import { testEconomyService } from "./helpers/services.js";
import { PLAN_YEAR, resetFixedAssets, setupFixedAssets, testFixedAssetService } from "./helpers/fixed-assets.js";

// Ingående avskrivning: an asset acquired before the company started
// bookkeeping in Nav already carries accumulated depreciation in the opening
// balance. The register treats that amount exactly like months already
// booked — the plan rule (missingMonths) sees it as a synthetic booked entry
// on the through-month and nothing is ever stored in fixed_asset_depreciations.

const service = testFixedAssetService;
const Y = PLAN_YEAR;

// Acquired two years before the plan year, 60 months from Mar Y-2 → Feb Y+3.
// Depreciated outside Nav through Dec Y-1 (22 months); 45 000 does not divide
// evenly over the 38 remaining months, so the per-month recomputation shows.
const ACQUIRED = { acquisitionDate: `${Y - 2}-03-15`, depreciationStartMonth: `${Y - 2}-03`, acquisitionCost: 120000, usefulLifeMonths: 60 };
const THROUGH = `${Y - 1}-12`;
const OPENING = 45000;
const LAST_MONTH = `${Y + 3}-02`;

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
    openingDepreciation: number;
    openingDepreciationThroughMonth: string | null;
  }> = {}
) {
  return service.createAsset(
    {
      name: "Gammal svarv",
      categoryId,
      ...ACQUIRED,
      residualValue: 0,
      openingDepreciation: OPENING,
      openingDepreciationThroughMonth: THROUGH,
      ...overrides,
    },
    userId
  );
}

function expectedPlan(throughMonth: string, booked: { month: string; amount: number }[] = []) {
  return missingMonths(
    {
      acquisitionCost: ACQUIRED.acquisitionCost,
      residualValue: 0,
      usefulLifeMonths: ACQUIRED.usefulLifeMonths,
      depreciationStartMonth: ACQUIRED.depreciationStartMonth,
      bookedMonths: [{ month: THROUGH, amount: OPENING }, ...booked],
    },
    throughMonth
  );
}

async function storedRowCount() {
  return (await db.select().from(fixedAssetDepreciations)).length;
}

describe("ingående avskrivning", () => {
  it("derives accumulated depreciation and book value from the opening amount and plans from the month after", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await createAsset(user.id, category.id);

    expect(asset.openingDepreciation).toBe("45000.00");
    expect(asset.openingDepreciationThroughMonth).toBe(`${THROUGH}-01`);
    expect(asset.accumulatedDepreciation).toBe(OPENING);
    expect(asset.bookValue).toBe(75000);
    // Nothing synthetic is stored: the card's row table and the row count stay empty.
    expect(asset.depreciations).toEqual([]);
    expect(asset.bookedMonthCount).toBe(0);
    expect(await storedRowCount()).toBe(0);

    expect(asset.plannedMonths).toHaveLength(38);
    expect(asset.plannedMonths[0]!.month).toBe(`${Y}-01`);
    expect(asset.plannedMonths.at(-1)!.month).toBe(LAST_MONTH);
    expect(asset.plannedMonths).toEqual(expectedPlan(LAST_MONTH));
    // The remaining base, not the whole base, is what the plan spreads.
    expect(asset.plannedMonths.reduce((sum, row) => sum + row.amount, 0)).toBeCloseTo(75000, 2);

    const list = await service.listAssets({ limit: 50, offset: 0 });
    expect(list.rows[0]).toMatchObject({ accumulatedDepreciation: OPENING, bookValue: 75000 });
  });

  it("refuses an opening depreciation that contradicts the plan", async () => {
    const { user, category } = await setupFixedAssets();
    const rejects = async (overrides: Parameters<typeof createAsset>[2]) =>
      expect(createAsset(user.id, category.id, overrides)).rejects.toBeInstanceOf(InvalidOpeningDepreciationError);

    // Through-month before the plan starts, after it ends.
    await rejects({ openingDepreciationThroughMonth: `${Y - 2}-02` });
    await rejects({ openingDepreciationThroughMonth: addMonths(LAST_MONTH, 1) });
    // The opening amount is history: the current month and the future are refused.
    const current = currentMonthStockholm();
    await rejects({ openingDepreciationThroughMonth: current });
    await rejects({ openingDepreciationThroughMonth: addMonths(current, 1) });
    // More than cost − residual.
    await rejects({ openingDepreciation: 120000.01 });
    await rejects({ residualValue: 80000, openingDepreciation: 40000.01 });
    // One of the two without the other (the service, not only zod, must hold the line).
    await rejects({ openingDepreciationThroughMonth: null });
    await rejects({ openingDepreciation: 0 });
    // Through-month = the plan's last month while depreciable value remains:
    // missingMonths would return [] forever.
    await rejects({ usefulLifeMonths: 22, openingDepreciation: 1000 });

    // Exactly the base through the plan's last month is the "fully
    // depreciated before Nav" case and is fine.
    const settled = await createAsset(user.id, category.id, { usefulLifeMonths: 22, openingDepreciation: 120000 });
    expect(settled.bookValue).toBe(0);
    expect(settled.plannedMonths).toEqual([]);
    // residual = cost with no opening is still allowed (unchanged behaviour).
    const land = await createAsset(user.id, category.id, {
      name: "Mark",
      acquisitionCost: 500000,
      residualValue: 500000,
      openingDepreciation: 0,
      openingDepreciationThroughMonth: null,
    });
    expect(land.plannedMonths).toEqual([]);
  });

  it("can be edited or cleared before the first run and is locked after it", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await createAsset(user.id, category.id);

    // Amount alone: the stored through-month is kept.
    const raised = await service.updateAsset(asset.id, { openingDepreciation: 50000 }, user.id);
    expect(raised).toMatchObject({ openingDepreciation: "50000.00", accumulatedDepreciation: 50000, bookValue: 70000 });
    expect(raised.plannedMonths[0]!.month).toBe(`${Y}-01`);

    // Cleared: the plan starts from the start month again.
    const cleared = await service.updateAsset(asset.id, { openingDepreciation: 0, openingDepreciationThroughMonth: null }, user.id);
    expect(cleared).toMatchObject({ openingDepreciation: "0.00", openingDepreciationThroughMonth: null, accumulatedDepreciation: 0 });
    expect(cleared.plannedMonths[0]!.month).toBe(`${Y - 2}-03`);

    // The merged row is validated: an amount without a stored month, a month
    // before the start, a residual that eats the opening amount.
    await expect(service.updateAsset(asset.id, { openingDepreciation: 1000 }, user.id)).rejects.toBeInstanceOf(InvalidOpeningDepreciationError);
    await expect(
      service.updateAsset(asset.id, { openingDepreciation: 1000, openingDepreciationThroughMonth: `${Y - 2}-01` }, user.id)
    ).rejects.toBeInstanceOf(InvalidOpeningDepreciationError);
    await service.updateAsset(asset.id, { openingDepreciation: OPENING, openingDepreciationThroughMonth: THROUGH }, user.id);
    await expect(service.updateAsset(asset.id, { residualValue: 80000 }, user.id)).rejects.toBeInstanceOf(InvalidOpeningDepreciationError);

    await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    await expect(service.updateAsset(asset.id, { openingDepreciation: 46000 }, user.id)).rejects.toBeInstanceOf(FixedAssetFieldLockedError);
    await expect(service.updateAsset(asset.id, { openingDepreciationThroughMonth: `${Y - 1}-11` }, user.id)).rejects.toBeInstanceOf(
      FixedAssetFieldLockedError
    );
    // Re-sending the stored values is not a change.
    const same = await service.updateAsset(
      asset.id,
      { openingDepreciation: OPENING, openingDepreciationThroughMonth: THROUGH, name: "Gammal svarv B" },
      user.id
    );
    expect(same.name).toBe("Gammal svarv B");
    // A useful life ending on or before the last booked month is still refused.
    await expect(service.updateAsset(asset.id, { usefulLifeMonths: 22 }, user.id)).rejects.toBeInstanceOf(FixedAssetLifeTooShortError);
  });

  it("starts the first run the month after the through-month with the plan rule's amounts", async () => {
    const { user, category } = await setupFixedAssets();
    const asset = await createAsset(user.id, category.id);

    const preview = await service.previewDepreciation({ throughMonth: `${Y}-06` });
    expect(preview.assets[0]!.months.map((row) => row.month)).toEqual([`${Y}-01`, `${Y}-02`, `${Y}-03`, `${Y}-04`, `${Y}-05`, `${Y}-06`]);

    const first = await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    const expectedFirst = expectedPlan(`${Y}-06`);
    expect(expectedFirst).toHaveLength(6);
    expect(first.rows.map((row) => ({ month: row.month, amount: row.amount }))).toEqual(expectedFirst);
    expect(first.rows.every((row) => row.month > THROUGH)).toBe(true);
    // 75 000 / 38 = 1 973.68…: the recomputed figure, not 2 000.
    expect(first.rows[0]!.amount).toBe(1973.68);
    expect(first.total).toBe(expectedFirst.reduce((sum, row) => sum + row.amount, 0));
    const verification = await testEconomyService.findVerificationById(first.verification.id);
    expect(verification.rows.map((row) => ({ account: row.accountNumber, debit: Number(row.debit), credit: Number(row.credit) }))).toEqual([
      { account: "7830", debit: first.total, credit: 0 },
      { account: "1229", debit: 0, credit: first.total },
    ]);
    // Only the six live months are stored — never the opening amount.
    expect(await storedRowCount()).toBe(6);

    const afterFirst = await service.getAsset(asset.id);
    expect(afterFirst.accumulatedDepreciation).toBe(OPENING + first.total);
    expect(afterFirst.bookValue).toBe(ACQUIRED.acquisitionCost - OPENING - first.total);
    expect(afterFirst.bookedMonthCount).toBe(6);
    expect(afterFirst.plannedMonths[0]!.month).toBe(`${Y}-07`);

    // A second run continues from the live rows + the opening amount.
    const second = await service.bookDepreciation({ throughMonth: `${Y}-09` }, user.id);
    expect(second.rows.map((row) => ({ month: row.month, amount: row.amount }))).toEqual(
      expectedPlan(`${Y}-09`, first.rows.map((row) => ({ month: row.month, amount: row.amount })))
    );
    expect(second.rows.map((row) => row.month)).toEqual([`${Y}-07`, `${Y}-08`, `${Y}-09`]);
    expect((await service.listAssets({ limit: 50, offset: 0 })).rows[0]!.accumulatedDepreciation).toBe(OPENING + first.total + second.total);
  });

  it("never books an asset fully depreciated by its opening amount, while others still run", async () => {
    const { user, category } = await setupFixedAssets();
    const done = await createAsset(user.id, category.id, { openingDepreciation: 120000 });
    expect(done.bookValue).toBe(0);
    expect(done.plannedMonths).toEqual([]);
    await expect(service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id)).rejects.toBeInstanceOf(NothingToDepreciateError);
    expect(await storedRowCount()).toBe(0);

    await createAsset(user.id, category.id, {
      name: "Ny fräs",
      acquisitionDate: `${Y}-02-14`,
      depreciationStartMonth: `${Y}-02`,
      openingDepreciation: 0,
      openingDepreciationThroughMonth: null,
    });
    const result = await service.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    expect(result.rows.map((row) => row.assetNumber)).toEqual(["AN-2", "AN-2", "AN-2", "AN-2", "AN-2"]);
    expect((await service.getAsset(done.id)).accumulatedDepreciation).toBe(120000);
  });
});
