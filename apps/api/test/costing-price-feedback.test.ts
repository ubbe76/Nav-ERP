import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articleStandardCostHistory, articles, db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import {
  CostCalculationNotFoundError,
  InvalidCalculationQuantityError,
  createCostingService,
} from "../src/modules/costing/service/costing.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Prisåterföring: writing a saved calculation's figures back onto the article.

const articleService = createArticleService(createArticleRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);

const costingSettings = {
  costingMaterialSource: "standard" as "standard" | "supplier" | "actual",
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 0,
  costingGeneralMarkupPercent: 0,
};
const costingService = createCostingService(
  createCostingRepository(db),
  { getSettings: async () => costingSettings },
  articleService
);

const TRUNCATE = sql`TRUNCATE cost_calculations, article_standard_cost_history, routing_operations, work_centers, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  Object.assign(costingSettings, {
    costingMaterialSource: "standard",
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 20,
  });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

let seq = 0;
const nextNumber = (p: string) => `${p}-${(seq += 1)}-${crypto.randomUUID().slice(0, 8)}`;

// Parent with 3 x a 100 kr component = 300 material per unit, no routing, no
// markups but a 20 % general markup → TVK 300/unit, sales price 360/unit.
async function makeCalculation(quantity: number) {
  const component = await articleService.createArticle({
    articleNumber: nextNumber("COMP"),
    name: "Komponent",
    type: "purchased",
    unit: "st",
    standardCost: 100,
    active: true,
  });
  const parent = await articleService.createArticle({
    articleNumber: nextNumber("PARENT"),
    name: "Slutprodukt",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 3 });
  const { calculation } = await costingService.preCalculate(parent.id, quantity, true);
  return { parent, calculation };
}

const historyFor = (articleId: string) =>
  db.select().from(articleStandardCostHistory).where(eq(articleStandardCostHistory.articleId, articleId));

const readArticle = async (id: string) => (await db.select().from(articles).where(eq(articles.id, id)))[0]!;

describe("Sätt standardpris", () => {
  it("writes the calculation's TVK per unit and logs one history row", async () => {
    const { parent, calculation } = await makeCalculation(10);

    await costingService.applyStandardCostFromCalculation(calculation.id);

    // TVK is 3000 for 10 units — the 20 % general markup is NOT part of it.
    expect(Number((await readArticle(parent.id)).standardCost)).toBe(300);
    expect(await historyFor(parent.id)).toHaveLength(1);
  });

  it("does not append a second history row when applied twice", async () => {
    // updateStandardCost decides whether to log by comparing
    // Number(previousCost) — a 4-decimal string from Postgres — against the new
    // value. Without rounding before the call, an unrounded float would always
    // compare as changed and every click would append a duplicate row.
    const { parent, calculation } = await makeCalculation(3); // 900 / 3 = 300 exactly

    await costingService.applyStandardCostFromCalculation(calculation.id);
    await costingService.applyStandardCostFromCalculation(calculation.id);

    expect(await historyFor(parent.id)).toHaveLength(1);
  });

  it("does not append a second history row when the per-unit cost does not terminate", async () => {
    // The real shape of the trap: 100 minutes of setup at 100 kr/h is
    // 166,6667 kr for the batch, and over 3 units that is 55,55556666… — a
    // figure Postgres stores as 55.5556. updateStandardCost then compares
    // Number("55.5556") against whatever it is handed, so passing the
    // unrounded float would report "changed" forever and append a duplicate
    // history row on every single click.
    const parent = await articleService.createArticle({
      articleNumber: nextNumber("PARENT"),
      name: "Slutprodukt",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const wc = await mfgService.createWorkCenter({
      code: String(300 + (seq % 600)),
      name: nextNumber("Resurs"),
      hourlyRate: 100,
      overheadPercent: 0,
      active: true,
    });
    await mfgService.createRoutingOperation(parent.id, {
      sequenceNo: 10,
      workCenterId: wc.id,
      setupTime: 100,
      runTimePerUnit: 0,
    });
    const { calculation } = await costingService.preCalculate(parent.id, 3, true);

    await costingService.applyStandardCostFromCalculation(calculation.id);
    const afterFirst = await historyFor(parent.id);
    expect(afterFirst).toHaveLength(1);
    expect(Number((await readArticle(parent.id)).standardCost)).toBeCloseTo(55.5556, 4);

    await costingService.applyStandardCostFromCalculation(calculation.id);
    expect(await historyFor(parent.id)).toHaveLength(1);
  });

  it("includes the halvfabrikat bucket, so a multi-level calculation sets the right cost", async () => {
    const raw = await articleService.createArticle({
      articleNumber: nextNumber("RAW"),
      name: "Ramaterial",
      type: "purchased",
      unit: "st",
      standardCost: 50,
      active: true,
    });
    const semi = await articleService.createArticle({
      articleNumber: nextNumber("SEMI"),
      name: "Underrede",
      type: "manufactured",
      unit: "st",
      standardCost: 999,
      active: true,
    });
    const top = await articleService.createArticle({
      articleNumber: nextNumber("TOP"),
      name: "Slutprodukt",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    await articleService.addBomComponent(semi.id, { componentArticleId: raw.id, quantity: 2 });
    await articleService.addBomComponent(top.id, { componentArticleId: semi.id, quantity: 1 });

    const { calculation } = await costingService.preCalculate(top.id, 5, true, true);
    await costingService.applyStandardCostFromCalculation(calculation.id);

    // 5 x 1 semi x 2 raw x 50 = 500, over 5 units = 100/unit. Proves the
    // figure came from cost-figures.ts and not from a hand-rolled sum that
    // forgot the new bucket.
    expect(Number((await readArticle(top.id)).standardCost)).toBe(100);
  });

  it("refuses an unknown calculation", async () => {
    await expect(costingService.applyStandardCostFromCalculation(crypto.randomUUID())).rejects.toBeInstanceOf(
      CostCalculationNotFoundError
    );
  });
});

describe("Sätt försäljningspris", () => {
  it("writes the calculation's sales price per unit", async () => {
    const { parent, calculation } = await makeCalculation(10);

    await costingService.applySalesPriceFromCalculation(calculation.id);

    // TVK 300/unit + 20 % general markup = 360.
    expect(Number((await readArticle(parent.id)).salesPrice)).toBe(360);
    // The standard cost is untouched — the two buttons are independent.
    expect((await readArticle(parent.id)).standardCost).toBeNull();
  });

  it("refuses an unknown calculation", async () => {
    await expect(costingService.applySalesPriceFromCalculation(crypto.randomUUID())).rejects.toBeInstanceOf(
      CostCalculationNotFoundError
    );
  });
});

describe("prisåterföring med oanvändbart antal", () => {
  it("writes nothing when the quantity cannot carry a per-unit figure", async () => {
    const { parent, calculation } = await makeCalculation(5);
    // preCalculate refuses a non-positive quantity, so the degenerate row is
    // forced directly — the guard exists for calculations that predate it or
    // arrive some other way.
    await db.execute(sql`UPDATE cost_calculations SET quantity = 0 WHERE id = ${calculation.id}`);

    await expect(costingService.applyStandardCostFromCalculation(calculation.id)).rejects.toBeInstanceOf(
      InvalidCalculationQuantityError
    );
    expect((await readArticle(parent.id)).standardCost).toBeNull();
  });
});
