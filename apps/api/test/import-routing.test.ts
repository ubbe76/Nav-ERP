import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { articles as articlesTable, db, manufacturingOrders, moOperations, routingOperations, units, workCenters } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import {
  ImportMappingError,
  ImportValidationError,
  createImportService,
} from "../src/modules/import/service/import.service.js";
import type { ExistingArticle } from "../src/modules/import/service/articles.js";
import {
  parseRoutingTimeUnit,
  planRoutingImport,
  suggestRoutingMapping,
  type RoutingImportDeps,
} from "../src/modules/import/service/routing.js";

const MAPPING = {
  Artikelnummer: "articleNumber",
  Sekvensnr: "sequenceNo",
  Resurs: "workCenterCode",
  "Ställtid": "setupTime",
  "Tid/enhet": "runTimePerUnit",
  Kalkyl: "costingOnly",
};

function article(articleNumber: string, id: string, type: ExistingArticle["type"] = "manufactured"): ExistingArticle {
  return {
    id,
    articleNumber,
    name: articleNumber,
    type,
    unitCode: "st",
    unitId: "unit-st",
    isPhantom: false,
    groupCode: null,
    standardCost: null,
    weight: null,
    active: true,
  };
}

function fakeDeps(
  articles: ExistingArticle[] = [],
  workCenterCodes: string[] = ["110"],
  existingOperations: { articleId: string; sequenceNo: number; costingOnly?: boolean }[] = []
): RoutingImportDeps {
  return {
    async articlesByNumber(numbers) {
      return new Map(articles.filter((a) => numbers.includes(a.articleNumber)).map((a) => [a.articleNumber, a]));
    },
    async workCentersByCode() {
      return new Map(workCenterCodes.map((code) => [code, { id: `wc-${code}`, code }]));
    },
    async routingOperationsByArticle() {
      const map = new Map<string, Map<number, { id: string; costingOnly: boolean }>>();
      for (const op of existingOperations) {
        const perArticle = map.get(op.articleId) ?? new Map();
        perArticle.set(op.sequenceNo, { id: `op-${op.articleId}-${op.sequenceNo}`, costingOnly: op.costingOnly ?? false });
        map.set(op.articleId, perArticle);
      }
      return map;
    },
  };
}

describe("suggestRoutingMapping", () => {
  it("guesses the primary headings for every field", () => {
    const suggested = suggestRoutingMapping([
      "Artikelnummer",
      "Sekvensnr",
      "Resurs",
      "Ställtid",
      "Tid/enhet",
      "Kalkyl",
    ]);
    expect(Object.values(suggested)).toEqual([
      "articleNumber",
      "sequenceNo",
      "workCenterCode",
      "setupTime",
      "runTimePerUnit",
      "costingOnly",
    ]);
  });

  it("recognises alternate spellings and leaves unknown columns unmapped", () => {
    const suggested = suggestRoutingMapping(["Art.nr", "Operationsnr", "Maskin", "Riggtid", "Styckstid", "Pos."]);
    expect(suggested["Art.nr"]).toBe("articleNumber");
    expect(suggested["Operationsnr"]).toBe("sequenceNo");
    expect(suggested["Maskin"]).toBe("workCenterCode");
    expect(suggested["Riggtid"]).toBe("setupTime");
    expect(suggested["Styckstid"]).toBe("runTimePerUnit");
    expect(suggested["Pos."]).toBeNull();
  });

  it("maps Beskrivning to the operation's name, not to the comment", () => {
    // The alias briefly pointed at `comment` (TODO2 #18) and moved when the
    // field it actually names arrived.
    const suggested = suggestRoutingMapping(["Artikelnummer", "Op.", "Produktionsgrupp", "Beskrivning", "Instruktion"]);
    expect(suggested["Beskrivning"]).toBe("description");
    expect(suggested["Instruktion"]).toBe("comment");
  });

  it("recognises Monitor's Instruktion as the Kommentar column", () => {
    const suggested = suggestRoutingMapping(["Artikelnummer", "Op.", "Produktionsgrupp", "Ställtid", "Stycktid", "Instruktion"]);
    expect(suggested["Instruktion"]).toBe("comment");
  });

  it("maps Monitor G5:s operationslista", () => {
    // The real export's headings: "Op." and "Produktionsgrupp" are the two the
    // dictionary used to miss, which left the wizard with no resource column.
    const suggested = suggestRoutingMapping([
      "Artikelnummer",
      "Produktionsgrupp",
      "Artikelbenämning",
      "Op.",
      "Operationens benämning",
      "Ställtid",
      "Stycktid",
      "Endast kalkyl",
    ]);
    expect(suggested["Artikelnummer"]).toBe("articleNumber");
    expect(suggested["Produktionsgrupp"]).toBe("workCenterCode");
    expect(suggested["Op."]).toBe("sequenceNo");
    expect(suggested["Ställtid"]).toBe("setupTime");
    expect(suggested["Stycktid"]).toBe("runTimePerUnit");
    expect(suggested["Endast kalkyl"]).toBe("costingOnly");
    // The article's name still has no home here; the OPERATION's name now does.
    expect(suggested["Artikelbenämning"]).toBeNull();
    expect(suggested["Operationens benämning"]).toBe("description");
  });

  it("maps Monitor's Enhet (the time-unit column) to timeUnit", () => {
    const suggested = suggestRoutingMapping(["Artikelnummer", "Produktionsgrupp", "Op.", "Ställtid", "Stycktid", "Enhet"]);
    expect(suggested["Enhet"]).toBe("timeUnit");
    expect(suggestRoutingMapping(["Tidsenhet"])["Tidsenhet"]).toBe("timeUnit");
  });

  it("recognises Packinstruktion and its alternate spellings", () => {
    const suggested = suggestRoutingMapping(["Artikelnummer", "Op.", "Produktionsgrupp", "Packinstruktion"]);
    expect(suggested["Packinstruktion"]).toBe("packingInstructions");
    expect(suggestRoutingMapping(["Packning"])["Packning"]).toBe("packingInstructions");
    expect(suggestRoutingMapping(["Packinstruktioner"])["Packinstruktioner"]).toBe("packingInstructions");
  });
});

describe("planRoutingImport", () => {
  it("plans two new operations on an existing article", async () => {
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "10", "110", "15", "2", "Nej"],
          ["A-1", "20", "110", "0,5", "1,25", "Ja"],
        ],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows.every((row) => row.errors.length === 0)).toBe(true);
    expect(plan.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    expect(plan.rows.every((row) => row.action === "create")).toBe(true);
    expect(plan.summary).toEqual({ create: 2, update: 0, skip: 0, error: 0, warning: 0 });
    expect(plan.willCreate).toEqual({ units: [], articleGroups: [] });
    expect(plan.hasErrors).toBe(false);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([
      { articleId: "id-1", sequenceNo: 10, workCenterId: "wc-110", setupTime: 15, runTimePerUnit: 2, timeUnit: "minutes_per_unit", costingOnly: false, comment: null, printOnWorkCard: false, description: null, packingInstructions: null },
      { articleId: "id-1", sequenceNo: 20, workCenterId: "wc-110", setupTime: 0.5, runTimePerUnit: 1.25, timeUnit: "minutes_per_unit", costingOnly: true, comment: null, printOnWorkCard: false, description: null, packingInstructions: null },
    ]);
  });

  it("errors on a missing or unknown article number", async () => {
    const plan = await planRoutingImport(
      { mapping: MAPPING, rows: [["", "10", "110", "0", "1", ""], ["SAKNAS", "10", "110", "0", "1", ""]] },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[0]!.errors).toContain("Artikelnummer saknas");
    expect(plan.rows[1]!.errors).toContain("Artikeln SAKNAS finns inte i artikelregistret");
    expect(plan.creates).toHaveLength(0);
    expect(plan.hasErrors).toBe(true);
  });

  it("warns but does not block when the article is not manufactured", async () => {
    const plan = await planRoutingImport(
      { mapping: MAPPING, rows: [["K-1", "10", "110", "0", "1", ""]] },
      fakeDeps([article("K-1", "id-k", "purchased")])
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.warnings).toEqual([
      "Artikeln K-1 är inte tillverkad — operationen används inte vid tillverkning",
    ]);
    expect(plan.creates).toHaveLength(1);
  });

  it("rejects a sequence number that is not a positive integer", async () => {
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [["A-1", "", "110", "0", "1", ""], ["A-1", "abc", "110", "0", "1", ""], ["A-1", "1,5", "110", "0", "1", ""], ["A-1", "0", "110", "0", "1", ""]],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[0]!.errors).toContain("Sekvensnr saknas");
    expect(plan.rows[1]!.errors).toContain('Ogiltigt sekvensnr: "abc" (ange ett heltal större än 0)');
    expect(plan.rows[2]!.errors).toContain('Ogiltigt sekvensnr: "1,5" (ange ett heltal större än 0)');
    expect(plan.rows[3]!.errors).toContain('Ogiltigt sekvensnr: "0" (ange ett heltal större än 0)');
  });

  it("rejects an operation that already exists on the article", async () => {
    const plan = await planRoutingImport(
      { mapping: MAPPING, rows: [["A-1", "10", "110", "0", "1", ""]] },
      fakeDeps([article("A-1", "id-1")], ["110"], [{ articleId: "id-1", sequenceNo: 10 }])
    );

    expect(plan.rows[0]!.errors).toEqual([
      "Operation 10 finns redan på artikel A-1 — ta bort raden ur filen",
    ]);
    expect(plan.creates).toHaveLength(0);
  });

  it("skips an operation that already exists when skipExisting is set", async () => {
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "10", "110", "0", "1", ""],
          ["A-1", "20", "110", "5", "2", ""],
        ],
        skipExisting: true,
      },
      fakeDeps([article("A-1", "id-1")], ["110"], [{ articleId: "id-1", sequenceNo: 10 }])
    );

    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.skipReason).toBe("Operation 10 finns redan på artikel A-1");
    // The whole record rides along so the saved/printed list shows the row.
    expect(plan.rows[0]!.values).toEqual({
      articleNumber: "A-1",
      sequenceNo: "10",
      workCenterCode: "110",
      setupTime: "0",
      runTimePerUnit: "1",
      costingOnly: "",
    });
    expect(plan.rows[1]!.action).toBe("create");
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 1, error: 0, warning: 0 });
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates).toEqual([
      { articleId: "id-1", sequenceNo: 20, workCenterId: "wc-110", setupTime: 5, runTimePerUnit: 2, timeUnit: "minutes_per_unit", costingOnly: false, comment: null, printOnWorkCard: false, description: null, packingInstructions: null },
    ]);
  });

  it("skips an existing operation even when its other cells are invalid", async () => {
    // Nothing is written for the row, so validating the cells would only
    // block a file the user explicitly asked to skip past.
    const plan = await planRoutingImport(
      { mapping: MAPPING, rows: [["A-1", "10", "999", "abc", "", "kanske"]], skipExisting: true },
      fakeDeps([article("A-1", "id-1")], ["110"], [{ articleId: "id-1", sequenceNo: 10 }])
    );

    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.hasErrors).toBe(false);
  });

  it("still errors on an in-file duplicate that does not exist in the database", async () => {
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "10", "110", "0", "1", ""],
          ["A-1", "10", "110", "0", "1", ""],
        ],
        skipExisting: true,
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[1]!.errors).toEqual([
      "Operation 10 för artikel A-1 förekommer flera gånger i filen",
    ]);
    expect(plan.hasErrors).toBe(true);
  });

  it("skips both occurrences when the duplicated operation is already in the database", async () => {
    // Both rows are skipped, so the file cannot conflict with itself — the
    // duplicate is not worth an error that would block the whole import.
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "10", "110", "0", "1", ""],
          ["A-1", "10", "110", "0", "1", ""],
        ],
        skipExisting: true,
      },
      fakeDeps([article("A-1", "id-1")], ["110"], [{ articleId: "id-1", sequenceNo: 10 }])
    );

    expect(plan.rows.map((row) => row.action)).toEqual(["skip", "skip"]);
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates).toHaveLength(0);
  });

  it("rejects the second occurrence of the same operation in the file", async () => {
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [["A-1", "10", "110", "0", "1", ""], ["A-1", "10", "110", "0", "1", ""], ["A-1", "10", "110", "0", "1", ""]],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.errors).toContain("Operation 10 för artikel A-1 förekommer flera gånger i filen");
    // The third row is blamed too — the key is recorded even for failed rows.
    expect(plan.rows[2]!.errors).toContain("Operation 10 för artikel A-1 förekommer flera gånger i filen");
    expect(plan.creates).toHaveLength(1);
  });

  it("reads Monitor's Instruktion column into the operation's Kommentar", async () => {
    const plan = await planRoutingImport(
      {
        mapping: { ...MAPPING, Instruktion: "comment" },
        rows: [
          ["A-1", "10", "110", "0", "1", "", "Kör med skyddsglasögon"],
          ["A-1", "20", "110", "0", "1", "", ""],
        ],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.creates.map((row) => row.comment)).toEqual(["Kör med skyddsglasögon", null]);
    // The file carries no column for the print flag — it is off until the
    // wizard's checkbox says otherwise.
    expect(plan.creates.every((row) => row.printOnWorkCard === false)).toBe(true);
  });

  it("turns on the print flag from the wizard checkbox, but only for rows that have a comment", async () => {
    const plan = await planRoutingImport(
      {
        mapping: { ...MAPPING, Instruktion: "comment" },
        rows: [
          ["A-1", "10", "110", "0", "1", "", "Avsyna innan nästa operation"],
          ["A-1", "20", "110", "0", "1", "", ""],
        ],
        printCommentOnWorkCard: true,
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.creates.map((row) => row.printOnWorkCard)).toEqual([true, false]);
  });

  it("errors on a comment longer than the column allows", async () => {
    const plan = await planRoutingImport(
      {
        mapping: { ...MAPPING, Instruktion: "comment" },
        rows: [["A-1", "10", "110", "0", "1", "", "x".repeat(1001)]],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[0]!.errors).toEqual(["Kommentaren är för lång (1001 tecken, max 1000)"]);
    expect(plan.hasErrors).toBe(true);
    expect(plan.creates).toHaveLength(0);
  });

  it("reads Monitor's Operationens benämning into the operation's Beskrivning", async () => {
    const plan = await planRoutingImport(
      {
        mapping: { ...MAPPING, "Operationens benämning": "description" },
        rows: [
          ["A-1", "10", "110", "0", "1", "", "Kapning"],
          ["A-1", "20", "110", "0", "1", "", ""],
        ],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.creates.map((row) => row.description)).toEqual(["Kapning", null]);
  });

  it("errors on a description longer than the column allows", async () => {
    const plan = await planRoutingImport(
      {
        mapping: { ...MAPPING, "Operationens benämning": "description" },
        rows: [["A-1", "10", "110", "0", "1", "", "x".repeat(256)]],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[0]!.errors).toEqual(["Beskrivningen är för lång (256 tecken, max 255)"]);
    expect(plan.creates).toHaveLength(0);
  });

  it("reads Packinstruktion into the operation's packingInstructions", async () => {
    const plan = await planRoutingImport(
      {
        mapping: { ...MAPPING, Packinstruktion: "packingInstructions" },
        rows: [
          ["A-1", "10", "110", "0", "1", "", "Wellpapp runt kanterna"],
          ["A-1", "20", "110", "0", "1", "", ""],
        ],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.hasErrors).toBe(false);
    expect(plan.creates.map((row) => row.packingInstructions)).toEqual(["Wellpapp runt kanterna", null]);
  });

  it("errors on a packing instruction longer than the column allows — never a silent truncation", async () => {
    const plan = await planRoutingImport(
      {
        mapping: { ...MAPPING, Packinstruktion: "packingInstructions" },
        rows: [["A-1", "10", "110", "0", "1", "", "x".repeat(1001)]],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[0]!.errors).toEqual(["Packinstruktionen är för lång (1001 tecken, max 1000)"]);
    expect(plan.hasErrors).toBe(true);
    expect(plan.creates).toHaveLength(0);
  });

  it("pads a work centre code Excel stripped the leading zeros from", async () => {
    const plan = await planRoutingImport(
      { mapping: MAPPING, rows: [["A-1", "10", "7", "0", "1", ""]] },
      fakeDeps([article("A-1", "id-1")], ["007"])
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    // Padding is Excel's fault, not the user's — no warning either.
    expect(plan.rows[0]!.warnings).toEqual([]);
    expect(plan.creates[0]!.workCenterId).toBe("wc-007");
  });

  it("rejects a missing, malformed or unknown work centre", async () => {
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [["A-1", "10", "", "0", "1", ""], ["A-1", "20", "11X", "0", "1", ""], ["A-1", "30", "999", "0", "1", ""]],
      },
      fakeDeps([article("A-1", "id-1")], ["110"])
    );

    expect(plan.rows[0]!.errors).toContain("Resurs saknas");
    expect(plan.rows[1]!.errors).toContain('Ogiltig resurskod: "11X" (ange tre siffror, t.ex. 110)');
    expect(plan.rows[2]!.errors).toContain("Resursen 999 finns inte i resursregistret");
  });

  it("requires both times and rejects negative or malformed ones", async () => {
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "10", "110", "", "1", ""],
          ["A-1", "20", "110", "0", "", ""],
          ["A-1", "30", "110", "-1", "1", ""],
          ["A-1", "40", "110", "0", "x", ""],
        ],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[0]!.errors).toContain("Ställtid saknas");
    expect(plan.rows[1]!.errors).toContain("Tid per enhet saknas");
    expect(plan.rows[2]!.errors).toContain("Ställtiden kan inte vara negativ");
    expect(plan.rows[3]!.errors).toContain('Ogiltig tid per enhet: "x"');
  });

  it("accepts a zero setup time — the column is required, the value need not be", async () => {
    const plan = await planRoutingImport(
      { mapping: MAPPING, rows: [["A-1", "10", "110", "0", "0", ""]] },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.creates[0]!.setupTime).toBe(0);
  });

  it("reads Kalkyl in the spellings a Swedish spreadsheet produces", async () => {
    const plan = await planRoutingImport(
      {
        mapping: MAPPING,
        rows: [
          ["A-1", "10", "110", "0", "1", "Ja"],
          ["A-1", "20", "110", "0", "1", "true"],
          ["A-1", "30", "110", "0", "1", "1"],
          ["A-1", "40", "110", "0", "1", "Nej"],
          ["A-1", "50", "110", "0", "1", ""],
          ["A-1", "60", "110", "0", "1", "kanske"],
        ],
      },
      fakeDeps([article("A-1", "id-1")])
    );

    expect(plan.creates.map((c) => c.costingOnly)).toEqual([true, true, true, false, false]);
    expect(plan.rows[5]!.errors).toContain('Ogiltigt värde för Kalkyl: "kanske" (Ja/Nej/1/0/true/false)');
  });

  // --- Tidsenhet (Monitor's "Enhet") — storage is always minutes per unit,
  // so the planner converts the file's values once, here. ---
  describe("time unit", () => {
    const UNIT_MAPPING = { ...MAPPING, Enhet: "timeUnit" };

    it("understands Monitor's antal/timme: setup in hours, run time as pieces per hour, saved as st/h", async () => {
      const plan = await planRoutingImport(
        { mapping: UNIT_MAPPING, rows: [["A-1", "10", "110", "0,2", "360", "Nej", "antal/timme"]] },
        fakeDeps([article("A-1", "id-1")])
      );
      expect(plan.rows[0]!.errors).toEqual([]);
      expect(plan.rows[0]!.warnings).toEqual([]);
      expect(plan.creates[0]).toMatchObject({ setupTime: 12, runTimePerUnit: 0.1667, timeUnit: "units_per_hour" });
    });

    it("treats an unmapped or empty unit as minutes — today's behaviour", async () => {
      const unmapped = await planRoutingImport(
        { mapping: MAPPING, rows: [["A-1", "10", "110", "0,2", "360", "Nej"]] },
        fakeDeps([article("A-1", "id-1")])
      );
      expect(unmapped.creates[0]).toMatchObject({ setupTime: 0.2, runTimePerUnit: 360, timeUnit: "minutes_per_unit" });
      const empty = await planRoutingImport(
        { mapping: UNIT_MAPPING, rows: [["A-1", "10", "110", "0,2", "360", "Nej", ""]] },
        fakeDeps([article("A-1", "id-1")])
      );
      expect(empty.creates[0]).toMatchObject({ setupTime: 0.2, runTimePerUnit: 360, timeUnit: "minutes_per_unit" });
    });

    it("converts hours and seconds per unit to minutes", async () => {
      const plan = await planRoutingImport(
        {
          mapping: UNIT_MAPPING,
          rows: [
            ["A-1", "10", "110", "0,5", "0,25", "Nej", "timmar/enhet"],
            ["A-1", "20", "110", "90", "30", "Nej", "sekunder/enhet"],
            ["A-1", "30", "110", "3", "1,5", "Nej", "minuter/enhet"],
          ],
        },
        fakeDeps([article("A-1", "id-1")])
      );
      expect(plan.hasErrors).toBe(false);
      expect(plan.creates.map((c) => [c.setupTime, c.runTimePerUnit, c.timeUnit])).toEqual([
        [30, 15, "minutes_per_unit"],
        [1.5, 0.5, "minutes_per_unit"],
        [3, 1.5, "minutes_per_unit"],
      ]);
    });

    it("saves antal/timme with Stycktid 0 as 0 min/st with a warning — 0 st/h has no meaning", async () => {
      const plan = await planRoutingImport(
        { mapping: UNIT_MAPPING, rows: [["A-1", "10", "110", "0,2", "0", "Nej", "antal/timme"]] },
        fakeDeps([article("A-1", "id-1")])
      );
      expect(plan.rows[0]!.errors).toEqual([]);
      expect(plan.rows[0]!.warnings).toEqual(["Stycktid 0 kan inte uttryckas i st/h — sparas som 0 min/st"]);
      expect(plan.creates[0]).toMatchObject({ setupTime: 12, runTimePerUnit: 0, timeUnit: "minutes_per_unit" });
    });

    it("rejects an unknown unit as a row error instead of guessing", async () => {
      const plan = await planRoutingImport(
        { mapping: UNIT_MAPPING, rows: [["A-1", "10", "110", "1", "1", "Nej", "furlongs"]] },
        fakeDeps([article("A-1", "id-1")])
      );
      expect(plan.rows[0]!.errors).toEqual([
        'Okänd tidsenhet: "furlongs" (antal/timme, minuter/enhet, timmar/enhet eller sekunder/enhet)',
      ]);
      expect(plan.creates).toEqual([]);
    });

    it("recognises the vocabulary in its common spellings", () => {
      expect(parseRoutingTimeUnit("antal/timme")).toBe("units_per_hour");
      expect(parseRoutingTimeUnit("st/h")).toBe("units_per_hour");
      expect(parseRoutingTimeUnit("st/tim")).toBe("units_per_hour");
      expect(parseRoutingTimeUnit("min/st")).toBe("minutes_per_unit");
      expect(parseRoutingTimeUnit("Minuter/enhet")).toBe("minutes_per_unit");
      expect(parseRoutingTimeUnit("tim")).toBe("hours_per_unit");
      expect(parseRoutingTimeUnit("sek")).toBe("seconds_per_unit");
      expect(parseRoutingTimeUnit("")).toBeNull();
      expect(parseRoutingTimeUnit("kg")).toBeNull();
    });

    it("keeps a lego operation timeless whatever the file says, with a warning", async () => {
      const deps = fakeDeps([article("A-1", "id-1")]);
      deps.workCentersByCode = async () => new Map([["910", { id: "wc-910", code: "910", type: "subcontract" }]]);
      const plan = await planRoutingImport(
        { mapping: UNIT_MAPPING, rows: [["A-1", "10", "910", "0,2", "360", "Nej", "antal/timme"]] },
        deps
      );
      expect(plan.rows[0]!.errors).toEqual([]);
      expect(plan.rows[0]!.warnings).toEqual(["Legoresurs — tiderna sätts till 0 (lego-operationer har inga tider)"]);
      expect(plan.creates[0]).toMatchObject({ setupTime: 0, runTimePerUnit: 0, timeUnit: "minutes_per_unit" });
    });
  });

  // --- "Uppdatera befintliga operationer" — the opt-in that turns the
  // create-only import into an upsert, so a routing imported with the wrong
  // time unit can be repaired by re-running the file. ---
  describe("updateExisting", () => {
    it("rewrites an existing operation instead of erroring, text fields only when filled in", async () => {
      const plan = await planRoutingImport(
        {
          mapping: { ...MAPPING, Enhet: "timeUnit", Instruktion: "comment", "Operationens benämning": "description" },
          rows: [
            ["A-1", "10", "110", "0,2", "360", "Ja", "antal/timme", "", "Bockning"],
            ["A-1", "20", "110", "5", "2", "Nej", "", "Se ritning", ""],
          ],
          updateExisting: true,
          printCommentOnWorkCard: true,
        },
        fakeDeps([article("A-1", "id-1")], ["110"], [{ articleId: "id-1", sequenceNo: 10 }])
      );
      expect(plan.hasErrors).toBe(false);
      expect(plan.rows.map((row) => row.action)).toEqual(["update", "create"]);
      expect(plan.summary).toEqual({ create: 1, update: 1, skip: 0, error: 0, warning: 0 });
      expect(plan.updates).toEqual([
        {
          id: "op-id-1-10",
          patch: {
            workCenterId: "wc-110",
            setupTime: 12,
            runTimePerUnit: 0.1667,
            timeUnit: "units_per_hour",
            costingOnly: true,
            description: "Bockning",
          },
        },
      ]);
      expect(plan.creates).toHaveLength(1);
      expect(plan.creates[0]).toMatchObject({ sequenceNo: 20, comment: "Se ritning", printOnWorkCard: true });
    });

    it("sets the print flag on an updated operation only when the row carries a comment", async () => {
      const plan = await planRoutingImport(
        {
          mapping: { ...MAPPING, Instruktion: "comment" },
          rows: [["A-1", "10", "110", "1", "1", "Nej", "Använd lyftok"]],
          updateExisting: true,
          printCommentOnWorkCard: true,
        },
        fakeDeps([article("A-1", "id-1")], ["110"], [{ articleId: "id-1", sequenceNo: 10 }])
      );
      expect(plan.updates[0]!.patch).toMatchObject({ comment: "Använd lyftok", printOnWorkCard: true });
    });

    it("still rejects an in-file duplicate of an operation being updated", async () => {
      const plan = await planRoutingImport(
        {
          mapping: MAPPING,
          rows: [
            ["A-1", "10", "110", "1", "1", "Nej"],
            ["A-1", "10", "110", "2", "2", "Nej"],
          ],
          updateExisting: true,
        },
        fakeDeps([article("A-1", "id-1")], ["110"], [{ articleId: "id-1", sequenceNo: 10 }])
      );
      expect(plan.rows[1]!.errors).toEqual(["Operation 10 för artikel A-1 förekommer flera gånger i filen"]);
      expect(plan.hasErrors).toBe(true);
    });

    it("refuses the combination with skipExisting as a mapping error", async () => {
      await expect(
        planRoutingImport(
          { mapping: MAPPING, rows: [["A-1", "10", "110", "1", "1", "Nej"]], skipExisting: true, updateExisting: true },
          fakeDeps([article("A-1", "id-1")])
        )
      ).rejects.toBeInstanceOf(ImportMappingError);
    });
  });

  it("requires the five mandatory columns to be mapped", async () => {
    await expect(
      planRoutingImport(
        { mapping: { Artikelnummer: "articleNumber", Sekvensnr: "sequenceNo" }, rows: [] },
        fakeDeps()
      )
    ).rejects.toBeInstanceOf(ImportMappingError);
  });
});

// --- Integration: repository and service against a real Postgres ---

const repo = createImportRepository(db);
const importService = createImportService(repo);

const TRUNCATE = sql`TRUNCATE mo_operations, manufacturing_orders, routing_operations, bom_components, articles, work_centers CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function seedUnit() {
  await db.insert(units).values({ code: "st", name: "Styck" }).onConflictDoNothing();
  const [unit] = await db.select({ id: units.id }).from(units).where(sql`${units.code} = 'st'`);
  return unit!.id;
}

async function seedArticle(articleNumber: string) {
  const unitId = await seedUnit();
  const [article] = await db
    .insert(articlesTable)
    .values({ articleNumber, name: articleNumber, type: "manufactured", unitId })
    .returning({ id: articlesTable.id });
  return article!.id;
}

async function seedWorkCenter(code: string) {
  const [workCenter] = await db
    .insert(workCenters)
    .values({ code, name: `Resurs ${code}` })
    .returning({ id: workCenters.id });
  return workCenter!.id;
}

describe("routing import — repository", () => {
  it("maps work centres by their three-digit code", async () => {
    const id = await seedWorkCenter("110");
    const map = await repo.workCentersByCode();
    expect(map.get("110")).toEqual({ id, code: "110", type: "machine" });
  });

  it("maps existing operations per article, carrying the Kalkyl flag", async () => {
    const articleId = await seedArticle("A-1");
    const workCenterId = await seedWorkCenter("110");
    await db.insert(routingOperations).values([
      { articleId, sequenceNo: 10, workCenterId, setupTime: "1", runTimePerUnit: "1" },
      { articleId, sequenceNo: 20, workCenterId, setupTime: "1", runTimePerUnit: "1", costingOnly: true },
    ]);

    const map = await repo.routingOperationsByArticle([articleId]);
    expect(map.get(articleId)!.get(10)!.costingOnly).toBe(false);
    expect(map.get(articleId)!.get(20)!.costingOnly).toBe(true);
  });

  it("writes the operations, minutes and Kalkyl flag included", async () => {
    const articleId = await seedArticle("A-1");
    const workCenterId = await seedWorkCenter("110");

    const result = await repo.executeRoutingPlan({
      rows: [],
      summary: { create: 2, update: 0, skip: 0, error: 0, warning: 0 },
      willCreate: { units: [], articleGroups: [] },
      hasErrors: false,
      creates: [
        { articleId, sequenceNo: 10, workCenterId, setupTime: 15, runTimePerUnit: 2, timeUnit: "minutes_per_unit", costingOnly: false, comment: null, printOnWorkCard: false, description: null, packingInstructions: null },
        { articleId, sequenceNo: 20, workCenterId, setupTime: 0.5, runTimePerUnit: 1.25, timeUnit: "units_per_hour", costingOnly: true, comment: null, printOnWorkCard: false, description: null, packingInstructions: null },
      ],
      updates: [],
    });

    expect(result).toEqual({ created: 2, updated: 0, registersCreated: { units: [], articleGroups: [] } });
    const stored = await db.select().from(routingOperations).orderBy(routingOperations.sequenceNo);
    expect(stored.map((row) => [row.sequenceNo, row.setupTime, row.runTimePerUnit, row.timeUnit, row.costingOnly])).toEqual([
      [10, "15.00", "2.0000", "minutes_per_unit", false],
      [20, "0.50", "1.2500", "units_per_hour", true],
    ]);
  });

  it("rewrites the operations in plan.updates, leaving untouched fields alone", async () => {
    const articleId = await seedArticle("A-1");
    const workCenterId = await seedWorkCenter("110");
    const [existing] = await db
      .insert(routingOperations)
      .values({ articleId, sequenceNo: 10, workCenterId, setupTime: "0.20", runTimePerUnit: "360.0000", comment: "Behåll mig", printOnWorkCard: true, description: "Gammalt namn" })
      .returning({ id: routingOperations.id });

    const result = await repo.executeRoutingPlan({
      rows: [],
      summary: { create: 0, update: 1, skip: 0, error: 0, warning: 0 },
      willCreate: { units: [], articleGroups: [] },
      hasErrors: false,
      creates: [],
      updates: [
        { id: existing!.id, patch: { workCenterId, setupTime: 12, runTimePerUnit: 0.1667, timeUnit: "units_per_hour", costingOnly: false, description: "Bockning" } },
      ],
    });

    expect(result).toEqual({ created: 0, updated: 1, registersCreated: { units: [], articleGroups: [] } });
    const [stored] = await db.select().from(routingOperations);
    expect(stored).toMatchObject({
      setupTime: "12.00",
      runTimePerUnit: "0.1667",
      timeUnit: "units_per_hour",
      description: "Bockning",
      // Not in the patch — untouched.
      comment: "Behåll mig",
      printOnWorkCard: true,
    });
  });
});

describe("import service — routing entity", () => {
  it("accepts routing in the entity enum", () => {
    expect(importEntitySchema.options).toContain("routing");
  });

  it("suggests the routing mapping through parse", async () => {
    const result = await importService.parse(
      "routing",
      Buffer.from("Artikelnummer;Operationsnr;Maskin;Ställtid;Tid/enhet;Okänd\nA-1;10;110;0;1;x\n")
    );
    expect(result.suggestedMapping).toEqual({
      Artikelnummer: "articleNumber",
      Operationsnr: "sequenceNo",
      Maskin: "workCenterCode",
      "Ställtid": "setupTime",
      "Tid/enhet": "runTimePerUnit",
      "Okänd": null,
    });
    expect(result.meta.format).toBe("csv");
  });

  it("commits an operation import end-to-end", async () => {
    const articleId = await seedArticle("A-1");
    await seedWorkCenter("110");

    const result = await importService.commit("routing", {
      mapping: MAPPING,
      rows: [["A-1", "10", "110", "15", "2", "Nej"]],
    });

    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      skippedRows: [],
      registersCreated: { units: [], articleGroups: [] },
    });
    const stored = await db.select().from(routingOperations);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.articleId).toBe(articleId);
  });

  it("skips the operations that already exist and lists them in the response", async () => {
    const articleId = await seedArticle("A-1");
    const workCenter = await seedWorkCenter("110");
    await db
      .insert(routingOperations)
      .values({ articleId, sequenceNo: 10, workCenterId: workCenter, setupTime: "1", runTimePerUnit: "1" });

    const result = await importService.commit("routing", {
      mapping: MAPPING,
      rows: [
        ["A-1", "10", "110", "15", "2", "Nej"],
        ["A-1", "20", "110", "5", "1", "Nej"],
      ],
      skipExisting: true,
    });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows).toEqual([
      {
        rowNumber: 2,
        reason: "Operation 10 finns redan på artikel A-1",
        values: {
          articleNumber: "A-1",
          sequenceNo: "10",
          workCenterCode: "110",
          setupTime: "15",
          runTimePerUnit: "2",
          costingOnly: "Nej",
        },
      },
    ]);

    const stored = await db.select().from(routingOperations).orderBy(routingOperations.sequenceNo);
    expect(stored).toHaveLength(2);
    // The pre-existing operation is untouched — not rewritten with the file's
    // 15 minutes of setup time.
    expect(Number(stored[0]!.setupTime)).toBe(1);
    expect(Number(stored[1]!.setupTime)).toBe(5);
  });

  it("repairs already-imported times with updateExisting without touching a released order's snapshot", async () => {
    const articleId = await seedArticle("A-1");
    const workCenterId = await seedWorkCenter("110");
    // What the old import wrote for Monitor's "0.2 h / 360 st/h": both read
    // as minutes.
    const [op] = await db
      .insert(routingOperations)
      .values({ articleId, sequenceNo: 10, workCenterId, setupTime: "0.20", runTimePerUnit: "360.0000" })
      .returning({ id: routingOperations.id });
    // A released order's snapshot of the same operation.
    const [mo] = await db
      .insert(manufacturingOrders)
      .values({ orderNumber: "TO-RT-1", articleId, quantity: "1", status: "released" })
      .returning({ id: manufacturingOrders.id });
    await db.insert(moOperations).values({
      manufacturingOrderId: mo!.id,
      routingOperationId: op!.id,
      sequenceNo: 10,
      workCenterId,
      setupTime: "0.20",
      runTimePerUnit: "360.0000",
    });

    const result = await importService.commit("routing", {
      mapping: { ...MAPPING, Enhet: "timeUnit" },
      rows: [["A-1", "10", "110", "0,2", "360", "Nej", "antal/timme"]],
      updateExisting: true,
    });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);

    const [routing] = await db.select().from(routingOperations);
    expect(routing).toMatchObject({ setupTime: "12.00", runTimePerUnit: "0.1667", timeUnit: "units_per_hour" });
    const [snapshot] = await db.select().from(moOperations);
    expect(snapshot).toMatchObject({ setupTime: "0.20", runTimePerUnit: "360.0000" });
  });

  it("refuses skipExisting together with updateExisting", async () => {
    await seedArticle("A-1");
    await seedWorkCenter("110");
    await expect(
      importService.commit("routing", {
        mapping: MAPPING,
        rows: [["A-1", "10", "110", "1", "1", ""]],
        skipExisting: true,
        updateExisting: true,
      })
    ).rejects.toBeInstanceOf(ImportMappingError);
  });

  it("aborts the whole commit on any row error with nothing written", async () => {
    await seedArticle("A-1");
    await seedWorkCenter("110");

    await expect(
      importService.commit("routing", {
        mapping: MAPPING,
        rows: [
          ["A-1", "10", "110", "0", "1", ""],
          ["SAKNAS", "20", "110", "0", "1", ""],
        ],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    expect(await db.select().from(routingOperations)).toHaveLength(0);
  });
});
