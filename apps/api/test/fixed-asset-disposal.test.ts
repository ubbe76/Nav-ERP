import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@navet/db";
import { round2 } from "@navet/shared";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { readAccountBalances } from "../src/modules/economy/service/account-balances.js";
import { missingMonths } from "../src/modules/economy/service/depreciation-schedule.js";
import {
  DepreciationRunNotLatestError,
  DisposalRunNotUndoableError,
  FixedAssetNotActiveError,
  InvalidDisposalDateError,
  NothingToDepreciateError,
} from "../src/modules/economy/service/fixed-asset.service.js";
import { readVatAccountMovements } from "../src/modules/economy/service/vat-account-movements.js";
import { createVatReportService } from "../src/modules/economy/service/vat-report.service.js";
import { DEFAULT_POSTING_SETTINGS, testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { PLAN_YEAR, accountId, resetFixedAssets, setupFixedAssets, testFixedAssetService, testPoster } from "./helpers/fixed-assets.js";

const service = testFixedAssetService;
const Y = PLAN_YEAR;
const vatReport = createVatReportService({ db, poster: testPoster, settings: { read: async () => DEFAULT_POSTING_SETTINGS } });

beforeEach(resetFixedAssets);
afterAll(resetFixedAssets);

// 120 000 over 60 months divides evenly, so the plan rule gives exactly
// 2 000/month here and the literals below are the rule's own output.
async function setupDepreciated() {
  const base = await setupFixedAssets();
  const asset = await service.createAsset(
    { name: "CNC-fräs", categoryId: base.category.id, acquisitionDate: `${Y}-02-14`, acquisitionCost: 120000, usefulLifeMonths: 60 },
    base.user.id
  );
  const run = await service.bookDepreciation({ throughMonth: `${Y}-06` }, base.user.id);
  return { ...base, asset, run };
}

async function rowsOf(verificationId: string) {
  const verification = await testEconomyService.findVerificationById(verificationId);
  return {
    displayNumber: verification.displayNumber,
    date: verification.date,
    description: verification.description,
    rows: verification.rows.map((row) => ({ account: row.accountNumber, debit: Number(row.debit), credit: Number(row.credit) })),
  };
}

const sale = (price: number, intermediateAccountId: string) =>
  ({ disposalType: "sale", disposalDate: `${Y}-09-18`, disposalPrice: price, intermediateAccountId }) as const;

describe("avyttring", () => {
  it("sells at a loss: catch-up run through the disposal month, then the disposal verification of spec section 6", async () => {
    const { user, asset } = await setupDepreciated();
    const result = await service.disposeAsset(asset.id, sale(95000, await accountId("3973")), user.id);

    const catchUp = await rowsOf(result.depreciationRun!.id);
    expect(catchUp.displayNumber).toBe(`AV-${Y}-2`);
    expect(catchUp.date).toBe(`${Y}-09-18`);
    expect(catchUp.description).toBe(`Avskrivning AN-1 t.o.m. ${Y}-09 (avyttring)`);
    expect(catchUp.rows).toEqual([
      { account: "7830", debit: 6000, credit: 0 },
      { account: "1229", debit: 0, credit: 6000 },
    ]);

    const disposal = await rowsOf(result.disposalVerification.id);
    expect(disposal.displayNumber).toBe(`AV-${Y}-3`);
    expect(disposal.date).toBe(`${Y}-09-18`);
    expect(disposal.description).toBe("Avyttring AN-1 CNC-fräs");
    expect(disposal.rows).toEqual([
      { account: "1220", debit: 0, credit: 120000 },
      { account: "1229", debit: 16000, credit: 0 },
      { account: "3973", debit: 95000, credit: 0 },
      { account: "7970", debit: 9000, credit: 0 },
    ]);

    expect(result.asset).toMatchObject({
      status: "disposed",
      disposalType: "sale",
      disposalDate: `${Y}-09-18`,
      disposalPrice: "95000.00",
      accumulatedDepreciation: 16000,
      bookValue: 104000,
      plannedMonths: [],
    });
    expect(result.asset.disposalVerification?.displayNumber).toBe(`AV-${Y}-3`);
  });

  it("sells at a gain with the gain account as mellankonto: one merged debit of the book value", async () => {
    const { user, asset } = await setupDepreciated();
    const result = await service.disposeAsset(asset.id, sale(110000, await accountId("3973")), user.id);
    expect((await rowsOf(result.disposalVerification.id)).rows).toEqual([
      { account: "1220", debit: 0, credit: 120000 },
      { account: "1229", debit: 16000, credit: 0 },
      { account: "3973", debit: 104000, credit: 0 },
    ]);
  });

  it("scraps without a price: the book value is the loss", async () => {
    const { user, asset } = await setupDepreciated();
    const result = await service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: `${Y}-09-18` }, user.id);
    expect((await rowsOf(result.disposalVerification.id)).description).toBe("Utrangering AN-1 CNC-fräs");
    expect((await rowsOf(result.disposalVerification.id)).rows).toEqual([
      { account: "1220", debit: 0, credit: 120000 },
      { account: "1229", debit: 16000, credit: 0 },
      { account: "7970", debit: 104000, credit: 0 },
    ]);
    expect(result.asset.disposalPrice).toBeNull();
  });

  it("books no catch-up when the months are already depreciated further, and never reverses the extra month", async () => {
    const { user, asset } = await setupDepreciated();
    const result = await service.disposeAsset(
      asset.id,
      { disposalType: "sale", disposalDate: `${Y}-05-20`, disposalPrice: 100000, intermediateAccountId: await accountId("3973") },
      user.id
    );
    expect(result.depreciationRun).toBeNull();
    // Feb–Jun stays booked: 10 000 accumulated, book value 110 000, loss 10 000.
    expect((await rowsOf(result.disposalVerification.id)).rows).toEqual([
      { account: "1220", debit: 0, credit: 120000 },
      { account: "1229", debit: 10000, credit: 0 },
      { account: "3973", debit: 100000, credit: 0 },
      { account: "7970", debit: 10000, credit: 0 },
    ]);
  });

  // Task 4b: the opening amount (ingående avskrivning) is accumulated
  // depreciation too. Summing live rows alone would leave it on the ack
  // account forever after the disposal.
  it("includes the opening depreciation in the ack debit and the gain/loss of a pre-Nav asset", async () => {
    const { user, category } = await setupFixedAssets();
    const plan = { acquisitionCost: 120000, residualValue: 0, usefulLifeMonths: 60, depreciationStartMonth: `${Y - 2}-03` };
    const opening = { month: `${Y - 1}-12`, amount: 45000 };
    const asset = await service.createAsset(
      {
        name: "Gammal svarv",
        categoryId: category.id,
        acquisitionDate: `${Y - 2}-03-15`,
        ...plan,
        openingDepreciation: opening.amount,
        openingDepreciationThroughMonth: opening.month,
      },
      user.id
    );
    // The plan rule from the opening entry: 75 000 over the 38 remaining
    // months — not a round amount, so this really exercises the rule.
    const catchUpMonths = missingMonths({ ...plan, bookedMonths: [opening] }, `${Y}-03`);
    expect(catchUpMonths.map((row) => row.month)).toEqual([`${Y}-01`, `${Y}-02`, `${Y}-03`]);
    const catchUp = round2(catchUpMonths.reduce((sum, row) => sum + row.amount, 0));
    const accumulated = round2(opening.amount + catchUp);
    const bookValue = round2(120000 - accumulated);

    const preview = await service.disposalPreview(asset.id, { disposalType: "scrap", disposalDate: `${Y}-03-18` });
    expect(preview.catchUpMonths).toEqual(catchUpMonths);
    expect(preview).toMatchObject({ accumulatedDepreciation: accumulated, bookValue, gain: 0, loss: bookValue });

    const result = await service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: `${Y}-03-18` }, user.id);
    expect((await rowsOf(result.depreciationRun!.id)).rows).toEqual([
      { account: "7830", debit: catchUp, credit: 0 },
      { account: "1229", debit: 0, credit: catchUp },
    ]);
    expect((await rowsOf(result.disposalVerification.id)).rows).toEqual([
      { account: "1220", debit: 0, credit: 120000 },
      { account: "1229", debit: accumulated, credit: 0 },
      { account: "7970", debit: bookValue, credit: 0 },
    ]);
    expect(result.asset).toMatchObject({ status: "disposed", accumulatedDepreciation: accumulated, bookValue });
  });

  it("is final: later runs skip it, edits and a second disposal are refused, and no run before it can be undone", async () => {
    const { user, asset, run } = await setupDepreciated();
    await service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: `${Y}-09-18` }, user.id);
    await expect(service.bookDepreciation({ throughMonth: `${Y}-12` }, user.id)).rejects.toBeInstanceOf(NothingToDepreciateError);
    await expect(service.updateAsset(asset.id, { name: "X" }, user.id)).rejects.toBeInstanceOf(FixedAssetNotActiveError);
    expect((await service.updateAsset(asset.id, { note: "Skrotad" }, user.id)).note).toBe("Skrotad");
    await expect(service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: `${Y}-09-18` }, user.id)).rejects.toBeInstanceOf(
      FixedAssetNotActiveError
    );
    const runs = await service.listRuns({ limit: 50, offset: 0 });
    expect(runs.rows[0]).toMatchObject({ disposalAssetNumber: "AN-1", undoable: false });
    await expect(service.undoRun(runs.rows[0]!.id, user.id)).rejects.toBeInstanceOf(DisposalRunNotUndoableError);
    await expect(service.undoRun(run.run.id, user.id)).rejects.toBeInstanceOf(DepreciationRunNotLatestError);
  });

  it("rejects a date before the acquisition or in the future, and a locked period leaves no trace", async () => {
    const { user, asset, planYearId } = await setupDepreciated();
    await expect(service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: `${Y}-01-01` }, user.id)).rejects.toBeInstanceOf(
      InvalidDisposalDateError
    );
    await expect(
      service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: `${new Date().getFullYear() + 1}-01-01` }, user.id)
    ).rejects.toBeInstanceOf(InvalidDisposalDateError);
    const year = await testEconomyService.findFiscalYearById(planYearId);
    await testEconomyService.lockPeriod(year.periods.find((p) => p.startDate === `${Y}-09-01`)!.id, user.id);
    await expect(service.disposeAsset(asset.id, { disposalType: "scrap", disposalDate: `${Y}-09-18` }, user.id)).rejects.toBeInstanceOf(
      AccountingPeriodLockedError
    );
    expect((await service.getAsset(asset.id)).status).toBe("active");
    expect((await service.listRuns({ limit: 50, offset: 0 })).total).toBe(1);
  });

  it("previews the exact rows and warns when the mellankonto lacks momsruta 05", async () => {
    const { asset } = await setupDepreciated();
    const gain = await testEconomyRepository.findAccountByNumber("3973");
    const preview = await service.disposalPreview(asset.id, sale(95000, gain!.id));
    expect(preview.catchUpMonths.map((row) => row.month)).toEqual([`${Y}-07`, `${Y}-08`, `${Y}-09`]);
    expect(preview).toMatchObject({ accumulatedDepreciation: 16000, bookValue: 104000, gain: 0, loss: 9000 });
    expect(preview.rows).toEqual([
      { accountNumber: "1220", accountName: "Inventarier och verktyg", debit: 0, credit: 120000 },
      { accountNumber: "1229", accountName: "Ack avskrivningar inventarier", debit: 16000, credit: 0 },
      { accountNumber: "3973", accountName: "Vinst vid avyttring av maskiner och inventarier", debit: 95000, credit: 0 },
      { accountNumber: "7970", accountName: "Förlust vid avyttring av anläggningstillgångar", debit: 9000, credit: 0 },
    ]);
    expect(preview.warnings).toEqual(["intermediate-account-not-box-05"]);

    await testEconomyService.updateAccount(gain!.id, { vatBox: "05" });
    expect((await service.disposalPreview(asset.id, sale(95000, gain!.id))).warnings).toEqual([]);
    expect((await service.disposalPreview(asset.id, { disposalType: "scrap", disposalDate: `${Y}-09-18` })).warnings).toEqual([]);
    expect((await service.getAsset(asset.id)).status).toBe("active");
  });

  // Spec 3.6a: the VAT report excludes the disposal verification by identity.
  it("keeps the sale in ruta 05 of the VAT report while the P&L still sees the disposal", async () => {
    const { user, asset } = await setupDepreciated();
    const gain = await testEconomyRepository.findAccountByNumber("3973");
    await testEconomyService.updateAccount(gain!.id, { vatBox: "05" });
    await service.disposeAsset(asset.id, sale(95000, gain!.id), user.id);

    // The customer invoice, booked the ordinary way (here: a manual A verification).
    await testEconomyService.createSeries({ code: "A", name: "Manuella verifikat" });
    const series = await testEconomyRepository.findSeriesByCode("A");
    const draft = await testEconomyService.createVerification(
      {
        seriesId: series!.id,
        date: `${Y}-09-20`,
        description: "Faktura CNC-fräs",
        rows: [
          { accountId: await accountId("1510"), debit: 118750, credit: 0 },
          { accountId: gain!.id, debit: 0, credit: 95000 },
          { accountId: await accountId("2610"), debit: 0, credit: 23750 },
        ],
      },
      user.id
    );
    await testEconomyService.book(draft.id, user.id);

    const report = await vatReport.getReport({ from: `${Y}-09-01`, to: `${Y}-09-30` });
    expect(report.boxes.sales05).toBe(95000);
    expect(report.boxes.vatOut25_10).toBe(23750);
    expect(report.boxes.vatToPay49).toBe(23750);

    const movements = await readVatAccountMovements(db, `${Y}-09-01`, `${Y}-09-30`);
    expect(movements.find((row) => row.accountNumber === "3973")).toMatchObject({ debit: 0, credit: 95000 });
    // 1220 and 7970 only ever appear on the (excluded) disposal verification.
    // 1229 is NOT asserted absent: the catch-up run (AV-Y-2, 7830/1229) is
    // dated in September and is deliberately visible to the report.
    expect(movements.some((row) => ["1220", "7970"].includes(row.accountNumber))).toBe(false);

    // readAccountBalances has NO exclusion: the P&L sees both sides of 3973.
    const balances = await readAccountBalances(db, { from: null, to: `${Y}-09-30` });
    expect(balances.find((row) => row.accountNumber === "3973")).toMatchObject({ periodDebit: 95000, periodCredit: 95000 });
    expect(balances.find((row) => row.accountNumber === "7970")).toMatchObject({ periodDebit: 9000 });
  });
});
