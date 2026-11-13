import { createArticleSchema, importExportQuerySchema, updateSystemSettingsSchema } from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db, stockBatches, stockLocations, stockTransactions, systemSettings, type Tx } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createImportExportRepository } from "../src/modules/import/repository/import-export.repository.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportExportService } from "../src/modules/import/service/import-export.service.js";
import { ImportValidationError, createImportService } from "../src/modules/import/service/import.service.js";
import { suggestStockBalanceMapping } from "../src/modules/import/service/stock-balances.js";
import { articleBatchBalances, batchCellsForArticles } from "../src/modules/stock/repository/batch-balances.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { lockArticlesForOutflow } from "../src/modules/stock/service/outflow-locations.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Batch (#8) in the saldoimport: the column Batch names a CELL of a
// batchstyrd article (a batch number, or Okänd) and Antal is then that
// cell's balance after the import. Without Batch the row is the whole place,
// as before (import-stock-balances.test.ts, untouched).

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const imports = createImportService(createImportRepository(db));
const exports = createImportExportService(createImportExportRepository(db), testArticleService);

const TRUNCATE = sql`TRUNCATE stock_count_sessions, stock_transactions, stock_locations, warehouses, articles CASCADE`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetSetting();
});

const MAPPING = { Artikelnummer: "articleNumber", Lager: "warehouseName", Lagerplats: "locationName", Antal: "quantity", "À-pris": "unitCost", Batch: "batchNumber" };
const input = (rows: string[][], extra: Record<string, unknown> = {}) => ({ mapping: MAPPING, rows, ...extra });

async function makeArticle(articleNumber: string, patch: Record<string, unknown> = {}) {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber, name: articleNumber, type: "purchased", active: true, batchTracked: true, ...patch })
  );
}

// "<place>/<batch | Okänd>=<quantity>" for every cell of the article, sorted.
async function cells(articleId: string) {
  const names = new Map((await db.select({ id: stockLocations.id, name: stockLocations.name }).from(stockLocations)).map((l) => [l.id, l.name]));
  return (await batchCellsForArticles(db, [articleId])).map((c) => `${names.get(c.locationId)}/${c.batchNumber ?? "Okänd"}=${c.quantity}`).sort();
}

async function rowsOf(articleId: string) {
  return db
    .select({ delta: stockTransactions.quantityDelta, unitCost: stockTransactions.unitCost, batchNumber: stockBatches.batchNumber, note: stockTransactions.note })
    .from(stockTransactions)
    .leftJoin(stockBatches, eq(stockBatches.id, stockTransactions.batchId))
    .where(eq(stockTransactions.articleId, articleId))
    .orderBy(asc(stockTransactions.createdAt), asc(stockTransactions.id));
}

describe("Importera lagersaldon — Batch", () => {
  it("the template's heading maps to the field", () => {
    expect(suggestStockBalanceMapping(["Artikelnummer", "Lager", "Lagerplats", "Antal", "À-pris", "Batch"])).toMatchObject({ Batch: "batchNumber" });
    expect(suggestStockBalanceMapping(["Batchnummer"])).toEqual({ Batchnummer: "batchNumber" });
  });

  it("books each row into its batch — created by the import — and the same file again changes nothing", async () => {
    const article = await makeArticle("BT-1", { standardCost: 10 });
    const file = input([
      ["BT-1", "Huvudlager", "A1", "10", "24,5", "L-2"],
      ["BT-1", "Huvudlager", "A1", "4", "", " L-10 "],
      ["BT-1", "Huvudlager", "B2", "6", "", "l-2"],
    ]);

    const preview = await imports.preview("stockBalances", file);
    expect(preview.summary).toMatchObject({ create: 3, error: 0 });
    // A preview creates nothing.
    expect(await db.select().from(stockBatches)).toEqual([]);

    const result = await imports.commit("stockBalances", file);
    expect(result).toMatchObject({ created: 3, updated: 0 });
    expect(await cells(article.id)).toEqual(["A1/L-10=4", "A1/L-2=10", "B2/L-2=6"]);
    const batches = await db.select().from(stockBatches).orderBy(asc(stockBatches.batchNumber));
    expect(batches.map((b) => [b.batchNumber, b.origin, b.articleId])).toEqual([
      ["L-10", "import", article.id],
      ["L-2", "import", article.id],
    ]);
    // An increase is priced as before: the row's À-pris, else the standard cost.
    // (One transaction, one created_at: the rows are compared sorted.)
    expect((await rowsOf(article.id)).map((r) => [Number(r.delta), r.unitCost, r.batchNumber, r.note]).sort((x, y) => Number(y[0]) - Number(x[0]))).toEqual([
      [10, "24.5000", "L-2", "Import av lagersaldo"],
      [6, "10.0000", "L-2", "Import av lagersaldo"],
      [4, "10.0000", "L-10", "Import av lagersaldo"],
    ]);

    const again = await imports.preview("stockBalances", file);
    expect(again.summary).toMatchObject({ skip: 3, create: 0, update: 0 });
    expect(await imports.commit("stockBalances", file)).toMatchObject({ created: 0, updated: 0 });
    expect(await rowsOf(article.id)).toHaveLength(3);
  });

  it("the batches of one import have the same age, so the batch number decides which is drawn first", async () => {
    const article = await makeArticle("BT-2");
    await imports.commit(
      "stockBalances",
      input([
        ["BT-2", "Huvudlager", "A1", "1", "", "L-10"],
        ["BT-2", "Huvudlager", "A1", "1", "", "L-9"],
        ["BT-2", "Huvudlager", "A1", "1", "", "L-1"],
        ["BT-2", "Huvudlager", "A1", "1", "", "Okänd"],
      ])
    );
    const created = await db.select({ createdAt: stockBatches.createdAt }).from(stockBatches);
    expect(new Set(created.map((b) => b.createdAt.getTime())).size).toBe(1);
    // compareBatches: Okänd first, then (same age) the number, numerically.
    expect((await articleBatchBalances(db, article.id)).map((b) => b.batchNumber)).toEqual([null, "L-1", "L-9", "L-10"]);
  });

  it("Antal is the CELL's balance after the import: a correction is booked in the batch, 0 empties it, the others are untouched", async () => {
    const article = await makeArticle("BT-3");
    await imports.commit(
      "stockBalances",
      input([
        ["BT-3", "Huvudlager", "A1", "10", "", "L-1"],
        ["BT-3", "Huvudlager", "A1", "5", "", "L-2"],
      ])
    );

    const corrected = input([
      ["BT-3", "Huvudlager", "A1", "7", "30", "L-1"],
      ["BT-3", "Huvudlager", "A1", "0", "", "L-2"],
      ["BT-3", "Huvudlager", "A1", "3", "", "L-3"],
    ]);
    const preview = await imports.preview("stockBalances", corrected);
    expect(preview.rows.map((r) => [r.action, r.values["currentQuantity"], r.values["change"]])).toEqual([
      ["update", 10, -3],
      ["update", 5, -5],
      ["create", 0, 3],
    ]);
    expect(preview.rows[0]!.warnings).toEqual(["Saldot minskar med 3", "À-priset används inte när saldot minskar"]);

    expect(await imports.commit("stockBalances", corrected)).toMatchObject({ created: 1, updated: 2 });
    expect(await cells(article.id)).toEqual(["A1/L-1=7", "A1/L-3=3"]);
    // The decrease is an outflow of the batch, unpriced.
    const booked = (await rowsOf(article.id)).filter((r) => !(Number(r.delta) === 10 && r.batchNumber === "L-1") && !(Number(r.delta) === 5 && r.batchNumber === "L-2"));
    expect(booked.map((r) => [Number(r.delta), r.unitCost, r.batchNumber]).sort((x, y) => Number(x[0]) - Number(y[0]))).toEqual([
      [-5, null, "L-2"],
      [-3, null, "L-1"],
      [3, null, "L-3"],
    ]);
  });

  it("Okänd names the stock without a batch as a cell of its own", async () => {
    const article = await makeArticle("BT-4");
    await imports.commit("stockBalances", input([["BT-4", "Huvudlager", "A1", "10", "", "L-1"]]));
    const location = (await db.select().from(stockLocations).where(eq(stockLocations.name, "A1")))[0]!;
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 4, transactionType: "inventory_adjustment" });

    // The Okänd cell holds 4 — the place 14.
    const preview = await imports.preview("stockBalances", input([["BT-4", "Huvudlager", "A1", "6", "", "okänd"]]));
    expect(preview.rows[0]!.values).toMatchObject({ currentQuantity: 4, change: 2 });
    await imports.commit("stockBalances", input([["BT-4", "Huvudlager", "A1", "6", "", "okänd"]]));
    expect(await cells(article.id)).toEqual(["A1/L-1=10", "A1/Okänd=6"]);
    // No batch is ever called Okänd.
    expect((await db.select().from(stockBatches)).map((b) => b.batchNumber)).toEqual(["L-1"]);
  });

  it("without Batch the row is the whole place, as before — an increase lands in Okänd", async () => {
    const article = await makeArticle("BT-5");
    await imports.commit("stockBalances", input([["BT-5", "Huvudlager", "A1", "10", "", "L-1"]]));

    const preview = await imports.preview("stockBalances", input([["BT-5", "Huvudlager", "A1", "15", "", ""]]));
    expect(preview.rows[0]!.values).toMatchObject({ currentQuantity: 10, change: 5 });
    await imports.commit("stockBalances", input([["BT-5", "Huvudlager", "A1", "15", "", ""]]));
    expect(await cells(article.id)).toEqual(["A1/L-1=10", "A1/Okänd=5"]);
  });

  it("row errors: Batch on an article that is not batchstyrd, both with and without Batch on one place, the same batch twice, a too long number", async () => {
    await makeArticle("BT-6");
    await makeArticle("PLAIN", { batchTracked: false });
    const rows = [
      ["PLAIN", "Huvudlager", "A1", "5", "", "L-1"],
      ["PLAIN", "Huvudlager", "A1", "5", "", "Okänd"],
      ["BT-6", "Huvudlager", "A1", "5", "", "L-1"],
      ["BT-6", "Huvudlager", "A1", "5", "", ""],
      ["BT-6", "Huvudlager", "B2", "5", "", "L-1"],
      ["BT-6", "Huvudlager", "B2", "5", "", "l-1"],
      ["BT-6", "Huvudlager", "C3", "5", "", "x".repeat(51)],
      // The same batch on another place, and another batch on the same place, are fine.
      ["BT-6", "Huvudlager", "B2", "5", "", "L-2"],
    ];
    const preview = await imports.preview("stockBalances", input(rows));
    expect(preview.rows.map((r) => r.errors)).toEqual([
      ["Artikeln PLAIN är inte batchstyrd — ta bort Batch eller gör artikeln batchstyrd först"],
      // The second PLAIN row is the same place again (its Batch was not accepted).
      ["Artikeln PLAIN är inte batchstyrd — ta bort Batch eller gör artikeln batchstyrd först", "Artikel PLAIN förekommer flera gånger på samma lagerplats i filen"],
      [],
      ["Artikel BT-6 har rader både med och utan Batch på samma lagerplats i filen — ange Batch på alla (Okänd för saldot utan batch) eller på ingen"],
      [],
      ["Artikel BT-6 förekommer flera gånger med samma batch på samma lagerplats i filen"],
      ["Batch får vara högst 50 tecken"],
      [],
    ]);
    await expect(imports.commit("stockBalances", input(rows))).rejects.toBeInstanceOf(ImportValidationError);
    expect(await db.select().from(stockTransactions)).toEqual([]);
    expect(await db.select().from(stockBatches)).toEqual([]);
  });

  it("skipExisting is per cell when Batch is filled", async () => {
    const article = await makeArticle("BT-7");
    await imports.commit("stockBalances", input([["BT-7", "Huvudlager", "A1", "10", "", "L-1"]]));
    const file = input(
      [
        ["BT-7", "Huvudlager", "A1", "3", "", "L-1"],
        ["BT-7", "Huvudlager", "A1", "3", "", "L-2"],
      ],
      { skipExisting: true }
    );
    const preview = await imports.preview("stockBalances", file);
    expect(preview.rows.map((r) => r.action)).toEqual(["skip", "create"]);
    await imports.commit("stockBalances", file);
    expect(await cells(article.id)).toEqual(["A1/L-1=10", "A1/L-2=3"]);
  });

  it("the import takes the draws' article lock for a batchstyrd article before it books", async () => {
    const article = await makeArticle("BT-8");
    await imports.commit("stockBalances", input([["BT-8", "Huvudlager", "A1", "10", "", "L-1"]]));

    let begun!: () => void;
    const ready = new Promise<void>((resolve) => (begun = resolve));
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => (release = resolve));
    const held = db.transaction(async (tx: Tx) => {
      await lockArticlesForOutflow(tx, [article.id]);
      begun();
      await mayCommit;
    });
    await ready;
    let outcome!: Promise<unknown>;
    try {
      outcome = imports.commit("stockBalances", input([["BT-8", "Huvudlager", "A1", "4", "", "L-1"]])).then(
        (value) => value,
        (err: unknown) => err
      );
      await waitForLockWaiter();
    } finally {
      release();
      await held;
    }
    expect(await outcome).toMatchObject({ updated: 1 });
    expect(await cells(article.id)).toEqual(["A1/L-1=4"]);
  });
});

describe("Exportera lagersaldon — Batch", () => {
  it("a batchstyrd article is exported per cell and reads back without a change; every other article per place", async () => {
    const tracked = await makeArticle("EX-B");
    const plain = await makeArticle("EX-P", { batchTracked: false });
    await imports.commit(
      "stockBalances",
      input([
        ["EX-B", "Huvudlager", "A1", "10", "", "L-1"],
        ["EX-B", "Huvudlager", "A1", "2,5", "", "Okänd"],
        ["EX-B", "Huvudlager", "B2", "4", "", "L-2"],
        ["EX-P", "Huvudlager", "A1", "7", "", ""],
      ])
    );

    const file = await exports.exportFile("stockBalances", importExportQuerySchema.parse({ format: "csv" }));
    const content = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
    const parsedFile = await imports.parse("stockBalances", content);
    expect(parsedFile.headers).toEqual(["Artikelnummer", "Lager", "Lagerplats", "Antal", "À-pris", "Batch"]);
    expect(parsedFile.rows).toEqual([
      ["EX-B", "Huvudlager", "A1", "10", "", "L-1"],
      ["EX-B", "Huvudlager", "A1", "2,5", "", "Okänd"],
      ["EX-B", "Huvudlager", "B2", "4", "", "L-2"],
      ["EX-P", "Huvudlager", "A1", "7", "", ""],
    ]);

    const roundTrip = { mapping: parsedFile.suggestedMapping, rows: parsedFile.rows };
    const preview = await imports.preview("stockBalances", roundTrip);
    expect(preview.summary).toMatchObject({ skip: 4, error: 0, create: 0, update: 0 });
    expect(await imports.commit("stockBalances", roundTrip)).toMatchObject({ created: 0, updated: 0 });
    expect(await rowsOf(tracked.id)).toHaveLength(3);
    expect(await rowsOf(plain.id)).toHaveLength(1);
  });
});
