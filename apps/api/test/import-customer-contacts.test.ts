import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { customerContacts, customers, db } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import {
  planCustomerContactImport,
  suggestCustomerContactMapping,
  type CustomerContactImportDeps,
  type CustomerContactImportPlan,
  type ExistingCustomerContact,
} from "../src/modules/import/service/customer-contacts.js";
import {
  createImportService,
  ImportMappingError,
  ImportValidationError,
} from "../src/modules/import/service/import.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { buildXlsxBuffer } from "./helpers/xlsx-fixture.js";

const repo = createImportRepository(db);

const TRUNCATE = sql`TRUNCATE customer_contacts, customer_delivery_addresses, customers CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const importService = createImportService(repo);

// In-memory deps — the planner never touches Drizzle with these.
function fakeDeps(
  customersByNumber: Record<string, string> = {},
  contacts: Record<string, ExistingCustomerContact[]> = {}
): CustomerContactImportDeps {
  return {
    async customersByNumber(numbers) {
      return new Map(
        Object.entries(customersByNumber)
          .filter(([number]) => numbers.includes(number))
          .map(([number, id]) => [number, { id }])
      );
    },
    async contactsByCustomer(customerIds) {
      return new Map(
        Object.entries(contacts).filter(([customerId]) => customerIds.includes(customerId))
      );
    },
  };
}

const CUSTOMER_1 = "11111111-1111-1111-1111-111111111111";
const CUSTOMER_2 = "22222222-2222-2222-2222-222222222222";

describe("suggestCustomerContactMapping", () => {
  it("guesses the exact Monitor 'Referenser' headings", () => {
    const suggested = suggestCustomerContactMapping([
      "Kund",
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
      Kund: "customerNumber",
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

describe("planCustomerContactImport — validation", () => {
  it("errors when the customer is missing from the register", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name" },
        rows: [["999", "Ada Lovelace"]],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Kunden 999 finns inte — importera kunderna först"]);
    expect(plan.hasErrors).toBe(true);
    expect(plan.creates).toEqual([]);
  });

  it("errors on a missing customer number", async () => {
    const plan = await planCustomerContactImport(
      { mapping: { Kund: "customerNumber", "Referens – Namn": "name" }, rows: [["", "Namnlös"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Kundnummer saknas"]);
  });

  it("errors on an empty name cell", async () => {
    const plan = await planCustomerContactImport(
      { mapping: { Kund: "customerNumber", "Referens – Namn": "name" }, rows: [["1001", ""]] },
      fakeDeps({ "1001": CUSTOMER_1 })
    );
    expect(plan.rows[0]!.errors).toEqual(["Namn saknas"]);
  });

  it("throws ImportMappingError when name is unmapped", async () => {
    await expect(
      planCustomerContactImport({ mapping: { Kund: "customerNumber" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
  });

  it("skips a contact that already exists on the customer, case-insensitively", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name" },
        rows: [["1001", "ada LOVELACE"]],
      },
      fakeDeps(
        { "1001": CUSTOMER_1 },
        { [CUSTOMER_1]: [{ id: "c1", name: "Ada Lovelace", isPrimary: false }] }
      )
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Kontakten finns redan");
    expect(plan.creates).toEqual([]);
    expect(plan.hasErrors).toBe(false);
  });

  it("skips a duplicate (customer, name) pair within the file — first occurrence wins", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [
          ["1001", "Ada Lovelace", "Ja"],
          ["1001", "ada lovelace", "Ja"],
        ],
      },
      fakeDeps({ "1001": CUSTOMER_1 })
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

  it("allows the same name for two different customers", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name" },
        rows: [
          ["1001", "Ada Lovelace"],
          ["1002", "Ada Lovelace"],
        ],
      },
      fakeDeps({ "1001": CUSTOMER_1, "1002": CUSTOMER_2 })
    );
    expect(plan.rows.every((row) => row.errors.length === 0)).toBe(true);
    expect(plan.creates).toHaveLength(2);
  });
});

describe("planCustomerContactImport — isPrimary", () => {
  it("parses the ja/nej/x/1/0/true/false boolean forms", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [
          ["1001", "A", "Ja"],
          ["1002", "B", "x"],
        ],
      },
      fakeDeps({ "1001": CUSTOMER_1, "1002": CUSTOMER_2 })
    );
    expect(plan.creates.find((c) => c.name === "A")!.isPrimary).toBe(true);
    expect(plan.creates.find((c) => c.name === "B")!.isPrimary).toBe(true);
  });

  it("errors on an unrecognized isPrimary value", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [["1001", "A", "kanske"]],
      },
      fakeDeps({ "1001": CUSTOMER_1 })
    );
    expect(plan.rows[0]!.errors).toEqual([
      'Ogiltigt värde för Förvald: "kanske" (Ja/Nej/X/1/0/true/false)',
    ]);
  });

  it("demotes a second primary to a regular contact with a warning — DB has one already", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [["1001", "Ny Referens", "Ja"]],
      },
      fakeDeps(
        { "1001": CUSTOMER_1 },
        { [CUSTOMER_1]: [{ id: "c1", name: "Befintlig", isPrimary: true }] }
      )
    );
    expect(plan.creates[0]!.isPrimary).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual([
      "Kunden har redan en huvudkontakt — Ny Referens importeras som vanlig kontakt",
    ]);
  });

  it("demotes the second primary claimed within the same file", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [
          ["1001", "Först", "Ja"],
          ["1001", "Sedan", "Ja"],
        ],
      },
      fakeDeps({ "1001": CUSTOMER_1 })
    );
    expect(plan.creates.find((c) => c.name === "Först")!.isPrimary).toBe(true);
    expect(plan.creates.find((c) => c.name === "Sedan")!.isPrimary).toBe(false);
    expect(plan.rows[1]!.warnings).toEqual([
      "Kunden har redan en huvudkontakt — Sedan importeras som vanlig kontakt",
    ]);
  });
});

describe("planCustomerContactImport — e-mail, fax and comment", () => {
  it("drops an invalid e-mail with a warning instead of blocking the row", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name", "E-post": "email" },
        rows: [["1001", "A", "not-an-email"]],
      },
      fakeDeps({ "1001": CUSTOMER_1 })
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.warnings).toEqual(["Ogiltig e-postadress 'not-an-email' — fältet lämnades tomt"]);
    expect(plan.creates[0]!.email).toBeUndefined();
  });

  it("folds the fax number into the comment, separated by · when both are present", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: {
          Kund: "customerNumber",
          "Referens – Namn": "name",
          Anmärkning: "comment",
          Faxnummer: "fax",
        },
        rows: [["1001", "A", "Ring efter 17", "0322-123 45"]],
      },
      fakeDeps({ "1001": CUSTOMER_1 })
    );
    expect(plan.creates[0]!.comment).toBe("Ring efter 17 · Fax 0322-123 45");
  });

  it("uses just the fax number as the comment when Anmärkning is empty", async () => {
    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name", Faxnummer: "fax" },
        rows: [["1001", "A", "0322-123 45"]],
      },
      fakeDeps({ "1001": CUSTOMER_1 })
    );
    expect(plan.creates[0]!.comment).toBe("Fax 0322-123 45");
  });

  it("leaves comment unset when neither Anmärkning nor fax is present", async () => {
    const plan = await planCustomerContactImport(
      { mapping: { Kund: "customerNumber", "Referens – Namn": "name" }, rows: [["1001", "A"]] },
      fakeDeps({ "1001": CUSTOMER_1 })
    );
    expect(plan.creates[0]!.comment).toBeUndefined();
  });
});

describe("customer contact import — repository", () => {
  it("creates a contact against a real customer", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ customerNumber: "1001", name: "Kund AB" })
      .returning();
    const plan = await planCustomerContactImport(
      { mapping: { Kund: "customerNumber", "Referens – Namn": "name" }, rows: [["1001", "Ada Lovelace"]] },
      repo
    );
    expect(plan.hasErrors).toBe(false);
    const result = await repo.executeCustomerContactPlan(plan);
    expect(result).toEqual({ created: 1, updated: 0, registersCreated: { units: [], articleGroups: [] } });
    const rows = await db.select().from(customerContacts).where(eq(customerContacts.customerId, customer!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Ada Lovelace");
  });

  it("never violates the one-primary-per-customer index across the whole plan", async () => {
    const [customer] = await db
      .insert(customers)
      .values({ customerNumber: "1001", name: "Kund AB" })
      .returning();
    await db.insert(customerContacts).values({ customerId: customer!.id, name: "Befintlig", isPrimary: true });

    const plan = await planCustomerContactImport(
      {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name", Förvald: "isPrimary" },
        rows: [["1001", "Ny", "Ja"]],
      },
      repo
    );
    await expect(repo.executeCustomerContactPlan(plan)).resolves.toEqual({
      created: 1,
      updated: 0,
      registersCreated: { units: [], articleGroups: [] },
    });
    const rows = await db.select().from(customerContacts).where(eq(customerContacts.customerId, customer!.id));
    expect(rows.filter((row) => row.isPrimary)).toHaveLength(1);
  });

  it("skips a contact matching an existing one and reports it via the service", async () => {
    await db.insert(customers).values({ customerNumber: "1001", name: "Kund AB" });
    await importService.commit("customerContacts", {
      mapping: { Kund: "customerNumber", "Referens – Namn": "name" },
      rows: [["1001", "Ada Lovelace"]],
    });

    const result = await importService.commit("customerContacts", {
      mapping: { Kund: "customerNumber", "Referens – Namn": "name" },
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

describe("import service — customerContacts entity", () => {
  it("accepts customerContacts in the entity enum", () => {
    expect(importEntitySchema.options).toContain("customerContacts");
  });

  it("aborts the whole commit on any row error (nothing written)", async () => {
    await db.insert(customers).values({ customerNumber: "1001", name: "Kund AB" });
    await expect(
      importService.commit("customerContacts", {
        mapping: { Kund: "customerNumber", "Referens – Namn": "name" },
        rows: [
          ["1001", "Frisk Rad"],
          ["9999", "Trasig Rad"],
        ],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    const rows = await db.select().from(customerContacts);
    expect(rows).toHaveLength(0);
  });

  it("imports an xlsx workbook with Monitor's exact 'Referenser' headings end to end", async () => {
    await db.insert(customers).values({ customerNumber: "1001", name: "Kund AB" });
    const buf = buildXlsxBuffer([
      {
        name: "Referenser",
        rows: [
          ["Kund", "Förvald", "Referens – Namn", "Telefon", "Mobiltelefon", "E-post", "Faxnummer", "Anmärkning"],
          ["1001", "Ja", "Erik Exempelsson", "0322-111 11", "070-111 11 11", "erik@kund.se", "0322-222 22", "VD"],
        ],
      },
    ]);
    const parsed = await importService.parse("customerContacts", buf);
    expect(parsed.suggestedMapping["Referens – Namn"]).toBe("name");

    const mapping: Record<string, string | null> = {};
    for (const header of parsed.headers) mapping[header] = parsed.suggestedMapping[header] ?? null;

    const result = await importService.commit("customerContacts", { mapping, rows: parsed.rows });
    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      skippedRows: [],
      registersCreated: { units: [], articleGroups: [] },
    });

    const [row] = await db.select().from(customerContacts);
    expect(row!.name).toBe("Erik Exempelsson");
    expect(row!.isPrimary).toBe(true);
    expect(row!.comment).toBe("VD · Fax 0322-222 22");
  });
});
