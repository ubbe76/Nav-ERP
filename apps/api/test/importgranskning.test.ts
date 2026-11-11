import { createArticleSchema, createStockLocationSchema } from "@navet/shared";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  articleGroups,
  articleUnits,
  articles as articlesTable,
  bomComponents,
  db,
  routingOperations,
  stockCountSessions,
  stockLocations,
  stockTransactions,
  units,
  warehouses,
  workCenters,
} from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import { OPERATION_HAS_LINKED_MATERIAL_MESSAGE } from "../src/modules/import/service/routing.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { parsed } from "./helpers/parsed.js";

// Importgranskningen 2026-11-11, artikelsidan: the structure's row order
// (import, Kopiera från, a re-run with Uppdatera befintliga strukturrader,
// migration 0207), the operation import's Kalkyl on an operation that draws
// material, the saldoimport's "***" with a Lager and Antal 0 on a new place,
// a new varugrupp whose name is taken, and the unit import's Ja on the
// grundenhet's row.

const articleRepo = createArticleRepository(db);
const articleService = createArticleService(articleRepo);
const stockService = createStockService(createStockRepository(db));
const imports = createImportService(createImportRepository(db));

const TRUNCATE = sql`TRUNCATE stock_count_sessions, stock_transactions, stock_locations, warehouses, bom_components,
  routing_operations, work_centers, article_units, articles, article_groups CASCADE`;
// Unit codes these tests invent — units itself is shared with the other files.
const TEST_UNIT_CODES = ["zzrulle"];

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(units).where(inArray(units.code, TEST_UNIT_CODES));
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(units).where(inArray(units.code, TEST_UNIT_CODES));
});

async function unitId(code: string, name = code) {
  await db.insert(units).values({ code, name }).onConflictDoNothing();
  const [unit] = await db.select({ id: units.id }).from(units).where(eq(units.code, code));
  return unit!.id;
}

async function seedArticles(numbers: string[], type: "manufactured" | "purchased" = "purchased", unit = "st") {
  const id = await unitId(unit, unit === "st" ? "Styck" : unit);
  const rows = await db
    .insert(articlesTable)
    .values(numbers.map((articleNumber) => ({ articleNumber, name: articleNumber, type, unitId: id })))
    .returning({ id: articlesTable.id, articleNumber: articlesTable.articleNumber });
  return new Map(rows.map((row) => [row.articleNumber, row.id]));
}

// The structure as the card lists it.
async function cardRows(parentId: string) {
  return articleRepo.getBomComponents(parentId);
}

const BOM_MAPPING = { Artikelnummer: "articleNumber", Komponentnummer: "componentNumber", Antal: "quantity" };

describe("strukturradernas ordning", () => {
  it("lists an imported structure in the file's order, across the import's chunks", async () => {
    // 520 rows: more than one 500-row insert statement, so the running index
    // has to carry over the chunk boundary.
    const numbers = Array.from({ length: 520 }, (_, i) => `K-${String(i).padStart(3, "0")}`);
    // File order that is neither the article numbers' nor the ids'.
    const fileOrder = numbers.map((_, i) => numbers[(i * 37) % numbers.length]!);
    expect(new Set(fileOrder).size).toBe(520);
    const parent = (await seedArticles(["A-1"], "manufactured")).get("A-1")!;
    await seedArticles(numbers);

    const result = await imports.commit("bom", {
      mapping: BOM_MAPPING,
      rows: fileOrder.map((number, i) => ["A-1", number, String(i + 1)]),
    });
    expect(result.created).toBe(520);

    const rows = await cardRows(parent);
    expect(rows.map((row) => row.componentArticleNumber)).toEqual(fileOrder);
    // Every row has its own instant — nothing is left to the uuid.
    const stamps = await db.select({ at: sql<string>`created_at::text` }).from(bomComponents).where(eq(bomComponents.parentArticleId, parent));
    expect(new Set(stamps.map((s) => s.at)).size).toBe(520);
  });

  it("keeps the order per parent when the file interleaves two structures", async () => {
    const parents = await seedArticles(["A-1", "A-2"], "manufactured");
    const numbers = Array.from({ length: 12 }, (_, i) => `K-${i}`);
    await seedArticles(numbers);
    const rows = numbers.flatMap((number, i) => [
      ["A-1", number, "1"],
      ["A-2", numbers[numbers.length - 1 - i]!, "1"],
    ]);
    await imports.commit("bom", { mapping: BOM_MAPPING, rows });

    expect((await cardRows(parents.get("A-1")!)).map((r) => r.componentArticleNumber)).toEqual(numbers);
    expect((await cardRows(parents.get("A-2")!)).map((r) => r.componentArticleNumber)).toEqual([...numbers].reverse());
  });

  it("Kopiera från gives the new article the source's order", async () => {
    const source = (await seedArticles(["SRC"], "manufactured")).get("SRC")!;
    const numbers = Array.from({ length: 30 }, (_, i) => `K-${i}`);
    await seedArticles(numbers);
    const fileOrder = numbers.map((_, i) => numbers[(i * 7) % numbers.length]!);
    await imports.commit("bom", { mapping: BOM_MAPPING, rows: fileOrder.map((number) => ["SRC", number, "1"]) });
    expect((await cardRows(source)).map((r) => r.componentArticleNumber)).toEqual(fileOrder);

    const copy = await articleService.createArticle(
      parsed(createArticleSchema, {
        articleNumber: "COPY",
        name: "Kopia",
        type: "manufactured",
        copyFrom: { articleId: source, parts: ["beredning"] },
      })
    );

    expect((await cardRows(copy.id)).map((r) => r.componentArticleNumber)).toEqual(fileOrder);
  });

  it("a re-run with Uppdatera befintliga strukturrader updates each repeated row, not its neighbour", async () => {
    const parent = (await seedArticles(["A-1"], "manufactured")).get("A-1")!;
    await seedArticles(["K-1"]);
    // The same component on eight rows, no Pos. — only the order tells them apart.
    const first = Array.from({ length: 8 }, (_, i) => ["A-1", "K-1", String(i + 1)]);
    await imports.commit("bom", { mapping: BOM_MAPPING, rows: first });
    const before = await cardRows(parent);
    expect(before.map((row) => Number(row.quantity))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    // The same file with every antal + 10.
    const second = first.map(([a, k, q]) => [a!, k!, String(Number(q) + 10)]);
    const result = await imports.commit("bom", { mapping: BOM_MAPPING, rows: second, updateExisting: true });
    expect(result).toMatchObject({ created: 0, updated: 8 });

    const after = await cardRows(parent);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => Number(row.quantity))).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
  });
});

describe("migration 0207 — strukturrader med samma tidsstämpel ordnas efter Pos.", () => {
  const statements = readFileSync(new URL("../../../packages/db/drizzle/0207_strukturradernas_ordning.sql", import.meta.url), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const migrate = () =>
    db.transaction(async (tx) => {
      for (const statement of statements) await tx.execute(sql.raw(statement));
    });

  const stored = (parentId: string) =>
    db
      .select({
        id: bomComponents.id,
        position: bomComponents.position,
        at: sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`,
      })
      .from(bomComponents)
      .where(eq(bomComponents.parentArticleId, parentId))
      .orderBy(asc(bomComponents.createdAt), asc(bomComponents.id));

  it("orders a group numerically by Pos., then by its text, rows without Pos. last by id — and leaves single rows alone", async () => {
    const parents = await seedArticles(["A-1", "A-2", "A-3"], "manufactured");
    const component = (await seedArticles(["K-1"])).get("K-1")!;
    const a1 = parents.get("A-1")!;
    const a2 = parents.get("A-2")!;
    const a3 = parents.get("A-3")!;
    const group = new Date("2026-09-06T10:00:00.123Z");
    const row = (parentArticleId: string, position: string | null, createdAt: Date) => ({
      parentArticleId,
      componentArticleId: component,
      quantity: "1",
      position,
      createdAt,
    });
    await db.insert(bomComponents).values([
      // One import's rows: the same instant on every row.
      ...["10", "2", null, "B", "2a", "A", " 1", null, "100", ""].map((position) => row(a1, position, group)),
      // A row added by hand later, and a single row on another article.
      row(a1, "1", new Date("2026-09-07T08:00:00Z")),
      row(a2, "7", group),
      // Another article's own group at the same instant.
      row(a3, "20", group),
      row(a3, "3", group),
    ]);
    const blanksById = (await stored(a1)).filter((r) => r.position === null || r.position === "").map((r) => r.id);
    const untouched = await stored(a2);

    await migrate();

    const after = await stored(a1);
    expect(after.slice(0, 7).map((r) => r.position)).toEqual([" 1", "2", "2a", "10", "100", "A", "B"]);
    // Rows without a Pos. keep the order they had (id), after the others.
    expect(after.slice(7, 10).map((r) => r.id)).toEqual(blanksById);
    // The row added later is still last.
    expect(after[10]!.position).toBe("1");
    // The group keeps its instant; each row is one microsecond after the last.
    expect(after.slice(0, 10).map((r) => r.at)).toEqual(
      Array.from({ length: 10 }, (_, i) => `2026-09-06 10:00:00.${123000 + i}`)
    );
    expect(await stored(a2)).toEqual(untouched);
    expect((await stored(a3)).map((r) => r.position)).toEqual(["3", "20"]);

    // Nothing shares an instant any more — a second run changes nothing.
    const once = [...(await stored(a1)), ...(await stored(a3))];
    await migrate();
    expect([...(await stored(a1)), ...(await stored(a3))]).toEqual(once);
  });
});

describe("operationsimportens Kalkyl på en operation med kopplat material", () => {
  const ROUTING_MAPPING = {
    Artikelnummer: "articleNumber",
    Sekvensnr: "sequenceNo",
    Resurs: "workCenterCode",
    "Ställtid": "setupTime",
    "Tid/enhet": "runTimePerUnit",
    Kalkyl: "costingOnly",
  };

  async function fixture(rowCostingOnly: boolean) {
    const parent = (await seedArticles(["A-1"], "manufactured")).get("A-1")!;
    const component = (await seedArticles(["K-1"])).get("K-1")!;
    const [workCenter] = await db.insert(workCenters).values({ code: "110", name: "Resurs 110" }).returning({ id: workCenters.id });
    const [operation] = await db
      .insert(routingOperations)
      .values({ articleId: parent, sequenceNo: 10, workCenterId: workCenter!.id, setupTime: "1", runTimePerUnit: "1" })
      .returning({ id: routingOperations.id });
    await db.insert(bomComponents).values({
      parentArticleId: parent,
      componentArticleId: component,
      quantity: "1",
      routingOperationId: operation!.id,
      costingOnly: rowCostingOnly,
    });
    return operation!.id;
  }
  const file = (kalkyl: string) => ({ mapping: ROUTING_MAPPING, rows: [["A-1", "10", "110", "5", "2", kalkyl]], updateExisting: true });

  it("is a row error with the card's text, and nothing is written", async () => {
    const operationId = await fixture(false);

    const preview = await imports.preview("routing", file("Ja"));
    expect(preview.rows[0]!.errors).toEqual([OPERATION_HAS_LINKED_MATERIAL_MESSAGE]);
    expect(OPERATION_HAS_LINKED_MATERIAL_MESSAGE).toContain("kan inte märkas Kalkyl");
    await expect(imports.commit("routing", file("Ja"))).rejects.toMatchObject({ name: "ImportValidationError" });

    const [operation] = await db.select().from(routingOperations).where(eq(routingOperations.id, operationId));
    expect(operation).toMatchObject({ costingOnly: false, setupTime: "1.00" });
  });

  it("still updates the operation when the file says Nej, and marks it Kalkyl when only a kalkylrad is linked", async () => {
    const operationId = await fixture(false);
    await imports.commit("routing", file("Nej"));
    expect((await db.select().from(routingOperations).where(eq(routingOperations.id, operationId)))[0]).toMatchObject({
      costingOnly: false,
      setupTime: "5.00",
    });

    // A kalkylrad's link has no effect (countBomComponentsForOperation's rule).
    await db.update(bomComponents).set({ costingOnly: true }).where(eq(bomComponents.routingOperationId, operationId));
    const preview = await imports.preview("routing", file("Ja"));
    expect(preview.rows[0]!.errors).toEqual([]);
    await imports.commit("routing", file("Ja"));
    expect((await db.select().from(routingOperations).where(eq(routingOperations.id, operationId)))[0]!.costingOnly).toBe(true);
  });
});

describe("saldoimporten", () => {
  const MAPPING = { Artikelnummer: "articleNumber", Lager: "warehouseName", Lagerplats: "locationName", Antal: "quantity" };
  const input = (rows: string[][], extra: Record<string, unknown> = {}) => ({ mapping: MAPPING, rows, ...extra });

  const makeArticle = (articleNumber: string) =>
    articleService.createArticle(
      parsed(createArticleSchema, { articleNumber, name: articleNumber, type: "purchased", active: true, standardCost: 10 })
    );
  const warehouseNames = async () => (await db.select({ name: warehouses.name }).from(warehouses)).map((w) => w.name).sort();
  const locationNames = async () => (await db.select({ name: stockLocations.name }).from(stockLocations)).map((l) => l.name).sort();
  async function balance(articleId: string, locationId: string) {
    const [row] = await db
      .select({ q: sql<string>`coalesce(sum(${stockTransactions.quantityDelta}), 0)` })
      .from(stockTransactions)
      .where(and(eq(stockTransactions.articleId, articleId), eq(stockTransactions.locationId, locationId)));
    return Number(row!.q);
  }
  const fallbackId = async () => (await db.select({ id: stockLocations.id }).from(stockLocations).where(eq(stockLocations.name, "***")))[0]!.id;

  describe("Lagerplats *** med ett Lager är reservplatsen", () => {
    it("previews today's balance on *** and creates neither the warehouse nor a place", async () => {
      const article = await makeArticle("PL-1");
      // 5 on "***" (a new article's place).
      await imports.commit("stockBalances", input([["PL-1", "", "", "5"]]));
      const fallback = await fallbackId();
      expect(await balance(article.id, fallback)).toBe(5);

      const preview = await imports.preview("stockBalances", input([["PL-1", "Nyttlager", "***", "8"]]));
      expect(preview.rows[0]).toMatchObject({ action: "update", errors: [], values: { currentQuantity: 5, change: 3 } });
      expect(preview.willCreate).toMatchObject({ warehouses: [], stockLocations: [] });

      const result = await imports.commit("stockBalances", input([["PL-1", "Nyttlager", "***", "8"]]));
      expect(result).toMatchObject({ created: 0, updated: 1, registersCreated: { warehouses: [], stockLocations: [] } });
      expect(await balance(article.id, fallback)).toBe(8);
      expect(await warehouseNames()).toEqual(["***"]);
      expect(await locationNames()).toEqual(["***"]);
    });

    it("skips the row when the balance is already there, and with Hoppa över rader som redan finns", async () => {
      await makeArticle("PL-2");
      await imports.commit("stockBalances", input([["PL-2", "", "", "5"]]));

      const same = await imports.preview("stockBalances", input([["PL-2", "Nyttlager", "***", "5"]]));
      expect(same.rows[0]).toMatchObject({ action: "skip" });
      const skip = await imports.preview("stockBalances", input([["PL-2", "Nyttlager", "***", "9"]], { skipExisting: true }));
      expect(skip.rows[0]).toMatchObject({ action: "skip" });
      expect(skip.willCreate).toMatchObject({ warehouses: [], stockLocations: [] });
    });

    it("sees the same place twice in the file, and the frysvakt on ***", async () => {
      await makeArticle("PL-3");
      await imports.commit("stockBalances", input([["PL-3", "", "", "5"]]));

      const twice = await imports.preview(
        "stockBalances",
        input([
          ["PL-3", "", "", "6"],
          ["PL-3", "Nyttlager", "***", "7"],
        ])
      );
      expect(twice.rows[1]!.errors).toEqual(["Artikel PL-3 förekommer flera gånger på samma lagerplats i filen"]);

      await db.insert(stockCountSessions).values({ countNumber: "INV-1", locationId: await fallbackId(), blocksTransactions: true } as never);
      const frozen = await imports.preview("stockBalances", input([["PL-3", "Nyttlager", "***", "7"]]));
      expect(frozen.rows[0]!.errors).toEqual(["Lagerplatsen inventeras just nu och är spärrad för lagerhändelser"]);
    });

    it("books on the one *** when the Lager exists and has no such place", async () => {
      const article = await makeArticle("PL-4");
      const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
      await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));

      const preview = await imports.preview("stockBalances", input([["PL-4", "Huvudlager", "***", "4"]]));
      expect(preview.willCreate).toMatchObject({ warehouses: [], stockLocations: [] });
      const result = await imports.commit("stockBalances", input([["PL-4", "Huvudlager", "***", "4"]]));
      expect(result.registersCreated).toMatchObject({ warehouses: [], stockLocations: [] });
      expect(await balance(article.id, await fallbackId())).toBe(4);
      expect(await locationNames()).toEqual(["***", "A1"]);
    });
  });

  describe("Antal 0 på en ny plats", () => {
    it("promises and creates nothing — neither the warehouse nor the place", async () => {
      await makeArticle("PL-5");
      const before = await warehouseNames();

      const preview = await imports.preview("stockBalances", input([["PL-5", "Nyttlager", "B9", "0"]]));
      expect(preview.rows[0]).toMatchObject({ action: "skip" });
      expect(preview.willCreate).toMatchObject({ warehouses: [], stockLocations: [] });

      const result = await imports.commit("stockBalances", input([["PL-5", "Nyttlager", "B9", "0"]]));
      expect(result).toMatchObject({ created: 0, updated: 0, registersCreated: { warehouses: [], stockLocations: [] } });
      expect(await warehouseNames()).toEqual(before);
    });

    it("creates the warehouse once for the rows that are booked, with the first booked spelling's place", async () => {
      await makeArticle("PL-6");
      await makeArticle("PL-7");
      const rows = [
        ["PL-6", "Nyttlager", "B9", "0"],
        ["PL-7", "Nyttlager", "B10", "3"],
      ];
      const preview = await imports.preview("stockBalances", input(rows));
      expect(preview.willCreate).toMatchObject({ warehouses: ["Nyttlager"], stockLocations: ["Nyttlager / B10"] });
      const result = await imports.commit("stockBalances", input(rows));
      expect(result.registersCreated).toMatchObject({ warehouses: ["Nyttlager"], stockLocations: ["Nyttlager / B10"] });
      expect((await locationNames()).filter((name) => name !== "***")).toEqual(["B10"]);
    });
  });
});

describe("artikelimportens nya varugrupp vars namn är upptaget", () => {
  it("creates the group with a suffixed name and puts the articles in it", async () => {
    // The group with code 30 is called "3" — the file's Varugrupp 3 is a new code.
    await db.insert(articleGroups).values({ code: "30", name: "3" });

    const result = await imports.commit("articles", {
      mapping: { Artikelnummer: "articleNumber", Benämning: "name", Varugrupp: "groupCode" },
      rows: [["VG-1", "Artikel i grupp 3", "3"]],
    });
    expect(result.registersCreated.articleGroups).toEqual(["3"]);

    const [group] = await db.select().from(articleGroups).where(eq(articleGroups.code, "3"));
    expect(group).toMatchObject({ code: "3", name: "3 (2)" });
    const [article] = await db.select().from(articlesTable).where(eq(articlesTable.articleNumber, "VG-1"));
    expect(article!.groupId).toBe(group!.id);
  });
});

describe("enhetsimportens Ja på grundenhetens rad", () => {
  const MAPPING = {
    Artikelnummer: "articleNumber",
    "Enh.": "unitCode",
    "Omr.faktor": "factor",
    "Inköpsorder": "isPurchaseUnit",
    Kundorder: "isSalesUnit",
  };

  async function fixture() {
    const articleId = (await seedArticles(["ZM310"], "purchased", "kg")).get("ZM310")!;
    const rulle = await unitId("zzrulle");
    await db.insert(articleUnits).values({ articleId, unitId: rulle, quantityPerBase: "0.020000" });
    // An earlier import made the alternative unit the default for both.
    await db.update(articlesTable).set({ purchaseUnitId: rulle, salesUnitId: rulle }).where(eq(articlesTable.id, articleId));
    return { articleId, rulle };
  }
  const articleRow = async (id: string) => (await db.select().from(articlesTable).where(eq(articlesTable.id, id)))[0]!;

  it("makes the grundenhet the default again for the column that says Ja, and leaves the other", async () => {
    const { articleId, rulle } = await fixture();

    const rows = [
      ["ZM310", "kg", "1", "Ja", "Nej"],
      ["ZM310", "zzrulle", "50", "Nej", "Nej"],
    ];
    const preview = await imports.preview("articleUnits", { mapping: MAPPING, rows });
    expect(preview.rows[0]).toMatchObject({ action: "skip", errors: [] });
    await imports.commit("articleUnits", { mapping: MAPPING, rows });

    expect(await articleRow(articleId)).toMatchObject({ purchaseUnitId: null, salesUnitId: rulle });
  });

  it("refuses Ja on both the grundenhet's row and an alternative row, whichever comes first", async () => {
    const { articleId, rulle } = await fixture();

    const baseFirst = await imports.preview("articleUnits", {
      mapping: MAPPING,
      rows: [
        ["ZM310", "kg", "1", "Ja", "Nej"],
        ["ZM310", "zzrulle", "50", "Ja", "Nej"],
      ],
    });
    expect(baseFirst.rows.map((row) => row.errors)).toEqual([[], ["Artikel ZM310 har flera enheter markerade Inköpsorder i filen"]]);

    const baseLast = await imports.preview("articleUnits", {
      mapping: MAPPING,
      rows: [
        ["ZM310", "zzrulle", "50", "Nej", "Ja"],
        ["ZM310", "kg", "1", "Nej", "Ja"],
      ],
    });
    expect(baseLast.rows.map((row) => row.errors)).toEqual([[], ["Artikel ZM310 har flera enheter markerade Kundorder i filen"]]);
    expect(await articleRow(articleId)).toMatchObject({ purchaseUnitId: rulle, salesUnitId: rulle });
  });
});
