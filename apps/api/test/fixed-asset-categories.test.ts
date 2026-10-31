import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db, fixedAssetCategories } from "@navet/db";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { AccountNotFoundError, InactiveAccountError } from "../src/modules/economy/service/economy.service.js";
import {
  DuplicateFixedAssetCategoryNameError,
  FixedAssetBasAccountMissingError,
  FixedAssetCategoryAccountsLockedError,
  FixedAssetCategoryAccountsNotDistinctError,
  FixedAssetCategoryAccountRoleConflictError,
  FixedAssetCategoryInUseError,
  FixedAssetCategoryNotFoundError,
} from "../src/modules/economy/service/fixed-asset.service.js";
import { createFixedAssetService } from "../src/modules/economy/service/fixed-asset.service.js";
import { testDocumentPdfService, testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { PLAN_YEAR, accountId, resetFixedAssets, setupFixedAssets, testFixedAssetService, testPoster } from "./helpers/fixed-assets.js";

const service = testFixedAssetService;

beforeEach(resetFixedAssets);
afterAll(resetFixedAssets);

async function categoryInput(overrides: Partial<Parameters<typeof service.createCategory>[0]> = {}) {
  return {
    name: "Maskiner",
    assetAccountId: await accountId("1210"),
    accumulatedDepreciationAccountId: await accountId("1219"),
    depreciationExpenseAccountId: await accountId("7830"),
    disposalGainAccountId: await accountId("3973"),
    disposalLossAccountId: await accountId("7970"),
    defaultUsefulLifeMonths: 60,
    ...overrides,
  };
}

describe("anläggningsgrupper", () => {
  it("creates a category with its five accounts joined and lists it", async () => {
    await setupFixedAssets();
    const created = await service.createCategory(await categoryInput());
    expect(created.accounts.asset).toMatchObject({ number: "1210", active: true });
    expect(created.accounts.expense.number).toBe("7830");
    expect(created.assetCount).toBe(0);

    const list = await service.listCategories();
    expect(list.map((category) => category.name)).toEqual(["Inventarier", "Maskiner"]);
  });

  it("rejects a duplicate name, a missing account, an inactive account and non-distinct accounts", async () => {
    await setupFixedAssets();
    await expect(service.createCategory(await categoryInput({ name: "Inventarier" }))).rejects.toBeInstanceOf(
      DuplicateFixedAssetCategoryNameError
    );
    await expect(service.createCategory(await categoryInput({ assetAccountId: crypto.randomUUID() }))).rejects.toBeInstanceOf(
      AccountNotFoundError
    );
    const inactive = await testEconomyService.createAccount({ number: "1230", name: "Installationer" });
    await testEconomyService.updateAccount(inactive.id, { active: false });
    await expect(service.createCategory(await categoryInput({ assetAccountId: inactive.id }))).rejects.toBeInstanceOf(
      InactiveAccountError
    );
    await expect(
      service.createCategory(await categoryInput({ depreciationExpenseAccountId: await accountId("1210") }))
    ).rejects.toBeInstanceOf(FixedAssetCategoryAccountsNotDistinctError);
  });

  // The asset and ack accounts are reconciled per account, so neither may
  // have another role in any group; the same role in several groups is fine
  // (Maskiner above shares Inventarier's expense, gain and loss accounts).
  it("refuses an asset or ack account in another role, in another group or its own", async () => {
    await setupFixedAssets();
    const conflict = (accountNumber: string, role: string, categoryName: string, otherRole: string) =>
      expect.objectContaining({ name: "FixedAssetCategoryAccountRoleConflictError", accountNumber, role, categoryName, otherRole });

    // Inventarier: asset 1220, ack 1229.
    await expect(service.createCategory(await categoryInput({ depreciationExpenseAccountId: await accountId("1229") }))).rejects.toEqual(
      conflict("1229", "expense", "Inventarier", "accumulated")
    );
    await expect(service.createCategory(await categoryInput({ assetAccountId: await accountId("1229") }))).rejects.toEqual(
      conflict("1229", "asset", "Inventarier", "accumulated")
    );
    await expect(service.createCategory(await categoryInput({ accumulatedDepreciationAccountId: await accountId("1220") }))).rejects.toEqual(
      conflict("1220", "accumulated", "Inventarier", "asset")
    );
    // Its own asset account as its gain account.
    await expect(service.createCategory(await categoryInput({ disposalGainAccountId: await accountId("1210") }))).rejects.toEqual(
      conflict("1210", "gain", "Maskiner", "asset")
    );

    // An update that moves an account into a crossing role is refused too.
    const maskiner = await service.createCategory(await categoryInput());
    await expect(service.updateCategory(maskiner.id, { disposalLossAccountId: await accountId("1220") })).rejects.toBeInstanceOf(
      FixedAssetCategoryAccountRoleConflictError
    );
  });

  it("lets a name change through on a combination saved before the role check", async () => {
    await setupFixedAssets();
    const [legacy] = await db
      .insert(fixedAssetCategories)
      .values({ ...(await categoryInput({ name: "Gammal", depreciationExpenseAccountId: await accountId("1229") })) })
      .returning();
    const renamed = await service.updateCategory(legacy!.id, { name: "Gammal grupp" });
    expect(renamed.name).toBe("Gammal grupp");
  });

  it("updates, refuses to update a missing one, and deletes an unused one", async () => {
    await setupFixedAssets();
    const created = await service.createCategory(await categoryInput());
    const updated = await service.updateCategory(created.id, { defaultUsefulLifeMonths: 84, name: "Maskiner & verktyg" });
    expect(updated).toMatchObject({ defaultUsefulLifeMonths: 84, name: "Maskiner & verktyg" });
    await expect(service.updateCategory(crypto.randomUUID(), { name: "X" })).rejects.toBeInstanceOf(
      FixedAssetCategoryNotFoundError
    );
    await service.deleteCategory(created.id);
    expect((await service.listCategories()).map((category) => category.name)).toEqual(["Inventarier"]);
  });

  it("refuses to delete a category that has an asset", async () => {
    const { category, user } = await setupFixedAssets();
    await service.createAsset(
      { name: "Svarv", categoryId: category.id, acquisitionDate: `${new Date().getFullYear() - 1}-02-14`, acquisitionCost: 120000, residualValue: 0 },
      user.id
    );
    await expect(service.deleteCategory(category.id)).rejects.toBeInstanceOf(FixedAssetCategoryInUseError);
  });

  // Final review, item 3: the three posting accounts are what the group's
  // depreciation sits on in the ledger. Locked once any asset in the group
  // has live depreciation rows or an opening depreciation; gain/loss, name
  // and useful life stay editable; re-sending the same id is not a change.
  it("locks the asset, ack and expense accounts once the group has booked or opening depreciation", async () => {
    const { user, category } = await setupFixedAssets();
    const flag = async (id: string) => (await service.listCategories()).find((row) => row.id === id)!.postingAccountsLocked;
    expect(await flag(category.id)).toBe(false);
    await service.createAsset(
      { name: "Svarv", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-02-14`, acquisitionCost: 120000 },
      user.id
    );
    // An asset without rows does not lock anything.
    expect(await flag(category.id)).toBe(false);
    const run = await service.bookDepreciation({ throughMonth: `${PLAN_YEAR}-03` }, user.id);
    expect(await flag(category.id)).toBe(true);

    for (const patch of [
      { assetAccountId: await accountId("1210") },
      { accumulatedDepreciationAccountId: await accountId("1219") },
      { depreciationExpenseAccountId: await accountId("7820") },
    ]) {
      await expect(service.updateCategory(category.id, patch)).rejects.toBeInstanceOf(FixedAssetCategoryAccountsLockedError);
    }
    const gain = await testEconomyService.createAccount({ number: "3972", name: "Vinst vid avyttring av immateriella anläggningstillgångar" });
    const updated = await service.updateCategory(category.id, {
      name: "Inventarier & verktyg",
      defaultUsefulLifeMonths: 84,
      assetAccountId: category.assetAccountId,
      accumulatedDepreciationAccountId: category.accumulatedDepreciationAccountId,
      depreciationExpenseAccountId: category.depreciationExpenseAccountId,
      disposalGainAccountId: gain.id,
      disposalLossAccountId: await accountId("7830"),
    });
    expect(updated).toMatchObject({ name: "Inventarier & verktyg", defaultUsefulLifeMonths: 84, postingAccountsLocked: true });
    expect(updated.accounts.gain.number).toBe("3972");
    expect(updated.accounts.loss.number).toBe("7830");

    // Only LIVE rows count: once the only run is undone the lock lifts.
    await service.undoRun(run.run.id, user.id);
    expect(await flag(category.id)).toBe(false);
    expect((await service.updateCategory(category.id, { depreciationExpenseAccountId: await accountId("7820") })).accounts.expense.number).toBe("7820");

    // An opening depreciation locks on its own — it is already on the accounts.
    const maskiner = await service.createCategory(await categoryInput());
    await service.createAsset(
      {
        name: "Gammal fräs",
        categoryId: maskiner.id,
        acquisitionDate: `${PLAN_YEAR - 2}-03-15`,
        acquisitionCost: 120000,
        openingDepreciation: 44000,
        openingDepreciationThroughMonth: `${PLAN_YEAR - 1}-12`,
      },
      user.id
    );
    expect(await flag(maskiner.id)).toBe(true);
    await expect(service.updateCategory(maskiner.id, { assetAccountId: await accountId("1220") })).rejects.toBeInstanceOf(
      FixedAssetCategoryAccountsLockedError
    );
  });

  it("seeds the five BAS categories idempotently and reports a missing account", async () => {
    await setupFixedAssets();
    const first = await service.seedBasCategories();
    expect(first.created).toEqual([
      "Maskiner och andra tekniska anläggningar",
      "Inventarier och verktyg",
      "Bilar och andra transportmedel",
      "Datorer",
      "Byggnader",
    ]);
    expect(first.skipped).toEqual([]);
    const second = await service.seedBasCategories();
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(5);

    const datorer = (await service.listCategories()).find((category) => category.name === "Datorer")!;
    expect(datorer.accounts.asset.number).toBe("1250");
    expect(datorer.accounts.accumulated.number).toBe("1259");
    expect(datorer.defaultUsefulLifeMonths).toBe(36);
    const byggnader = (await service.listCategories()).find((category) => category.name === "Byggnader")!;
    expect(byggnader.accounts.expense.number).toBe("7820");
    expect(byggnader.defaultUsefulLifeMonths).toBe(600);
  });

  it("survives a double click: two concurrent seeds both succeed, one creates and one skips, and the created groups are logged", async () => {
    await setupFixedAssets();
    const logged: string[] = [];
    const audited = createFixedAssetService({
      db,
      poster: testPoster,
      audit: { log: async (entry) => void logged.push(`${entry.action}:${entry.entityId}`) },
      pdf: testDocumentPdfService,
    });
    const results = await Promise.allSettled([audited.seedBasCategories(), audited.seedBasCategories()]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const values = results.map((r) => (r as PromiseFulfilledResult<{ created: string[]; skipped: string[] }>).value);
    expect(values.map((v) => v.created.length).sort()).toEqual([0, 5]);
    expect(values.map((v) => v.skipped.length).sort()).toEqual([0, 5]);
    expect((await service.listCategories()).filter((category) => category.name === "Datorer")).toHaveLength(1);
    expect(logged.sort()).toEqual(
      ["Bilar och andra transportmedel", "Byggnader", "Datorer", "Inventarier och verktyg", "Maskiner och andra tekniska anläggningar"].map(
        (name) => `created:${name}`
      )
    );
  });

  it("creates nothing when a BAS account is missing", async () => {
    await setupFixedAssets();
    const bilar = await testEconomyRepository.findAccountByNumber("1240");
    await testEconomyService.updateAccount(bilar!.id, { active: false });
    await expect(service.seedBasCategories()).rejects.toBeInstanceOf(FixedAssetBasAccountMissingError);
    expect((await service.listCategories()).map((category) => category.name)).toEqual(["Inventarier"]);
    // Sanity: the BAS list the seed reads from still carries every account.
    expect(BAS_STANDARD_ACCOUNTS.some((account) => account.number === "1240")).toBe(true);
  });
});
