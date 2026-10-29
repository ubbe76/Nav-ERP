import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, stockCountSessions, stockLocations, stockTransactions, warehouses } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { ImportValidationError, createImportService } from "../src/modules/import/service/import.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

// Lagersaldon (#3) through the import service and repository: Antal is the
// balance AFTER the import, the difference is booked as an
// inventory_adjustment, missing warehouses/locations are created, and the
// row's À-pris (else the standard cost) values an increase.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const imports = createImportService(createImportRepository(db));

const TRUNCATE = sql`TRUNCATE stock_count_sessions, stock_transactions, stock_locations, warehouses, articles CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const MAPPING = { Artikelnummer: "articleNumber", Lager: "warehouseName", Lagerplats: "locationName", Antal: "quantity", "À-pris": "unitCost" };
const input = (rows: string[][], extra: Record<string, unknown> = {}) => ({ mapping: MAPPING, rows, ...extra });

async function makeArticle(articleNumber: string, patch: Record<string, unknown> = {}) {
  return articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", unit: "st", active: true, ...patch } as never);
}

async function transactionsOf(articleId: string) {
  return db.select().from(stockTransactions).where(eq(stockTransactions.articleId, articleId));
}

async function balance(articleId: string, locationId: string) {
  const rows = await db
    .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
    .from(stockTransactions)
    .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
  return Number(rows[0]!.q);
}

describe("Importera lagersaldon", () => {
  it("books the balance at the row's price and creates the missing warehouse and location", async () => {
    const article = await makeArticle("PL-1", { standardCost: 10 });

    const preview = await imports.preview("stockBalances", input([["PL-1", "Huvudlager", "A1", "120", "24,5"]]));
    expect(preview.willCreate).toMatchObject({ warehouses: ["Huvudlager"], stockLocations: ["Huvudlager / A1"] });
    expect(preview.summary).toMatchObject({ create: 1, error: 0 });

    const result = await imports.commit("stockBalances", input([["PL-1", "Huvudlager", "A1", "120", "24,5"]]));
    expect(result).toMatchObject({ created: 1, updated: 0, registersCreated: { warehouses: ["Huvudlager"], stockLocations: ["Huvudlager / A1"] } });

    const [row] = await transactionsOf(article.id);
    expect(row).toMatchObject({ quantityDelta: "120.0000", unitCost: "24.5000", transactionType: "inventory_adjustment", note: "Import av lagersaldo" });
  });

  it("changes nothing on the same file twice, and books only the difference of a corrected file", async () => {
    const article = await makeArticle("PL-2", { standardCost: 10 });
    await imports.commit("stockBalances", input([["PL-2", "Huvudlager", "A1", "120", ""]]));
    const [location] = await db.select().from(stockLocations).where(eq(stockLocations.name, "A1"));

    const again = await imports.commit("stockBalances", input([["PL-2", "Huvudlager", "A1", "120", ""]]));
    expect(again).toMatchObject({ created: 0, updated: 0, skipped: 1 });
    expect(again.skippedRows[0]!.reason).toBe("Saldot är redan 120");
    expect(await transactionsOf(article.id)).toHaveLength(1);

    const corrected = await imports.preview("stockBalances", input([["PL-2", "Huvudlager", "A1", "100", "30"]]));
    expect(corrected.rows[0]).toMatchObject({ action: "update" });
    expect(corrected.rows[0]!.warnings).toEqual(["Saldot minskar med 20", "À-priset används inte när saldot minskar"]);
    await imports.commit("stockBalances", input([["PL-2", "Huvudlager", "A1", "100", "30"]]));
    expect(await balance(article.id, location!.id)).toBe(100);
    const decrease = (await transactionsOf(article.id)).find((t) => Number(t.quantityDelta) < 0);
    expect(decrease).toMatchObject({ quantityDelta: "-20.0000", unitCost: null });

    // 0 empties the place, which is then retired like any emptied location.
    await imports.commit("stockBalances", input([["PL-2", "Huvudlager", "A1", "0", ""]]));
    expect(await balance(article.id, location!.id)).toBe(0);
    const [retired] = await db.select().from(stockLocations).where(eq(stockLocations.id, location!.id));
    expect(retired!.active).toBe(false);
  });

  it("values an increase at the standard cost without À-pris, on the article's own location without a place", async () => {
    const warehouse = await stockService.createWarehouse({ name: "Lager 2", active: true });
    const own = await stockService.createLocation({ warehouseId: warehouse.id, name: "B7", active: true });
    const article = await makeArticle("PL-3", { standardCost: 7, defaultLocationId: own.id });

    await imports.commit("stockBalances", input([["PL-3", "", "", "5", ""]]));
    const [row] = await transactionsOf(article.id);
    expect(row).toMatchObject({ locationId: own.id, quantityDelta: "5.0000", unitCost: "7.0000" });
  });

  it("warns, and books without value, when there is neither À-pris nor standard cost", async () => {
    const article = await makeArticle("PL-4");
    const preview = await imports.preview("stockBalances", input([["PL-4", "Huvudlager", "A1", "3", ""]]));
    expect(preview.rows[0]!.warnings).toEqual(["Varken à-pris eller standardkostnad — lagervärdet för ökningen blir okänt"]);
    await imports.commit("stockBalances", input([["PL-4", "Huvudlager", "A1", "3", ""]]));
    expect((await transactionsOf(article.id))[0]!.unitCost).toBeNull();
  });

  it("resolves a location name alone when it is unique and refuses it when it is not", async () => {
    const a = await stockService.createWarehouse({ name: "Norr", active: true });
    const b = await stockService.createWarehouse({ name: "Syd", active: true });
    const unique = await stockService.createLocation({ warehouseId: a.id, name: "Unik", active: true });
    await stockService.createLocation({ warehouseId: a.id, name: "Dubbel", active: true });
    await stockService.createLocation({ warehouseId: b.id, name: "Dubbel", active: true });
    const article = await makeArticle("PL-5", { standardCost: 1 });

    const preview = await imports.preview(
      "stockBalances",
      input([
        ["PL-5", "", "unik", "2", ""],
        ["PL-5", "", "Dubbel", "2", ""],
        ["PL-5", "", "Saknas", "2", ""],
      ])
    );
    expect(preview.rows[0]!.errors).toEqual([]);
    expect(preview.rows[1]!.errors).toEqual(["Lagerplatsen Dubbel finns i flera lager (Norr, Syd) — ange lager"]);
    expect(preview.rows[2]!.errors).toEqual(["Lagerplatsen Saknas finns inte — ange lager så skapas den"]);

    await imports.commit("stockBalances", input([["PL-5", "", "unik", "2", ""]]));
    expect(await balance(article.id, unique.id)).toBe(2);
  });

  it("stops the whole import on a row error and writes nothing", async () => {
    await makeArticle("PL-6", { standardCost: 1 });
    await makeArticle("TJ-1", { type: "service" });
    await makeArticle("FA-1", { type: "manufactured", isPhantom: true });
    const rows = [
      ["PL-6", "Huvudlager", "A1", "5", ""],
      ["PL-6", "huvudlager", "a1", "6", ""],
      ["TJ-1", "Huvudlager", "A1", "1", ""],
      ["FA-1", "Huvudlager", "A1", "1", ""],
      ["PL-6", "Huvudlager", "A2", "-1", ""],
      ["PL-6", "Huvudlager", "", "1", ""],
      ["SAKNAS", "", "", "1", ""],
    ];
    const preview = await imports.preview("stockBalances", input(rows));
    expect(preview.rows.map((r) => r.errors)).toEqual([
      [],
      ["Artikel PL-6 förekommer flera gånger på samma lagerplats i filen"],
      ["Artikeln TJ-1 är en tjänst — tjänster lagerhålls inte"],
      ["Artikeln FA-1 är en fantomartikel — den lagerhålls aldrig"],
      ["Antal kan inte vara negativt — det är saldot efter importen"],
      ["Lagerplats saknas — ange lagerplatsen i lagret, eller lämna båda tomma för artikelns lagerplats"],
      ["Artikeln SAKNAS finns inte i artikelregistret"],
    ]);
    await expect(imports.commit("stockBalances", input(rows))).rejects.toBeInstanceOf(ImportValidationError);
    expect(await db.select().from(stockTransactions)).toHaveLength(0);
    // Nothing created either (new articles already got the "***" fallback).
    expect((await db.select().from(warehouses)).map((w) => w.name)).toEqual(["***"]);
  });

  it("leaves places with a balance alone with Hoppa över rader som redan finns", async () => {
    const article = await makeArticle("PL-7", { standardCost: 1 });
    await imports.commit("stockBalances", input([["PL-7", "Huvudlager", "A1", "10", ""]]));
    const result = await imports.commit(
      "stockBalances",
      input([["PL-7", "Huvudlager", "A1", "50", ""], ["PL-7", "Huvudlager", "A2", "4", ""]], { skipExisting: true })
    );
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    expect(result.skippedRows[0]!.reason).toBe("Platsen har redan saldo 10");
    expect((await transactionsOf(article.id)).map((t) => Number(t.quantityDelta)).sort((x, y) => x - y)).toEqual([4, 10]);
  });

  it("refuses a location under a stock count that blocks transactions", async () => {
    await makeArticle("PL-8", { standardCost: 1 });
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    await db.insert(stockCountSessions).values({ countNumber: "INV-1", locationId: location.id, blocksTransactions: true } as never);
    const preview = await imports.preview("stockBalances", input([["PL-8", "Huvudlager", "A1", "1", ""]]));
    expect(preview.rows[0]!.errors).toEqual(["Lagerplatsen inventeras just nu och är spärrad för lagerhändelser"]);
  });
});
