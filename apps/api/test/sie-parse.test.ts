import { describe, expect, it } from "vitest";
import { parseSieFile, SieParseError } from "../src/modules/economy/service/sie-parse.js";
import { encodeCp437 } from "../src/modules/economy/service/sie-encoding.js";

const FILE = [
  "#FLAGGA 0",
  '#PROGRAM "Visma Compact" 5.1',
  "#FORMAT PC8",
  "#GEN 20260101 AN",
  "#SIETYP 4",
  "#ORGNR 556677-8899",
  '#FNAMN "Målerifirman AB"',
  "#RAR 0 20260101 20261231",
  "#RAR -1 20250101 20251231",
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 2081 "Aktiekapital"',
  "#IB 0 1930 25000.00",
  "#IB 0 2081 -25000.00",
  "#IB -1 1930 1000.00",
  "",
].join("\r\n");

function parse(text: string) {
  return parseSieFile(encodeCp437(text));
}

describe("parseSieFile", () => {
  it("reads the fiscal year, accounts and opening balances", () => {
    const result = parse(FILE);
    expect(result.fiscalYear).toEqual({ startDate: "2026-01-01", endDate: "2026-12-31" });
    expect(result.companyName).toBe("Målerifirman AB");
    expect(result.accounts).toEqual([
      { number: "1930", name: "Företagskonto" },
      { number: "2081", name: "Aktiekapital" },
    ]);
    expect(result.openingBalances).toEqual([
      { accountNumber: "1930", amount: 25000 },
      { accountNumber: "2081", amount: -25000 },
    ]);
  });

  it("ignores balances for comparison years — only year 0 is imported", () => {
    const result = parse(FILE);
    expect(result.openingBalances.every((b) => b.accountNumber !== "9999")).toBe(true);
    expect(result.openingBalances).toHaveLength(2);
  });

  it("decodes CP437 Swedish characters", () => {
    expect(parse(FILE).accounts[0]!.name).toBe("Företagskonto");
  });

  it("also accepts a UTF-8 file, which real exporters emit despite the spec", () => {
    const utf8 = Buffer.from(FILE, "utf-8");
    const result = parseSieFile(utf8);
    expect(result.companyName).toBe("Målerifirman AB");
    expect(result.accounts[0]!.name).toBe("Företagskonto");
  });

  it("handles escaped quotes inside a quoted field", () => {
    const result = parse(['#RAR 0 20260101 20261231', '#KONTO 1915 "Kassa \\"special\\""', "#IB 0 1915 5"].join("\r\n"));
    expect(result.accounts[0]!.name).toBe('Kassa "special"');
  });

  it("accepts LF-only line endings and ignores blank lines", () => {
    const result = parseSieFile(
      encodeCp437(["#RAR 0 20260101 20261231", "", "#IB 0 1930 100", ""].join("\n"))
    );
    expect(result.openingBalances).toEqual([{ accountNumber: "1930", amount: 100 }]);
  });

  it("ignores records it does not care about, including #VER blocks", () => {
    const result = parse(
      [
        "#RAR 0 20260101 20261231",
        "#IB 0 1930 100",
        '#VER A 1 20260115 "Kundfaktura"',
        "{",
        "\t#TRANS 1930 {} 100",
        "\t#TRANS 3001 {} -100",
        "}",
      ].join("\r\n")
    );
    expect(result.openingBalances).toEqual([{ accountNumber: "1930", amount: 100 }]);
  });

  it("throws when the file has no #RAR 0", () => {
    expect(() => parse("#FLAGGA 0\r\n#IB 0 1930 100\r\n")).toThrow(SieParseError);
  });

  it("throws on a file with no opening balances at all", () => {
    expect(() => parse("#RAR 0 20260101 20261231\r\n")).toThrow(SieParseError);
  });

  it("throws on a malformed #IB amount rather than importing NaN", () => {
    expect(() => parse("#RAR 0 20260101 20261231\r\n#IB 0 1930 abc\r\n")).toThrow(SieParseError);
  });
});
