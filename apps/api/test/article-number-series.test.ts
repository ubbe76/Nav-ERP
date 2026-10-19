import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, ne, sql } from "drizzle-orm";
import { articleGroups, db, numberSeries } from "@navet/db";
import { createArticleSchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService, InvalidReferenceError } from "../src/modules/article/service/article.service.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import {
  BuiltInNumberSeriesError,
  createSystemService,
  DuplicateNumberSeriesNameError,
} from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Artikelnummerserier (migration 0127). number_series is a shared,
// never-truncated table (see system.service.test.ts): every test puts the
// default series back and removes the series it created.
const articleService = createArticleService(createArticleRepository(db));
const systemService = createSystemService(createSystemRepository(db), createAuditRepository(db));

async function reset() {
  await db.execute(sql`TRUNCATE articles, article_groups CASCADE`);
  await db.delete(numberSeries).where(and(eq(numberSeries.forArticles, true), ne(numberSeries.key, "article")));
  await db.update(numberSeries).set({ prefix: "", nextNumber: 1001, digits: 0 }).where(eq(numberSeries.key, "article"));
}
beforeEach(reset);
afterAll(reset);

function create(fields: Record<string, unknown> = {}) {
  return articleService.createArticle(createArticleSchema.parse({ name: "Diskbänk", type: "purchased", ...fields }));
}

async function nextNumberOf(key: string) {
  const [row] = await db.select().from(numberSeries).where(eq(numberSeries.key, key));
  return row!.nextNumber;
}

describe("artikelnummerserier", () => {
  it("an article without a number gets the next one in the default series", async () => {
    expect((await create()).articleNumber).toBe("1001");
    expect((await create()).articleNumber).toBe("1002");
    expect(await nextNumberOf("article")).toBe(1003);
  });

  it("skips numbers already taken — imported or typed by hand", async () => {
    await create({ articleNumber: "1001" });
    await create({ articleNumber: "1002" });
    await create({ articleNumber: "1004" });
    const [preview] = await articleService.listArticleNumberSeries();
    expect(preview).toMatchObject({ key: "article", isDefault: true, nextArticleNumber: "1003" });

    expect((await create()).articleNumber).toBe("1003");
    expect((await create()).articleNumber).toBe("1005");
    expect(await nextNumberOf("article")).toBe(1006);
  });

  it("a typed number wins and leaves the series alone", async () => {
    expect((await create({ articleNumber: "X-1" })).articleNumber).toBe("X-1");
    expect(await nextNumberOf("article")).toBe(1001);
  });

  it("the group's own series numbers its articles; an explicit series overrides the group", async () => {
    const series = await systemService.createArticleNumberSeries({ name: "Plåt", prefix: "PL-", nextNumber: 1, digits: 3 });
    expect(series.forArticles).toBe(true);
    const group = await articleService.createArticleGroup({ code: "100", name: "Plåt", numberSeriesKey: series.key });

    expect((await create({ groupId: group.id })).articleNumber).toBe("PL-001");
    expect((await create({ groupId: group.id, numberSeriesKey: "article" })).articleNumber).toBe("1001");
    expect((await create({ groupId: group.id })).articleNumber).toBe("PL-002");

    const listed = await articleService.listArticleNumberSeries();
    expect(listed.map((s) => [s.name, s.nextArticleNumber])).toEqual([
      [null, "1002"],
      ["Plåt", "PL-003"],
    ]);
  });

  it("refuses a series that is not an article series, on the article and on the group", async () => {
    await expect(create({ numberSeriesKey: "customer" })).rejects.toThrow(InvalidReferenceError);
    await expect(create({ numberSeriesKey: "nope" })).rejects.toThrow(InvalidReferenceError);
    await expect(
      articleService.createArticleGroup({ code: "200", name: "Rör", numberSeriesKey: "sales_order" })
    ).rejects.toThrow(InvalidReferenceError);
  });

  it("concurrent creations never share a number", async () => {
    await create({ articleNumber: "1003" });
    const created = await Promise.all(Array.from({ length: 8 }, () => create()));
    const numbers = created.map((a) => a.articleNumber).sort();
    expect(new Set(numbers).size).toBe(8);
    expect(numbers).not.toContain("1003");
  });

  it("own series can be renamed and deleted (groups fall back to the default); built-in ones cannot", async () => {
    const series = await systemService.createArticleNumberSeries({ name: "Plåt", prefix: "PL-", nextNumber: 1, digits: 0 });
    await expect(systemService.createArticleNumberSeries({ name: "Plåt", prefix: "", nextNumber: 1, digits: 0 })).rejects.toThrow(
      DuplicateNumberSeriesNameError
    );
    const renamed = await systemService.updateNumberSeries(series.key, { name: "Plåtdetaljer" });
    expect(renamed.name).toBe("Plåtdetaljer");

    await expect(systemService.updateNumberSeries("article", { name: "Mina" })).rejects.toThrow(BuiltInNumberSeriesError);
    await expect(systemService.deleteNumberSeries("article")).rejects.toThrow(BuiltInNumberSeriesError);
    await expect(systemService.deleteNumberSeries("customer")).rejects.toThrow(BuiltInNumberSeriesError);

    const group = await articleService.createArticleGroup({ code: "100", name: "Plåt", numberSeriesKey: series.key });
    await systemService.deleteNumberSeries(series.key);
    const [after] = await db.select().from(articleGroups).where(eq(articleGroups.id, group.id));
    expect(after!.numberSeriesKey).toBeNull();
    expect((await create({ groupId: group.id })).articleNumber).toBe("1001");
  });
});
