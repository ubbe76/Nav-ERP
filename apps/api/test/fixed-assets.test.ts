import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  FixedAssetCategoryNotFoundError,
  FixedAssetFieldLockedError,
  FixedAssetHasDepreciationError,
  FixedAssetLifeTooShortError,
  FixedAssetNotFoundError,
  InvalidFixedAssetValuesError,
  SupplierInvoiceNotFoundError,
} from "../src/modules/economy/service/fixed-asset.service.js";
import {
  PLAN_YEAR,
  resetFixedAssets,
  setupFixedAssets,
  testFixedAssetService,
} from "./helpers/fixed-assets.js";

const service = testFixedAssetService;

beforeEach(resetFixedAssets);
afterAll(resetFixedAssets);

describe("anläggningar", () => {
  it("numbers assets AN-1, AN-2 and defaults start month and useful life", async () => {
    const { category, user } = await setupFixedAssets();
    const first = await service.createAsset(
      {
        name: "CNC-fräs",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-02-14`,
        acquisitionCost: 120000,
        residualValue: 0,
      },
      user.id,
    );
    expect(first.assetNumber).toBe("AN-1");
    expect(first.depreciationStartMonth).toBe(`${PLAN_YEAR}-02-01`);
    expect(first.usefulLifeMonths).toBe(60);
    expect(first.status).toBe("active");
    expect(first.accumulatedDepreciation).toBe(0);
    expect(first.bookValue).toBe(120000);
    expect(first.plannedMonths).toHaveLength(60);
    expect(first.plannedMonths[0]).toEqual({
      month: `${PLAN_YEAR}-02`,
      amount: 2000,
    });
    expect(first.category.name).toBe("Inventarier");

    const second = await service.createAsset(
      {
        name: "Server",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-03-31`,
        acquisitionCost: 36000,
        residualValue: 0,
        usefulLifeMonths: 36,
        depreciationStartMonth: `${PLAN_YEAR}-04`,
        note: "Serienr 123",
      },
      user.id,
    );
    expect(second.assetNumber).toBe("AN-2");
    expect(second.depreciationStartMonth).toBe(`${PLAN_YEAR}-04-01`);
    expect(second.usefulLifeMonths).toBe(36);
    expect(second.note).toBe("Serienr 123");
  });

  it("rejects an unknown category and an unknown supplier invoice", async () => {
    const { category, user } = await setupFixedAssets();
    const base = {
      name: "X",
      acquisitionDate: `${PLAN_YEAR}-02-14`,
      acquisitionCost: 1000,
      residualValue: 0,
    };
    await expect(
      service.createAsset(
        { ...base, categoryId: crypto.randomUUID() },
        user.id,
      ),
    ).rejects.toBeInstanceOf(FixedAssetCategoryNotFoundError);
    await expect(
      service.createAsset(
        {
          ...base,
          categoryId: category.id,
          supplierInvoiceId: crypto.randomUUID(),
        },
        user.id,
      ),
    ).rejects.toBeInstanceOf(SupplierInvoiceNotFoundError);
  });

  it("lists with search, status and category filters and derived book values", async () => {
    const { category, user } = await setupFixedAssets();
    await service.createAsset(
      {
        name: "CNC-fräs",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-02-14`,
        acquisitionCost: 120000,
      },
      user.id,
    );
    await service.createAsset(
      {
        name: "Server",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-03-01`,
        acquisitionCost: 36000,
      },
      user.id,
    );
    const all = await service.listAssets({ limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.rows.map((row) => row.assetNumber)).toEqual(["AN-1", "AN-2"]);
    expect(all.rows[0]).toMatchObject({
      categoryName: "Inventarier",
      accumulatedDepreciation: 0,
      bookValue: 120000,
    });
    expect(
      (
        await service.listAssets({ search: "serv", limit: 50, offset: 0 })
      ).rows.map((row) => row.name),
    ).toEqual(["Server"]);
    expect(
      (await service.listAssets({ search: "AN-1", limit: 50, offset: 0 }))
        .total,
    ).toBe(1);
    expect(
      (await service.listAssets({ status: "disposed", limit: 50, offset: 0 }))
        .total,
    ).toBe(0);
    expect(
      (
        await service.listAssets({
          categoryId: crypto.randomUUID(),
          limit: 50,
          offset: 0,
        })
      ).total,
    ).toBe(0);
  });

  it("updates every field before the first depreciation and validates the merged row", async () => {
    const { category, user } = await setupFixedAssets();
    const asset = await service.createAsset(
      {
        name: "CNC-fräs",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-02-14`,
        acquisitionCost: 120000,
      },
      user.id,
    );
    const updated = await service.updateAsset(
      asset.id,
      {
        name: "CNC-fräs 2",
        acquisitionCost: 130000,
        residualValue: 10000,
        usefulLifeMonths: 48,
        depreciationStartMonth: `${PLAN_YEAR}-03`,
        acquisitionDate: `${PLAN_YEAR}-02-20`,
      },
      user.id,
    );
    expect(updated).toMatchObject({
      name: "CNC-fräs 2",
      acquisitionCost: "130000.00",
      residualValue: "10000.00",
      usefulLifeMonths: 48,
    });
    expect(updated.depreciationStartMonth).toBe(`${PLAN_YEAR}-03-01`);
    expect(updated.plannedMonths).toHaveLength(48);
    expect(updated.plannedMonths[0]!.amount).toBe(2500);

    await expect(
      service.updateAsset(asset.id, { residualValue: 200000 }, user.id),
    ).rejects.toBeInstanceOf(InvalidFixedAssetValuesError);
    await expect(
      service.updateAsset(
        asset.id,
        { depreciationStartMonth: `${PLAN_YEAR}-01` },
        user.id,
      ),
    ).rejects.toBeInstanceOf(InvalidFixedAssetValuesError);
    await expect(
      service.updateAsset(crypto.randomUUID(), { name: "X" }, user.id),
    ).rejects.toBeInstanceOf(FixedAssetNotFoundError);
  });

  it("deletes an asset that was never depreciated", async () => {
    const { category, user } = await setupFixedAssets();
    const asset = await service.createAsset(
      {
        name: "Fel",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-02-14`,
        acquisitionCost: 1,
      },
      user.id,
    );
    await service.deleteAsset(asset.id, user.id);
    await expect(service.getAsset(asset.id)).rejects.toBeInstanceOf(
      FixedAssetNotFoundError,
    );
    // The number is never reused.
    const next = await service.createAsset(
      {
        name: "Nästa",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-02-14`,
        acquisitionCost: 1,
      },
      user.id,
    );
    expect(next.assetNumber).toBe("AN-2");
  });

  it("locks identity fields once a depreciation is booked, keeps the rest editable and blocks delete", async () => {
    const { category, user } = await setupFixedAssets();
    const asset = await service.createAsset(
      {
        name: "CNC-fräs",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-01-10`,
        acquisitionCost: 12000,
        usefulLifeMonths: 12,
      },
      user.id,
    );
    // 12 000 over 12 months: a real run through February books 2 × 1 000.
    await service.bookDepreciation({ throughMonth: `${PLAN_YEAR}-02` }, user.id);
    await expect(
      service.updateAsset(asset.id, { acquisitionCost: 13000 }, user.id),
    ).rejects.toBeInstanceOf(FixedAssetFieldLockedError);
    // Re-sending the stored value is not a change.
    await expect(
      service.updateAsset(
        asset.id,
        { acquisitionCost: 12000, name: "CNC 2" },
        user.id,
      ),
    ).resolves.toMatchObject({
      name: "CNC 2",
      accumulatedDepreciation: 2000,
      bookValue: 10000,
    });
    await expect(service.deleteAsset(asset.id, user.id)).rejects.toBeInstanceOf(
      FixedAssetHasDepreciationError,
    );
  });

  it("refuses a useful life that leaves nothing to depreciate the remaining base over", async () => {
    const { category, user } = await setupFixedAssets();
    const asset = await service.createAsset(
      {
        name: "CNC-fräs",
        categoryId: category.id,
        acquisitionDate: `${PLAN_YEAR}-01-10`,
        acquisitionCost: 12000,
        usefulLifeMonths: 12,
      },
      user.id,
    );
    await service.bookDepreciation({ throughMonth: `${PLAN_YEAR}-03` }, user.id);
    // Life 2 ends before the last booked month, life 3 exactly on it: in both
    // cases missingMonths would return [] forever while 9000 remains.
    for (const life of [2, 3]) {
      await expect(
        service.updateAsset(asset.id, { usefulLifeMonths: life }, user.id),
      ).rejects.toBeInstanceOf(FixedAssetLifeTooShortError);
    }
    const longer = await service.updateAsset(
      asset.id,
      { usefulLifeMonths: 4 },
      user.id,
    );
    expect(longer.plannedMonths).toHaveLength(1);
    expect(longer.plannedMonths[0]).toEqual({
      month: `${PLAN_YEAR}-04`,
      amount: 9000,
    });
    // A residual value that consumes the whole remaining base lifts the restriction.
    const settled = await service.updateAsset(
      asset.id,
      { residualValue: 9000, usefulLifeMonths: 2 },
      user.id,
    );
    expect(settled.plannedMonths).toEqual([]);
  });
});
