import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildFixedAssetPlan, type PlanAssetInput, type PlanCategoryInput } from "../src/modules/economy/service/fixed-asset-plan.js";
import { buildFixedAssetPlanCsv } from "../src/modules/economy/service/fixed-asset-plan-csv.js";
import { FixedAssetPlanYearNotFoundError } from "../src/modules/economy/service/fixed-asset.service.js";
import { missingMonths } from "../src/modules/economy/service/depreciation-schedule.js";
import { formatNumber } from "../src/modules/mail/service/document-pdf.js";
import { pdfText } from "./helpers/pdf.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { PLAN_YEAR, accountId, resetFixedAssets, setupFixedAssets, testFixedAssetService } from "./helpers/fixed-assets.js";

const Y = PLAN_YEAR;
const YEAR = { id: "fy", label: "2026", startDate: "2026-01-01", endDate: "2026-12-31" };
const INVENTARIER: PlanCategoryInput = {
  id: "cat-1",
  name: "Inventarier",
  assetAccount: { id: "acc-1220", number: "1220", name: "Inventarier och verktyg" },
  accumulatedAccount: { id: "acc-1229", number: "1229", name: "Ack avskrivningar inventarier" },
};
const MASKINER: PlanCategoryInput = {
  id: "cat-2",
  name: "Maskiner",
  assetAccount: { id: "acc-1220", number: "1220", name: "Inventarier och verktyg" }, // shares 1220 on purpose
  accumulatedAccount: { id: "acc-1219", number: "1219", name: "Ack avskrivningar maskiner" },
};

function asset(overrides: Partial<PlanAssetInput>): PlanAssetInput {
  return {
    id: "a1",
    assetNumber: "AN-1",
    name: "CNC-fräs",
    categoryId: "cat-1",
    acquisitionDate: "2025-02-14",
    acquisitionCost: 120000,
    disposalDate: null,
    depreciations: [],
    openingDepreciation: 0,
    ...overrides,
  };
}

describe("buildFixedAssetPlan (pure)", () => {
  it("classifies opening, acquisitions, disposals and the year's depreciation per asset and sums per category", () => {
    const plan = buildFixedAssetPlan({
      fiscalYear: YEAR,
      categories: [INVENTARIER],
      assets: [
        asset({
          depreciations: [
            { date: "2025-12-31", amount: 22000 },
            { date: "2026-06-30", amount: 12000 },
          ],
        }),
        asset({ id: "a2", assetNumber: "AN-2", name: "Server", acquisitionDate: "2026-03-01", acquisitionCost: 36000, depreciations: [{ date: "2026-06-30", amount: 4000 }] }),
        asset({ id: "a3", assetNumber: "AN-3", name: "Såld", acquisitionDate: "2024-01-01", acquisitionCost: 50000, disposalDate: "2026-04-10", depreciations: [{ date: "2025-12-31", amount: 20000 }, { date: "2026-04-10", amount: 4000 }] }),
        asset({ id: "a4", assetNumber: "AN-4", name: "Nästa år", acquisitionDate: "2027-01-05" }),
        asset({ id: "a5", assetNumber: "AN-5", name: "Länge sen", acquisitionDate: "2020-01-05", disposalDate: "2025-06-30", depreciations: [{ date: "2025-06-30", amount: 1 }] }),
      ],
      ledgerBalances: [],
    });
    const rows = plan.categories[0]!.assets;
    expect(rows.map((row) => row.assetNumber)).toEqual(["AN-1", "AN-2", "AN-3"]);
    expect(rows[0]).toMatchObject({ acquisitionOpening: 120000, acquisitions: 0, disposals: 0, acquisitionClosing: 120000, depreciationOpening: 22000, depreciationYear: 12000, depreciationDisposed: 0, depreciationClosing: 34000, bookValueClosing: 86000 });
    expect(rows[1]).toMatchObject({ acquisitionOpening: 0, acquisitions: 36000, acquisitionClosing: 36000, depreciationYear: 4000, depreciationClosing: 4000, bookValueClosing: 32000 });
    expect(rows[2]).toMatchObject({ acquisitionOpening: 50000, disposals: -50000, acquisitionClosing: 0, depreciationOpening: 20000, depreciationYear: 4000, depreciationDisposed: -24000, depreciationClosing: 0, bookValueClosing: 0 });
    expect(plan.categories[0]!.totals).toMatchObject({ acquisitionClosing: 156000, depreciationClosing: 38000, bookValueClosing: 118000 });
    expect(plan.totals.bookValueClosing).toBe(118000);
  });

  // Review Focus 4: acquired and disposed within the year.
  it("shows an asset acquired and disposed in the same year with closing 0 and keeps it out of the reconciliation", () => {
    const plan = buildFixedAssetPlan({
      fiscalYear: YEAR,
      categories: [INVENTARIER],
      assets: [asset({ acquisitionDate: "2026-02-01", disposalDate: "2026-08-15", depreciations: [{ date: "2026-08-15", amount: 14000 }] })],
      ledgerBalances: [{ accountId: "acc-1220", debit: 120000, credit: 120000 }, { accountId: "acc-1229", debit: 14000, credit: 14000 }],
    });
    expect(plan.categories[0]!.assets[0]).toMatchObject({ acquisitions: 120000, disposals: -120000, acquisitionClosing: 0, depreciationYear: 14000, depreciationDisposed: -14000, depreciationClosing: 0 });
    expect(plan.reconciliation.every((row) => !row.mismatch)).toBe(true);
  });

  it("reconciles per account, merging categories that share an account, and flags a difference", () => {
    const plan = buildFixedAssetPlan({
      fiscalYear: YEAR,
      categories: [INVENTARIER, MASKINER],
      assets: [
        asset({ depreciations: [{ date: "2026-12-31", amount: 24000 }] }),
        asset({ id: "a2", assetNumber: "AN-2", categoryId: "cat-2", acquisitionCost: 80000, depreciations: [{ date: "2026-12-31", amount: 16000 }] }),
      ],
      ledgerBalances: [
        { accountId: "acc-1220", debit: 220000, credit: 0 }, // 20 000 booked on 1220 outside the register
        { accountId: "acc-1229", debit: 0, credit: 24000 },
        { accountId: "acc-1219", debit: 0, credit: 16000 },
      ],
    });
    expect(plan.reconciliation).toEqual([
      { accountId: "acc-1219", accountNumber: "1219", accountName: "Ack avskrivningar maskiner", kind: "accumulated", registerAmount: 16000, ledgerAmount: 16000, difference: 0, mismatch: false },
      { accountId: "acc-1220", accountNumber: "1220", accountName: "Inventarier och verktyg", kind: "asset", registerAmount: 200000, ledgerAmount: 220000, difference: 20000, mismatch: true },
      { accountId: "acc-1229", accountNumber: "1229", accountName: "Ack avskrivningar inventarier", kind: "accumulated", registerAmount: 24000, ledgerAmount: 24000, difference: 0, mismatch: false },
    ]);
  });

  // Pre-Nav asset: the opening amount is in the ledger's IB, never a movement.
  it("puts the opening depreciation in the opening column for every year the asset is shown, never in the year's depreciation", () => {
    const pre = asset({ acquisitionDate: "2024-03-15", openingDepreciation: 45000, depreciations: [{ date: "2026-06-30", amount: 12000 }] });
    const plan = buildFixedAssetPlan({
      fiscalYear: YEAR,
      categories: [INVENTARIER],
      assets: [pre],
      ledgerBalances: [{ accountId: "acc-1220", debit: 120000, credit: 0 }, { accountId: "acc-1229", debit: 0, credit: 57000 }],
    });
    expect(plan.categories[0]!.assets[0]).toMatchObject({ depreciationOpening: 45000, depreciationYear: 12000, depreciationClosing: 57000, bookValueClosing: 63000 });
    expect(plan.reconciliation.every((row) => !row.mismatch)).toBe(true);

    // The following year: opening + last year's live row are both "opening".
    const next = buildFixedAssetPlan({
      fiscalYear: { id: "fy27", label: "2027", startDate: "2027-01-01", endDate: "2027-12-31" },
      categories: [INVENTARIER],
      assets: [{ ...pre, depreciations: [...pre.depreciations, { date: "2027-03-31", amount: 3000 }] }],
      ledgerBalances: [],
    });
    expect(next.categories[0]!.assets[0]).toMatchObject({ depreciationOpening: 57000, depreciationYear: 3000, depreciationClosing: 60000 });

    // Disposed during the year: the disposal column removes opening AND live rows.
    const sold = buildFixedAssetPlan({
      fiscalYear: YEAR,
      categories: [INVENTARIER],
      assets: [{ ...pre, disposalDate: "2026-07-01" }],
      ledgerBalances: [],
    });
    expect(sold.categories[0]!.assets[0]).toMatchObject({ depreciationOpening: 45000, depreciationYear: 12000, depreciationDisposed: -57000, depreciationClosing: 0, acquisitionClosing: 0 });
  });

  it("flattens to CSV with one row per asset and a header", () => {
    const plan = buildFixedAssetPlan({ fiscalYear: YEAR, categories: [INVENTARIER], assets: [asset({})], ledgerBalances: [] });
    const csv = buildFixedAssetPlanCsv(plan);
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("Grupp;Nr;Benämning;Anskaffad;Avyttrad;IB anskaffning");
    expect(lines[1]).toContain("Inventarier;AN-1;CNC-fräs;2025-02-14;;120000,00");
  });
});

describe("avskrivningsplan (DB, PDF)", () => {
  beforeEach(resetFixedAssets);
  afterAll(resetFixedAssets);

  it("reconciles against the ledger when the acquisition is booked on the asset account, and warns when it is not", async () => {
    const { user, category, planYearId } = await setupFixedAssets();
    const asset = await testFixedAssetService.createAsset(
      { name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${Y}-02-14`, acquisitionCost: 120000 },
      user.id
    );
    await testFixedAssetService.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);

    const before = await testFixedAssetService.getPlan({ fiscalYearId: planYearId });
    expect(before.reconciliation.find((row) => row.accountNumber === "1220")).toMatchObject({ registerAmount: 120000, ledgerAmount: 0, mismatch: true });
    expect(before.reconciliation.find((row) => row.accountNumber === "1229")).toMatchObject({ registerAmount: 10000, ledgerAmount: 10000, mismatch: false });

    await testEconomyService.createSeries({ code: "A", name: "Manuella verifikat" });
    const series = await testEconomyRepository.findSeriesByCode("A");
    const draft = await testEconomyService.createVerification(
      {
        seriesId: series!.id,
        date: `${Y}-02-14`,
        description: "Köp CNC-fräs",
        rows: [
          { accountId: await accountId("1220"), debit: 120000, credit: 0 },
          { accountId: await accountId("2440"), debit: 0, credit: 120000 },
        ],
      },
      user.id
    );
    await testEconomyService.book(draft.id, user.id);

    const after = await testFixedAssetService.getPlan({ fiscalYearId: planYearId });
    expect(after.reconciliation.every((row) => !row.mismatch)).toBe(true);
    expect(after.categories[0]!.assets[0]).toMatchObject({ assetNumber: asset.assetNumber, acquisitions: 120000, depreciationYear: 10000, bookValueClosing: 110000 });
    await expect(testFixedAssetService.getPlan({ fiscalYearId: crypto.randomUUID() })).rejects.toBeInstanceOf(FixedAssetPlanYearNotFoundError);
  });

  it("reconciles a pre-Nav asset: opening depreciation in the opening column, ledger IB includes it", async () => {
    const { user, category, planYearId } = await setupFixedAssets();
    const created = await testFixedAssetService.createAsset(
      {
        name: "Gammal svarv",
        categoryId: category.id,
        acquisitionDate: `${Y - 2}-03-15`,
        depreciationStartMonth: `${Y - 2}-03`,
        acquisitionCost: 120000,
        usefulLifeMonths: 60,
        residualValue: 0,
        openingDepreciation: 45000,
        openingDepreciationThroughMonth: `${Y - 1}-12`,
      },
      user.id
    );
    await testFixedAssetService.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    const yearAmount = missingMonths(
      { acquisitionCost: 120000, residualValue: 0, usefulLifeMonths: 60, depreciationStartMonth: `${Y - 2}-03`, bookedMonths: [{ month: `${Y - 1}-12`, amount: 45000 }] },
      `${Y}-06`
    ).reduce((sum, row) => sum + row.amount, 0);

    // The ledger's opening balance as the SIE import books it: dated the year's first day.
    await testEconomyService.createSeries({ code: "A", name: "Manuella verifikat" });
    const series = await testEconomyRepository.findSeriesByCode("A");
    const draft = await testEconomyService.createVerification(
      {
        seriesId: series!.id,
        date: `${Y}-01-01`,
        description: "Ingående balans",
        rows: [
          { accountId: await accountId("1220"), debit: 120000, credit: 0 },
          { accountId: await accountId("1229"), debit: 0, credit: 45000 },
          { accountId: await accountId("2440"), debit: 0, credit: 75000 },
        ],
      },
      user.id
    );
    await testEconomyService.book(draft.id, user.id);

    const plan = await testFixedAssetService.getPlan({ fiscalYearId: planYearId });
    const row = plan.categories[0]!.assets[0]!;
    expect(row).toMatchObject({ assetNumber: created.assetNumber, acquisitionOpening: 120000, acquisitions: 0, depreciationOpening: 45000 });
    expect(row.depreciationYear).toBeCloseTo(yearAmount, 2);
    expect(row.depreciationClosing).toBeCloseTo(45000 + yearAmount, 2);
    expect(plan.reconciliation.every((r) => !r.mismatch)).toBe(true);
    expect(plan.reconciliation.find((r) => r.accountNumber === "1229")!.ledgerAmount).toBeCloseTo(45000 + yearAmount, 2);
  });

  it("renders the PDF and the CSV", async () => {
    const { user, category, planYearId } = await setupFixedAssets();
    await testFixedAssetService.createAsset({ name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${Y}-02-14`, acquisitionCost: 120000 }, user.id);
    await testFixedAssetService.bookDepreciation({ throughMonth: `${Y}-06` }, user.id);
    const pdf = await testFixedAssetService.getPlanPdf({ fiscalYearId: planYearId });
    expect(pdf.filename).toBe(`avskrivningsplan-${Y}.pdf`);
    const text = pdfText(pdf.content);
    expect(text).toContain("Avskrivningsplan");
    expect(text).toContain("AN-1");
    expect(text).toContain("CNC-fräs");
    expect(text).toContain(formatNumber(110000));
    expect(text).not.toContain("-0,00");
    expect(text).toContain("1220");
    const csv = await testFixedAssetService.getPlanCsv({ fiscalYearId: planYearId });
    expect(csv.filename).toBe(`avskrivningsplan-${Y}.csv`);
    expect(csv.content).toContain("AN-1;CNC-fräs");
  });
});
