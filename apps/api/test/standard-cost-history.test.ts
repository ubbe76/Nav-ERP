import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { articleStandardCostHistory, db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";

// Repository-level coverage for article_standard_cost_history (D1): the
// table is written by exactly three call sites — article create,
// updateStandardCost and CSV import (create + update) — and only when the
// value actually changes. Called against the real repositories/test
// database, mirroring stock-unit-cost.test.ts's style.

const articleRepo = createArticleRepository(db);
const articleService = createArticleService(articleRepo);
const importRepo = createImportRepository(db);
const importService = createImportService(importRepo);

const TRUNCATE = sql`TRUNCATE stock_transactions, article_standard_cost_history, bom_components, articles, article_groups CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticle(articleNumber: string, standardCost?: number) {
  return articleService.createArticle({
    articleNumber,
    name: articleNumber,
    type: "purchased",
    isPhantom: false,
    active: true,
    ...(standardCost !== undefined ? { standardCost } : {}),
  });
}

async function historyFor(articleId: string) {
  return db
    .select()
    .from(articleStandardCostHistory)
    .where(eq(articleStandardCostHistory.articleId, articleId))
    .orderBy(asc(articleStandardCostHistory.validFrom));
}

describe("createArticle — article_standard_cost_history", () => {
  it("writes exactly one history row with the given cost when a standard cost is provided", async () => {
    const article = await makeArticle("STD-1", 42.5);

    const rows = await historyFor(article!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost).toBe("42.5000");
    // No user id is threaded through the article create call chain (article
    // routes never pass req.user through to createArticle/repo.create) —
    // createdBy stays null.
    expect(rows[0]?.createdBy).toBeNull();
  });

  it("writes no history row when no standard cost is given", async () => {
    const article = await makeArticle("STD-2");

    const rows = await historyFor(article!.id);
    expect(rows).toHaveLength(0);
  });
});

describe("updateStandardCost — article_standard_cost_history", () => {
  it("writes a row when the new value differs from the current one", async () => {
    const article = await makeArticle("STD-3", 10);
    expect(await historyFor(article!.id)).toHaveLength(1); // baseline from create

    await articleService.updateStandardCost(article!.id, 20);

    const rows = await historyFor(article!.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.cost).toBe("20.0000");
  });

  it("writes no row when the new value equals the current one", async () => {
    const article = await makeArticle("STD-4", 10);
    expect(await historyFor(article!.id)).toHaveLength(1); // baseline from create

    await articleService.updateStandardCost(article!.id, 10);

    expect(await historyFor(article!.id)).toHaveLength(1); // unchanged
  });

  it("writes a row when the article previously had no standard cost", async () => {
    const article = await makeArticle("STD-5"); // no cost at creation
    expect(await historyFor(article!.id)).toHaveLength(0);

    await articleService.updateStandardCost(article!.id, 15);

    const rows = await historyFor(article!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost).toBe("15.0000");
  });

  it("two successive changes are retrievable in valid_from order", async () => {
    const article = await makeArticle("STD-6"); // no baseline row

    await articleService.updateStandardCost(article!.id, 10);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await articleService.updateStandardCost(article!.id, 20);

    const rows = await historyFor(article!.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.cost).toBe("10.0000");
    expect(rows[1]?.cost).toBe("20.0000");
    expect(rows[0]!.validFrom.getTime()).toBeLessThanOrEqual(rows[1]!.validFrom.getTime());
  });
});

describe("CSV import — article_standard_cost_history", () => {
  const mapping = { Artikelnummer: "articleNumber", Benämning: "name", Standardpris: "standardCost" };

  it("writes history rows for created articles that carry a standard cost, none for those without", async () => {
    const result = await importService.commit("articles", {
      mapping,
      rows: [
        ["IMP-1", "Med pris", "12,50"],
        ["IMP-2", "Utan pris", ""],
      ],
    });
    expect(result.created).toBe(2);

    const created = await importRepo.articlesByNumber(["IMP-1", "IMP-2"]);
    const withCost = await historyFor(created.get("IMP-1")!.id);
    expect(withCost).toHaveLength(1);
    expect(withCost[0]?.cost).toBe("12.5000");

    const withoutCost = await historyFor(created.get("IMP-2")!.id);
    expect(withoutCost).toHaveLength(0);
  });

  it("writes exactly one row when an import sets an article's cost, and none when the same file is re-imported", async () => {
    const existing = await makeArticle("IMP-3"); // no standard cost yet
    const input = { mapping, rows: [["IMP-3", "Uppdaterad", "77,00"]] };

    await importService.commit("articles", input);
    let rows = await historyFor(existing!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cost).toBe("77.0000");

    // Re-importing the identical file: the planner stages no standardCost
    // patch at all since the value hasn't changed — no new row.
    await importService.commit("articles", input);
    rows = await historyFor(existing!.id);
    expect(rows).toHaveLength(1);
  });

  it("writes a new row when an import changes an already-set cost, on top of the create-time baseline", async () => {
    const existing = await makeArticle("IMP-4", 50); // baseline row from create
    expect(await historyFor(existing!.id)).toHaveLength(1);

    await importService.commit("articles", {
      mapping,
      rows: [["IMP-4", "Ny kostnad", "60,00"]],
    });

    const rows = await historyFor(existing!.id);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.cost).toBe("60.0000");
  });
});

// The D1 migration's backfill (one history row per article that already had
// a standard cost) is a migration-only, one-time INSERT ... SELECT — it runs
// once when the migration is applied and is never re-run by application
// code. There is no boot-time or request-time code path anywhere in
// apps/api that re-inserts backfill rows; the three writers above (create,
// updateStandardCost, CSV import) are the only application-code writers of
// this table, and all three only fire on an actual value change. Nothing to
// assert at the vitest level beyond that — confirmed by inspection of the
// call sites (grep for articleStandardCostHistory / recordStandardCostHistory
// across apps/api/src turns up only the three writer sites and this file).
