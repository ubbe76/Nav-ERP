import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db, units } from "@navet/db";
import { batchUpdateArticlesSchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createConfiguratorService } from "../src/modules/configurator/service/configurator.service.js";
import { testCostingService, variantTestDeps } from "./helpers/configurator.js";

const repo = createArticleRepository(db);
const service = createArticleService(repo);
const configurator = createConfiguratorService({
  db,
  prices: async () => ({ articleNumber: "X", price: { unitPrice: 1, discountPercent: 0, source: "customer_article" } }),
  customerExists: async () => true,
  articles: {
    exists: async (id) => (await service.getArticle(id)) != null,
    isDescendant: (a, b) => service.isDescendant(a, b),
    find: (id) => service.getArticle(id),
  },
  costing: testCostingService,
  ...variantTestDeps,
});

const RESET = sql`TRUNCATE configurator_rules, configurator_values, configurator_groups, configurator_templates, article_units, bom_components, stock_transactions, articles, article_groups, units CASCADE`;
let stId: string;
let kgId: string;
beforeEach(async () => {
  await db.execute(RESET);
  const rows = await db.insert(units).values([{ code: "st", name: "Styck" }, { code: "kg", name: "Kilogram" }]).returning();
  stId = rows.find((r) => r.code === "st")!.id;
  kgId = rows.find((r) => r.code === "kg")!.id;
});
afterAll(async () => {
  await db.execute(RESET);
});

const make = (n: string, extra: Record<string, unknown> = {}) =>
  service.createArticle({ articleNumber: n, name: `Namn ${n}`, type: "manufactured", unitId: stId, ...extra } as never);

describe("updateArticlesBatch", () => {
  it("saves ok rows, reports failed rows by code, keeps request order and leaves failures untouched", async () => {
    const plain = await make("B-1");
    const template = await make("B-2");
    await configurator.createTemplate(template.id, { mode: "to_order" });
    const withUnits = await make("B-3");
    await service.addArticleUnit(withUnits.id, { unitId: kgId, quantityPerBase: 5 });
    const unknownGroup = await make("B-4");
    const missing = crypto.randomUUID();

    const { results } = await service.updateArticlesBatch([
      { id: plain.id, name: "Nytt namn", type: "purchased" },
      { id: template.id, type: "purchased" },
      { id: withUnits.id, unitId: kgId },
      { id: unknownGroup.id, groupId: crypto.randomUUID() },
      { id: missing, name: "x" },
    ]);

    expect(results.map((r) => r.id)).toEqual([plain.id, template.id, withUnits.id, unknownGroup.id, missing]);
    expect(results[0]).toMatchObject({ ok: true, article: { name: "Nytt namn", type: "purchased", articleNumber: "B-1" } });
    expect(results.slice(1).map((r) => (r.ok ? "ok" : r.error.code))).toEqual([
      "configurator-mode-not-allowed",
      "base-unit-locked",
      "invalid-reference",
      "article-not-found",
    ]);
    expect((await service.getArticle(plain.id))!.name).toBe("Nytt namn");
    expect((await service.getArticle(template.id))!.type).toBe("manufactured");
    expect((await service.getArticle(withUnits.id))!.unitId).toBe(stId);
    expect((await service.getArticle(unknownGroup.id))!.groupId).toBeNull();
  });

  it("changes only the given fields", async () => {
    const a = await make("B-5", { salesPrice: 12 });
    await service.updateArticlesBatch([{ id: a.id, name: "Bara namn" }]);
    const after = (await service.getArticle(a.id))!;
    expect(after).toMatchObject({ name: "Bara namn", type: "manufactured", articleNumber: "B-5", unitId: stId });
    expect(Number(after.salesPrice)).toBe(12);
  });
});

describe("updateArticlesBatch unexpected errors", () => {
  it("reports an unknown error as unexpected, hides its message and still saves the other rows", async () => {
    const a = await make("B-6");
    const b = await make("B-7");
    const spy = vi.spyOn(repo, "update").mockRejectedValueOnce(Object.assign(new Error("secret db detail"), { name: "WeirdInternalError" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { results } = await service.updateArticlesBatch([{ id: a.id, name: "Ny A" }, { id: b.id, name: "Ny B" }]);
    spy.mockRestore();
    log.mockRestore();
    expect(results[0]).toEqual({ id: a.id, ok: false, error: { code: "unexpected", message: "Kunde inte spara raden" } });
    expect(results[1]).toMatchObject({ ok: true, article: { name: "Ny B" } });
  });
});

describe("batchUpdateArticlesSchema", () => {
  const id = crypto.randomUUID();
  it("accepts 1-500 rows with at least one field each", () => {
    expect(batchUpdateArticlesSchema.safeParse({ rows: [{ id, groupId: null }] }).success).toBe(true);
    expect(batchUpdateArticlesSchema.safeParse({ rows: Array.from({ length: 500 }, () => ({ id, name: "x" })) }).success).toBe(true);
  });
  it("rejects 501 rows, none, empty patches and fields outside the inline set", () => {
    expect(batchUpdateArticlesSchema.safeParse({ rows: Array.from({ length: 501 }, () => ({ id, name: "x" })) }).success).toBe(false);
    expect(batchUpdateArticlesSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(batchUpdateArticlesSchema.safeParse({ rows: [{ id }] }).success).toBe(false);
    expect(batchUpdateArticlesSchema.safeParse({ rows: [{ id, articleNumber: "X" }] }).success).toBe(false);
    expect(batchUpdateArticlesSchema.safeParse({ rows: [{ id, name: "" }] }).success).toBe(false);
  });
});
