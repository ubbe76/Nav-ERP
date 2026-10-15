import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ClosingDateLockedError } from "../src/modules/economy/service/year-end-closing.service.js";
import { testFixedAssetService } from "./helpers/fixed-assets.js";
import { YEAR, accountId, buildYearEndService, resetYearEnd, setupYearEnd, verificationLines } from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const service = buildYearEndService();

async function assetThroughNovember(userId: string) {
  const category = await testFixedAssetService.createCategory({
    name: "Maskiner",
    assetAccountId: await accountId("1210"),
    accumulatedDepreciationAccountId: await accountId("1219"),
    depreciationExpenseAccountId: await accountId("7830"),
    disposalGainAccountId: await accountId("3973"),
    disposalLossAccountId: await accountId("7970"),
    defaultUsefulLifeMonths: 60,
  });
  await testFixedAssetService.createAsset({ name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${YEAR}-02-14`, acquisitionCost: 120000 }, userId);
  await testFixedAssetService.bookDepreciation({ throughMonth: `${YEAR}-11` }, userId);
}

describe("steg 3 — avskrivningar", () => {
  it("runs the register through the closing month, dated on the closing date, once", async () => {
    const { user, yearId } = await setupYearEnd();
    await assetThroughNovember(user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    expect((await service.getClosing(closing.id)).steps.depreciation).toMatchObject({ status: "missing", throughMonth: `${YEAR}-12`, missingAssets: 1 });

    // The amount comes from the register's own plan, never from a literal.
    const expected = (await testFixedAssetService.previewDepreciation({ throughMonth: `${YEAR}-12` })).total;
    const result = await service.bookDepreciation(closing.id, user.id);
    expect(result.unchanged).toBe(false);
    expect(result.run!.total).toBe(expected);
    expect(result.run!.rows.map((row) => row.month)).toEqual([`${YEAR}-12`]);
    const lines = await verificationLines(result.run!.verification.id);
    expect(lines).toEqual([
      { account: "1219", debit: 0, credit: expected },
      { account: "7830", debit: expected, credit: 0 },
    ]);
    expect((await service.getClosing(closing.id)).steps.depreciation.status).toBe("done");

    const again = await service.bookDepreciation(closing.id, user.id);
    expect(again).toEqual({ unchanged: true, run: null });
  });

  it("goes back to missing when the run is undone in the register", async () => {
    const { user, yearId } = await setupYearEnd();
    await assetThroughNovember(user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const result = await service.bookDepreciation(closing.id, user.id);
    await testFixedAssetService.undoRun(result.run!.run.id, user.id);
    expect((await service.getClosing(closing.id)).steps.depreciation.status).toBe("missing");
  });

  // Review Focus 1 (avskrivning).
  it("dates the run on a closing date before the year's last day and still takes December", async () => {
    const { user, yearId } = await setupYearEnd();
    await assetThroughNovember(user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId, closingDate: `${YEAR}-12-20` }, user.id);
    const result = await service.bookDepreciation(closing.id, user.id);
    expect(result.run!.rows.map((row) => row.month)).toEqual([`${YEAR}-12`]);
    const detail = await service.getClosing(closing.id);
    expect(detail.steps.depreciation.status).toBe("done");
    // The AV verification's date is the closing date.
    const runs = await testFixedAssetService.listRuns({ limit: 10, offset: 0 });
    expect(runs.rows.find((run) => run.id === result.run!.run.id)!.verification.date).toBe(`${YEAR}-12-20`);
  });

  // Steg 3 is a booked step too: its AV verification is dated on the closing
  // date, so the date locks once the run exists.
  it("locks the closing date once the step's depreciation run is booked", async () => {
    const { user, yearId } = await setupYearEnd();
    await assetThroughNovember(user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId, closingDate: `${YEAR}-12-20` }, user.id);
    await service.bookDepreciation(closing.id, user.id);
    await expect(service.updateClosingDate(closing.id, `${YEAR}-12-31`, user.id)).rejects.toBeInstanceOf(ClosingDateLockedError);
    expect((await service.getClosing(closing.id)).closingDate).toBe(`${YEAR}-12-20`);
  });

  it("is done with nothing to book when the company has no fixed assets", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    expect((await service.getClosing(closing.id)).steps.depreciation.status).toBe("done");
    expect(await service.bookDepreciation(closing.id, user.id)).toEqual({ unchanged: true, run: null });
  });
});
