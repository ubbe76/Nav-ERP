import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { costCalculations, db, manufacturingOrders } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { createReportsService } from "../src/modules/reports/service/reports.service.js";

// Kalkylutfall against the real save paths: the förkalkyl is saved the only
// way the costing module saves one (on the article, no MO) and the
// efterkalkyl on the order. The report used to join pre and post on the MO,
// so no order could ever be compared.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const costingService = createCostingService(createCostingRepository(db), {
  getSettings: async () => ({
    costingMaterialSource: "standard" as const,
    costingSupplierPriceTier: "base" as const,
    costingMoPercent: 0,
    costingLoPercent: 0,
    costingAffoPercent: 0,
    costingGeneralMarkupPercent: 0,
  }),
});
// The margin report's self-cost reader is not exercised here; the costing
// service is the real implementation app.ts wires.
const reportsService = createReportsService(createReportsRepository(db), costingService);

const TRUNCATE = sql`TRUNCATE cost_calculations, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// Parent with one component at standard cost 10, two per parent: the
// förkalkyl's material is 20/st. The order has nothing consumed yet, so its
// efterkalkyl is 0/st — a −100 % outcome, which is all this test needs.
async function makeOrder() {
  const user = await authRepo.create({
    email: `calc-outcome-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Kalkyl",
    role: "admin",
  });
  const parent = await articleService.createArticle({
    articleNumber: `PARENT-${crypto.randomUUID()}`,
    name: "Bänk",
    type: "manufactured",
    active: true,
  });
  const component = await articleService.createArticle({
    articleNumber: `COMP-${crypto.randomUUID()}`,
    name: "Skiva",
    type: "purchased",
    standardCost: 10,
    active: true,
  });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2 });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, user.id);
  return { parent, order };
}

describe("reports service — calculation outcome (Kalkylutfall)", () => {
  it("compares an order's efterkalkyl with the article's förkalkyl", async () => {
    const { parent, order } = await makeOrder();
    const { calculation: preCalc } = await costingService.preCalculate(parent.id, 5, true);
    expect(preCalc.manufacturingOrderId).toBeNull(); // the premise of the bug
    const { calculation: postCalc } = await costingService.postCalculate(order.id, true);

    const result = await reportsService.getCalculationOutcome({});

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.manufacturingOrderId).toBe(order.id);
    expect(row.orderNumber).toBe(order.orderNumber);
    expect(row.articleNumber).toBe(parent.articleNumber);
    expect(row.preTvkPerUnit).toBe(20);
    expect(row.postTvkPerUnit).toBe(0);
    expect(row.deltaPct).toBe(-100);
    expect(row.preCalculatedAt).toBe(new Date(preCalc.calculatedAt).toISOString());
    expect(row.postCalculatedAt).toBe(new Date(postCalc.calculatedAt).toISOString());
    expect(result.notComparable).toEqual({ onlyPost: 0, invalidQuantity: 0 });
  });

  it("does not use a förkalkyl saved after the efterkalkyl", async () => {
    const { parent, order } = await makeOrder();
    const { calculation: postCalc } = await costingService.postCalculate(order.id, true);
    const { calculation: preCalc } = await costingService.preCalculate(parent.id, 5, true);
    // Pin the order explicitly: the pre one second after the post.
    await db
      .update(costCalculations)
      .set({ calculatedAt: new Date(new Date(postCalc.calculatedAt).getTime() + 1000) })
      .where(eq(costCalculations.id, preCalc.id));

    const result = await reportsService.getCalculationOutcome({});

    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0 });
  });

  it("counts a beställningsvara's TO as not comparable instead of using the template's förkalkyl", async () => {
    const { parent, order } = await makeOrder();
    await costingService.preCalculate(parent.id, 5, true);
    await costingService.postCalculate(order.id, true);
    // Only the presence of the configuration matters to the report.
    await db
      .update(manufacturingOrders)
      .set({ configuration: { templateArticleId: parent.id, key: "k", selection: [], cost: { manufacturingCostPerUnit: 20, calculatedAt: new Date().toISOString() } } })
      .where(eq(manufacturingOrders.id, order.id));

    const result = await reportsService.getCalculationOutcome({});

    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0 });
  });
});
