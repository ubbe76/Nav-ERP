import { createArticleSchema, createStockAdjustmentSchema, createStockLocationSchema, updateSystemSettingsSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { articles, auditLog, db, stockBatches, stockTransactions, systemSettings, type Tx } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { articleBatchBalances, batchCellQuantity, batchCellsForArticles } from "../src/modules/stock/repository/batch-balances.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import {
  ArticleNotBatchTrackableError,
  batchErrorStatus,
  BatchInsufficientError,
  BatchNotTrackedError,
  BatchNumberReservedError,
  BatchTrackingDisabledError,
  BatchTrackingInUseError,
  StockBatchNotFoundError,
} from "../src/modules/stock/service/batch.errors.js";
import {
  BATCH_TRACKING_ENABLED_KEY,
  trackedArticleIds,
  batchTrackingEnabledForShare,
  isTrackedArticle,
} from "../src/modules/stock/service/batch-tracking.js";
import { findArticleBatch, getOrCreateBatch } from "../src/modules/stock/service/batches.js";
import { lockArticlesForOutflow } from "../src/modules/stock/service/outflow-locations.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Batch (#8), steg 1: the batch register (getOrCreateBatch), the article's
// flag Batchstyrd and the system setting it depends on, the justering as an
// inflow with a batch, the per-cell readers and the article card's route.
// The pure allocation rule is in batch-allocation.test.ts; inleverans and
// the TO's finished goods in stock-batch-inflows.test.ts.

const articleService = createArticleService(createArticleRepository(db), createAuditRepository(db));
const stockService = createStockService(createStockRepository(db));

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, user_settings, users CASCADE`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
const setEnabled = (batchTrackingEnabled: boolean) =>
  testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled }));

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
});

let n = 0;
async function makeArticle(patch: Record<string, unknown> = {}) {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `B-${++n}-${crypto.randomUUID().slice(0, 8)}`, name: "Plåt", type: "purchased", active: true, ...patch })
  );
}

// A batchstyrd article, with the setting switched on.
async function makeTracked(patch: Record<string, unknown> = {}) {
  await setEnabled(true);
  return makeArticle({ batchTracked: true, ...patch });
}

// Numbered warehouses, so two places made in a row sort in that order.
let warehouses = 0;
async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${String(++warehouses).padStart(4, "0")} ${crypto.randomUUID()}`, active: true });
  return stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name, active: true }));
}

const adjust = (articleId: string, locationId: string, quantityDelta: number, batchNumber?: string) =>
  stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment", batchNumber });

// A decrease booked on Okänd whatever batches the place holds (a decrease
// without a chosen batch takes the place's batches oldest first).
const takeUnknown = (articleId: string, locationId: string, quantity: number) =>
  stockService.recordTransaction({ articleId, locationId, quantityDelta: -quantity, transactionType: "inventory_adjustment", batchId: null });

// A transaction held open until `release` — and what a contender did while
// it was (see artikelgranskning.test.ts): the contender must end up WAITING
// on a lock, or waitForLockWaiter throws.
function heldTransaction(work: (tx: Tx) => Promise<void>) {
  let begun!: () => void;
  const ready = new Promise<void>((resolve) => (begun = resolve));
  let release!: () => void;
  const mayCommit = new Promise<void>((resolve) => (release = resolve));
  const done = db.transaction(async (tx) => {
    await work(tx);
    begun();
    await mayCommit;
  });
  return { ready, release, done };
}

async function raceAgainst(held: ReturnType<typeof heldTransaction>, contender: () => Promise<unknown>): Promise<unknown> {
  await held.ready;
  let outcome!: Promise<unknown>;
  try {
    outcome = contender().then(
      (value) => value,
      (err: unknown) => err
    );
    await waitForLockWaiter();
  } finally {
    held.release();
    await held.done;
  }
  return outcome;
}

describe("getOrCreateBatch", () => {
  it("creates the batch on its first inflow and finds it again — per article, case-insensitively, first spelling kept", async () => {
    const [a, b] = [await makeArticle(), await makeArticle()];
    const first = await getOrCreateBatch(db, { articleId: a.id, batchNumber: "  L-2291 ", origin: "manual" });
    expect(first.batchNumber).toBe("L-2291");
    const again = await getOrCreateBatch(db, { articleId: a.id, batchNumber: "l-2291", origin: "purchase_receipt" });
    expect(again).toEqual(first);
    // Another article's batch with the same number is another batch.
    const other = await getOrCreateBatch(db, { articleId: b.id, batchNumber: "L-2291", origin: "manual" });
    expect(other.id).not.toBe(first.id);

    const rows = await db.select().from(stockBatches).where(eq(stockBatches.articleId, a.id));
    // The origin is how the batch was CREATED — a later inflow never changes it.
    expect(rows.map((r) => [r.batchNumber, r.origin])).toEqual([["L-2291", "manual"]]);
  });

  it("refuses the reserved name Okänd in any case, and the database refuses an untrimmed or empty number", async () => {
    const a = await makeArticle();
    await expect(getOrCreateBatch(db, { articleId: a.id, batchNumber: "okänd", origin: "manual" })).rejects.toThrow(BatchNumberReservedError);
    await expect(getOrCreateBatch(db, { articleId: a.id, batchNumber: " OKÄND ", origin: "manual" })).rejects.toThrow(BatchNumberReservedError);
    await expect(db.insert(stockBatches).values({ articleId: a.id, batchNumber: " X", origin: "manual" })).rejects.toThrow();
    await expect(db.insert(stockBatches).values({ articleId: a.id, batchNumber: "", origin: "manual" })).rejects.toThrow();
    expect(await db.select().from(stockBatches)).toEqual([]);
  });

  it("two simultaneous first inflows get the same batch", async () => {
    const a = await makeArticle();
    let heldId = "";
    const held = heldTransaction(async (tx) => {
      heldId = (await getOrCreateBatch(tx, { articleId: a.id, batchNumber: "L-1", origin: "manual" })).id;
    });
    const outcome = await raceAgainst(held, () => getOrCreateBatch(db, { articleId: a.id, batchNumber: "l-1", origin: "import" }));
    expect(outcome).toEqual({ id: heldId, batchNumber: "L-1" });
    expect(await db.select().from(stockBatches)).toHaveLength(1);
  });

  it("findArticleBatch: a chosen batch must exist and be the article's", async () => {
    const [a, b] = [await makeArticle(), await makeArticle()];
    const batch = await getOrCreateBatch(db, { articleId: a.id, batchNumber: "L-1", origin: "manual" });
    expect(await findArticleBatch(db, a.id, batch.id)).toEqual(batch);
    await expect(findArticleBatch(db, b.id, batch.id)).rejects.toThrow(StockBatchNotFoundError);
    await expect(findArticleBatch(db, a.id, crypto.randomUUID())).rejects.toThrow(StockBatchNotFoundError);
  });
});

describe("Batchstyrd and the setting Använd batch- och serienummer", () => {
  it("is off by default: the flag cannot be switched on, neither at creation nor afterwards", async () => {
    expect((await testSystemService.getSettings()).batchTrackingEnabled).toBe(false);
    await expect(makeArticle({ batchTracked: true })).rejects.toThrow(BatchTrackingDisabledError);
    const a = await makeArticle();
    expect(a.batchTracked).toBe(false);
    await expect(articleService.updateArticle(a.id, { batchTracked: true })).rejects.toThrow(BatchTrackingDisabledError);
    // Sending false while it is off is nothing to refuse.
    expect((await articleService.updateArticle(a.id, { batchTracked: false }))!.batchTracked).toBe(false);
  });

  it("with the setting on the flag goes on and off, logged on the article", async () => {
    await setEnabled(true);
    expect((await testSystemService.getSettings()).batchTrackingEnabled).toBe(true);
    const a = await makeArticle();
    expect((await articleService.updateArticle(a.id, { batchTracked: true }, null))!.batchTracked).toBe(true);
    expect(await isTrackedArticle(db, a.id)).toBe(true);
    // Unchanged = no log row.
    await articleService.updateArticle(a.id, { batchTracked: true, name: "Plåt 2" });
    expect((await articleService.updateArticle(a.id, { batchTracked: false }))!.batchTracked).toBe(false);

    // In write order (no ORDER BY gave the rows in any order now and then).
    const log = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "article"), eq(auditLog.entityId, a.id)))
      .orderBy(asc(auditLog.createdAt));
    expect(log.map((row) => (row.detail as { after: unknown }).after)).toEqual([{ batchTracked: true }, { batchTracked: false }]);

    const created = await makeArticle({ batchTracked: true });
    expect(created.batchTracked).toBe(true);
    expect(await trackedArticleIds(db, [a.id, created.id, crypto.randomUUID()])).toEqual(new Set([created.id]));
  });

  it("may always be switched off — also with stock in named batches, which stay in the log and come back", async () => {
    const a = await makeTracked();
    const location = await makeLocation();
    await adjust(a.id, location.id, 10, "L-1");
    await adjust(a.id, location.id, 4);

    expect((await articleService.updateArticle(a.id, { batchTracked: false }))!.batchTracked).toBe(false);
    // Not shown while the flag is off…
    expect(await stockService.getArticleBatchBalances(a.id)).toEqual({ batchTracked: false, batches: [] });
    // …a justering is Okänd again, and a batch is refused.
    await adjust(a.id, location.id, 1);
    await expect(adjust(a.id, location.id, 1, "L-1")).rejects.toThrow(BatchNotTrackedError);

    await articleService.updateArticle(a.id, { batchTracked: true });
    const view = await stockService.getArticleBatchBalances(a.id);
    expect(view.batches.map((b) => [b.batchNumber, b.total])).toEqual([
      [null, "5.0000"],
      ["L-1", "10.0000"],
    ]);
  });

  it("a Tjänst or a phantom is never batchstyrd, and an article that becomes one loses the flag", async () => {
    await setEnabled(true);
    await expect(makeArticle({ type: "service", batchTracked: true })).rejects.toThrow(ArticleNotBatchTrackableError);
    await expect(makeArticle({ type: "manufactured", isPhantom: true, batchTracked: true })).rejects.toThrow(ArticleNotBatchTrackableError);
    const service = await makeArticle({ type: "service" });
    await expect(articleService.updateArticle(service.id, { batchTracked: true })).rejects.toThrow(ArticleNotBatchTrackableError);

    const goods = await makeArticle({ batchTracked: true });
    await expect(articleService.updateArticle(goods.id, { type: "service", batchTracked: true })).rejects.toThrow(ArticleNotBatchTrackableError);
    expect((await articleService.updateArticle(goods.id, { type: "service" }))!).toMatchObject({ type: "service", batchTracked: false });

    const made = await makeArticle({ type: "manufactured", batchTracked: true });
    expect((await articleService.updateArticle(made.id, { isPhantom: true }))!).toMatchObject({ isPhantom: true, batchTracked: false });
  });

  it("Kopiera från brings the flag along — but not onto a Tjänst, and the request wins", async () => {
    const source = await makeTracked();
    const copy = (patch: Record<string, unknown>) => makeArticle({ copyFrom: { articleId: source.id, parts: ["information"] }, ...patch });
    expect((await copy({})).batchTracked).toBe(true);
    expect((await copy({ batchTracked: false })).batchTracked).toBe(false);
    expect((await copy({ type: "service" })).batchTracked).toBe(false);
  });

  it("the setting can only be switched off while no article is batchstyrd — and nothing else of the PATCH is saved", async () => {
    const a = await makeTracked();
    await makeArticle({ batchTracked: true });
    const before = (await testSystemService.getSettings()).quoteValidityDays;
    const refused = testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: false, quoteValidityDays: before + 7 }));
    await expect(refused).rejects.toThrow(BatchTrackingInUseError);
    await expect(refused).rejects.toMatchObject({ articleCount: 2 });
    expect(await testSystemService.getSettings()).toMatchObject({ batchTrackingEnabled: true, quoteValidityDays: before });

    await db.update(articles).set({ tracking: "none" });
    expect((await setEnabled(false)).batchTrackingEnabled).toBe(false);
    await expect(articleService.updateArticle(a.id, { batchTracked: true })).rejects.toThrow(BatchTrackingDisabledError);
  });

  it("race: a switch-off of the setting waits for a flag being switched on, and then refuses", async () => {
    await setEnabled(true);
    const a = await makeArticle();
    const held = heldTransaction(async (tx) => {
      expect(await batchTrackingEnabledForShare(tx)).toBe(true);
      await tx.update(articles).set({ tracking: "batch" }).where(eq(articles.id, a.id));
    });
    const outcome = await raceAgainst(held, () => setEnabled(false));
    expect(outcome).toBeInstanceOf(BatchTrackingInUseError);
    expect((await testSystemService.getSettings()).batchTrackingEnabled).toBe(true);
  });

  it("race: a flag switched on waits for a switch-off of the setting in progress, and is then refused", async () => {
    await setEnabled(true);
    const a = await makeArticle();
    const held = heldTransaction(async (tx) => {
      await tx.update(systemSettings).set({ value: "false" }).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
    });
    const outcome = await raceAgainst(held, () => articleService.updateArticle(a.id, { batchTracked: true }));
    expect(outcome).toBeInstanceOf(BatchTrackingDisabledError);
    expect(await isTrackedArticle(db, a.id)).toBe(false);
  });

  it("race: a flag change waits for an inflow that has already read the flag", async () => {
    await setEnabled(true);
    const a = await makeArticle();
    const location = await makeLocation();
    const held = heldTransaction(async (tx) => {
      // What every inflow does first (FOR KEY SHARE) — it read "not batchstyrd"…
      expect(await isTrackedArticle(tx, a.id)).toBe(false);
      await tx.insert(stockTransactions).values({ articleId: a.id, locationId: location.id, quantityDelta: "5", transactionType: "inventory_adjustment" });
    });
    const outcome = await raceAgainst(held, () => articleService.updateArticle(a.id, { batchTracked: true }));
    // …and the change only went through after its row was committed (Okänd).
    expect(outcome).toMatchObject({ batchTracked: true });
    expect(await batchCellQuantity(db, a.id, location.id, null)).toBe(5);
  });

  it("race: an inflow waits for a flag change in progress and books with the new flag", async () => {
    await setEnabled(true);
    const a = await makeArticle();
    const location = await makeLocation();
    const held = heldTransaction(async (tx) => {
      // updateArticle's lock (lockArticle) and its write.
      await tx.select({ id: articles.id }).from(articles).where(eq(articles.id, a.id)).for("update");
      await tx.update(articles).set({ tracking: "batch" }).where(eq(articles.id, a.id));
    });
    const outcome = await raceAgainst(held, () => adjust(a.id, location.id, 5, "L-9"));
    // Before the change committed the batch would have been refused (batch-not-tracked).
    expect(outcome).toMatchObject({ quantityDelta: "5.0000" });
    expect((outcome as { batchId: string | null }).batchId).not.toBeNull();
  });
});

describe("Justering with a batch", () => {
  it("a positive justering books into the named batch (created on first use), or Okänd without one", async () => {
    const a = await makeTracked({ standardCost: 12 });
    const location = await makeLocation();
    const named = await adjust(a.id, location.id, 10, "L-1");
    const sameBatch = await adjust(a.id, location.id, 2, "l-1");
    const unknown = await adjust(a.id, location.id, 4);

    expect(named!.batchId).not.toBeNull();
    expect(sameBatch!.batchId).toBe(named!.batchId);
    expect(unknown!.batchId).toBeNull();
    // Still an inflow like any other: priced at the standard cost.
    expect(named!.unitCost).toBe("12.0000");
    const [batch] = await db.select().from(stockBatches);
    expect(batch).toMatchObject({ id: named!.batchId, articleId: a.id, batchNumber: "L-1", origin: "manual" });

    expect(await batchCellQuantity(db, a.id, location.id, named!.batchId)).toBe(12);
    expect(await batchCellQuantity(db, a.id, location.id, null)).toBe(4);
  });

  it("refuses a batch on an article that is not batchstyrd, the reserved name, and a batch on a decrease", async () => {
    await setEnabled(true);
    const plain = await makeArticle();
    const tracked = await makeArticle({ batchTracked: true });
    const location = await makeLocation();
    await expect(adjust(plain.id, location.id, 5, "L-1")).rejects.toThrow(BatchNotTrackedError);
    await expect(adjust(tracked.id, location.id, 5, "Okänd")).rejects.toThrow(BatchNumberReservedError);
    expect(await db.select().from(stockTransactions)).toEqual([]);
    expect(await db.select().from(stockBatches)).toEqual([]);

    // The route's schema: batchNumber only names the batch of an inflow; "" = left out.
    const base = { articleId: tracked.id, locationId: location.id };
    expect(createStockAdjustmentSchema.safeParse({ ...base, quantityDelta: -1, batchNumber: "L-1" }).success).toBe(false);
    expect(createStockAdjustmentSchema.parse({ ...base, quantityDelta: -1, batchNumber: " " }).batchNumber).toBeUndefined();
    expect(createStockAdjustmentSchema.parse({ ...base, quantityDelta: 1, batchNumber: " L-1 " }).batchNumber).toBe("L-1");
    expect(createStockAdjustmentSchema.safeParse({ ...base, quantityDelta: 1, batchNumber: "x".repeat(51) }).success).toBe(false);
  });

  it("an article that is not batchstyrd is booked exactly as before — no batch, no batch row", async () => {
    const plain = await makeArticle({ standardCost: 3 });
    const location = await makeLocation();
    const row = await adjust(plain.id, location.id, 5);
    expect(row).toMatchObject({ quantityDelta: "5.0000", unitCost: "3.0000", batchId: null });
    await adjust(plain.id, location.id, -2);
    expect(await batchCellsForArticles(db, [plain.id])).toMatchObject([{ batchId: null, batchNumber: null, quantity: 3 }]);
    expect(await db.select().from(stockBatches)).toEqual([]);
  });

  it("race: a decrease of a batchstyrd article takes the draws' article lock; one that is not batchstyrd does not", async () => {
    await setEnabled(true);
    const tracked = await makeArticle({ batchTracked: true });
    const plain = await makeArticle();
    const location = await makeLocation();
    await adjust(tracked.id, location.id, 10);
    await adjust(plain.id, location.id, 10);

    const held = heldTransaction(async (tx) => {
      await lockArticlesForOutflow(tx, [tracked.id, plain.id]);
    });
    await held.ready;
    // Not batchstyrd: goes straight through while the lock is held, as before.
    expect(await adjust(plain.id, location.id, -1)).toMatchObject({ quantityDelta: "-1.0000" });
    const outcome = await raceAgainst(held, () => adjust(tracked.id, location.id, -1));
    expect(outcome).toMatchObject({ quantityDelta: "-1.0000", batchId: null });
  });
});

describe("the log and the readers", () => {
  it("the stock log is append-only for batch_id too", async () => {
    const a = await makeTracked();
    const location = await makeLocation();
    const row = await adjust(a.id, location.id, 10, "L-1");
    const other = await getOrCreateBatch(db, { articleId: a.id, batchNumber: "L-2", origin: "manual" });
    await expect(db.update(stockTransactions).set({ batchId: other.id }).where(eq(stockTransactions.id, row!.id))).rejects.toMatchObject({
      cause: { code: "NV001" },
    });
    await expect(db.update(stockTransactions).set({ batchId: null }).where(eq(stockTransactions.id, row!.id))).rejects.toMatchObject({
      cause: { code: "NV001" },
    });
    // A batch the log refers to cannot be deleted.
    await expect(db.delete(stockBatches).where(eq(stockBatches.id, row!.batchId!))).rejects.toThrow();
  });

  it("batchCellsForArticles: every cell with a balance, Okänd as batch null, narrowed to places when asked", async () => {
    const a = await makeTracked();
    const b = await makeArticle({ batchTracked: true });
    const [a1, b2] = [await makeLocation("A1"), await makeLocation("B2")];
    await adjust(a.id, a1.id, 10, "L-1");
    await takeUnknown(a.id, a1.id, 3); // Okänd −3 next to the named batch
    await adjust(a.id, b2.id, 4, "L-1");
    await adjust(a.id, b2.id, 2, "L-2");
    await takeUnknown(a.id, b2.id, 2); // nets Okänd on B2 to −2…
    await adjust(a.id, b2.id, 2, undefined); // …and back to 0: no cell
    await adjust(b.id, a1.id, 1);

    const key = (c: { articleId: string; locationId: string; batchNumber: string | null; quantity: number }) =>
      `${c.articleId === a.id ? "a" : "b"}/${c.locationId === a1.id ? "A1" : "B2"}/${c.batchNumber ?? "Okänd"}=${c.quantity}`;
    expect((await batchCellsForArticles(db, [a.id, b.id])).map(key).sort()).toEqual([
      "a/A1/L-1=10",
      "a/A1/Okänd=-3",
      "a/B2/L-1=4",
      "a/B2/L-2=2",
      "b/A1/Okänd=1",
    ]);
    expect((await batchCellsForArticles(db, [a.id], { locationIds: [b2.id] })).map(key).sort()).toEqual(["a/B2/L-1=4", "a/B2/L-2=2"]);
    expect(await batchCellsForArticles(db, [a.id], { locationIds: [] })).toEqual([]);
    expect(await batchCellsForArticles(db, [])).toEqual([]);
    const cells = await batchCellsForArticles(db, [a.id]);
    expect(cells.find((c) => c.batchNumber === "L-1")!.batchCreatedAt).toBeInstanceOf(Date);
    expect(cells.find((c) => c.batchId === null)!.batchCreatedAt).toBeNull();
  });

  it("articleBatchBalances: Okänd first, then the oldest batch, each with its places", async () => {
    const a = await makeTracked();
    const [a1, b2] = [await makeLocation("A1"), await makeLocation("B2")];
    await adjust(a.id, b2.id, 2, "NY");
    await adjust(a.id, a1.id, 7, "GAMMAL");
    await adjust(a.id, b2.id, 3, "GAMMAL");
    await adjust(a.id, a1.id, 1);
    // GAMMAL is the older one, whatever order the rows were booked in.
    await db.update(stockBatches).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(stockBatches.batchNumber, "GAMMAL"));

    const balances = await articleBatchBalances(db, a.id, stockholmToday());
    expect(balances.map((b) => [b.batchNumber, b.origin, b.total, b.locations.map((l) => `${l.locationName}:${l.quantity}`)])).toEqual([
      [null, null, "1.0000", ["A1:1.0000"]],
      ["GAMMAL", "manual", "10.0000", ["A1:7.0000", "B2:3.0000"]],
      ["NY", "manual", "2.0000", ["B2:2.0000"]],
    ]);
    expect(balances[0]).toMatchObject({ batchId: null, createdAt: null });
    expect(balances[1]!.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(balances[1]!.locations[0]).toMatchObject({ locationId: a1.id, blocked: false });
  });

  it("batchErrorStatus maps every batch error once for all routes", () => {
    expect(batchErrorStatus(new BatchInsufficientError("L-1", 1, 2))).toBe(409);
    expect(batchErrorStatus(new BatchTrackingDisabledError())).toBe(409);
    expect(batchErrorStatus(new BatchTrackingInUseError(3))).toBe(409);
    expect(batchErrorStatus(new StockBatchNotFoundError("x"))).toBe(404);
    expect(batchErrorStatus(new BatchNotTrackedError("A-1"))).toBe(400);
    expect(batchErrorStatus(new BatchNumberReservedError("Okänd"))).toBe(400);
    expect(batchErrorStatus(new ArticleNotBatchTrackableError())).toBe(400);
    expect(batchErrorStatus(new Error("annat"))).toBeNull();
  });
});

describe("the routes", () => {
  const PASSWORD = "ett-tillräckligt-långt-lösenord";
  let app: ReturnType<typeof buildApp>;
  let admin: string;
  const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const asAdmin = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload === undefined ? {} : { payload: payload as never }) });

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  beforeEach(async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
    });
    admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
  });

  afterAll(async () => {
    await app.close();
  });

  it("the setting, the flag, a justering with a batch and the card's saldo per batch — with their error codes", async () => {
    const location = await makeLocation();
    const article = { articleNumber: "RT-1", name: "Plåt", type: "purchased" };

    // Off by default.
    expect((await asAdmin("GET", "/settings")).json().batchTrackingEnabled).toBe(false);
    const refused = await asAdmin("POST", "/articles", { ...article, batchTracked: true });
    expect([refused.statusCode, refused.json().code]).toEqual([409, "batch-tracking-disabled"]);

    expect((await asAdmin("PATCH", "/settings", { batchTrackingEnabled: true })).json().batchTrackingEnabled).toBe(true);
    const created = await asAdmin("POST", "/articles", article);
    expect(created.json().batchTracked).toBe(false);
    const id = created.json().id as string;

    // Not batchstyrd yet: a batch is the client's mistake.
    const early = await asAdmin("POST", "/stock/transactions", { articleId: id, locationId: location.id, quantityDelta: 5, batchNumber: "L-1" });
    expect([early.statusCode, early.json().code]).toEqual([400, "batch-not-tracked"]);
    expect((await asAdmin("GET", `/articles/${id}/batch-balances`)).json()).toEqual({ batchTracked: false, batches: [] });

    expect((await asAdmin("PATCH", `/articles/${id}`, { batchTracked: true })).json().batchTracked).toBe(true);
    expect((await asAdmin("GET", `/articles/${id}`)).json().batchTracked).toBe(true);

    const booked = await asAdmin("POST", "/stock/transactions", { articleId: id, locationId: location.id, quantityDelta: 5, batchNumber: " L-1 " });
    expect(booked.statusCode).toBe(201);
    expect(booked.json().batchId).toEqual(expect.any(String));
    expect((await asAdmin("POST", "/stock/transactions", { articleId: id, locationId: location.id, quantityDelta: 2, batchNumber: "" })).json().batchId).toBeNull();
    const reserved = await asAdmin("POST", "/stock/transactions", { articleId: id, locationId: location.id, quantityDelta: 1, batchNumber: "okänd" });
    expect([reserved.statusCode, reserved.json().code]).toEqual([400, "batch-number-reserved"]);
    const onDecrease = await asAdmin("POST", "/stock/transactions", { articleId: id, locationId: location.id, quantityDelta: -1, batchNumber: "L-1" });
    expect([onDecrease.statusCode, onDecrease.json().code]).toEqual([400, "validation-failed"]);

    const balances = await asAdmin("GET", `/articles/${id}/batch-balances`);
    expect(balances.statusCode).toBe(200);
    expect(balances.json()).toMatchObject({
      batchTracked: true,
      batches: [
        { batchId: null, batchNumber: null, total: "2.0000" },
        { batchId: booked.json().batchId, batchNumber: "L-1", origin: "manual", total: "5.0000", locations: [{ locationId: location.id, locationName: "A1", quantity: "5.0000" }] },
      ],
    });
    expect((await asAdmin("GET", `/articles/${crypto.randomUUID()}/batch-balances`)).statusCode).toBe(404);

    const inUse = await asAdmin("PATCH", "/settings", { batchTrackingEnabled: false });
    expect([inUse.statusCode, inUse.json().code]).toEqual([409, "batch-tracking-in-use"]);
    const service = await asAdmin("PATCH", `/articles/${id}`, { type: "service", batchTracked: true });
    expect([service.statusCode, service.json().code]).toEqual([400, "article-not-batch-trackable"]);

    // Always allowed, stock in a named batch or not.
    expect((await asAdmin("PATCH", `/articles/${id}`, { batchTracked: false })).json().batchTracked).toBe(false);
    expect((await asAdmin("PATCH", "/settings", { batchTrackingEnabled: false })).json().batchTrackingEnabled).toBe(false);
  });
});
