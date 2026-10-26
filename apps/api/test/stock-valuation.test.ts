import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { articleCodes, articleStandardCostHistory, db, stockTransactions } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createValuationService } from "../src/modules/stock/service/valuation.service.js";
import { testDocumentPdfService } from "./helpers/services.js";
import { pdfText } from "./helpers/pdf.js";

// Service-level coverage for the lagervärdering report (D1): quantity comes
// from stock_transactions (already historical, arkitekturprincip 1); the
// price comes from one of three sources depending on method. Fixtures write
// directly into stock_transactions/article_standard_cost_history with
// explicit created_at/valid_from timestamps (rather than going through
// receiveGoods/updateStandardCost, whose timestamps default to "now") so
// each test can freely place events before/after an arbitrary asOf without
// racing the real clock — mirrors moving-average.test.ts's fabricated rows.

const articleService = createArticleService(createArticleRepository(db));
const stockRepo = createStockRepository(db);
const stockService = createStockService(stockRepo);
const valuationService = createValuationService({ db, pdf: testDocumentPdfService });

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, mo_material_consumptions, manufacturing_orders, bom_components, article_standard_cost_history, article_groups, article_codes, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name, active: true });
}

async function makeArticle(opts: { groupId?: string } = {}) {
  return articleService.createArticle({
    articleNumber: `ART-VAL-${crypto.randomUUID()}`,
    name: "Test Article",
    type: "purchased",
    active: true,
    ...(opts.groupId ? { groupId: opts.groupId } : {}),
  });
}

// Writes a stock_transactions row with an explicit created_at, bypassing the
// repository writers (whose timestamps always default to now()) so the
// fixture can place a movement on any calendar day.
async function insertTransaction(row: {
  articleId: string;
  locationId: string;
  quantityDelta: number;
  unitCost?: number | null;
  transactionType?: "purchase_receipt" | "sales_delivery" | "inventory_adjustment" | "mo_receipt";
  createdAt: Date;
}) {
  const [tx] = await db
    .insert(stockTransactions)
    .values({
      articleId: row.articleId,
      locationId: row.locationId,
      quantityDelta: String(row.quantityDelta),
      unitCost: row.unitCost != null ? String(row.unitCost) : null,
      transactionType: row.transactionType ?? "inventory_adjustment",
      createdAt: row.createdAt,
    })
    .returning();
  return tx!;
}

// Writes an article_standard_cost_history row with an explicit valid_from —
// same rationale as insertTransaction above.
async function insertHistory(articleId: string, cost: number, validFrom: Date) {
  const [row] = await db
    .insert(articleStandardCostHistory)
    .values({ articleId, cost: String(cost), validFrom })
    .returning();
  return row!;
}

function rowFor(result: Awaited<ReturnType<typeof valuationService.getValuation>>, articleId: string) {
  return result.groups.flatMap((g) => g.rows).find((r) => r.articleId === articleId);
}

describe("getValuation — standard method", () => {
  it("uses the history row valid as of asOf, not a later price change", async () => {
    const location = await makeLocation();
    const article = await makeArticle();

    // Old price, valid from the deep past.
    await insertHistory(article.id, 100, new Date("2000-01-01T12:00:00Z"));
    // Stock received "now" (real time) — always after the old price and
    // before the far-future new price below, regardless of when the test runs.
    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 10,
      createdAt: new Date(),
    });
    // New price, not valid until the far future.
    await insertHistory(article.id, 200, new Date("2999-01-01T12:00:00Z"));

    const before = await valuationService.getValuation({ asOf: "2500-06-15", method: "standard" });
    const rowBefore = rowFor(before, article.id);
    expect(rowBefore?.quantity).toBe(10);
    expect(rowBefore?.unitCost).toBe(100);
    expect(rowBefore?.value).toBe(1000);

    const after = await valuationService.getValuation({ asOf: "2999-01-01", method: "standard" });
    const rowAfter = rowFor(after, article.id);
    expect(rowAfter?.unitCost).toBe(200);
    expect(rowAfter?.value).toBe(2000);
  });

  it("falls back to the earliest history row when asOf predates every row", async () => {
    const location = await makeLocation();
    const article = await makeArticle();

    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 4,
      createdAt: new Date(),
    });
    // Both history rows are in the future relative to "today" — asOf=today
    // must fall back to the EARLIEST one (500), not the later 600.
    await insertHistory(article.id, 500, new Date("2999-01-01T12:00:00Z"));
    await insertHistory(article.id, 600, new Date("2999-06-01T12:00:00Z"));

    const todayStr = new Date().toLocaleDateString("sv-SE");
    const result = await valuationService.getValuation({ asOf: todayStr, method: "standard" });
    const row = rowFor(result, article.id);
    expect(row?.unitCost).toBe(500);
    expect(row?.quantity).toBe(4);
  });

  it("defaults asOf to today when omitted", async () => {
    const result = await valuationService.getValuation({ method: "standard" });
    expect(result.asOf).toBe(new Date().toLocaleDateString("sv-SE"));
  });
});

describe("getValuation — latest_purchase method", () => {
  it("picks the most recent priced purchase_receipt at or before asOf, ignoring unpriced ones", async () => {
    const location = await makeLocation();
    const article = await makeArticle();

    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 10,
      unitCost: 100,
      transactionType: "purchase_receipt",
      createdAt: new Date("2020-01-01T10:00:00Z"),
    });
    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 5,
      unitCost: 150,
      transactionType: "purchase_receipt",
      createdAt: new Date("2021-06-01T10:00:00Z"),
    });
    // The MOST RECENT receipt is unpriced — must be ignored in favour of the
    // last PRICED one (150), not treated as "no price at all".
    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 5,
      unitCost: null,
      transactionType: "purchase_receipt",
      createdAt: new Date("2022-01-01T10:00:00Z"),
    });

    const result = await valuationService.getValuation({ asOf: "2023-01-01", method: "latest_purchase" });
    const row = rowFor(result, article.id);
    expect(row?.quantity).toBe(20);
    expect(row?.unitCost).toBe(150);
    expect(row?.value).toBe(3000);
  });
});

describe("getValuation — moving_average method", () => {
  it("matches a hand-computed sequence through computeMovingAverage", async () => {
    const location = await makeLocation();
    const article = await makeArticle();

    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 10,
      unitCost: 100,
      transactionType: "purchase_receipt",
      createdAt: new Date("2020-01-01T10:00:00Z"),
    });
    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 10,
      unitCost: 200,
      transactionType: "purchase_receipt",
      createdAt: new Date("2020-01-02T10:00:00Z"),
    });
    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: -4,
      unitCost: null,
      transactionType: "sales_delivery",
      createdAt: new Date("2020-01-03T10:00:00Z"),
    });

    // Hand-computed: 10 @ 100 + 10 @ 200 -> 20 @ 150; a -4 outflow leaves the
    // average unchanged (computeMovingAverage's own rule) -> 16 @ 150.
    const result = await valuationService.getValuation({ asOf: "2020-01-31", method: "moving_average" });
    const row = rowFor(result, article.id);
    expect(row?.quantity).toBe(16);
    expect(row?.unitCost).toBe(150);
    expect(row?.value).toBe(2400);
  });
});

// Group name is picked so plain alphabetical order would NOT put
// "Utan varugrupp" last on its own ("A-gruppen" < "Utan..." < "Ö-gruppen")
// — the null-group-last rule has to be doing real work for this to pass.
async function setupGroupingFixture(location: { id: string }) {
  const groupHigh = await articleService.createArticleGroup({ code: "501", name: "Ö-gruppen" });
  const groupLow = await articleService.createArticleGroup({ code: "502", name: "A-gruppen" });

  const articleX = await makeArticle({ groupId: groupHigh.id });
  await insertHistory(articleX.id, 100, new Date("2000-01-01T12:00:00Z"));
  await insertTransaction({
    articleId: articleX.id,
    locationId: location.id,
    quantityDelta: 10,
    createdAt: new Date("2020-01-01T10:00:00Z"),
  });

  // Nets to zero — must be entirely absent from the report.
  const articleY = await makeArticle({ groupId: groupHigh.id });
  await insertTransaction({
    articleId: articleY.id,
    locationId: location.id,
    quantityDelta: 5,
    createdAt: new Date("2020-01-01T10:00:00Z"),
  });
  await insertTransaction({
    articleId: articleY.id,
    locationId: location.id,
    quantityDelta: -5,
    createdAt: new Date("2020-01-02T10:00:00Z"),
  });

  // No standard-cost history at all -> unvalued.
  const articleZ = await makeArticle({ groupId: groupLow.id });
  await insertTransaction({
    articleId: articleZ.id,
    locationId: location.id,
    quantityDelta: 7,
    createdAt: new Date("2020-01-01T10:00:00Z"),
  });

  // No group -> falls into "Utan varugrupp".
  const articleW = await makeArticle();
  await insertHistory(articleW.id, 50, new Date("2000-01-01T12:00:00Z"));
  await insertTransaction({
    articleId: articleW.id,
    locationId: location.id,
    quantityDelta: 3,
    createdAt: new Date("2020-01-01T10:00:00Z"),
  });

  return { groupHigh, groupLow, articleX, articleY, articleZ, articleW };
}

describe("getValuation — grouping, zero-net exclusion, totals", () => {
  it("drops zero-net articles, orders groups (null group last) and excludes unvalued rows from totals", async () => {
    const location = await makeLocation();
    const { articleY } = await setupGroupingFixture(location);

    const result = await valuationService.getValuation({ asOf: "2020-06-01", method: "standard" });

    expect(result.groupBy).toBe("group");
    expect(result.groups.map((g) => g.groupName)).toEqual(["A-gruppen", "Ö-gruppen", "Utan varugrupp"]);

    const allArticleIds = result.groups.flatMap((g) => g.rows.map((r) => r.articleId));
    expect(allArticleIds).not.toContain(articleY.id);

    const groupA = result.groups.find((g) => g.groupName === "A-gruppen")!;
    expect(groupA.rows).toHaveLength(1);
    expect(groupA.rows[0]!.value).toBeNull();
    expect(groupA.total).toBe(0);

    const groupO = result.groups.find((g) => g.groupName === "Ö-gruppen")!;
    expect(groupO.total).toBe(1000);

    const groupNone = result.groups.find((g) => g.groupName === "Utan varugrupp")!;
    expect(groupNone.total).toBe(150);

    expect(result.totalValue).toBe(1150); // excludes articleZ's null value
    expect(result.unvaluedCount).toBe(1);
  });

  it("groupId narrows the report to a single group", async () => {
    const location = await makeLocation();
    const { groupLow, articleZ } = await setupGroupingFixture(location);

    const result = await valuationService.getValuation({
      asOf: "2020-06-01",
      method: "standard",
      groupId: groupLow.id,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.groupName).toBe("A-gruppen");
    expect(result.groups[0]!.rows.map((r) => r.articleId)).toEqual([articleZ.id]);
    expect(result.totalValue).toBe(0);
    expect(result.unvaluedCount).toBe(1);
  });

  it("groupBy articleCode subtotals per artikelkod (none last) and articleCodeId narrows to one", async () => {
    const location = await makeLocation();
    const { articleX, articleZ, articleW } = await setupGroupingFixture(location);
    const [plat] = await db.insert(articleCodes).values({ code: "100", name: "Plåt" }).returning();
    const [ror] = await db.insert(articleCodes).values({ code: "200", name: "Rör" }).returning();
    // X (varugrupp Ö) and Z (varugrupp A) share a code across groups; W has none.
    await articleService.updateArticle(articleX.id, { articleCodeId: ror!.id });
    await articleService.updateArticle(articleZ.id, { articleCodeId: plat!.id });

    const result = await valuationService.getValuation({ asOf: "2020-06-01", method: "standard", groupBy: "articleCode" });
    expect(result.groupBy).toBe("articleCode");
    expect(result.groups.map((g) => [g.groupId, g.groupName, g.rows.map((r) => r.articleId)])).toEqual([
      [plat!.id, "Plåt", [articleZ.id]],
      [ror!.id, "Rör", [articleX.id]],
      [null, "Utan artikelkod", [articleW.id]],
    ]);
    expect(result.totalValue).toBe(1150);

    const narrowed = await valuationService.getValuation({ asOf: "2020-06-01", method: "standard", articleCodeId: ror!.id });
    expect(narrowed.groups.map((g) => g.groupName)).toEqual(["Ö-gruppen"]);
    expect(narrowed.groups[0]!.rows.map((r) => r.articleId)).toEqual([articleX.id]);
  });
});

describe("getValuation — date bound", () => {
  it("includes a transaction created late on asOf's own date (inclusive end-of-day)", async () => {
    const location = await makeLocation();
    const article = await makeArticle();
    await insertHistory(article.id, 42, new Date("2000-01-01T12:00:00Z"));
    // Late in the day, not midnight — a naive `created_at <= asOf` (asOf
    // parsed as midnight) would wrongly exclude this row.
    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 8,
      createdAt: new Date("2024-03-15T21:00:00Z"),
    });

    const result = await valuationService.getValuation({ asOf: "2024-03-15", method: "standard" });
    const row = rowFor(result, article.id);
    expect(row?.quantity).toBe(8);
    expect(row?.value).toBe(336);
  });
});

describe("getValuationPdf", () => {
  it("prints the title, group name, article number and the grand total", async () => {
    const location = await makeLocation();
    const group = await articleService.createArticleGroup({ code: "601", name: "PDF-gruppen" });
    const article = await makeArticle({ groupId: group.id });
    await insertHistory(article.id, 10, new Date("2000-01-01T12:00:00Z"));
    await insertTransaction({
      articleId: article.id,
      locationId: location.id,
      quantityDelta: 5,
      createdAt: new Date("2020-01-01T10:00:00Z"),
    });

    const { filename, content } = await valuationService.getValuationPdf({
      asOf: "2020-06-01",
      method: "standard",
    });
    expect(filename).toBe("lagervardering-2020-06-01-standard.pdf");

    const text = pdfText(content);
    expect(text).toContain("Lagervärdering");
    expect(text).toContain("PDF-gruppen");
    expect(text).toContain(article.articleNumber);
    expect(text).toContain("SUMMA LAGERVÄRDE");
  });
});
