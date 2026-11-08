import { createArticleSchema, createStockLocationSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, stockTransactions } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { parsed } from "./helpers/parsed.js";

// GET /stock/summary (Översikten): articles whose PHYSICAL balance summed over
// every place — blocked ones included — is above 0, counted in one query.

const articleService = createArticleService(createArticleRepository(db));
const stockRepo = createStockRepository(db);
const stockService = createStockService(stockRepo);

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, article_codes, articles CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeLocations(...names: string[]) {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const out = [];
  for (const name of names) {
    out.push((await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name, active: true })))!);
  }
  return out;
}

async function makeArticle() {
  return (await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `ART-SUM-${crypto.randomUUID()}`, name: "Artikel", type: "purchased", active: true })
  ))!;
}

async function move(articleId: string, locationId: string, delta: number, type: "inventory_adjustment" | "purchase_receipt" = "inventory_adjustment") {
  await db.insert(stockTransactions).values({ articleId, locationId, quantityDelta: String(delta), transactionType: type });
}

describe("stockService.getStockSummary", () => {
  it("is 0 on an empty log", async () => {
    expect(await stockService.getStockSummary()).toEqual({ articlesInStock: 0 });
  });

  it("counts an article once however many places hold it, and sums over the places", async () => {
    const [a1, b1] = await makeLocations("A1", "B1");
    const art = await makeArticle();
    await move(art.id, a1!.id, 5);
    await move(art.id, b1!.id, 3);
    expect(await stockService.getStockSummary()).toEqual({ articlesInStock: 1 });
  });

  it("counts goods on a blocked place (physical, not usable)", async () => {
    const [a1] = await makeLocations("A1");
    const art = await makeArticle();
    await move(art.id, a1!.id, 4);
    await stockService.blockLocation(a1!.id, null);
    expect(await stockService.getStockSummary()).toEqual({ articlesInStock: 1 });
  });

  it("does not count a balance netted out to 0 or a negative sum", async () => {
    const [a1, b1] = await makeLocations("A1", "B1");
    const zero = await makeArticle();
    const negative = await makeArticle();
    const spread = await makeArticle();
    await move(zero.id, a1!.id, 5);
    await move(zero.id, a1!.id, -5);
    await move(negative.id, a1!.id, -2);
    // +3 on one place, -3 on another nets to 0 over the places.
    await move(spread.id, a1!.id, 3);
    await move(spread.id, b1!.id, -3);
    expect(await stockService.getStockSummary()).toEqual({ articlesInStock: 0 });
    // A plus place outweighing a minus place counts.
    await move(negative.id, b1!.id, 10);
    expect(await stockService.getStockSummary()).toEqual({ articlesInStock: 1 });
  });

  it("an undone receipt (reversing row) takes the article out again", async () => {
    const [a1] = await makeLocations("A1");
    const art = await makeArticle();
    await move(art.id, a1!.id, 7, "purchase_receipt");
    expect(await stockService.getStockSummary()).toEqual({ articlesInStock: 1 });
    await move(art.id, a1!.id, -7, "purchase_receipt");
    expect(await stockService.getStockSummary()).toEqual({ articlesInStock: 0 });
  });
});
