import { describe, expect, it } from "vitest";
import { buildSieFile, sieAccountType, type SieExportData } from "../src/modules/economy/service/sie-export.js";
import { decodeCp437 } from "../src/modules/economy/service/sie-encoding.js";

// Pure builder tests — the shape of the emitted file, straight against the
// SIE 4 spec's own examples.

const BASE: SieExportData = {
  program: { name: "Nav-ERP", version: "1.0" },
  generatedDate: "2026-08-07",
  generatedBy: "urban",
  company: { name: "Målerifirman AB", orgNumber: "556677-8899" },
  fiscalYears: [{ yearIndex: 0, startDate: "2026-01-01", endDate: "2026-12-31" }],
  accounts: [
    { number: "1930", name: "Företagskonto", type: "T" },
    { number: "2440", name: "Leverantörsskulder", type: "S" },
    { number: "3001", name: "Försäljning inom Sverige 25 %", type: "I" },
  ],
  balances: [
    { yearIndex: 0, accountNumber: "1930", ib: 0, ub: 3500, res: 0 },
    { yearIndex: 0, accountNumber: "2440", ib: 0, ub: -5000, res: 0 },
    { yearIndex: 0, accountNumber: "3001", ib: 0, ub: 0, res: -10000 },
  ],
  verifications: [],
};

function lines(data: SieExportData): string[] {
  return decodeCp437(buildSieFile(data)).split("\r\n");
}

describe("buildSieFile — header", () => {
  it("emits the mandatory identification posts in spec order", () => {
    const out = lines(BASE);
    expect(out[0]).toBe("#FLAGGA 0");
    expect(out[1]).toBe('#PROGRAM "Nav-ERP" 1.0');
    expect(out[2]).toBe("#FORMAT PC8");
    expect(out[3]).toBe("#GEN 20260807 urban");
    expect(out[4]).toBe("#SIETYP 4");
    expect(out[5]).toBe("#ORGNR 556677-8899");
    expect(out[6]).toBe('#FNAMN "Målerifirman AB"');
    expect(out[7]).toBe("#RAR 0 20260101 20261231");
  });

  it("omits #ORGNR when the company has none rather than emitting an empty one", () => {
    const out = lines({ ...BASE, company: { name: "Utan orgnr", orgNumber: null } });
    expect(out.some((line) => line.startsWith("#ORGNR"))).toBe(false);
    expect(out.some((line) => line.startsWith("#FNAMN"))).toBe(true);
  });

  it("emits a #RAR line for the comparison year too", () => {
    const out = lines({
      ...BASE,
      fiscalYears: [
        { yearIndex: 0, startDate: "2026-01-01", endDate: "2026-12-31" },
        { yearIndex: -1, startDate: "2025-01-01", endDate: "2025-12-31" },
      ],
    });
    expect(out).toContain("#RAR 0 20260101 20261231");
    expect(out).toContain("#RAR -1 20250101 20251231");
  });
});

describe("buildSieFile — chart of accounts and balances", () => {
  it("emits #KONTO and #KTYP per account", () => {
    const out = lines(BASE);
    expect(out).toContain('#KONTO 1930 "Företagskonto"');
    expect(out).toContain("#KTYP 1930 T");
    expect(out).toContain('#KONTO 3001 "Försäljning inom Sverige 25 %"');
    expect(out).toContain("#KTYP 3001 I");
  });

  it("writes assets positive and liabilities negative", () => {
    const out = lines(BASE);
    expect(out).toContain("#UB 0 1930 3500");
    expect(out).toContain("#UB 0 2440 -5000");
  });

  it("omits balance rows that are zero", () => {
    const out = lines(BASE);
    // 1930 has no opening balance.
    expect(out.some((line) => line.startsWith("#IB 0 1930"))).toBe(false);
    expect(out).toContain("#RES 0 3001 -10000");
  });

  it("gives balance accounts #IB/#UB and result accounts #RES — never both", () => {
    const out = lines({
      ...BASE,
      balances: [
        { yearIndex: 0, accountNumber: "1930", ib: 1000, ub: 3500, res: 2500 },
        { yearIndex: 0, accountNumber: "3001", ib: 0, ub: -10000, res: -10000 },
      ],
    });
    // A bank account never carries a #RES line, even though money moved.
    expect(out).toContain("#IB 0 1930 1000");
    expect(out).toContain("#UB 0 1930 3500");
    expect(out.some((line) => line.startsWith("#RES 0 1930"))).toBe(false);
    // A revenue account is the mirror image: #RES only.
    expect(out).toContain("#RES 0 3001 -10000");
    expect(out.some((line) => line.startsWith("#UB 0 3001"))).toBe(false);
    expect(out.some((line) => line.startsWith("#IB 0 3001"))).toBe(false);
  });
});

describe("buildSieFile — verifications", () => {
  const withVer: SieExportData = {
    ...BASE,
    verifications: [
      {
        series: "A",
        number: 1,
        date: "2026-01-15",
        description: "Kundfaktura",
        rows: [
          { accountNumber: "1510", amount: 12500, description: null },
          { accountNumber: "3001", amount: -10000, description: null },
          { accountNumber: "2610", amount: -2500, description: "Moms" },
        ],
      },
    ],
  };

  it("wraps #TRANS rows in braces on their own lines", () => {
    const out = lines(withVer);
    const start = out.indexOf('#VER A 1 20260115 "Kundfaktura"');
    expect(start).toBeGreaterThan(-1);
    expect(out[start + 1]).toBe("{");
    expect(out[start + 2]).toBe("\t#TRANS 1510 {} 12500");
    expect(out[start + 3]).toBe("\t#TRANS 3001 {} -10000");
    expect(out[start + 4]).toBe('\t#TRANS 2610 {} -2500 "" "Moms"');
    expect(out[start + 5]).toBe("}");
  });

  it("keeps every verification balanced at zero", () => {
    for (const verification of withVer.verifications) {
      const sum = verification.rows.reduce((total, row) => total + row.amount, 0);
      expect(sum).toBe(0);
    }
  });

  it("orders verifications by series then ascending number", () => {
    const out = lines({
      ...withVer,
      verifications: [
        { series: "B", number: 1, date: "2026-02-01", description: "B1", rows: [] },
        { series: "A", number: 2, date: "2026-01-20", description: "A2", rows: [] },
        { series: "A", number: 1, date: "2026-01-15", description: "A1", rows: [] },
      ],
    });
    const order = out.filter((line) => line.startsWith("#VER")).map((line) => line.split(" ")[2]);
    expect(out.filter((line) => line.startsWith("#VER")).map((l) => l.split(" ").slice(1, 3).join(""))).toEqual([
      "A1",
      "A2",
      "B1",
    ]);
    expect(order).toHaveLength(3);
  });
});

describe("buildSieFile — encoding", () => {
  it("returns CP437 bytes, not UTF-8", () => {
    const buffer = buildSieFile(BASE);
    // "Målerifirman" — å is a single 0x86 byte in CP437, two bytes in UTF-8.
    expect(buffer.includes(0x86)).toBe(true);
    expect(buffer.includes(Buffer.from("å", "utf-8"))).toBe(false);
  });

  it("terminates every line with CRLF and ends the file with one", () => {
    const text = decodeCp437(buildSieFile(BASE));
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.includes("\n\n")).toBe(false);
  });
});

describe("sieAccountType", () => {
  it("maps BAS classes to the spec's T/S/K/I", () => {
    expect(sieAccountType("1930")).toBe("T");
    expect(sieAccountType("2440")).toBe("S");
    expect(sieAccountType("3001")).toBe("I");
    expect(sieAccountType("4010")).toBe("K");
    expect(sieAccountType("7010")).toBe("K");
    expect(sieAccountType("8410")).toBe("K");
  });
});
