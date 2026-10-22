import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db, productionGroups, suppliers, workCenters } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import {
  planWorkCenterImport,
  suggestWorkCenterMapping,
  parseWorkCenterType,
  parseNumberCell,
  parseBoolCell,
  type WorkCenterImportDeps,
  type ExistingWorkCenter,
} from "../src/modules/import/service/work-centers.js";
import {
  planLegoWorkCenterImport,
  suggestLegoWorkCenterMapping,
  type LegoWorkCenterImportDeps,
} from "../src/modules/import/service/lego-work-centers.js";
import {
  planProductionGroupImport,
  suggestProductionGroupMapping,
  type ProductionGroupImportDeps,
} from "../src/modules/import/service/production-groups.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";

const repo = createImportRepository(db);

const TRUNCATE = sql`
  TRUNCATE work_centers, production_groups, suppliers, routing_operations, mo_operations CASCADE
`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// --- fakeDeps helpers (no DB) ---

function workCenterDeps(
  existing: Record<string, ExistingWorkCenter> = {},
  groups: Record<string, { id: string; name: string }> = {}
): WorkCenterImportDeps {
  return {
    async workCentersByCodeDetailed() {
      return new Map(Object.entries(existing));
    },
    async productionGroupsByCode() {
      return new Map(Object.entries(groups).map(([code, g]) => [code.toLowerCase(), g]));
    },
  };
}

function legoWorkCenterDeps(
  existing: Record<string, ExistingWorkCenter> = {},
  supplierNumbers: Record<string, { id: string }> = {}
): LegoWorkCenterImportDeps {
  return {
    async workCentersByCodeDetailed() {
      return new Map(Object.entries(existing));
    },
    async suppliersByNumber(numbers: string[]) {
      return new Map(
        Object.entries(supplierNumbers).filter(([number]) => numbers.includes(number))
      );
    },
  };
}

function productionGroupDeps(existing: Record<string, { id: string; name: string }> = {}): ProductionGroupImportDeps {
  return {
    async productionGroupsByCode() {
      return new Map(Object.entries(existing).map(([code, g]) => [code.toLowerCase(), g]));
    },
  };
}

describe("suggestWorkCenterMapping", () => {
  it("guesses Monitor's Kostnader export", () => {
    const headers = [
      "Prod.grupp",
      "Namn",
      "Typ",
      "Avdelning",
      "Benämning",
      "Namn (2)",
      "Typ (2)",
      "Förv. ställ",
      "Förv. styck",
      "Aktuell, STD",
      "Aktuell, K.pris 1",
      "Aktuell, K.pris 2",
      "Kommande, STD",
      "Kommande, K.pris 1",
      "Kommande, K.pris 2",
      "Nuvarande, Effekt",
      "Nuvarande, Öv. utsläpp",
      "Kommande, Effekt",
      "Kommande, Öv. utsläpp",
    ];
    const suggested = suggestWorkCenterMapping(headers);
    expect(suggested).toEqual({
      "Prod.grupp": "code",
      Namn: "name",
      Typ: "type",
      Avdelning: "productionGroupCode",
      Benämning: "productionGroupName",
      "Namn (2)": "costRowName",
      "Typ (2)": null,
      "Förv. ställ": "rateAppliesToSetup",
      "Förv. styck": "rateAppliesToRun",
      "Aktuell, STD": "hourlyRate",
      "Aktuell, K.pris 1": "calcRate1",
      "Aktuell, K.pris 2": null,
      "Kommande, STD": null,
      "Kommande, K.pris 1": null,
      "Kommande, K.pris 2": null,
      "Nuvarande, Effekt": null,
      "Nuvarande, Öv. utsläpp": null,
      "Kommande, Effekt": null,
      "Kommande, Öv. utsläpp": null,
    });
  });

  it("guesses Monitor's Lista export", () => {
    const headers = [
      "Prod.grupp",
      "Namn",
      "Typ",
      "Op. benämning",
      "Avdelning",
      "Lagerställe",
      "Planerare namn",
      "Kategori",
      "Ta med delrapporterade i Körklara (F)",
      "Tidshorisont",
      "Förvald ställtid",
      "Förvald fördelningstid",
      "Med i LTK",
      "Mtrl i std.enhet",
      "Auto rapp. antal",
      "Und. autom. rapp. mtrl",
    ];
    const suggested = suggestWorkCenterMapping(headers);
    expect(suggested).toEqual({
      "Prod.grupp": "code",
      Namn: "name",
      Typ: "type",
      "Op. benämning": "defaultOperationName",
      Avdelning: "productionGroupCode",
      Lagerställe: null,
      "Planerare namn": null,
      Kategori: null,
      "Ta med delrapporterade i Körklara (F)": null,
      Tidshorisont: null,
      "Förvald ställtid": "defaultSetupTime",
      "Förvald fördelningstid": null,
      "Med i LTK": null,
      "Mtrl i std.enhet": null,
      "Auto rapp. antal": null,
      "Und. autom. rapp. mtrl": null,
    });
  });
});

describe("suggestLegoWorkCenterMapping", () => {
  it("guesses Monitor's Lego export, leaving the repeated 'Namn' columns unmapped", () => {
    const headers = [
      "Prod.grupp",
      "Namn",
      "Leverantör",
      "Namn (2)",
      "Namn (3)",
      "Ledtid beställning",
      "Kötid",
      "Ledtid",
      "Skapa inte fakturaunderlag",
      "Skapa I-order",
    ];
    const suggested = suggestLegoWorkCenterMapping(headers);
    expect(suggested).toEqual({
      "Prod.grupp": "code",
      Namn: "name",
      Leverantör: "supplierNumber",
      "Namn (2)": null,
      "Namn (3)": null,
      "Ledtid beställning": "orderLeadTimeDays",
      Kötid: "queueTimeDays",
      Ledtid: "leadTimeDays",
      "Skapa inte fakturaunderlag": null,
      "Skapa I-order": null,
    });
  });
});

describe("suggestProductionGroupMapping", () => {
  it("maps Avdelning/Benämning from the Kostnader headers, leaving 'Namn' unmapped", () => {
    const headers = ["Prod.grupp", "Namn", "Typ", "Avdelning", "Benämning"];
    const suggested = suggestProductionGroupMapping(headers);
    expect(suggested["Avdelning"]).toBe("code");
    expect(suggested["Benämning"]).toBe("name");
    expect(suggested["Namn"]).toBeNull();
  });

  it("maps a generic Kod/Namn file's both columns", () => {
    const suggested = suggestProductionGroupMapping(["Kod", "Namn"]);
    expect(suggested).toEqual({ Kod: "code", Namn: "name" });
  });
});

describe("planWorkCenterImport", () => {
  const BASE_MAPPING = {
    "Prod.grupp": "code",
    Namn: "name",
    Typ: "type",
  };

  it("parses Monitor's work center types", () => {
    expect(parseWorkCenterType("Maskin")).toBe("machine");
    expect(parseWorkCenterType("Manuellt arbete")).toBe("personnel");
    expect(parseWorkCenterType("Robot")).toBeNull();
  });

  it("parses numbers and booleans as Monitor/Excel deliver them", () => {
    expect(parseNumberCell("375")).toBe(375);
    expect(parseNumberCell("0.1")).toBe(0.1);
    expect(parseNumberCell("1 250,50")).toBe(1250.5);
    expect(parseNumberCell("")).toBeNull();
    expect(parseNumberCell("abc")).toBeNull();
    expect(parseBoolCell("true")).toBe(true);
    expect(parseBoolCell("false")).toBe(false);
    expect(parseBoolCell("ja")).toBe(true);
    expect(parseBoolCell("nej")).toBe(false);
    expect(parseBoolCell("")).toBeNull();
  });

  it("maps Maskin/Manuellt arbete to machine/personnel and warns on an unknown type", async () => {
    const plan = await planWorkCenterImport(
      {
        mapping: BASE_MAPPING,
        rows: [
          ["100", "Kapning", "Maskin"],
          ["101", "Svets", "Manuellt arbete"],
          ["102", "Robotarm", "Robot"],
        ],
      },
      workCenterDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual([]);
    expect(plan.creates[0]).toMatchObject({ code: "100", type: "machine" });
    expect(plan.rows[1]!.warnings).toEqual([]);
    expect(plan.creates[1]).toMatchObject({ code: "101", type: "personnel" });
    expect(plan.rows[2]!.warnings[0]).toContain("Okänd typ");
    expect(plan.rows[2]!.warnings[0]).toContain("importeras som Maskin");
    // Unknown type: no `type` key is written into the create plan — the
    // "machine" fallback is the repository's DB-default at insert time, not
    // something the planner asserts.
    expect(plan.creates[2]).not.toHaveProperty("type");
  });

  it("errors when the resource number is not three digits", async () => {
    const plan = await planWorkCenterImport(
      { mapping: BASE_MAPPING, rows: [["1234", "Långt nummer", "Maskin"], ["1A", "Bokstav", "Maskin"]] },
      workCenterDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Resursnumret ska vara exakt tre siffror"]);
    expect(plan.rows[1]!.errors).toEqual(["Resursnumret ska vara exakt tre siffror"]);
    expect(plan.hasErrors).toBe(true);
  });

  it("pads a one- or two-digit number to three (Excel turns 007 into 7), like the routing import", async () => {
    const plan = await planWorkCenterImport(
      { mapping: BASE_MAPPING, rows: [["7", "Kort nummer", "Maskin"], ["12", "Tvåsiffrigt", "Maskin"]] },
      workCenterDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.rows.map((r) => r.warnings)).toEqual([[], []]);
    expect(plan.creates.map((c) => c.code)).toEqual(["007", "012"]);

    // A padded number matches the existing resource.
    const update = await planWorkCenterImport(
      { mapping: BASE_MAPPING, rows: [["7", "Kapning", "Maskin"]] },
      workCenterDeps({ "007": { id: "wc-7", code: "007", type: "machine" } })
    );
    expect(update.rows[0]!.action).toBe("update");
  });

  describe("Kostnader shape: only the Ordinarie cost row counts", () => {
    const KOSTNADER_MAPPING = {
      "Prod.grupp": "code",
      Namn: "name",
      Typ: "type",
      Avdelning: "productionGroupCode",
      Benämning: "productionGroupName",
      "Namn (2)": "costRowName",
      "Förv. ställ": "rateAppliesToSetup",
      "Förv. styck": "rateAppliesToRun",
      "Aktuell, STD": "hourlyRate",
      "Aktuell, K.pris 1": "calcRate1",
    };
    // Mirrors code 100's three rows in Produktionsgruppslista-Kostnader.
    const CODE_100_ROWS = [
      ["100", "Kapning", "Maskin", "100", "Kapar", "Ordinarie", "true", "true", "375", "750"],
      ["100", "Kapning", "Maskin", "100", "Kapar", "Undantag 1", "false", "false", "0", "0"],
      ["100", "Kapning", "Maskin", "100", "Kapar", "Undantag 2", "false", "false", "0", "0"],
    ];

    it("creates one work center from the Ordinarie row and skips the Undantag rows", async () => {
      const plan = await planWorkCenterImport({ mapping: KOSTNADER_MAPPING, rows: CODE_100_ROWS }, workCenterDeps());
      expect(plan.hasErrors).toBe(false);
      expect(plan.creates).toHaveLength(1);
      expect(plan.creates[0]).toMatchObject({
        code: "100",
        name: "Kapning",
        type: "machine",
        hourlyRate: 375,
        calcRate1: 750,
        rateAppliesToSetup: true,
        rateAppliesToRun: true,
      });
      expect(plan.rows[0]!.action).toBe("create");
      expect(plan.rows[1]!.action).toBe("skip");
      expect(plan.rows[1]!.skipReason).toContain("Ordinarie");
      expect(plan.rows[2]!.action).toBe("skip");
      expect(plan.rows[2]!.skipReason).toContain("Ordinarie");
    });

    it("queues the avdelning for creation, named from Benämning, when it doesn't exist yet", async () => {
      const plan = await planWorkCenterImport({ mapping: KOSTNADER_MAPPING, rows: CODE_100_ROWS }, workCenterDeps());
      expect(plan.newProductionGroups).toEqual([{ code: "100", name: "Kapar" }]);
      expect(plan.willCreate.productionGroups).toEqual(["100 · Kapar"]);
      expect(plan.creates[0]!.productionGroupCode).toBe("100");
      expect(plan.creates[0]!.productionGroupId).toBeUndefined();
    });

    it("resolves the avdelning to an id when it already exists", async () => {
      const plan = await planWorkCenterImport(
        { mapping: KOSTNADER_MAPPING, rows: CODE_100_ROWS },
        workCenterDeps({}, { "100": { id: "grp-100-id", name: "Kapar" } })
      );
      expect(plan.newProductionGroups).toEqual([]);
      expect(plan.willCreate.productionGroups).toEqual([]);
      expect(plan.creates[0]!.productionGroupId).toBe("grp-100-id");
      expect(plan.creates[0]!.productionGroupCode).toBeUndefined();
    });
  });

  it("classifies an existing code as an update with only the filled cells in the patch", async () => {
    const plan = await planWorkCenterImport(
      { mapping: BASE_MAPPING, rows: [["100", "Nytt namn", ""]] },
      workCenterDeps({ "100": { id: "wc-1", code: "100", type: "machine" } })
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.updates).toEqual([{ id: "wc-1", patch: { name: "Nytt namn" } }]);
  });

  it("skips an existing code when skipExisting is set", async () => {
    const plan = await planWorkCenterImport(
      { mapping: BASE_MAPPING, rows: [["100", "Nytt namn", "Maskin"]], skipExisting: true },
      workCenterDeps({ "100": { id: "wc-1", code: "100", type: "machine" } })
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.updates).toEqual([]);
  });

  it("errors when the code belongs to an existing legoresurs", async () => {
    const plan = await planWorkCenterImport(
      { mapping: BASE_MAPPING, rows: [["100", "Kapning", "Maskin"]] },
      workCenterDeps({ "100": { id: "wc-1", code: "100", type: "subcontract" } })
    );
    expect(plan.rows[0]!.errors[0]).toContain("legoresurs");
    expect(plan.hasErrors).toBe(true);
  });

  it("skips a row typed as lego with a pointer to the Legoresurser tab", async () => {
    const plan = await planWorkCenterImport(
      { mapping: BASE_MAPPING, rows: [["200", "Lego-grej", "Legoarbete"]] },
      workCenterDeps()
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toContain("Legoresurser");
    expect(plan.creates).toEqual([]);
  });

  it("errors when a new resource has no name", async () => {
    const plan = await planWorkCenterImport(
      { mapping: BASE_MAPPING, rows: [["300", "", "Maskin"]] },
      workCenterDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Namn saknas — obligatoriskt för ny resurs"]);
  });
});

describe("planLegoWorkCenterImport", () => {
  const MAPPING = {
    "Prod.grupp": "code",
    Namn: "name",
    Leverantör: "supplierNumber",
    "Ledtid beställning": "orderLeadTimeDays",
    Kötid: "queueTimeDays",
    Ledtid: "leadTimeDays",
  };

  it("resolves a known supplier number to supplierId", async () => {
    const plan = await planLegoWorkCenterImport(
      { mapping: MAPPING, rows: [["830", "Övriga kostnader", "51005262", "0", "1", "2"]] },
      legoWorkCenterDeps({}, { "51005262": { id: "sup-1" } })
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates[0]).toEqual({
      code: "830",
      name: "Övriga kostnader",
      supplierId: "sup-1",
      orderLeadTimeDays: 0,
      queueTimeDays: 1,
      leadTimeDays: 2,
    });
  });

  it("errors when the supplier number is unknown, pointing at the supplier import", async () => {
    const plan = await planLegoWorkCenterImport(
      { mapping: MAPPING, rows: [["830", "Övriga kostnader", "999999", "0", "1", "2"]] },
      legoWorkCenterDeps()
    );
    expect(plan.rows[0]!.errors[0]).toContain("finns inte — importera leverantörerna först");
  });

  it("pads a one- or two-digit number to three, like the resource import", async () => {
    const plan = await planLegoWorkCenterImport(
      { mapping: MAPPING, rows: [["83", "Övriga kostnader", "51005262", "0", "1", "2"]] },
      legoWorkCenterDeps({}, { "51005262": { id: "sup-1" } })
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates[0]!.code).toBe("083");
  });

  it("parses the lead/queue time numbers", () => {
    expect(parseNumberCell("10")).toBe(10);
    expect(parseNumberCell("1")).toBe(1);
    expect(parseNumberCell("7")).toBe(7);
  });

  it("errors when the code belongs to an existing machine resource", async () => {
    const plan = await planLegoWorkCenterImport(
      { mapping: MAPPING, rows: [["100", "Kapning", "51005262", "0", "1", "2"]] },
      legoWorkCenterDeps({ "100": { id: "wc-1", code: "100", type: "machine" } }, { "51005262": { id: "sup-1" } })
    );
    expect(plan.rows[0]!.errors[0]).toContain("maskin");
  });

  it("skips an existing legoresurs when skipExisting is set", async () => {
    const plan = await planLegoWorkCenterImport(
      { mapping: MAPPING, rows: [["830", "Övriga kostnader", "51005262", "0", "1", "2"]], skipExisting: true },
      legoWorkCenterDeps(
        { "830": { id: "wc-830", code: "830", type: "subcontract" } },
        { "51005262": { id: "sup-1" } }
      )
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.updates).toEqual([]);
  });
});

describe("planProductionGroupImport", () => {
  const MAPPING = { Avdelning: "code", Benämning: "name" };

  it("creates the first occurrence of a repeated avdelning and skips the rest", async () => {
    const plan = await planProductionGroupImport(
      {
        mapping: MAPPING,
        rows: [
          ["100", "Kapar"],
          ["100", "Kapar"],
          ["200", "Ej avrapportering"],
        ],
      },
      productionGroupDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates).toEqual([
      { code: "100", name: "Kapar" },
      { code: "200", name: "Ej avrapportering" },
    ]);
    expect(plan.rows[1]!.action).toBe("skip");
    expect(plan.rows[1]!.skipReason).toBe("Avdelningen förekommer flera gånger i filen");
  });

  it("names a group after its own code when the name cell is empty", async () => {
    const plan = await planProductionGroupImport({ mapping: MAPPING, rows: [["300", ""]] }, productionGroupDeps());
    expect(plan.creates).toEqual([{ code: "300", name: "300" }]);
  });

  it("classifies an existing code as an update", async () => {
    const plan = await planProductionGroupImport(
      { mapping: MAPPING, rows: [["100", "Nytt namn"]] },
      productionGroupDeps({ "100": { id: "grp-1", name: "Kapar" } })
    );
    expect(plan.updates).toEqual([{ id: "grp-1", patch: { name: "Nytt namn" } }]);
  });

  it("skips an existing code when skipExisting is set", async () => {
    const plan = await planProductionGroupImport(
      { mapping: MAPPING, rows: [["100", "Nytt namn"]], skipExisting: true },
      productionGroupDeps({ "100": { id: "grp-1", name: "Kapar" } })
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.updates).toEqual([]);
  });
});
