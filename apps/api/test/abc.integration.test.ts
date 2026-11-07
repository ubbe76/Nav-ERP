import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { configuratorTemplates, db, stockTransactions, systemSettings } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";

// ABC-klassning (#10, etapp 2) against the database. "Today" is pinned to
// 2030-03-04 like forecast.integration.test.ts: the default period is the
// twelve whole months 2029-03 … 2030-02. The consumption is written
// straight into stock_transactions (created_at dates the värderingsdag).
// The planning service never creates orders here, so the creators are
// stubs.

const TODAY = "2030-03-04";

const articleRepo = createArticleRepository(db);
const stockService = createStockService(createStockRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: { createPurchaseOrder: async () => { throw new Error("not used"); } } as never,
  manufacturing: { createManufacturingOrder: async () => { throw new Error("not used"); } } as never,
  requirementsCacheMs: 0,
  today: () => TODAY,
});
// The register with the classification bound (app.ts binds planningService
// the same way) and one without (the fixtures' shape).
const articleService = createArticleService(articleRepo, undefined, { abc: planningService });
const plainArticleService = createArticleService(articleRepo);

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, configurator_templates, bom_components, article_forecasts, articles CASCADE`;
const SETTING_KEYS = ["planning_abc_period_months", "planning_abc_class_a_percent", "planning_abc_class_b_percent"];

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  locationId = null;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
});

let locationId: string | null = null;
async function location() {
  if (locationId) return locationId;
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID().slice(0, 6)}`, active: true });
  const loc = await stockService.createLocation({ warehouseId: warehouse.id, name: `A-${crypto.randomUUID().slice(0, 6)}`, active: true });
  locationId = loc.id;
  return loc.id;
}

type Movement = { day: string; type: "sales_delivery" | "mo_consumption" | "inventory_adjustment" | "purchase_receipt"; delta: number };

async function movements(articleId: string, rows: Movement[]) {
  const loc = await location();
  await db.insert(stockTransactions).values(
    rows.map((r) => ({
      articleId,
      locationId: loc,
      quantityDelta: String(r.delta),
      transactionType: r.type,
      createdAt: new Date(`${r.day}T10:00:00Z`),
    }))
  );
}

async function article(
  articleNumber: string,
  opts: {
    type?: "purchased" | "manufactured" | "service";
    standardCost?: number;
    isPhantom?: boolean;
    active?: boolean;
    reorderPoint?: number;
    safetyStock?: number;
    forecastControlled?: boolean;
    template?: "variants" | "to_order";
  } = {}
) {
  const a = await articleService.createArticle({
    articleNumber,
    name: `Namn ${articleNumber}`,
    type: opts.type ?? "purchased",
    active: opts.active ?? true,
    isPhantom: opts.isPhantom ?? false,
    standardCost: opts.standardCost,
    reorderPoint: opts.reorderPoint,
    safetyStock: opts.safetyStock,
    forecastControlled: opts.forecastControlled,
  });
  if (opts.template) await db.insert(configuratorTemplates).values({ articleId: a.id, mode: opts.template });
  return a;
}

// The standard picture (total 1300): P1 1000 (A), P2 200 (A — 76.92 % before
// it), M1 100 (B — 92.31 % before it), P3 flagged (consumption, no standard
// cost), P4 unused. S1/PH/INACT/T1/T2 have consumption but are outside the
// selection (service, phantom, inactive, templates).
async function standardPicture() {
  const p1 = await article("P1", { standardCost: 10, reorderPoint: 20, safetyStock: 5, forecastControlled: true });
  await movements(p1.id, [
    { day: "2029-02-20", type: "purchase_receipt", delta: 500 },
    { day: "2029-06-10", type: "sales_delivery", delta: -100 },
    // Outside the period: before it and in the current month.
    { day: "2029-02-25", type: "sales_delivery", delta: -1000 },
    { day: "2030-03-02", type: "sales_delivery", delta: -1000 },
    // Not consumption.
    { day: "2029-11-20", type: "inventory_adjustment", delta: -50 },
  ]);
  const p2 = await article("P2", { standardCost: 5 });
  await movements(p2.id, [
    { day: "2029-10-01", type: "mo_consumption", delta: -40 },
    // An undone delivery nets to 0.
    { day: "2029-09-12", type: "sales_delivery", delta: -6 },
    { day: "2029-09-13", type: "sales_delivery", delta: 6 },
  ]);
  const m1 = await article("M1", { type: "manufactured", standardCost: 2 });
  await movements(m1.id, [{ day: "2030-02-28", type: "sales_delivery", delta: -50 }]);
  const p3 = await article("P3");
  await movements(p3.id, [{ day: "2029-05-05", type: "sales_delivery", delta: -10 }]);
  const p4 = await article("P4", { standardCost: 100 });
  const excluded = [
    await article("S1", { type: "service", standardCost: 10 }),
    await article("PH", { type: "manufactured", isPhantom: true, standardCost: 10 }),
    await article("INACT", { active: false, standardCost: 10 }),
    await article("T1", { type: "manufactured", standardCost: 10, template: "variants" }),
    await article("T2", { type: "manufactured", standardCost: 10, template: "to_order" }),
  ];
  for (const e of excluded) await movements(e.id, [{ day: "2029-08-08", type: "sales_delivery", delta: -1000 }]);
  return { p1, p2, m1, p3, p4, excluded };
}

const classes = (rows: { articleNumber: string; abcClass: string }[]) => rows.map((r) => `${r.articleNumber}:${r.abcClass}`);

describe("the classification out of the stock log", () => {
  it("sums the period's consumption, values it at the standard cost, flags a missing one, excludes services/phantoms/inactive/templates and classes by cumulative share", async () => {
    const { p1 } = await standardPicture();
    const list = await planningService.listAbc({ limit: 50, offset: 0 });
    expect(list.period).toEqual({ months: 12, from: "2029-03-01", to: "2030-02-28" });
    expect(list.limits).toEqual({ aPercent: 80, bPercent: 95 });
    expect(list.total).toBe(5);
    expect(classes(list.rows)).toEqual(["P1:A", "P2:A", "M1:B", "P3:C", "P4:C"]);
    expect(list.rows[0]).toMatchObject({
      articleId: p1.id,
      articleNumber: "P1",
      name: "Namn P1",
      type: "purchased",
      consumed: 100,
      standardCost: 10,
      value: 1000,
      share: 76.92,
      cumulativeShare: 76.92,
      abcClass: "A",
      missingStandardCost: false,
      reorderPoint: 20,
      safetyStock: 5,
      forecastControlled: true,
    });
    expect(list.rows[1]).toMatchObject({ articleNumber: "P2", consumed: 40, value: 200, share: 15.38, cumulativeShare: 92.31, reorderPoint: null, safetyStock: null, forecastControlled: false });
    expect(list.rows[2]).toMatchObject({ articleNumber: "M1", type: "manufactured", consumed: 50, value: 100, share: 7.69, cumulativeShare: 100 });
    expect(list.rows[3]).toMatchObject({ articleNumber: "P3", consumed: 10, standardCost: null, value: 0, abcClass: "C", missingStandardCost: true });
    expect(list.rows[4]).toMatchObject({ articleNumber: "P4", consumed: 0, standardCost: 100, value: 0, abcClass: "C", missingStandardCost: false });
    expect(list.summary).toEqual([
      { abcClass: "A", count: 2, value: 1200, share: 92.31 },
      { abcClass: "B", count: 1, value: 100, share: 7.69 },
      { abcClass: "C", count: 2, value: 0, share: 0 },
    ]);
  });

  it("follows the class limits and the period from the settings", async () => {
    const { p4 } = await standardPicture();
    await systemService.updateSettings({ planningAbcClassAPercent: 70, planningAbcClassBPercent: 90 });
    let list = await planningService.listAbc({ limit: 50, offset: 0 });
    expect(list.limits).toEqual({ aPercent: 70, bPercent: 90 });
    expect(classes(list.rows)).toEqual(["P1:A", "P2:B", "M1:C", "P3:C", "P4:C"]);

    // Three months (2029-12 … 2030-02): only M1's February delivery is
    // inside — and a January delivery of P4 makes it the biggest.
    await movements(p4.id, [{ day: "2030-01-15", type: "sales_delivery", delta: -3 }]);
    await systemService.updateSettings({ planningAbcPeriodMonths: 3 });
    list = await planningService.listAbc({ limit: 50, offset: 0 });
    expect(list.period).toEqual({ months: 3, from: "2029-12-01", to: "2030-02-28" });
    expect(classes(list.rows)).toEqual(["P4:A", "M1:B", "P1:C", "P2:C", "P3:C"]);
    expect(list.rows[0]).toMatchObject({ consumed: 3, value: 300, share: 75 });
    expect(list.rows[1]).toMatchObject({ consumed: 50, value: 100, cumulativeShare: 100 });
    // P3's consumption lies outside the period now: nothing to price, no flag.
    expect(list.rows.find((r) => r.articleNumber === "P3")).toMatchObject({ consumed: 0, missingStandardCost: false });

    // A stored pair that breaks the rule decodes to the defaults.
    await db.insert(systemSettings).values({ key: "planning_abc_class_a_percent", value: "99" }).onConflictDoUpdate({ target: systemSettings.key, set: { value: "99" } });
    list = await planningService.listAbc({ limit: 50, offset: 0 });
    expect(list.limits).toEqual({ aPercent: 80, bPercent: 95 });
  });

  it("filters by class, type and search with total following the filter, pages the sorted rows and keeps the whole summary", async () => {
    await standardPicture();
    const onlyC = await planningService.listAbc({ limit: 50, offset: 0, class: ["C"] });
    expect(onlyC.total).toBe(2);
    expect(classes(onlyC.rows)).toEqual(["P3:C", "P4:C"]);
    expect(onlyC.summary[0]).toEqual({ abcClass: "A", count: 2, value: 1200, share: 92.31 });

    const ab = await planningService.listAbc({ limit: 50, offset: 0, class: ["A", "B"] });
    expect(classes(ab.rows)).toEqual(["P1:A", "P2:A", "M1:B"]);

    const manufactured = await planningService.listAbc({ limit: 50, offset: 0, type: "manufactured" });
    expect(manufactured.total).toBe(1);
    expect(classes(manufactured.rows)).toEqual(["M1:B"]);

    const search = await planningService.listAbc({ limit: 50, offset: 0, search: "namn p" });
    expect(search.total).toBe(4);
    expect(classes(search.rows)).toEqual(["P1:A", "P2:A", "P3:C", "P4:C"]);

    const page = await planningService.listAbc({ limit: 2, offset: 1 });
    expect(page.total).toBe(5);
    expect(classes(page.rows)).toEqual(["P2:A", "M1:B"]);
  });

  it("answers an empty register with no rows and an all-zero summary", async () => {
    const list = await planningService.listAbc({ limit: 50, offset: 0 });
    expect(list.rows).toEqual([]);
    expect(list.total).toBe(0);
    expect(list.summary.map((s) => s.count)).toEqual([0, 0, 0]);
  });
});

describe("the article register's ABC column", () => {
  it("carries abcClass per row from the same classification (null outside the selection), filters by class with total following, and the card has it too", async () => {
    const { p1, excluded } = await standardPicture();
    const all = await articleService.listArticles({ limit: 50, offset: 0, withAbc: true });
    expect(all.total).toBe(10);
    const byNumber = Object.fromEntries(all.rows.map((r) => [r.articleNumber, r.abcClass]));
    expect(byNumber).toEqual({ P1: "A", P2: "A", M1: "B", P3: "C", P4: "C", S1: null, PH: null, INACT: null, T1: null, T2: null });

    const onlyA = await articleService.listArticles({ limit: 50, offset: 0, abcClass: ["A"] });
    expect(onlyA.total).toBe(2);
    expect(onlyA.rows.map((r) => r.articleNumber)).toEqual(["P1", "P2"]);
    // The class filter combines with the others (where built once).
    const cManufactured = await articleService.listArticles({ limit: 50, offset: 0, abcClass: ["B", "C"], type: "manufactured" });
    expect(cManufactured.total).toBe(1);
    expect(cManufactured.rows[0]).toMatchObject({ articleNumber: "M1", abcClass: "B" });
    const paged = await articleService.listArticles({ limit: 1, offset: 1, abcClass: ["A", "B", "C"] });
    expect(paged.total).toBe(5);
    expect(paged.rows.map((r) => r.articleNumber)).toEqual(["P1"]);

    expect((await articleService.getArticle(p1.id, { withAbc: true }))?.abcClass).toBe("A");
    expect((await articleService.getArticle(excluded[0]!.id, { withAbc: true }))?.abcClass).toBeNull();
    expect(await articleService.getArticle("00000000-0000-4000-8000-000000000000")).toBeNull();

    // Without the reader (the fixtures): null everywhere, the filter matches nothing.
    const plain = await plainArticleService.listArticles({ limit: 50, offset: 0, withAbc: true });
    expect(plain.total).toBe(10);
    expect(plain.rows.every((r) => r.abcClass === null)).toBe(true);
    expect(await plainArticleService.listArticles({ limit: 50, offset: 0, abcClass: ["A"] })).toEqual({ rows: [], total: 0 });
    expect((await plainArticleService.getArticle(p1.id, { withAbc: true }))?.abcClass).toBeNull();

    // Opt-in: without withAbc (the ArticlePicker, the configurator's getArticle)
    // the classification is never read and the rows carry no abcClass.
    let reads = 0;
    const counting = createArticleService(createArticleRepository(db), undefined, {
      abc: { abcClassByArticle: async () => (reads++, new Map()) },
    });
    const bare = await counting.listArticles({ limit: 50, offset: 0 });
    expect(bare.total).toBe(10);
    expect(bare.rows.every((r) => !("abcClass" in r))).toBe(true);
    expect("abcClass" in ((await counting.getArticle(p1.id)) ?? {})).toBe(false);
    expect(reads).toBe(0);
    await counting.listArticles({ limit: 50, offset: 0, withAbc: true });
    await counting.listArticles({ limit: 50, offset: 0, abcClass: ["A"] });
    expect(reads).toBe(2);
  });
});
