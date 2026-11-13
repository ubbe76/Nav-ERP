import { createArticleSchema, createStockAdjustmentSchema, createStockLocationSchema, updateSystemSettingsSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, like, sql } from "drizzle-orm";
import { articles, db, numberSeries, stockBatches, stockTransactions, systemSettings } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import {
  BatchKindMismatchError,
  BatchNumberReservedError,
  isSerialBalanceViolation,
  SerialAlreadyInStockError,
  SerialCountMismatchError,
  SerialNumbersTooManyError,
} from "../src/modules/stock/service/batch.errors.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { getOrCreateBatch } from "../src/modules/stock/service/batches.js";
import {
  assertSerialsOutOfStock,
  claimSerialNumbers,
  DEFAULT_SERIAL_SERIES_KEY,
  getOrCreateSerials,
  lockSerials,
} from "../src/modules/stock/service/serial-numbers.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { BuiltInNumberSeriesError } from "../src/modules/system/service/system.service.js";
import { parsed } from "./helpers/parsed.js";
import { testSystemService } from "./helpers/services.js";

// Serienummer (#8 etapp 2, steg 3 — migration 0215): a serial number is a
// stock_batches row with kind = 'serial' whose balance is 0 or 1. This file:
// the leaf (get-or-create, the sort, the locks' helpers), the database guard
// (NV002), the series and claimSerialNumbers, and the positive justering.
// Inleverans and the TO's finished goods are in stock-serial-inflows.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));

const TRUNCATE = sql`TRUNCATE stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log CASCADE`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
// The common series back to SN-000001, the user's own serial series gone.
const resetSeries = async () => {
  await db.delete(numberSeries).where(like(numberSeries.key, "serial\\_%"));
  await db.update(numberSeries).set({ prefix: "SN-", nextNumber: 1, digits: 6 }).where(eq(numberSeries.key, DEFAULT_SERIAL_SERIES_KEY));
};

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
  await resetSeries();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
  await resetSeries();
});

let n = 0;
const makeArticle = (patch: Record<string, unknown> = {}) =>
  articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `SN-ART-${++n}-${crypto.randomUUID().slice(0, 6)}`, name: "Pump", type: "manufactured", active: true, tracking: "serial", ...patch })
  );
let places = 0;
async function makeLocation(name = "A1") {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${String(++places).padStart(4, "0")} ${crypto.randomUUID()}`, active: true });
  return (await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name, active: true })))!;
}
const batchesOf = (articleId: string) => db.select().from(stockBatches).where(eq(stockBatches.articleId, articleId)).orderBy(asc(stockBatches.batchNumber));
// A raw stock row — what a writer that forgot the rule would do.
const book = (articleId: string, locationId: string, batchId: string | null, delta: number) =>
  db.insert(stockTransactions).values({ articleId, locationId, batchId, quantityDelta: String(delta), transactionType: "inventory_adjustment" });
const guardRefuses = async (work: Promise<unknown>) => {
  const err = await work.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, "the insert should have been refused").not.toBeNull();
  expect(isSerialBalanceViolation(err)).toBe(true);
};

describe("getOrCreateSerials", () => {
  it("creates one serial row per number, keeps the first spelling, and answers in the list's order", async () => {
    const a = await makeArticle();
    const first = await getOrCreateSerials(db, { articleId: a.id, serialNumbers: [" B-2 ", "A-1", "c-3"], origin: "purchase_receipt" });
    expect(first.map((s) => s.batchNumber)).toEqual(["B-2", "A-1", "c-3"]);
    expect((await batchesOf(a.id)).map((b) => [b.batchNumber, b.kind, b.origin])).toEqual([
      ["A-1", "serial", "purchase_receipt"],
      ["B-2", "serial", "purchase_receipt"],
      ["c-3", "serial", "purchase_receipt"],
    ]);
    // Again, in another case and order: the same rows, nothing new.
    const again = await getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["C-3", "b-2"], origin: "manual" });
    expect(again).toEqual([first[2], first[0]]);
    expect(await batchesOf(a.id)).toHaveLength(3);
    // Unique per ARTICLE: another article has its own A-1.
    const other = await makeArticle();
    const [theirs] = await getOrCreateSerials(db, { articleId: other.id, serialNumbers: ["A-1"], origin: "manual" });
    expect(theirs!.id).not.toBe(first[1]!.id);
  });

  it("refuses a number twice in the list (whatever the case), the reserved name and more than 1 000 numbers", async () => {
    const a = await makeArticle();
    const err = await getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["X-1", "X-2", "x-1"], origin: "manual" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SerialCountMismatchError);
    expect((err as Error).message).toBe("Serienummer x-1 förekommer flera gånger");
    await expect(getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["ÅÄÖ-1", "åäö-1"], origin: "manual" })).rejects.toThrow(SerialCountMismatchError);
    await expect(getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["Okänd"], origin: "manual" })).rejects.toThrow(BatchNumberReservedError);
    const many = Array.from({ length: 1001 }, (_, i) => `M-${i}`);
    await expect(getOrCreateSerials(db, { articleId: a.id, serialNumbers: many, origin: "manual" })).rejects.toThrow(SerialNumbersTooManyError);
    expect(await batchesOf(a.id)).toEqual([]);
  });

  it("a number is either a batch or a serial number on the article — 409 batch-kind-mismatch both ways", async () => {
    const a = await makeArticle();
    await getOrCreateBatch(db, { articleId: a.id, batchNumber: "L-1", origin: "manual" });
    await getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["S-1"], origin: "manual" });
    const asSerial = await getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["S-2", "l-1"], origin: "manual" }).catch((e: unknown) => e);
    expect(asSerial).toBeInstanceOf(BatchKindMismatchError);
    expect((asSerial as Error).message).toBe("L-1 finns redan som batch på artikeln och kan inte användas som serienummer");
    const asBatch = await getOrCreateBatch(db, { articleId: a.id, batchNumber: "s-1", origin: "manual" }).catch((e: unknown) => e);
    expect(asBatch).toBeInstanceOf(BatchKindMismatchError);
    expect((asBatch as Error).message).toBe("S-1 finns redan som serienummer på artikeln och kan inte användas som batch");
    // The serial sort through the single-row leaf too.
    expect((await getOrCreateBatch(db, { articleId: a.id, batchNumber: "S-1", origin: "manual", kind: "serial" })).batchNumber).toBe("S-1");
  });

  it("assertSerialsOutOfStock names the number and where it stands", async () => {
    const a = await makeArticle();
    const place = await makeLocation("B7");
    const [s1, s2] = await getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["S-1", "S-2"], origin: "manual" });
    await db.transaction(async (tx) => {
      await lockSerials(tx, [s2!.id, s1!.id]);
      await assertSerialsOutOfStock(tx, [s1!.id, s2!.id]);
    });
    await book(a.id, place.id, s2!.id, 1);
    const err = await assertSerialsOutOfStock(db, [s1!.id, s2!.id]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SerialAlreadyInStockError);
    expect((err as Error).message).toMatch(/^Serienummer S-2 finns redan i lager \(Lager .* — B7\)$/);
  });
});

describe("the database guard (trigger stock_transactions_serial_unit, NV002)", () => {
  it("a serial number's balance is 0 or 1 — in total and on the row's place — and it moves one at a time", async () => {
    const a = await makeArticle();
    const [here, there] = [await makeLocation("A1"), await makeLocation("B2")];
    const [s] = await getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["S-1"], origin: "manual" });
    // ±2 and a fraction are refused outright.
    await guardRefuses(book(a.id, here.id, s!.id, 2));
    await guardRefuses(book(a.id, here.id, s!.id, 0.5));
    // Out of stock it cannot be taken.
    await guardRefuses(book(a.id, here.id, s!.id, -1));
    await book(a.id, here.id, s!.id, 1);
    // In twice — on the same place or another — is refused.
    await guardRefuses(book(a.id, here.id, s!.id, 1));
    await guardRefuses(book(a.id, there.id, s!.id, 1));
    // Taken from the WRONG place: the total would be 0, the place −1.
    await guardRefuses(book(a.id, there.id, s!.id, -1));
    // A move written in one INSERT (both legs) is fine, as is out and in again.
    await db.insert(stockTransactions).values([
      { articleId: a.id, locationId: here.id, batchId: s!.id, quantityDelta: "-1", transactionType: "stock_transfer" },
      { articleId: a.id, locationId: there.id, batchId: s!.id, quantityDelta: "1", transactionType: "stock_transfer" },
    ]);
    await book(a.id, there.id, s!.id, -1);
    await book(a.id, here.id, s!.id, 1);
    // The same number twice in ONE insert is seen together.
    const [t] = await getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["S-2"], origin: "manual" });
    await guardRefuses(
      db.insert(stockTransactions).values([
        { articleId: a.id, locationId: here.id, batchId: t!.id, quantityDelta: "1", transactionType: "inventory_adjustment" },
        { articleId: a.id, locationId: there.id, batchId: t!.id, quantityDelta: "1", transactionType: "inventory_adjustment" },
      ])
    );
    const rows = await db.select().from(stockTransactions).where(eq(stockTransactions.articleId, a.id));
    expect(rows.reduce((sum, r) => sum + Number(r.quantityDelta), 0)).toBe(1);
  });

  it("batch rows and rows without a batch are untouched by it", async () => {
    const a = await makeArticle({ tracking: "batch" });
    const place = await makeLocation();
    const batch = await getOrCreateBatch(db, { articleId: a.id, batchNumber: "L-1", origin: "manual" });
    await book(a.id, place.id, batch.id, 5);
    await book(a.id, place.id, batch.id, 5.5);
    await book(a.id, place.id, batch.id, -20);
    await book(a.id, place.id, null, -3);
    expect(await db.select().from(stockTransactions).where(eq(stockTransactions.articleId, a.id))).toHaveLength(4);
  });
});

describe("the serial number series and claimSerialNumbers", () => {
  const claim = (articleId: string, count: number) => db.transaction((tx) => claimSerialNumbers(tx, { articleId, count }));
  const nextOf = async (key: string) => (await db.select().from(numberSeries).where(eq(numberSeries.key, key)))[0]!.nextNumber;

  it("the common series is seeded — SN- and six digits — and numbers the styck in order", async () => {
    const [seed] = await db.select().from(numberSeries).where(eq(numberSeries.key, "serial"));
    expect(seed).toMatchObject({ prefix: "SN-", digits: 6, forSerials: true, forArticles: false, name: null });
    const a = await makeArticle();
    const first = await claim(a.id, 3);
    expect(first.map((s) => s.batchNumber)).toEqual(["SN-000001", "SN-000002", "SN-000003"]);
    expect((await claim(a.id, 1)).map((s) => s.batchNumber)).toEqual(["SN-000004"]);
    expect((await batchesOf(a.id)).map((b) => [b.kind, b.origin])).toEqual(Array(4).fill(["serial", "manufacturing_order"]));
    expect(await nextOf("serial")).toBe(5);
    // The series is shared: another article goes on from there (the numbers are unique per article).
    expect((await claim((await makeArticle()).id, 1))[0]!.batchNumber).toBe("SN-000005");
  });

  it("steps over numbers the article already has — typed, imported, or a batch — and takes more until the count is there", async () => {
    const a = await makeArticle();
    await getOrCreateSerials(db, { articleId: a.id, serialNumbers: ["sn-000002"], origin: "manual" });
    await getOrCreateBatch(db, { articleId: a.id, batchNumber: "SN-000004", origin: "manual" });
    expect((await claim(a.id, 4)).map((s) => s.batchNumber)).toEqual(["SN-000001", "SN-000003", "SN-000005", "SN-000006"]);
    expect(await nextOf("serial")).toBe(7);
  });

  it("an article's own series with its own prefix — created under Nummerserier — instead of the common one", async () => {
    const own = await testSystemService.createArticleNumberSeries({ name: "Pumpar", prefix: "P", nextNumber: 100, digits: 0, forSerials: true });
    expect(own).toMatchObject({ forSerials: true, forArticles: false });
    expect(own.key).toMatch(/^serial_[0-9a-f]{12}$/);
    const a = await makeArticle({ serialSeriesKey: own.key });
    expect((await claim(a.id, 2)).map((s) => s.batchNumber)).toEqual(["P100", "P101"]);
    expect(await nextOf("serial")).toBe(1);
    // The card's list: the common one first, each with the number it would issue next.
    expect(await articleService.listSerialNumberSeries()).toEqual([
      { key: "serial", name: null, prefix: "SN-", digits: 6, isDefault: true, nextSerialNumber: "SN-000001" },
      { key: own.key, name: "Pumpar", prefix: "P", digits: 0, isDefault: false, nextSerialNumber: "P102" },
    ]);
    // A serial series is no article number series.
    expect((await articleService.listArticleNumberSeries()).map((s) => s.key)).not.toContain(own.key);

    // The built-in one can be reconfigured, never renamed or deleted; an own one can go — the article falls back.
    await expect(testSystemService.deleteNumberSeries("serial")).rejects.toThrow(BuiltInNumberSeriesError);
    await expect(testSystemService.updateNumberSeries("serial", { name: "Egen" })).rejects.toThrow(BuiltInNumberSeriesError);
    await testSystemService.updateNumberSeries("serial", { prefix: "S", digits: 3 });
    await testSystemService.deleteNumberSeries(own.key);
    expect((await db.select().from(articles).where(eq(articles.id, a.id)))[0]!.serialSeriesKey).toBeNull();
    expect((await claim(a.id, 1))[0]!.batchNumber).toBe("S001");
  });

  it("a rolled-back transaction burns no numbers; two simultaneous claims never get the same number", async () => {
    const a = await makeArticle();
    await expect(
      db.transaction(async (tx) => {
        await claimSerialNumbers(tx, { articleId: a.id, count: 5 });
        throw new Error("torrkörning");
      })
    ).rejects.toThrow("torrkörning");
    expect(await nextOf("serial")).toBe(1);
    expect(await batchesOf(a.id)).toEqual([]);

    const [x, y] = await Promise.all([claim(a.id, 20), claim(a.id, 20)]);
    const numbers = [...x, ...y].map((s) => s.batchNumber);
    expect(new Set(numbers).size).toBe(40);
    expect([...numbers].sort()).toEqual(Array.from({ length: 40 }, (_, i) => `SN-${String(i + 1).padStart(6, "0")}`));
    await expect(claim(a.id, 1001)).rejects.toThrow(SerialNumbersTooManyError);
    expect(await nextOf("serial")).toBe(41);
  });
});

describe("Positiv justering av en serienummerstyrd artikel", () => {
  const adjust = (articleId: string, locationId: string, quantityDelta: number, extra: Record<string, unknown> = {}) =>
    stockService.recordTransaction(parsed(createStockAdjustmentSchema, { articleId, locationId, quantityDelta, ...extra }));
  const cells = async (articleId: string) =>
    (
      await db
        .select({ number: stockBatches.batchNumber, kind: stockBatches.kind, quantity: sql<string>`sum(${stockTransactions.quantityDelta})` })
        .from(stockTransactions)
        .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
        .where(and(eq(stockTransactions.articleId, articleId)))
        .groupBy(stockBatches.batchNumber, stockBatches.kind)
    )
      .map((c) => `${c.number ?? "Okänd"}${c.kind === "serial" ? "#" : ""}=${Number(c.quantity)}`)
      .sort();

  it("a number is ONE styck that must not stand in stock; without a number the goods are Okänd in any quantity", async () => {
    const a = await makeArticle();
    const [a1, b2] = [await makeLocation("A1"), await makeLocation("B2")];
    const booked = await adjust(a.id, a1.id, 1, { batchNumber: " SN-77 " });
    expect(booked!.batchId).toEqual(expect.any(String));
    await expect(adjust(a.id, a1.id, 2, { batchNumber: "SN-78" })).rejects.toThrow(SerialCountMismatchError);
    await expect(adjust(a.id, a1.id, 1, { batchNumber: "sn-77" })).rejects.toThrow(SerialAlreadyInStockError);
    await expect(adjust(a.id, b2.id, 1, { batchNumber: "SN-77" })).rejects.toThrow(SerialAlreadyInStockError);
    // Old stock from before the article was serienummerstyrd can still be corrected.
    await adjust(a.id, a1.id, 2.5);
    expect(await cells(a.id)).toEqual(["Okänd=2.5", "SN-77#=1"]);
    // Nothing of the refused ones was created or booked.
    expect((await batchesOf(a.id)).map((b) => b.batchNumber)).toEqual(["SN-77"]);
  });

  it("Serienummer skapas: Vid utleverans — the stock is untracked, a number on a justering is refused like a batch on a plain article", async () => {
    const a = await makeArticle({ serialAssignedAt: "delivery" });
    const a1 = await makeLocation();
    await expect(adjust(a.id, a1.id, 1, { batchNumber: "SN-1" })).rejects.toMatchObject({ name: "BatchNotTrackedError" });
    const row = await adjust(a.id, a1.id, 4);
    expect(row!.batchId).toBeNull();
    expect(await batchesOf(a.id)).toEqual([]);
  });
});
