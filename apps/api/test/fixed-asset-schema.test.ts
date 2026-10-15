import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, fixedAssetCategories, fixedAssets, numberSeries } from "@navet/db";
import { eq } from "drizzle-orm";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { testEconomyRepository } from "./helpers/services.js";

const TRUNCATE = sql`TRUNCATE fixed_asset_depreciations, fixed_asset_depreciation_runs, fixed_assets, fixed_asset_categories, accounts CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await testEconomyRepository.seedAccounts([...BAS_STANDARD_ACCOUNTS]);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

// drizzle wraps the driver error; the violated constraint is on `cause`.
// Several names = any of them (Postgres reports the alphabetically first
// failing CHECK when a row violates more than one).
async function expectConstraint(promise: PromiseLike<unknown>, constraint: string | string[]) {
  const accepted = Array.isArray(constraint) ? constraint : [constraint];
  const error = await Promise.resolve(promise).then(
    () => null,
    (caught: unknown) => caught as { cause?: { constraint_name?: string } }
  );
  expect(error, `expected ${accepted.join(" or ")} to be violated`).not.toBeNull();
  expect(accepted).toContain(error!.cause?.constraint_name);
}

async function accountId(number: string) {
  return (await testEconomyRepository.findAccountByNumber(number))!.id;
}

async function insertCategory() {
  const [row] = await db
    .insert(fixedAssetCategories)
    .values({
      name: "Inventarier",
      assetAccountId: await accountId("1220"),
      accumulatedDepreciationAccountId: await accountId("1229"),
      depreciationExpenseAccountId: await accountId("7830"),
      disposalGainAccountId: await accountId("3973"),
      disposalLossAccountId: await accountId("7970"),
      defaultUsefulLifeMonths: 60,
    })
    .returning();
  return row!;
}

describe("migration 0103", () => {
  it("seeds the fixed_asset number series", async () => {
    const [row] = await db.select().from(numberSeries).where(eq(numberSeries.key, "fixed_asset"));
    expect(row).toMatchObject({ prefix: "AN-", digits: 0 });
  });

  it("refuses a category whose expense account equals its asset account", async () => {
    await expectConstraint(
      db.insert(fixedAssetCategories).values({
        name: "Fel",
        assetAccountId: await accountId("1220"),
        accumulatedDepreciationAccountId: await accountId("1229"),
        depreciationExpenseAccountId: await accountId("1220"),
        disposalGainAccountId: await accountId("3973"),
        disposalLossAccountId: await accountId("7970"),
        defaultUsefulLifeMonths: 60,
      }),
      "fixed_asset_category_accounts_distinct"
    );
  });

  it("refuses a disposed status without the disposal columns, and a residual above cost", async () => {
    const category = await insertCategory();
    const base = {
      assetNumber: "AN-1",
      name: "Svarv",
      categoryId: category.id,
      acquisitionDate: "2026-02-14",
      acquisitionCost: "120000.00",
      usefulLifeMonths: 60,
      depreciationStartMonth: "2026-02-01",
    };
    await expectConstraint(db.insert(fixedAssets).values({ ...base, status: "disposed" }), "fixed_asset_disposal_consistent");
    // A residual above cost also makes cost − residual negative, which the
    // 0104 opening-within-base CHECK (opening 0) refuses as well.
    await expectConstraint(db.insert(fixedAssets).values({ ...base, residualValue: "130000.00" }), [
      "fixed_asset_residual_range",
      "fixed_asset_opening_within_base",
    ]);
    await expectConstraint(db.insert(fixedAssets).values({ ...base, depreciationStartMonth: "2026-01-01" }), "fixed_asset_start_after_acquisition");
    const [ok] = await db.insert(fixedAssets).values(base).returning();
    expect(ok!.status).toBe("active");
  });
});

describe("migration 0104 (ingående avskrivning)", () => {
  it("ties the opening amount to its through-month and caps it at cost − residual", async () => {
    const category = await insertCategory();
    const base = {
      assetNumber: "AN-1",
      name: "Svarv",
      categoryId: category.id,
      acquisitionDate: "2020-02-14",
      acquisitionCost: "120000.00",
      residualValue: "20000.00",
      usefulLifeMonths: 120,
      depreciationStartMonth: "2020-02-01",
    };
    // Amount without month, month without amount.
    await expectConstraint(db.insert(fixedAssets).values({ ...base, openingDepreciation: "1000.00" }), "fixed_asset_opening_consistent");
    await expectConstraint(
      db.insert(fixedAssets).values({ ...base, openingDepreciationThroughMonth: "2025-12-01" }),
      "fixed_asset_opening_consistent"
    );
    // Negative (fails both the sign and the pairing CHECK).
    await expectConstraint(db.insert(fixedAssets).values({ ...base, openingDepreciation: "-1.00" }), [
      "fixed_asset_opening_consistent",
      "fixed_asset_opening_nonnegative",
    ]);
    // Not the first of a month.
    await expectConstraint(
      db.insert(fixedAssets).values({ ...base, openingDepreciation: "1000.00", openingDepreciationThroughMonth: "2025-12-31" }),
      "fixed_asset_opening_month_first_day"
    );
    // Above the depreciable base (120 000 − 20 000).
    await expectConstraint(
      db.insert(fixedAssets).values({ ...base, openingDepreciation: "100000.01", openingDepreciationThroughMonth: "2025-12-01" }),
      "fixed_asset_opening_within_base"
    );
    const [ok] = await db
      .insert(fixedAssets)
      .values({ ...base, openingDepreciation: "100000.00", openingDepreciationThroughMonth: "2025-12-01" })
      .returning();
    expect(ok).toMatchObject({ openingDepreciation: "100000.00", openingDepreciationThroughMonth: "2025-12-01" });
    const [plain] = await db.insert(fixedAssets).values({ ...base, assetNumber: "AN-2" }).returning();
    expect(plain).toMatchObject({ openingDepreciation: "0.00", openingDepreciationThroughMonth: null });
  });
});
