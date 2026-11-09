import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articleCodes, articles, configuratorTemplates, costCalculations, db } from "@navet/db";
import { createArticleGroupSchema, createArticleSchema, preCalculationBatchSaveSchema, preCalculationBatchSchema, PRE_CALCULATION_BATCH_MAX } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { setCopiedArticles } from "../src/modules/article/repository/copied-articles.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { ArticleNotFoundError, createCostingService, type CostingService } from "../src/modules/costing/service/costing.service.js";
import {
  PreCalculationBatchTooLargeError,
  createPreCalculationBatchService,
  ZERO_COST_WARNING,
} from "../src/modules/costing/service/pre-calculation-batch.service.js";
import { parsed } from "./helpers/parsed.js";

// Förkalkylera flera (#27) against the database: the quantity per article,
// the selection, the cap, a failing article, previous/change, the preview
// writing nothing, the save with and without the price flags (exactly what
// the card's apply functions write), partial success and multiLevel.

const articleRepo = createArticleRepository(db);
const articleService = createArticleService(articleRepo);
const authRepo = createAuthRepository(db);

// 20 % general markup so pris/st differs from TVK/st; Affo 10 % so SVK
// differs from TVK.
const costingSettings = {
  costingMaterialSource: "standard" as "standard" | "supplier",
  costingSupplierPriceTier: "base" as "base" | "tiered",
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 10,
  costingGeneralMarkupPercent: 20,
  costingMaterialMarkupPercent: 0,
};
const costingService = createCostingService(createCostingRepository(db), { getSettings: async () => costingSettings }, articleService);
const copied = { listCopiedArticleIds: async (userId: string) => (await articleService.listCopiedArticles(userId)).articleIds };
const logged: { msg: string; extra?: Record<string, unknown> }[] = [];
const log = (msg: string, extra?: Record<string, unknown>) => {
  logged.push({ msg, extra });
};
const batch = createPreCalculationBatchService({ db, costing: costingService, copied, log });

// A costing dependency whose preCalculate is wrapped (spied on or made to
// fail for one article) and otherwise the real one. The overloads make the
// real function awkward to call generically, hence the two casts.
const realPreCalculate = costingService.preCalculate as unknown as (...args: unknown[]) => Promise<never>;
const withPreCalculate = (fn: (...args: unknown[]) => Promise<unknown>) => ({
  ...costingService,
  preCalculate: fn as unknown as CostingService["preCalculate"],
});

const TRUNCATE = sql`TRUNCATE user_copied_articles, configurator_templates, cost_calculations, article_standard_cost_history, article_sales_price_history, routing_operations, work_centers, bom_components, articles, article_groups, article_codes, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  logged.length = 0;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

let seq = 0;
const nextNumber = (p: string) => `${p}-${(seq += 1)}`;

async function makeUser() {
  return authRepo.create({ email: `batch-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Kalkyl", role: "admin" });
}

// A manufactured parent with 3 × a purchased component at `componentCost`:
// TVK = 3 × componentCost per unit, no routing. The component is INACTIVE so
// the default selection (active only) is the products alone.
async function makeProduct(opts: {
  articleNumber?: string;
  componentCost?: number;
  standardCost?: number;
  salesPrice?: number;
  groupId?: string;
  articleCodeId?: string;
  active?: boolean;
  type?: "manufactured" | "purchased" | "service";
} = {}) {
  const parent = await articleService.createArticle(
    parsed(createArticleSchema, {
      articleNumber: opts.articleNumber ?? nextNumber("P"),
      name: `Produkt ${opts.articleNumber ?? seq}`,
      type: opts.type ?? "manufactured",
      standardCost: opts.standardCost,
      salesPrice: opts.salesPrice,
      groupId: opts.groupId,
      articleCodeId: opts.articleCodeId,
      active: opts.active ?? true,
    })
  );
  if ((opts.type ?? "manufactured") === "manufactured") {
    const component = await articleService.createArticle(
      parsed(createArticleSchema, {
        articleNumber: nextNumber("K"),
        name: "Komponent",
        type: "purchased",
        standardCost: opts.componentCost ?? 100,
        active: false,
      })
    );
    await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 3 });
  }
  return parent;
}

const filter = (
  f: Partial<{
    articleNumberRanges: { from?: string; to?: string }[];
    groupId: string;
    type: "manufactured" | "purchased" | "service";
    articleCodeId: string;
    activeOnly: boolean;
  }> = {}
) =>
  parsed(preCalculationBatchSchema, { selection: { activeOnly: true, ...f }, fallbackQuantity: 1 });

const article = (id: string) => db.select().from(articles).where(eq(articles.id, id)).then((r) => r[0]!);
const calculationCount = () => db.select({ n: sql<number>`count(*)::int` }).from(costCalculations).then((r) => r[0]!.n);

describe("Förkalkylera flera — the quantity", () => {
  it("is the latest saved förkalkyl's quantity, else the fallback — a saved trial counts as the latest", async () => {
    const user = await makeUser();
    const withCalc = await makeProduct({ articleNumber: "Q-1" });
    const withoutCalc = await makeProduct({ articleNumber: "Q-2" });
    const withTrial = await makeProduct({ articleNumber: "Q-3" });
    await costingService.preCalculate(withCalc.id, 2, true);
    await costingService.preCalculate(withCalc.id, 5, true);
    await costingService.preCalculate(withTrial.id, 4, true);
    // A saved Pröva påslag is a förkalkyl like any other and the latest (costing.md).
    await costingService.preCalculate(withTrial.id, 9, true, false, { generalMarkupPercent: 50 });

    const { rows } = await batch.preview(user.id, parsed(preCalculationBatchSchema, { selection: { activeOnly: true }, fallbackQuantity: 7 }));
    expect(rows.map((r) => [r.articleNumber, r.quantity, r.quantitySource])).toEqual([
      ["Q-1", 5, "latest"],
      ["Q-2", 7, "fallback"],
      ["Q-3", 9, "latest"],
    ]);
    // The previous is that same calculation (quantity 9), not the first.
    expect(rows[2]!.previous?.quantity).toBe(9);
  });
});

describe("Förkalkylera flera — the selection", () => {
  it("from/to are inclusive and in byte order", async () => {
    const user = await makeUser();
    for (const n of ["A-1", "A-10", "A-9", "B-1"]) await makeProduct({ articleNumber: n });
    // Byte order: "A-1" < "A-10" < "A-9" < "B-1" — an ICU/natural sort would
    // put A-9 before A-10 and make this range something else.
    const { rows } = await batch.preview(user.id, filter({ articleNumberRanges: [{ from: "A-10", to: "A-9" }] }));
    expect(rows.map((r) => r.articleNumber)).toEqual(["A-10", "A-9"]);
    const open = await batch.preview(user.id, filter({ articleNumberRanges: [{ from: "A-9" }] }));
    expect(open.rows.map((r) => r.articleNumber)).toEqual(["A-9", "B-1"]);
    // The whole register comes in that same byte order.
    const all = await batch.preview(user.id, filter());
    expect(all.rows.map((r) => r.articleNumber)).toEqual(["A-1", "A-10", "A-9", "B-1"]);
  });

  it("several ranges are a union (or), overlapping ranges list an article once, and an unbounded range lets everything in", async () => {
    const user = await makeUser();
    for (const n of ["A-1", "A-2", "A-3", "B-1", "B-2", "C-1"]) await makeProduct({ articleNumber: n });
    const numbers = async (ranges: { from?: string; to?: string }[]) =>
      (await batch.preview(user.id, filter({ articleNumberRanges: ranges }))).rows.map((r) => r.articleNumber);

    // Two disjoint ranges: the union, still in byte order over the whole list.
    expect(await numbers([{ from: "B-2", to: "C-1" }, { from: "A-1", to: "A-2" }])).toEqual(["A-1", "A-2", "B-2", "C-1"]);
    // Overlapping ranges: no duplicate rows.
    expect(await numbers([{ from: "A-2", to: "B-1" }, { from: "A-3", to: "B-2" }])).toEqual(["A-2", "A-3", "B-1", "B-2"]);
    // Open on one side each: up to A-2, and from C-1.
    expect(await numbers([{ to: "A-2" }, { from: "C-1" }])).toEqual(["A-1", "A-2", "C-1"]);
    // A range without bounds restricts nothing — or:ed with the rest, the
    // whole list stays in; so does an empty list of ranges.
    expect(await numbers([{ from: "B-1", to: "B-2" }, {}])).toEqual(["A-1", "A-2", "A-3", "B-1", "B-2", "C-1"]);
    expect(await numbers([])).toEqual(["A-1", "A-2", "A-3", "B-1", "B-2", "C-1"]);
    // The other filters apply on top of the union (and).
    const only = await batch.preview(user.id, filter({ articleNumberRanges: [{ to: "A-2" }, { from: "C-1" }], type: "purchased" }));
    expect(only.rows).toEqual([]);
  });

  it("filters on group, type, article code and active, and never takes a configurator template", async () => {
    const user = await makeUser();
    const group = await articleService.createArticleGroup(parsed(createArticleGroupSchema, { code: "9", name: "Grupp" }));
    const [code] = await db.insert(articleCodes).values({ code: "X", name: "Kod X" }).returning();
    const inGroup = await makeProduct({ articleNumber: "S-1", groupId: group.id });
    const withCode = await makeProduct({ articleNumber: "S-2", articleCodeId: code!.id });
    const purchased = await makeProduct({ articleNumber: "S-3", type: "purchased", standardCost: 10 });
    const inactive = await makeProduct({ articleNumber: "S-4", active: false });
    const template = await makeProduct({ articleNumber: "S-5" });
    await db.insert(configuratorTemplates).values({ articleId: template.id, mode: "variants" });

    const numbers = async (f: Parameters<typeof filter>[0]) => (await batch.preview(user.id, filter(f))).rows.map((r) => r.articleNumber);
    expect(await numbers({ groupId: group.id })).toEqual(["S-1"]);
    expect(await numbers({ articleCodeId: code!.id })).toEqual(["S-2"]);
    expect(await numbers({ type: "purchased" })).toEqual(["S-3"]);
    expect(await numbers({ type: "manufactured" })).toEqual(["S-1", "S-2"]);
    expect(await numbers({ activeOnly: false, type: "manufactured" })).toEqual(["S-1", "S-2", "S-4"]);
    // The purchased article is still calculated: no structure, TVK 0.
    const { rows } = await batch.preview(user.id, filter({ type: "purchased" }));
    expect(rows[0]).toMatchObject({ articleId: purchased.id, manufacturingCostPerUnit: 0, error: null });
    expect([inGroup.id, withCode.id, inactive.id, template.id]).toHaveLength(4);
  });

  it("copied = the user's Kopierat list in its order, templates dropped", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const a = await makeProduct({ articleNumber: "C-1" });
    const b = await makeProduct({ articleNumber: "C-2" });
    const c = await makeProduct({ articleNumber: "C-3" });
    const template = await makeProduct({ articleNumber: "C-4" });
    await db.insert(configuratorTemplates).values({ articleId: template.id, mode: "to_order" });
    await setCopiedArticles(db, user.id, [c.id, template.id, a.id], "add");
    await setCopiedArticles(db, other.id, [b.id], "add");

    const { rows } = await batch.preview(user.id, parsed(preCalculationBatchSchema, { selection: { copied: true }, fallbackQuantity: 1 }));
    expect(rows.map((r) => r.articleNumber)).toEqual(["C-3", "C-1"]);
    const empty = await batch.preview((await makeUser()).id, parsed(preCalculationBatchSchema, { selection: { copied: true }, fallbackQuantity: 1 }));
    expect(empty.rows).toEqual([]);
  });

  it("refuses more than PRE_CALCULATION_BATCH_MAX articles before calculating anything", async () => {
    const user = await makeUser();
    const unitId = await articleRepo.getOrCreateDefaultUnitId();
    await db.insert(articles).values(
      Array.from({ length: PRE_CALCULATION_BATCH_MAX + 1 }, (_, i) => ({
        articleNumber: `BULK-${String(i).padStart(4, "0")}`,
        name: `Bulk ${i}`,
        type: "purchased" as const,
        unitId,
      }))
    );
    let calls = 0;
    const counting = createPreCalculationBatchService({
      db,
      costing: withPreCalculate(async (...args) => {
        calls += 1;
        return realPreCalculate(...args);
      }),
      copied,
      log,
    });
    const err = await counting.preview(user.id, filter()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PreCalculationBatchTooLargeError);
    expect((err as PreCalculationBatchTooLargeError).count).toBe(PRE_CALCULATION_BATCH_MAX + 1);
    expect((err as PreCalculationBatchTooLargeError).max).toBe(PRE_CALCULATION_BATCH_MAX);
    expect(calls).toBe(0);
    // Exactly the cap is fine.
    await db.delete(articles).where(eq(articles.articleNumber, "BULK-0000"));
    const ok = await counting.preview(user.id, filter());
    expect(ok.rows).toHaveLength(PRE_CALCULATION_BATCH_MAX);
    expect(calls).toBe(PRE_CALCULATION_BATCH_MAX);
  });
});

describe("Förkalkylera flera — the preview", () => {
  it("gives TVK/st, SVK/st, pris/st, the current prices and the previous calculation's TVK/st with the change", async () => {
    const user = await makeUser();
    const product = await makeProduct({ articleNumber: "V-1", componentCost: 100, standardCost: 250, salesPrice: 400 });
    const { calculation: previous } = await costingService.preCalculate(product.id, 2, true);
    // The component now costs 110: TVK/st 330 against 300.
    const [component] = await db.select({ id: articles.id }).from(articles).where(eq(articles.articleNumber, `K-${seq}`));
    await articleService.updateStandardCost(component!.id, 110);

    const { rows } = await batch.preview(user.id, filter());
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      articleId: product.id,
      articleNumber: "V-1",
      name: "Produkt V-1",
      type: "manufactured",
      quantity: 2,
      quantitySource: "latest",
      manufacturingCostPerUnit: 330,
      selfCostPerUnit: 363, // + Affo 10 %
      salesPricePerUnit: 435.6, // + 20 % general markup on SVK
      previous: { calculationId: previous.id, calculatedAt: new Date(previous.calculatedAt).toISOString(), quantity: 2, manufacturingCostPerUnit: 300 },
      change: { amount: 30, percent: 10 },
      currentStandardCost: 250,
      currentSalesPrice: 400,
      warnings: [],
      error: null,
    });
  });

  it("change is null without a previous calculation and when the previous TVK/st is 0; missing prices are null", async () => {
    const user = await makeUser();
    const fresh = await makeProduct({ articleNumber: "N-1" });
    const zero = await makeProduct({ articleNumber: "N-2", componentCost: 0 });
    await costingService.preCalculate(zero.id, 1, true);
    const [component] = await db.select({ id: articles.id }).from(articles).where(eq(articles.articleNumber, `K-${seq}`));
    await articleService.updateStandardCost(component!.id, 5);

    const { rows } = await batch.preview(user.id, filter());
    expect(rows.map((r) => [r.articleNumber, r.previous?.manufacturingCostPerUnit ?? null, r.change, r.currentStandardCost, r.currentSalesPrice])).toEqual([
      ["N-1", null, null, null, null],
      ["N-2", 0, null, null, null],
    ]);
    expect(rows[0]!.previous).toBeNull();
    expect(rows[1]!.manufacturingCostPerUnit).toBe(15);
    expect(fresh.id).toBeTruthy();
  });

  it("reports one article's failure on its row and goes on with the rest; an unknown error is logged", async () => {
    const user = await makeUser();
    const ok = await makeProduct({ articleNumber: "E-1" });
    const missing = await makeProduct({ articleNumber: "E-2" });
    const broken = await makeProduct({ articleNumber: "E-3" });
    const failing = createPreCalculationBatchService({
      db,
      costing: withPreCalculate(async (articleId, ...rest) => {
        if (articleId === missing.id) throw new ArticleNotFoundError(missing.id);
        if (articleId === broken.id) throw new Error("boom");
        return realPreCalculate(articleId, ...rest);
      }),
      copied,
      log,
    });
    const { rows } = await failing.preview(user.id, filter());
    expect(rows.map((r) => [r.articleNumber, r.error, r.manufacturingCostPerUnit, r.change])).toEqual([
      ["E-1", null, 300, null],
      ["E-2", "Artikeln finns inte", null, null],
      ["E-3", "Kalkylen kunde inte beräknas", null, null],
    ]);
    expect(rows[1]!).toMatchObject({ articleId: missing.id, quantity: 1, quantitySource: "fallback", warnings: [] });
    expect(logged).toHaveLength(1);
    expect(logged[0]!.extra).toMatchObject({ articleId: broken.id, err: { message: "boom" } });
    expect(ok.id).toBeTruthy();
  });

  it("writes nothing", async () => {
    const user = await makeUser();
    const product = await makeProduct({ articleNumber: "W-1", standardCost: 1, salesPrice: 2 });
    await costingService.preCalculate(product.id, 3, true);
    const before = await calculationCount();
    const { rows } = await batch.preview(user.id, filter());
    expect(rows[0]!.manufacturingCostPerUnit).toBe(300);
    expect(await calculationCount()).toBe(before);
    expect(await article(product.id)).toMatchObject({ standardCost: "1.0000", salesPrice: "2.0000" });
  });
});

describe("Förkalkylera flera — the save", () => {
  it("saves a calculation per item and sets the prices exactly as the card's apply functions do", async () => {
    const viaBatch = await makeProduct({ articleNumber: "B-1", componentCost: 33.3333 });
    const viaCard = await makeProduct({ articleNumber: "B-2", componentCost: 33.3333 });
    const untouched = await makeProduct({ articleNumber: "B-3", standardCost: 1, salesPrice: 2 });

    const result = await batch.save(
      parsed(preCalculationBatchSaveSchema, {
        items: [
          { articleId: viaBatch.id, quantity: 7 },
          { articleId: untouched.id, quantity: 7 },
        ],
        setStandardCost: true,
        setSalesPrice: true,
      })
    );
    // The card's own path for B-2 at the same quantity.
    const { calculation } = await costingService.preCalculate(viaCard.id, 7, true);
    await costingService.applyStandardCostFromCalculation(calculation.id);
    await costingService.applySalesPriceFromCalculation(calculation.id, { mayApplyTrial: false });

    expect(result.errors).toEqual([]);
    expect(result.saved).toEqual([
      { articleId: viaBatch.id, articleNumber: "B-1", calculationId: expect.any(String), standardCostSet: true, salesPriceSet: true },
      { articleId: untouched.id, articleNumber: "B-3", calculationId: expect.any(String), standardCostSet: true, salesPriceSet: true },
    ]);
    const batched = await article(viaBatch.id);
    const carded = await article(viaCard.id);
    expect(batched.standardCost).toBe(carded.standardCost);
    expect(batched.salesPrice).toBe(carded.salesPrice);
    // 3 × 33.3333 = 99.9999 → TVK/st 99.9999, pris/st 99.9999 × 1.1 × 1.2 = 131.99987 → 131.9999
    expect(batched.standardCost).toBe("99.9999");
    expect(batched.salesPrice).toBe("131.9999");
    expect(await article(untouched.id)).toMatchObject({ standardCost: "300.0000", salesPrice: "396.0000" });
    const [saved] = await db.select().from(costCalculations).where(eq(costCalculations.id, result.saved[0]!.calculationId));
    expect(saved).toMatchObject({ articleId: viaBatch.id, type: "pre", quantity: "7.0000", multiLevel: false, generalMarkupLevel: "company" });
  });

  it("without the flags only saves; multiLevel is passed through", async () => {
    const product = await makeProduct({ articleNumber: "F-1", standardCost: 1, salesPrice: 2 });
    const seen: unknown[][] = [];
    const spying = createPreCalculationBatchService({
      db,
      costing: withPreCalculate(async (...args) => {
        seen.push(args);
        return realPreCalculate(...args);
      }),
      copied,
      log,
    });
    const result = await spying.save(parsed(preCalculationBatchSaveSchema, { items: [{ articleId: product.id, quantity: 4 }], multiLevel: true }));
    expect(result).toEqual({
      saved: [{ articleId: product.id, articleNumber: "F-1", calculationId: expect.any(String), standardCostSet: false, salesPriceSet: false }],
      errors: [],
    });
    expect(seen).toEqual([[product.id, 4, true, true, null]]);
    expect(await article(product.id)).toMatchObject({ standardCost: "1.0000", salesPrice: "2.0000" });
    const [saved] = await db.select().from(costCalculations).where(eq(costCalculations.id, result.saved[0]!.calculationId));
    expect(saved!.multiLevel).toBe(true);

    // The preview passes it through as well, without save.
    const user = await makeUser();
    seen.length = 0;
    await spying.preview(user.id, parsed(preCalculationBatchSchema, { selection: { activeOnly: true }, fallbackQuantity: 2, multiLevel: true }));
    expect(seen).toEqual([[product.id, 4, false, true, null]]);
  });

  it("never writes a price of 0: a purchased article without a structure has TVK/st 0 — warned in the preview, reported on save", async () => {
    const purchased = await makeProduct({ articleNumber: "Z-1", type: "purchased", standardCost: 80, salesPrice: 120 });
    const user = await makeUser();

    const preview = await batch.preview(user.id, filter({ type: "purchased" }));
    expect(preview.rows).toEqual([
      expect.objectContaining({ articleNumber: "Z-1", manufacturingCostPerUnit: 0, salesPricePerUnit: 0, warnings: [ZERO_COST_WARNING], error: null }),
    ]);

    const result = await batch.save(
      parsed(preCalculationBatchSaveSchema, { items: [{ articleId: purchased.id, quantity: 1 }], setStandardCost: true, setSalesPrice: true })
    );
    expect(result).toEqual({
      saved: [{ articleId: purchased.id, articleNumber: "Z-1", calculationId: expect.any(String), standardCostSet: false, salesPriceSet: false }],
      errors: [
        {
          articleId: purchased.id,
          articleNumber: "Z-1",
          message: "Kalkylen sparades men standardpriset sattes inte (TVK/st är 0) och försäljningspriset sattes inte (pris/st är 0)",
        },
      ],
    });
    // The calculation is saved; the prices are untouched.
    expect(await article(purchased.id)).toMatchObject({ standardCost: "80.0000", salesPrice: "120.0000" });
  });

  it("answers partial success honestly: a failed article, an unknown id, a template, and a saved calculation whose price step failed", async () => {
    const ok = await makeProduct({ articleNumber: "H-1" });
    const broken = await makeProduct({ articleNumber: "H-2" });
    const priceFails = await makeProduct({ articleNumber: "H-3", salesPrice: 50 });
    const template = await makeProduct({ articleNumber: "H-4" });
    await db.insert(configuratorTemplates).values({ articleId: template.id, mode: "variants" });
    const unknownId = crypto.randomUUID();
    const partial = createPreCalculationBatchService({
      db,
      costing: {
        ...withPreCalculate(async (articleId, ...rest) => {
          if (articleId === broken.id) throw new Error("boom");
          return realPreCalculate(articleId, ...rest);
        }),
        applySalesPriceFromCalculation: async (id: string, opts?: { mayApplyTrial?: boolean }) => {
          const [calc] = await db.select({ articleId: costCalculations.articleId }).from(costCalculations).where(eq(costCalculations.id, id));
          if (calc!.articleId === priceFails.id) throw new Error("price boom");
          return costingService.applySalesPriceFromCalculation(id, opts);
        },
      },
      copied,
      log,
    });
    const result = await partial.save(
      parsed(preCalculationBatchSaveSchema, {
        items: [
          { articleId: ok.id, quantity: 1 },
          { articleId: broken.id, quantity: 1 },
          { articleId: unknownId, quantity: 1 },
          { articleId: template.id, quantity: 1 },
          { articleId: priceFails.id, quantity: 1 },
        ],
        setStandardCost: true,
        setSalesPrice: true,
      })
    );
    expect(result.saved).toEqual([
      { articleId: ok.id, articleNumber: "H-1", calculationId: expect.any(String), standardCostSet: true, salesPriceSet: true },
      { articleId: priceFails.id, articleNumber: "H-3", calculationId: expect.any(String), standardCostSet: true, salesPriceSet: false },
    ]);
    expect(result.errors).toEqual([
      { articleId: broken.id, articleNumber: "H-2", message: "Kalkylen kunde inte beräknas" },
      { articleId: unknownId, articleNumber: null, message: "Artikeln finns inte" },
      { articleId: template.id, articleNumber: "H-4", message: "Konfiguratormallar förkalkyleras inte" },
      { articleId: priceFails.id, articleNumber: "H-3", message: "Kalkylen sparades men försäljningspriset sattes inte (priset kunde inte skrivas)" },
    ]);
    // H-3: the calculation and the standard cost are there, the sales price is as before.
    expect(await article(priceFails.id)).toMatchObject({ standardCost: "300.0000", salesPrice: "50.0000" });
    expect(await calculationCount()).toBe(2);
    expect(logged.map((l) => l.msg)).toEqual([
      `Förkalkylera flera: save failed for article ${broken.id}`,
      `Förkalkylera flera: apply-sales-price failed for article ${priceFails.id}`,
    ]);
  });
});
