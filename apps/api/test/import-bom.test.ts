import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import {
  articleUnits,
  articles as articlesTable,
  bomComponents,
  db,
  routingOperations,
  units,
  workCenters,
} from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import {
  ImportMappingError,
  ImportValidationError,
  createImportService,
} from "../src/modules/import/service/import.service.js";
import type { ExistingArticle } from "../src/modules/import/service/articles.js";
import { planBomImport, suggestBomMapping, type BomImportDeps } from "../src/modules/import/service/bom.js";
import type { BomEdge } from "../src/modules/import/service/bom-cycle.js";

const MAPPING = {
  Artikelnummer: "articleNumber",
  Komponentnummer: "componentNumber",
  Antal: "quantity",
  Enhet: "unitCode",
  Operation: "operationSequenceNo",
};

function article(
  articleNumber: string,
  id: string,
  overrides: Partial<ExistingArticle> = {}
): ExistingArticle {
  return {
    id,
    articleNumber,
    name: articleNumber,
    type: "manufactured",
    unitCode: "st",
    unitId: "unit-st",
    isPhantom: false,
    groupCode: null,
    standardCost: null,
    weight: null,
    active: true,
    ...overrides,
  };
}

interface FakeOptions {
  articles?: ExistingArticle[];
  units?: { id: string; code: string }[];
  /** componentArticleId -> unitId -> quantity_per_base */
  factors?: Record<string, Record<string, number>>;
  operations?: { articleId: string; sequenceNo: number; costingOnly?: boolean }[];
  edges?: BomEdge[];
}

function fakeDeps(options: FakeOptions = {}): BomImportDeps {
  const articles = options.articles ?? [];
  const units = options.units ?? [{ id: "unit-st", code: "st" }];
  return {
    async articlesByNumber(numbers) {
      return new Map(articles.filter((a) => numbers.includes(a.articleNumber)).map((a) => [a.articleNumber, a]));
    },
    async unitsByCode() {
      return new Map(units.map((u) => [u.code.toLowerCase(), u]));
    },
    async articleUnitFactors() {
      return new Map(
        Object.entries(options.factors ?? {}).map(([articleId, byUnit]) => [articleId, new Map(Object.entries(byUnit))])
      );
    },
    async routingOperationsByArticle() {
      const map = new Map<string, Map<number, { id: string; costingOnly: boolean }>>();
      for (const op of options.operations ?? []) {
        const perArticle = map.get(op.articleId) ?? new Map();
        perArticle.set(op.sequenceNo, { id: `op-${op.articleId}-${op.sequenceNo}`, costingOnly: op.costingOnly ?? false });
        map.set(op.articleId, perArticle);
      }
      return map;
    },
    async allBomEdges() {
      return options.edges ?? [];
    },
    async resolveDefaults() {
      resolveDefaultsCalls++;
      return { unitId: "unit-st", locationId: "loc-fallback" };
    },
  };
}

// resolveDefaults() creates the "st" unit and the "***" location on first use,
// so a preview must not call it unless createMissingArticles is set.
let resolveDefaultsCalls = 0;

// Monitor G5's Materiallista, exactly as importService.parse hands it on: the
// parent and the component share the headings "Artikelnummer" and
// "Artikelbenämning", and parse() has already suffixed the repeats.
const MATERIALLISTA_HEADERS = [
  "Huvudartikel", "Artikelbenämning", "Status", "Beredare", "Spärrad (material)", "Pos.",
  "Artikelnummer", "Artikelbenämning (2)", "A", "Ersättningsartikel", "Artikeltyp",
  "Till operation", "Pgrp", "Inst.kvant.", "Extra %", "Kvantitet", "Enhet", "Standardpris",
  "End. kal.", "Instruktion", "Filer (material)", "Villkor", "Från och med", "Till och med",
];

// The wide mapping the Materiallista produces — used by the createMissingArticles tests.
const FULL_MAPPING = {
  Huvudartikel: "articleNumber",
  Artikelnummer: "componentNumber",
  Benämning: "componentName",
  Artikeltyp: "componentType",
  "Till operation": "operationSequenceNo",
  Kvantitet: "quantity",
  Enhet: "unitCode",
  Standardpris: "componentStandardCost",
};

describe("suggestBomMapping", () => {
  it("guesses the primary headings for every field", () => {
    const suggested = suggestBomMapping(["Artikelnummer", "Komponentnummer", "Antal", "Enhet", "Operation"]);
    expect(Object.values(suggested)).toEqual([
      "articleNumber",
      "componentNumber",
      "quantity",
      "unitCode",
      "operationSequenceNo",
    ]);
  });

  it("recognises alternate spellings and leaves unknown columns unmapped", () => {
    const suggested = suggestBomMapping(["Huvudartikel", "Ingående artikel", "Åtgång", "Enhetskod", "Op.nr", "Notering"]);
    expect(suggested["Huvudartikel"]).toBe("articleNumber");
    expect(suggested["Ingående artikel"]).toBe("componentNumber");
    expect(suggested["Åtgång"]).toBe("quantity");
    expect(suggested["Enhetskod"]).toBe("unitCode");
    expect(suggested["Op.nr"]).toBe("operationSequenceNo");
    expect(suggested["Notering"]).toBeNull();
  });

  it("maps a SOLE Artikelbenämning column to the component's name", () => {
    // The secondary dictionary only fires for a column that lost a contest,
    // so a plain structure file with one name column used to leave
    // componentName unmapped — and every row then failed with "Benämning
    // saknas" under Skapa saknade artiklar.
    const suggested = suggestBomMapping(["Artikelnummer", "Komponentnummer", "Artikelbenämning", "Antal"]);
    expect(suggested["Artikelbenämning"]).toBe("componentName");
    expect(suggested["Artikelnummer"]).toBe("articleNumber");
    expect(suggested["Komponentnummer"]).toBe("componentNumber");
  });

  it("leaves the sole-name rule alone when the file has two name columns", () => {
    // Two candidates is exactly the Materiallista shape: the first column is
    // the PARENT's name and the secondary dictionary has already claimed the
    // second. The rule must not reach in and map the parent's.
    const suggested = suggestBomMapping(["Huvudartikel", "Artikelbenämning", "Artikelnummer", "Artikelbenämning (2)"]);
    expect(suggested["Artikelbenämning"]).toBeNull();
    expect(suggested["Artikelbenämning (2)"]).toBe("componentName");
  });

  it("does not steal a name column when Komponentens benämning already won the field", () => {
    const suggested = suggestBomMapping(["Artikelnummer", "Komponentnummer", "Komponentens benämning", "Benämning"]);
    expect(suggested["Komponentens benämning"]).toBe("componentName");
    expect(suggested["Benämning"]).toBeNull();
  });

  it("maps Monitor G5:s Materiallista column by column", () => {
    const suggested = suggestBomMapping(MATERIALLISTA_HEADERS);
    expect(suggested).toEqual({
      Huvudartikel: "articleNumber",
      // The FIRST Artikelbenämning is the PARENT's name — this import does not
      // store it, so it must stay unmapped.
      Artikelbenämning: null,
      Status: null,
      Beredare: null,
      "Spärrad (material)": null,
      "Pos.": "position",
      // Secondary alias: articleNumber was claimed by Huvudartikel.
      Artikelnummer: "componentNumber",
      "Artikelbenämning (2)": "componentName",
      A: null,
      Ersättningsartikel: null,
      Artikeltyp: "componentType",
      "Till operation": "operationSequenceNo",
      Pgrp: null,
      "Inst.kvant.": null,
      "Extra %": null,
      Kvantitet: "quantity",
      Enhet: "unitCode",
      Standardpris: "componentStandardCost",
      "End. kal.": null,
      Instruktion: null,
      "Filer (material)": null,
      Villkor: null,
      "Från och med": null,
      "Till och med": null,
    });
  });

  it("lets a primary alias win — the secondary steals nothing", () => {
    const suggested = suggestBomMapping(["Artikelnummer", "Komponentnummer", "Antal"]);
    expect(suggested).toEqual({
      Artikelnummer: "articleNumber",
      Komponentnummer: "componentNumber",
      Antal: "quantity",
    });
  });
});

describe("planBomImport", () => {
  const parentAndTwoComponents = {
    articles: [article("A-1", "id-a"), article("K-1", "id-k1"), article("K-2", "id-k2")],
  };

  it("plans two new structure rows on an existing article", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "2", "", ""], ["A-1", "K-2", "1,5", "", ""]] },
      fakeDeps(parentAndTwoComponents)
    );

    expect(plan.rows.every((row) => row.errors.length === 0)).toBe(true);
    expect(plan.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(plan.summary).toEqual({ create: 2, update: 0, skip: 0, error: 0, warning: 0 });
    expect(plan.willCreate).toEqual({ units: [], articleGroups: [], articles: [] });
    expect(plan.creates).toEqual([
      { parentArticleId: "id-a", componentArticleId: "id-k1", componentNumber: "K-1", quantity: 2, unitId: null, unitFactor: null, routingOperationId: null },
      { parentArticleId: "id-a", componentArticleId: "id-k2", componentNumber: "K-2", quantity: 1.5, unitId: null, unitFactor: null, routingOperationId: null },
    ]);
  });

  it("errors on a missing or unknown article or component", async () => {
    const plan = await planBomImport(
      {
        mapping: MAPPING,
        rows: [["", "K-1", "1", "", ""], ["SAKNAS", "K-1", "1", "", ""], ["A-1", "", "1", "", ""], ["A-1", "SAKNAS", "1", "", ""]],
      },
      fakeDeps(parentAndTwoComponents)
    );

    expect(plan.rows[0]!.errors).toContain("Artikelnummer saknas");
    expect(plan.rows[1]!.errors).toContain("Artikeln SAKNAS finns inte i artikelregistret");
    expect(plan.rows[2]!.errors).toContain("Komponentnummer saknas");
    expect(plan.rows[3]!.errors).toContain("Komponenten SAKNAS finns inte i artikelregistret");
    expect(plan.creates).toHaveLength(0);
  });

  it("rejects an article as its own component", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "A-1", "1", "", ""]] },
      fakeDeps(parentAndTwoComponents)
    );
    expect(plan.rows[0]!.errors).toContain("En artikel kan inte ingå i sin egen struktur");
  });

  it("warns but does not block when the parent is neither manufactured nor a phantom", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["K-3", "K-1", "1", "", ""], ["F-1", "K-1", "1", "", ""]] },
      fakeDeps({
        articles: [
          article("K-3", "id-k3", { type: "purchased" }),
          article("F-1", "id-f", { type: "purchased", isPhantom: true }),
          article("K-1", "id-k1"),
        ],
      })
    );

    expect(plan.rows[0]!.warnings).toEqual([
      "Artikeln K-3 är inte tillverkad — strukturen används inte vid tillverkning",
    ]);
    // A phantom is never manufactured itself but its structure is very much used.
    expect(plan.rows[1]!.warnings).toEqual([]);
    expect(plan.creates).toHaveLength(2);
  });

  it("rejects a component that is already in the structure", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "1", "", ""]] },
      fakeDeps({ ...parentAndTwoComponents, edges: [{ parentId: "id-a", componentId: "id-k1" }] })
    );

    expect(plan.rows[0]!.errors).toEqual([
      "Komponenten K-1 finns redan i strukturen för A-1 — ta bort raden ur filen",
    ]);
    expect(plan.creates).toHaveLength(0);
  });

  it("skips a component that is already in the structure when skipExisting is set", async () => {
    const plan = await planBomImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "K-1", "1", "", ""],
          ["A-1", "K-2", "3", "", ""],
        ],
        skipExisting: true,
      },
      fakeDeps({ ...parentAndTwoComponents, edges: [{ parentId: "id-a", componentId: "id-k1" }] })
    );

    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.skipReason).toBe("Komponenten K-1 finns redan i strukturen för A-1");
    expect(plan.rows[0]!.values).toEqual({
      articleNumber: "A-1",
      componentNumber: "K-1",
      quantity: "1",
      unitCode: "",
      operationSequenceNo: "",
    });
    expect(plan.rows[1]!.action).toBe("create");
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 1, error: 0, warning: 0 });
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates).toEqual([
      {
        parentArticleId: "id-a",
        componentArticleId: "id-k2",
        componentNumber: "K-2",
        quantity: 3,
        unitId: null,
        unitFactor: null,
        routingOperationId: null,
      },
    ]);
  });

  it("keeps the cycle check aligned when a row before the cyclic one is skipped", async () => {
    // The skip branch must push its null onto `staged`, or the cycle pass
    // blames the wrong row.
    const plan = await planBomImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "K-1", "1", "", ""],
          ["K-2", "A-1", "1", "", ""],
        ],
        skipExisting: true,
      },
      fakeDeps({
        ...parentAndTwoComponents,
        edges: [
          { parentId: "id-a", componentId: "id-k1" },
          { parentId: "id-k2", componentId: "id-a" },
        ],
      })
    );

    expect(plan.rows.map((row) => row.action)).toEqual(["skip", "skip"]);
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates).toHaveLength(0);
  });

  it("still errors on an in-file duplicate that is not yet in the structure", async () => {
    const plan = await planBomImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "K-1", "1", "", ""],
          ["A-1", "K-1", "1", "", ""],
        ],
        skipExisting: true,
      },
      fakeDeps(parentAndTwoComponents)
    );

    expect(plan.rows[1]!.errors).toContain("Komponenten K-1 för artikel A-1 förekommer flera gånger i filen");
    expect(plan.hasErrors).toBe(true);
  });

  it("rejects the same component twice in the file, even at different operations", async () => {
    // bom_components is unique on (parent, component) — the operation is not
    // part of the key, so two rows for one component can never both land.
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "1", "", "10"], ["A-1", "K-1", "1", "", "20"]] },
      fakeDeps({
        ...parentAndTwoComponents,
        operations: [
          { articleId: "id-a", sequenceNo: 10 },
          { articleId: "id-a", sequenceNo: 20 },
        ],
      })
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.errors).toContain("Komponenten K-1 för artikel A-1 förekommer flera gånger i filen");
    expect(plan.creates).toHaveLength(1);
  });

  it("rejects a missing, malformed or non-positive quantity", async () => {
    const plan = await planBomImport(
      {
        mapping: MAPPING,
        rows: [["A-1", "K-1", "", "", ""], ["A-1", "K-2", "x", "", ""], ["A-1", "K-1", "0", "", ""], ["A-1", "K-2", "-2", "", ""]],
      },
      fakeDeps(parentAndTwoComponents)
    );

    expect(plan.rows[0]!.errors).toContain("Antal saknas");
    expect(plan.rows[1]!.errors).toContain('Ogiltigt antal: "x"');
    expect(plan.rows[2]!.errors).toContain("Antalet måste vara större än 0");
    expect(plan.rows[3]!.errors).toContain("Antalet måste vara större än 0");
  });

  it("treats the component's base unit as no unit at all", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "3", "st", ""]] },
      fakeDeps(parentAndTwoComponents)
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.creates[0]).toMatchObject({ quantity: 3, unitId: null, unitFactor: null });
  });

  it("converts an alternative unit to the component's base unit and snapshots the factor", async () => {
    // 1 st of K-1 weighs 5 kg, so 10 kg is 2 st.
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "10", "KG", ""]] },
      fakeDeps({
        ...parentAndTwoComponents,
        units: [
          { id: "unit-st", code: "st" },
          { id: "unit-kg", code: "kg" },
        ],
        factors: { "id-k1": { "unit-kg": 5 } },
      })
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.creates[0]).toMatchObject({ quantity: 2, unitId: "unit-kg", unitFactor: 5 });
  });

  it("rejects an unknown unit and one the component does not carry", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "1", "hektar", ""], ["A-1", "K-2", "1", "kg", ""]] },
      fakeDeps({
        ...parentAndTwoComponents,
        units: [
          { id: "unit-st", code: "st" },
          { id: "unit-kg", code: "kg" },
        ],
        factors: { "id-k1": { "unit-kg": 5 } },
      })
    );

    expect(plan.rows[0]!.errors).toContain("Enheten hektar finns inte i enhetsregistret");
    expect(plan.rows[1]!.errors).toContain(
      "Enheten kg är inte upplagd på komponenten K-2 — lägg upp den som alternativ enhet först"
    );
  });

  it("links a row to the parent's own operation", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "1", "", "10"]] },
      fakeDeps({ ...parentAndTwoComponents, operations: [{ articleId: "id-a", sequenceNo: 10 }] })
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.creates[0]!.routingOperationId).toBe("op-id-a-10");
  });

  it("rejects a malformed, unknown or Kalkyl operation", async () => {
    const plan = await planBomImport(
      {
        mapping: MAPPING,
        rows: [["A-1", "K-1", "1", "", "abc"], ["A-1", "K-2", "1", "", "99"], ["A-1", "K-1", "1", "", "20"]],
      },
      fakeDeps({
        ...parentAndTwoComponents,
        operations: [
          { articleId: "id-a", sequenceNo: 10 },
          { articleId: "id-a", sequenceNo: 20, costingOnly: true },
        ],
      })
    );

    expect(plan.rows[0]!.errors).toContain('Ogiltig operation: "abc" (ange ett heltal större än 0)');
    // A sequence number that is not on the routing is a WARNING, not an error
    // — see the dedicated test below.
    expect(plan.rows[1]!.errors).toEqual([]);
    expect(plan.rows[2]!.errors).toContain(
      "Operation 20 på artikel A-1 är en kalkyloperation och kan inte förbruka material"
    );
  });

  it("warns instead of erroring when the operation is not on the article's routing", async () => {
    const plan = await planBomImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "K-1", "1", "", "99"],
          ["A-1", "K-2", "1", "", "10"],
        ],
      },
      // K-2's row links; K-1's does not. A-1 HAS a routing, so the message
      // names the missing sequence number.
      fakeDeps({ ...parentAndTwoComponents, operations: [{ articleId: "id-a", sequenceNo: 10 }] })
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.warnings).toContain(
      "Operation 99 finns inte på artikel A-1 — materialet kopplas inte till någon operation och dras i takt med inleveransen av färdiga varor"
    );
    expect(plan.hasErrors).toBe(false);
    // The row is imported, just without the link.
    expect(plan.creates).toHaveLength(2);
    expect(plan.creates[0]!.routingOperationId).toBeNull();
    expect(plan.creates[1]!.routingOperationId).toBe("op-id-a-10");
  });

  it("names the missing routing when the article has no operations at all", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "1", "", "10"]] },
      fakeDeps({ ...parentAndTwoComponents, operations: [] })
    );

    expect(plan.rows[0]!.warnings).toContain(
      "Artikel A-1 har ingen rutt — materialet kopplas inte till någon operation och dras i takt med inleveransen av färdiga varor"
    );
    expect(plan.hasErrors).toBe(false);
  });

  it("blames the row that closes a cycle against the existing structure", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["K-1", "A-1", "1", "", ""]] },
      fakeDeps({ ...parentAndTwoComponents, edges: [{ parentId: "id-a", componentId: "id-k1" }] })
    );

    expect(plan.rows[0]!.errors).toEqual(["Raden skapar en cirkulär struktur — A-1 innehåller redan K-1"]);
    expect(plan.creates).toHaveLength(0);
    expect(plan.hasErrors).toBe(true);
    // summarize runs AFTER the cycle pass, so the row counts as an error.
    expect(plan.summary).toEqual({ create: 0, update: 0, skip: 0, error: 1, warning: 0 });
  });

  it("blames only the closing row when two rows in the file form the cycle", async () => {
    const plan = await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "1", "", ""], ["K-1", "A-1", "1", "", ""]] },
      fakeDeps(parentAndTwoComponents)
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.errors).toHaveLength(1);
    expect(plan.creates).toHaveLength(1);
  });

  it("requires the three mandatory columns to be mapped", async () => {
    await expect(
      planBomImport({ mapping: { Artikelnummer: "articleNumber" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
  });

  // --- createMissingArticles ---

  const onlyParent = { articles: [article("A-1", "id-a")] };

  it("errors on an unknown component and stages nothing without the flag", async () => {
    const plan = await planBomImport(
      { mapping: FULL_MAPPING, rows: [["A-1", "K-NY", "Ny komponent", "Köpt", "", "2", "st", "12,50"]] },
      fakeDeps(onlyParent)
    );

    expect(plan.rows[0]!.errors).toContain("Komponenten K-NY finns inte i artikelregistret");
    expect(plan.articleCreates).toEqual([]);
    expect(plan.willCreate.articles).toEqual([]);
  });

  it("stages the missing component as a new article with the flag", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [["A-1", "K-NY", "Ny komponent", "Köpt", "", "2", "st", "12,50"]],
        createMissingArticles: true,
      },
      fakeDeps({ ...onlyParent, units: [{ id: "unit-st", code: "st" }] })
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.warnings).toContain("Komponenten K-NY finns inte och skapas som ny artikel");
    expect(plan.hasErrors).toBe(false);
    expect(plan.willCreate.articles).toEqual(["K-NY"]);
    expect(plan.articleCreates).toEqual([
      {
        articleNumber: "K-NY",
        name: "Ny komponent",
        type: "purchased",
        isPhantom: false,
        unitCode: "st",
        standardCost: 12.5,
      },
    ]);
    // The structure row rides along with a null id, resolved in the tx.
    expect(plan.creates).toEqual([
      {
        parentArticleId: "id-a",
        componentArticleId: null,
        componentNumber: "K-NY",
        quantity: 2,
        unitId: null,
        unitFactor: null,
        routingOperationId: null,
      },
    ]);
    expect(plan.fallbackUnitId).toBe("unit-st");
    expect(plan.fallbackLocationId).toBe("loc-fallback");
  });

  it("never creates the PARENT, not even when the flag is set", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-OKÄND", "K-NY", "Ny komponent", "Köpt", "", "1", "st", ""],
          // The same number as a component on another row must not help either.
          ["A-1", "A-OKÄND", "Okänd som komponent", "Köpt", "", "1", "st", ""],
        ],
        createMissingArticles: true,
      },
      fakeDeps({ ...onlyParent, units: [{ id: "unit-st", code: "st" }] })
    );

    expect(plan.rows[0]!.errors).toContain("Artikeln A-OKÄND finns inte i artikelregistret");
    expect(plan.hasErrors).toBe(true);
  });

  it("creates one article when the same new component appears on several rows", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-1", "K-NY", "Ny komponent", "Köpt", "", "1", "st", "10"],
          ["A-2", "K-NY", "Ny komponent", "Köpt", "", "3", "st", "10"],
        ],
        createMissingArticles: true,
      },
      fakeDeps({
        articles: [article("A-1", "id-a"), article("A-2", "id-a2")],
        units: [{ id: "unit-st", code: "st" }],
      })
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.articleCreates).toHaveLength(1);
    expect(plan.willCreate.articles).toEqual(["K-NY"]);
    // Only the first row announces the creation.
    expect(plan.rows[0]!.warnings).toHaveLength(1);
    expect(plan.rows[1]!.warnings).toEqual([]);
  });

  it("warns when a later row disagrees about name, type or price — the first wins", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-1", "K-NY", "Första namnet", "Köpt", "", "1", "st", "10"],
          ["A-2", "K-NY", "Annat namn", "Tillverkad", "", "1", "st", "20"],
        ],
        createMissingArticles: true,
      },
      fakeDeps({
        articles: [article("A-1", "id-a"), article("A-2", "id-a2")],
        units: [{ id: "unit-st", code: "st" }],
      })
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.rows[1]!.warnings).toEqual([
      'Benämningen för K-NY avviker från en tidigare rad — "Första namnet" används',
      "Artikeltypen för K-NY avviker från en tidigare rad",
      "Standardpriset för K-NY avviker från en tidigare rad",
    ]);
    expect(plan.articleCreates[0]!.name).toBe("Första namnet");
    expect(plan.articleCreates[0]!.type).toBe("purchased");
    expect(plan.articleCreates[0]!.standardCost).toBe(10);
  });

  it("errors when a later row gives the new component a different unit", async () => {
    // A new article has exactly one base unit and no alternative units.
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-1", "K-NY", "Ny komponent", "Köpt", "", "1", "kg", ""],
          ["A-2", "K-NY", "Ny komponent", "Köpt", "", "1", "st", ""],
        ],
        createMissingArticles: true,
      },
      fakeDeps({
        articles: [article("A-1", "id-a"), article("A-2", "id-a2")],
        units: [{ id: "unit-st", code: "st" }],
      })
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.errors).toContain(
      "Enheten st är inte upplagd på komponenten K-NY — lägg upp den som alternativ enhet först"
    );
  });

  it("treats a blank unit on the first row as st, so a later st row matches", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-1", "K-NY", "Ny", "Köpt", "", "1", "", ""],
          ["A-2", "K-NY", "Ny", "Köpt", "", "1", "st", ""],
        ],
        createMissingArticles: true,
      },
      fakeDeps({
        articles: [article("A-1", "id-a"), article("A-2", "id-a2")],
        units: [{ id: "unit-st", code: "st" }],
      })
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.articleCreates[0]!.unitCode).toBeNull();
  });

  it("queues an unknown unit for creation instead of erroring on a new component", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [["A-1", "K-NY", "Stålplåt", "Köpt", "", "4,8", "kg", "15"]],
        createMissingArticles: true,
      },
      fakeDeps({ ...onlyParent, units: [{ id: "unit-st", code: "st" }] })
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.willCreate.units).toEqual(["kg"]);
    // The row's unit IS the new article's base unit, so nothing is converted.
    expect(plan.creates[0]!.unitId).toBeNull();
    expect(plan.creates[0]!.unitFactor).toBeNull();
    expect(plan.creates[0]!.quantity).toBe(4.8);
  });

  it("still errors on an unknown unit for an EXISTING component", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [["A-1", "K-1", "", "", "", "1", "kg", ""]],
        createMissingArticles: true,
      },
      fakeDeps({ ...parentAndTwoComponents, units: [{ id: "unit-st", code: "st" }] })
    );

    expect(plan.rows[0]!.errors).toContain("Enheten kg finns inte i enhetsregistret");
    expect(plan.articleCreates).toEqual([]);
  });

  it("reads Monitor's article types, falling back to the wizard's Standardtyp", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-1", "K-F", "Fantom", "Fiktiv", "", "1", "st", ""],
          ["A-1", "K-T", "Tillverkad", "Tillverkad", "", "1", "st", ""],
          ["A-1", "K-TOM", "Utan typ", "", "", "1", "st", ""],
          ["A-1", "K-FEL", "Fel typ", "Blah", "", "1", "st", ""],
        ],
        createMissingArticles: true,
        defaults: { articleType: "service" },
      },
      fakeDeps({ ...onlyParent, units: [{ id: "unit-st", code: "st" }] })
    );

    expect(plan.articleCreates[0]).toMatchObject({ type: "manufactured", isPhantom: true });
    expect(plan.articleCreates[1]).toMatchObject({ type: "manufactured", isPhantom: false });
    expect(plan.articleCreates[2]).toMatchObject({ type: "service", isPhantom: false });
    expect(plan.rows[3]!.errors).toContain('Okänd artikeltyp: "Blah"');
  });

  it("rejects a new component without a name, and a negative price", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-1", "K-A", "", "Köpt", "", "1", "st", ""],
          ["A-1", "K-B", "Med namn", "Köpt", "", "1", "st", "-5"],
        ],
        createMissingArticles: true,
      },
      fakeDeps({ ...onlyParent, units: [{ id: "unit-st", code: "st" }] })
    );

    expect(plan.rows[0]!.errors).toContain("Benämning saknas för den nya komponenten K-A");
    expect(plan.rows[1]!.errors).toContain("Standardpriset för K-B kan inte vara negativt");
  });

  it("stages no article for a row that skipExisting skips", async () => {
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [["A-1", "K-1", "Finns redan", "Köpt", "", "1", "st", ""]],
        skipExisting: true,
        createMissingArticles: true,
      },
      fakeDeps({ ...parentAndTwoComponents, edges: [{ parentId: "id-a", componentId: "id-k1" }] })
    );

    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.articleCreates).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  it("errors when the same new component sits on the same parent twice", async () => {
    // Without a synthetic key this would slip past the planner and hit the
    // (parent, component) unique index as a 409 at commit.
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-1", "K-NY", "Ny", "Köpt", "", "1", "st", ""],
          ["A-1", "K-NY", "Ny", "Köpt", "", "2", "st", ""],
        ],
        createMissingArticles: true,
      },
      fakeDeps({ ...onlyParent, units: [{ id: "unit-st", code: "st" }] })
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.errors).toContain(
      "Komponenten K-NY för artikel A-1 förekommer flera gånger i filen"
    );
  });

  it("keeps two different new components apart in the cycle graph", async () => {
    // Both are synthetic "new:" nodes; merging them into one would invent an
    // edge that is not in the file.
    const plan = await planBomImport(
      {
        mapping: FULL_MAPPING,
        rows: [
          ["A-1", "K-NY1", "Ny 1", "Köpt", "", "1", "st", ""],
          ["A-1", "K-NY2", "Ny 2", "Köpt", "", "1", "st", ""],
        ],
        createMissingArticles: true,
      },
      fakeDeps({ ...onlyParent, units: [{ id: "unit-st", code: "st" }] })
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.creates).toHaveLength(2);
  });

  it("does not call resolveDefaults when the flag is off", async () => {
    // resolveDefaults CREATES the "st" unit and the "***" location — a plain
    // structure preview must not have that side effect.
    resolveDefaultsCalls = 0;
    await planBomImport({ mapping: MAPPING, rows: [["A-1", "K-1", "1", "", ""]] }, fakeDeps(parentAndTwoComponents));
    expect(resolveDefaultsCalls).toBe(0);

    await planBomImport(
      { mapping: MAPPING, rows: [["A-1", "K-1", "1", "", ""]], createMissingArticles: true },
      fakeDeps(parentAndTwoComponents)
    );
    expect(resolveDefaultsCalls).toBe(1);
  });
});

// --- Integration: repository and service against a real Postgres ---

const repo = createImportRepository(db);
const importService = createImportService(repo);

const TRUNCATE = sql`TRUNCATE bom_components, routing_operations, article_units, articles, work_centers CASCADE`;

// `units` is deliberately NOT truncated — the whole suite shares the register
// and seeds "st" into it. But this file's import now CREATES units, and a code
// left behind by an earlier run makes onConflictDoNothing return nothing, so
// the "was the unit created?" assertions would pass on run 1 and fail on run 2.
// Clearing just the codes these tests invent keeps them deterministic without
// pulling the rug out from under every other file.
const TEST_UNIT_CODES = ["kgx", "kgy", "kgz"];

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(units).where(inArray(units.code, TEST_UNIT_CODES));
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(units).where(inArray(units.code, TEST_UNIT_CODES));
});

async function unitId(code: string, name: string) {
  await db.insert(units).values({ code, name }).onConflictDoNothing();
  const [unit] = await db.select({ id: units.id }).from(units).where(sql`${units.code} = ${code}`);
  return unit!.id;
}

async function seedArticle(articleNumber: string, type: "manufactured" | "purchased" = "manufactured") {
  const [article] = await db
    .insert(articlesTable)
    .values({ articleNumber, name: articleNumber, type, unitId: await unitId("st", "Styck") })
    .returning({ id: articlesTable.id });
  return article!.id;
}

describe("bom import — repository", () => {
  it("returns every structure edge in the table", async () => {
    const parentId = await seedArticle("A-1");
    const componentId = await seedArticle("K-1", "purchased");
    await db.insert(bomComponents).values({ parentArticleId: parentId, componentArticleId: componentId, quantity: "2" });

    expect(await repo.allBomEdges()).toEqual([{ id: expect.any(String), parentId, componentId }]);
  });

  it("maps a component's alternative unit factors", async () => {
    const componentId = await seedArticle("K-1", "purchased");
    const kg = await unitId("kg", "Kilogram");
    await db.insert(articleUnits).values({ articleId: componentId, unitId: kg, quantityPerBase: "5" });

    const map = await repo.articleUnitFactors([componentId]);
    expect(map.get(componentId)!.get(kg)).toBe(5);
  });

  it("writes base-unit quantities plus the display unit and factor snapshot", async () => {
    const parentId = await seedArticle("A-1");
    const componentId = await seedArticle("K-1", "purchased");
    const kg = await unitId("kg", "Kilogram");

    const result = await repo.executeBomPlan({
      rows: [],
      summary: { create: 1, update: 0, skip: 0, error: 0, warning: 0 },
      willCreate: { units: [], articleGroups: [], articles: [] },
      articleCreates: [],
      fallbackUnitId: null,
      fallbackLocationId: null,
      hasErrors: false,
      creates: [
        {
          parentArticleId: parentId,
          componentArticleId: componentId,
          componentNumber: "K-1",
          quantity: 2,
          unitId: kg,
          unitFactor: 5,
          routingOperationId: null,
        },
      ],
    });

    expect(result).toEqual({ created: 1, updated: 0, registersCreated: { units: [], articleGroups: [], articles: [] } });
    const [stored] = await db.select().from(bomComponents);
    expect(stored!.quantity).toBe("2.0000");
    expect(stored!.unitId).toBe(kg);
    expect(stored!.unitFactor).toBe("5.000000");
  });

  it("creates the missing unit, article, price history and structure row in one transaction", async () => {
    const parentId = await seedArticle("A-1");
    const fallback = await repo.resolveDefaults();

    const result = await repo.executeBomPlan({
      rows: [],
      summary: { create: 1, update: 0, skip: 0, error: 0, warning: 1 },
      willCreate: { units: ["kgx"], articleGroups: [], articles: ["K-NY"] },
      articleCreates: [
        {
          articleNumber: "K-NY",
          name: "Stålplåt 2000x1000x3",
          type: "purchased",
          isPhantom: false,
          unitCode: "kgx",
          standardCost: 12.45,
        },
      ],
      fallbackUnitId: fallback.unitId,
      fallbackLocationId: fallback.locationId,
      hasErrors: false,
      creates: [
        {
          parentArticleId: parentId,
          componentArticleId: null,
          componentNumber: "K-NY",
          quantity: 0.3,
          unitId: null,
          unitFactor: null,
          routingOperationId: null,
        },
      ],
    });

    expect(result).toEqual({
      created: 1,
      updated: 0,
      registersCreated: { units: ["kgx"], articleGroups: [], articles: ["K-NY"] },
    });

    const [created] = await db
      .select()
      .from(articlesTable)
      .where(sql`${articlesTable.articleNumber} = 'K-NY'`);
    expect(created!.name).toBe("Stålplåt 2000x1000x3");
    expect(created!.type).toBe("purchased");
    expect(created!.standardCost).toBe("12.4500");
    expect(created!.defaultLocationId).toBe(fallback.locationId);
    const [newUnit] = await db.select({ id: units.id }).from(units).where(sql`${units.code} = 'kgx'`);
    expect(created!.unitId).toBe(newUnit!.id);

    const history = await db.execute(
      sql`select cost from article_standard_cost_history where article_id = ${created!.id}`
    );
    expect(history).toHaveLength(1);

    const [stored] = await db.select().from(bomComponents);
    expect(stored!.componentArticleId).toBe(created!.id);
    expect(stored!.quantity).toBe("0.3000");
  });

  it("rolls the new unit and article back when the structure insert fails", async () => {
    const parentId = await seedArticle("A-1");
    const fallback = await repo.resolveDefaults();
    const plan = {
      rows: [],
      summary: { create: 2, update: 0, skip: 0, error: 0, warning: 0 },
      willCreate: { units: ["kgy"], articleGroups: [], articles: ["K-ROLL"] },
      articleCreates: [
        {
          articleNumber: "K-ROLL",
          name: "Rullas tillbaka",
          type: "purchased" as const,
          isPhantom: false,
          unitCode: "kgy",
          standardCost: null,
        },
      ],
      fallbackUnitId: fallback.unitId,
      fallbackLocationId: fallback.locationId,
      hasErrors: false,
      // The same pair twice violates the (parent, component) unique index —
      // the planner would have caught it, so this forces the failure past it.
      creates: [
        { parentArticleId: parentId, componentArticleId: null, componentNumber: "K-ROLL", quantity: 1, unitId: null, unitFactor: null, routingOperationId: null },
        { parentArticleId: parentId, componentArticleId: null, componentNumber: "K-ROLL", quantity: 1, unitId: null, unitFactor: null, routingOperationId: null },
      ],
    };

    await expect(repo.executeBomPlan(plan)).rejects.toThrow();

    expect(await db.select().from(articlesTable).where(sql`${articlesTable.articleNumber} = 'K-ROLL'`)).toHaveLength(0);
    expect(await db.select().from(units).where(sql`${units.code} = 'kgy'`)).toHaveLength(0);
    expect(await db.select().from(bomComponents)).toHaveLength(0);
  });
});

describe("import service — bom entity", () => {
  it("accepts bom in the entity enum", () => {
    expect(importEntitySchema.options).toContain("bom");
  });

  it("suggests the bom mapping through parse", async () => {
    const result = await importService.parse(
      "bom",
      Buffer.from("Huvudartikel;Ingående artikel;Åtgång;Enhet;Op.nr;Okänd\nA-1;K-1;2;st;10;x\n")
    );
    expect(result.suggestedMapping).toEqual({
      Huvudartikel: "articleNumber",
      "Ingående artikel": "componentNumber",
      "Åtgång": "quantity",
      Enhet: "unitCode",
      "Op.nr": "operationSequenceNo",
      "Okänd": null,
    });
  });

  it("commits a structure import end-to-end, linking the row to an operation", async () => {
    const parentId = await seedArticle("A-1");
    const componentId = await seedArticle("K-1", "purchased");
    const [workCenter] = await db
      .insert(workCenters)
      .values({ code: "110", name: "Svets" })
      .returning({ id: workCenters.id });
    const [operation] = await db
      .insert(routingOperations)
      .values({ articleId: parentId, sequenceNo: 10, workCenterId: workCenter!.id, setupTime: "1", runTimePerUnit: "1" })
      .returning({ id: routingOperations.id });

    const result = await importService.commit("bom", {
      mapping: MAPPING,
      rows: [["A-1", "K-1", "2", "", "10"]],
    });

    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      skippedRows: [],
      registersCreated: { units: [], articleGroups: [], articles: [] },
    });
    const [stored] = await db.select().from(bomComponents);
    expect(stored!.parentArticleId).toBe(parentId);
    expect(stored!.componentArticleId).toBe(componentId);
    expect(stored!.routingOperationId).toBe(operation!.id);
  });

  it("parses a Materiallista header row and maps parent and component apart", async () => {
    // The two "Artikelbenämning" columns come out of parse() suffixed — the
    // one place where the dedup rename and the secondary alias meet.
    const result = await importService.parse(
      "bom",
      Buffer.from(
        "Huvudartikel;Artikelbenämning;Artikelnummer;Artikelbenämning;Artikeltyp;Till operation;Kvantitet;Enhet;Standardpris\n" +
          "A-1;Förälder;K-1;Komponent;Köpt;10;2;st;12,50\n"
      )
    );
    expect(result.suggestedMapping).toEqual({
      Huvudartikel: "articleNumber",
      "Artikelbenämning": null,
      Artikelnummer: "componentNumber",
      "Artikelbenämning (2)": "componentName",
      Artikeltyp: "componentType",
      "Till operation": "operationSequenceNo",
      Kvantitet: "quantity",
      Enhet: "unitCode",
      Standardpris: "componentStandardCost",
    });
  });

  it("creates the missing component and its unit end-to-end", async () => {
    const parentId = await seedArticle("A-1");

    const result = await importService.commit("bom", {
      mapping: FULL_MAPPING,
      rows: [["A-1", "K-NY", "Stålplåt 2000x1000x3", "Köpt", "", "0,3", "kgz", "12,45"]],
      createMissingArticles: true,
    });

    expect(result.created).toBe(1);
    expect(result.registersCreated).toEqual({
      units: ["kgz"],
      articleGroups: [],
      articles: ["K-NY"],
    });

    const [created] = await db
      .select()
      .from(articlesTable)
      .where(sql`${articlesTable.articleNumber} = 'K-NY'`);
    expect(created!.type).toBe("purchased");
    expect(created!.standardCost).toBe("12.4500");
    const [stored] = await db.select().from(bomComponents);
    expect(stored!.parentArticleId).toBe(parentId);
    expect(stored!.componentArticleId).toBe(created!.id);
    // The row's unit IS the new article's base unit, so nothing is converted.
    expect(stored!.unitId).toBeNull();
    expect(stored!.quantity).toBe("0.3000");
  });

  it("leaves the article register untouched when the flag is off", async () => {
    await seedArticle("A-1");

    await expect(
      importService.commit("bom", {
        mapping: FULL_MAPPING,
        rows: [["A-1", "K-NY", "Stålplåt", "Köpt", "", "1", "st", ""]],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    expect(await db.select().from(articlesTable).where(sql`${articlesTable.articleNumber} = 'K-NY'`)).toHaveLength(0);
  });

  it("aborts the whole commit on any row error with nothing written", async () => {
    await seedArticle("A-1");
    await seedArticle("K-1", "purchased");

    await expect(
      importService.commit("bom", {
        mapping: MAPPING,
        rows: [
          ["A-1", "K-1", "2", "", ""],
          ["A-1", "SAKNAS", "1", "", ""],
        ],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    expect(await db.select().from(bomComponents)).toHaveLength(0);
  });

  it("skips the rows that already exist and lists them in the response", async () => {
    const parentId = await seedArticle("A-1");
    const componentId = await seedArticle("K-1", "purchased");
    await seedArticle("K-2", "purchased");
    await db
      .insert(bomComponents)
      .values({ parentArticleId: parentId, componentArticleId: componentId, quantity: "2" });

    const result = await importService.commit("bom", {
      mapping: MAPPING,
      rows: [
        ["A-1", "K-1", "9", "", ""],
        ["A-1", "K-2", "3", "", ""],
      ],
      skipExisting: true,
    });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows).toEqual([
      {
        rowNumber: 2,
        reason: "Komponenten K-1 finns redan i strukturen för A-1",
        values: { articleNumber: "A-1", componentNumber: "K-1", quantity: "9", unitCode: "", operationSequenceNo: "" },
      },
    ]);

    const stored = await db.select().from(bomComponents);
    expect(stored).toHaveLength(2);
    // The pre-existing row keeps its quantity — the file's 9 is not written.
    expect(Number(stored.find((row) => row.componentArticleId === componentId)!.quantity)).toBe(2);
  });

  it("refuses a row that already exists in the structure", async () => {
    const parentId = await seedArticle("A-1");
    const componentId = await seedArticle("K-1", "purchased");
    await db.insert(bomComponents).values({ parentArticleId: parentId, componentArticleId: componentId, quantity: "2" });

    const preview = await importService.preview("bom", { mapping: MAPPING, rows: [["A-1", "K-1", "2", "", ""]] });
    expect(preview.rows[0]!.errors).toEqual([
      "Komponenten K-1 finns redan i strukturen för A-1 — ta bort raden ur filen",
    ]);
    expect(preview.summary.error).toBe(1);
  });
});

// --- Pos. and "Uppdatera befintliga strukturrader" (importfält 2026-10) ---
describe("bom import — Pos. and updateExisting", () => {
  const POS_MAPPING = { ...MAPPING, "Pos.": "position" };

  it("maps Monitor's Pos. and stores it on new rows", async () => {
    expect(suggestBomMapping(["Huvudartikel", "Pos.", "Artikelnummer", "Kvantitet"])["Pos."]).toBe("position");
    const plan = await planBomImport(
      { mapping: POS_MAPPING, rows: [["A-1", "K-1", "2", "", "", "12"]] },
      fakeDeps({ articles: [article("A-1", "id-a"), article("K-1", "id-k", { type: "purchased" })] })
    );
    expect(plan.creates[0]).toMatchObject({ componentArticleId: "id-k", position: "12" });

    const tooLong = await planBomImport(
      { mapping: POS_MAPPING, rows: [["A-1", "K-1", "2", "", "", "x".repeat(21)]] },
      fakeDeps({ articles: [article("A-1", "id-a"), article("K-1", "id-k", { type: "purchased" })] })
    );
    expect(tooLong.rows[0]!.errors).toEqual(["Pos. är för lång (21 tecken, max 20)"]);
  });

  it("rewrites an existing row with updateExisting instead of erroring", async () => {
    const deps = fakeDeps({
      articles: [article("A-1", "id-a"), article("K-1", "id-k", { type: "purchased" })],
      edges: [{ id: "row-1", parentId: "id-a", componentId: "id-k" }],
      operations: [{ articleId: "id-a", sequenceNo: 10 }],
    });
    const plain = await planBomImport({ mapping: POS_MAPPING, rows: [["A-1", "K-1", "3", "", "10", "7"]] }, deps);
    expect(plain.rows[0]!.errors[0]).toContain("finns redan i strukturen");

    const plan = await planBomImport(
      { mapping: POS_MAPPING, rows: [["A-1", "K-1", "3", "", "10", "7"]], updateExisting: true },
      deps
    );
    expect(plan.rows[0]!.action).toBe("update");
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([
      { id: "row-1", patch: { quantity: 3, unitId: null, unitFactor: null, routingOperationId: "op-id-a-10", position: "7" } },
    ]);

    // Without the operation column the link is left alone; an empty Pos. too.
    const noOperation = await planBomImport(
      { mapping: { ...MAPPING, Operation: null, "Pos.": "position" }, rows: [["A-1", "K-1", "3", "", "", ""]], updateExisting: true },
      deps
    );
    expect(noOperation.updates![0]!.patch).toEqual({ quantity: 3, unitId: null, unitFactor: null });

    await expect(
      planBomImport({ mapping: POS_MAPPING, rows: [], updateExisting: true, skipExisting: true }, deps)
    ).rejects.toBeInstanceOf(ImportMappingError);
  });

  it("commits the update end-to-end", async () => {
    await seedArticle("A-1");
    await seedArticle("K-1", "purchased");
    await importService.commit("bom", { mapping: MAPPING, rows: [["A-1", "K-1", "2", "", ""]] });
    const result = await importService.commit("bom", {
      mapping: { ...MAPPING, "Pos.": "position" },
      rows: [["A-1", "K-1", "5", "", "", "4"]],
      updateExisting: true,
    });
    expect(result).toMatchObject({ created: 0, updated: 1 });
    const [stored] = await db.select().from(bomComponents);
    expect(stored).toMatchObject({ quantity: "5.0000", position: "4" });
  });
});
