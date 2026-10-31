import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { fixedAssetRoutes } from "../src/modules/economy/routes/fixed-asset.routes.js";
import { PLAN_YEAR, accountId, resetFixedAssets, setupFixedAssets, testFixedAssetService } from "./helpers/fixed-assets.js";
import { testEconomyService } from "./helpers/services.js";

beforeEach(resetFixedAssets);
afterAll(resetFixedAssets);

export function buildFixedAssetApp(userId: string) {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: userId, email: "test@example.com", name: "Testanvändare", role: "admin" } as never;
  });
  app.register(fixedAssetRoutes, { service: testFixedAssetService });
  return app;
}

describe("fixed-asset-categories routes", () => {
  it("201s a category, 409s a duplicate name, 404s an unknown id, 400s non-distinct accounts", async () => {
    const { user } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    const payload = {
      name: "Maskiner",
      assetAccountId: await accountId("1210"),
      accumulatedDepreciationAccountId: await accountId("1219"),
      depreciationExpenseAccountId: await accountId("7830"),
      disposalGainAccountId: await accountId("3973"),
      disposalLossAccountId: await accountId("7970"),
      defaultUsefulLifeMonths: 60,
    };
    const created = await app.inject({ method: "POST", url: "/fixed-asset-categories", payload });
    expect(created.statusCode).toBe(201);
    expect(created.json().accounts.asset.number).toBe("1210");

    const duplicate = await app.inject({ method: "POST", url: "/fixed-asset-categories", payload });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("duplicate-fixed-asset-category-name");

    const missing = await app.inject({ method: "PATCH", url: `/fixed-asset-categories/${crypto.randomUUID()}`, payload: { name: "X" } });
    expect(missing.statusCode).toBe(404);

    const same = await app.inject({
      method: "POST",
      url: "/fixed-asset-categories",
      payload: { ...payload, name: "Fel", depreciationExpenseAccountId: payload.assetAccountId },
    });
    expect(same.statusCode).toBe(400);
    expect(same.json().code).toBe("fixed-asset-category-accounts-not-distinct");

    const empty = await app.inject({ method: "POST", url: "/fixed-asset-categories", payload: {} });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe("validation-failed");

    // Inventarier's ack account (1229) as another group's expense account.
    const crossed = await app.inject({
      method: "POST",
      url: "/fixed-asset-categories",
      payload: { ...payload, name: "Korsad", depreciationExpenseAccountId: await accountId("1229") },
    });
    expect(crossed.statusCode).toBe(409);
    expect(crossed.json()).toMatchObject({
      code: "fixed-asset-category-account-role-conflict",
      accountNumber: "1229",
      role: "expense",
      categoryName: "Inventarier",
      otherRole: "accumulated",
    });
    await app.close();
  });

  it("409s a posting-account change on a group with booked depreciation and exposes the lock flag", async () => {
    const { user, category } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    await testFixedAssetService.createAsset(
      { name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-02-14`, acquisitionCost: 120000 },
      user.id
    );
    await testFixedAssetService.bookDepreciation({ throughMonth: `${PLAN_YEAR}-03` }, user.id);
    const list = await app.inject({ url: "/fixed-asset-categories" });
    expect(list.json()[0].postingAccountsLocked).toBe(true);

    const locked = await app.inject({
      method: "PATCH",
      url: `/fixed-asset-categories/${category.id}`,
      payload: { depreciationExpenseAccountId: await accountId("7820") },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().code).toBe("fixed-asset-category-accounts-locked");

    const renamed = await app.inject({ method: "PATCH", url: `/fixed-asset-categories/${category.id}`, payload: { name: "Inventarier B" } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Inventarier B");
    await app.close();
  });

  it("seeds BAS categories and 409s when a BAS account is inactive", async () => {
    const { user } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    const seeded = await app.inject({ method: "POST", url: "/fixed-asset-categories/generate-bas" });
    expect(seeded.statusCode).toBe(200);
    expect(seeded.json().created).toHaveLength(5);
    await app.close();
  });
});

describe("fixed-assets routes", () => {
  it("201s, 404s an unknown asset, 400s a residual above cost and 204s a delete", async () => {
    const { user, category } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    const created = await app.inject({
      method: "POST",
      url: "/fixed-assets",
      payload: { name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-02-14`, acquisitionCost: "120000" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().assetNumber).toBe("AN-1");

    expect((await app.inject({ url: `/fixed-assets/${crypto.randomUUID()}` })).statusCode).toBe(404);

    const bad = await app.inject({ method: "PATCH", url: `/fixed-assets/${created.json().id}`, payload: { residualValue: "999999" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe("invalid-fixed-asset-values");

    const list = await app.inject({ url: "/fixed-assets?search=cnc" });
    expect(list.json().total).toBe(1);

    expect((await app.inject({ method: "DELETE", url: `/fixed-assets/${created.json().id}` })).statusCode).toBe(204);
    await app.close();
  });

  // Browser-check bug: the register's default "Aktiva" view must not show a
  // disposed asset. status=active filters, status=disposed filters, no
  // status = everything.
  it("filters the list on status=active and status=disposed", async () => {
    const { user, category } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    const disposed = await testFixedAssetService.createAsset(
      { name: "Gammal svarv", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-02-14`, acquisitionCost: 12000 },
      user.id
    );
    await testFixedAssetService.createAsset(
      { name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-03-01`, acquisitionCost: 120000 },
      user.id
    );
    await testFixedAssetService.disposeAsset(disposed.id, { disposalType: "scrap", disposalDate: `${PLAN_YEAR}-09-18` }, user.id);

    const active = await app.inject({ url: "/fixed-assets?status=active&limit=50&offset=0" });
    expect(active.statusCode).toBe(200);
    expect(active.json().total).toBe(1);
    expect(active.json().rows.map((row: { assetNumber: string }) => row.assetNumber)).toEqual(["AN-2"]);

    const gone = await app.inject({ url: "/fixed-assets?status=disposed" });
    expect(gone.json().rows.map((row: { assetNumber: string }) => row.assetNumber)).toEqual(["AN-1"]);

    const all = await app.inject({ url: "/fixed-assets" });
    expect(all.json().total).toBe(2);
    await app.close();
  });

  it("400s an opening depreciation whose through-month lies before the plan starts, and one missing its month", async () => {
    const { user, category } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    const payload = {
      name: "Gammal svarv",
      categoryId: category.id,
      acquisitionDate: `${PLAN_YEAR - 2}-03-15`,
      acquisitionCost: "120000",
      openingDepreciation: "44000",
    };
    const unpaired = await app.inject({ method: "POST", url: "/fixed-assets", payload });
    expect(unpaired.statusCode).toBe(400);
    expect(unpaired.json().code).toBe("validation-failed");

    const early = await app.inject({
      method: "POST",
      url: "/fixed-assets",
      payload: { ...payload, openingDepreciationThroughMonth: `${PLAN_YEAR - 2}-02` },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().code).toBe("invalid-opening-depreciation");

    const ok = await app.inject({
      method: "POST",
      url: "/fixed-assets",
      payload: { ...payload, openingDepreciationThroughMonth: `${PLAN_YEAR - 1}-12` },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      openingDepreciation: "44000.00",
      openingDepreciationThroughMonth: `${PLAN_YEAR - 1}-12-01`,
      accumulatedDepreciation: 44000,
      bookValue: 76000,
    });

    const locked = await app.inject({
      method: "PATCH",
      url: `/fixed-assets/${ok.json().id}`,
      payload: { openingDepreciation: "45000" },
    });
    // Before any run the field is simply edited; the merged row is validated.
    expect(locked.statusCode).toBe(200);
    expect(locked.json().accumulatedDepreciation).toBe(45000);
    await app.close();
  });
});

describe("fixed-asset-depreciation-runs routes", () => {
  it("201s a run, 409s nothing-to-depreciate, 400s a future month and 409s a locked month", async () => {
    const { user, category, planYearId } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    await testFixedAssetService.createAsset(
      { name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-02-14`, acquisitionCost: 120000 },
      user.id
    );
    const preview = await app.inject({ url: `/fixed-asset-depreciation-runs/preview?throughMonth=${PLAN_YEAR}-06` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().total).toBe(10000);

    const booked = await app.inject({ method: "POST", url: "/fixed-asset-depreciation-runs", payload: { throughMonth: `${PLAN_YEAR}-06` } });
    expect(booked.statusCode).toBe(201);
    expect(booked.json().verification.displayNumber).toBe(`AV-${PLAN_YEAR}-1`);

    const again = await app.inject({ method: "POST", url: "/fixed-asset-depreciation-runs", payload: { throughMonth: `${PLAN_YEAR}-06` } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("nothing-to-depreciate");

    const future = await app.inject({
      method: "POST",
      url: "/fixed-asset-depreciation-runs",
      payload: { throughMonth: `${new Date().getFullYear() + 1}-01` },
    });
    expect(future.statusCode).toBe(400);
    expect(future.json().code).toBe("depreciation-month-in-future");

    const year = await testEconomyService.findFiscalYearById(planYearId);
    await testEconomyService.lockPeriod(year.periods.find((p) => p.startDate === `${PLAN_YEAR}-07-01`)!.id, user.id);
    const locked = await app.inject({ method: "POST", url: "/fixed-asset-depreciation-runs", payload: { throughMonth: `${PLAN_YEAR}-07` } });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().code).toBe("accounting-period-locked");

    const badMonth = await app.inject({ url: "/fixed-asset-depreciation-runs/preview?throughMonth=2026-13" });
    expect(badMonth.statusCode).toBe(400);
    expect(badMonth.json().code).toBe("validation-failed");

    const runs = await app.inject({ url: "/fixed-asset-depreciation-runs" });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().total).toBe(1);
    expect(runs.json().rows[0].undoable).toBe(true);
    await app.close();
  });
});

describe("POST /fixed-asset-depreciation-runs/:runId/undo", () => {
  it("200s the latest run, 409s the one before it and 404s an unknown id", async () => {
    const { user, category } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    await testFixedAssetService.createAsset(
      { name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-02-14`, acquisitionCost: 120000 },
      user.id
    );
    const first = await testFixedAssetService.bookDepreciation({ throughMonth: `${PLAN_YEAR}-03` }, user.id);
    const second = await testFixedAssetService.bookDepreciation({ throughMonth: `${PLAN_YEAR}-06` }, user.id);
    const notLatest = await app.inject({ method: "POST", url: `/fixed-asset-depreciation-runs/${first.run.id}/undo` });
    expect(notLatest.statusCode).toBe(409);
    expect(notLatest.json().code).toBe("depreciation-run-not-latest");
    const ok = await app.inject({ method: "POST", url: `/fixed-asset-depreciation-runs/${second.run.id}/undo` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reversalVerification.displayNumber).toBe(`AV-${PLAN_YEAR}-3`);
    expect((await app.inject({ method: "POST", url: `/fixed-asset-depreciation-runs/${crypto.randomUUID()}/undo` })).statusCode).toBe(404);
    await app.close();
  });
});

describe("disposal routes", () => {
  it("previews with a warning, 400s a bad date, and disposes", async () => {
    const { user, category } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    const asset = await testFixedAssetService.createAsset(
      { name: "CNC-fräs", categoryId: category.id, acquisitionDate: `${PLAN_YEAR}-02-14`, acquisitionCost: 120000 },
      user.id
    );
    const gain = await accountId("3973");
    const preview = await app.inject({
      url: `/fixed-assets/${asset.id}/disposal-preview?disposalType=sale&disposalDate=${PLAN_YEAR}-09-18&disposalPrice=95000&intermediateAccountId=${gain}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().warnings).toEqual(["intermediate-account-not-box-05"]);

    const early = await app.inject({
      method: "POST",
      url: `/fixed-assets/${asset.id}/dispose`,
      payload: { disposalType: "scrap", disposalDate: `${PLAN_YEAR}-01-01` },
    });
    expect(early.statusCode).toBe(400);
    expect(early.json().code).toBe("invalid-disposal-date");

    const unknownAccount = await app.inject({
      method: "POST",
      url: `/fixed-assets/${asset.id}/dispose`,
      payload: { disposalType: "sale", disposalDate: `${PLAN_YEAR}-09-18`, disposalPrice: 1000, intermediateAccountId: crypto.randomUUID() },
    });
    expect(unknownAccount.statusCode).toBe(404);
    expect(unknownAccount.json().code).toBe("account-not-found");

    const disposed = await app.inject({
      method: "POST",
      url: `/fixed-assets/${asset.id}/dispose`,
      payload: { disposalType: "scrap", disposalDate: `${PLAN_YEAR}-09-18` },
    });
    expect(disposed.statusCode).toBe(200);
    expect(disposed.json().asset.status).toBe("disposed");
    expect(disposed.json().disposalVerification.displayNumber).toBe(`AV-${PLAN_YEAR}-2`);

    const again = await app.inject({
      method: "POST",
      url: `/fixed-assets/${asset.id}/dispose`,
      payload: { disposalType: "scrap", disposalDate: `${PLAN_YEAR}-09-18` },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("fixed-asset-not-active");
    await app.close();
  });
});

describe("fixed-asset-plan routes", () => {
  it("200s JSON, PDF and CSV and 404s an unknown fiscal year", async () => {
    const { user, planYearId } = await setupFixedAssets();
    const app = buildFixedAssetApp(user.id);
    expect((await app.inject({ url: `/fixed-asset-plan?fiscalYearId=${planYearId}` })).statusCode).toBe(200);
    const pdf = await app.inject({ url: `/fixed-asset-plan/pdf?fiscalYearId=${planYearId}` });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const csv = await app.inject({ url: `/fixed-asset-plan/csv?fiscalYearId=${planYearId}` });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    const missing = await app.inject({ url: `/fixed-asset-plan?fiscalYearId=${crypto.randomUUID()}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("fixed-asset-plan-year-not-found");
    await app.close();
  });
});
