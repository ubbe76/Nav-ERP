import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { importRoutes } from "../src/modules/import/routes/import.routes.js";
import {
  ImportMappingError,
  isUnorderedHeaderKey,
  resolveColumns,
  uniqueHeaders,
  type ImportService,
} from "../src/modules/import/service/import.service.js";
import { generatePaymentTermCode } from "../src/modules/import/service/customers.js";
import { detectImportEntity } from "../src/modules/import/service/detect.js";
import {
  Utf16ImportFileError,
  XlsxTooLargeError,
  parseCsvBuffer,
  parseRecords,
  stripControlCharacters,
} from "../src/modules/import/service/csv.js";
import { decodeOoxmlText, parseXlsxBuffer, zipUnpackedBytes } from "../src/modules/import/service/xlsx.js";
import {
  planCustomerDeliveryAddressImport,
  type CustomerDeliveryAddressImportDeps,
} from "../src/modules/import/service/customer-delivery-addresses.js";
import { suggestSupplierContactMapping } from "../src/modules/import/service/supplier-contacts.js";
import { suggestSupplierDeliveryAddressMapping } from "../src/modules/import/service/supplier-delivery-addresses.js";
import { multipartFile } from "./helpers/banking.js";
import { parseBankStatementCsv } from "../src/modules/banking/service/bank-statement-csv.js";
import { BankStatementCsvMappingError } from "../src/modules/banking/service/banking.errors.js";

// Importgranskningen, kunder/leverantörer och infrastrukturen: the column
// mapping, payment term codes, the detection of a trimmed contact template,
// CSV/XLSX reading, the delivery address's country, the supplier number
// alias and the oversized upload. Pure — no database.

describe("the column mapping keeps the file's column order", () => {
  it("renames a header JavaScript would enumerate first, so the mapping's key order is the column order", () => {
    const headers = uniqueHeaders(["Kundnummer", "Namn", "2025"]);
    expect(headers).toEqual(["Kundnummer", "Namn", "2025 (kolumn 3)"]);
    const mapping: Record<string, string | null> = {};
    for (const header of headers) mapping[header] = header === "Kundnummer" ? "customerNumber" : header === "Namn" ? "name" : null;
    // Column 0 is the customer number, column 1 the name — before, "2025"
    // came first and every column shifted one step.
    expect(resolveColumns(mapping, ["customerNumber", "name"], ["customerNumber"])).toEqual(["customerNumber", "name", null]);
  });

  it("refuses a mapping keyed by an integer header from a direct API caller", () => {
    expect(isUnorderedHeaderKey("2025")).toBe(true);
    expect(isUnorderedHeaderKey("0")).toBe(true);
    expect(isUnorderedHeaderKey("007")).toBe(false);
    expect(isUnorderedHeaderKey("2025 (kolumn 3)")).toBe(false);
    expect(() => resolveColumns({ Kundnummer: "customerNumber", "2025": null }, ["customerNumber"], ["customerNumber"])).toThrow(
      ImportMappingError
    );
  });

  it("never gives a repeated header a name the file already has", () => {
    expect(uniqueHeaders(["Namn", "Namn (2)", "Namn"])).toEqual(["Namn", "Namn (2)", "Namn (3)"]);
    expect(uniqueHeaders(["Namn", "Namn", "Namn (2)"])).toEqual(["Namn", "Namn (3)", "Namn (2)"]);
    // The common case is unchanged.
    expect(uniqueHeaders(["Pris", "Pris"])).toEqual(["Pris", "Pris (2)"]);
  });
});

describe("generatePaymentTermCode", () => {
  it("gives the day count only to a term that is one, and never a code with misleading leading digits", () => {
    expect(generatePaymentTermCode("30 dagar netto")).toBe("30");
    expect(generatePaymentTermCode("30 dagar efter fakturadatum")).toBe("30");
    expect(generatePaymentTermCode("Förskott")).toBe("FORSKOTT");
    // dueDateFromTerm reads leading digits: these were 1, 2 and 10 days.
    for (const name of ["1 månad netto", "2% 10 dagar, 30 dagar netto", "10 dagar 2%, 30 dagar netto"]) {
      const code = generatePaymentTermCode(name);
      expect([name, /^\d/.test(code)]).toEqual([name, false]);
      expect(code.length).toBeLessThanOrEqual(20);
    }
    expect(generatePaymentTermCode("1 månad netto")).toBe("V_1_MANAD_NETTO");
  });
});

describe("detection of a trimmed contact template", () => {
  it("reads the contact template without Mobiltelefon and Faxnummer as contacts, not as customers", () => {
    expect(detectImportEntity(["Kundnummer", "Kontaktperson", "Förvald", "Telefon", "E-post", "Anmärkning"])).toBe("customerContacts");
    expect(detectImportEntity(["Kundnummer", "Kontaktperson", "Telefon", "E-post", "Anmärkning"])).toBe("customerContacts");
    expect(detectImportEntity(["Kundnummer", "Kontaktperson", "Förvald", "Telefon"])).toBe("customerContacts");
    expect(detectImportEntity(["Leverantörsnummer", "Kontaktperson", "Förvald", "Telefon", "E-post"])).toBe("supplierContacts");
  });

  it("still reads Alternativa leveransadresser (Förvald + Adressrad 1) and the customer template as before", () => {
    expect(detectImportEntity(["Kundnummer", "Namn", "Adressrad 1", "Postnummer", "Förvald"])).toBe("customerDeliveryAddresses");
    expect(detectImportEntity(["Kundnummer", "Namn", "Adressrad 1", "Postnummer", "Postort"])).toBe("customers");
  });
});

describe("CSV reading", () => {
  it("drops rows of nothing but delimiters, as Excel writes for formatted empty rows", () => {
    const parsed = parseCsvBuffer(Buffer.from("Kundnummer;Namn;Ort\n1001;Kund AB;Småstad\n;;\n;;\n", "utf-8"));
    expect(parsed.rows).toEqual([["1001", "Kund AB", "Småstad"]]);
  });

  it("reads a quote inside an unquoted field as a character, not the start of a quoted field", () => {
    expect(parseRecords('Nr;Namn;Ort\n1001;Rör 2" AB;Småstad\n1002;Kund;Ort\n', ";")).toEqual([
      ["Nr", "Namn", "Ort"],
      ["1001", 'Rör 2" AB', "Småstad"],
      ["1002", "Kund", "Ort"],
    ]);
    // A quoted field is still one field, separators and all.
    expect(parseRecords('Nr;Namn\n1001;"Kund; AB"\n', ";")).toEqual([
      ["Nr", "Namn"],
      ["1001", "Kund; AB"],
    ]);
  });

  it("strips NUL and other control characters Postgres text refuses, and refuses a UTF-16 file", () => {
    expect(parseCsvBuffer(Buffer.from("Nr;Namn\n1001;Kund\u0000 AB\n", "utf-8")).rows).toEqual([["1001", "Kund AB"]]);
    expect(stripControlCharacters(decodeOoxmlText("rad 1_x0000_\trad_x000d_\n2"))).toBe("rad 1\trad\n2");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Nr;Namn\n1001;Kund\n", "utf16le")]);
    expect(() => parseCsvBuffer(utf16)).toThrow(Utf16ImportFileError);
    // The bank statement reader shares the decoder and answers with its own 400.
    expect(() =>
      parseBankStatementCsv(utf16, { dateColumn: "Bokföringsdag", amountColumn: "Belopp", textColumn: "Text" }, "X", "SEK")
    ).toThrow(BankStatementCsvMappingError);
  });
});

describe("XLSX size guard", () => {
  const template = readFileSync(new URL("../../web/public/importmallar/importmall-kunder.xlsx", import.meta.url));

  it("reads the unpacked size from the zip directory and accepts an ordinary workbook", async () => {
    const size = zipUnpackedBytes(template);
    expect(size).toBeGreaterThan(0);
    expect(size!).toBeLessThan(10 * 1024 * 1024);
    expect((await parseXlsxBuffer(template)).headers[0]).toBe("Kundnummer");
  });

  it("refuses a workbook whose parts claim to unpack to more than the limit, before unpacking it", async () => {
    // Patch the first central-directory entry's uncompressed size to 4 GB − 2.
    const bomb = Buffer.from(template);
    let eocd = bomb.length - 22;
    while (bomb.readUInt32LE(eocd) !== 0x06054b50) eocd--;
    const central = bomb.readUInt32LE(eocd + 16);
    bomb.writeUInt32LE(0xfffffffe, central + 24);
    await expect(parseXlsxBuffer(bomb)).rejects.toBeInstanceOf(XlsxTooLargeError);
  });
});

describe("delivery address country", () => {
  const deps = (country: string): CustomerDeliveryAddressImportDeps => ({
    async customerAddressesByNumber(numbers) {
      return new Map(
        numbers.includes("1001")
          ? [["1001", { id: "11111111-1111-1111-1111-111111111111", address: "Hauptstraße 1", postalCode: "10115", city: "Berlin", country }]]
          : []
      );
    },
    async deliveryAddressesByCustomer() {
      return new Map();
    },
  });
  const mapping = { Kund: "customerNumber", "Adressrad 1": "address", Postnummer: "postalCode", Stad: "city" };

  it("takes the customer's own country when Land is empty", async () => {
    const plan = await planCustomerDeliveryAddressImport({ mapping, rows: [["1001", "Lagerweg 5", "20095", "Hamburg"]] }, deps("DE"));
    expect(plan.creates[0]!.country).toBe("DE");
    // The customer's own address is recognised again (it never matched with SE).
    const own = await planCustomerDeliveryAddressImport({ mapping, rows: [["1001", "Hauptstraße 1", "10115", "Berlin"]] }, deps("DE"));
    expect(own.creates).toHaveLength(0);
  });
});

describe("supplier contact and address files map Leverantörsnr", () => {
  it("maps the heading the detector keys on", () => {
    expect(suggestSupplierContactMapping(["Leverantörsnr", "Kontaktperson", "Mobiltelefon"])["Leverantörsnr"]).toBe("supplierNumber");
    expect(suggestSupplierDeliveryAddressMapping(["Leverantörsnr", "Adressnamn", "Adressrad 1"])["Leverantörsnr"]).toBe("supplierNumber");
  });
});

describe("an upload over the size limit", () => {
  it("answers the Swedish 400, not the multipart library's English 413", async () => {
    const app = Fastify();
    // A 1 KB limit stands in for the 20 MB one (app.ts).
    app.register(fastifyMultipart, { limits: { fileSize: 1024 } });
    app.addHook("preHandler", async (req) => {
      req.user = { id: crypto.randomUUID(), role: "admin" } as never;
    });
    app.register(importRoutes, { service: {} as ImportService });
    const big = "Kundnummer;Namn\n" + "1001;Kund AB\n".repeat(200);
    for (const url of ["/imports/detect", "/imports/customers/parse"]) {
      const res = await app.inject({ method: "POST", url, ...multipartFile("kunder.csv", big) });
      expect([url, res.statusCode, res.json().error]).toEqual([url, 400, "Filen är för stor — max 20 MB"]);
    }
    await app.close();
  });
});
