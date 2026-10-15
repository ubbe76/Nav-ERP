import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { carriers, db, deliveryTerms, numberSeries, paymentTerms, suppliers } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import {
  planSupplierImport,
  suggestSupplierMapping,
  type SupplierImportDeps,
  type SupplierImportPlan,
} from "../src/modules/import/service/suppliers.js";
import {
  createImportService,
  ImportMappingError,
  ImportValidationError,
} from "../src/modules/import/service/import.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { buildXlsxBuffer } from "./helpers/xlsx-fixture.js";

const repo = createImportRepository(db);

// number_series is NEVER truncated (shared, sequence-like base data). The
// "supplier" row is seeded by the leverantörsnummer plan's migration; the
// ON CONFLICT upsert below self-heals a stale test database and pins
// next_number to a known value per test. The three registers ARE truncated
// — same as the customer import suite, nothing else here seeds them.
const TRUNCATE = sql`
  TRUNCATE supplier_contacts, supplier_delivery_addresses, suppliers,
    payment_terms, delivery_terms, carriers CASCADE
`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function setSupplierSeries(next: number) {
  await db.execute(sql`
    INSERT INTO number_series (key, prefix, next_number, digits)
    VALUES ('supplier', '', ${next}, 0)
    ON CONFLICT (key) DO UPDATE SET next_number = EXCLUDED.next_number
  `);
}

async function supplierSeriesNext(): Promise<number> {
  const [row] = await db.select().from(numberSeries).where(eq(numberSeries.key, "supplier"));
  return row!.nextNumber;
}

const NUMBER_NAME_MAPPING = { Leverantörsnummer: "supplierNumber", Namn: "name" };

const importService = createImportService(repo);

// In-memory deps (number -> id) — the planner never touches Drizzle, so
// these tests run without any database writes. `registers` seeds the three
// name/code -> id lookups; keys are matched case-insensitively, same as the
// real repository methods.
function fakeDeps(
  existing: Record<string, string> = {},
  registers: {
    paymentTerms?: Record<string, string>;
    deliveryTerms?: Record<string, string>;
    carriers?: Record<string, string>;
  } = {}
): SupplierImportDeps {
  const toMap = (reg?: Record<string, string>) =>
    new Map(Object.entries(reg ?? {}).map(([key, id]) => [key.toLowerCase(), id]));
  return {
    async suppliersByNumber(numbers) {
      return new Map(
        Object.entries(existing)
          .filter(([number]) => numbers.includes(number))
          .map(([number, id]) => [number, { id }])
      );
    },
    async paymentTermsByNameOrCode() {
      return toMap(registers.paymentTerms);
    },
    async deliveryTermsByNameOrCode() {
      return toMap(registers.deliveryTerms);
    },
    async carriersByNameOrCode() {
      return toMap(registers.carriers);
    },
  };
}

const EMPTY_WILL_CREATE = {
  units: [] as string[],
  articleGroups: [] as string[],
  paymentTerms: [] as string[],
  deliveryTerms: [] as string[],
  carriers: [] as string[],
};

describe("suggestSupplierMapping", () => {
  it("guesses the primary Monitor headings for every field", () => {
    const suggested = suggestSupplierMapping([
      "Leverantörsnummer",
      "Namn",
      "Orgnr",
      "Momsreg.nr",
      "Kontaktperson",
      "E-post",
      "Telefon",
      "Adress",
      "Postnummer",
      "Ort",
      "Valuta",
      "Vårt kundnummer",
      "Betalningsvillkor",
      "Leveransvillkor",
      "Leveranssätt",
      "Kundnummer hos speditör",
    ]);
    expect(Object.values(suggested)).toEqual([
      "supplierNumber",
      "name",
      "orgNumber",
      "vatNumber",
      "contactName",
      "email",
      "phone",
      "address",
      "postalCode",
      "city",
      "currency",
      "ourCustomerNumber",
      "paymentTerm",
      "deliveryTerm",
      "carrier",
      "carrierCustomerNumber",
    ]);
  });

  it("guesses Monitor's Postadress export: 'Leverantör', prefixed address block, Namn left unmapped", () => {
    // Exact headings from Leverantorslista-Postadress. The short "Namn"
    // column is the display name — deliberately unmapped in a Monitor
    // export so the Lista/Referenser runs never overwrite the legal name.
    const suggested = suggestSupplierMapping([
      "Leverantör",
      "Namn",
      "Postadress – Adressformat",
      "Postadress – Namn",
      "Postadress – Adressrad 1",
      "Postadress – Adressrad 2",
      "Postadress – Adressrad 3",
      "Postadress – Adressrad 4",
      "Postadress – Postnummer",
      "Postadress – Stad",
      "Postadress – Region",
      "Postadress – Land",
    ]);
    expect(suggested).toEqual({
      Leverantör: "supplierNumber",
      Namn: null,
      "Postadress – Adressformat": null,
      "Postadress – Namn": "name",
      "Postadress – Adressrad 1": "address",
      "Postadress – Adressrad 2": "address2",
      "Postadress – Adressrad 3": "address3",
      "Postadress – Adressrad 4": null,
      "Postadress – Postnummer": "postalCode",
      "Postadress – Stad": "city",
      "Postadress – Region": null,
      "Postadress – Land": null, // suppliers carry no country column
    });
  });

  it("guesses Monitor's Lista export: Namn mapped (suppliers are created there), org/VAT numbers and 'Vårt kundnr'", () => {
    // "Leverantörsgrupp" and "Minsta ordervärde" are the headings unique to
    // this file (SUPPLIER_LISTA_MARKERS) — they are what triggers "Namn"
    // being mapped here, unlike in every other Monitor supplier file.
    const suggested = suggestSupplierMapping([
      "Leverantör",
      "Namn",
      "Leverantörsroll",
      "Leverantörsgrupp",
      "Momsreg.nr",
      "Organisationsnummer",
      "Vårt kundnr",
      "Minsta ordervärde",
      "Lev.nr på faktura",
      "Webbsida",
    ]);
    expect(suggested).toEqual({
      Leverantör: "supplierNumber",
      Namn: "name",
      Leverantörsroll: null,
      Leverantörsgrupp: null,
      "Momsreg.nr": "vatNumber",
      Organisationsnummer: "orgNumber",
      "Vårt kundnr": "ourCustomerNumber",
      "Minsta ordervärde": null,
      "Lev.nr på faktura": null,
      Webbsida: null,
    });
  });

  it("keeps 'Namn' unmapped in Monitor's other files (Leveransadress, Besöksadress and Referenser)", () => {
    expect(suggestSupplierMapping(["Leverantör", "Namn", "Leveransadress – Namn"])["Namn"]).toBeNull();
    expect(suggestSupplierMapping(["Leverantör", "Namn", "Avviker från leveransadress", "Besöksadress – Namn"])["Namn"]).toBeNull();
    // Referenser carries "Leverantörsroll" too — it must NOT count as a Lista marker.
    expect(
      suggestSupplierMapping(["Leverantör", "Namn", "Leverantörsroll", "Förvald", "Referens – Namn"])["Namn"]
    ).toBeNull();
  });

  it("still maps a lone 'Namn' column to name when the file has no 'Leverantör' column", () => {
    const suggested = suggestSupplierMapping(["Lev.nr", "Namn"]);
    expect(suggested).toEqual({ "Lev.nr": "supplierNumber", Namn: "name" });
  });

  it("guesses alternate spellings case-insensitively, first hit wins, unknown columns stay unmapped", () => {
    const suggested = suggestSupplierMapping([
      "Lev.nr",
      "Leverantörsnr",
      "LEVERANTÖRSNAMN",
      "Organisationsnummer",
      "VAT-nummer",
      "Referens",
      "Mail",
      "Besöksadress",
      "Postnr",
      "Postort",
      "Vårt kundnr",
      "Frisyr",
    ]);
    expect(suggested["Lev.nr"]).toBe("supplierNumber");
    // supplierNumber was already claimed by the first column — first hit wins.
    expect(suggested["Leverantörsnr"]).toBeNull();
    expect(suggested["LEVERANTÖRSNAMN"]).toBe("name");
    expect(suggested["Organisationsnummer"]).toBe("orgNumber");
    expect(suggested["VAT-nummer"]).toBe("vatNumber");
    expect(suggested["Referens"]).toBe("contactName");
    expect(suggested["Mail"]).toBe("email");
    expect(suggested["Besöksadress"]).toBe("address");
    expect(suggested["Postnr"]).toBe("postalCode");
    expect(suggested["Postort"]).toBe("city");
    expect(suggested["Vårt kundnr"]).toBe("ourCustomerNumber");
    expect(suggested["Frisyr"]).toBeNull();
  });
});

describe("planSupplierImport — classification and validation", () => {
  it("classifies unknown numbers as create and known numbers as update", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
        rows: [
          ["100", "Gammal Lev"],
          ["200", "Ny Lev"],
        ],
      },
      fakeDeps({ "100": "11111111-1111-1111-1111-111111111111" })
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.summary).toEqual({ create: 1, update: 1, skip: 0, error: 0, warning: 0 });
    // rowNumber is the Excel row: 1-based data rows + 1 for the header line.
    expect(plan.rows[0]!).toMatchObject({ rowNumber: 2, action: "update", errors: [] });
    expect(plan.rows[1]!).toMatchObject({ rowNumber: 3, action: "create", errors: [] });
    expect(plan.updates).toEqual([
      { id: "11111111-1111-1111-1111-111111111111", patch: { name: "Gammal Lev" } },
    ]);
    expect(plan.creates).toEqual([{ supplierNumber: "200", name: "Ny Lev" }]);
    expect(plan.willCreate).toEqual(EMPTY_WILL_CREATE);
  });

  it("skips a known number entirely when skipExisting is set", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
        rows: [
          ["100", "Skriv inte över"],
          ["250", "Ny Lev"],
        ],
        skipExisting: true,
      },
      fakeDeps({ "100": "11111111-1111-1111-1111-111111111111" })
    );

    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.skipReason).toBe("Leverantören 100 finns redan i registret");
    expect(plan.rows[0]!.values).toEqual({ supplierNumber: "100", name: "Skriv inte över" });
    expect(plan.updates).toEqual([]);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 1, error: 0, warning: 0 });
    expect(plan.hasErrors).toBe(false);
    // A skipped number is taken by the existing record — the series must
    // still be pulled past it, exactly as if the row had been imported.
    expect(plan.maxNumericNumber).toBe(250);
  });

  it("pulls the series past a skipped number that is higher than any created one", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
        rows: [
          ["900", "Finns redan"],
          ["250", "Ny Lev"],
        ],
        skipExisting: true,
      },
      fakeDeps({ "900": "11111111-1111-1111-1111-111111111111" })
    );

    expect(plan.maxNumericNumber).toBe(900);
  });

  it("errors on a row without supplier number", async () => {
    const plan = await planSupplierImport(
      { mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" }, rows: [["", "Namnlös"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Leverantörsnummer saknas"]);
    expect(plan.summary.error).toBe(1);
    expect(plan.hasErrors).toBe(true);
    expect(plan.creates).toEqual([]);
  });

  it("errors when a new supplier has no name", async () => {
    const plan = await planSupplierImport(
      { mapping: { Leverantörsnummer: "supplierNumber" }, rows: [["300"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Namn saknas — obligatoriskt för ny leverantör"]);
  });

  it("errors on values longer than the column allows", async () => {
    const plan = await planSupplierImport(
      { mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" }, rows: [["400", "x".repeat(256)]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Fältet 'Namn' är för långt (max 255 tecken)"]);
  });

  it("errors on the second occurrence of a duplicated number", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
        rows: [
          ["600", "Första"],
          ["600", "Andra"],
        ],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.errors).toEqual(["Leverantörsnumret förekommer flera gånger i filen"]);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 0, error: 1, warning: 0 });
    expect(plan.creates).toHaveLength(1);
  });
});

describe("planSupplierImport — currency, e-mail policy and series basis", () => {
  it("uppercases the currency and rejects codes that are not three letters", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name", Valuta: "currency" },
        rows: [
          ["700", "Lev Ett", "eur"],
          ["701", "Lev Två", "EURO"],
        ],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.creates).toEqual([{ supplierNumber: "700", name: "Lev Ett", currency: "EUR" }]);
    expect(plan.rows[1]!.errors).toEqual(["Ogiltig valutakod 'EURO' — ange 3 bokstäver, t.ex. SEK"]);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 0, error: 1, warning: 0 });
  });

  it("omits currency from the payload when the cell is empty", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name", Valuta: "currency" },
        rows: [["702", "Lev Tre", ""]],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    // Create: the DB default 'SEK' applies. Update: the field is untouched.
    expect(plan.creates).toEqual([{ supplierNumber: "702", name: "Lev Tre" }]);
  });

  it("drops an invalid e-mail with a warning instead of blocking the row", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name", "E-post": "email" },
        rows: [["500", "Lev AB", "not-an-email"]],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.warnings).toEqual(["Ogiltig e-postadress 'not-an-email' — fältet lämnades tomt"]);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 0, error: 0, warning: 1 });
    expect(plan.creates).toEqual([{ supplierNumber: "500", name: "Lev AB" }]);
  });

  it("carries ourCustomerNumber in the payload", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name", "Vårt kundnummer": "ourCustomerNumber" },
        rows: [["800", "Lev AB", "KUND-777"]],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.creates).toEqual([{ supplierNumber: "800", name: "Lev AB", ourCustomerNumber: "KUND-777" }]);
  });

  it("computes maxNumericNumber over all-digit numbers only", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
        rows: [
          ["5", "A"],
          ["250", "B"],
          ["L-9000", "C"],
          ["12345678901", "D"],
        ],
      },
      fakeDeps()
    );
    // "L-9000" is not all-digit, "12345678901" exceeds the 9-digit int4 cap.
    expect(plan.hasErrors).toBe(false);
    expect(plan.maxNumericNumber).toBe(250);
  });

  it("leaves maxNumericNumber null when no number is numeric", async () => {
    const plan = await planSupplierImport(
      { mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" }, rows: [["ABC", "Lev"]] },
      fakeDeps()
    );
    expect(plan.maxNumericNumber).toBeNull();
  });

  it("throws ImportMappingError when supplierNumber is unmapped", async () => {
    await expect(
      planSupplierImport({ mapping: { Namn: "name" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
  });
});

describe("planSupplierImport — address merging and registers", () => {
  const ADDRESS_MAPPING = {
    Leverantörsnummer: "supplierNumber",
    Namn: "name",
    "Adressrad 1": "address",
    "Adressrad 2": "address2",
    "Adressrad 3": "address3",
  };

  it("joins address/address2/address3 with a newline, dropping empty parts", async () => {
    const plan = await planSupplierImport(
      { mapping: ADDRESS_MAPPING, rows: [["700", "Lev AB", "Box 12", "", "Industrivägen 3"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.creates[0]!.address).toBe("Box 12\nIndustrivägen 3");
    expect(plan.rows[0]!.values["address"]).toBe("Box 12\nIndustrivägen 3");
  });

  it("leaves address unset when all three parts are empty on an update", async () => {
    const plan = await planSupplierImport(
      { mapping: ADDRESS_MAPPING, rows: [["700", "", "", "", ""]] },
      fakeDeps({ "700": "11111111-1111-1111-1111-111111111111" })
    );
    expect(plan.updates[0]!.patch).toEqual({});
  });

  const REGISTER_MAPPING = {
    Leverantörsnummer: "supplierNumber",
    Namn: "name",
    Betalningsvillkor: "paymentTerm",
    Leveransvillkor: "deliveryTerm",
    Leveranssätt: "carrier",
    "Kundnummer hos speditör": "carrierCustomerNumber",
  };

  it("resolves a register cell by NAME or CODE against the existing register, case-insensitively", async () => {
    const plan = await planSupplierImport(
      { mapping: REGISTER_MAPPING, rows: [["710", "Lev AB", "30 DAGAR NETTO", "dap", "DHL", "K-1"]] },
      fakeDeps(
        {},
        {
          paymentTerms: { "30 dagar netto": "pt-1", "30": "pt-1" },
          deliveryTerms: { DAP: "dt-1" },
          carriers: { "DHL Freight": "c-1", dhl: "c-1" },
        }
      )
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.creates[0]).toEqual({
      supplierNumber: "710",
      name: "Lev AB",
      paymentTermId: "pt-1",
      deliveryTermId: "dt-1",
      carrierId: "c-1",
      carrierCustomerNumber: "K-1",
    });
    expect(plan.willCreate).toEqual(EMPTY_WILL_CREATE);
  });

  it("queues a register miss in willCreate, deduped case-insensitively, and carries the raw name", async () => {
    const plan = await planSupplierImport(
      {
        mapping: REGISTER_MAPPING,
        rows: [
          ["720", "A", "10 dagar netto", "EXW", "Schenker", ""],
          ["721", "B", "10 DAGAR NETTO", "exw", "schenker", ""],
        ],
      },
      fakeDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.willCreate).toEqual({
      ...EMPTY_WILL_CREATE,
      paymentTerms: ["10 dagar netto"],
      deliveryTerms: ["EXW"],
      carriers: ["Schenker"],
    });
    expect(plan.creates[0]).toMatchObject({
      paymentTermName: "10 dagar netto",
      deliveryTermName: "EXW",
      carrierName: "Schenker",
    });
    expect(plan.creates[0]!.paymentTermId).toBeUndefined();
  });

  it("errors on a register value longer than the register's name column", async () => {
    const plan = await planSupplierImport(
      { mapping: REGISTER_MAPPING, rows: [["730", "Lev", "x".repeat(101), "", "", ""]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Fältet 'Betalningsvillkor' är för långt (max 100 tecken)"]);
    expect(plan.willCreate.paymentTerms).toEqual([]);
  });
});

describe("supplier import — repository", () => {
  it("preserves Monitor numbers, defaults currency to SEK and answers with the commit shape", async () => {
    const plan = await planSupplierImport({ mapping: NUMBER_NAME_MAPPING, rows: [["1234", "Lev AB"]] }, repo);
    const result = await repo.executeSupplierPlan(plan);
    expect(result).toEqual({ created: 1, updated: 0, registersCreated: EMPTY_WILL_CREATE });
    const [row] = await db.select().from(suppliers).where(eq(suppliers.supplierNumber, "1234"));
    expect(row!.name).toBe("Lev AB");
    expect(row!.currency).toBe("SEK"); // empty currency on create -> DB default
  });

  it("imports ourCustomerNumber", async () => {
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name", "Vårt kundnummer": "ourCustomerNumber" },
        rows: [["300", "Lev AB", "KUND-777"]],
      },
      repo
    );
    await repo.executeSupplierPlan(plan);
    const [row] = await db.select().from(suppliers).where(eq(suppliers.supplierNumber, "300"));
    expect(row!.ourCustomerNumber).toBe("KUND-777");
  });

  it("updates by supplier number and leaves unmapped/empty fields untouched", async () => {
    await db.insert(suppliers).values({
      supplierNumber: "42",
      name: "Gammalt Namn",
      phone: "070-111 11 11",
      currency: "EUR",
    });
    const plan = await planSupplierImport(
      {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name", Valuta: "currency" },
        rows: [["42", "Nytt Namn", ""]],
      },
      repo
    );
    const result = await repo.executeSupplierPlan(plan);
    expect(result.updated).toBe(1);
    const [row] = await db.select().from(suppliers).where(eq(suppliers.supplierNumber, "42"));
    expect(row!.name).toBe("Nytt Namn");
    expect(row!.phone).toBe("070-111 11 11"); // never mapped — untouched
    expect(row!.currency).toBe("EUR"); // mapped but empty cell — untouched
  });

  it("overwrites currency on update when the cell has a value", async () => {
    await db.insert(suppliers).values({ supplierNumber: "43", name: "Lev", currency: "SEK" });
    const plan = await planSupplierImport(
      { mapping: { Leverantörsnummer: "supplierNumber", Valuta: "currency" }, rows: [["43", "usd"]] },
      repo
    );
    await repo.executeSupplierPlan(plan);
    const [row] = await db.select().from(suppliers).where(eq(suppliers.supplierNumber, "43"));
    expect(row!.currency).toBe("USD");
  });

  it("bumps the supplier series past the highest numeric imported number", async () => {
    await setSupplierSeries(100);
    const plan = await planSupplierImport(
      {
        mapping: NUMBER_NAME_MAPPING,
        rows: [
          ["5", "A"],
          ["250", "B"],
          ["ABC-1", "C"],
        ],
      },
      repo
    );
    await repo.executeSupplierPlan(plan);
    expect(await supplierSeriesNext()).toBe(251);
  });

  it("never lowers the series", async () => {
    await setSupplierSeries(1000);
    const plan = await planSupplierImport({ mapping: NUMBER_NAME_MAPPING, rows: [["5", "Låg"]] }, repo);
    await repo.executeSupplierPlan(plan);
    expect(await supplierSeriesNext()).toBe(1000);
  });

  it("leaves the series untouched when no imported number is numeric", async () => {
    await setSupplierSeries(100);
    const plan = await planSupplierImport({ mapping: NUMBER_NAME_MAPPING, rows: [["L-100", "Lev AB"]] }, repo);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 0, error: 0, warning: 0 });
    await repo.executeSupplierPlan(plan);
    expect(await supplierSeriesNext()).toBe(100);
  });

  it("writes nothing when any statement in the transaction fails", async () => {
    await setSupplierSeries(100);
    const [existing] = await db
      .insert(suppliers)
      .values({ supplierNumber: "900", name: "Befintlig" })
      .returning();

    // Hand-built plan that bypasses planSupplierImport's length validation:
    // the update's 300-char name violates varchar(255), so the update
    // statement throws — the create and the series bump must both roll back.
    const plan: SupplierImportPlan = {
      rows: [],
      summary: { create: 1, update: 1, skip: 0, error: 0, warning: 0 },
      willCreate: EMPTY_WILL_CREATE,
      creates: [{ supplierNumber: "901", name: "Ny Lev" }],
      updates: [{ id: existing!.id, patch: { name: "x".repeat(300) } }],
      maxNumericNumber: 901,
      hasErrors: false,
    };

    await expect(repo.executeSupplierPlan(plan)).rejects.toThrow();

    const rows = await db.select().from(suppliers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Befintlig");
    expect(await supplierSeriesNext()).toBe(100);
  });
});

describe("supplier import — repository registers", () => {
  it("creates the three missing registers before the suppliers that reference them, and reports them", async () => {
    const plan = await planSupplierImport(
      {
        mapping: {
          Leverantörsnummer: "supplierNumber",
          Namn: "name",
          Betalningsvillkor: "paymentTerm",
          Leveransvillkor: "deliveryTerm",
          Leveranssätt: "carrier",
        },
        rows: [["950", "Lev AB", "30 dagar netto", "DAP", "Leverantören bokar frakt"]],
      },
      repo
    );
    expect(plan.willCreate).toEqual({
      ...EMPTY_WILL_CREATE,
      paymentTerms: ["30 dagar netto"],
      deliveryTerms: ["DAP"],
      carriers: ["Leverantören bokar frakt"],
    });

    const result = await repo.executeSupplierPlan(plan);
    expect(result.registersCreated).toEqual({
      units: [],
      articleGroups: [],
      paymentTerms: ["30 dagar netto"],
      deliveryTerms: ["DAP"],
      carriers: ["Leverantören bokar frakt"],
    });

    const [pt] = await db.select().from(paymentTerms).where(eq(paymentTerms.name, "30 dagar netto"));
    expect(pt!.code).toBe("30"); // "<n> dagar" -> the day count is the code
    const [dt] = await db.select().from(deliveryTerms).where(eq(deliveryTerms.name, "DAP"));
    expect(dt!.code).toBe("DAP");
    const [carrier] = await db.select().from(carriers).where(eq(carriers.name, "Leverantören bokar frakt"));
    expect(carrier!.code.length).toBeLessThanOrEqual(20);

    const [supplier] = await db.select().from(suppliers).where(eq(suppliers.supplierNumber, "950"));
    expect(supplier!.paymentTermId).toBe(pt!.id);
    expect(supplier!.deliveryTermId).toBe(dt!.id);
    expect(supplier!.carrierId).toBe(carrier!.id);
  });

  it("re-importing the same file a second time finds the registers instead of recreating them, and patches on update", async () => {
    const input = {
      mapping: { Leverantörsnummer: "supplierNumber", Namn: "name", Betalningsvillkor: "paymentTerm" },
      rows: [["960", "Lev AB", "60 dagar netto"]],
    };
    await repo.executeSupplierPlan(await planSupplierImport(input, repo));
    const second = await planSupplierImport(input, repo);
    expect(second.willCreate.paymentTerms).toEqual([]);
    expect(second.updates[0]!.patch.paymentTermId).toBeDefined();
    const result = await repo.executeSupplierPlan(second);
    expect(result.registersCreated.paymentTerms).toEqual([]);
    expect(await db.select().from(paymentTerms)).toHaveLength(1);
  });

  it("rolls back register creation too when a later statement in the same transaction fails", async () => {
    const [existing] = await db.insert(suppliers).values({ supplierNumber: "970", name: "Befintlig" }).returning();
    const plan: SupplierImportPlan = {
      rows: [],
      summary: { create: 0, update: 1, skip: 0, error: 0, warning: 0 },
      willCreate: { ...EMPTY_WILL_CREATE, carriers: ["Bring"] },
      creates: [],
      updates: [{ id: existing!.id, patch: { name: "x".repeat(300), carrierName: "Bring" } }],
      maxNumericNumber: null,
      hasErrors: false,
    };
    await expect(repo.executeSupplierPlan(plan)).rejects.toThrow();
    expect(await db.select().from(carriers)).toHaveLength(0);
  });
});

describe("import service — suppliers entity", () => {
  it("accepts suppliers in the entity enum", () => {
    expect(importEntitySchema.options).toContain("suppliers");
  });

  it("suggests the supplier mapping through parse", async () => {
    const result = await importService.parse(
      "suppliers",
      Buffer.from("Lev.nr;Namn;Valuta;Okänd kolumn\n100;Lev AB;EUR;x\n")
    );
    expect(result.suggestedMapping).toEqual({
      "Lev.nr": "supplierNumber",
      Namn: "name",
      Valuta: "currency",
      "Okänd kolumn": null,
    });
  });

  it("commits a supplier import end-to-end", async () => {
    const result = await importService.commit("suppliers", {
      mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
      rows: [["1001", "Lev AB"]],
    });
    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      skippedRows: [],
      registersCreated: EMPTY_WILL_CREATE,
    });
  });

  it("imports the Postadress export's Monitor headings end-to-end from xlsx", async () => {
    const buf = buildXlsxBuffer([
      {
        name: "Postadress",
        rows: [
          [
            "Leverantör",
            "Namn",
            "Postadress – Adressformat",
            "Postadress – Namn",
            "Postadress – Adressrad 1",
            "Postadress – Adressrad 2",
            "Postadress – Adressrad 3",
            "Postadress – Adressrad 4",
            "Postadress – Postnummer",
            "Postadress – Stad",
            "Postadress – Region",
            "Postadress – Land",
          ],
          [
            "0001",
            "Gjuteriet",
            "Postnummer + Stad",
            "Gjuteriet i Exempelby AB",
            "Gjutarvägen 1",
            "",
            "",
            "",
            "44695",
            "EXEMPELBY",
            "",
            "SE",
          ],
        ],
      },
    ]);
    const parsed = await importService.parse("suppliers", buf);
    const mapping: Record<string, string | null> = {};
    for (const header of parsed.headers) mapping[header] = parsed.suggestedMapping[header] ?? null;

    const result = await importService.commit("suppliers", { mapping, rows: parsed.rows });
    expect(result.created).toBe(1);

    const [row] = await db.select().from(suppliers).where(eq(suppliers.supplierNumber, "0001"));
    expect(row!.name).toBe("Gjuteriet i Exempelby AB"); // "Postadress – Namn", not the short "Namn"
    expect(row!.address).toBe("Gjutarvägen 1");
    expect(row!.postalCode).toBe("44695");
    expect(row!.city).toBe("EXEMPELBY");
  });

  it("skips existing records and lists them in the response", async () => {
    await importService.commit("suppliers", {
      mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
      rows: [["3001", "Före"]],
    });

    const result = await importService.commit("suppliers", {
      mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
      rows: [
        ["3001", "Efter"],
        ["3002", "Lev AB"],
      ],
      skipExisting: true,
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows).toEqual([
      {
        rowNumber: 2,
        reason: "Leverantören 3001 finns redan i registret",
        values: { supplierNumber: "3001", name: "Efter" },
      },
    ]);

    const rows = await db.select().from(suppliers);
    expect(rows.find((row) => row.supplierNumber === "3001")!.name).toBe("Före");
  });

  it("aborts the whole commit on any row error with the preview payload (nothing written)", async () => {
    await expect(
      importService.commit("suppliers", {
        mapping: { Leverantörsnummer: "supplierNumber", Namn: "name" },
        rows: [
          ["2001", "Frisk rad"],
          ["", "Trasig rad"],
        ],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    const rows = await db.select().from(suppliers);
    expect(rows).toHaveLength(0); // nothing written
  });
});
