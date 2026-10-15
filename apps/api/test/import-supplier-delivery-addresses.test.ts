import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { supplierDeliveryAddresses, suppliers, db } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import {
  planSupplierDeliveryAddressImport,
  suggestSupplierDeliveryAddressMapping,
  type SupplierDeliveryAddressImportDeps,
  type ExistingSupplierAddress,
  type ExistingSupplierDeliveryAddress,
} from "../src/modules/import/service/supplier-delivery-addresses.js";
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

const SUPPLIER_1 = "11111111-1111-1111-1111-111111111111";
const SUPPLIER_2 = "22222222-2222-2222-2222-222222222222";

// In-memory deps — the planner never touches Drizzle with these.
function fakeDeps(
  suppliersByNumber: Record<string, ExistingSupplierAddress> = {},
  deliveryAddresses: Record<string, ExistingSupplierDeliveryAddress[]> = {}
): SupplierDeliveryAddressImportDeps {
  return {
    async supplierAddressesByNumber(numbers) {
      return new Map(
        Object.entries(suppliersByNumber).filter(([number]) => numbers.includes(number))
      );
    },
    async deliveryAddressesBySupplier(supplierIds) {
      return new Map(
        Object.entries(deliveryAddresses).filter(([supplierId]) => supplierIds.includes(supplierId))
      );
    },
  };
}

function supplier(overrides: Partial<ExistingSupplierAddress> = {}): ExistingSupplierAddress {
  return { id: SUPPLIER_1, address: "Storgatan 1", postalCode: "111 22", city: "Stockholm", ...overrides };
}

describe("suggestSupplierDeliveryAddressMapping", () => {
  it("guesses the exact Monitor supplier 'Leveransadress' headings (no postal/city columns, Land unmapped)", () => {
    const suggested = suggestSupplierDeliveryAddressMapping([
      "Leverantör",
      "Namn",
      "Leveransadress – Namn",
      "Leveransadress – Adressrad 1",
      "Leveransadress – Adressrad 2",
      "Leveransadress – Adressrad 3",
      "Leveransadress – Adressrad 4",
      "Leveransadress – Land",
    ]);
    expect(suggested).toEqual({
      Leverantör: "supplierNumber",
      Namn: null,
      "Leveransadress – Namn": "label",
      "Leveransadress – Adressrad 1": "address",
      "Leveransadress – Adressrad 2": "address2",
      "Leveransadress – Adressrad 3": "address3",
      "Leveransadress – Adressrad 4": null,
      "Leveransadress – Land": null,
    });
  });

  it("guesses the unprefixed headings too, including postal/city if present", () => {
    const suggested = suggestSupplierDeliveryAddressMapping([
      "Leverantör",
      "Leveransadress – Namn",
      "Adressrad 1",
      "Adressrad 2",
      "Adressrad 3",
      "Postnummer",
      "Stad",
      "Land",
    ]);
    expect(suggested).toEqual({
      Leverantör: "supplierNumber",
      "Leveransadress – Namn": "label",
      "Adressrad 1": "address",
      "Adressrad 2": "address2",
      "Adressrad 3": "address3",
      Postnummer: "postalCode",
      Stad: "city",
      Land: null,
    });
  });
});

describe("planSupplierDeliveryAddressImport — validation", () => {
  it("errors when the supplier is missing from the register", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["999", "Ängsvägen 1"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Leverantören 999 finns inte — importera leverantörerna först"]);
    expect(plan.hasErrors).toBe(true);
  });

  it("errors on a missing supplier number", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["", "Ängsvägen 1"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Leverantörsnummer saknas"]);
  });

  // Monitor writes one row per supplier even when no delivery address is
  // registered — those rows carry nothing to import and must not block the
  // file.
  it("skips a row whose address lines are all empty", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Leveransadress – Namn": "label" }, rows: [["1001", "Leverantör AB"]] },
      fakeDeps({ "1001": supplier() })
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Adress saknas");
    expect(plan.creates).toEqual([]);
    expect(plan.summary.skip).toBe(1);
  });

  it("still errors on a missing supplier before the empty-address skip", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber" }, rows: [["999"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Leverantören 999 finns inte — importera leverantörerna först"]);
  });

  it("joins address lines 1-3 with a newline, dropping empty ones", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      {
        mapping: {
          Leverantör: "supplierNumber",
          "Adressrad 1": "address",
          "Adressrad 2": "address2",
          "Adressrad 3": "address3",
        },
        rows: [["1001", "Ängsvägen 1", "", "c/o Person"]],
      },
      fakeDeps({ "1001": supplier() })
    );
    expect(plan.creates[0]!.address).toBe("Ängsvägen 1\nc/o Person");
  });

  it("falls back the label to Leveransadress when unmapped/empty", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      fakeDeps({ "1001": supplier() })
    );
    expect(plan.creates[0]!.label).toBe("Leveransadress");
  });

  it("throws ImportMappingError when supplierNumber is unmapped", async () => {
    await expect(
      planSupplierDeliveryAddressImport({ mapping: { "Adressrad 1": "address" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
  });
});

describe("planSupplierDeliveryAddressImport — skip rules", () => {
  it("skips a row identical to the supplier's own address (full key match)", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      {
        mapping: {
          Leverantör: "supplierNumber",
          "Adressrad 1": "address",
          Postnummer: "postalCode",
          Stad: "city",
        },
        rows: [["1001", "storgatan 1", "11122", "STOCKHOLM"]],
      },
      fakeDeps({ "1001": supplier({ address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" }) })
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Samma som leverantörens adress");
    expect(plan.creates).toEqual([]);
  });

  // Monitor's supplier "Leveransadress" export has no postal code/city
  // columns — the row carries only the street address, so comparing the
  // full key (address|postal|city) against the supplier's full address
  // (which DOES have a postal code/city) would never match. Without this
  // fallback every one of a real import's ~662 suppliers would get a
  // pointless duplicate delivery address.
  it("skips a street-only row matching the supplier's own street, even though the supplier has postal code/city (address-only fallback)", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["1001", "storgatan 1"]] },
      fakeDeps({ "1001": supplier({ address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" }) })
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Samma som leverantörens adress");
    expect(plan.creates).toEqual([]);
  });

  it("does NOT apply the address-only fallback when the row's street differs from the supplier's", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      fakeDeps({ "1001": supplier({ address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" }) })
    );
    expect(plan.rows[0]!.action).toBe("create");
    expect(plan.creates).toHaveLength(1);
  });

  it("does NOT apply the address-only fallback when the row carries a postal code even if the street matches", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      {
        mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address", Postnummer: "postalCode" },
        rows: [["1001", "Storgatan 1", "999 99"]],
      },
      fakeDeps({ "1001": supplier({ address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" }) })
    );
    expect(plan.rows[0]!.action).toBe("create");
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.postalCode).toBe("999 99");
  });

  it("skips a row matching an existing delivery address", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["1001", "  Ängsvägen 1  "]] },
      fakeDeps(
        { "1001": supplier() },
        {
          [SUPPLIER_1]: [
            { address: "Ängsvägen 1", postalCode: null, city: null, isDefault: false },
          ],
        }
      )
    );
    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.skipReason).toBe("Leveransadressen finns redan");
  });

  it("skips the second occurrence of the same new address within the file", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      {
        mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" },
        rows: [
          ["1001", "Ängsvägen 1"],
          ["1001", "ängsvägen 1"],
        ],
      },
      fakeDeps({ "1001": supplier() })
    );
    expect(plan.rows[0]!.action).toBe("create");
    expect(plan.rows[1]!.action).toBe("skip");
    expect(plan.rows[1]!.skipReason).toBe("Leveransadressen finns redan");
    expect(plan.creates).toHaveLength(1);
  });

  it("allows the same new address for two different suppliers", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      {
        mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" },
        rows: [
          ["1001", "Ängsvägen 1"],
          ["1002", "Ängsvägen 1"],
        ],
      },
      fakeDeps({ "1001": supplier({ id: SUPPLIER_1 }), "1002": supplier({ id: SUPPLIER_2 }) })
    );
    expect(plan.creates).toHaveLength(2);
  });
});

describe("planSupplierDeliveryAddressImport — setAsDefault", () => {
  it("defaults to true when omitted: the first row becomes the supplier's default", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      fakeDeps({ "1001": supplier() })
    );
    expect(plan.creates[0]!.isDefault).toBe(true);
    expect(plan.rows[0]!.warnings).toEqual([]);
  });

  it("warns and does not set isDefault when the supplier already has a default", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      fakeDeps(
        { "1001": supplier() },
        {
          [SUPPLIER_1]: [
            { address: "Befintlig 1", postalCode: null, city: null, isDefault: true },
          ],
        }
      )
    );
    expect(plan.creates[0]!.isDefault).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual(["Leverantören har redan en förvald leveransadress"]);
  });

  it("claims the default for only the first of several new rows in the file", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      {
        mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" },
        rows: [
          ["1001", "Ängsvägen 1"],
          ["1001", "Björkvägen 2"],
        ],
      },
      fakeDeps({ "1001": supplier() })
    );
    expect(plan.creates[0]!.isDefault).toBe(true);
    expect(plan.creates[1]!.isDefault).toBe(false);
    expect(plan.rows[1]!.warnings).toEqual(["Leverantören har redan en förvald leveransadress"]);
  });

  it("never sets isDefault when setAsDefault is explicitly false, no warning either", async () => {
    const plan = await planSupplierDeliveryAddressImport(
      {
        mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" },
        rows: [["1001", "Ängsvägen 1"]],
        setAsDefault: false,
      },
      fakeDeps({ "1001": supplier() })
    );
    expect(plan.creates[0]!.isDefault).toBe(false);
    expect(plan.rows[0]!.warnings).toEqual([]);
  });
});

describe("supplier delivery address import — repository", () => {
  it("creates a delivery address against a real supplier", async () => {
    const [supplierRow] = await db
      .insert(suppliers)
      .values({ supplierNumber: "1001", name: "Leverantör AB", address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" })
      .returning();
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      repo
    );
    expect(plan.hasErrors).toBe(false);
    const result = await repo.executeSupplierDeliveryAddressPlan(plan);
    expect(result).toEqual({ created: 1, updated: 0, registersCreated: { units: [], articleGroups: [] } });
    const rows = await db
      .select()
      .from(supplierDeliveryAddresses)
      .where(eq(supplierDeliveryAddresses.supplierId, supplierRow!.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isDefault).toBe(true);
  });

  it("skips a row matching the supplier's real main address", async () => {
    await db
      .insert(suppliers)
      .values({ supplierNumber: "1001", name: "Leverantör AB", address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" });
    const plan = await planSupplierDeliveryAddressImport(
      {
        mapping: {
          Leverantör: "supplierNumber",
          "Adressrad 1": "address",
          Postnummer: "postalCode",
          Stad: "city",
        },
        rows: [["1001", "Storgatan 1", "111 22", "Stockholm"]],
      },
      repo
    );
    expect(plan.rows[0]!.skipReason).toBe("Samma som leverantörens adress");
    const result = await repo.executeSupplierDeliveryAddressPlan(plan);
    expect(result.created).toBe(0);
  });

  it("never violates the one-default-per-supplier index across the whole plan", async () => {
    const [supplierRow] = await db
      .insert(suppliers)
      .values({ supplierNumber: "1001", name: "Leverantör AB" })
      .returning();
    await db.insert(supplierDeliveryAddresses).values({
      supplierId: supplierRow!.id,
      label: "Befintlig",
      address: "Befintlig 1",
      isDefault: true,
    });
    const plan = await planSupplierDeliveryAddressImport(
      { mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" }, rows: [["1001", "Ängsvägen 1"]] },
      repo
    );
    await expect(repo.executeSupplierDeliveryAddressPlan(plan)).resolves.toEqual({
      created: 1,
      updated: 0,
      registersCreated: { units: [], articleGroups: [] },
    });
    const rows = await db
      .select()
      .from(supplierDeliveryAddresses)
      .where(eq(supplierDeliveryAddresses.supplierId, supplierRow!.id));
    expect(rows.filter((row) => row.isDefault)).toHaveLength(1);
  });
});

describe("import service — supplierDeliveryAddresses entity", () => {
  it("accepts supplierDeliveryAddresses in the entity enum", () => {
    expect(importEntitySchema.options).toContain("supplierDeliveryAddresses");
  });

  it("aborts the whole commit on any row error (nothing written)", async () => {
    await db.insert(suppliers).values({ supplierNumber: "1001", name: "Leverantör AB" });
    await expect(
      importService.commit("supplierDeliveryAddresses", {
        mapping: { Leverantör: "supplierNumber", "Adressrad 1": "address" },
        rows: [
          ["1001", "Frisk adress"],
          ["9999", "Trasig adress"],
        ],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    const rows = await db.select().from(supplierDeliveryAddresses);
    expect(rows).toHaveLength(0);
  });

  it("imports an xlsx workbook with Monitor's exact supplier 'Leveransadress' headings end to end (no postal/city columns, Land present but unmapped)", async () => {
    await db
      .insert(suppliers)
      .values({ supplierNumber: "1001", name: "Leverantör AB", address: "Storgatan 1", postalCode: "111 22", city: "Stockholm" });
    const buf = buildXlsxBuffer([
      {
        name: "Leveransadress",
        rows: [
          [
            "Leverantör",
            "Namn",
            "Leveransadress – Namn",
            "Leveransadress – Adressrad 1",
            "Leveransadress – Adressrad 2",
            "Leveransadress – Adressrad 3",
            "Leveransadress – Adressrad 4",
            "Leveransadress – Land",
          ],
          ["1001", "Leverantör AB", "", "Ängsvaktaregatan 7A", "", "", "", "SE"],
        ],
      },
    ]);
    const parsed = await importService.parse("supplierDeliveryAddresses", buf);
    expect(parsed.suggestedMapping["Leveransadress – Adressrad 1"]).toBe("address");
    expect(parsed.suggestedMapping["Leveransadress – Land"]).toBeNull();

    const mapping: Record<string, string | null> = {};
    for (const header of parsed.headers) mapping[header] = parsed.suggestedMapping[header] ?? null;

    const result = await importService.commit("supplierDeliveryAddresses", { mapping, rows: parsed.rows });
    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      skippedRows: [],
      registersCreated: { units: [], articleGroups: [] },
    });

    const [row] = await db.select().from(supplierDeliveryAddresses);
    expect(row!.address).toBe("Ängsvaktaregatan 7A");
    expect(row!.isDefault).toBe(true);
  });
});
