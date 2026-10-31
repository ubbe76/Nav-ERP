import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createCostingRepository, type MaterialRowWrite } from "../src/modules/costing/repository/costing.repository.js";

// The specification rows are written in ONE multi-row INSERT, so a
// now()-default would give every row the same created_at and the
// ORDER BY created_at read would return them in whatever order the planner
// visits them. The repository stamps them a millisecond apart instead.

const articleService = createArticleService(createArticleRepository(db));
const repo = createCostingRepository(db);

const TRUNCATE = sql`TRUNCATE cost_calculations, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticle(name: string, type: "manufactured" | "purchased") {
  return articleService.createArticle({
    articleNumber: `${name}-${crypto.randomUUID().slice(0, 8)}`,
    name,
    type,
    unit: "st",
    active: true,
  });
}

function materialRow(componentArticleId: string, amount: number): MaterialRowWrite {
  return {
    componentArticleId,
    kind: "material",
    quantity: 1,
    unitId: null,
    unitFactor: null,
    unitCost: amount,
    priceSource: "standard",
    amount,
    overheadAmount: 0,
    materialMarkupAmount: 0,
    supplierCurrency: null,
    supplierUnitPrice: null,
    exchangeRate: null,
    priceDate: null,
  };
}

describe("kalkylens specifikationsrader", () => {
  it("are read back in the order they were written", async () => {
    const top = await makeArticle("Slutprodukt", "manufactured");
    // Deliberately not sorted by name, number or id — only the input order
    // can explain the read order.
    const components = [];
    for (const name of ["K", "C", "X", "A", "M", "B", "Z", "D", "Q", "E", "Y", "F"]) {
      components.push(await makeArticle(name, "purchased"));
    }

    const saved = await repo.createCostCalculation(
      {
        articleId: top.id,
        manufacturingOrderId: null,
        quantity: 1,
        materialCost: 0,
        materialOverhead: 0,
        laborCost: 0,
        overhead: 0,
        subcontractCost: 0,
        subcontractOverhead: 0,
        semiFinishedCost: 0,
        businessOverhead: 0,
        generalMarkup: 0,
        materialMarkup: 0,
        salesPrice: 0,
        materialSource: "standard",
        multiLevel: false,
        moPercent: 0,
        loPercent: 0,
        affoPercent: 0,
        generalMarkupPercent: 0,
        materialMarkupPercent: 0,
        type: "pre",
      },
      components.map((c, i) => materialRow(c.id, i + 1)),
      []
    );

    const rows = await repo.listMaterialRows(saved.id);
    expect(rows.map((r) => r.componentArticleId)).toEqual(components.map((c) => c.id));
    // Every row has its own timestamp — no tie left for the planner to break.
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(rows.length);
  });
});
