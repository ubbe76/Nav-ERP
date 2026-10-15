import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { supplierContacts, suppliers, db } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import {
  planSupplierContactImport,
  suggestSupplierContactMapping,
  type SupplierContactImportDeps,
  type SupplierContactImportPlan,
  type ExistingSupplierContact,
} from "../src/modules/import/service/supplier-contacts.js";
import {
  createImportService,
  ImportMappingError,
  ImportValidationError,
} from "../src/modules/import/service/import.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { buildXlsxBuffer } from "./helpers/xlsx-fixture.js";

const repo = createImportRepository(db);

const TRUNCATE = sql`TRUNCATE supplier_contacts, supplier_delivery_addresses, suppliers CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const importService = createImportService(repo);

// In-memory deps — the planner never touches Drizzle with these.
function fakeDeps(
  suppliersByNumber: Record<string, string> = {},
  contacts: Record<string, ExistingSupplierContact[]> = {}
): SupplierContactImportDeps {
  return {
    async suppliersByNumber(numbers) {
      return new Map(
        Object.entries(suppliersByNumber)
          .filter(([number]) => numbers.includes(number))
          .map(([number, id]) => [number, { id }])
      );
    },
    async contactsBySupplier(supplierIds) {
      return new Map(
        Object.entries(contacts).filter(([supplierId]) => supplierIds.includes(supplierId))
      );
    },
  };
}

const SUPPLIER_1 = "11111111-1111-1111-1111-111111111111";
const SUPPLIER_2 = "22222222-2222-2222-2222-222222222222";

describe("suggestSupplierContactMapping", () => {
  it("guesses the exact Monitor 'Referenser' headings", () => {
    const suggested = suggestSupplierContactMapping([
      "Leverantör",
      "Namn",
      "Leverantörsroll",
      "Förvald",
      "Referens – Namn",
      "Telefon",
      "Mobiltelefon",
      "E-post",
      "Faxnummer",
      "Anmärkning",
      "Kommentar",
      "F",
      "Referenskategori",
    ]);
    expect(suggested).toEqual({
      Leverantör: "supplierNumber",
      Namn: null,
      Leverantörsroll: null,
      Förvald: "isPrimary",
      "Referens – Namn": "name",
      Telefon: "phone",
      Mobiltelefon: "mobile",
      "E-post": "email",
      Faxnummer: "fax",
      Anmärkning: "comment",
      Kommentar: null,
      F: null,
      Referenskategori: null,
    });
  });
});

describe("planSupplierContactImport — validation", () => {
  it("errors when the supplier is missing from the register", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" },
        rows: [["999", "Ada Lovelace"]],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Leverantören 999 finns inte — importera leverantörerna först"]);
    expect(plan.hasErrors).toBe(true);
    expect(plan.creates).toEqual([]);
  });

  it("errors on a missing supplier number", async () => {
    const plan = await planSupplierContactImport(
      { mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" }, rows: [["", "Namnlös"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Leverantörsnummer saknas"]);
  });

  it("errors on an empty name cell", async () => {
    const plan = await planSupplierContactImport(
      { mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" }, rows: [["1001", ""]] },
      fakeDeps({ "1001": SUPPLIER_1 })
    );
    expect(plan.rows[0]!.errors).toEqual(["Namn saknas"]);
  });

  it("throws ImportMappingError when name is unmapped", async () => {
    await expect(
      planSupplierContactImport({ mapping: { Leverantör: "supplierNumber" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
  });

  it("skips a contact that already exists on the supplier, case-insensitively", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" },
        rows: [["1001", "ada LOVELACE"]],
      },
      fakeDeps(
        { "1001": SUPPLIER_1 },
        { [SUPPLIER_1]: [{ id: "c1", name: "Ada Lovelace", isPrimary: false }] }
      )
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Kontakten finns redan");
    expect(plan.creates).toEqual([]);
    expect(plan.hasErrors).toBe(false);
  });

  it("skips a duplicate (supplier, name) pair within the file — first occurrence wins", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [
          ["1001", "Ada Lovelace", "Ja"],
          ["1001", "ada lovelace", "Ja"],
        ],
      },
      fakeDeps({ "1001": SUPPLIER_1 })
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.action).toBe("skip");
    expect(plan.rows[1]!.skipReason).toBe("Kontakten förekommer flera gånger i filen");
    expect(plan.rows[1]!.errors).toEqual([]);
    expect(plan.hasErrors).toBe(false);
    expect(plan.summary.skip).toBe(1);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.isPrimary).toBe(true);
  });

  it("allows the same name for two different suppliers", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" },
        rows: [
          ["1001", "Ada Lovelace"],
          ["1002", "Ada Lovelace"],
        ],
      },
      fakeDeps({ "1001": SUPPLIER_1, "1002": SUPPLIER_2 })
    );
    expect(plan.rows.every((row) => row.errors.length === 0)).toBe(true);
    expect(plan.creates).toHaveLength(2);
  });
});

describe("planSupplierContactImport — isPrimary", () => {
  it("parses the ja/nej/x/1/0/true/false boolean forms", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [
          ["1001", "A", "Ja"],
          ["1002", "B", "x"],
        ],
      },
      fakeDeps({ "1001": SUPPLIER_1, "1002": SUPPLIER_2 })
    );
    expect(plan.creates.find((c) => c.name === "A")!.isPrimary).toBe(true);
    expect(plan.creates.find((c) => c.name === "B")!.isPrimary).toBe(true);
  });

  it("errors on an unrecognized isPrimary value", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [["1001", "A", "kanske"]],
      },
      fakeDeps({ "1001": SUPPLIER_1 })
    );
    expect(plan.rows[0]!.errors).toEqual([
      'Ogiltigt värde för Förvald: "kanske" (Ja/Nej/X/1/0/true/false)',
    ]);
  });

  it("demotes a second primary to a regular contact with a warning — DB has one already", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [["1001", "Ny Referens", "Ja"]],
      },
      fakeDeps(
        { "1001": SUPPLIER_1 },
        { [SUPPLIER_1]: [{ id: "c1", name: "Befintlig", isPrimary: true }] }
      )
    );
    expect(plan.creates[0]!.isPrimary).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual([
      "Leverantören har redan en huvudkontakt — Ny Referens importeras som vanlig kontakt",
    ]);
  });

  it("demotes the second primary claimed within the same file", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [
          ["1001", "Först", "Ja"],
          ["1001", "Sedan", "Ja"],
        ],
      },
      fakeDeps({ "1001": SUPPLIER_1 })
    );
    expect(plan.creates.find((c) => c.name === "Först")!.isPrimary).toBe(true);
    expect(plan.creates.find((c) => c.name === "Sedan")!.isPrimary).toBe(false);
    expect(plan.rows[1]!.warnings).toEqual([
      "Leverantören har redan en huvudkontakt — Sedan importeras som vanlig kontakt",
    ]);
  });
});

describe("planSupplierContactImport — e-mail, fax and comment", () => {
  it("drops an invalid e-mail with a warning instead of blocking the row", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name", "E-post": "email" },
        rows: [["1001", "A", "not-an-email"]],
      },
      fakeDeps({ "1001": SUPPLIER_1 })
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.warnings).toEqual(["Ogiltig e-postadress 'not-an-email' — fältet lämnades tomt"]);
    expect(plan.creates[0]!.email).toBeUndefined();
  });

  it("folds the fax number into the comment, separated by · when both are present", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: {
          Leverantör: "supplierNumber",
          "Referens – Namn": "name",
          Anmärkning: "comment",
          Faxnummer: "fax",
        },
        rows: [["1001", "A", "Ring efter 17", "0322-123 45"]],
      },
      fakeDeps({ "1001": SUPPLIER_1 })
    );
    expect(plan.creates[0]!.comment).toBe("Ring efter 17 · Fax 0322-123 45");
  });

  it("uses just the fax number as the comment when Anmärkning is empty", async () => {
    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name", Faxnummer: "fax" },
        rows: [["1001", "A", "0322-123 45"]],
      },
      fakeDeps({ "1001": SUPPLIER_1 })
    );
    expect(plan.creates[0]!.comment).toBe("Fax 0322-123 45");
  });

  it("leaves comment unset when neither Anmärkning nor fax is present", async () => {
    const plan = await planSupplierContactImport(
      { mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" }, rows: [["1001", "A"]] },
      fakeDeps({ "1001": SUPPLIER_1 })
    );
    expect(plan.creates[0]!.comment).toBeUndefined();
  });
});

describe("supplier contact import — repository", () => {
  it("creates a contact against a real supplier", async () => {
    const [supplier] = await db
      .insert(suppliers)
      .values({ supplierNumber: "1001", name: "Leverantör AB" })
      .returning();
    const plan = await planSupplierContactImport(
      { mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" }, rows: [["1001", "Ada Lovelace"]] },
      repo
    );
    expect(plan.hasErrors).toBe(false);
    const result = await repo.executeSupplierContactPlan(plan);
    expect(result).toEqual({ created: 1, updated: 0, registersCreated: { units: [], articleGroups: [] } });
    const rows = await db.select().from(supplierContacts).where(eq(supplierContacts.supplierId, supplier!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ada Lovelace");
  });

  it("never violates the one-primary-per-supplier index across the whole plan", async () => {
    const [supplier] = await db
      .insert(suppliers)
      .values({ supplierNumber: "1001", name: "Leverantör AB" })
      .returning();
    await db.insert(supplierContacts).values({ supplierId: supplier!.id, name: "Befintlig", isPrimary: true });

    const plan = await planSupplierContactImport(
      {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [["1001", "Ny", "Ja"]],
      },
      repo
    );
    await expect(repo.executeSupplierContactPlan(plan)).resolves.toEqual({
      created: 1,
      updated: 0,
      registersCreated: { units: [], articleGroups: [] },
    });
    const rows = await db.select().from(supplierContacts).where(eq(supplierContacts.supplierId, supplier!.id));
    expect(rows.filter((row) => row.isPrimary)).toHaveLength(1);
  });

  it("skips a contact matching an existing one and reports it via the service", async () => {
    await db.insert(suppliers).values({ supplierNumber: "1001", name: "Leverantör AB" });
    await importService.commit("supplierContacts", {
      mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" },
      rows: [["1001", "Ada Lovelace"]],
    });

    const result = await importService.commit("supplierContacts", {
      mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" },
      rows: [
        ["1001", "ada lovelace"],
        ["1001", "Grace Hopper"],
      ],
    });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows[0]!.reason).toBe("Kontakten finns redan");
  });
});

describe("import service — supplierContacts entity", () => {
  it("accepts supplierContacts in the entity enum", () => {
    expect(importEntitySchema.options).toContain("supplierContacts");
  });

  it("aborts the whole commit on any row error (nothing written)", async () => {
    await db.insert(suppliers).values({ supplierNumber: "1001", name: "Leverantör AB" });
    await expect(
      importService.commit("supplierContacts", {
        mapping: { Leverantör: "supplierNumber", "Referens – Namn": "name" },
        rows: [
          ["1001", "Frisk Rad"],
          ["9999", "Trasig Rad"],
        ],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    const rows = await db.select().from(supplierContacts);
    expect(rows).toHaveLength(0);
  });

  it("imports an xlsx workbook with Monitor's exact 'Referenser' headings end to end", async () => {
    await db.insert(suppliers).values({ supplierNumber: "1001", name: "Leverantör AB" });
    const buf = buildXlsxBuffer([
      {
        name: "Referenser",
        rows: [
          [
            "Leverantör",
            "Namn",
            "Leverantörsroll",
            "Förvald",
            "Referens – Namn",
            "Telefon",
            "Mobiltelefon",
            "E-post",
            "Faxnummer",
            "Anmärkning",
            "Kommentar",
            "F",
            "Referenskategori",
          ],
          [
            "1001",
            "Leverantör AB",
            "Leverantör",
            "Ja",
            "Erik Exempelsson",
            "0322-111 11",
            "070-111 11 11",
            "erik@leverantor.se",
            "0322-222 22",
            "VD",
            "",
            "",
            "",
          ],
        ],
      },
    ]);
    const parsed = await importService.parse("supplierContacts", buf);
    expect(parsed.suggestedMapping["Referens – Namn"]).toBe("name");
    expect(parsed.suggestedMapping["Leverantör"]).toBe("supplierNumber");

    const mapping: Record<string, string | null> = {};
    for (const header of parsed.headers) mapping[header] = parsed.suggestedMapping[header] ?? null;

    const result = await importService.commit("supplierContacts", { mapping, rows: parsed.rows });
    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      skippedRows: [],
      registersCreated: { units: [], articleGroups: [] },
    });

    const [row] = await db.select().from(supplierContacts);
    expect(row!.name).toBe("Erik Exempelsson");
    expect(row!.isPrimary).toBe(true);
    expect(row!.comment).toBe("VD · Fax 0322-222 22");
  });
});
