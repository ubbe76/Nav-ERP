// Inventering per underlagets datum (#26): Registrera books the differences
// per the moment the underlag was created when the count provably describes
// that moment and the day is still open for bookkeeping.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { listStockTransactionsQuerySchema, createArticleSchema, createStockLocationSchema } from "@navet/shared";
import { accountingPeriods, articleStandardCostHistory, db, fiscalYears, stockCountSessions, stockTransactions } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { StockCountBackdateRefusedError } from "../src/modules/stock/service/stock.errors.js";
import {
  createStockCountRepository,
  type PostingPeriodReader,
} from "../src/modules/stock/repository/stock-count.repository.js";
import { createValuationService } from "../src/modules/stock/service/valuation.service.js";
import { postingPeriodLockOn } from "../src/modules/economy/service/verification-poster.js";
import { createUser, createCalendarYear, resetYearEnd } from "./helpers/year-end.js";
import { testEconomyService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const valuation = createValuationService({ db });

const TRUNCATE = sql`TRUNCATE stock_count_rows, stock_count_sessions, stock_transactions, stock_locations, warehouses, bom_components, article_standard_cost_history, articles, audit_log CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetYearEnd();
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetYearEnd();
});

// The underlag was created on 2025-12-31 at 16:00 Stockholm (15:00 UTC); the
// stock it froze arrived the day before.
const FREEZE = new Date("2025-12-31T15:00:00Z");
const BEFORE_FREEZE = new Date("2025-12-30T09:00:00Z");

async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${name}`, active: true });
  return stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name, active: true }));
}

async function makeArticle(number: string, standardCost?: number) {
  return articleService.createArticle(parsed(createArticleSchema, {
    articleNumber: number,
    name: `Artikel ${number}`,
    type: "purchased",
    active: true,
    ...(standardCost !== undefined ? { standardCost } : {}),
  }));
}

// Stock on the location, registered before the freeze.
async function stockBeforeFreeze(articleId: string, locationId: string, quantity: number, unitCost = "10") {
  const row = await stockService.recordTransaction({ articleId, locationId, quantityDelta: quantity, transactionType: "inventory_adjustment" });
  await db
    .update(stockTransactions)
    .set({ createdAt: BEFORE_FREEZE, unitCost })
    .where(eq(stockTransactions.id, (row as { id: string }).id));
}

// A count frozen at FREEZE (its rows were seeded from the balances above).
async function countFrozenAtFreeze(repo: ReturnType<typeof createStockCountRepository>, locationId: string, blocks = false) {
  const session = await repo.createSession({ locationId, blocksTransactions: blocks }, null);
  await db.update(stockCountSessions).set({ createdAt: FREEZE }).where(eq(stockCountSessions.id, session.id));
  return session;
}

async function count(repo: ReturnType<typeof createStockCountRepository>, sessionId: string, articleId: string, quantity: number) {
  const detail = await repo.getSession(sessionId);
  const row = detail!.rows.find((r) => r.articleId === articleId)!;
  await repo.updateRow(sessionId, row.id, { countedQuantity: quantity });
}

async function adjustmentsOf(sessionId: string) {
  return db
    .select()
    .from(stockTransactions)
    .where(and(eq(stockTransactions.referenceId, sessionId), eq(stockTransactions.transactionType, "inventory_adjustment")));
}

const fixedLock = (lock: Awaited<ReturnType<PostingPeriodReader["lockOn"]>>): PostingPeriodReader => ({
  lockOn: async () => lock,
});

describe("Registrera per underlagets datum", () => {
  it("defaults to the underlag's moment for an undisturbed count from an earlier day", async () => {
    const repo = createStockCountRepository(db);
    const location = await makeLocation();
    const article = await makeArticle("BAK-1", 10);
    await stockBeforeFreeze(article.id, location.id, 10);
    const session = await countFrozenAtFreeze(repo, location.id);
    await count(repo, session.id, article.id, 7);

    const before = await repo.getSession(session.id);
    expect(before!.backdating).toEqual({
      countDate: "2025-12-31",
      sameDay: false,
      allowed: true,
      reason: null,
      reasonText: null,
    });

    const result = await repo.postSession(session.id, null);
    expect(result).toMatchObject({ adjustments: 1, valuedOn: "2025-12-31" });
    const [row] = await adjustmentsOf(session.id);
    expect(Number(row!.quantityDelta)).toBe(-3);
    expect(row!.valuedAt!.toISOString()).toBe(FREEZE.toISOString());
    // Registration time is untouched — the log still says when it happened.
    expect(row!.createdAt.getTime()).toBeGreaterThan(FREEZE.getTime() + 24 * 3600 * 1000);
    expect((await repo.getSession(session.id))!.valuedOn).toBe("2025-12-31");

    // The valuation per the underlag's day sees the counted quantity.
    const asOfFreeze = await valuation.getValuation({ asOf: "2025-12-31", method: "standard" });
    expect(asOfFreeze.groups[0]!.rows[0]).toMatchObject({ quantity: 7 });
    const dayBefore = await valuation.getValuation({ asOf: "2025-12-30", method: "standard" });
    expect(dayBefore.groups[0]!.rows[0]).toMatchObject({ quantity: 10 });
  });

  it("values a backdated positive difference at the standard cost of the freeze moment", async () => {
    const repo = createStockCountRepository(db);
    const location = await makeLocation();
    const article = await makeArticle("BAK-2", 10);
    // The first standard cost was valid from before the freeze; 12 came after.
    await db
      .update(articleStandardCostHistory)
      .set({ validFrom: new Date("2025-12-01T00:00:00Z") })
      .where(eq(articleStandardCostHistory.articleId, article.id));
    await articleService.updateStandardCost(article.id, 12);
    await stockBeforeFreeze(article.id, location.id, 5);

    const backdated = await countFrozenAtFreeze(repo, location.id);
    await count(repo, backdated.id, article.id, 8);
    await repo.postSession(backdated.id, null, "count_date");
    expect(Number((await adjustmentsOf(backdated.id))[0]!.unitCost)).toBe(10);

    const today = await countFrozenAtFreeze(repo, location.id);
    await count(repo, today.id, article.id, 9);
    const result = await repo.postSession(today.id, null, "today");
    expect(result.valuedOn).toBeNull();
    const [row] = await adjustmentsOf(today.id);
    expect(row!.valuedAt).toBeNull();
    expect(Number(row!.unitCost)).toBe(12);
  });

  it("books today when the count's articles moved on the location after the freeze, and refuses an explicit count_date", async () => {
    const repo = createStockCountRepository(db);
    const location = await makeLocation();
    const moved = await makeArticle("BAK-3", 10);
    const untouched = await makeArticle("BAK-4", 10);
    await stockBeforeFreeze(moved.id, location.id, 10);
    await stockBeforeFreeze(untouched.id, location.id, 4);
    const session = await countFrozenAtFreeze(repo, location.id);
    // Registered after the freeze (now) — the count may no longer describe the freeze.
    await stockService.recordTransaction({ articleId: moved.id, locationId: location.id, quantityDelta: -2, transactionType: "sales_delivery" });

    // Only the untouched article counted: nothing booked has moved.
    await count(repo, session.id, untouched.id, 3);
    expect((await repo.getSession(session.id))!.backdating).toMatchObject({ allowed: true, reason: null });

    await count(repo, session.id, moved.id, 7);
    const detail = await repo.getSession(session.id);
    expect(detail!.backdating).toMatchObject({ allowed: false, reason: "disturbed" });
    expect(detail!.backdating!.reasonText).toMatch(/lagerrörelser på lagerplatsen efter att underlaget skapades/);

    await expect(repo.postSession(session.id, null, "count_date")).rejects.toBeInstanceOf(StockCountBackdateRefusedError);
    expect(await adjustmentsOf(session.id)).toHaveLength(0);

    const result = await repo.postSession(session.id, null);
    expect(result).toMatchObject({ adjustments: 2, valuedOn: null });
    expect((await adjustmentsOf(session.id)).every((r) => r.valuedAt === null)).toBe(true);
  });

  it("refuses the underlag's day in a locked period or a closed year", async () => {
    const location = await makeLocation();
    const article = await makeArticle("BAK-5", 10);
    await stockBeforeFreeze(article.id, location.id, 10);

    const locked = createStockCountRepository(db, fixedLock({ kind: "period_locked" }));
    const session = await countFrozenAtFreeze(locked, location.id);
    await count(locked, session.id, article.id, 9);
    expect((await locked.getSession(session.id))!.backdating).toMatchObject({
      allowed: false,
      reason: "period_locked",
      reasonText: "Bokföringsperioden för 2025-12-31 är låst.",
    });
    await expect(locked.postSession(session.id, null, "count_date")).rejects.toThrow(
      "Inventeringen INV-"
    );

    const closed = createStockCountRepository(db, fixedLock({ kind: "year_closed", yearLabel: "2025" }));
    expect((await closed.getSession(session.id))!.backdating).toMatchObject({
      reason: "year_closed",
      reasonText: "Räkenskapsåret 2025 är stängt.",
    });
    const result = await closed.postSession(session.id, null);
    expect(result.valuedOn).toBeNull();
    expect((await adjustmentsOf(session.id))[0]!.valuedAt).toBeNull();
  });

  it("offers no choice for an underlag from today", async () => {
    const repo = createStockCountRepository(db);
    const location = await makeLocation();
    const article = await makeArticle("BAK-6", 10);
    await stockBeforeFreeze(article.id, location.id, 10);
    const session = await repo.createSession({ locationId: location.id, blocksTransactions: true }, null);
    await count(repo, session.id, article.id, 10);
    expect((await repo.getSession(session.id))!.backdating).toMatchObject({ sameDay: true, allowed: true });
  });

  it("puts a backdated row at its freeze moment in the stock log: date filter, order and running balance", async () => {
    const repo = createStockCountRepository(db);
    const location = await makeLocation();
    const article = await makeArticle("BAK-7", 10);
    await stockBeforeFreeze(article.id, location.id, 10);
    const session = await countFrozenAtFreeze(repo, location.id);
    // A movement elsewhere after the freeze, registered before the count.
    const other = await makeLocation("B1");
    await stockService.recordTransaction({ articleId: article.id, locationId: other.id, quantityDelta: 5, transactionType: "inventory_adjustment" });
    await count(repo, session.id, article.id, 6);
    await repo.postSession(session.id, null);

    const decemberOnly = await stockService.listTransactions(
      listStockTransactionsQuerySchema.parse({ articleId: article.id, from: "2025-12-31", to: "2025-12-31" })
    );
    expect(decemberOnly.rows.map((r) => Number(r.quantityDelta))).toEqual([-4]);
    expect(new Date(decemberOnly.rows[0]!.valuedAt).toISOString()).toBe(FREEZE.toISOString());

    const all = await stockService.listTransactions(listStockTransactionsQuerySchema.parse({ articleId: article.id }));
    // Newest värderingsdatum first: the +5 registered before the count, then
    // the count at its freeze, then the stock from before it.
    expect(all.rows.map((r) => [Number(r.quantityDelta), Number(r.balance)])).toEqual([
      [5, 11],
      [-4, 6],
      [10, 10],
    ]);
  });
});

describe("postingPeriodLockOn — economy's verdict for the count's day", () => {
  it("is null without a period, names the closed year and reports a locked period", async () => {
    expect(await postingPeriodLockOn(db, "2024-12-31")).toBeNull();

    const user = await createUser();
    const year = await createCalendarYear(2024);
    expect(await postingPeriodLockOn(db, "2024-12-31")).toBeNull();

    const [december] = await db
      .select({ id: accountingPeriods.id })
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.fiscalYearId, year.id), eq(accountingPeriods.startDate, "2024-12-01")));
    await testEconomyService.lockPeriod(december!.id, user.id);
    expect(await postingPeriodLockOn(db, "2024-12-31")).toEqual({ kind: "period_locked" });
    expect(await postingPeriodLockOn(db, "2024-11-30")).toBeNull();

    await db.update(fiscalYears).set({ status: "closed", closedAt: new Date(), closedBy: user.id }).where(eq(fiscalYears.id, year.id));
    expect(await postingPeriodLockOn(db, "2024-11-30")).toEqual({ kind: "year_closed", yearLabel: "2024" });
  });
});
