import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articleSupplierPriceBreaks, articleSuppliers, articles as articlesTable, db, suppliers, units } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import type { ExistingArticle } from "../src/modules/import/service/articles.js";
import {
  netPrice,
  planSupplierPriceImport,
  suggestSupplierPriceMapping,
  type SupplierPriceImportDeps,
} from "../src/modules/import/service/supplier-prices.js";

// Monitor's two "Prislista Inköp" exports, headings in file order. The
// stafflat file repeats "Pris" — parse() renames the second one "Pris (2)".
const LISTA_HEADERS = [
  "Artikelnummer",
  "Artikelbenämning",
  "Artikeltyp",
  "Artikelkod",
  "Förvald",
  "Leverantör",
  "Namn",
  "Lev. art.nr",
  "Pris",
  "Ställpris",
  "Rabatt",
  "Prisdatum",
];
const STAFFLAT_HEADERS = [
  "Artikelnummer",
  "Artikelbenämning",
  "Artikeltyp",
  "Artikelkod",
  "Leverantör",
  "Namn",
  "Lev. art.nr",
  "Pris",
  "Ställpris",
  "Rabatt",
  "Prisdatum",
  "Gränsvärde antal",
  "Pris (2)",
];

const MAPPING: Record<string, string | null> = {
  Artikelnummer: "articleNumber",
  Leverantör: "supplierNumber",
  "Lev. art.nr": "supplierArticleNumber",
  Pris: "price",
  Rabatt: "discountPercent",
  Förvald: "isPrimary",
};
const BREAK_MAPPING: Record<string, string | null> = {
  Artikelnummer: "articleNumber",
  Leverantör: "supplierNumber",
  Pris: "price",
  Rabatt: "discountPercent",
  "Gränsvärde antal": "breakQuantity",
  "Pris (2)": "breakPrice",
};

function article(articleNumber: string, id: string): ExistingArticle {
  return {
    id,
    articleNumber,
    name: articleNumber,
    type: "purchased",
    unitCode: "st",
    unitId: "unit-st",
    isPhantom: false,
    groupCode: null,
    standardCost: null,
    weight: null,
    surfaceTreatment: null,
    colour: null,
    active: true,
  };
}

function fakeDeps(
  articles: ExistingArticle[] = [],
  supplierNumbers: string[] = ["50331388", "8949158"],
  catalog: { articleId: string; supplierNumber: string; id: string; isPrimary?: boolean }[] = []
): SupplierPriceImportDeps {
  return {
    async articlesByNumber(numbers) {
      return new Map(articles.filter((a) => numbers.includes(a.articleNumber)).map((a) => [a.articleNumber, a]));
    },
    async suppliersByNumber(numbers) {
      return new Map(supplierNumbers.filter((n) => numbers.includes(n)).map((n) => [n, { id: `sup-${n}` }]));
    },
    async articleSuppliersByArticle() {
      const map = new Map<string, Map<string, { id: string; isPrimary: boolean }>>();
      for (const row of catalog) {
        const perArticle = map.get(row.articleId) ?? new Map<string, { id: string; isPrimary: boolean }>();
        perArticle.set(`sup-${row.supplierNumber}`, { id: row.id, isPrimary: row.isPrimary ?? false });
        map.set(row.articleId, perArticle);
      }
      return map;
    },
  };
}

describe("suggestSupplierPriceMapping", () => {
  it("maps the plain Prislista-Inköp export, leaving Namn/Ställpris/Prisdatum alone", () => {
    const suggested = suggestSupplierPriceMapping(LISTA_HEADERS);
    expect(suggested).toEqual({
      Artikelnummer: "articleNumber",
      Artikelbenämning: null,
      Artikeltyp: null,
      Artikelkod: null,
      Förvald: "isPrimary",
      Leverantör: "supplierNumber",
      Namn: null,
      "Lev. art.nr": "supplierArticleNumber",
      Pris: "price",
      Ställpris: null,
      Rabatt: "discountPercent",
      Prisdatum: null,
    });
  });

  it("maps the stafflat export's second Pris column to the break price", () => {
    const suggested = suggestSupplierPriceMapping(STAFFLAT_HEADERS);
    expect(suggested["Pris"]).toBe("price");
    expect(suggested["Gränsvärde antal"]).toBe("breakQuantity");
    expect(suggested["Pris (2)"]).toBe("breakPrice");
    expect(suggested["Förvald"]).toBeUndefined();
  });
});

describe("netPrice", () => {
  it("bakes the discount into the price, 4 decimals", () => {
    expect(netPrice(100, 60)).toBe(40);
    expect(netPrice(55.47, 60)).toBe(22.188);
    expect(netPrice(3.52, 25)).toBe(2.64);
  });
});

describe("planSupplierPriceImport", () => {
  it("plans one catalog row per (article, supplier) with net prices and the primary flag", async () => {
    const plan = await planSupplierPriceImport(
      {
        mapping: MAPPING,
        rows: [
          ["10217", "50331388", "234588", "192,89", "", "false"],
          ["10217", "8949158", "", "78", "", "true"],
          ["2394-25X2", "50331388", "71754", "55,47", "60", "true"],
          ["1914-NV-19", "50331388", "25943", "", "", "false"],
        ],
      },
      fakeDeps([article("10217", "id-1"), article("2394-25X2", "id-2"), article("1914-NV-19", "id-3")])
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.rows.map((row) => row.action)).toEqual(["create", "create", "create", "create"]);
    expect(plan.rows[2]!.warnings).toEqual(["Rabatten 60 % är inbakad i priset"]);
    expect(plan.summary).toEqual({ create: 4, update: 0, skip: 0, error: 0, warning: 1 });
    expect(plan.breaksMapped).toBe(false);
    expect(plan.primaryArticleIds.sort()).toEqual(["id-1", "id-2"]);
    expect(plan.creates).toEqual([
      { articleId: "id-1", supplierId: "sup-50331388", supplierArticleNumber: "234588", price: 192.89, isPrimary: false, breaks: [] },
      { articleId: "id-1", supplierId: "sup-8949158", supplierArticleNumber: null, price: 78, isPrimary: true, breaks: [] },
      { articleId: "id-2", supplierId: "sup-50331388", supplierArticleNumber: "71754", price: 22.188, isPrimary: true, breaks: [] },
      { articleId: "id-3", supplierId: "sup-50331388", supplierArticleNumber: "25943", price: null, isPrimary: false, breaks: [] },
    ]);
  });

  it("groups the stafflat file's break rows under their catalog row, ignoring Gränsvärde ≤ 1 with a warning", async () => {
    const plan = await planSupplierPriceImport(
      {
        mapping: BREAK_MAPPING,
        rows: [
          ["10217", "50331388", "192,89", "", "12", "143,95"],
          ["10217", "50331388", "192,89", "", "24", "120,92"],
          ["10217", "50331388", "192,89", "", "48", "97,89"],
          ["S235JRC", "50331388", "1540,56", "", "0,63694275", "1197,12"],
          ["1914-NV-19", "50331388", "", "", "", ""],
        ],
      },
      fakeDeps([article("10217", "id-1"), article("S235JRC", "id-2"), article("1914-NV-19", "id-3")])
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.breaksMapped).toBe(true);
    expect(plan.rows[3]!.warnings).toEqual(["Gränsvärde 0,63694275 ignoreras (antal 1 är grundpriset)"]);
    // Rows count as rows in the preview, catalog rows in the result.
    expect(plan.summary.create).toBe(5);
    expect(plan.creates).toEqual([
      {
        articleId: "id-1",
        supplierId: "sup-50331388",
        supplierArticleNumber: null,
        price: 192.89,
        isPrimary: false,
        breaks: [
          { fromQuantity: 12, price: 143.95 },
          { fromQuantity: 24, price: 120.92 },
          { fromQuantity: 48, price: 97.89 },
        ],
      },
      { articleId: "id-2", supplierId: "sup-50331388", supplierArticleNumber: null, price: 1540.56, isPrimary: false, breaks: [] },
      { articleId: "id-3", supplierId: "sup-50331388", supplierArticleNumber: null, price: null, isPrimary: false, breaks: [] },
    ]);
  });

  it("applies the row's discount to the break price too", async () => {
    const plan = await planSupplierPriceImport(
      { mapping: BREAK_MAPPING, rows: [["A", "50331388", "100", "60", "10", "80"]] },
      fakeDeps([article("A", "id-1")])
    );
    expect(plan.creates[0]).toMatchObject({ price: 40, breaks: [{ fromQuantity: 10, price: 32 }] });
  });

  it("updates an existing catalog row and replaces its breaks; skipExisting skips the whole group", async () => {
    const deps = fakeDeps([article("A", "id-1")], ["50331388"], [{ articleId: "id-1", supplierNumber: "50331388", id: "cat-1", isPrimary: true }]);
    const update = await planSupplierPriceImport(
      {
        mapping: BREAK_MAPPING,
        rows: [
          ["A", "50331388", "100", "", "10", "90"],
          ["A", "50331388", "100", "", "20", "80"],
        ],
      },
      deps
    );
    expect(update.rows.map((row) => row.action)).toEqual(["update", "update"]);
    expect(update.creates).toEqual([]);
    expect(update.updates).toEqual([
      { id: "cat-1", articleId: "id-1", patch: { price: 100 }, breaks: [{ fromQuantity: 10, price: 90 }, { fromQuantity: 20, price: 80 }] },
    ]);
    // Förvald is not in this file, so the primary flag is left alone.
    expect(update.primaryArticleIds).toEqual([]);

    const skip = await planSupplierPriceImport(
      {
        mapping: BREAK_MAPPING,
        rows: [
          ["A", "50331388", "100", "", "10", "90"],
          ["A", "50331388", "100", "", "20", "80"],
        ],
        skipExisting: true,
      },
      deps
    );
    expect(skip.rows.map((row) => row.action)).toEqual(["skip", "skip"]);
    expect(skip.summary.skip).toBe(2);
    expect(skip.updates).toEqual([]);
  });

  it("leaves the price untouched on update when the cell is empty", async () => {
    const plan = await planSupplierPriceImport(
      { mapping: MAPPING, rows: [["A", "50331388", "NEW-NR", "", "", "true"]] },
      fakeDeps([article("A", "id-1")], ["50331388"], [{ articleId: "id-1", supplierNumber: "50331388", id: "cat-1" }])
    );
    expect(plan.updates[0]!.patch).toEqual({ supplierArticleNumber: "NEW-NR", isPrimary: true });
    expect(plan.primaryArticleIds).toEqual(["id-1"]);
  });

  it("errors on unknown articles/suppliers, a break without a price, duplicate breaks and two primaries", async () => {
    const plan = await planSupplierPriceImport(
      {
        mapping: { ...BREAK_MAPPING, Förvald: "isPrimary" },
        rows: [
          ["SAKNAS", "50331388", "1", "", "", "", ""],
          ["A", "99", "1", "", "", "", ""],
          ["A", "50331388", "1", "", "10", "", ""],
          ["A", "50331388", "1", "", "20", "5", ""],
          ["A", "50331388", "1", "", "20", "4", ""],
          ["B", "50331388", "1", "", "", "", "true"],
          ["B", "8949158", "1", "", "", "", "true"],
          ["C", "50331388", "1", "150", "", "", ""],
        ],
      },
      fakeDeps([article("A", "id-a"), article("B", "id-b"), article("C", "id-c")])
    );
    expect(plan.rows.map((row) => row.errors)).toEqual([
      ["Artikeln SAKNAS finns inte i artikelregistret"],
      ["Leverantören 99 finns inte i leverantörsregistret"],
      ["Staffelpris saknas för gränsvärdet 10"],
      [],
      ["Gränsvärdet 20 förekommer flera gånger för artikel A och leverantör 50331388"],
      [],
      ["Artikel B har flera leverantörer markerade Förvald i filen"],
      ["Rabatten måste vara mellan 0 och 100 procent"],
    ]);
    expect(plan.hasErrors).toBe(true);
    expect(plan.creates).toEqual([]);
  });
});

// --- Database ---

const repo = createImportRepository(db);
const importService = createImportService(repo);

const TRUNCATE = sql`TRUNCATE article_supplier_price_breaks, article_suppliers, bom_components, articles, suppliers CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function seedUnit() {
  await db.insert(units).values({ code: "st", name: "Styck" }).onConflictDoNothing();
  const [unit] = await db.select({ id: units.id }).from(units).where(eq(units.code, "st"));
  return unit!.id;
}

async function seedArticle(articleNumber: string) {
  const unitId = await seedUnit();
  const [row] = await db
    .insert(articlesTable)
    .values({ articleNumber, name: articleNumber, type: "purchased", unitId })
    .returning({ id: articlesTable.id });
  return row!.id;
}

async function seedSupplier(supplierNumber: string) {
  const [row] = await db
    .insert(suppliers)
    .values({ supplierNumber, name: `Leverantör ${supplierNumber}` })
    .returning({ id: suppliers.id });
  return row!.id;
}

describe("supplier price import — repository and service", () => {
  it("accepts supplierPrices in the entity enum", () => {
    expect(importEntitySchema.options).toContain("supplierPrices");
  });

  it("creates catalog rows, demotes the previous primary and writes the staffel in one transaction", async () => {
    const articleId = await seedArticle("A");
    const oldSupplier = await seedSupplier("1");
    const newSupplier = await seedSupplier("2");
    await db.insert(articleSuppliers).values({ articleId, supplierId: oldSupplier, price: "10", isPrimary: true });

    const plain = await importService.commit("supplierPrices", {
      mapping: MAPPING,
      rows: [["A", "2", "X-1", "100", "10", "true"]],
    });
    expect(plain).toMatchObject({ created: 1, updated: 0, skipped: 0 });
    const rows = await db.select().from(articleSuppliers).where(eq(articleSuppliers.articleId, articleId));
    expect(rows.find((r) => r.supplierId === oldSupplier)!.isPrimary).toBe(false);
    const created = rows.find((r) => r.supplierId === newSupplier)!;
    expect(created).toMatchObject({ isPrimary: true, price: "90.0000", supplierArticleNumber: "X-1" });

    // The stafflat file: replaces the (empty) break set, leaves Förvald alone.
    const stafflat = await importService.commit("supplierPrices", {
      mapping: BREAK_MAPPING,
      rows: [
        ["A", "2", "100", "10", "10", "80"],
        ["A", "2", "100", "10", "50", "70"],
      ],
    });
    expect(stafflat).toMatchObject({ created: 0, updated: 1 });
    const breaks = await db
      .select()
      .from(articleSupplierPriceBreaks)
      .where(eq(articleSupplierPriceBreaks.articleSupplierId, created.id));
    expect(breaks.map((b) => [b.fromQuantity, b.price])).toEqual([
      ["10.0000", "72.0000"],
      ["50.0000", "63.0000"],
    ]);
    const [after] = await db.select().from(articleSuppliers).where(eq(articleSuppliers.id, created.id));
    expect(after!.isPrimary).toBe(true);

    // Re-running the plain list never touches the staffel.
    await importService.commit("supplierPrices", { mapping: MAPPING, rows: [["A", "2", "X-1", "100", "10", "true"]] });
    expect(await db.select().from(articleSupplierPriceBreaks)).toHaveLength(2);
  });
});
