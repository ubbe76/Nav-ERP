import { describe, expect, it } from "vitest";
import {
  FIXED_ASSET_DISPOSAL_TYPE_LABELS,
  FIXED_ASSET_STATUS_LABELS,
  createFixedAssetSchema,
  disposeFixedAssetSchema,
  monthKeySchema,
  updateFixedAssetSchema,
} from "@navet/shared";
import * as web from "../../web/lib/fixedAssets.js";

describe("fixed-asset zod schemas", () => {
  it("accepts YYYY-MM and rejects dates, day-months and month 13", () => {
    expect(monthKeySchema.safeParse("2026-02").success).toBe(true);
    expect(monthKeySchema.safeParse("2026-02-01").success).toBe(false);
    expect(monthKeySchema.safeParse("2026-13").success).toBe(false);
    expect(monthKeySchema.safeParse("2026-2").success).toBe(false);
  });

  it("rejects a residual above cost and a start before the acquisition month", () => {
    const base = { name: "Svarv", categoryId: crypto.randomUUID(), acquisitionDate: "2026-02-14", acquisitionCost: "120000" };
    expect(createFixedAssetSchema.safeParse({ ...base, residualValue: "130000" }).success).toBe(false);
    expect(createFixedAssetSchema.safeParse({ ...base, depreciationStartMonth: "2026-01" }).success).toBe(false);
    const parsed = createFixedAssetSchema.parse({ ...base, depreciationStartMonth: "2026-03" });
    expect(parsed.acquisitionCost).toBe(120000);
    expect(parsed.residualValue).toBe(0);
    expect(parsed.usefulLifeMonths).toBeUndefined();
  });

  it("lets a PATCH carry only one field", () => {
    expect(updateFixedAssetSchema.parse({ usefulLifeMonths: "48" })).toEqual({ usefulLifeMonths: 48 });
    expect(updateFixedAssetSchema.safeParse({}).success).toBe(false);
  });

  it("takes the opening depreciation and its through-month together, or neither", () => {
    const base = { name: "Svarv", categoryId: crypto.randomUUID(), acquisitionDate: "2020-02-14", acquisitionCost: "120000" };
    const parsed = createFixedAssetSchema.parse(base);
    expect(parsed.openingDepreciation).toBe(0);
    expect(parsed.openingDepreciationThroughMonth ?? null).toBeNull();
    expect(
      createFixedAssetSchema.parse({ ...base, openingDepreciation: "44000.50", openingDepreciationThroughMonth: "2025-12" })
    ).toMatchObject({ openingDepreciation: 44000.5, openingDepreciationThroughMonth: "2025-12" });
    // One without the other, a negative amount and a third decimal are all refused.
    expect(createFixedAssetSchema.safeParse({ ...base, openingDepreciation: "44000" }).success).toBe(false);
    expect(createFixedAssetSchema.safeParse({ ...base, openingDepreciationThroughMonth: "2025-12" }).success).toBe(false);
    expect(createFixedAssetSchema.safeParse({ ...base, openingDepreciation: "0", openingDepreciationThroughMonth: "2025-12" }).success).toBe(false);
    expect(createFixedAssetSchema.safeParse({ ...base, openingDepreciation: "-1" }).success).toBe(false);
    expect(
      createFixedAssetSchema.safeParse({ ...base, openingDepreciation: "44000.005", openingDepreciationThroughMonth: "2025-12" }).success
    ).toBe(false);

    // A PATCH may carry one of the two (the service merges with the stored
    // row) but when both are present they must agree.
    expect(updateFixedAssetSchema.parse({ openingDepreciation: "0", openingDepreciationThroughMonth: null })).toEqual({
      openingDepreciation: 0,
      openingDepreciationThroughMonth: null,
    });
    expect(updateFixedAssetSchema.safeParse({ openingDepreciation: "1000", openingDepreciationThroughMonth: null }).success).toBe(false);
    expect(updateFixedAssetSchema.safeParse({ openingDepreciation: "0", openingDepreciationThroughMonth: "2025-12" }).success).toBe(false);
    expect(updateFixedAssetSchema.parse({ openingDepreciationThroughMonth: "2025-11" })).toEqual({ openingDepreciationThroughMonth: "2025-11" });
  });

  it("requires price + mellankonto for a sale and refuses them for a scrap", () => {
    expect(
      disposeFixedAssetSchema.safeParse({ disposalType: "sale", disposalDate: "2026-09-18", disposalPrice: "95000" }).success
    ).toBe(false);
    expect(
      disposeFixedAssetSchema.parse({
        disposalType: "sale",
        disposalDate: "2026-09-18",
        disposalPrice: "95000",
        intermediateAccountId: "4b5a5b1e-7e2e-4c2e-9c3a-2a1c3b4d5e6f",
      })
    ).toMatchObject({ disposalPrice: 95000 });
    expect(disposeFixedAssetSchema.safeParse({ disposalType: "scrap", disposalDate: "2026-09-18", disposalPrice: "1" }).success).toBe(
      false
    );
    expect(disposeFixedAssetSchema.parse({ disposalType: "scrap", disposalDate: "2026-09-18" })).toEqual({
      disposalType: "scrap",
      disposalDate: "2026-09-18",
    });
  });
});

describe("fixed-asset labels — web mirror", () => {
  it("is identical to @navet/shared", () => {
    expect(web.FIXED_ASSET_STATUS_LABELS).toEqual(FIXED_ASSET_STATUS_LABELS);
    expect(web.FIXED_ASSET_DISPOSAL_TYPE_LABELS).toEqual(FIXED_ASSET_DISPOSAL_TYPE_LABELS);
  });

  // Browser-check item: the default view is Aktiva — no parameter must
  // become status=active, "all" must drop the filter.
  it("maps the register list's status parameter to the API filter", () => {
    expect(web.fixedAssetListStatus(undefined)).toBe("active");
    expect(web.fixedAssetListStatus("all")).toBe("");
    expect(web.fixedAssetListStatus("disposed")).toBe("disposed");
    expect(web.fixedAssetListStatus("active")).toBe("active");
    expect(web.fixedAssetListStatus(["disposed", "active"])).toBe("disposed");
  });

  it("labels months in Swedish", () => {
    expect(web.monthLabel("2026-06")).toBe("Juni 2026");
    expect(web.monthLabel("2026-01")).toBe("Januari 2026");
  });
});
