import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { customerDeliveryAddresses, customers, db } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import {
  planCustomerDeliveryAddressImport,
  suggestCustomerDeliveryAddressMapping,
  type CustomerDeliveryAddressImportDeps,
  type ExistingCustomerAddress,
  type ExistingDeliveryAddress,
} from "../src/modules/import/service/customer-delivery-addresses.js";
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

const CUSTOMER_1 = "11111111-1111-1111-1111-111111111111";
const CUSTOMER_2 = "22222222-2222-2222-2222-222222222222";

// In-memory deps — the planner never touches Drizzle with these.
function fakeDeps(
  customersByNumber: Record<string, ExistingCustomerAddress> = {},
  deliveryAddresses: Record<string, ExistingDeliveryAddress[]> = {}
): CustomerDeliveryAddressImportDeps {
  return {
    async customerAddressesByNumber(numbers) {
      return new Map(
        Object.entries(customersByNumber).filter(([number]) => numbers.includes(number))
      );
    },
    async deliveryAddressesByCustomer(customerIds) {
      return new Map(
        Object.entries(deliveryAddresses).filter(([customerId]) => customerIds.includes(customerId))
      );
    },
  };
}

function customer(overrides: Partial<ExistingCustomerAddress> = {}): ExistingCustomerAddress {
  return { id: CUSTOMER_1, address: "Storgatan 1", postalCode: "111 22", city: "Stockholm", country: "SE", ...overrides };
}

describe("suggestCustomerDeliveryAddressMapping", () => {
  it("guesses the exact Monitor 'Leveransadress' headings", () => {
    const suggested = suggestCustomerDeliveryAddressMapping([
      "Kund",
      "Leveransadress – Namn",
      "Adressrad 1",
      "Adressrad 2",
      "Adressrad 3",
      "Adressrad 4",
      "Postnummer",
      "Stad",
      "Land",
      "Namn",
    ]);
    expect(suggested).toEqual({
      Kund: "customerNumber",
      "Leveransadress – Namn": "label",
      "Adressrad 1": "address",
      "Adressrad 2": "address2",
      "Adressrad 3": "address3",
      "Adressrad 4": null,
      Postnummer: "postalCode",
      Stad: "city",
      Land: "country",
      Namn: null,
    });
  });

  // The headings Monitor G5 actually writes (2026-09): every column carries
  // the block prefix.
  it("guesses the prefixed 'Leveransadress – …' headings", () => {
    const suggested = suggestCustomerDeliveryAddressMapping([
      "Kund",
      "Namn",
      "Leveransadress – Namn",
      "Leveransadress – Adressrad 1",
      "Leveransadress – Adressrad 2",
      "Leveransadress – Adressrad 3",
      "Leveransadress – Adressrad 4",
      "Leveransadress – Postnummer",
      "Leveransadress – Stad",
      "Leveransadress – Land",
    ]);
    expect(suggested).toEqual({
      Kund: "customerNumber",
      Namn: null,
      "Leveransadress – Namn": "label",
      "Leveransadress – Adressrad 1": "address",
      "Leveransadress – Adressrad 2": "address2",
      "Leveransadress – Adressrad 3": "address3",
      "Leveransadress – Adressrad 4": null,
      "Leveransadress – Postnummer": "postalCode",
      "Leveransadress – Stad": "city",
      "Leveransadress – Land": "country",
    });
  });
});

describe("planCustomerDeliveryAddressImport — validation", () => {
  it("errors when the customer is missing from the register", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["999", "Ängsvägen 1"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Kunden 999 finns inte — importera kunderna först"]);
    expect(plan.hasErrors).toBe(true);
  });

  it("errors on a missing customer number", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["", "Ängsvägen 1"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Kundnummer saknas"]);
  });

  // Monitor writes one row per customer even when no delivery address is
  // registered — those rows carry nothing to import and must not block the
  // file.
  it("skips a row whose address lines are all empty", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Leveransadress – Namn": "label" }, rows: [["1001", "Kund AB"]] },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Adress saknas");
    expect(plan.creates).toEqual([]);
    expect(plan.summary.skip).toBe(1);
  });

  it("still errors on a missing customer before the empty-address skip", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber" }, rows: [["999"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Kunden 999 finns inte — importera kunderna först"]);
  });

  it("joins address lines 1-3 with a newline, dropping empty ones", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: {
          Kund: "customerNumber",
          "Adressrad 1": "address",
          "Adressrad 2": "address2",
          "Adressrad 3": "address3",
        },
        rows: [["1001", "Ängsvägen 1", "", "c/o Person"]],
      },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.creates[0]!.address).toBe("Ängsvägen 1\nc/o Person");
  });

  it("falls back the label to Leveransadress when unmapped/empty", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.creates[0]!.label).toBe("Leveransadress");
  });

  it("throws ImportMappingError when customerNumber is unmapped", async () => {
    await expect(
      planCustomerDeliveryAddressImport({ mapping: { "Adressrad 1": "address" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
  });
});

describe("planCustomerDeliveryAddressImport — country", () => {
  it("defaults to SE when unmapped/empty", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.creates[0]!.country).toBe("SE");
  });

  it("trims and uppercases a valid two-letter code", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: { Kund: "customerNumber", "Adressrad 1": "address", Land: "country" },
        rows: [["1001", "Toftevej 1", " dk "]],
      },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.creates[0]!.country).toBe("DK");
  });

  it("errors on an invalid country code", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: { Kund: "customerNumber", "Adressrad 1": "address", Land: "country" },
        rows: [["1001", "Adr 1", "Sverige"]],
      },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.rows[0]!.errors).toEqual(["Ogiltig landskod 'Sverige' — ange två bokstäver, t.ex. SE"]);
  });
});

describe("planCustomerDeliveryAddressImport — skip rules", () => {
  it("skips a row identical to the customer's own address", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: {
          Kund: "customerNumber",
          "Adressrad 1": "address",
          Postnummer: "postalCode",
          Stad: "city",
        },
        rows: [["1001", "storgatan 1", "11122", "STOCKHOLM"]],
      },
      fakeDeps({ "1001": customer({ address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" }) })
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Samma som kundens adress");
    expect(plan.creates).toEqual([]);
  });

  it("skips a row matching an existing delivery address", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["1001", "  Ängsvägen 1  "]] },
      fakeDeps(
        { "1001": customer() },
        {
          [CUSTOMER_1]: [
            { address: "Ängsvägen 1", postalCode: null, city: null, country: "SE", isDefault: false },
          ],
        }
      )
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Leveransadressen finns redan");
  });

  it("skips the second occurrence of the same new address within the file", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: { Kund: "customerNumber", "Adressrad 1": "address" },
        rows: [
          ["1001", "Ängsvägen 1"],
          ["1001", "ängsvägen 1"],
        ],
      },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.rows[0]!.action).toBe("create");
    expect(plan.rows[1]!.action).toBe("skip");
    expect(plan.rows[1]!.skipReason).toBe("Leveransadressen finns redan");
    expect(plan.creates).toHaveLength(1);
  });

  it("allows the same new address for two different customers", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: { Kund: "customerNumber", "Adressrad 1": "address" },
        rows: [
          ["1001", "Ängsvägen 1"],
          ["1002", "Ängsvägen 1"],
        ],
      },
      fakeDeps({ "1001": customer({ id: CUSTOMER_1 }), "1002": customer({ id: CUSTOMER_2 }) })
    );
    expect(plan.creates).toHaveLength(2);
  });
});

describe("planCustomerDeliveryAddressImport — setAsDefault", () => {
  it("defaults to true when omitted: the first row becomes the customer's default", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.creates[0]!.isDefault).toBe(true);
    expect(plan.rows[0]!.warnings).toEqual([]);
  });

  it("warns and does not set isDefault when the customer already has a default", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      fakeDeps(
        { "1001": customer() },
        {
          [CUSTOMER_1]: [
            { address: "Befintlig 1", postalCode: null, city: null, country: "SE", isDefault: true },
          ],
        }
      )
    );
    expect(plan.creates[0]!.isDefault).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual(["Kunden har redan en förvald leveransadress"]);
  });

  it("claims the default for only the first of several new rows in the file", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: { Kund: "customerNumber", "Adressrad 1": "address" },
        rows: [
          ["1001", "Ängsvägen 1"],
          ["1001", "Björkvägen 2"],
        ],
      },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.creates[0]!.isDefault).toBe(true);
    expect(plan.creates[1]!.isDefault).toBe(false);
    expect(plan.rows[1]!.warnings).toEqual(["Kunden har redan en förvald leveransadress"]);
  });

  it("never sets isDefault when setAsDefault is explicitly false, no warning either", async () => {
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: { Kund: "customerNumber", "Adressrad 1": "address" },
        rows: [["1001", "Ängsvägen 1"]],
        setAsDefault: false,
      },
      fakeDeps({ "1001": customer() })
    );
    expect(plan.creates[0]!.isDefault).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual([]);
  });
});

describe("customer delivery address import — repository", () => {
  it("creates a delivery address against a real customer", async () => {
    const [customerRow] = await db
      .insert(customers)
      .values({ customerNumber: "1001", name: "Kund AB", address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" })
      .returning();
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      repo
    );
    expect(plan.hasErrors).toBe(false);
    const result = await repo.executeCustomerDeliveryAddressPlan(plan);
    expect(result).toEqual({ created: 1, updated: 0, registersCreated: { units: [], articleGroups: [] } });
    const rows = await db
      .select()
      .from(customerDeliveryAddresses)
      .where(eq(customerDeliveryAddresses.customerId, customerRow!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isDefault).toBe(true);
  });

  it("skips a row matching the customer's real main address", async () => {
    await db
      .insert(customers)
      .values({ customerNumber: "1001", name: "Kund AB", address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" });
    const plan = await planCustomerDeliveryAddressImport(
      {
        mapping: {
          Kund: "customerNumber",
          "Adressrad 1": "address",
          Postnummer: "postalCode",
          Stad: "city",
        },
        rows: [["1001", "Storgatan 1", "111 22", "Stockholm"]],
      },
      repo
    );
    expect(plan.rows[0]!.skipReason).toBe("Samma som kundens adress");
    const result = await repo.executeCustomerDeliveryAddressPlan(plan);
    expect(result.created).toBe(0);
  });

  it("never violates the one-default-per-customer index across the whole plan", async () => {
    const [customerRow] = await db
      .insert(customers)
      .values({ customerNumber: "1001", name: "Kund AB" })
      .returning();
    await db.insert(customerDeliveryAddresses).values({
      customerId: customerRow!.id,
      label: "Befintlig",
      address: "Befintlig 1",
      isDefault: true,
    });
    const plan = await planCustomerDeliveryAddressImport(
      { mapping: { Kund: "customerNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      repo
    );
    await expect(repo.executeCustomerDeliveryAddressPlan(plan)).resolves.toEqual({
      created: 1,
      updated: 0,
      registersCreated: { units: [], articleGroups: [] },
    });
    const rows = await db
      .select()
      .from(customerDeliveryAddresses)
      .where(eq(customerDeliveryAddresses.customerId, customerRow!.id));
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
  });
});

describe("import service — customerDeliveryAddresses entity", () => {
  it("accepts customerDeliveryAddresses in the entity enum", () => {
    expect(importEntitySchema.options).toContain("customerDeliveryAddresses");
  });

  it("aborts the whole commit on any row error (nothing written)", async () => {
    await db.insert(customers).values({ customerNumber: "1001", name: "Kund AB" });
    await expect(
      importService.commit("customerDeliveryAddresses", {
        mapping: { Kund: "customerNumber", "Adressrad 1": "address" },
        rows: [
          ["1001", "Frisk adress"],
          ["9999", "Trasig adress"],
        ],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    const rows = await db.select().from(customerDeliveryAddresses);
    expect(rows).toHaveLength(0);
  });

  it("imports an xlsx workbook with Monitor's exact 'Leveransadress' headings end to end", async () => {
    await db
      .insert(customers)
      .values({ customerNumber: "1001", name: "Kund AB", address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" });
    const buf = buildXlsxBuffer([
      {
        name: "Leveransadress",
        rows: [
          ["Kund", "Leveransadress – Namn", "Adressrad 1", "Postnummer", "Stad", "Land"],
          ["1001", "Ängsvaktaregatan", "Ängsvaktaregatan 7A", "123 45", "Farsta", "SE"],
        ],
      },
    ]);
    const parsed = await importService.parse("customerDeliveryAddresses", buf);
    expect(parsed.suggestedMapping["Leveransadress – Namn"]).toBe("label");

    const mapping: Record<string, string | null> = {};
    for (const header of parsed.headers) mapping[header] = parsed.suggestedMapping[header] ?? null;

    const result = await importService.commit("customerDeliveryAddresses", { mapping, rows: parsed.rows });
    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      skippedRows: [],
      registersCreated: { units: [], articleGroups: [] },
    });

    const [row] = await db.select().from(customerDeliveryAddresses);
    expect(row!.label).toBe("Ängsvaktaregatan");
    expect(row!.address).toBe("Ängsvaktaregatan 7A");
    expect(row!.isDefault).toBe(true);
  });
});
