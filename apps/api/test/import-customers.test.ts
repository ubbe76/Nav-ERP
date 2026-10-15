import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { carriers, customers, db, deliveryTerms, numberSeries, paymentTerms, priceLists } from "@navet/db";
import { importEntitySchema } from "@navet/shared";
import {
  assignRegisterCodes,
  generatePaymentTermCode,
  planCustomerImport,
  slugifyRegisterCode,
  suggestCustomerMapping,
  type CustomerImportDeps,
  type CustomerImportPlan,
} from "../src/modules/import/service/customers.js";
import {
  createImportService,
  ImportMappingError,
  ImportValidationError,
} from "../src/modules/import/service/import.service.js";
import { createImportRepository } from "../src/modules/import/repository/import.repository.js";
import { buildXlsxBuffer } from "./helpers/xlsx-fixture.js";

const repo = createImportRepository(db);

// number_series is NEVER truncated (shared, sequence-like base data). The
// "customer" row is seeded by the kundnummer plan's migration; the ON
// CONFLICT upsert below self-heals a stale test database and pins
// next_number to a known value per test. The four registers ARE truncated —
// unlike units/articleGroups (shared by every article-import test file),
// nothing else in this suite seeds them.
const TRUNCATE = sql`
  TRUNCATE customer_contacts, customer_delivery_addresses, customers,
    payment_terms, delivery_terms, carriers, price_lists CASCADE
`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function setCustomerSeries(next: number) {
  await db.execute(sql`
    INSERT INTO number_series (key, prefix, next_number, digits)
    VALUES ('customer', '', ${next}, 0)
    ON CONFLICT (key) DO UPDATE SET next_number = EXCLUDED.next_number
  `);
}

async function customerSeriesNext(): Promise<number> {
  const [row] = await db.select().from(numberSeries).where(eq(numberSeries.key, "customer"));
  return row!.nextNumber;
}

const NUMBER_NAME_MAPPING = { Kundnummer: "customerNumber", Namn: "name" };

const importService = createImportService(repo);

// In-memory deps (number -> id) — the planner never touches Drizzle, so
// these tests run without any database writes. `registers` seeds the four
// name/code -> id lookups; keys are matched case-insensitively, same as the
// real repository methods.
function fakeDeps(
  existing: Record<string, string> = {},
  registers: {
    paymentTerms?: Record<string, string>;
    deliveryTerms?: Record<string, string>;
    carriers?: Record<string, string>;
    priceLists?: Record<string, string>;
  } = {}
): CustomerImportDeps {
  const toMap = (reg?: Record<string, string>) =>
    new Map(Object.entries(reg ?? {}).map(([key, id]) => [key.toLowerCase(), id]));
  return {
    async customersByNumber(numbers) {
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
    async priceListsByNameOrCode() {
      return toMap(registers.priceLists);
    },
  };
}

const EMPTY_WILL_CREATE = {
  units: [] as string[],
  articleGroups: [] as string[],
  paymentTerms: [] as string[],
  deliveryTerms: [] as string[],
  carriers: [] as string[],
  priceLists: [] as string[],
};

describe("suggestCustomerMapping", () => {
  it("guesses the primary Monitor headings for every field", () => {
    const suggested = suggestCustomerMapping([
      "Kundnummer",
      "Namn",
      "Orgnr",
      "Momsreg.nr",
      "Kontaktperson",
      "E-post",
      "Telefon",
      "Adress",
      "Postnummer",
      "Ort",
      "Fakturaadress",
      "Faktura e-post",
    ]);
    expect(Object.values(suggested)).toEqual([
      "customerNumber",
      "name",
      "orgNumber",
      "vatNumber",
      "contactName",
      "email",
      "phone",
      "address",
      "postalCode",
      "city",
      "invoiceAddress",
      "invoiceEmail",
    ]);
  });

  it("guesses alternate spellings case-insensitively, first hit wins, unknown columns stay unmapped", () => {
    const suggested = suggestCustomerMapping([
      "Kundnr",
      "KUNDNUMMER",
      "Kundnamn",
      "Organisationsnummer",
      "VAT-nummer",
      "Referens",
      "Mail",
      "Besöksadress",
      "Postnr",
      "Postort",
      "Frisyr",
    ]);
    expect(suggested["Kundnr"]).toBe("customerNumber");
    // customerNumber was already claimed by the first column — first hit wins.
    expect(suggested["KUNDNUMMER"]).toBeNull();
    expect(suggested["Kundnamn"]).toBe("name");
    expect(suggested["Organisationsnummer"]).toBe("orgNumber");
    expect(suggested["VAT-nummer"]).toBe("vatNumber");
    expect(suggested["Referens"]).toBe("contactName");
    expect(suggested["Mail"]).toBe("email");
    expect(suggested["Besöksadress"]).toBe("address");
    expect(suggested["Postnr"]).toBe("postalCode");
    expect(suggested["Postort"]).toBe("city");
    expect(suggested["Frisyr"]).toBeNull();
  });

  // Aliasprioritet (suggestMapping's `preferred` argument): Monitor's
  // Postadress export lists the short "Namn" column BEFORE the full
  // "Postadress – Namn" one, and both alias to "name" — without the
  // preferred pass, "Namn" (coming first) would win the contest and
  // "Postadress – Namn" would be left unmapped, the wrong way round.
  it("prefers the specific 'Postadress – Namn' heading over the generic 'Namn' even though Namn comes first", () => {
    const suggested = suggestCustomerMapping(["Kund", "Namn", "Postadress – Namn"]);
    expect(suggested).toEqual({
      Kund: "customerNumber",
      Namn: null,
      "Postadress – Namn": "name",
    });
  });

  it("still maps a lone 'Namn' column to name when no 'Postadress – Namn' column is present", () => {
    const suggested = suggestCustomerMapping(["Kundnummer", "Namn"]);
    expect(suggested["Namn"]).toBe("name");
  });

  // Lista-first order: Monitor's Lista export is where the customers are
  // CREATED, and a new customer needs a name — so the short "Namn" column
  // maps to name there, detected by headings only the Lista file carries
  // (CUSTOMER_LISTA_MARKERS). Every address file keeps "Namn" unmapped so
  // the legal name from "Postadress – Namn" is never overwritten.
  it("maps 'Namn' to name in Monitor's Lista export (Lista-only headings present)", () => {
    expect(suggestCustomerMapping(["Kund", "Namn", "Kundgrupp", "Organisationsnr"])).toEqual({
      Kund: "customerNumber",
      Namn: "name",
      Kundgrupp: null,
      Organisationsnr: "orgNumber",
    });
  });

  it("maps 'Namn' in a terms-only Lista export too (Betalningsvillkor/Prislista are Lista markers)", () => {
    expect(suggestCustomerMapping(["Kund", "Namn", "Betalningsvillkor"])).toEqual({
      Kund: "customerNumber",
      Namn: "name",
      Betalningsvillkor: "paymentTerm",
    });
  });

  it("leaves 'Namn' unmapped in every Monitor address file", () => {
    // Postadress: the preferred alias hands name to the full heading.
    expect(suggestCustomerMapping(["Kund", "Namn", "Postadress – Namn"])).toEqual({
      Kund: "customerNumber",
      Namn: null,
      "Postadress – Namn": "name",
    });
    // Fakturaadress: name must survive the invoice-address update run.
    expect(suggestCustomerMapping(["Kund", "Namn", "Avviker från postadress", "Fakturaadress – Namn"])["Namn"]).toBeNull();
    // Leveransadress/Besöksadress loaded on the Kunder tab by mistake.
    expect(suggestCustomerMapping(["Kund", "Namn", "Leveransadress – Namn"])["Namn"]).toBeNull();
    expect(suggestCustomerMapping(["Kund", "Namn", "Avviker från leveransadress", "Besöksadress – Namn"])["Namn"]).toBeNull();
    // A Lista marker next to an invoice-address marker is NOT a Lista file.
    expect(suggestCustomerMapping(["Kund", "Namn", "Kundgrupp", "Fakturaadress – Namn"])["Namn"]).toBeNull();
  });

  // The exact 34 headings of Kundlista-Lista-2026-09-03.xlsx. Only Kund,
  // Namn, Momsreg.nr, Organisationsnr, Vårt leverantörsnummer,
  // Samlingsfaktura, Privatperson and Webbsida have a counterpart in
  // `customers`; everything else stays unmapped — Personnummer deliberately
  // (org_number is the only column, and merging is a v2 question), Kundgrupp
  // deliberately (Sverige/EU/Export is not a country code — Postadress –
  // Land is).
  it("guesses the exact headings of Monitor's Lista export (2026-09-03)", () => {
    const headers = [
      "Kund", "Namn", "Prioritet", "Kundgrupp", "Momsreg.nr", "Moderbolag (kund)",
      "Välj leveransadress", "Personnummer", "Organisationsnr", "Kundkategori",
      "Vårt leverantörsnummer", "Kundnummer faktura", "Kreditlimit", "Försäkringsavgift",
      "Bankgiro", "PlusGiro", "Faktureringsavgift", "Betalningspåminnelse", "Samlingsfaktura",
      "Påminnelseavgift", "Öresavrundning", "Faktura i vänteläge", "Factoring",
      "Distributionsmetod", "Terminskurs", "Strökund", "Privatperson", "Webbsida",
      "Order som XML", "Faktura som XML", "Ärende som XML", "EORI-nr",
      "Flera order i e-postmeddelande", "Flera fakturor i e-post",
    ];
    const suggested = suggestCustomerMapping(headers);
    const expected: Record<string, string | null> = Object.fromEntries(headers.map((h) => [h, null]));
    expected["Kund"] = "customerNumber";
    expected["Namn"] = "name";
    expected["Momsreg.nr"] = "vatNumber";
    expected["Organisationsnr"] = "orgNumber";
    expected["Vårt leverantörsnummer"] = "ourSupplierNumber";
    expected["Samlingsfaktura"] = "collectiveInvoicing";
    expected["Privatperson"] = "privatePerson";
    expected["Webbsida"] = "website";
    expect(suggested).toEqual(expected);
  });

  // The actual headings of Monitor G5's exports (2026-09) — every column is
  // prefixed with its block name, and Adressrad 4/Adressformat/Region have
  // no Nav counterpart.
  it("guesses Monitor's prefixed Postadress and Fakturaadress headings", () => {
    expect(
      suggestCustomerMapping([
        "Kund",
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
      ])
    ).toEqual({
      Kund: "customerNumber",
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
      "Postadress – Land": "country",
    });
    expect(
      suggestCustomerMapping([
        "Kund",
        "Namn",
        "Avviker från postadress",
        "Fakturaadress – Namn",
        "Fakturaadress – Adressrad 1",
        "Fakturaadress – Adressrad 2",
        "Fakturaadress – Adressrad 3",
        "Fakturaadress – Adressrad 4",
        "Fakturaadress – Postnummer",
        "Fakturaadress – Stad",
        "Fakturaadress – Land",
      ])
    ).toEqual({
      Kund: "customerNumber",
      Namn: null,
      "Avviker från postadress": "invoiceAddressDiffers",
      "Fakturaadress – Namn": "invoiceName",
      "Fakturaadress – Adressrad 1": "invoiceAddress",
      "Fakturaadress – Adressrad 2": "invoiceAddress2",
      "Fakturaadress – Adressrad 3": "invoiceAddress3",
      "Fakturaadress – Adressrad 4": null,
      "Fakturaadress – Postnummer": "invoicePostalCode",
      "Fakturaadress – Stad": "invoiceCity",
      "Fakturaadress – Land": "invoiceCountry",
    });
  });

  // File-context rule: Monitor's Fakturaadress export reuses the exact same
  // column headings as the Postadress export ("Adressrad 1..3",
  // "Postnummer", "Stad", "Land") for the INVOICE address — detected by the
  // presence of "Fakturaadress – Namn" or "Avviker från postadress".
  it("routes the shared address columns to the invoice fields when the Fakturaadress export is detected", () => {
    const suggested = suggestCustomerMapping([
      "Kund",
      "Avviker från postadress",
      "Fakturaadress – Namn",
      "Adressrad 1",
      "Adressrad 2",
      "Adressrad 3",
      "Postnummer",
      "Stad",
      "Land",
    ]);
    expect(suggested).toEqual({
      Kund: "customerNumber",
      "Avviker från postadress": "invoiceAddressDiffers",
      "Fakturaadress – Namn": "invoiceName",
      "Adressrad 1": "invoiceAddress",
      "Adressrad 2": "invoiceAddress2",
      "Adressrad 3": "invoiceAddress3",
      Postnummer: "invoicePostalCode",
      Stad: "invoiceCity",
      Land: "invoiceCountry",
    });
  });

  it("routes the same address columns to the customer's own address for the Postadress export", () => {
    const suggested = suggestCustomerMapping([
      "Kund",
      "Postadress – Namn",
      "Adressrad 1",
      "Adressrad 2",
      "Adressrad 3",
      "Postnummer",
      "Stad",
      "Land",
    ]);
    expect(suggested).toEqual({
      Kund: "customerNumber",
      "Postadress – Namn": "name",
      "Adressrad 1": "address",
      "Adressrad 2": "address2",
      "Adressrad 3": "address3",
      Postnummer: "postalCode",
      Stad: "city",
      Land: "country",
    });
  });

  it("guesses the Lista export's register columns", () => {
    const suggested = suggestCustomerMapping(["Kund", "Betalningsvillkor", "Leveransvillkor", "Leveranssätt", "Prislista", "Rabatt"]);
    expect(suggested).toEqual({
      Kund: "customerNumber",
      Betalningsvillkor: "paymentTerm",
      Leveransvillkor: "deliveryTerm",
      Leveranssätt: "carrier",
      Prislista: "priceList",
      Rabatt: "discountPercent",
    });
  });
});

describe("planCustomerImport — classification and validation", () => {
  it("classifies unknown numbers as create and known numbers as update", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name" },
        rows: [
          ["100", "Gammal Kund"],
          ["200", "Ny Kund"],
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
      { id: "11111111-1111-1111-1111-111111111111", patch: { name: "Gammal Kund" } },
    ]);
    expect(plan.creates).toEqual([{ customerNumber: "200", name: "Ny Kund" }]);
    expect(plan.willCreate).toEqual(EMPTY_WILL_CREATE);
  });

  it("skips a known number entirely when skipExisting is set", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name" },
        rows: [
          ["100", "Skriv inte över"],
          ["250", "Ny Kund"],
        ],
        skipExisting: true,
      },
      fakeDeps({ "100": "11111111-1111-1111-1111-111111111111" })
    );

    expect(plan.rows[0]!.action).toBe("skip");
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.skipReason).toBe("Kunden 100 finns redan i registret");
    expect(plan.rows[0]!.values).toEqual({ customerNumber: "100", name: "Skriv inte över" });
    expect(plan.updates).toEqual([]);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 1, error: 0, warning: 0 });
    expect(plan.hasErrors).toBe(false);
    // A skipped number is taken by the existing record — the series must
    // still be pulled past it, exactly as if the row had been imported.
    expect(plan.maxNumericNumber).toBe(250);
  });

  it("pulls the series past a skipped number that is higher than any created one", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name" },
        rows: [
          ["900", "Finns redan"],
          ["250", "Ny Kund"],
        ],
        skipExisting: true,
      },
      fakeDeps({ "900": "11111111-1111-1111-1111-111111111111" })
    );

    expect(plan.maxNumericNumber).toBe(900);
  });

  it("errors on a row without customer number", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name" }, rows: [["", "Namnlös"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Kundnummer saknas"]);
    expect(plan.summary.error).toBe(1);
    expect(plan.hasErrors).toBe(true);
    expect(plan.creates).toEqual([]);
  });

  it("errors when a new customer has no name", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber" }, rows: [["300"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Namn saknas — obligatoriskt för ny kund"]);
  });

  it("allows an update row with empty name cell (empty = untouched)", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name", Telefon: "phone" },
        rows: [["100", "", "070-123 45 67"]],
      },
      fakeDeps({ "100": "22222222-2222-2222-2222-222222222222" })
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.updates[0]!.patch).toEqual({ phone: "070-123 45 67" });
  });

  it("errors on values longer than the column allows", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name" }, rows: [["400", "x".repeat(256)]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Fältet 'Namn' är för långt (max 255 tecken)"]);
    expect(plan.summary.error).toBe(1);
  });
});

describe("planCustomerImport — e-mail policy, duplicates and series basis", () => {
  it("drops an invalid e-mail with a warning instead of blocking the row", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name", "E-post": "email" },
        rows: [["500", "Kund AB", "not-an-email"]],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[0]!.warnings).toEqual(["Ogiltig e-postadress 'not-an-email' — fältet lämnades tomt"]);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 0, error: 0, warning: 1 });
    expect(plan.creates).toEqual([{ customerNumber: "500", name: "Kund AB" }]);
  });

  it("applies the same policy to invoiceEmail", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name", "Faktura e-post": "invoiceEmail" },
        rows: [["501", "Kund AB", "faktura@"]],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.warnings).toEqual(["Ogiltig e-postadress 'faktura@' — fältet lämnades tomt"]);
    expect(plan.creates).toEqual([{ customerNumber: "501", name: "Kund AB" }]);
  });

  it("errors on the second occurrence of a duplicated number", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name" },
        rows: [
          ["600", "Första"],
          ["600", "Andra"],
        ],
      },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([]);
    expect(plan.rows[1]!.errors).toEqual(["Kundnumret förekommer flera gånger i filen"]);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 0, error: 1, warning: 0 });
    expect(plan.creates).toHaveLength(1);
  });

  it("computes maxNumericNumber over all-digit numbers only", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name" },
        rows: [
          ["5", "A"],
          ["250", "B"],
          ["K-9000", "C"],
          ["12345678901", "D"],
        ],
      },
      fakeDeps()
    );
    // "K-9000" is not all-digit, "12345678901" exceeds the 9-digit int4 cap.
    expect(plan.hasErrors).toBe(false);
    expect(plan.maxNumericNumber).toBe(250);
  });

  it("leaves maxNumericNumber null when no number is numeric", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name" }, rows: [["ABC", "Kund"]] },
      fakeDeps()
    );
    expect(plan.maxNumericNumber).toBeNull();
  });

  it("throws ImportMappingError when customerNumber is unmapped", async () => {
    await expect(
      planCustomerImport({ mapping: { Namn: "name" }, rows: [] }, fakeDeps())
    ).rejects.toBeInstanceOf(ImportMappingError);
  });
});

describe("planCustomerImport — address merging, country, discount, invoice-differs", () => {
  const ADDRESS_MAPPING = {
    Kundnummer: "customerNumber",
    Namn: "name",
    "Adressrad 1": "address",
    "Adressrad 2": "address2",
    "Adressrad 3": "address3",
  };

  it("joins address/address2/address3 with a newline", async () => {
    const plan = await planCustomerImport(
      { mapping: ADDRESS_MAPPING, rows: [["700", "Kund AB", "Storgatan 1", "Box 2", "Extra rad"]] },
      fakeDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates[0]!.address).toBe("Storgatan 1\nBox 2\nExtra rad");
  });

  it("drops empty address parts instead of leaving blank lines", async () => {
    const plan = await planCustomerImport(
      { mapping: ADDRESS_MAPPING, rows: [["701", "Kund AB", "Storgatan 1", "", "Extra rad"]] },
      fakeDeps()
    );
    expect(plan.creates[0]!.address).toBe("Storgatan 1\nExtra rad");
  });

  it("leaves address unset when all three parts are empty on an update", async () => {
    const plan = await planCustomerImport(
      { mapping: ADDRESS_MAPPING, rows: [["100", "Namn oförändrat", "", "", ""]] },
      fakeDeps({ "100": "11111111-1111-1111-1111-111111111111" })
    );
    expect(plan.updates[0]!.patch.address).toBeUndefined();
  });

  it("uppercases a valid country code on create", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name", Land: "country" }, rows: [["702", "Kund AB", "se"]] },
      fakeDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates[0]!.country).toBe("SE");
  });

  it("errors on a country code that isn't two letters", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name", Land: "country" }, rows: [["703", "Kund AB", "XYZ"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Land måste vara en landskod med två bokstäver (t.ex. SE)"]);
  });

  it("leaves country unset (SE default applies) when the cell is empty", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name", Land: "country" }, rows: [["704", "Kund AB", ""]] },
      fakeDeps()
    );
    expect(plan.creates[0]!).not.toHaveProperty("country");
  });

  it("parses a Swedish-comma discount within 0–100", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name", Rabatt: "discountPercent" }, rows: [["705", "Kund AB", "15,5"]] },
      fakeDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates[0]!.discountPercent).toBe(15.5);
  });

  it("errors on a discount that isn't a number", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name", Rabatt: "discountPercent" }, rows: [["706", "Kund AB", "abc"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(['Ogiltig rabatt: "abc"']);
  });

  it("errors on a discount outside 0–100", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name", Rabatt: "discountPercent" }, rows: [["707", "Kund AB", "150"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual(["Kundrabatten måste vara mellan 0 och 100"]);
  });

  const INVOICE_DIFFERS_MAPPING = {
    Kundnummer: "customerNumber",
    Namn: "name",
    "Avviker från postadress": "invoiceAddressDiffers",
    "Fakturaadress – Namn": "invoiceName",
    "Faktura e-post": "invoiceEmail",
  };

  it("drops every invoice* key except invoiceEmail when invoiceAddressDiffers is false, on create", async () => {
    const plan = await planCustomerImport(
      {
        mapping: INVOICE_DIFFERS_MAPPING,
        rows: [["708", "Kund AB", "Nej", "Holding AB", "faktura@kund.se"]],
      },
      fakeDeps()
    );
    expect(plan.hasErrors).toBe(false);
    expect(plan.creates[0]!).not.toHaveProperty("invoiceName");
    expect(plan.creates[0]!.invoiceEmail).toBe("faktura@kund.se");
  });

  it("keeps invoice* keys when invoiceAddressDiffers is true", async () => {
    const plan = await planCustomerImport(
      { mapping: INVOICE_DIFFERS_MAPPING, rows: [["709", "Kund AB", "Ja", "Holding AB", "faktura@kund.se"]] },
      fakeDeps()
    );
    expect(plan.creates[0]!.invoiceName).toBe("Holding AB");
  });

  it("drops invoice* keys from the patch too, on update", async () => {
    const plan = await planCustomerImport(
      { mapping: INVOICE_DIFFERS_MAPPING, rows: [["100", "Kund AB", "0", "Holding AB", ""]] },
      fakeDeps({ "100": "11111111-1111-1111-1111-111111111111" })
    );
    expect(plan.updates[0]!.patch).not.toHaveProperty("invoiceName");
  });

  it("errors on an unrecognized invoiceAddressDiffers value", async () => {
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name", "Avviker från postadress": "invoiceAddressDiffers" }, rows: [["710", "Kund AB", "kanske"]] },
      fakeDeps()
    );
    expect(plan.rows[0]!.errors).toEqual([
      "Ogiltigt värde för 'Avviker från postadress': \"kanske\" (Ja/Nej/1/0/x/true/false)",
    ]);
  });

  describe("planCustomerImport — samlingsfaktura/privatperson/webbsida/vårt leverantörsnummer", () => {
    const EXTRA_FIELDS_MAPPING = {
      Kundnummer: "customerNumber",
      Namn: "name",
      Samlingsfaktura: "collectiveInvoicing",
      Privatperson: "privatePerson",
      Webbsida: "website",
      "Vårt leverantörsnummer": "ourSupplierNumber",
    };

    it("parses 'Ja'/'Nej' into true/false", async () => {
      const plan = await planCustomerImport(
        { mapping: EXTRA_FIELDS_MAPPING, rows: [["711", "Kund AB", "Ja", "Nej", "", ""]] },
        fakeDeps()
      );
      expect(plan.hasErrors).toBe(false);
      expect(plan.creates[0]!.collectiveInvoicing).toBe(true);
      expect(plan.creates[0]!.privatePerson).toBe(false);
    });

    it("parses 'x'/'1' as true", async () => {
      const plan = await planCustomerImport(
        { mapping: EXTRA_FIELDS_MAPPING, rows: [["712", "Kund AB", "x", "1", "", ""]] },
        fakeDeps()
      );
      expect(plan.hasErrors).toBe(false);
      expect(plan.creates[0]!.collectiveInvoicing).toBe(true);
      expect(plan.creates[0]!.privatePerson).toBe(true);
    });

    // Monitor's Samlingsfaktura column is a mode, not a checkbox: its Lista
    // export carries "Nej" or "Per kund" (other modes read "Per …" too).
    // Any "Per …" value means the customer IS on collective invoicing.
    it("treats Monitor's 'Per kund' (and any 'Per …' mode) as Samlingsfaktura = true", async () => {
      const plan = await planCustomerImport(
        {
          mapping: EXTRA_FIELDS_MAPPING,
          rows: [
            ["715", "Kund AB", "Per kund", "false", "", ""],
            ["716", "Kund BB", "Per leveransadress", "true", "", ""],
            ["717", "Kund CC", "Nej", "false", "", ""],
          ],
        },
        fakeDeps()
      );
      expect(plan.hasErrors).toBe(false);
      expect(plan.creates.map((c) => c.collectiveInvoicing)).toEqual([true, true, false]);
      expect(plan.creates.map((c) => c.privatePerson)).toEqual([false, true, false]);
    });

    it("errors on an unrecognized boolean value, mentioning the field label", async () => {
      const plan = await planCustomerImport(
        { mapping: EXTRA_FIELDS_MAPPING, rows: [["713", "Kund AB", "kanske", "", "", ""]] },
        fakeDeps()
      );
      expect(plan.rows[0]!.errors).toEqual(['Ogiltigt värde för \'Samlingsfaktura\': "kanske" (Ja/Nej)']);
    });

    it("stores website and ourSupplierNumber as plain text", async () => {
      const plan = await planCustomerImport(
        {
          mapping: EXTRA_FIELDS_MAPPING,
          rows: [["714", "Kund AB", "", "", "www.nimoverken.com", "LEV-4711"]],
        },
        fakeDeps()
      );
      expect(plan.hasErrors).toBe(false);
      expect(plan.creates[0]!.website).toBe("www.nimoverken.com");
      expect(plan.creates[0]!.ourSupplierNumber).toBe("LEV-4711");
    });
  });

  const REGISTER_MAPPING = {
    Kundnummer: "customerNumber",
    Namn: "name",
    Betalningsvillkor: "paymentTerm",
    Leveransvillkor: "deliveryTerm",
    Leveranssätt: "carrier",
    Prislista: "priceList",
  };

  it("resolves a register cell by NAME against the existing register", async () => {
    const plan = await planCustomerImport(
      { mapping: REGISTER_MAPPING, rows: [["711", "Kund AB", "30 dagar netto", "", "", ""]] },
      fakeDeps({}, { paymentTerms: { "30 dagar netto": "pt-1" } })
    );
    expect(plan.creates[0]!.paymentTermId).toBe("pt-1");
    expect(plan.creates[0]!).not.toHaveProperty("paymentTermName");
    expect(plan.willCreate.paymentTerms).toEqual([]);
  });

  it("resolves a register cell by CODE against the existing register", async () => {
    const plan = await planCustomerImport(
      { mapping: REGISTER_MAPPING, rows: [["712", "Kund AB", "30", "", "", ""]] },
      fakeDeps({}, { paymentTerms: { "30 dagar netto": "pt-1", "30": "pt-1" } })
    );
    expect(plan.creates[0]!.paymentTermId).toBe("pt-1");
  });

  it("queues a register miss in willCreate and carries the raw name on the plan row", async () => {
    const plan = await planCustomerImport(
      { mapping: REGISTER_MAPPING, rows: [["713", "Kund AB", "Kontant", "", "", ""]] },
      fakeDeps()
    );
    expect(plan.creates[0]!.paymentTermName).toBe("Kontant");
    expect(plan.creates[0]!).not.toHaveProperty("paymentTermId");
    expect(plan.willCreate.paymentTerms).toEqual(["Kontant"]);
  });

  it("dedupes a repeated register miss case-insensitively, keeping the first-seen casing", async () => {
    const plan = await planCustomerImport(
      {
        mapping: REGISTER_MAPPING,
        rows: [
          ["714", "A", "Kontant", "", "", ""],
          ["715", "B", "KONTANT", "", "", ""],
        ],
      },
      fakeDeps()
    );
    expect(plan.willCreate.paymentTerms).toEqual(["Kontant"]);
  });
});

describe("register code generation", () => {
  it("uses the day count as the code for a '<n> dagar ...' payment term name", () => {
    expect(generatePaymentTermCode("30 dagar netto")).toBe("30");
    expect(generatePaymentTermCode("10 Dagar")).toBe("10");
  });

  it("slugifies a day-less payment term the same way as every other register", () => {
    expect(generatePaymentTermCode("Förskott")).toBe("FORSKOTT");
    expect(slugifyRegisterCode("Förskott")).toBe("FORSKOTT");
  });

  it("replaces å/ä with A and ö with O, and squashes the rest to underscores", () => {
    expect(slugifyRegisterCode("Öre & Co.")).toBe("ORE_CO");
  });

  it("caps a long generated code at 20 characters", () => {
    const code = slugifyRegisterCode("Kund bokar själv frakt");
    expect(code.length).toBeLessThanOrEqual(20);
    expect(code).toBe("KUND_BOKAR_SJALV_FRA");
  });

  it("suffixes a code that collides with one generated earlier in the same batch", () => {
    // "DHL!" and "DHL?" both slugify to the base code "DHL".
    const codes = assignRegisterCodes(["DHL!", "DHL?"], slugifyRegisterCode, new Set());
    expect(codes.get("DHL!")).toBe("DHL");
    expect(codes.get("DHL?")).toBe("DHL_2");
  });

  it("suffixes a code that collides with one already in the register", () => {
    const codes = assignRegisterCodes(["Ny Speditör"], slugifyRegisterCode, new Set(["NY_SPEDITOR"]));
    expect(codes.get("Ny Speditör")).toBe("NY_SPEDITOR_2");
  });
});

describe("customer import — repository", () => {
  it("preserves Monitor numbers on import and answers with the commit shape", async () => {
    const plan = await planCustomerImport({ mapping: NUMBER_NAME_MAPPING, rows: [["1234", "Kund AB"]] }, repo);
    const result = await repo.executeCustomerPlan(plan);
    expect(result).toEqual({ created: 1, updated: 0, registersCreated: EMPTY_WILL_CREATE });
    const [row] = await db.select().from(customers).where(eq(customers.customerNumber, "1234"));
    expect(row!.name).toBe("Kund AB");
  });

  it("updates by customer number and leaves unmapped/empty fields untouched", async () => {
    await db.insert(customers).values({
      customerNumber: "42",
      name: "Gammalt Namn",
      phone: "070-111 11 11",
      email: "old@example.com",
    });
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name", "E-post": "email" },
        rows: [["42", "Nytt Namn", ""]],
      },
      repo
    );
    const result = await repo.executeCustomerPlan(plan);
    expect(result.updated).toBe(1);
    const [row] = await db.select().from(customers).where(eq(customers.customerNumber, "42"));
    expect(row!.name).toBe("Nytt Namn");
    expect(row!.phone).toBe("070-111 11 11"); // never mapped — untouched
    expect(row!.email).toBe("old@example.com"); // mapped but empty cell — untouched
  });

  it("keeps existing e-mail when the imported address is invalid on update", async () => {
    await db.insert(customers).values({ customerNumber: "50", name: "Kund", email: "kvar@example.com" });
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", "E-post": "email" }, rows: [["50", "trasig-adress"]] },
      repo
    );
    expect(plan.rows[0]!.warnings).toEqual(["Ogiltig e-postadress 'trasig-adress' — fältet lämnades tomt"]);
    await repo.executeCustomerPlan(plan);
    const [row] = await db.select().from(customers).where(eq(customers.customerNumber, "50"));
    expect(row!.email).toBe("kvar@example.com");
  });

  it("bumps the customer series past the highest numeric imported number", async () => {
    await setCustomerSeries(100);
    const plan = await planCustomerImport(
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
    await repo.executeCustomerPlan(plan);
    expect(await customerSeriesNext()).toBe(251);
  });

  it("never lowers the series", async () => {
    await setCustomerSeries(1000);
    const plan = await planCustomerImport({ mapping: NUMBER_NAME_MAPPING, rows: [["5", "Låg"]] }, repo);
    await repo.executeCustomerPlan(plan);
    expect(await customerSeriesNext()).toBe(1000);
  });

  it("leaves the series untouched when no imported number is numeric", async () => {
    await setCustomerSeries(100);
    const plan = await planCustomerImport({ mapping: NUMBER_NAME_MAPPING, rows: [["K-100", "Kund AB"]] }, repo);
    expect(plan.summary).toEqual({ create: 1, update: 0, skip: 0, error: 0, warning: 0 });
    await repo.executeCustomerPlan(plan);
    expect(await customerSeriesNext()).toBe(100);
  });

  it("writes nothing when any statement in the transaction fails", async () => {
    await setCustomerSeries(100);
    const [existing] = await db
      .insert(customers)
      .values({ customerNumber: "900", name: "Befintlig" })
      .returning();

    // Hand-built plan that bypasses planCustomerImport's length validation:
    // the update's 300-char name violates varchar(255), so the update
    // statement throws — the create and the series bump must both roll back.
    const plan: CustomerImportPlan = {
      rows: [],
      summary: { create: 1, update: 1, skip: 0, error: 0, warning: 0 },
      willCreate: EMPTY_WILL_CREATE,
      creates: [{ customerNumber: "901", name: "Ny Kund" }],
      updates: [{ id: existing!.id, patch: { name: "x".repeat(300) } }],
      maxNumericNumber: 901,
      hasErrors: false,
    };

    await expect(repo.executeCustomerPlan(plan)).rejects.toThrow();

    const rows = await db.select().from(customers);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Befintlig");
    expect(await customerSeriesNext()).toBe(100);
  });

  it("creates the four missing registers before the customers that reference them, and reports them", async () => {
    const plan = await planCustomerImport(
      {
        mapping: {
          Kundnummer: "customerNumber",
          Namn: "name",
          Betalningsvillkor: "paymentTerm",
          Leveransvillkor: "deliveryTerm",
          Leveranssätt: "carrier",
          Prislista: "priceList",
        },
        rows: [["950", "Kund AB", "30 dagar netto", "DAP", "Kund bokar själv frakt", "Standard"]],
      },
      repo
    );
    expect(plan.willCreate).toEqual({
      units: [],
      articleGroups: [],
      paymentTerms: ["30 dagar netto"],
      deliveryTerms: ["DAP"],
      carriers: ["Kund bokar själv frakt"],
      priceLists: ["Standard"],
    });

    const result = await repo.executeCustomerPlan(plan);
    expect(result.registersCreated).toEqual({
      units: [],
      articleGroups: [],
      paymentTerms: ["30 dagar netto"],
      deliveryTerms: ["DAP"],
      carriers: ["Kund bokar själv frakt"],
      priceLists: ["Standard"],
    });

    const [pt] = await db.select().from(paymentTerms).where(eq(paymentTerms.name, "30 dagar netto"));
    expect(pt!.code).toBe("30"); // "<n> dagar" -> the day count is the code

    const [dt] = await db.select().from(deliveryTerms).where(eq(deliveryTerms.name, "DAP"));
    expect(dt!.code).toBe("DAP");

    const [carrier] = await db.select().from(carriers).where(eq(carriers.name, "Kund bokar själv frakt"));
    expect(carrier!.code.length).toBeLessThanOrEqual(20);

    const [priceList] = await db.select().from(priceLists).where(eq(priceLists.name, "Standard"));
    expect(priceList!.code).toBe("STANDARD");

    const [customer] = await db.select().from(customers).where(eq(customers.customerNumber, "950"));
    expect(customer!.paymentTermId).toBe(pt!.id);
    expect(customer!.deliveryTermId).toBe(dt!.id);
    expect(customer!.carrierId).toBe(carrier!.id);
    expect(customer!.priceListId).toBe(priceList!.id);
  });

  it("resolves against a register the SAME import just created, on a later row in the same file", async () => {
    const plan = await planCustomerImport(
      {
        mapping: { Kundnummer: "customerNumber", Namn: "name", Betalningsvillkor: "paymentTerm" },
        rows: [
          ["951", "Kund A", "Kontant"],
          ["952", "Kund B", "Kontant"],
        ],
      },
      repo
    );
    expect(plan.willCreate.paymentTerms).toEqual(["Kontant"]); // deduped, not two creates
    await repo.executeCustomerPlan(plan);

    const rows = await db.select().from(paymentTerms).where(eq(paymentTerms.name, "Kontant"));
    expect(rows).toHaveLength(1); // created once, not twice
  });

  it("re-importing the same file a second time finds the register instead of recreating it", async () => {
    const mapping = { Kundnummer: "customerNumber", Namn: "name", Betalningsvillkor: "paymentTerm" };
    const first = await planCustomerImport(
      { mapping, rows: [["953", "Kund A", "Kontant"]] },
      repo
    );
    await repo.executeCustomerPlan(first);

    const second = await planCustomerImport(
      { mapping, rows: [["954", "Kund B", "Kontant"]] },
      repo
    );
    expect(second.willCreate.paymentTerms).toEqual([]);
    expect(second.creates[0]!.paymentTermId).toBeDefined();

    const rows = await db.select().from(paymentTerms).where(eq(paymentTerms.name, "Kontant"));
    expect(rows).toHaveLength(1);
  });

  it("rolls back register creation too when a later statement in the same transaction fails", async () => {
    // Hand-built plan (bypasses planCustomerImport's own validation, same
    // trick as the "writes nothing" test above): the create's 300-char name
    // violates varchar(255), so the customer insert throws AFTER the
    // register step has already run inside the same transaction.
    const plan: CustomerImportPlan = {
      rows: [],
      summary: { create: 1, update: 0, skip: 0, error: 0, warning: 0 },
      willCreate: { ...EMPTY_WILL_CREATE, paymentTerms: ["30 dagar netto"] },
      creates: [
        {
          customerNumber: "955",
          name: "x".repeat(300),
          paymentTermName: "30 dagar netto",
        } as CustomerImportPlan["creates"][number],
      ],
      updates: [],
      maxNumericNumber: null,
      hasErrors: false,
    };

    await expect(repo.executeCustomerPlan(plan)).rejects.toThrow();

    const rows = await db.select().from(paymentTerms).where(eq(paymentTerms.name, "30 dagar netto"));
    expect(rows).toHaveLength(0); // the register row rolled back along with the customer insert
  });

  it("self-heals a same-name-different-code race instead of erroring (name is indexed, not just code)", async () => {
    // Simulates the TOCTOU the article import's resolveNewUnitId guards
    // against: the register already carries this exact NAME under a
    // different code by the time the transaction runs (a concurrent import,
    // here just inserted directly) — this planner's own lookup indexes by
    // name too, so the miss self-heals to the existing row instead of
    // erroring; the assertion below documents that self-heal.
    await db.insert(paymentTerms).values({ code: "OLDCODE", name: "Kontant" });
    const plan = await planCustomerImport(
      { mapping: { Kundnummer: "customerNumber", Namn: "name", Betalningsvillkor: "paymentTerm" }, rows: [["956", "Kund AB", "Kontant"]] },
      fakeDeps() // fakeDeps' lookup does NOT know about the row just inserted above
    );
    expect(plan.willCreate.paymentTerms).toEqual(["Kontant"]);

    const result = await repo.executeCustomerPlan(plan);
    expect(result.registersCreated.paymentTerms).toEqual([]); // nothing new created — resolved to the existing row

    const [customer] = await db.select().from(customers).where(eq(customers.customerNumber, "956"));
    const [existing] = await db.select().from(paymentTerms).where(eq(paymentTerms.name, "Kontant"));
    expect(customer!.paymentTermId).toBe(existing!.id);
  });
});

describe("import service — customers entity", () => {
  it("accepts customers in the entity enum", () => {
    expect(importEntitySchema.options).toContain("customers");
  });

  it("suggests the customer mapping through parse", async () => {
    const result = await importService.parse(
      "customers",
      Buffer.from("Kundnummer;Namn;Okänd kolumn\n100;Kund AB;x\n")
    );
    expect(result.suggestedMapping).toEqual({
      Kundnummer: "customerNumber",
      Namn: "name",
      "Okänd kolumn": null,
    });
  });

  it("commits a customer import end-to-end", async () => {
    const result = await importService.commit("customers", {
      mapping: { Kundnummer: "customerNumber", Namn: "name" },
      rows: [["1001", "Kund AB"]],
    });
    expect(result).toEqual({
      created: 1,
      updated: 0,
      skipped: 0,
      skippedRows: [],
      registersCreated: EMPTY_WILL_CREATE,
    });
  });

  it("skips existing records and lists them in the response", async () => {
    await importService.commit("customers", {
      mapping: { Kundnummer: "customerNumber", Namn: "name" },
      rows: [["3001", "Före"]],
    });

    const result = await importService.commit("customers", {
      mapping: { Kundnummer: "customerNumber", Namn: "name" },
      rows: [
        ["3001", "Efter"],
        ["3002", "Kund AB"],
      ],
      skipExisting: true,
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedRows).toEqual([
      {
        rowNumber: 2,
        reason: "Kunden 3001 finns redan i registret",
        values: { customerNumber: "3001", name: "Efter" },
      },
    ]);

    const rows = await db.select().from(customers);
    expect(rows.find((row) => row.customerNumber === "3001")!.name).toBe("Före");
  });

  it("aborts the whole commit on any row error with the preview payload (nothing written)", async () => {
    await expect(
      importService.commit("customers", {
        mapping: { Kundnummer: "customerNumber", Namn: "name" },
        rows: [
          ["2001", "Frisk rad"],
          ["", "Trasig rad"],
        ],
      })
    ).rejects.toBeInstanceOf(ImportValidationError);
    const rows = await db.select().from(customers);
    expect(rows).toHaveLength(0); // nothing written
  });

  // End-to-end with the real Monitor G5 headings, via the .xlsx path
  // (buildXlsxBuffer/helpers/xlsx-fixture.ts) — exercises suggestMapping's
  // alias priority (Namn vs Postadress – Namn), the address merge and the
  // country normalization together, through the same parse/commit path the
  // wizard uses.
  it("imports the Postadress export's Monitor headings end-to-end", async () => {
    const buf = buildXlsxBuffer([
      {
        name: "Blad1",
        rows: [
          [
            "Kund",
            "Namn",
            "Postadress – Namn",
            "Adressrad 1",
            "Adressrad 2",
            "Adressrad 3",
            "Postnummer",
            "Stad",
            "Land",
          ],
          ["1001", "Kort namn", "Kund AB (juridiskt)", "Storgatan 1", "Box 2", "", "12345", "Stockholm", "se"],
        ],
      },
    ]);

    const parsed = await importService.parse("customers", buf);
    expect(parsed.suggestedMapping["Namn"]).toBeNull();
    expect(parsed.suggestedMapping["Postadress – Namn"]).toBe("name");

    const result = await importService.commit("customers", { mapping: parsed.suggestedMapping, rows: parsed.rows });
    expect(result.created).toBe(1);

    const [row] = await db.select().from(customers).where(eq(customers.customerNumber, "1001"));
    expect(row!.name).toBe("Kund AB (juridiskt)");
    expect(row!.address).toBe("Storgatan 1\nBox 2");
    expect(row!.postalCode).toBe("12345");
    expect(row!.city).toBe("Stockholm");
    expect(row!.country).toBe("SE");
  });

  // The documented run order, through the same parse/commit path the wizard
  // uses: Lista CREATES the customer with the short name + org/VAT numbers,
  // Postadress replaces the short name with the legal one and fills the
  // address, Fakturaadress leaves the name alone. Org/VAT numbers survive
  // both later runs because neither file carries those columns (and empty
  // cells never overwrite anyway).
  it("imports Lista, then Postadress, then Fakturaadress in the documented order", async () => {
    const lista = buildXlsxBuffer([
      {
        name: "Blad1",
        rows: [
          ["Kund", "Namn", "Prioritet", "Kundgrupp", "Momsreg.nr", "Personnummer", "Organisationsnr", "Kreditlimit", "Privatperson"],
          ["1001", "Kort namn", 9, "Sverige", "SE556677889901", "", "556677-8899", 100000, false],
          ["1002", "Privat kund", 9, "Sverige", "", "121212-1212", "", 0, true],
        ],
      },
    ]);
    const parsedLista = await importService.parse("customers", lista);
    expect(parsedLista.suggestedMapping["Namn"]).toBe("name");
    expect(parsedLista.suggestedMapping["Organisationsnr"]).toBe("orgNumber");
    expect(parsedLista.suggestedMapping["Momsreg.nr"]).toBe("vatNumber");
    expect(parsedLista.suggestedMapping["Personnummer"]).toBeNull();
    const listaResult = await importService.commit("customers", {
      mapping: parsedLista.suggestedMapping,
      rows: parsedLista.rows,
    });
    expect(listaResult).toMatchObject({ created: 2, updated: 0 });

    const postadress = buildXlsxBuffer([
      {
        name: "Blad1",
        rows: [
          ["Kund", "Namn", "Postadress – Adressformat", "Postadress – Namn", "Postadress – Adressrad 1",
           "Postadress – Adressrad 2", "Postadress – Adressrad 3", "Postadress – Adressrad 4",
           "Postadress – Postnummer", "Postadress – Stad", "Postadress – Region", "Postadress – Land"],
          ["1001", "Kort namn", "Postnummer + Stad", "Kund AB (juridiskt)", "Storgatan 1", "Box 2", "", "", "12345", "Stockholm", "", "SE"],
          ["1002", "Privat kund", "Postnummer + Stad", "Anna Andersson", "Lillgatan 3", "", "", "", "54321", "Göteborg", "", "SE"],
        ],
      },
    ]);
    const parsedPost = await importService.parse("customers", postadress);
    expect(parsedPost.suggestedMapping["Namn"]).toBeNull();
    expect(parsedPost.suggestedMapping["Postadress – Namn"]).toBe("name");
    const postResult = await importService.commit("customers", {
      mapping: parsedPost.suggestedMapping,
      rows: parsedPost.rows,
    });
    expect(postResult).toMatchObject({ created: 0, updated: 2 });

    const faktura = buildXlsxBuffer([
      {
        name: "Blad1",
        rows: [
          ["Kund", "Namn", "Avviker från postadress", "Fakturaadress – Namn", "Fakturaadress – Adressrad 1",
           "Fakturaadress – Postnummer", "Fakturaadress – Stad", "Fakturaadress – Land"],
          ["1001", "Kort namn", true, "Kund AB Ekonomi", "Box 99", "11111", "Solna", "SE"],
          ["1002", "Privat kund", false, "Anna Andersson", "Lillgatan 3", "54321", "Göteborg", "SE"],
        ],
      },
    ]);
    const parsedFakt = await importService.parse("customers", faktura);
    expect(parsedFakt.suggestedMapping["Namn"]).toBeNull();
    await importService.commit("customers", { mapping: parsedFakt.suggestedMapping, rows: parsedFakt.rows });

    const [ab] = await db.select().from(customers).where(eq(customers.customerNumber, "1001"));
    expect(ab!.name).toBe("Kund AB (juridiskt)"); // legal name replaced the Lista short name
    expect(ab!.orgNumber).toBe("556677-8899"); // survived both later runs
    expect(ab!.vatNumber).toBe("SE556677889901");
    expect(ab!.address).toBe("Storgatan 1\nBox 2");
    expect(ab!.country).toBe("SE");
    expect(ab!.invoiceName).toBe("Kund AB Ekonomi");
    expect(ab!.invoiceAddress).toBe("Box 99");

    const [privat] = await db.select().from(customers).where(eq(customers.customerNumber, "1002"));
    expect(privat!.name).toBe("Anna Andersson");
    expect(privat!.orgNumber).toBeNull(); // Personnummer is not mapped in v1
    expect(privat!.invoiceName).toBeNull(); // "Avviker från postadress" = false drops the invoice block
  });
});
