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

// --- #VER / #TRANS (SIE-import av verifikat, etapp 3) ---

import { parseSieDocument, splitFields } from "../src/modules/economy/service/sie-parse.js";

const JOURNAL = [
  "#FLAGGA 0",
  '#PROGRAM "Lönesystemet" 2.4',
  "#FORMAT PC8",
  "#GEN 20260201",
  "#SIETYP 4",
  '#FNAMN "Målerifirman AB"',
  "#RAR 0 20260101 20261231",
  '#KONTO 7210 "Löner tjänstemän"',
  '#KONTO 2710 "Personalskatt"',
  '#KONTO 2731 "Avräkning sociala avgifter"',
  '#KONTO 7510 "Arbetsgivaravgifter"',
  '#KONTO 1930 "Företagskonto"',
  '#DIM 1 "Kostnadsställe"',
  '#VER "LÖ" "1" 20260125 "Lön januari" 20260201',
  "{",
  '  #TRANS 7210 {} 30000.00 20260125 "Bruttolön"',
  '  #TRANS 2710 {} -9000.00 "" "Skatt"',
  '  #TRANS 1930 {1 "100"} -21000.00',
  "}",
  '#VER LÖ 2 20260125 "Sociala avgifter"',
  "{",
  "  #RTRANS 7510 {} 9426.00",
  "  #TRANS 7510 {} 9426.00",
  "  #BTRANS 2731 {} -9000.00",
  "  #TRANS 2731 {} -9426.00",
  "}",
  "#UB 0 1930 1000.00",
  "",
].join("\r\n");

describe("splitFields with brace lists", () => {
  it("keeps an object list as one field and strips quotes outside it", () => {
    expect(splitFields('#TRANS 7210 {1 "100" 2 "Avd \\"A\\""} 30000.00 "" "Bruttolön"')).toEqual([
      "#TRANS",
      "7210",
      '{1 "100" 2 "Avd \\"A\\""}'.replace('\\"A\\"', '"A"'),
      "30000.00",
      "",
      "Bruttolön",
    ]);
    expect(splitFields("#TRANS 1930 {} -21000.00")).toEqual(["#TRANS", "1930", "{}", "-21000.00"]);
  });
});

describe("parseSieDocument — verifications", () => {
  it("reads #VER headers and their #TRANS rows, debit-positive", () => {
    const doc = parseSieDocument(encodeCp437(JOURNAL));
    expect(doc.program).toBe("Lönesystemet 2.4");
    expect(doc.companyName).toBe("Målerifirman AB");
    expect(doc.fiscalYears).toEqual([{ index: 0, startDate: "2026-01-01", endDate: "2026-12-31" }]);
    expect(doc.verifications).toHaveLength(2);
    const [first, second] = doc.verifications;
    expect(first).toMatchObject({ series: "LÖ", number: "1", date: "2026-01-25", text: "Lön januari" });
    expect(first!.rows).toEqual([
      { accountNumber: "7210", objects: [], amount: 30000, transDate: "2026-01-25", description: "Bruttolön" },
      { accountNumber: "2710", objects: [], amount: -9000, transDate: null, description: "Skatt" },
      { accountNumber: "1930", objects: [{ dimension: "1", object: "100" }], amount: -21000, transDate: null, description: null },
    ]);
    expect(second).toMatchObject({ series: "LÖ", number: "2", text: "Sociala avgifter" });
  });

  it("skips #RTRANS and #BTRANS — only #TRANS is a booked row", () => {
    const doc = parseSieDocument(encodeCp437(JOURNAL));
    expect(doc.verifications[1]!.rows.map((r) => [r.accountNumber, r.amount])).toEqual([
      ["7510", 9426],
      ["2731", -9426],
    ]);
  });

  it("decodes Swedish letters in CP437 and in UTF-8 alike", () => {
    expect(parseSieDocument(encodeCp437(JOURNAL)).accounts[0]!.name).toBe("Löner tjänstemän");
    expect(parseSieDocument(Buffer.from(JOURNAL, "utf-8")).accounts[0]!.name).toBe("Löner tjänstemän");
    expect(parseSieDocument(Buffer.from(JOURNAL, "utf-8")).verifications[0]!.series).toBe("LÖ");
  });

  it("reads a #VER without text and a #TRANS without an object list", () => {
    const doc = parseSieDocument(Buffer.from(["#VER A 7 20260301", "{", "#TRANS 1930 100.00", "#TRANS 3001 -100.00", "}"].join("\n")));
    expect(doc.verifications[0]).toMatchObject({ series: "A", number: "7", date: "2026-03-01", text: "" });
    expect(doc.verifications[0]!.rows.map((r) => r.amount)).toEqual([100, -100]);
  });

  it("gives an empty list for a file without #VER, and refuses a block that never closes", () => {
    expect(parseSieDocument(encodeCp437(FILE)).verifications).toEqual([]);
    expect(() => parseSieDocument(Buffer.from(["#VER A 1 20260301 \"x\"", "{", "#TRANS 1930 100.00"].join("\n")))).toThrow(SieParseError);
  });

  it("refuses a #VER without a date and a #TRANS with a malformed amount", () => {
    expect(() => parseSieDocument(Buffer.from(["#VER A 1", "{", "}"].join("\n")))).toThrow(SieParseError);
    expect(() => parseSieDocument(Buffer.from(["#VER A 1 20260301", "{", "#TRANS 1930 {} 1,5", "}"].join("\n")))).toThrow(SieParseError);
  });

  it("still serves the opening-balance reader unchanged", () => {
    const result = parseSieFile(encodeCp437(FILE));
    expect(result.openingBalances).toHaveLength(2);
  });
});
