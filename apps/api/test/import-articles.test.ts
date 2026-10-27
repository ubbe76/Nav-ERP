import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { count, eq, inArray, sql } from "drizzle-orm";
import { articleGroups, articleSuppliers, articles, db, stockLocations, suppliers, units } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import {
  createArticleService,
  DuplicateArticleNumberError,
  InvalidReferenceError,
} from "../src/modules/article/service/article.service.js";
import {
  planArticleImport,
  suggestArticleMapping,
  type ArticleImportDeps,
  type ArticleImportPlan,
  type ExistingArticle,
} from "../src/modules/import/service/articles.js";
import {
  createImportService,
  ImportMappingError,
  ImportValidationError,
} from "../src/modules/import/service/import.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";

const articleRepo = createArticleRepository(db);
const articleService = createArticleService(articleRepo);
const importRepo = createImportRepository(db);
const importService = createImportService(importRepo);

const FAKE_UUID = "00000000-0000-0000-0000-000000000000";

// Unit codes created by these tests — deleted up front instead of truncating
// units, which other suites' seeded standard units depend on.
const TEST_UNIT_CODES = ["pall", "PALL", "kartong9"];

beforeEach(async () => {
  await db.execute(sql`TRUNCATE bom_components, stock_transactions, articles, article_groups, article_codes, suppliers CASCADE`);
  await db.delete(units).where(inArray(units.code, TEST_UNIT_CODES));
});

afterAll(async () => {
  await db.execute(sql`TRUNCATE bom_components, stock_transactions, articles, article_groups, article_codes, suppliers CASCADE`);
  await db.delete(units).where(inArray(units.code, TEST_UNIT_CODES));
});

describe("createArticle — semantik importen beror på (bugfixar)", () => {
  it("throws DuplicateArticleNumberError on a duplicate number (POST /articles -> 409)", async () => {
    await articleService.createArticle({
      articleNumber: "DUP-1",
      name: "Original",
      type: "purchased",
      isPhantom: false,
      active: true,
    });
    await expect(
      articleService.createArticle({
        articleNumber: "DUP-1",
        name: "Kopia",
        type: "purchased",
        isPhantom: false,
        active: true,
      })
    ).rejects.toBeInstanceOf(DuplicateArticleNumberError);
  });

  it("rejects an unknown groupId with InvalidReferenceError instead of an FK violation", async () => {
    await expect(
      articleService.createArticle({
        articleNumber: "REF-1",
        name: "Grupplös",
        type: "purchased",
        isPhantom: false,
        active: true,
        groupId: FAKE_UUID,
      })
    ).rejects.toBeInstanceOf(InvalidReferenceError);
  });

  it("rejects an unknown packageTypeId with InvalidReferenceError", async () => {
    await expect(
      articleService.createArticle({
        articleNumber: "REF-2",
        name: "Kollilös",
        type: "purchased",
        isPhantom: false,
        active: true,
        packageTypeId: FAKE_UUID,
      })
    ).rejects.toBeInstanceOf(InvalidReferenceError);
  });
});

// In-memory deps — the plan builder never touches Drizzle directly, so these
// tests run without any database writes.
function fakeDeps(
  existing: ExistingArticle[] = [],
  unitCodes: string[] = ["st"],
  groupCodes: string[] = [],
  articleCodes: string[] = []
): ArticleImportDeps {
  return {
    async articlesByNumber(numbers) {
      return new Map(
        existing.filter((a) => numbers.includes(a.articleNumber)).map((a) => [a.articleNumber, a])
      );
    },
    async unitsByCode() {
      return new Map(unitCodes.map((code) => [code.toLowerCase(), { id: `unit-${code}`, code }]));
    },
    async groupsByCode() {
      return new Map(groupCodes.map((code) => [code, `group-${code}`]));
    },
    async articleCodesByCode() {
      return new Map(articleCodes.map((code) => [code, `code-${code}`]));
    },
    async suppliersByNumber(numbers) {
      return new Map(numbers.filter((n) => n.startsWith("L")).map((n) => [n, { id: `sup-${n}` }]));
    },
    async resolveDefaults() {
      return { unitId: "unit-st", locationId: "loc-fallback" };
    },
  };
}

// Key order = column order (JSON objects preserve insertion order).
const MAPPING: Record<string, string | null> = {
  Artikelnummer: "articleNumber",
  Benämning: "name",
  Typ: "type",
  Enhet: "unitCode",
  Artikelgrupp: "groupCode",
  Standardpris: "standardCost",
  Vikt: "weight",
  Aktiv: "active",
};

describe("suggestArticleMapping", () => {
  it("guesses Monitor headers case-insensitively and ignores unknown columns", () => {
    const suggested = suggestArticleMapping(["Artikelnummer", "BENÄMNING", "Art.nr", "Frisyr"]);
    expect(suggested["Artikelnummer"]).toBe("articleNumber");
    expect(suggested["BENÄMNING"]).toBe("name");
    // articleNumber was already claimed by the first column — first hit wins.
    expect(suggested["Art.nr"]).toBeNull();
    expect(suggested["Frisyr"]).toBeNull();
  });

  it("covers the whole alias dictionary", () => {
    const suggested = suggestArticleMapping([
      "Artikelnr",
      "Namn",
      "Artikeltyp",
      "Enhet",
      "Artikelgruppkod",
      "Standardkostnad",
      "Nettovikt",
      "Ytbehandling",
      "Färg",
      "Status",
    ]);
    expect(Object.values(suggested)).toEqual([
      "articleNumber",
      "name",
      "type",
      "unitCode",
      "groupCode",
      "standardCost",
      "weight",
      "surfaceTreatment",
      "colour",
      "active",
    ]);
  });

  it("also aliases Kulor to colour", () => {
    const suggested = suggestArticleMapping(["Kulor"]);
    expect(suggested["Kulor"]).toBe("colour");
  });

  // The header row of the real Monitor G5 export: Artikelkod is the
  // artikelkod and Varugrupp the varugrupp (groupCode); Artikelkategori and
  // the stock columns have no target.
  it("maps the real Monitor G5 export header row", () => {
    const suggested = suggestArticleMapping([
      "Artikelnummer",
      "Artikelbenämning",
      "Artikeltyp",
      "Standardpris",
      "Artikelkategori",
      "Artikelkod",
      "Varugrupp",
      "Enhet",
      "Totalt saldo",
      "Lagerplatsurval",
    ]);
    expect(Object.values(suggested)).toEqual([
      "articleNumber",
      "name",
      "type",
      "standardCost",
      null,
      "articleCode",
      "groupCode",
      "unitCode",
      null,
      null,
    ]);
  });
});

describe("planArticleImport", () => {
  it("plans a create with normalized decimals and Swedish booleans", async () => {
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [["A-1", "Vinkel", "", "st", "", "1 234,56", "2,5", "Ja"]],
        defaults: { articleType: "manufactured" },
      },
      fakeDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 0, error: 0, warning: 0 });
    expect(plan.creates).toEqual([
      {
        articleNumber: "A-1",
        name: "Vinkel",
        type: "manufactured", // empty type cell -> defaults.articleType
        isPhantom: false,
        unitCode: "st",
        groupCode: null,
        articleCode: null,
        standardCost: 1234.56,
        weight: 2.5,
        surfaceTreatment: null,
        colour: null,
        active: true,
        reorderPoint: null,
        orderQuantity: null,
        rounding: null,
      },
    ]);
    expect(plan.fallbackUnitId).toBe("unit-st");
    expect(plan.fallbackLocationId).toBe("loc-fallback");
  });

  it("normalizes Monitor type spellings and errors on unknown ones", async () => {
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [
          ["T-1", "x", "Tillverkad", "", "", "", "", ""],
          ["T-2", "x", "P", "", "", "", "", ""],
          ["T-3", "x", "Lego", "", "", "", "", ""],
          ["T-4", "x", "Grönsak", "", "", "", "", ""],
        ],
      },
      fakeDeps()
    );
    expect(plan.creates.map((c) => c.type)).toEqual(["manufactured", "purchased", "service"]);
    expect(plan.rows[3]!.errors[0]).toContain("Okänd artikeltyp");
    expect(plan.summary).toEqual({ create: 3, update: 0, skip: 0, error: 1, warning: 0 });
    expect(plan.hasErrors).toBe(true);
  });

  it("reads Monitor's Fiktiv as a manufactured fantomartikel", async () => {
    // Fiktiv is not a type here — it is the is_phantom FLAG beside one. It
    // lands on manufactured regardless of the wizard's Standardtyp, because
    // a phantom must carry a structure and only manufactured articles show
    // the Beredning tab.
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [
          ["F-1", "Underrede", "Fiktiv", "", "", "", "", ""],
          ["F-2", "Modul", "F", "", "", "", "", ""],
          ["F-3", "Fiktiv artikel i namnet", "Tillverkad", "", "", "", "", ""],
        ],
        defaults: { articleType: "purchased" },
      },
      fakeDeps()
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.creates.map((c) => [c.type, c.isPhantom])).toEqual([
      ["manufactured", true],
      ["manufactured", true],
      // Only the TYPE cell decides — a benämning mentioning "fiktiv" does not.
      ["manufactured", false],
    ]);
    expect(plan.rows[0]!.values["type"]).toBe("manufactured");
    expect(plan.rows[0]!.values["isPhantom"]).toBe(true);
    expect(plan.rows[2]!.values["isPhantom"]).toBeUndefined();
  });

  it("never flips the phantom flag on an existing article, but warns", async () => {
    const existing: ExistingArticle = {
      id: "id-1",
      articleNumber: "F-1",
      name: "Underrede",
      type: "manufactured",
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
    const plan = await planArticleImport(
      { mapping: MAPPING, rows: [["F-1", "", "Fiktiv", "", "", "", "", ""]] },
      fakeDeps([existing])
    );

    expect(plan.rows[0]!.action).toBe("update");
    expect(plan.rows[0]!.errors).toEqual([]);
    // The type matches (both manufactured), so only the flag is warned about.
    expect(plan.rows[0]!.warnings).toEqual([
      "Fantomflaggan sätts inte vid uppdatering (artikeln förblir icke-fantom)",
    ]);
    expect(plan.updates).toEqual([{ id: "id-1", patch: {} }]);
  });

  it("marks existing numbers as updates, leaves empty cells untouched and never changes type/unit", async () => {
    const existing: ExistingArticle = {
      id: "id-1",
      articleNumber: "A-1",
      name: "Gammalt namn",
      type: "purchased",
      unitCode: "st",
      unitId: "unit-st",
      isPhantom: false,
      groupCode: null,
      standardCost: "10.0000",
      weight: null,
      surfaceTreatment: null,
      colour: null,
      active: true,
    };
    const plan = await planArticleImport(
      { mapping: MAPPING, rows: [["A-1", "", "Tillverkad", "kg", "", "", "", ""]] },
      fakeDeps([existing], ["st", "kg"])
    );
    expect(plan.rows[0]!.action).toBe("update");
    expect(plan.rows[0]!.errors).toEqual([]);
    // Both the differing type and the differing unit warn — neither is applied.
    expect(plan.rows[0]!.warnings).toHaveLength(2);
    expect(plan.updates).toEqual([{ id: "id-1", patch: {} }]);
    expect(plan.summary).toEqual({ create: 0, update: 1, skip: 0, error: 0, warning: 1 });
    // The kg unit exists but must NOT end up in willCreate via an update row.
    expect(plan.willCreate.units).toEqual([]);
  });

  it("skips an existing article entirely when skipExisting is set", async () => {
    const existing: ExistingArticle = {
      id: "id-1",
      articleNumber: "A-1",
      name: "Behåll mig",
      type: "manufactured",
      unitCode: "st",
      unitId: "unit-st",
      isPhantom: false,
      groupCode: null,
      standardCost: "10.0000",
      weight: null,
      surfaceTreatment: null,
      colour: null,
      active: true,
    };
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "Skriv inte över", "Köpt", "kg", "", "999", "", "Nej"],
          ["A-2", "Ny artikel", "Köpt", "st", "", "", "", ""],
        ],
        skipExisting: true,
      },
      fakeDeps([existing], ["st", "kg"])
    );

    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.warnings).toEqual([]);
    expect(plan.rows[0]!.skipReason).toBe("Artikeln A-1 finns redan i artikelregistret");
    expect(plan.updates).toEqual([]);
    expect(plan.creates.map((create) => create.articleNumber)).toEqual(["A-2"]);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 1, error: 0, warning: 0 });
    expect(plan.hasErrors).toBe(false);
  });

  it("patches only the non-empty cells on update", async () => {
    const existing: ExistingArticle = {
      id: "id-2",
      articleNumber: "B-1",
      name: "Behåller ej",
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
    const plan = await planArticleImport(
      { mapping: MAPPING, rows: [["B-1", "Nytt namn", "", "", "3100", "99,50", "", "Nej"]] },
      fakeDeps([existing], ["st"], ["3100"])
    );
    expect(plan.updates).toEqual([
      { id: "id-2", patch: { name: "Nytt namn", groupCode: "3100", standardCost: 99.5, active: false } },
    ]);
  });

  // Same key order as ARTICLE_IMPORT_FIELDS: the two new columns sit right
  // before Aktiv.
  const MAPPING_WITH_SURFACE: Record<string, string | null> = {
    ...MAPPING,
  };
  delete MAPPING_WITH_SURFACE["Aktiv"];
  MAPPING_WITH_SURFACE["Ytbehandling"] = "surfaceTreatment";
  MAPPING_WITH_SURFACE["Färg"] = "colour";
  MAPPING_WITH_SURFACE["Aktiv"] = "active";

  it("creates with Ytbehandling/Färg from the mapped columns", async () => {
    const plan = await planArticleImport(
      {
        mapping: MAPPING_WITH_SURFACE,
        rows: [["Y-1", "Vinkel", "", "st", "", "", "", "Pulverlack RAL 9010", "Vit", "Ja"]],
      },
      fakeDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates[0]!.surfaceTreatment).toBe("Pulverlack RAL 9010");
    expect(plan.creates[0]!.colour).toBe("Vit");
  });

  it("errors when Ytbehandling/Färg exceed 200 characters", async () => {
    const tooLong = "x".repeat(201);
    const plan = await planArticleImport(
      { mapping: MAPPING_WITH_SURFACE, rows: [["Y-2", "x", "", "", "", "", "", tooLong, tooLong, ""]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toContain("Fältet 'Ytbehandling' är för långt (max 200 tecken)");
    expect(plan.rows[0]!.errors).toContain("Fältet 'Färg' är för långt (max 200 tecken)");
  });

  it("only patches Ytbehandling/Färg on update when the value actually differs", async () => {
    const existing: ExistingArticle = {
      id: "id-3",
      articleNumber: "Y-3",
      name: "Befintlig",
      type: "purchased",
      unitCode: "st",
      unitId: "unit-st",
      isPhantom: false,
      groupCode: null,
      standardCost: null,
      weight: null,
      surfaceTreatment: "Förzinkad",
      colour: "Svart",
      active: true,
    };
    // Same surfaceTreatment, new colour -> only colour patches.
    const plan = await planArticleImport(
      {
        mapping: MAPPING_WITH_SURFACE,
        rows: [["Y-3", "", "", "", "", "", "", "Förzinkad", "Röd", ""]],
      },
      fakeDeps([existing])
    );
    expect(plan.updates[0]!.patch).toEqual({ colour: "Röd" });
  });

  it("leaves Ytbehandling/Färg untouched on update when the cells are empty", async () => {
    const existing: ExistingArticle = {
      id: "id-4",
      articleNumber: "Y-4",
      name: "Befintlig",
      type: "purchased",
      unitCode: "st",
      unitId: "unit-st",
      isPhantom: false,
      groupCode: null,
      standardCost: null,
      weight: null,
      surfaceTreatment: "Förzinkad",
      colour: "Svart",
      active: true,
    };
    const plan = await planArticleImport(
      {
        mapping: MAPPING_WITH_SURFACE,
        rows: [["Y-4", "", "", "", "", "", "", "", "", ""]],
      },
      fakeDeps([existing])
    );
    expect(plan.updates[0]!.patch).toEqual({});
  });

  it("errors on the second occurrence of a duplicate number in the file", async () => {
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [
          ["D-1", "Första", "", "", "", "", "", ""],
          ["D-1", "Andra", "", "", "", "", "", ""],
        ],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.errors[0]).toContain("förekommer flera gånger");
    expect(plan.creates).toHaveLength(1);
  });

  it("errors on group codes that are not 1-4 digits, takes Monitor's single-digit varugrupp", async () => {
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [
          ["G-1", "x", "", "", "12x", "", "", ""],
          ["G-2", "x", "", "", "12345", "", "", ""],
          ["G-3", "x", "", "", "8", "", "", ""],
        ],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors[0]).toContain("Ogiltig varugruppskod");
    expect(plan.rows[1]!.errors[0]).toContain("Ogiltig varugruppskod");
    expect(plan.rows[2]!.errors).toEqual([]);
    expect(plan.willCreate.articleGroups).toEqual(["8"]);
  });

  it("reads Artikelkod: unknown codes in willCreate, a known one resolves, a changed one patches, too long errors", async () => {
    const mapping = { Artikelnummer: "articleNumber", Benämning: "name", Artikelkod: "articleCode" };
    const existing = {
      id: "a-1", articleNumber: "K-1", name: "Finns", type: "purchased", unitCode: "st", unitId: "unit-st",
      isPhantom: false, groupCode: null, articleCode: "100", standardCost: null, weight: null,
      surfaceTreatment: null, colour: null, active: true,
    } satisfies ExistingArticle;
    const plan = await planArticleImport(
      {
        mapping,
        rows: [
          ["K-1", "", "120"],
          ["K-2", "Ny", "100"],
          ["K-3", "Ny", "330"],
          ["K-4", "Ny", "x".repeat(21)],
          ["K-5", "Ny", ""],
        ],
      },
      fakeDeps([existing], ["st"], [], ["100"])
    );
    expect(plan.willCreate.articleCodes).toEqual(["120", "330"]);
    expect(plan.updates).toEqual([{ id: "a-1", patch: { articleCode: "120" } }]);
    expect(plan.creates.map((c) => [c.articleNumber, c.articleCode])).toEqual([["K-2", "100"], ["K-3", "330"], ["K-5", null]]);
    expect(plan.rows[3]!.errors[0]).toContain("Artikelkoden är för lång");
    // The same code as stored stages no patch.
    const again = await planArticleImport({ mapping, rows: [["K-1", "", "100"]] }, fakeDeps([existing], ["st"], [], ["100"]));
    expect(again.updates).toEqual([{ id: "a-1", patch: {} }]);
  });

  it("collects unknown units and groups in willCreate, case-insensitively for units", async () => {
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [
          ["W-1", "x", "", "pall", "9990", "", "", ""],
          ["W-2", "x", "", "PALL", "9990", "", "", ""],
          ["W-3", "x", "", "ST", "", "", "", ""],
        ],
      },
      fakeDeps([], ["st"])
    );
    // "pall" is new (first-seen casing wins, PALL is the same unit);
    // "ST" matches the existing "st" unit and creates nothing.
    expect(plan.willCreate.units).toEqual(["pall"]);
    expect(plan.willCreate.articleGroups).toEqual(["9990"]);
    expect(plan.hasErrors).toBe(false);
  });

  it("errors on missing/too long article numbers and missing names on create", async () => {
    const plan = await planArticleImport(
      {
        mapping: MAPPING,
        rows: [
          ["", "Namnlös", "", "", "", "", "", ""],
          ["X".repeat(51), "x", "", "", "", "", "", ""],
          ["N-1", "", "", "", "", "", "", ""],
        ],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors[0]).toContain("Artikelnummer saknas");
    expect(plan.rows[1]!.errors[0]).toContain("för långt");
    expect(plan.rows[2]!.errors[0]).toContain("Benämning saknas");
    expect(plan.summary.error).toBe(3);
  });

  // --- Monitor's Planering export: Beställningspunkt, Orderkvantitet,
  // Avrundningsantal, Partiformningsregel (+ Nettovikt, already aliased). ---
  describe("planning fields", () => {
    const PLANNING_MAPPING: Record<string, string | null> = {
      Artikelnummer: "articleNumber",
      Partiformningsregel: "lotSizingRule",
      Orderkvantitet: "orderQuantity",
      Avrundningsantal: "rounding",
      Beställningspunkt: "reorderPoint",
      Nettovikt: "weight",
    };
    const existing = (): ExistingArticle => ({
      id: "id-1",
      articleNumber: "A-1",
      name: "Befintlig",
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
    });

    it("maps the real Planering export's headings", () => {
      const suggested = suggestArticleMapping([
        "Artikelnummer",
        "Artikelbenämning",
        "Artikeltyp",
        "Planeringsmetod",
        "Styrning",
        "Partiformningsregel",
        "Periodlängd",
        "Orderkvantitet",
        "Min. kvantitet",
        "Avrundningsantal",
        "Beställningspunkt",
        "Säkerhetslager",
        "Säkerhetstid",
        "Max. kvant. på T-order",
        "Max. kvant på I-order",
        "Ledtid",
        "Årsvolym",
        "ABC-kod",
        "Anskaffa från lagerställe",
        "Nettovikt",
      ]);
      expect(suggested["Partiformningsregel"]).toBe("lotSizingRule");
      expect(suggested["Orderkvantitet"]).toBe("orderQuantity");
      expect(suggested["Avrundningsantal"]).toBe("rounding");
      expect(suggested["Beställningspunkt"]).toBe("reorderPoint");
      expect(suggested["Nettovikt"]).toBe("weight");
      // Deliberately without a home.
      expect(suggested["Min. kvantitet"]).toBeNull();
      expect(suggested["Säkerhetslager"]).toBe("safetyStock");
      expect(suggested["Styrning"]).toBe("stockControlled");
      expect(suggested["Ledtid"]).toBeNull();
      expect(suggestArticleMapping(["Avrundning", "BP"])).toEqual({ Avrundning: "rounding", BP: "reorderPoint" });
    });

    it("patches the planning fields on update, reading 0 as 'none' (null)", async () => {
      const plan = await planArticleImport(
        {
          mapping: PLANNING_MAPPING,
          rows: [
            ["A-1", "Fast orderstorlek", "200", "5", "50", "1,16"],
            ["A-1", "Fast orderstorlek", "0", "0", "0", ""],
          ],
        },
        fakeDeps([existing()])
      );
      // The duplicate number is an error on row 3 — build the two rows in
      // two plans instead.
      expect(plan.rows[1]!.errors).toContain("Artikelnumret förekommer flera gånger i filen");
      const first = await planArticleImport(
        { mapping: PLANNING_MAPPING, rows: [["A-1", "Fast orderstorlek", "200", "5", "50", "1,16"]] },
        fakeDeps([existing()])
      );
      expect(first.hasErrors).toBe(false);
      expect(first.updates[0]!.patch).toEqual({ orderQuantity: 200, rounding: 5, reorderPoint: 50, weight: 1.16 });
      const zeros = await planArticleImport(
        { mapping: PLANNING_MAPPING, rows: [["A-1", "Fast orderstorlek", "0", "0", "0", ""]] },
        fakeDeps([existing()])
      );
      expect(zeros.updates[0]!.patch).toEqual({ orderQuantity: null, rounding: null, reorderPoint: null });
    });

    it("takes Orderkvantitet only when Partiformningsregel is Fast orderstorlek", async () => {
      const demand = await planArticleImport(
        { mapping: PLANNING_MAPPING, rows: [["A-1", "Mot behov", "100", "1", "", ""]] },
        fakeDeps([existing()])
      );
      expect(demand.hasErrors).toBe(false);
      expect(demand.updates[0]!.patch).toEqual({ rounding: 1 });
      expect(demand.rows[0]!.warnings).toEqual([
        "Orderkvantitet hoppades över — Partiformningsregel är inte Fast orderstorlek",
      ]);

      // A mapped but empty rule skips the quantity too, with the same warning.
      const emptyRule = await planArticleImport(
        { mapping: PLANNING_MAPPING, rows: [["A-1", "", "100", "", "", ""]] },
        fakeDeps([existing()])
      );
      expect(emptyRule.updates[0]!.patch).toEqual({});
      expect(emptyRule.rows[0]!.warnings).toEqual([
        "Orderkvantitet hoppades över — Partiformningsregel är inte Fast orderstorlek",
      ]);

      // 0 is "none" — skipping it loses nothing, so no warning.
      const zeroSkipped = await planArticleImport(
        { mapping: PLANNING_MAPPING, rows: [["A-1", "Mot behov", "0", "", "", ""]] },
        fakeDeps([existing()])
      );
      expect(zeroSkipped.rows[0]!.warnings).toEqual([]);

      // Unmapped rule column: the quantity is taken as-is.
      const noRule = await planArticleImport(
        { mapping: { Artikelnummer: "articleNumber", Orderkvantitet: "orderQuantity" }, rows: [["A-1", "100"]] },
        fakeDeps([existing()])
      );
      expect(noRule.updates[0]!.patch).toEqual({ orderQuantity: 100 });
    });

    it("rounds an Avrundning with more than 3 decimals and warns, refuses negatives", async () => {
      const plan = await planArticleImport(
        {
          mapping: PLANNING_MAPPING,
          rows: [["A-1", "Mot behov", "0", "28,86000111", "0", ""]],
        },
        fakeDeps([existing()])
      );
      expect(plan.rows[0]!.errors).toEqual([]);
      expect(plan.rows[0]!.warnings).toEqual(["Avrundningen 28,86000111 avrundas till 28.86 (högst 3 decimaler)"]);
      expect(plan.updates[0]!.patch.rounding).toBe(28.86);

      const negative = await planArticleImport(
        { mapping: PLANNING_MAPPING, rows: [["A-1", "Mot behov", "0", "-5", "-1", ""]] },
        fakeDeps([existing()])
      );
      expect(negative.rows[0]!.errors).toEqual([
        "Beställningspunkten kan inte vara negativ",
        "Avrundningen kan inte vara negativ",
      ]);
    });

    it("stores the planning fields on a created article", async () => {
      const plan = await planArticleImport(
        {
          mapping: { ...PLANNING_MAPPING, Benämning: "name" },
          rows: [["NY-1", "Fast orderstorlek", "10", "5", "20", "", "Ny artikel"]],
        },
        fakeDeps()
      );
      expect(plan.hasErrors).toBe(false);
      expect(plan.creates[0]).toMatchObject({ reorderPoint: 20, orderQuantity: 10, rounding: 5 });
    });
  });

  it("throws ImportMappingError when articleNumber is unmapped or a field is mapped twice", async () => {
    await expect(
      planArticleImport({ mapping: { Benämning: "name" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
    await expect(
      planArticleImport(
        { mapping: { A: "articleNumber", B: "name", C: "name" }, rows: [] },
        fakeDeps()
      )
    ).rejects.toBeInstanceOf(ImportMappingError);
    await expect(
      planArticleImport({ mapping: { A: "articleNumber", B: "hittepå" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
  });
});

async function makeArticle(articleNumber: string, name = articleNumber) {
  return articleService.createArticle({ articleNumber, name, type: "purchased", isPhantom: false, active: true });
}

async function emptyPlan(): Promise<ArticleImportPlan> {
  const fallback = await importRepo.resolveDefaults();
  return {
    rows: [],
    summary: { create: 0, update: 0, skip: 0, error: 0, warning: 0 },
    willCreate: { units: [], articleGroups: [], articleCodes: [] },
    creates: [],
    updates: [],
    fallbackUnitId: fallback.unitId,
    fallbackLocationId: fallback.locationId,
    hasErrors: false,
  };
}

describe("import repository — lookups", () => {
  it("resolves existing articles by number with joined unit/group codes", async () => {
    const created = await makeArticle("LOOK-1", "Uppslag");
    const map = await importRepo.articlesByNumber(["LOOK-1", "FINNS-EJ"]);
    expect(map.size).toBe(1);
    const row = map.get("LOOK-1")!;
    expect(row.id).toBe(created.id);
    expect(row.unitCode).toBe("st");
    expect(row.groupCode).toBeNull();
    expect(row.active).toBe(true);
  });

  it("keys units by lowercased code and groups by exact code", async () => {
    const unitMap = await importRepo.unitsByCode();
    expect(unitMap.get("st")?.code).toBe("st");
    await articleService.createArticleGroup({ code: "3100", name: "Rostfritt" });
    const groupMap = await importRepo.groupsByCode();
    expect(typeof groupMap.get("3100")).toBe("string");
  });

  it("resolveDefaults returns the st unit and the *** location, stable across calls", async () => {
    const first = await importRepo.resolveDefaults();
    const second = await importRepo.resolveDefaults();
    expect(first).toEqual(second);
    const [location] = await db
      .select({ name: stockLocations.name })
      .from(stockLocations)
      .where(eq(stockLocations.id, first.locationId));
    expect(location!.name).toBe("***");
  });
});

describe("import repository — executeArticlePlan", () => {
  it("creates, updates and auto-creates registers in one transaction", async () => {
    const existing = await makeArticle("EXEC-1", "Före");
    const plan = await emptyPlan();
    plan.willCreate = { units: ["pall"], articleGroups: ["9990"], articleCodes: ["100"] };
    plan.creates = [
      {
        articleNumber: "EXEC-2",
        name: "Ny med ny enhet",
        type: "manufactured",
        isPhantom: true,
        unitCode: "pall",
        groupCode: "9990",
        articleCode: "100",
        standardCost: 12.5,
        weight: null,
        surfaceTreatment: null,
        colour: null,
        active: true,
      },
      {
        articleNumber: "EXEC-3",
        name: "Ny med fallback",
        type: "purchased",
        isPhantom: false,
        unitCode: null,
        groupCode: null,
        standardCost: null,
        weight: 1.25,
        surfaceTreatment: null,
        colour: null,
        active: false,
      },
    ];
    plan.updates = [{ id: existing.id, patch: { name: "Efter", standardCost: 99.5 } }];

    const result = await importRepo.executeArticlePlan(plan);
    expect(result).toEqual({
      created: 2,
      updated: 1,
      registersCreated: { units: ["pall"], articleGroups: ["9990"], articleCodes: ["100"] },
    });

    const created = await importRepo.articlesByNumber(["EXEC-2", "EXEC-3"]);
    expect(created.get("EXEC-2")!.unitCode).toBe("pall");
    expect(created.get("EXEC-2")!.groupCode).toBe("9990");
    expect(created.get("EXEC-2")!.articleCode).toBe("100");
    expect(created.get("EXEC-3")!.articleCode).toBeNull();
    // is_phantom is written from the plan, not left to the column default.
    expect(created.get("EXEC-2")!.isPhantom).toBe(true);
    expect(created.get("EXEC-3")!.unitCode).toBe("st"); // fallback unit
    expect(created.get("EXEC-3")!.active).toBe(false);
    expect(created.get("EXEC-3")!.isPhantom).toBe(false);
    // The auto-created group gets name = code.
    const [group] = await db.select().from(articleGroups).where(eq(articleGroups.code, "9990"));
    expect(group!.name).toBe("9990");
    // The new article carries the fallback *** location.
    const [row] = await db.select().from(articles).where(eq(articles.articleNumber, "EXEC-3"));
    expect(row!.defaultLocationId).toBe(plan.fallbackLocationId);

    const updated = await importRepo.articlesByNumber(["EXEC-1"]);
    expect(updated.get("EXEC-1")!.name).toBe("Efter");
    expect(Number(updated.get("EXEC-1")!.standardCost)).toBe(99.5);
  });

  it("resolves a differently-cased unit code to the existing unit instead of creating a duplicate", async () => {
    const plan = await emptyPlan();
    plan.creates = [
      { articleNumber: "CASE-1", name: "x", type: "purchased", unitCode: "ST", groupCode: null, standardCost: null, weight: null, surfaceTreatment: null, colour: null, active: true },
    ];
    await importRepo.executeArticlePlan(plan);
    const created = await importRepo.articlesByNumber(["CASE-1"]);
    expect(created.get("CASE-1")!.unitCode).toBe("st");
    const stVariants = await db.select().from(units).where(eq(units.code, "ST"));
    expect(stVariants).toHaveLength(0);
  });

  it("rolls back EVERYTHING when any insert fails (atomicity)", async () => {
    await makeArticle("ATOM-1");
    const [{ value: before }] = await db.select({ value: count() }).from(articles);

    const plan = await emptyPlan();
    plan.willCreate = { units: ["kartong9"], articleGroups: [], articleCodes: [] };
    plan.creates = [
      { articleNumber: "ATOM-2", name: "Går in", type: "purchased", unitCode: "kartong9", groupCode: null, standardCost: null, weight: null, surfaceTreatment: null, colour: null, active: true },
      // Collides with ATOM-1 -> unique violation -> whole tx rolls back.
      { articleNumber: "ATOM-1", name: "Krockar", type: "purchased", unitCode: null, groupCode: null, standardCost: null, weight: null, surfaceTreatment: null, colour: null, active: true },
    ];

    await expect(importRepo.executeArticlePlan(plan)).rejects.toThrow();

    const [{ value: after }] = await db.select({ value: count() }).from(articles);
    expect(after).toBe(before);
    // The register auto-creation rolled back too — it ran INSIDE the tx.
    const leaked = await db.select().from(units).where(eq(units.code, "kartong9"));
    expect(leaked).toHaveLength(0);
  });

  it("chunks large create batches at 500", async () => {
    const plan = await emptyPlan();
    plan.creates = Array.from({ length: 750 }, (_, i) => ({
      articleNumber: `BULK-${i}`,
      name: `Bulk ${i}`,
      type: "purchased" as const,
      unitCode: null,
      groupCode: null,
      standardCost: null,
      weight: null,
      surfaceTreatment: null,
      colour: null,
      active: true,
      reorderPoint: null,
      orderQuantity: null,
      rounding: null,
    }));
    const result = await importRepo.executeArticlePlan(plan);
    expect(result.created).toBe(750);
    const [{ value: total }] = await db.select({ value: count() }).from(articles);
    expect(total).toBe(750);
  });
});

describe("import service — parse", () => {
  it("parses a Monitor-style CSV and suggests the mapping", async () => {
    const result = await importService.parse(
      "articles",
      Buffer.from("Artikelnummer;Benämning;Enhet;Okänd kolumn\nA-1;Vinkel;st;x\n")
    );
    expect(result.headers).toEqual(["Artikelnummer", "Benämning", "Enhet", "Okänd kolumn"]);
    expect(result.rows).toEqual([["A-1", "Vinkel", "st", "x"]]);
    expect(result.suggestedMapping).toEqual({
      Artikelnummer: "articleNumber",
      Benämning: "name",
      Enhet: "unitCode",
      "Okänd kolumn": null,
    });
    // meta gained format/sheetName/sheetCount with the xlsx support; a CSV
    // reports no sheet, an xlsx no delimiter or encoding.
    expect(result.meta).toEqual({
      format: "csv",
      delimiter: ";",
      encoding: "utf-8",
      sheetName: null,
      sheetCount: null,
      rowCount: 1,
    });
  });

  it("suffixes duplicate header names so the mapping stays unambiguous", async () => {
    const result = await importService.parse("articles", Buffer.from("Namn;Namn\nA;B\n"));
    expect(result.headers).toEqual(["Namn", "Namn (2)"]);
  });
});

describe("import service — preview & commit", () => {
  const mapping = { Artikelnummer: "articleNumber", Benämning: "name", Enhet: "unitCode" };

  it("previews creates/updates/errors with willCreate, writing nothing", async () => {
    await makeArticle("PRE-1", "Finns redan");
    const [{ value: before }] = await db.select({ value: count() }).from(articles);

    const preview = await importService.preview("articles", {
      mapping,
      rows: [
        ["PRE-1", "Nytt namn", ""],
        ["PRE-2", "Ny artikel", "pall"],
        ["", "Radfel", ""],
      ],
    });
    expect(preview.summary).toEqual({ create: 1, update: 1, skip: 0, error: 1, warning: 0 });
    expect(preview.rows.map((r) => r.action)).toEqual(["update", "create", "create"]);
    expect(preview.willCreate.units).toEqual(["pall"]);

    const [{ value: after }] = await db.select({ value: count() }).from(articles);
    expect(after).toBe(before); // preview never writes
  });

  it("leaves existing articles untouched and lists them when skipExisting is set", async () => {
    await makeArticle("SKIP-1", "Före");
    const result = await importService.commit("articles", {
      mapping,
      rows: [
        ["SKIP-1", "Efter", ""],
        ["SKIP-2", "Ny", ""],
      ],
      skipExisting: true,
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows).toEqual([
      {
        rowNumber: 2,
        reason: "Artikeln SKIP-1 finns redan i artikelregistret",
        values: { articleNumber: "SKIP-1", name: "Efter", unitCode: "" },
      },
    ]);

    const rows = await importRepo.articlesByNumber(["SKIP-1", "SKIP-2"]);
    expect(rows.get("SKIP-1")!.name).toBe("Före");
    expect(rows.get("SKIP-2")!.name).toBe("Ny");
  });

  it("commits creates + updates + registers and answers with the counts", async () => {
    await makeArticle("COM-1", "Före");
    const result = await importService.commit("articles", {
      mapping,
      rows: [
        ["COM-1", "Efter", ""],
        ["COM-2", "Ny", "pall"],
      ],
    });
    expect(result).toEqual({
      created: 1,
      updated: 1,
      skipped: 0,
      skippedRows: [],
      registersCreated: { units: ["pall"], articleGroups: [], articleCodes: [] },
    });
    const rows = await importRepo.articlesByNumber(["COM-1", "COM-2"]);
    expect(rows.get("COM-1")!.name).toBe("Efter");
    expect(rows.get("COM-2")!.unitCode).toBe("pall");
  });

  it("commits a Fiktiv row as a manufactured fantomartikel", async () => {
    const result = await importService.commit("articles", {
      mapping: { Artikelnummer: "articleNumber", Benämning: "name", Artikeltyp: "type" },
      rows: [["FANTOM-1", "Underrede", "Fiktiv"]],
      // The Standardtyp is deliberately different — Fiktiv overrides it.
      defaults: { articleType: "purchased" },
    });

    expect(result.created).toBe(1);
    const [stored] = await db.select().from(articles).where(eq(articles.articleNumber, "FANTOM-1"));
    expect(stored!.type).toBe("manufactured");
    expect(stored!.isPhantom).toBe(true);
  });

  it("aborts the whole commit on any row error with the preview payload (nothing written)", async () => {
    const [{ value: before }] = await db.select({ value: count() }).from(articles);
    try {
      await importService.commit("articles", {
        mapping,
        rows: [
          ["ERR-1", "Frisk rad", ""],
          ["", "Trasig rad", ""],
        ],
      });
      expect.unreachable("commit should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ImportValidationError);
      const payload = (err as ImportValidationError).payload;
      expect(payload.summary.error).toBe(1);
      expect(payload.rows).toHaveLength(2);
    }
    const [{ value: after }] = await db.select({ value: count() }).from(articles);
    expect(after).toBe(before);
  });
});

// Monitor's "Artikellista, Inköp": Antal/kolli and the article's Leverantörsnr.
describe("article import — Antal/kolli and Leverantörsnr", () => {
  const mapping = {
    Artikelnummer: "articleNumber",
    Artikelbenämning: "name",
    "Antal/kolli (Inköp)": "quantityPerPackage",
    Leverantörsnr: "primarySupplierNumber",
  };

  it("suggests both columns from Monitor's headings", () => {
    const suggested = suggestArticleMapping(["Artikelnummer", "Antal/kolli (Inköp)", "Leverantörsnr"]);
    expect(suggested["Antal/kolli (Inköp)"]).toBe("quantityPerPackage");
    expect(suggested["Leverantörsnr"]).toBe("primarySupplierNumber");
  });

  it("plans the quantity (0 clears) and the supplier, and errors on an unknown supplier", async () => {
    const plan = await planArticleImport(
      {
        mapping,
        rows: [
          ["A-1", "Ett", "12", "L100"],
          ["A-2", "Två", "0,123456", ""],
          ["A-3", "Tre", "", "X9"],
          ["A-4", "Fyra", "-1", ""],
        ],
      },
      fakeDeps()
    );
    expect(plan.creates[0]).toMatchObject({ articleNumber: "A-1", quantityPerPackage: 12, primarySupplierId: "sup-L100" });
    expect(plan.creates[1]).toMatchObject({ articleNumber: "A-2", quantityPerPackage: 0.1235 });
    expect(plan.rows[1]!.warnings).toEqual(["Antal per förpackning 0,123456 avrundas till 0.1235 (högst 4 decimaler)"]);
    expect(plan.rows[2]!.errors).toEqual(["Leverantören X9 finns inte i leverantörsregistret"]);
    expect(plan.rows[3]!.errors).toEqual(["Antal per förpackning kan inte vara negativt"]);

    const update = await planArticleImport(
      { mapping, rows: [["A-1", "", "0", "L100"]] },
      fakeDeps([
        {
          id: "id-1",
          articleNumber: "A-1",
          name: "Ett",
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
        },
      ])
    );
    expect(update.updates[0]).toMatchObject({ patch: { quantityPerPackage: null }, primarySupplierId: "sup-L100" });
  });

  it("makes the supplier primary, demoting the old one and adding a priceless row when missing", async () => {
    const [oldSupplier, newSupplier] = await db
      .insert(suppliers)
      .values([
        { supplierNumber: "L-1", name: "Gamla leverantören" },
        { supplierNumber: "L-2", name: "Nya leverantören", currency: "EUR" },
      ])
      .returning({ id: suppliers.id });
    const existing = await makeArticle("INK-1");
    await db.insert(articleSuppliers).values({ articleId: existing.id, supplierId: oldSupplier!.id, price: "10", isPrimary: true });

    const rows = [
      ["INK-1", "", "", "L-2"],
      ["INK-2", "Ny artikel", "25", "L-1"],
    ];
    await importService.commit("articles", { mapping, rows });
    // Re-running the same file changes nothing (still one primary each).
    await importService.commit("articles", { mapping, rows });

    const links = await db.select().from(articleSuppliers);
    const forExisting = links.filter((link) => link.articleId === existing.id);
    expect(forExisting).toHaveLength(2);
    expect(forExisting.find((link) => link.supplierId === oldSupplier!.id)).toMatchObject({ isPrimary: false, price: "10.0000" });
    expect(forExisting.find((link) => link.supplierId === newSupplier!.id)).toMatchObject({
      isPrimary: true,
      price: null,
      currency: "EUR",
    });

    const [created] = await db.select().from(articles).where(eq(articles.articleNumber, "INK-2"));
    expect(created!.quantityPerPackage).toBe("25.0000");
    expect(links.filter((link) => link.articleId === created!.id)).toMatchObject([
      { supplierId: oldSupplier!.id, isPrimary: true, currency: "SEK" },
    ]);
  });
});

describe("article import — Säkerhetslager and Styrning", () => {
  it("reads both from the Planering export", async () => {
    const mapping = { Artikelnummer: "articleNumber", Artikelbenämning: "name", Säkerhetslager: "safetyStock", Styrning: "stockControlled" };
    expect(suggestArticleMapping(Object.keys(mapping))).toEqual(mapping);
    const plan = await planArticleImport(
      {
        mapping,
        rows: [
          ["A-1", "Ett", "20", "Lagerstyrd"],
          ["A-2", "Två", "0", "Orderstyrd"],
          ["A-3", "Tre", "-1", "Kanban"],
        ],
      },
      fakeDeps()
    );
    expect(plan.creates[0]).toMatchObject({ safetyStock: 20, stockControlled: true });
    expect(plan.creates[1]).toMatchObject({ stockControlled: false });
    expect(plan.creates[1]).not.toHaveProperty("safetyStock");
    expect(plan.rows[2]!.errors).toEqual([
      "Säkerhetslagret kan inte vara negativt",
      'Okänd styrning: "Kanban" (Lagerstyrd eller Orderstyrd)',
    ]);
  });
});

