import { describe, expect, it } from "vitest";
// The budget helpers have no imports, so vitest can load them directly.
import {
  amountText,
  distributeAnnual,
  distributeRow,
  isBudgetableAccount,
  isRevenueAccount,
  monthShortLabel,
  monthSums,
  parseAmount,
  rowsSignature,
  toPutLines,
  type BudgetEditRow,
} from "../../web/lib/budget.js";

const sum = (a: number[]) => Math.round(a.reduce((s, v) => s + v, 0) * 100) / 100;

function row(accountNumber: string, amounts: string[], annual: string | null = null): BudgetEditRow {
  return { key: accountNumber, accountNumber, accountName: "", amounts, annual };
}

describe("Fördela årsbelopp jämnt", () => {
  it("gives whole kronor rounded down, the last month takes the rest", () => {
    const parts = distributeAnnual(1000, 12);
    expect(parts).toHaveLength(12);
    expect(parts.slice(0, 11).every((p) => p === 83)).toBe(true);
    expect(parts[11]).toBe(87);
    expect(sum(parts)).toBe(1000);
  });

  it("is exact when the amount divides evenly", () => {
    expect(distributeAnnual(120000, 12)).toEqual(new Array(12).fill(10000));
  });

  it("mirrors a negative amount symmetrically", () => {
    const positive = distributeAnnual(1000, 12);
    const negative = distributeAnnual(-1000, 12);
    expect(negative).toEqual(positive.map((p) => -p));
    expect(sum(negative)).toBe(-1000);
  });

  it("keeps öre in the last month", () => {
    const parts = distributeAnnual(1000.5, 12);
    expect(parts.slice(0, 11).every((p) => p === 83)).toBe(true);
    expect(parts[11]).toBe(87.5);
    expect(sum(parts)).toBe(1000.5);
  });

  it("handles fewer or more periods than twelve and tiny amounts", () => {
    expect(distributeAnnual(1000, 1)).toEqual([1000]);
    const parts = distributeAnnual(1000, 18);
    expect(parts).toHaveLength(18);
    expect(sum(parts)).toBe(1000);
    // Less than one krona per month: everything lands in the last month.
    expect(distributeAnnual(5, 12)).toEqual([...new Array(11).fill(0), 5]);
    expect(distributeAnnual(0, 12)).toEqual(new Array(12).fill(0));
  });

  it("rejects unusable input", () => {
    expect(distributeAnnual(Number.NaN, 12)).toEqual([]);
    expect(distributeAnnual(1000, 0)).toEqual([]);
  });

  it("never loses a krona over a range of amounts and period counts", () => {
    for (const total of [1, 99, 100, 12345, 99999.99, -777, -12345.67]) {
      for (const months of [1, 2, 7, 11, 12, 13, 18, 24]) {
        expect(sum(distributeAnnual(total, months))).toBe(total);
      }
    }
  });

  it("distributeRow uses the typed annual amount, else the current sum", () => {
    const typed = distributeRow(row("3010", ["", "", "", "", "", "", "", "", "", "", "", ""], "1200"));
    expect(typed.annual).toBeNull();
    expect(typed.amounts).toEqual(new Array(12).fill("100"));
    const sumOnly = distributeRow(row("3010", ["1200", "", "", "", "", "", "", "", "", "", "", ""]));
    expect(sumOnly.amounts).toEqual(new Array(12).fill("100"));
    const empty = distributeRow(row("3010", new Array(12).fill("")));
    expect(empty.amounts).toEqual(new Array(12).fill(""));
  });
});

describe("account natures", () => {
  it("treats 3000-3999 and 8000-8399 as revenue, the rest of 3-8 as cost", () => {
    for (const a of ["3000", "3010", "3999", "8000", "8310", "8399"]) expect(isRevenueAccount(a)).toBe(true);
    for (const a of ["4010", "5010", "7010", "7999", "8400", "8999", "8989", "abc"]) expect(isRevenueAccount(a)).toBe(false);
  });

  it("budgets class 3-8 except the booked year result", () => {
    for (const a of ["3000", "4010", "7210", "8400", "8989"]) expect(isBudgetableAccount(a)).toBe(true);
    for (const a of ["1930", "2640", "2999", "8990", "8999", "9999", "301", "30100"]) expect(isBudgetableAccount(a)).toBe(false);
  });
});

describe("grid maths", () => {
  it("sums revenue, costs and result per month", () => {
    const sums = monthSums([row("3010", ["1000", "2000"]), row("4010", ["300", ""]), row("", ["99", "99"])], 2);
    expect(sums.revenue).toEqual([1000, 2000]);
    expect(sums.costs).toEqual([300, 0]);
    expect(sums.result).toEqual([700, 2000]);
  });

  it("parses typed amounts", () => {
    expect(parseAmount("")).toBe(0);
    expect(parseAmount("1 234,5")).toBe(1234.5);
    expect(parseAmount("-12.5")).toBe(-12.5);
    expect(amountText(0)).toBe("");
    expect(amountText(12.5)).toBe("12.5");
  });

  it("labels months", () => {
    expect(monthShortLabel("2026-01")).toBe("jan 26");
    expect(monthShortLabel("2025-12")).toBe("dec 25");
  });

  it("signature ignores blank rows and spelling of zero", () => {
    const a = rowsSignature([row("3010", ["100", ""]), row("", ["", ""])]);
    const b = rowsSignature([row("3010", ["100", "0"])]);
    expect(a).toBe(b);
    expect(rowsSignature([row("3010", ["101", ""])])).not.toBe(a);
  });

  it("builds the PUT lines and refuses an amount without account or a duplicate", () => {
    expect(toPutLines([row("3010", ["100", "0"]), row("", ["", ""])])).toEqual({
      lines: [{ accountNumber: "3010", amounts: [100, 0] }],
      error: null,
    });
    expect(toPutLines([row("", ["5", ""])]).error).not.toBeNull();
    expect(toPutLines([row("3010", ["1"]), row("3010", ["2"])]).error).toContain("3010");
  });
});
