import { describe, expect, it } from "vitest";
import {
  BALANCE_SHEET_GROUPS,
  INCOME_STATEMENT_ENTRIES,
  classifyAccount,
} from "../src/modules/economy/service/bas-report-lines.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import {
  buildBalanceSheet,
  buildIncomeStatement,
} from "../src/modules/economy/service/financial-reports.service.js";
import type { AccountBalance } from "../src/modules/economy/service/account-balances.js";

// Pure table tests — no database, no TRUNCATE. This file must stay
// millisecond-fast so the classification can be iterated on freely.

function countIntervalHits(accountNumber: string): number {
  let hits = 0;
  for (const group of BALANCE_SHEET_GROUPS) {
    for (const line of group.lines) {
      for (const [low, high] of line.intervals) {
        if (accountNumber >= low && accountNumber <= high) hits++;
      }
    }
  }
  for (const entry of INCOME_STATEMENT_ENTRIES) {
    if (entry.kind !== "line") continue;
    for (const [low, high] of entry.intervals) {
      if (accountNumber >= low && accountNumber <= high) hits++;
    }
  }
  return hits;
}

describe("BAS report intervals", () => {
  it("covers 0000–9999 exactly once", () => {
    const uncovered: string[] = [];
    const overlapping: string[] = [];
    for (let n = 0; n <= 9999; n++) {
      const number = String(n).padStart(4, "0");
      const hits = countIntervalHits(number);
      if (hits === 0) uncovered.push(number);
      if (hits > 1) overlapping.push(number);
    }
    expect(uncovered).toEqual([]);
    expect(overlapping).toEqual([]);
  });

  it("classifies every account in the seeded BAS chart", () => {
    for (const account of BAS_STANDARD_ACCOUNTS) {
      expect(() => classifyAccount(account.number)).not.toThrow();
    }
  });

  it.each([
    ["1010", "intangibleAssets"],
    ["1119", "buildingsAndLand"],
    ["1219", "machineryAndEquipment"],
    ["1410", "inventory"],
    ["1510", "accountsReceivable"],
    ["1650", "otherReceivables"],
    ["1790", "prepaidExpenses"],
    ["1930", "cashAndBank"],
    ["2081", "restrictedEquity"],
    ["2091", "unrestrictedEquity"],
    ["2099", "unrestrictedEquity"],
    ["2110", "untaxedReserves"],
    ["2350", "longTermLiabilities"],
    ["2440", "accountsPayable"],
    ["2510", "taxLiabilities"],
    ["2610", "otherCurrentLiabilities"],
    ["2650", "otherCurrentLiabilities"],
    ["2920", "accruedExpenses"],
  ])("puts %s on the balance sheet line %s", (number, lineKey) => {
    const result = classifyAccount(number);
    expect(result).toMatchObject({ report: "balanceSheet", lineKey });
  });

  it.each([
    ["3001", "netSales"],
    ["3740", "netSales"],
    ["3910", "otherOperatingIncome"],
    ["4010", "rawMaterials"],
    ["4990", "inventoryChange"],
    ["6110", "otherExternalCosts"],
    ["7010", "personnelCosts"],
    ["7510", "personnelCosts"],
    ["7830", "depreciation"],
    ["7990", "otherOperatingCosts"],
    ["8310", "financialIncome"],
    ["8410", "financialCosts"],
    ["8811", "appropriations"],
    ["8910", "tax"],
    ["8999", "bookedYearResult"],
  ])("puts %s on the income statement line %s", (number, lineKey) => {
    expect(classifyAccount(number)).toEqual({ report: "incomeStatement", lineKey });
  });

  it("sends class 0 and 9 accounts to the unclassified asset line", () => {
    for (const number of ["0000", "0100", "9000", "9999"]) {
      expect(classifyAccount(number)).toMatchObject({
        report: "balanceSheet",
        section: "assets",
        lineKey: "unclassified",
      });
    }
  });

  it("marks the two result lines as computed and gives them no intervals", () => {
    const equity = BALANCE_SHEET_GROUPS.find((g) => g.key === "equity");
    const computed = equity!.lines.filter((line) => line.computed);
    expect(computed.map((line) => line.key)).toEqual(["retainedResult", "yearResult"]);
    for (const line of computed) expect(line.intervals).toEqual([]);
  });

  it("orders income statement subtotals after the lines they summarise", () => {
    expect(INCOME_STATEMENT_ENTRIES[0]!.kind).toBe("line");
    const last = INCOME_STATEMENT_ENTRIES[INCOME_STATEMENT_ENTRIES.length - 1]!;
    expect(last).toMatchObject({ kind: "subtotal", key: "computedResult" });

    const subtotalKeys = INCOME_STATEMENT_ENTRIES.filter((e) => e.kind === "subtotal").map((e) => e.key);
    expect(subtotalKeys).toEqual([
      "operatingResult",
      "resultAfterFinancial",
      "resultBeforeTax",
      "yearResult",
      "computedResult",
    ]);
  });

  it("assigns every balance sheet group to a section", () => {
    for (const group of BALANCE_SHEET_GROUPS) {
      expect(["assets", "equityAndLiabilities"]).toContain(group.section);
    }
  });
});

// --- Pure report builders (no database) ---

let seq = 0;
// opening = booked before the fiscal year start, period = within the year.
function balance(
  accountNumber: string,
  opening: [number, number],
  period: [number, number] = [0, 0]
): AccountBalance {
  seq++;
  return {
    accountId: `acc-${seq}`,
    accountNumber,
    accountName: `Konto ${accountNumber}`,
    openingDebit: opening[0],
    openingCredit: opening[1],
    periodDebit: period[0],
    periodCredit: period[1],
  };
}

function findLine(sheet: ReturnType<typeof buildBalanceSheet>, lineKey: string) {
  for (const section of [sheet.assets, sheet.equityAndLiabilities]) {
    for (const group of section.groups) {
      const line = group.lines.find((l) => l.key === lineKey);
      if (line) return line;
    }
  }
  return undefined;
}

function entryTotal(statement: ReturnType<typeof buildIncomeStatement>, key: string) {
  return statement.entries.find((entry) => entry.key === key)?.total;
}

describe("buildBalanceSheet", () => {
  it("shows assets debit-positive and equity/liabilities credit-positive", () => {
    const sheet = buildBalanceSheet([
      balance("1930", [0, 0], [1000, 0]), // bank, debit
      balance("2440", [0, 0], [0, 1000]), // accounts payable, credit
    ]);
    expect(findLine(sheet, "cashAndBank")!.total).toBe(1000);
    expect(findLine(sheet, "accountsPayable")!.total).toBe(1000);
  });

  it("lets accumulated depreciation reduce the fixed-asset line it sits on", () => {
    const sheet = buildBalanceSheet([
      balance("1210", [0, 0], [100000, 0]),
      balance("1219", [0, 0], [0, 20000]),
    ]);
    expect(findLine(sheet, "machineryAndEquipment")!.total).toBe(80000);
  });

  it("presents a profit as a positive Årets resultat and a loss as negative", () => {
    const profit = buildBalanceSheet([
      balance("1930", [0, 0], [500, 0]),
      balance("3001", [0, 0], [0, 500]),
    ]);
    expect(findLine(profit, "yearResult")!.total).toBe(500);

    const loss = buildBalanceSheet([
      balance("1930", [0, 0], [0, 300]),
      balance("4010", [0, 0], [300, 0]),
    ]);
    expect(findLine(loss, "yearResult")!.total).toBe(-300);
  });

  it("splits result booked before the fiscal year start into Balanserat resultat", () => {
    const sheet = buildBalanceSheet([
      balance("1930", [800, 0], [200, 0]),
      balance("3001", [0, 800], [0, 200]),
    ]);
    expect(findLine(sheet, "retainedResult")!.total).toBe(800);
    expect(findLine(sheet, "yearResult")!.total).toBe(200);
  });

  it("balances: assets equal equity and liabilities, difference is 0", () => {
    const sheet = buildBalanceSheet([
      balance("1930", [0, 0], [12500, 0]),
      balance("1510", [0, 0], [3750, 0]),
      balance("2081", [0, 0], [0, 25000]),
      balance("2440", [0, 0], [0, 5000]),
      balance("2610", [0, 0], [0, 750]),
      balance("3001", [0, 0], [0, 20000]),
      balance("4010", [0, 0], [34500, 0]),
    ]);
    expect(sheet.difference).toBe(0);
    expect(sheet.assets.total).toBe(sheet.equityAndLiabilities.total);
  });

  it("keeps the balance sheet balanced when a class 9 account is posted to", () => {
    const sheet = buildBalanceSheet([
      balance("9000", [0, 0], [400, 0]),
      balance("2890", [0, 0], [0, 400]),
    ]);
    expect(findLine(sheet, "unclassified")!.total).toBe(400);
    expect(sheet.difference).toBe(0);
  });

  it("always renders the two computed equity lines, even at zero", () => {
    const sheet = buildBalanceSheet([balance("1930", [0, 0], [100, 0]), balance("2081", [0, 0], [0, 100])]);
    expect(findLine(sheet, "retainedResult")!.total).toBe(0);
    expect(findLine(sheet, "yearResult")!.total).toBe(0);
    expect(findLine(sheet, "retainedResult")!.computed).toBe(true);
  });

  it("omits lines and groups that have no accounts", () => {
    const sheet = buildBalanceSheet([balance("1930", [0, 0], [100, 0]), balance("2081", [0, 0], [0, 100])]);
    expect(findLine(sheet, "inventory")).toBeUndefined();
    expect(sheet.assets.groups.map((g) => g.key)).toEqual(["currentAssets"]);
  });

  it("omits an account whose balance nets to zero", () => {
    const sheet = buildBalanceSheet([balance("1910", [0, 0], [500, 500])]);
    expect(findLine(sheet, "cashAndBank")).toBeUndefined();
  });

  it("lists the underlying accounts under their line", () => {
    const sheet = buildBalanceSheet([
      balance("1910", [0, 0], [100, 0]),
      balance("1930", [0, 0], [250, 0]),
    ]);
    const line = findLine(sheet, "cashAndBank")!;
    expect(line.accounts.map((a) => a.accountNumber)).toEqual(["1910", "1930"]);
    expect(line.accounts.map((a) => a.amount)).toEqual([100, 250]);
    expect(line.total).toBe(350);
  });
});

describe("buildIncomeStatement", () => {
  it("is credit-positive: revenue positive, costs negative", () => {
    const statement = buildIncomeStatement([
      balance("3001", [0, 0], [0, 10000]),
      balance("4010", [0, 0], [6000, 0]),
    ]);
    expect(entryTotal(statement, "netSales")).toBe(10000);
    expect(entryTotal(statement, "rawMaterials")).toBe(-6000);
  });

  it("uses only the period window, never the opening one", () => {
    const statement = buildIncomeStatement([balance("3001", [0, 99999], [0, 500])]);
    expect(entryTotal(statement, "netSales")).toBe(500);
  });

  it("makes each subtotal a running sum of every line above it", () => {
    const statement = buildIncomeStatement([
      balance("3001", [0, 0], [0, 10000]),
      balance("4010", [0, 0], [6000, 0]),
      balance("8410", [0, 0], [500, 0]),
      balance("8910", [0, 0], [900, 0]),
    ]);
    expect(entryTotal(statement, "operatingResult")).toBe(4000);
    expect(entryTotal(statement, "resultAfterFinancial")).toBe(3500);
    expect(entryTotal(statement, "resultBeforeTax")).toBe(3500);
    expect(entryTotal(statement, "computedResult")).toBe(2600);
    expect(statement.result).toBe(2600);
  });

  it("omits empty lines but keeps every subtotal", () => {
    const statement = buildIncomeStatement([balance("3001", [0, 0], [0, 100])]);
    expect(statement.entries.filter((e) => e.kind === "line").map((e) => e.key)).toEqual(["netSales"]);
    expect(statement.entries.filter((e) => e.kind === "subtotal")).toHaveLength(5);
  });

  it("ignores balance sheet accounts entirely", () => {
    const statement = buildIncomeStatement([balance("1930", [0, 0], [5000, 0])]);
    expect(statement.result).toBe(0);
  });
});
