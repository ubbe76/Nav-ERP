import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createCostingRepository } from "../src/modules/costing/repository/costing.repository.js";
import { createCostingService } from "../src/modules/costing/service/costing.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";

// Verklig kostnad end to end: real stock_transactions, a real manufacturing
// order, and the moving average derived from the log rather than read off the
// article. The unit tests next door pin the arithmetic; these pin the wiring.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService);
const authRepo = createAuthRepository(db);

const costingSettings = {
  costingMaterialSource: "actual" as "standard" | "supplier" | "actual",
  costingMoPercent: 0,
  costingLoPercent: 0,
  costingAffoPercent: 0,
  costingGeneralMarkupPercent: 0,
};
const costingService = createCostingService(createCostingRepository(db), {
  getSettings: async () => costingSettings,
});

const TRUNCATE = sql`TRUNCATE cost_calculations, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  Object.assign(costingSettings, { costingMaterialSource: "actual" });
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

let seq = 0;
const nextNumber = (p: string) => `${p}-${(seq += 1)}-${crypto.randomUUID().slice(0, 8)}`;

// Builds: a parent needing 1 component per unit, stock received at two
// different prices, and an order that consumed 4 of them.
async function makeOrderConsumingAt(prices: number[], consumeQuantity: number, standardCostAfter?: number) {
  const user = await authRepo.create({
    email: `actual-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Cost Clerk",
    role: "admin",
  });
  const component = await articleService.createArticle({
    articleNumber: nextNumber("COMP"),
    name: "Komponent",
    type: "purchased",
    unit: "st",
    active: true,
  });
  const parent = await articleService.createArticle({
    articleNumber: nextNumber("PARENT"),
    name: "Slutprodukt",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 1 });

  const warehouse = await stockService.createWarehouse({ name: nextNumber("Lager"), active: true });
  const location = await stockService.createLocation({ warehouseId: warehouse.id, name: nextNumber("A"), active: true });

  // createTransaction stamps unit_cost from the article's CURRENT standard
  // cost on an inflow, so moving the standard cost between receipts is how a
  // real two-price history is built. An empty price list receives the same
  // stock with NO standard cost set, which is how unit_cost lands as null.
  if (prices.length === 0) {
    await stockService.recordTransaction({
      articleId: component.id,
      locationId: location.id,
      quantityDelta: 10,
      transactionType: "inventory_adjustment",
    });
  }
  for (const price of prices) {
    await articleService.updateStandardCost(component.id, price);
    await stockService.recordTransaction({
      articleId: component.id,
      locationId: location.id,
      quantityDelta: 10,
      transactionType: "inventory_adjustment",
    });
  }
  if (standardCostAfter !== undefined) await articleService.updateStandardCost(component.id, standardCostAfter);

  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 10 }, user.id);
  await mfgService.start(order.id);
  const [materialRow] = await mfgService.listMaterialConsumptions(order.id);
  await mfgService.consumeMaterial(order.id, materialRow!.id, { locationId: location.id, quantity: consumeQuantity }, user.id);

  return { order, component, parent };
}

describe("efterkalkyl med Verklig kostnad", () => {
  it("prices consumed material at the moving average, not at the article's current standard cost", async () => {
    // 10 @ 100 and 10 @ 200 → 150. The standard cost is then moved to 999 to
    // prove the calculation does not read it.
    const { order } = await makeOrderConsumingAt([100, 200], 4, 999);

    const { calculation } = await costingService.postCalculate(order.id);

    expect(Number(calculation.materialCost)).toBeCloseTo(600, 4); // 4 x 150
    expect(calculation.materialSource).toBe("actual");
  });

  it("records the price source on the saved specification row", async () => {
    const { order } = await makeOrderConsumingAt([100, 200], 4);

    const { calculation } = await costingService.postCalculate(order.id, true);
    const detail = await costingService.getCostCalculation(calculation.id);

    expect(detail!.materialRows).toHaveLength(1);
    expect(detail!.materialRows[0]!.priceSource).toBe("moving_average");
    expect(Number(detail!.materialRows[0]!.unitCost)).toBeCloseTo(150, 4);
  });

  it("falls back to the standard cost, with a warning, for material drawn before any priced receipt", async () => {
    // The component has no standard cost when the stock arrives, so D0 stamps
    // unit_cost null and there is no average to derive. Giving it a standard
    // cost afterwards is what the fallback then reads.
    const { order, component } = await makeOrderConsumingAt([], 4);
    await articleService.updateStandardCost(component.id, 42);

    const { calculation, warnings } = await costingService.postCalculate(order.id);

    expect(Number(calculation.materialCost)).toBe(168); // 4 x 42
    expect(warnings).toContain("Komponent: ingen verklig kostnad vid förbrukningen, använder standardpris");
  });
});

describe("förkalkyl med Verklig kostnad", () => {
  it("uses the standard cost and says so, while still snapshotting the configured source", async () => {
    const component = await articleService.createArticle({
      articleNumber: nextNumber("COMP"),
      name: "Komponent",
      type: "purchased",
      unit: "st",
      standardCost: 25,
      active: true,
    });
    const parent = await articleService.createArticle({
      articleNumber: nextNumber("PARENT"),
      name: "Slutprodukt",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    await articleService.addBomComponent(parent.id, { componentArticleId: component.id, quantity: 2 });

    const { calculation, warnings } = await costingService.preCalculate(parent.id, 3);

    expect(Number(calculation.materialCost)).toBe(150); // 3 x 2 x 25
    // The column records what it was told to read from; the row records what
    // it actually used, so the specification can show the fallback.
    expect(calculation.materialSource).toBe("actual");
    expect(warnings).toContain("Verklig kostnad gäller bara efterkalkylen — förkalkylen använder standardpris");
  });
});
