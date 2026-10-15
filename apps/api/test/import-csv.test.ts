import { describe, expect, it } from "vitest";
import { importCommitSchema, importEntitySchema } from "@navet/shared";
import {
  CsvRowLimitError,
  EmptyCsvError,
  normalizeDecimal,
  parseCsvBuffer,
} from "../src/modules/import/service/csv.js";
import {
  collectSkipped,
  skippedRow,
  summarize,
  type ImportRowResult,
} from "../src/modules/import/service/import.service.js";

// Schema tests for the shared import contracts. The parser tests (Task 2)
// live in this file too — everything here is pure, no database writes.

describe("import schemas", () => {
  it("accepts the implemented entities and rejects unknown ones", () => {
    expect(importEntitySchema.parse("articles")).toBe("articles");
    expect(importEntitySchema.parse("customers")).toBe("customers");
    expect(importEntitySchema.parse("suppliers")).toBe("suppliers");
    // Anything else is unknown and the routes answer 404.
    expect(importEntitySchema.safeParse("employees").success).toBe(false);
  });

  it("caps commit rows at 10 000 and allows null mapping targets", () => {
    const ok = importCommitSchema.parse({
      mapping: { Artikelnummer: "articleNumber", Extra: null },
      rows: [["A-1", "x"]],
    });
    expect(ok.mapping["Extra"]).toBeNull();

    const tooMany = importCommitSchema.safeParse({
      mapping: { Artikelnummer: "articleNumber" },
      rows: Array.from({ length: 10001 }, () => [""]),
    });
    expect(tooMany.success).toBe(false);
  });

  it("accepts an optional articleType default", () => {
    const parsed = importCommitSchema.parse({
      mapping: {},
      rows: [],
      defaults: { articleType: "purchased" },
    });
    expect(parsed.defaults?.articleType).toBe("purchased");
  });

  it("accepts an optional skipExisting flag and defaults it to undefined", () => {
    expect(importCommitSchema.parse({ mapping: {}, rows: [], skipExisting: true }).skipExisting).toBe(true);
    // Omitted means today's behaviour — the flag is purely additive, so the
    // external configurator's existing payloads keep working unchanged.
    expect(importCommitSchema.parse({ mapping: {}, rows: [] }).skipExisting).toBeUndefined();
    expect(importCommitSchema.safeParse({ mapping: {}, rows: [], skipExisting: "ja" }).success).toBe(false);
  });
});

describe("summarize / skipped rows", () => {
  function row(overrides: Partial<ImportRowResult>): ImportRowResult {
    return { rowNumber: 2, action: "create", errors: [], warnings: [], values: {}, ...overrides };
  }

  it("counts skipped rows in their own bucket, not as updates", () => {
    const summary = summarize([
      row({ rowNumber: 2 }),
      row({ rowNumber: 3, action: "update" }),
      row({ rowNumber: 4, action: "skip", skipReason: "finns redan" }),
      row({ rowNumber: 5, action: "skip", skipReason: "finns redan" }),
      row({ rowNumber: 6, errors: ["trasig"] }),
      row({ rowNumber: 7, warnings: ["se upp"] }),
    ]);
    expect(summary).toEqual({ create: 2, update: 1, skip: 2, error: 1, warning: 1 });
  });

  it("counts an errored row as an error even when its action is skip", () => {
    // A skipped row never carries errors today, but the error bucket must
    // stay the one that decides whether the commit is blocked.
    const summary = summarize([row({ action: "skip", errors: ["trasig"] })]);
    expect(summary).toEqual({ create: 0, update: 0, skip: 0, error: 1, warning: 0 });
  });

  it("collects the skipped rows in file order with their reason and cells", () => {
    const rows = [
      row({ rowNumber: 2 }),
      skippedRow(3, "Artikeln A-1 finns redan i artikelregistret", { articleNumber: "A-1", name: "Bänk" }),
      row({ rowNumber: 4, action: "update" }),
      skippedRow(5, "Artikeln A-2 finns redan i artikelregistret", { articleNumber: "A-2", name: "Lock" }),
    ];
    expect(collectSkipped(rows)).toEqual([
      { rowNumber: 3, reason: "Artikeln A-1 finns redan i artikelregistret", values: { articleNumber: "A-1", name: "Bänk" } },
      { rowNumber: 5, reason: "Artikeln A-2 finns redan i artikelregistret", values: { articleNumber: "A-2", name: "Lock" } },
    ]);
  });
});

describe("parseCsvBuffer — delimiter, quoting, encoding", () => {
  it("detects semicolon, comma and tab delimiters", () => {
    expect(parseCsvBuffer(Buffer.from("a;b;c\n1;2;3\n")).delimiter).toBe(";");
    expect(parseCsvBuffer(Buffer.from("a,b,c\n1,2,3\n")).delimiter).toBe(",");
    expect(parseCsvBuffer(Buffer.from("a\tb\tc\n1\t2\t3\n")).delimiter).toBe("\t");
  });

  it("ignores delimiters inside quoted fields when detecting", () => {
    // Line 1 has two commas but both sit inside quotes — the single
    // semicolon outside quotes wins.
    const parsed = parseCsvBuffer(Buffer.from('"a,b";"c,d"\n1;2\n'));
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["a,b", "c,d"]);
  });

  it("breaks ties in the order ; , tab", () => {
    // One of each on the header line -> semicolon wins the tie.
    const parsed = parseCsvBuffer(Buffer.from("a;b,c\td\n1;2,3\t4\n"));
    expect(parsed.delimiter).toBe(";");
  });

  it("unescapes doubled quotes and keeps quoted delimiters and newlines", () => {
    const csv = 'Artikelnummer;Benämning\nA-1;"Vinkel ""90"";\nmed radbrytning"\n';
    const parsed = parseCsvBuffer(Buffer.from(csv));
    expect(parsed.headers).toEqual(["Artikelnummer", "Benämning"]);
    expect(parsed.rows).toEqual([["A-1", 'Vinkel "90";\nmed radbrytning']]);
  });

  it("handles CRLF and ignores a trailing empty line", () => {
    const parsed = parseCsvBuffer(Buffer.from("a;b\r\n1;2\r\n\r\n"));
    expect(parsed.headers).toEqual(["a", "b"]);
    expect(parsed.rows).toEqual([["1", "2"]]);
  });

  it("strips a UTF-8 BOM and reports utf-8", () => {
    const parsed = parseCsvBuffer(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("Artikelnummer;Benämning\nA-1;Vinkel\n"),
      ])
    );
    expect(parsed.encoding).toBe("utf-8");
    expect(parsed.headers[0]).toBe("Artikelnummer");
    expect(parsed.headers[1]).toBe("Benämning");
  });

  it("falls back to windows-1252 when the bytes are not valid UTF-8", () => {
    // "Benämning" with a raw 0xE4 for ä — invalid as UTF-8.
    const bytes = Buffer.concat([
      Buffer.from("Ben", "ascii"),
      Buffer.from([0xe4]),
      Buffer.from("mning;Enhet\nVinkel;st\n", "ascii"),
    ]);
    const parsed = parseCsvBuffer(bytes);
    expect(parsed.encoding).toBe("windows-1252");
    expect(parsed.headers).toEqual(["Benämning", "Enhet"]);
    expect(parsed.rows).toEqual([["Vinkel", "st"]]);
  });

  // The shape the real Monitor G5 export actually has — BOM, comma
  // delimiter and Swedish decimals quoted so the decimal comma does not
  // split the field. Each piece is covered above; this locks the combination.
  it("parses the real export shape: BOM + comma delimiter + quoted Swedish decimals", () => {
    const parsed = parseCsvBuffer(
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          'Artikelnummer,Artikelbenämning,Standardpris\r\nRU2000,Belysningsmast Sky7,"16617,44"\r\n'
        ),
      ])
    );
    expect(parsed).toMatchObject({ delimiter: ",", encoding: "utf-8" });
    expect(parsed.headers).toEqual(["Artikelnummer", "Artikelbenämning", "Standardpris"]);
    expect(parsed.rows).toEqual([["RU2000", "Belysningsmast Sky7", "16617,44"]]);
    expect(normalizeDecimal(parsed.rows[0]![2]!)).toBe(16617.44);
  });

  it("throws CsvRowLimitError above 10 000 data rows", () => {
    const body = Array.from({ length: 10001 }, (_, i) => `A-${i}`).join("\n");
    expect(() => parseCsvBuffer(Buffer.from(`Artikelnummer\n${body}\n`))).toThrow(CsvRowLimitError);
  });

  it("throws EmptyCsvError on an empty buffer", () => {
    expect(() => parseCsvBuffer(Buffer.from(""))).toThrow(EmptyCsvError);
  });
});

describe("normalizeDecimal", () => {
  it("parses Swedish decimals with thousands separators", () => {
    expect(normalizeDecimal("1 234,56")).toBe(1234.56);
    expect(normalizeDecimal("1 234,56")).toBe(1234.56); // non-breaking space U+00A0
    expect(normalizeDecimal("1.234,56")).toBe(1234.56);
    expect(normalizeDecimal("1234,5")).toBe(1234.5);
  });

  it("accepts plain dot decimals and integers", () => {
    expect(normalizeDecimal("12.5")).toBe(12.5);
    expect(normalizeDecimal("1234")).toBe(1234);
  });

  it("returns null for empty and garbage input", () => {
    expect(normalizeDecimal("")).toBeNull();
    expect(normalizeDecimal("   ")).toBeNull();
    expect(normalizeDecimal("abc")).toBeNull();
    expect(normalizeDecimal("1,2,3")).toBeNull();
  });
});
