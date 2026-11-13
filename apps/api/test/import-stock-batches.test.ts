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
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
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
    expect((await articleBatchBalances(db, article.id, stockholmToday())).map((b) => b.batchNumber)).toEqual([null, "L-1", "L-9", "L-10"]);
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
    expect(parsedFile.headers).toEqual(["Artikelnummer", "Lager", "Lagerplats", "Antal", "À-pris", "Batch", "Serienummer", "Batchdatum", "Utgångsdatum"]);
    expect(parsedFile.rows).toEqual([
      ["EX-B", "Huvudlager", "A1", "10", "", "L-1", "", "", ""],
      ["EX-B", "Huvudlager", "A1", "2,5", "", "Okänd", "", "", ""],
      ["EX-B", "Huvudlager", "B2", "4", "", "L-2", "", "", ""],
      ["EX-P", "Huvudlager", "A1", "7", "", "", "", "", ""],
    ]);

    const roundTrip = { mapping: parsedFile.suggestedMapping, rows: parsedFile.rows };
    const preview = await imports.preview("stockBalances", roundTrip);
    expect(preview.summary).toMatchObject({ skip: 4, error: 0, create: 0, update: 0 });
    expect(await imports.commit("stockBalances", roundTrip)).toMatchObject({ created: 0, updated: 0 });
    expect(await rowsOf(tracked.id)).toHaveLength(3);
    expect(await rowsOf(plain.id)).toHaveLength(1);
  });
});

// Etapp 2: Batchdatum (the batch's age) and Utgångsdatum.
describe("Importera lagersaldon — Batchdatum och Utgångsdatum", () => {
  const DATED = { ...MAPPING, Batchdatum: "batchDate", Utgångsdatum: "expiresOn" };
  const dated = (rows: string[][]) => ({ mapping: DATED, rows });
  const batchDates = async () =>
    (await db.select().from(stockBatches).orderBy(asc(stockBatches.batchNumber))).map((b) => [b.batchNumber, b.batchDate, b.expiresOn]);

  it("the headings map to the fields — and nothing else does", () => {
    expect(suggestStockBalanceMapping(["Batch", "Batchdatum", "Utgångsdatum"])).toEqual({ Batch: "batchNumber", Batchdatum: "batchDate", Utgångsdatum: "expiresOn" });
    expect(suggestStockBalanceMapping(["Datum", "Leveransdatum", "Senaste inleverans"])).toEqual({ Datum: null, Leveransdatum: null, "Senaste inleverans": null });
  });

  it("Batchdatum decides the order the batches are drawn in, before the number; Utgångsdatum is stored", async () => {
    const article = await makeArticle("BD-1");
    await imports.commit(
      "stockBalances",
      dated([
        ["BD-1", "Huvudlager", "A1", "1", "", "L-1", "2026-03-01", ""],
        ["BD-1", "Huvudlager", "A1", "1", "", "L-2", "2026-01-15", ""],
        ["BD-1", "Huvudlager", "A1", "1", "", "L-3", "20251201", "2027/06/30"],
        ["BD-1", "Huvudlager", "A1", "1", "", "L-4", "", ""],
      ])
    );
    expect(await batchDates()).toEqual([
      ["L-1", "2026-03-01", null],
      ["L-2", "2026-01-15", null],
      ["L-3", "2025-12-01", "2027-06-30"],
      ["L-4", null, null],
    ]);
    // FEFO: the dated one first, then the undated by age — Batchdatum, and
    // L-4 (no Batchdatum) by the day it was created, today.
    expect((await articleBatchBalances(db, article.id, stockholmToday())).map((b) => b.batchNumber)).toEqual(["L-3", "L-2", "L-1", "L-4"]);
  });

  it("row errors: a date without a named batch, a bad date, two dates for one batch in the file", async () => {
    await makeArticle("BD-2");
    const preview = await imports.preview(
      "stockBalances",
      dated([
        ["BD-2", "Huvudlager", "A1", "1", "", "", "2026-01-01", ""],
        ["BD-2", "Huvudlager", "B1", "1", "", "Okänd", "", "2027-01-01"],
        ["BD-2", "Huvudlager", "C1", "1", "", "L-1", "i går", ""],
        ["BD-2", "Huvudlager", "D1", "1", "", "L-2", "2026-01-01", ""],
        ["BD-2", "Huvudlager", "E1", "1", "", "L-2", "2026-02-01", ""],
      ])
    );
    expect(preview.rows.map((r) => r.errors)).toEqual([
      ["Batchdatum kräver ett batchnummer i kolumnen Batch"],
      ["Utgångsdatum kräver ett batchnummer i kolumnen Batch"],
      ['Ogiltigt batchdatum: "i går" (ÅÅÅÅ-MM-DD)'],
      [],
      ["Batch L-2 har olika batchdatum i filen (2026-01-01 och 2026-02-01)"],
    ]);
  });

  it("fills in a batch without a date (also when the balance is unchanged); another date stays, with a warning", async () => {
    const article = await makeArticle("BD-3");
    await imports.commit("stockBalances", dated([["BD-3", "Huvudlager", "A1", "5", "", "L-1", "", ""]]));
    expect(await batchDates()).toEqual([["L-1", null, null]]);

    // The same balance, now with dates: not skipped, nothing booked.
    const fill = dated([["BD-3", "Huvudlager", "A1", "5", "", "L-1", "2026-02-02", "2027-02-02"]]);
    expect((await imports.preview("stockBalances", fill)).summary).toMatchObject({ update: 1, skip: 0, error: 0 });
    expect(await imports.commit("stockBalances", fill)).toMatchObject({ created: 0, updated: 1 });
    expect(await batchDates()).toEqual([["L-1", "2026-02-02", "2027-02-02"]]);
    expect(await rowsOf(article.id)).toHaveLength(1);
    // …and the same file again is skipped.
    expect((await imports.preview("stockBalances", fill)).summary).toMatchObject({ skip: 1, update: 0 });

    // Another date: the row goes through, the batch keeps its dates.
    const other = dated([["BD-3", "Huvudlager", "A1", "7", "", "L-1", "2025-01-01", "2028-01-01"]]);
    const preview = await imports.preview("stockBalances", other);
    expect(preview.rows[0]!.errors).toEqual([]);
    expect(preview.rows[0]!.warnings.slice(0, 2)).toEqual([
      "Batch L-1 har redan batchdatum 2026-02-02 — det står kvar (ändra det under Lager → Spårbarhet)",
      "Batch L-1 har redan utgångsdatum 2027-02-02 — det står kvar (ändra det under Lager → Spårbarhet)",
    ]);
    expect(await imports.commit("stockBalances", other)).toMatchObject({ updated: 1 });
    expect(await batchDates()).toEqual([["L-1", "2026-02-02", "2027-02-02"]]);
    expect(await cells(article.id)).toEqual(["A1/L-1=7"]);
  });

  it("export → import goes round with the dates", async () => {
    await makeArticle("BD-4");
    await imports.commit("stockBalances", dated([["BD-4", "Huvudlager", "A1", "3", "", "L-1", "2026-02-02", "2027-02-02"]]));
    const file = await exports.exportFile("stockBalances", importExportQuerySchema.parse({ format: "csv" }));
    const content = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
    const parsedFile = await imports.parse("stockBalances", content);
    expect(parsedFile.rows).toEqual([["BD-4", "Huvudlager", "A1", "3", "", "L-1", "", "2026-02-02", "2027-02-02"]]);
    const roundTrip = { mapping: parsedFile.suggestedMapping, rows: parsedFile.rows };
    expect((await imports.preview("stockBalances", roundTrip)).summary).toMatchObject({ skip: 1, error: 0, create: 0, update: 0 });
  });
});

// Serienummer (0215): the column names ONE serial number of a
// serienummerstyrd article (numbers created vid inleverans); Antal 0 or 1.
describe("Importera lagersaldon — Serienummer", () => {
  const SERIAL = { ...MAPPING, Serienummer: "serialNumber" };
  const serial = (rows: string[][]) => ({ mapping: SERIAL, rows });
  const kinds = async () => (await db.select().from(stockBatches).orderBy(asc(stockBatches.batchNumber))).map((b) => [b.batchNumber, b.kind, b.origin]);

  it("the heading maps to the field", () => {
    expect(suggestStockBalanceMapping(["Batch", "Serienummer"])).toEqual({ Batch: "batchNumber", Serienummer: "serialNumber" });
  });

  it("Antal 1 puts the number on the place, Antal 0 takes it away; the same file again changes nothing; a row without a number is Okänd", async () => {
    const article = await makeArticle("SN-1", { tracking: "serial", batchTracked: undefined });
    const file = serial([
      ["SN-1", "Huvudlager", "A1", "1", "", "", "S-001"],
      ["SN-1", "Huvudlager", "A1", "1", "", "", "S-002"],
      ["SN-1", "Huvudlager", "B2", "1", "", "", "S-003"],
    ]);
    expect((await imports.preview("stockBalances", file)).summary).toMatchObject({ create: 3, error: 0 });
    expect(await imports.commit("stockBalances", file)).toMatchObject({ created: 3 });
    expect(await cells(article.id)).toEqual(["A1/S-001=1", "A1/S-002=1", "B2/S-003=1"]);
    expect(await kinds()).toEqual([
      ["S-001", "serial", "import"],
      ["S-002", "serial", "import"],
      ["S-003", "serial", "import"],
    ]);
    expect((await imports.preview("stockBalances", file)).summary).toMatchObject({ skip: 3, create: 0, update: 0 });

    await imports.commit(
      "stockBalances",
      serial([
        ["SN-1", "Huvudlager", "A1", "0", "", "", "S-002"],
        // Old stock without a number is the place's Okänd, in any quantity.
        ["SN-1", "Huvudlager", "C3", "2,5", "", "", ""],
      ])
    );
    expect(await cells(article.id)).toEqual(["A1/S-001=1", "B2/S-003=1", "C3/Okänd=2.5"]);
    expect(await rowsOf(article.id)).toHaveLength(5);
  });

  it("row errors: another Antal than 0/1, a number twice in the file, Batch and Serienummer together, on another place, the wrong sort of article", async () => {
    const article = await makeArticle("SN-2", { tracking: "serial", batchTracked: undefined });
    await makeArticle("SN-B");
    await makeArticle("SN-D", { tracking: "serial", serialAssignedAt: "delivery", batchTracked: undefined });
    await imports.commit("stockBalances", serial([["SN-2", "Huvudlager", "A1", "1", "", "", "S-001"]]));
    const preview = await imports.preview(
      "stockBalances",
      serial([
        ["SN-2", "Huvudlager", "A1", "2", "", "", "S-010"],
        ["SN-2", "Huvudlager", "A1", "1", "", "", "S-011"],
        ["SN-2", "Huvudlager", "B2", "1", "", "", "s-011"],
        ["SN-2", "Huvudlager", "A1", "1", "", "L-1", "S-012"],
        ["SN-2", "Huvudlager", "B2", "1", "", "", "S-001"],
        ["SN-2", "Huvudlager", "A1", "1", "", "L-1", ""],
        ["SN-B", "Huvudlager", "A1", "1", "", "", "S-020"],
        ["SN-D", "Huvudlager", "A1", "1", "", "", "S-030"],
        // Vid utleverans: untracked stock, booked as before.
        ["SN-D", "Huvudlager", "B2", "4", "", "", ""],
      ])
    );
    expect(preview.rows.map((r) => r.errors)).toEqual([
      ["Antal ska vara 0 eller 1 på en rad med Serienummer"],
      [],
      ["Serienummer s-011 förekommer flera gånger i filen"],
      ["Ange antingen Batch eller Serienummer på raden, inte båda"],
      ["Serienummer S-001 finns på Huvudlager — A1 — flytta det dit det ska stå, eller sätt Antal 0 där först"],
      ["Artikeln SN-2 är serienummerstyrd — ange numret i kolumnen Serienummer, inte Batch"],
      ["Artikeln SN-B får inga serienummer vid inleverans — ta bort Serienummer, eller gör artikeln serienummerstyrd (Serienummer skapas: Vid inleverans) först"],
      ["Artikeln SN-D får inga serienummer vid inleverans — ta bort Serienummer, eller gör artikeln serienummerstyrd (Serienummer skapas: Vid inleverans) först"],
      [],
    ]);
    expect(await cells(article.id)).toEqual(["A1/S-001=1"]);
  });

  it("a number that is a batch on the article is a row error; export → import goes round with the numbers in their own column", async () => {
    const article = await makeArticle("SN-3");
    await imports.commit("stockBalances", input([["SN-3", "Huvudlager", "A1", "3", "", "L-1"]]));
    await articleService.updateArticle(article.id, { tracking: "serial" });
    const clash = await imports.preview("stockBalances", serial([["SN-3", "Huvudlager", "A1", "1", "", "", "l-1"]]));
    expect(clash.rows[0]!.errors).toEqual(["l-1 finns redan som batch på artikeln och kan inte användas som serienummer"]);
    await imports.commit("stockBalances", serial([["SN-3", "Huvudlager", "A1", "1", "", "", "S-1"]]));

    const file = await exports.exportFile("stockBalances", importExportQuerySchema.parse({ format: "csv" }));
    const content = typeof file.content === "string" ? Buffer.from(file.content, "utf8") : file.content;
    const parsedFile = await imports.parse("stockBalances", content);
    expect(parsedFile.headers).toEqual(["Artikelnummer", "Lager", "Lagerplats", "Antal", "À-pris", "Batch", "Serienummer", "Batchdatum", "Utgångsdatum"]);
    expect(parsedFile.rows).toEqual([
      ["SN-3", "Huvudlager", "A1", "3", "", "L-1", "", "", ""],
      ["SN-3", "Huvudlager", "A1", "1", "", "", "S-1", "", ""],
    ]);
    // The old BATCH cell of an article that is serienummerstyrd now is not importable as such
    // (the column Batch is refused there) — the serial row reads back unchanged.
    const roundTrip = { mapping: parsedFile.suggestedMapping, rows: [parsedFile.rows[1]!] };
    expect((await imports.preview("stockBalances", roundTrip)).summary).toMatchObject({ skip: 1, error: 0 });
  });
});
