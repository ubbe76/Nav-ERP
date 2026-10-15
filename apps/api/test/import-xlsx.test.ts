import { describe, expect, it } from "vitest";
import {
  CsvRowLimitError,
  EmptyCsvError,
  LegacyExcelFileError,
  UnreadableImportFileError,
  normalizeDecimal,
} from "../src/modules/import/service/csv.js";
import { parseXlsxBuffer } from "../src/modules/import/service/xlsx.js";
import { parseImportFile } from "../src/modules/import/service/parse-file.js";
import { buildXlsxBuffer } from "./helpers/xlsx-fixture.js";

// Guards the fixture builder itself before anything relies on it: if the
// hand-assembled workbook were rejected by read-excel-file, every other test
// in this file would fail for the wrong reason.
describe("buildXlsxBuffer — the fixture is a workbook read-excel-file accepts", () => {
  it("round-trips headers and rows", async () => {
    const buf = buildXlsxBuffer([
      { name: "Blad1", rows: [["Artikelnummer", "Antal"], ["ART-1", 2]] },
    ]);
    expect(buf.subarray(0, 4).toString("hex")).toBe("504b0304");

    const parsed = await parseXlsxBuffer(buf);
    expect(parsed.headers).toEqual(["Artikelnummer", "Antal"]);
    expect(parsed.rows).toEqual([["ART-1", "2"]]);
  });
});

describe("parseXlsxBuffer", () => {
  it("stringifies every cell type the reader can produce", async () => {
    const buf = buildXlsxBuffer([
      {
        name: "Blad1",
        rows: [
          ["Text", "Tal", "Heltal", "Boolean", "Datum", "Tom"],
          ["ART-1", 2.5, 10, true, new Date(Date.UTC(2026, 0, 15)), null],
          ["ART-2", 0.5, 7, false, null, "x"],
        ],
      },
    ]);

    const parsed = await parseXlsxBuffer(buf);
    expect(parsed.rows[0]).toEqual(["ART-1", "2.5", "10", "true", "2026-01-15", ""]);
    expect(parsed.rows[1]).toEqual(["ART-2", "0.5", "7", "false", "", "x"]);
    // The whole point of String(number): normalizeDecimal must still parse it.
    expect(normalizeDecimal(parsed.rows[0]![1]!)).toBe(2.5);
  });

  it("trims headers and drops fully empty rows", async () => {
    const buf = buildXlsxBuffer([
      {
        name: "Blad1",
        rows: [["  Artikelnummer  ", " Antal "], ["ART-1", 1], [null, null], ["ART-2", 2]],
      },
    ]);

    const parsed = await parseXlsxBuffer(buf);
    expect(parsed.headers).toEqual(["Artikelnummer", "Antal"]);
    expect(parsed.rows).toEqual([
      ["ART-1", "1"],
      ["ART-2", "2"],
    ]);
  });

  it("reads only the first sheet but reports how many there are", async () => {
    const buf = buildXlsxBuffer([
      { name: "Struktur", rows: [["Artikelnummer"], ["ART-1"]] },
      { name: "Blad2", rows: [["Något annat"], ["ignoreras"]] },
    ]);

    const parsed = await parseXlsxBuffer(buf);
    expect(parsed.sheetName).toBe("Struktur");
    expect(parsed.sheetCount).toBe(2);
    expect(parsed.rows).toEqual([["ART-1"]]);
  });

  it("rejects an empty workbook and one past the row limit", async () => {
    await expect(parseXlsxBuffer(buildXlsxBuffer([{ name: "Blad1", rows: [] }]))).rejects.toBeInstanceOf(
      EmptyCsvError
    );

    const tooMany = buildXlsxBuffer([
      {
        name: "Blad1",
        rows: [["Artikelnummer"], ...Array.from({ length: 10_001 }, (_, i) => [`ART-${i}`])],
      },
    ]);
    await expect(parseXlsxBuffer(tooMany)).rejects.toBeInstanceOf(CsvRowLimitError);
  });

  it("turns a zip that is not a workbook into a Swedish error", async () => {
    // A valid zip container whose parts are nonsense to the OOXML reader.
    const notAWorkbook = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(64),
    ]);
    await expect(parseXlsxBuffer(notAWorkbook)).rejects.toBeInstanceOf(UnreadableImportFileError);
  });
});

describe("parseImportFile — format sniffing", () => {
  it("reads a CSV buffer exactly as before", async () => {
    const parsed = await parseImportFile(Buffer.from("Artikelnummer;Antal\nART-1;2\n"));

    expect(parsed.format).toBe("csv");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.encoding).toBe("utf-8");
    expect(parsed.sheetName).toBeNull();
    expect(parsed.sheetCount).toBeNull();
    expect(parsed.headers).toEqual(["Artikelnummer", "Antal"]);
    expect(parsed.rows).toEqual([["ART-1", "2"]]);
  });

  it("reads an xlsx buffer and reports no delimiter or encoding", async () => {
    const buf = buildXlsxBuffer([{ name: "Operationer", rows: [["Artikelnummer"], ["ART-1"]] }]);
    const parsed = await parseImportFile(buf);

    expect(parsed.format).toBe("xlsx");
    expect(parsed.delimiter).toBeNull();
    expect(parsed.encoding).toBeNull();
    expect(parsed.sheetName).toBe("Operationer");
    expect(parsed.sheetCount).toBe(1);
    expect(parsed.rows).toEqual([["ART-1"]]);
  });

  it("detects the format from the bytes, not the extension", async () => {
    // A workbook a user renamed to .csv still reads as a workbook — the
    // service never sees the filename, which is why sniffing is content-based.
    const buf = buildXlsxBuffer([{ name: "Blad1", rows: [["Artikelnummer"], ["ART-1"]] }]);
    expect((await parseImportFile(buf)).format).toBe("xlsx");
  });

  it("names the two common wrong-file mistakes instead of failing to parse", async () => {
    const legacyXls = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(16),
    ]);
    await expect(parseImportFile(legacyXls)).rejects.toBeInstanceOf(LegacyExcelFileError);

    const pdf = Buffer.from("%PDF-1.7\n%âãÏÓ\n", "latin1");
    await expect(parseImportFile(pdf)).rejects.toBeInstanceOf(UnreadableImportFileError);
  });
});
