import { describe, expect, it } from "vitest";
import {
  budgetSign,
  budgetedAmounts,
  buildBudgetedIncomeStatement,
  calendarMonthMap,
  compareGridLines,
  inclusiveDays,
  isBudgetableAccount,
  periodShare,
  variancePercentOf,
} from "../src/modules/economy/service/budget-calc.js";
import { buildBudgetCsv, parseBudgetCsv } from "../src/modules/economy/service/budget-csv.js";
import { buildBudgetedIncomeStatementCsv } from "../src/modules/economy/service/financial-reports-csv.js";
import { generateMonthlyPeriods } from "../src/modules/economy/service/month-periods.js";
import { parseCsvBuffer } from "../src/modules/import/service/csv.js";

// Budget (etapp 5 del B): the pure rules — sign, budgetable accounts, the
// apportioning of a budget month over a report window, the calendar-month
// mapping of Kopiera utfall, the budgeted income statement and the CSV form.

describe("budgetSign", () => {
  it("is +1 on the revenue lines (3xxx, 80xx–83xx) and −1 on every other class 3–8 account", () => {
    expect(budgetSign("3001")).toBe(1);
    expect(budgetSign("3910")).toBe(1);
    expect(budgetSign("8310")).toBe(1);
    expect(budgetSign("4010")).toBe(-1);
    expect(budgetSign("4990")).toBe(-1);
    expect(budgetSign("5010")).toBe(-1);
    expect(budgetSign("7210")).toBe(-1);
    expect(budgetSign("8410")).toBe(-1);
    expect(budgetSign("8811")).toBe(-1);
    expect(budgetSign("8910")).toBe(-1);
  });

  it("budgetable = class 3–8 except 8990–8999", () => {
    expect(isBudgetableAccount("3001")).toBe(true);
    expect(isBudgetableAccount("8989")).toBe(true);
    expect(isBudgetableAccount("8990")).toBe(false);
    expect(isBudgetableAccount("8999")).toBe(false);
    expect(isBudgetableAccount("1930")).toBe(false);
    expect(isBudgetableAccount("2440")).toBe(false);
    expect(isBudgetableAccount("9000")).toBe(false);
    expect(isBudgetableAccount("300")).toBe(false);
  });
});

describe("periodShare", () => {
  const january = { startDate: "2026-01-01", endDate: "2026-01-31" };

  it("counts days inclusively", () => {
    expect(inclusiveDays("2026-01-01", "2026-01-31")).toBe(31);
    expect(inclusiveDays("2028-02-01", "2028-02-29")).toBe(29);
    expect(inclusiveDays("2026-02-01", "2026-01-31")).toBe(0);
  });

  it("gives the whole month for a window covering it, a fraction for part of it, 0 outside", () => {
    expect(periodShare(january, "2026-01-01", "2026-12-31")).toBe(1);
    expect(periodShare(january, "2025-12-15", "2026-01-31")).toBe(1);
    expect(periodShare(january, "2026-01-01", "2026-01-16")).toBeCloseTo(16 / 31, 12);
    expect(periodShare(january, "2026-01-31", "2026-01-31")).toBeCloseTo(1 / 31, 12);
    expect(periodShare(january, "2026-02-01", "2026-02-28")).toBe(0);
  });
});

describe("budgetedAmounts", () => {
  const periods = generateMonthlyPeriods("2026-01-01", "2026-12-31");

  it("turns natural amounts credit-positive and apportions by days", () => {
    const lines = [
      { accountNumber: "3001", month: 1, amount: 3100 },
      { accountNumber: "4010", month: 1, amount: 3100 },
    ];
    expect(budgetedAmounts(lines, periods, "2026-01-01", "2026-12-31")).toEqual(new Map([["3001", 3100], ["4010", -3100]]));
    expect(budgetedAmounts(lines, periods, "2026-01-01", "2026-01-16")).toEqual(new Map([["3001", 1600], ["4010", -1600]]));
  });

  it("sums a window over several months and rounds once per account", () => {
    const lines = [
      { accountNumber: "3001", month: 1, amount: 3100 },
      { accountNumber: "3001", month: 2, amount: 2800 },
      { accountNumber: "3001", month: 3, amount: 3100 },
      { accountNumber: "3001", month: 4, amount: 999 },
    ];
    // 17 of 31 January days + all of February + all of March.
    expect(budgetedAmounts(lines, periods, "2026-01-15", "2026-03-31").get("3001")).toBe(7600);
    // One third of a month (10/30) of 100 → 33.33, rounded once.
    expect(budgetedAmounts([{ accountNumber: "3001", month: 4, amount: 100 }], periods, "2026-04-01", "2026-04-10").get("3001")).toBe(33.33);
  });

  it("follows a brutet år's periods and ignores months the year lacks", () => {
    const broken = generateMonthlyPeriods("2026-05-01", "2027-04-30");
    const lines = [
      { accountNumber: "3001", month: 1, amount: 310 },
      { accountNumber: "3001", month: 13, amount: 999 },
    ];
    expect(budgetedAmounts(lines, broken, "2026-05-01", "2026-05-10").get("3001")).toBe(100);
    expect(budgetedAmounts(lines, broken, "2026-05-01", "2027-04-30").get("3001")).toBe(310);
  });
});

describe("calendarMonthMap", () => {
  it("maps target months onto the source period with the same calendar month", () => {
    const source = generateMonthlyPeriods("2026-01-01", "2026-12-31");
    const broken = generateMonthlyPeriods("2027-05-01", "2028-04-30");
    const map = calendarMonthMap(source, broken);
    expect(map.get(1)).toBe(5); // May
    expect(map.get(9)).toBe(1); // January
    expect(map.get(12)).toBe(4); // April
    expect(map.size).toBe(12);
  });

  it("takes the LATER source period when a long year has the same month twice", () => {
    const long = generateMonthlyPeriods("2026-07-01", "2027-12-31"); // 18 periods
    const target = generateMonthlyPeriods("2028-01-01", "2028-12-31");
    const map = calendarMonthMap(long, target);
    expect(map.get(7)).toBe(13); // July 2027, not July 2026
    expect(map.get(1)).toBe(7); // January 2027
  });

  // Omläggning av räkenskapsår: an 18-month target year has January–June
  // twice, and both get the source's January–June — every amount lands in
  // its own calendar month, and the long year is budgeted in full.
  it("gives both occurrences of a calendar month in an extended target year the same source month", () => {
    const source = generateMonthlyPeriods("2025-01-01", "2025-12-31");
    const extended = generateMonthlyPeriods("2026-01-01", "2027-06-30"); // 18 periods
    const map = calendarMonthMap(source, extended);
    expect(map.size).toBe(18);
    expect([map.get(1), map.get(13)]).toEqual([1, 1]); // January 2026 and January 2027
    expect([map.get(6), map.get(18)]).toEqual([6, 6]); // June 2026 and June 2027
    expect(map.get(12)).toBe(12); // December 2026
  });

  it("leaves a target month without counterpart out of the map", () => {
    const short = generateMonthlyPeriods("2026-07-01", "2026-12-31");
    const target = generateMonthlyPeriods("2027-01-01", "2027-12-31");
    const map = calendarMonthMap(short, target);
    expect(map.has(1)).toBe(false);
    expect(map.get(7)).toBe(1);
    expect(map.size).toBe(6);
  });
});

describe("compareGridLines", () => {
  it("orders by account, then cost center code with null first", () => {
    const lines = [
      { accountNumber: "4010", costCenterCode: "200" },
      { accountNumber: "3001", costCenterCode: "100" },
      { accountNumber: "3001", costCenterCode: null },
      { accountNumber: "4010", costCenterCode: "100" },
    ];
    expect([...lines].sort(compareGridLines)).toEqual([
      { accountNumber: "3001", costCenterCode: null },
      { accountNumber: "3001", costCenterCode: "100" },
      { accountNumber: "4010", costCenterCode: "100" },
      { accountNumber: "4010", costCenterCode: "200" },
    ]);
  });
});

describe("buildBudgetedIncomeStatement", () => {
  const balance = (accountNumber: string, debit: number, credit: number) => ({
    accountId: `id-${accountNumber}`,
    accountNumber,
    accountName: `Konto ${accountNumber}`,
    periodDebit: debit,
    periodCredit: credit,
  });

  it("shows budget-only accounts, variance and percent, null percent without budget", () => {
    const body = buildBudgetedIncomeStatement({
      period: [balance("3001", 0, 1000), balance("4010", 600, 0), balance("6110", 50, 0), balance("1930", 0, 350)],
      accumulated: [balance("3001", 0, 2500), balance("4010", 1300, 0), balance("6110", 50, 0)],
      periodBudget: new Map([["3001", 1200], ["4010", -500], ["5010", -100]]),
      accumulatedBudget: new Map([["3001", 2400], ["4010", -1000], ["5010", -200]]),
      accounts: new Map([["5010", { accountId: "id-5010", accountName: "Lokalhyra" }]]),
    });
    expect(variancePercentOf(-200, 1200)).toBe(-16.7);

    const netSales = body.entries.find((e) => e.key === "netSales")!;
    expect(netSales).toMatchObject({ kind: "line", total: 1000, amount: 1000, budget: 1200, variance: -200, variancePercent: -16.7, accumulated: 2500, accumulatedBudget: 2400, accumulatedVariance: 100, accumulatedVariancePercent: 4.2 });
    const rawMaterials = body.entries.find((e) => e.key === "rawMaterials")!;
    expect(rawMaterials).toMatchObject({ amount: -600, budget: -500, variance: -100, variancePercent: -20, accumulated: -1300, accumulatedBudget: -1000, accumulatedVariance: -300, accumulatedVariancePercent: -30 });
    const external = body.entries.find((e) => e.key === "otherExternalCosts")!;
    expect(external.kind).toBe("line");
    if (external.kind !== "line") throw new Error("unreachable");
    expect(external.accounts.map((a) => [a.accountNumber, a.accountName, a.amount, a.budget, a.variance, a.variancePercent])).toEqual([
      ["5010", "Lokalhyra", 0, -100, 100, 100],
      ["6110", "Konto 6110", -50, 0, -50, null],
    ]);
    expect(external.accounts.map((a) => a.accountId)).toEqual(["id-5010", "id-6110"]);
    expect(external).toMatchObject({ amount: -50, budget: -100, variance: 50, variancePercent: 50 });

    // The bank row is not an income statement account and never appears.
    expect(body.entries.flatMap((e) => (e.kind === "line" ? e.accounts.map((a) => a.accountNumber) : []))).not.toContain("1930");

    const operating = body.entries.find((e) => e.key === "operatingResult")!;
    expect(operating).toMatchObject({ kind: "subtotal", total: 350, budget: 600, variance: -250, variancePercent: -41.7, accumulated: 1150, accumulatedBudget: 1200 });
    expect(body).toMatchObject({
      result: 350,
      resultBudget: 600,
      resultVariance: -250,
      resultVariancePercent: -41.7,
      resultAccumulated: 1150,
      resultAccumulatedBudget: 1200,
      resultAccumulatedVariance: -50,
      resultAccumulatedVariancePercent: -4.2,
    });
  });

  it("lists a budgeted account the chart has lost with accountId null, never the number", () => {
    const body = buildBudgetedIncomeStatement({
      period: [],
      accumulated: [],
      periodBudget: new Map([["5010", -100]]),
      accumulatedBudget: new Map([["5010", -100]]),
      accounts: new Map(),
    });
    const external = body.entries.find((e) => e.key === "otherExternalCosts")!;
    if (external.kind !== "line") throw new Error("unreachable");
    expect(external.accounts).toEqual([expect.objectContaining({ accountId: null, accountNumber: "5010", accountName: "", amount: 0, budget: -100 })]);
  });

  it("is empty without data and skips lines without accounts", () => {
    const body = buildBudgetedIncomeStatement({ period: [], accumulated: [], periodBudget: new Map(), accumulatedBudget: new Map(), accounts: new Map() });
    expect(body.entries.every((e) => e.kind === "subtotal")).toBe(true);
    expect(body.result).toBe(0);
    expect(body.resultVariancePercent).toBeNull();
  });

  it("flattens to the CSV with every budget column", () => {
    const body = buildBudgetedIncomeStatement({
      period: [balance("3001", 0, 1000)],
      accumulated: [balance("3001", 0, 1000)],
      periodBudget: new Map([["3001", 800]]),
      accumulatedBudget: new Map([["3001", 800]]),
      accounts: new Map(),
    });
    const csv = buildBudgetedIncomeStatementCsv(body);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Konto;Benämning;Utfall;Budget;Avvikelse;Avvikelse %;Utfall ack.;Budget ack.;Avvikelse ack.;Avvikelse ack. %");
    expect(lines[1]).toBe("3001;Konto 3001;1000,00;800,00;200,00;25;1000,00;800,00;200,00;25");
    expect(lines.at(-2)).toBe(";Periodens resultat;1000,00;800,00;200,00;25;1000,00;800,00;200,00;25");
  });
});

describe("budget CSV", () => {
  const resolvers = {
    accountName: (number: string) => ({ "3001": "Försäljning", "4010": "Inköp material", "1930": "Företagskonto" })[number] ?? null,
    costCenterId: (code: string) => ({ "100": "cc-100", "200": "cc-200" })[code] ?? null,
    costCenterCode: (id: string) => ({ "cc-100": "100", "cc-200": "200" })[id] ?? null,
  };

  it("exports Konto;Kontonamn;Kostnadsställe;<months>;Summa in grid order", () => {
    const csv = buildBudgetCsv(["2027-01", "2027-02", "2027-03"], [
      { accountNumber: "3001", accountName: "Försäljning", costCenterId: null, costCenterCode: null, amounts: [1000, 1000.5, 0] },
      { accountNumber: "4010", accountName: "Inköp material", costCenterId: "cc-100", costCenterCode: "100", amounts: [400, 0, 0] },
    ]);
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("Konto;Kontonamn;Kostnadsställe;2027-01;2027-02;2027-03;Summa");
    expect(lines[1]).toBe("3001;Försäljning;;1000,00;1000,50;0,00;2000,50");
    expect(lines[2]).toBe("4010;Inköp material;100;400,00;0,00;0,00;400,00");
  });

  it("guards a cost center code that looks like a formula in Excel, and reads it back", () => {
    const codes = { "cc-minus": "-10", "cc-eq": "=SUM(A1)" } as const;
    const formulaResolvers = {
      ...resolvers,
      costCenterId: (code: string) => Object.entries(codes).find(([, c]) => c === code)?.[0] ?? null,
      costCenterCode: (id: string) => codes[id as keyof typeof codes] ?? null,
    };
    const csv = buildBudgetCsv(["2027-01"], [
      { accountNumber: "4010", accountName: "Inköp material", costCenterId: "cc-minus", costCenterCode: "-10", amounts: [400] },
      { accountNumber: "4010", accountName: "Inköp material", costCenterId: "cc-eq", costCenterCode: "=SUM(A1)", amounts: [-50] },
    ]);
    const lines = csv.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[1]).toBe("4010;Inköp material;'-10;400,00;400,00");
    expect(lines[2]).toBe("4010;Inköp material;'=SUM(A1);-50,00;-50,00");
    const { headers, rows } = parseCsvBuffer(Buffer.from(csv, "utf8"));
    const result = parseBudgetCsv([headers, ...rows], 1, formulaResolvers);
    expect(result.errors).toEqual([]);
    expect(result.lines.map((line) => [line.costCenterId, line.amounts])).toEqual([
      ["cc-minus", [400]],
      ["cc-eq", [-50]],
    ]);
  });

  it("parses the same form back, by column position, with decimal comma and spaces", () => {
    const text = [
      "Konto;Kontonamn;Kostnadsställe;jan;feb;mar;Summa",
      "4010;vad som helst;100;1 234,56;;-20;9999",
      "3001;;;1000;1000;1000;3000",
      // All zeros on another cost center: silently skipped (a duplicate key would be an error).
      "3001;;200;0;0;;0",
      "",
    ].join("\r\n");
    const { headers, rows } = parseCsvBuffer(Buffer.from("﻿" + text, "utf8"));
    const result = parseBudgetCsv([headers, ...rows], 3, resolvers);
    expect(result.errors).toEqual([]);
    expect(result.lines).toEqual([
      { accountNumber: "3001", accountName: "Försäljning", costCenterId: null, amounts: [1000, 1000, 1000] },
      { accountNumber: "4010", accountName: "Inköp material", costCenterId: "cc-100", amounts: [1234.56, 0, -20] },
    ]);
  });

  it("reports unknown account, non-budgetable account, unknown cost center, bad amount and duplicates per row", () => {
    const records = [
      ["Konto", "Kontonamn", "Kostnadsställe", "jan", "feb"],
      ["4711", "", "", "1", "2"],
      ["1930", "", "", "1", "2"],
      ["3001", "", "999", "1", "2"],
      ["3001", "", "", "abc", "2"],
      ["3001", "", "", "1", "2"],
      ["3001", "", "", "3", "4"],
      ["30", "", "", "3", "4"],
    ];
    const result = parseBudgetCsv(records, 2, resolvers);
    expect(result.lines).toEqual([{ accountNumber: "3001", accountName: "Försäljning", costCenterId: null, amounts: [1, 2] }]);
    expect(result.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 7, 8]);
    expect(result.errors[0]!.message).toContain("4711");
    expect(result.errors[2]!.message).toContain("999");
    expect(result.errors[3]!.message).toContain("abc");
    expect(result.errors[4]!.message).toContain("flera gånger");
  });

  it("round-trips an export", () => {
    const monthLabels = ["2027-01", "2027-02"];
    const exported = buildBudgetCsv(monthLabels, [
      { accountNumber: "3001", accountName: "Försäljning", costCenterId: "cc-200", costCenterCode: "200", amounts: [12.5, -3] },
    ]);
    const { headers, rows } = parseCsvBuffer(Buffer.from(exported, "utf8"));
    expect(parseBudgetCsv([headers, ...rows], 2, resolvers)).toEqual({
      lines: [{ accountNumber: "3001", accountName: "Försäljning", costCenterId: "cc-200", amounts: [12.5, -3] }],
      errors: [],
    });
  });
});
