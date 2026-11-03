import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { deliverBatchSchema, listStockBalancesQuerySchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { stockRoutes } from "../src/modules/stock/routes/stock.routes.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

// Fasta lagerplatser (0179) on the location routes, and the balances read
// the Utleverans page uses for its per-row location pickers.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

function buildApp() {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: unknown }).user = { id: crypto.randomUUID(), role: "admin", permissions: [] };
  });
  app.register(stockRoutes, { service: stockService, valuation: {} as never, counts: {} as never });
  return app;
}

describe("/stock/locations — fixed", () => {
  it("creates a fixed location by default, honours fixed: false, lists and patches the flag", async () => {
    const app = buildApp();
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });

    const fixed = await app.inject({ method: "POST", url: "/stock/locations", payload: { warehouseId: warehouse.id, name: "A1" } });
    expect(fixed.statusCode).toBe(201);
    expect(fixed.json()).toMatchObject({ name: "A1", active: true, fixed: true });

    const temporary = await app.inject({
      method: "POST",
      url: "/stock/locations",
      payload: { warehouseId: warehouse.id, name: "TMP", fixed: false },
    });
    expect(temporary.json()).toMatchObject({ name: "TMP", fixed: false });

    const list = await app.inject({ method: "GET", url: "/stock/locations" });
    expect(list.json().map((l: { name: string; fixed: boolean }) => [l.name, l.fixed])).toEqual([
      ["A1", true],
      ["TMP", false],
    ]);

    const patched = await app.inject({ method: "PATCH", url: `/stock/locations/${fixed.json().id}`, payload: { fixed: false } });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id: fixed.json().id, fixed: false, active: true });
  });
});

describe("GET /stock/balances?articleIds=", () => {
  it("answers with every listed article's locations and balances in one call", async () => {
    const app = buildApp();
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const a1 = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    const b2 = await stockService.createLocation({ warehouseId: warehouse.id, name: "B2", active: true });
    const make = (n: string) => articleService.createArticle({ articleNumber: n, name: n, type: "purchased", unit: "st", active: true });
    const [x, y, z] = [await make("X-1"), await make("Y-1"), await make("Z-1")];
    const stock = (articleId: string, locationId: string, quantityDelta: number) =>
      stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment" });
    await stock(x.id, a1.id, 5);
    await stock(x.id, b2.id, 7);
    await stock(y.id, b2.id, 3);
    await stock(z.id, a1.id, 9);

    const res = await app.inject({ method: "GET", url: `/stock/balances?articleIds=${x.id},${y.id}&limit=1000` });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(3);
    expect(
      res.json().rows.map((r: { articleNumber: string; locationId: string; warehouseName: string; locationName: string; quantityOnHand: string }) => [
        r.articleNumber,
        r.locationId,
        r.warehouseName,
        r.locationName,
        r.quantityOnHand,
      ])
    ).toEqual([
      ["X-1", a1.id, "Huvudlager", "A1", "5.0000"],
      ["X-1", b2.id, "Huvudlager", "B2", "7.0000"],
      ["Y-1", b2.id, "Huvudlager", "B2", "3.0000"],
    ]);
    // The balance is in the base unit, so Utleverans can print it.
    expect(res.json().rows.every((r: { unitCode: string }) => r.unitCode === "st")).toBe(true);
  });

  it("validates the list: uuids only, at most 200, empty = no filter", () => {
    expect(listStockBalancesQuerySchema.safeParse({ articleIds: "nope" }).success).toBe(false);
    expect(listStockBalancesQuerySchema.parse({}).articleIds).toBeUndefined();
    const id = "11111111-1111-4111-8111-111111111111";
    expect(listStockBalancesQuerySchema.parse({ articleIds: `${id}, ${id}` }).articleIds).toEqual([id, id]);
    expect(listStockBalancesQuerySchema.safeParse({ articleIds: Array(201).fill(id).join(",") }).success).toBe(false);
  });
});

describe("deliverBatchSchema — rows[].locationId", () => {
  it("keeps a row's own location and leaves it out when not sent", () => {
    const rowId = "22222222-2222-4222-8222-222222222222";
    const locationId = "33333333-3333-4333-8333-333333333333";
    const parsed = deliverBatchSchema.parse({ rows: [{ rowId, quantity: "2", locationId }, { rowId, quantity: 1 }] });
    expect(parsed).toEqual({ rows: [{ rowId, quantity: 2, locationId }, { rowId, quantity: 1 }] });
    expect(deliverBatchSchema.safeParse({ rows: [{ rowId, quantity: 1, locationId: "x" }] }).success).toBe(false);
  });
});
