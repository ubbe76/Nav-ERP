import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { articleUnits, articles as articlesTable, db, units } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { createImportService } from "../src/modules/import/service/import.service.js";
import type { ExistingArticle } from "../src/modules/import/service/articles.js";
import {
  planArticleUnitImport,
  suggestArticleUnitMapping,
  type ArticleUnitImportDeps,
} from "../src/modules/import/service/article-units.js";

// Monitor's "Artikellista, Enheter" headings, in file order.
const MONITOR_HEADERS = [
  "Artikelnummer",
  "Artikelbenämning",
  "Enh.",
  "Förvald",
  "Omr.faktor",
  "Materialuttag",
  "Inköpsorder",
  "Rapportera inleverans",
  "Kundorder",
  "Packa för leverans",
  "Rapportera utleverans",
  "Lagerrapportering",
  "Statistik",
];

const MAPPING: Record<string, string | null> = {
  Artikelnummer: "articleNumber",
  "Enh.": "unitCode",
  "Omr.faktor": "factor",
  "Inköpsorder": "isPurchaseUnit",
  Kundorder: "isSalesUnit",
};

function article(articleNumber: string, id: string, unitCode = "st"): ExistingArticle {
  return {
    id,
    articleNumber,
    name: articleNumber,
    type: "purchased",
    unitCode,
    unitId: `unit-${unitCode}`,
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
  unitCodes: string[] = ["st", "kg", "m"],
  factors: { articleId: string; unitCode: string; quantityPerBase: number }[] = []
): ArticleUnitImportDeps {
  return {
    async articlesByNumber(numbers) {
      return new Map(articles.filter((a) => numbers.includes(a.articleNumber)).map((a) => [a.articleNumber, a]));
    },
    async unitsByCode() {
      return new Map(unitCodes.map((code) => [code.toLowerCase(), { id: `unit-${code}`, code }]));
    },
    async articleUnitFactors() {
      const map = new Map<string, Map<string, number>>();
      for (const f of factors) {
        const perArticle = map.get(f.articleId) ?? new Map<string, number>();
        perArticle.set(`unit-${f.unitCode}`, f.quantityPerBase);
        map.set(f.articleId, perArticle);
      }
      return map;
    },
  };
}

describe("suggestArticleUnitMapping", () => {
  it("maps Monitor's Enheter export: Enh., Omr.faktor, Inköpsorder, Kundorder", () => {
    const suggested = suggestArticleUnitMapping(MONITOR_HEADERS);
    expect(suggested).toEqual({
      Artikelnummer: "articleNumber",
      Artikelbenämning: null,
      "Enh.": "unitCode",
      Förvald: null,
      "Omr.faktor": "factor",
      Materialuttag: null,
      "Inköpsorder": "isPurchaseUnit",
      "Rapportera inleverans": null,
      Kundorder: "isSalesUnit",
      "Packa för leverans": null,
      "Rapportera utleverans": null,
      Lagerrapportering: null,
      Statistik: null,
    });
  });

  it("recognises alternate spellings", () => {
    const suggested = suggestArticleUnitMapping(["Artnr", "Enhet", "Omräkningsfaktor", "Inköpsenhet", "Försäljningsenhet"]);
    expect(Object.values(suggested)).toEqual(["articleNumber", "unitCode", "factor", "isPurchaseUnit", "isSalesUnit"]);
  });
});

describe("planArticleUnitImport", () => {
  it("skips the base-unit row (factor 1) and inverts Monitor's factor for the alternative unit", async () => {
    // Ø12 rod: base kg, "m" says 0,89 = 0,89 kg per metre.
    const plan = await planArticleUnitImport(
      {
        mapping: MAPPING,
        rows: [
          ["S235JR-12", "kg", "1", "true", "true"],
          ["S235JR-12", "m", "0,89", "false", "false"],
        ],
      },
      fakeDeps([article("S235JR-12", "id-1", "kg")])
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.rows[0]).toMatchObject({ action: "skip", skipReason: "Grundenhet (faktor 1) — ingen alternativ enhet" });
    expect(plan.rows[0]!.warnings).toEqual([]);
    expect(plan.rows[1]!.action).toBe("create");
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 1, error: 0, warning: 0 });
    expect(plan.creates).toEqual([{ articleId: "id-1", unitCode: "m", quantityPerBase: 1.123596 }]);
    expect(plan.updates).toEqual([]);
    expect(plan.articleDefaults).toEqual([]);
    expect(plan.willCreate).toEqual({ units: [], articleGroups: [] });
  });

  it("warns when the factor-1 row names a different unit than the article's base unit", async () => {
    const plan = await planArticleUnitImport(
      { mapping: MAPPING, rows: [["A-1", "kg", "1", "", ""]] },
      fakeDeps([article("A-1", "id-1", "st")])
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.warnings).toEqual(["Grundenheten i filen (kg) avviker från artikelns grundenhet (st)"]);
    expect(plan.summary.warning).toBe(1);
  });

  it("refuses the article's base unit with a factor other than 1", async () => {
    const plan = await planArticleUnitImport(
      { mapping: MAPPING, rows: [["A-1", "ST", "5", "", ""]] },
      fakeDeps([article("A-1", "id-1", "st")])
    );
    expect(plan.rows[0]!.errors).toEqual(["Enheten ST är artikelns grundenhet och kan inte vara en alternativ enhet"]);
  });

  it("sets the default purchase/sales unit from Inköpsorder/Kundorder on an alternative row", async () => {
    const plan = await planArticleUnitImport(
      {
        mapping: MAPPING,
        rows: [
          ["ZM310", "kg", "1", "false", "false"],
          ["ZM310", "st", "50", "true", "true"],
        ],
      },
      fakeDeps([article("ZM310", "id-1", "kg")])
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates).toEqual([{ articleId: "id-1", unitCode: "st", quantityPerBase: 0.02 }]);
    expect(plan.articleDefaults).toEqual([{ articleId: "id-1", purchaseUnitCode: "st", salesUnitCode: "st" }]);
  });

  it("refuses two alternative units flagged as the purchase unit for one article", async () => {
    const plan = await planArticleUnitImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "kg", "2", "true", ""],
          ["A-1", "m", "3", "true", ""],
        ],
      },
      fakeDeps([article("A-1", "id-1")])
    );
    expect(plan.rows[1]!.errors).toEqual(["Artikel A-1 har flera enheter markerade Inköpsorder i filen"]);
  });

  it("updates an existing alternative unit's factor, or skips it with skipExisting", async () => {
    const deps = fakeDeps([article("A-1", "id-1")], ["st", "kg"], [{ articleId: "id-1", unitCode: "kg", quantityPerBase: 4 }]);
    const update = await planArticleUnitImport({ mapping: MAPPING, rows: [["A-1", "kg", "0,2", "", ""]] }, deps);
    expect(update.rows[0]!.action).toBe("update");
    expect(update.updates).toEqual([{ articleId: "id-1", unitId: "unit-kg", quantityPerBase: 5 }]);
    expect(update.creates).toEqual([]);

    const skip = await planArticleUnitImport(
      { mapping: MAPPING, rows: [["A-1", "kg", "0,2", "", ""]], skipExisting: true },
      deps
    );
    expect(skip.rows[0]).toMatchObject({ action: "skip", skipReason: "Enheten kg finns redan på artikel A-1" });
    expect(skip.updates).toEqual([]);
  });

  it("queues an unknown unit code for creation, case-insensitively", async () => {
    const plan = await planArticleUnitImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "Pall", "0,05", "", ""],
          ["A-2", "PALL", "0,1", "", ""],
        ],
      },
      fakeDeps([article("A-1", "id-1"), article("A-2", "id-2")], ["st"])
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.willCreate.units).toEqual(["Pall"]);
    expect(plan.creates.map((c) => c.quantityPerBase)).toEqual([20, 10]);
  });

  it("errors on unknown articles, missing/invalid factors, bad flags and in-file duplicates", async () => {
    const plan = await planArticleUnitImport(
      {
        mapping: MAPPING,
        rows: [
          ["SAKNAS", "kg", "2", "", ""],
          ["A-1", "", "2", "", ""],
          ["A-1", "kg", "", "", ""],
          ["A-1", "kg", "x", "", ""],
          ["A-1", "kg", "0", "", ""],
          ["A-1", "m", "2", "kanske", ""],
          ["A-1", "m", "2", "", ""],
          ["A-1", "m", "3", "", ""],
        ],
      },
      fakeDeps([article("A-1", "id-1")])
    );
    expect(plan.rows.map((row) => row.errors)).toEqual([
      ["Artikeln SAKNAS finns inte i artikelregistret"],
      ["Enhet saknas"],
      ["Omräkningsfaktor saknas"],
      ['Ogiltig omräkningsfaktor: "x"'],
      ["Omräkningsfaktorn måste vara större än 0"],
      ['Ogiltigt värde för Inköpsorder: "kanske" (Ja/Nej/1/0/true/false)'],
      [],
      ["Enheten m för artikel A-1 förekommer flera gånger i filen"],
    ]);
    expect(plan.hasErrors).toBe(true);
  });

  it("requires the three mandatory columns", async () => {
    await expect(
      planArticleUnitImport({ mapping: { Artikelnummer: "articleNumber", Enhet: "unitCode" }, rows: [] }, fakeDeps())
    ).rejects.toThrow(/factor/);
  });
});

// --- Database ---

const repo = createImportRepository(db);
const importService = createImportService(repo);

const TRUNCATE = sql`TRUNCATE article_units, bom_components, articles CASCADE`;
// Unit codes created by these tests — deleted instead of truncating units,
// which other suites' seeded standard units depend on.
const TEST_UNIT_CODES = ["zzpall"];

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(units).where(inArray(units.code, TEST_UNIT_CODES));
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(units).where(inArray(units.code, TEST_UNIT_CODES));
});

async function seedUnit(code: string, name = code) {
  await db.insert(units).values({ code, name }).onConflictDoNothing();
  const [unit] = await db.select({ id: units.id }).from(units).where(eq(units.code, code));
  return unit!.id;
}

async function seedArticle(articleNumber: string, unitCode = "st") {
  const unitId = await seedUnit(unitCode, unitCode === "st" ? "Styck" : unitCode);
  const [row] = await db
    .insert(articlesTable)
    .values({ articleNumber, name: articleNumber, type: "purchased", unitId })
    .returning({ id: articlesTable.id });
  return row!.id;
}

describe("article unit import — repository and service", () => {
  it("accepts articleUnits in the entity enum", () => {
    expect(importEntitySchema.options).toContain("articleUnits");
  });

  it("creates units, article_units rows and the default purchase/sales unit in one transaction", async () => {
    const articleId = await seedArticle("ZM310", "kg");
    const stId = await seedUnit("st", "Styck");

    const result = await importService.commit("articleUnits", {
      mapping: MAPPING,
      rows: [
        ["ZM310", "kg", "1", "false", "false"],
        ["ZM310", "st", "50", "true", "false"],
        ["ZM310", "zzpall", "500", "false", "true"],
      ],
    });
    expect(result).toMatchObject({ created: 2, updated: 0, skipped: 1 });
    expect(result.registersCreated.units).toEqual(["zzpall"]);

    const rows = await db.select().from(articleUnits).where(eq(articleUnits.articleId, articleId));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.unitId === stId)!.quantityPerBase).toBe("0.020000");
    const [stored] = await db.select().from(articlesTable).where(eq(articlesTable.id, articleId));
    expect(stored!.purchaseUnitId).toBe(stId);
    const [pall] = await db.select({ id: units.id }).from(units).where(eq(units.code, "zzpall"));
    expect(stored!.salesUnitId).toBe(pall!.id);
  });

  it("updates the factor of an existing alternative unit on a second run", async () => {
    const articleId = await seedArticle("A-1");
    const kgId = await seedUnit("kg");
    await db.insert(articleUnits).values({ articleId, unitId: kgId, quantityPerBase: "4.000000" });

    const result = await importService.commit("articleUnits", {
      mapping: MAPPING,
      rows: [["A-1", "kg", "0,2", "", ""]],
    });
    expect(result).toMatchObject({ created: 0, updated: 1 });
    const [row] = await db.select().from(articleUnits).where(eq(articleUnits.articleId, articleId));
    expect(row!.quantityPerBase).toBe("5.000000");
  });
});
