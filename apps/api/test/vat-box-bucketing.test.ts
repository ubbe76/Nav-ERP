import { describe, expect, it } from "vitest";
import { VAT_BOXES, VAT_CODE_CATALOG } from "@navet/shared";
import {
  bucketMovements,
  findRuleBoxMismatches,
  findUnassignedAccounts,
  findVatCodeBoxMismatches,
  roundBoxes,
  roundToKronor,
} from "../src/modules/economy/service/vat-report.service.js";
import type { VatAccountMovement } from "../src/modules/economy/service/vat-account-movements.js";
import { buildVatDeclarationFile } from "../src/modules/economy/service/vat-file.js";

function movement(accountNumber: string, vatBox: VatAccountMovement["vatBox"], debit: number, credit: number): VatAccountMovement {
  return { accountId: `id-${accountNumber}`, accountNumber, accountName: `Konto ${accountNumber}`, vatBox, debit, credit };
}

describe("bucketMovements — every box of the declaration", () => {
  it("routes each account's net to its box: sales and utgående moms credit-positive, inköp (20–24, 37), 50 and 48 debit-positive", () => {
    const boxes = bucketMovements([
      movement("3001", "05", 0, 1000),
      movement("3010", "05", 0, 200),
      movement("3401", "06", 0, 70),
      movement("3211", "07", 0, 80),
      movement("3913", "08", 0, 90),
      movement("2610", "10", 0, 300),
      movement("2620", "11", 0, 24),
      movement("2630", "12", 0, 6),
      movement("4515", "20", 1000, 0),
      movement("4535", "21", 600, 0),
      movement("4531", "22", 200, 0),
      movement("4415", "23", 400, 0),
      movement("4425", "24", 100, 0),
      movement("2614", "30", 0, 575),
      movement("2624", "31", 0, 12),
      movement("2634", "32", 0, 3),
      movement("3108", "35", 0, 400),
      movement("3105", "36", 0, 500),
      movement("4512", "37", 700, 0),
      movement("3109", "38", 0, 11),
      movement("3308", "39", 0, 120),
      movement("3305", "40", 0, 130),
      movement("3231", "41", 0, 140),
      movement("3004", "42", 0, 300),
      movement("2640", "48", 80, 0),
      movement("2645", "48", 1145, 0),
      movement("4545", "50", 10000, 0),
      movement("2615", "60", 0, 2500),
      movement("2625", "61", 0, 120),
      movement("2635", "62", 0, 30),
    ]);
    expect(boxes).toEqual({
      "05": 1200,
      "06": 70,
      "07": 80,
      "08": 90,
      "10": 300,
      "11": 24,
      "12": 6,
      "20": 1000,
      "21": 600,
      "22": 200,
      "23": 400,
      "24": 100,
      "30": 575,
      "31": 12,
      "32": 3,
      "35": 400,
      "36": 500,
      "37": 700,
      "38": 11,
      "39": 120,
      "40": 130,
      "41": 140,
      "42": 300,
      "48": 1225,
      "50": 10000,
      "60": 2500,
      "61": 120,
      "62": 30,
      // (300 + 24 + 6 + 575 + 12 + 3 + 2500 + 120 + 30) − 1225
      "49": 2345,
    });
  });

  it("has one key per stored box plus 49", () => {
    expect(Object.keys(bucketMovements([])).sort()).toEqual([...VAT_BOXES, "49"].sort());
  });

  it("ignores accounts with no box or 'none', whatever their number", () => {
    const boxes = bucketMovements([movement("3540", "none", 0, 60), movement("3999", null, 0, 75), movement("1510", null, 135, 0)]);
    expect(boxes["05"]).toBe(0);
    expect(boxes["49"]).toBe(0);
  });

  it("a second account tagged 10 counts in ruta 10 too (box follows the account)", () => {
    const boxes = bucketMovements([movement("2610", "10", 0, 100), movement("2611", "10", 0, 25)]);
    expect(boxes["10"]).toBe(125);
  });

  it("ruta 37 (the mellanman's purchase in a trepartshandel) is a purchase: a debit is positive, in the file too", () => {
    const boxes = bucketMovements([movement("4512", "37", 1234.4, 0), movement("4512", "37", 0, 34.4), movement("3109", "38", 0, 1500)]);
    expect(boxes["37"]).toBe(1200);
    expect(boxes["38"]).toBe(1500);
    // Neither 37 nor 38 enters ruta 49.
    expect(boxes["49"]).toBe(0);
    const file = buildVatDeclarationFile({ orgNumber: "556000-0175", period: "202403", boxes: roundBoxes(boxes) }).toString("latin1");
    expect(file).toContain("<InkopVaruMellan3p>1200</InkopVaruMellan3p>\n<ForsVaruMellan3p>1500</ForsVaruMellan3p>");
  });

  it("gives a negative 49 when the ingående moms exceeds the utgående (moms att få tillbaka)", () => {
    const boxes = bucketMovements([movement("2610", "10", 0, 100), movement("2640", "48", 400, 0)]);
    expect(boxes["49"]).toBe(-300);
  });
});

describe("hela kronor", () => {
  it("rounds to the nearest krona, halves away from zero, never a negative zero", () => {
    expect(roundToKronor(100.49)).toBe(100);
    expect(roundToKronor(100.5)).toBe(101);
    expect(roundToKronor(-100.5)).toBe(-101);
    expect(roundToKronor(-0.4)).toBe(0);
    expect(Object.is(roundToKronor(-0.4), 0)).toBe(true);
  });

  it("computes ruta 49 from the rounded boxes, not by rounding the öre sum", () => {
    const boxes = bucketMovements([
      movement("2610", "10", 0, 100.4),
      movement("2620", "11", 0, 50.4),
      movement("2630", "12", 0, 10.4),
      movement("2640", "48", 0.4, 0),
    ]);
    // öre: 161.20 − 0.40 = 160.80 → would round to 161
    expect(boxes["49"]).toBe(160.8);
    const rounded = roundBoxes(boxes);
    expect(rounded["10"]).toBe(100);
    expect(rounded["11"]).toBe(50);
    expect(rounded["12"]).toBe(10);
    expect(rounded["48"]).toBe(0);
    expect(rounded["49"]).toBe(160);
  });
});

describe("findUnassignedAccounts", () => {
  it("lists class-3, 26xx, 44xx and 45xx accounts without a box that moved, credit-net, and nothing else", () => {
    const warnings = findUnassignedAccounts([
      movement("3010", null, 0, 200),
      movement("2611", null, 0, 50),
      movement("4416", null, 30, 0),
      movement("4518", null, 20, 0),
      movement("3540", "none", 0, 60),
      movement("1510", null, 250, 0),
      movement("4010", null, 99, 0),
      movement("3020", null, 100, 100),
    ]);
    expect(warnings).toEqual([
      { accountNumber: "3010", accountName: "Konto 3010", net: 200 },
      { accountNumber: "2611", accountName: "Konto 2611", net: 50 },
      { accountNumber: "4416", accountName: "Konto 4416", net: -30 },
      { accountNumber: "4518", accountName: "Konto 4518", net: -20 },
    ]);
  });
});

// The catalog's default accounts with their expected boxes — a chart where
// every momskod is in order.
const CATALOG_CHART = [
  ...new Map(
    VAT_CODE_CATALOG.flatMap((entry) =>
      Object.values(entry.slots).map((slot) => [slot.account, { number: slot.account, name: slot.account, active: true, vatBox: slot.box as string | null }] as const)
    )
  ).values(),
];
const catalogCode = (code: string, overrides: Record<string, string | null | boolean> = {}) => {
  const entry = VAT_CODE_CATALOG.find((candidate) => candidate.code === code)!;
  return {
    id: `id-${code}`,
    code,
    active: true,
    revenueAccount: entry.slots.revenue?.account ?? null,
    outputVatAccount: entry.slots.outputVat?.account ?? null,
    inputVatAccount: entry.slots.inputVat?.account ?? null,
    costAccount: entry.slots.cost?.account ?? null,
    baseAccount: entry.slots.base?.account ?? null,
    baseCounterAccount: entry.slots.baseCounter?.account ?? null,
    ...overrides,
  } as Parameters<typeof findVatCodeBoxMismatches>[0][number];
};

describe("findVatCodeBoxMismatches — the catalog against the chart", () => {
  it("is empty for the catalog defaults", () => {
    expect(findVatCodeBoxMismatches(VAT_CODE_CATALOG.map((entry) => catalogCode(entry.code)), CATALOG_CHART)).toEqual([]);
  });

  it("names the code, the account and both boxes, and skips inactive codes", () => {
    const chart = CATALOG_CHART.map((account) => (account.number === "3108" ? { ...account, vatBox: "05" } : account));
    const mismatches = findVatCodeBoxMismatches(
      [catalogCode("EUV"), catalogCode("IMP25", { baseCounterAccount: "4599" }), catalogCode("EXV", { active: false, revenueAccount: "3001" })],
      chart
    );
    expect(mismatches.map((mismatch) => mismatch.message)).toEqual([
      "Momskod EUV: konto 3108 har ruta 05 men ska ha ruta 35",
      "Momskod IMP25: konto 4599 finns inte i kontoplanen",
    ]);
    expect(mismatches[0]).toMatchObject({ code: "EUV", slot: "revenue", expectedBox: "35", actualBox: "05", problem: "box_mismatch" });
  });
});

describe("findRuleBoxMismatches", () => {
  const codes = VAT_CODE_CATALOG.map((entry) => catalogCode(entry.code));
  const rule = (code: string | null, revenue: [string, string | null] | null, cost: [string, string | null] | null) => ({
    id: `rule-${code ?? "all"}`,
    groupCode: "310",
    groupName: "Diskbänkar",
    vatCodeId: code === null ? null : `id-${code}`,
    revenueAccountNumber: revenue?.[0] ?? null,
    revenueAccountVatBox: revenue?.[1] ?? null,
    costAccountNumber: cost?.[0] ?? null,
    costAccountVatBox: cost?.[1] ?? null,
  });

  it("checks the revenue account of a sales code and the cost account of an omvänd purchase", () => {
    const mismatches = findRuleBoxMismatches(
      [
        rule("EUV", ["3010", "05"], null),
        rule("EUT", ["3308", "39"], null),
        rule("IEUV25", null, ["4011", null]),
        rule("IUTV", null, ["4011", null]),
        rule("IMP25", ["3010", "05"], ["4011", "20"]),
      ],
      codes
    );
    expect(mismatches.map((mismatch) => mismatch.message)).toEqual([
      "Konteringsregel 310 Diskbänkar / EUV: konto 3010 har ruta 05 men ska ha ruta 35",
      "Konteringsregel 310 Diskbänkar / IEUV25: konto 4011 har ingen ruta men ska ha ruta 20",
    ]);
    expect(mismatches[0]).toMatchObject({
      code: "EUV",
      slot: "revenue",
      expectedBox: "35",
      expectedBoxes: ["35"],
      actualBox: "05",
      problem: "box_mismatch",
    });
  });

  it("checks domestic rules: MP25/MP12/MP6 revenue on ruta 05, MF on 42, and no purchase box on their cost account", () => {
    const mismatches = findRuleBoxMismatches(
      [
        rule("MP25", ["3108", "35"], ["4010", null]),
        rule("MP12", ["3002", "05"], ["4515", "20"]),
        rule("MP6", ["3003", null], null),
        rule("MF", ["3004", "42"], ["4545", "50"]),
        rule("MF", ["3001", "05"], null),
        // IUTV's cost account must not carry a purchase box either.
        rule("IUTV", null, ["4531", "22"]),
      ],
      codes
    );
    expect(mismatches.map((mismatch) => [mismatch.code, mismatch.slot, mismatch.problem, mismatch.expectedBoxes])).toEqual([
      ["MP25", "revenue", "box_mismatch", ["05"]],
      ["MP12", "cost", "purchase_box", []],
      ["MP6", "revenue", "box_mismatch", ["05"]],
      ["MF", "cost", "purchase_box", []],
      ["MF", "revenue", "box_mismatch", ["42"]],
      ["IUTV", "cost", "purchase_box", []],
    ]);
    expect(mismatches[0]!.message).toBe("Konteringsregel 310 Diskbänkar / MP25: konto 3108 har ruta 35 men ska ha ruta 05");
    expect(mismatches[1]!.message).toBe(
      "Konteringsregel 310 Diskbänkar / MP12: kostnadskonto 4515 har ruta 20 men ska inte ha någon av inköpsrutorna 20–24, 37 eller 50 (de gäller omvänd moms och import)"
    );
    expect(mismatches[2]!.message).toBe("Konteringsregel 310 Diskbänkar / MP6: konto 3003 har ingen ruta men ska ha ruta 05");
  });

  it("checks Alla momskoder: revenue on ruta 05 or 42, no purchase box on the cost account", () => {
    expect(findRuleBoxMismatches([rule(null, ["3001", "05"], ["4010", null]), rule(null, ["3004", "42"], ["4010", "none"])], codes)).toEqual([]);
    const mismatches = findRuleBoxMismatches([rule(null, ["3108", "35"], ["4535", "21"])], codes);
    expect(mismatches).toEqual([
      {
        ruleId: "rule-all",
        groupCode: "310",
        groupName: "Diskbänkar",
        code: null,
        slot: "revenue",
        accountNumber: "3108",
        expectedBox: null,
        expectedBoxes: ["05", "42"],
        actualBox: "35",
        problem: "box_mismatch",
        message: "Konteringsregel 310 Diskbänkar / Alla momskoder: konto 3108 har ruta 35 men ska ha ruta 05 eller ruta 42",
      },
      {
        ruleId: "rule-all",
        groupCode: "310",
        groupName: "Diskbänkar",
        code: null,
        slot: "cost",
        accountNumber: "4535",
        expectedBox: null,
        expectedBoxes: [],
        actualBox: "21",
        problem: "purchase_box",
        message:
          "Konteringsregel 310 Diskbänkar / Alla momskoder: kostnadskonto 4535 har ruta 21 men ska inte ha någon av inköpsrutorna 20–24, 37 eller 50 (de gäller omvänd moms och import)",
      },
    ]);
  });
});
