import { describe, expect, it } from "vitest";
// Pure web helpers, loaded directly (same idiom as web-budget.test.ts).
import { counterRow, emptyRow, rowTotals } from "../../web/lib/verificationRows.js";
import { currentFiscalYear } from "../../web/lib/fiscalYear.js";
import { distributePending, hasPendingAnnual, rowsSignature } from "../../web/lib/budget.js";

describe("rowTotals", () => {
  it("rounds per row, like the server, so 10,004 + 10,004 against 20,01 is not balanced", () => {
    const rows = [
      emptyRow({ accountNumber: "1930", debit: "10.004" }),
      emptyRow({ accountNumber: "1510", debit: "10.004" }),
      emptyRow({ accountNumber: "3010", credit: "20.01" }),
    ];
    const totals = rowTotals(rows);
    expect(totals.debit).toBe(20);
    expect(totals.credit).toBe(20.01);
    expect(totals.diff).toBe(-0.01);
  });

  it("keeps counterRow on the balancing side", () => {
    const counter = counterRow([emptyRow({ accountNumber: "1930", debit: "100" })]);
    expect(counter.credit).not.toBe("");
    expect(counter.debit).toBe("");
  });
});

describe("currentFiscalYear", () => {
  const years = [
    { startDate: "2027-01-01", endDate: "2027-12-31" },
    { startDate: "2026-01-01", endDate: "2026-12-31" },
  ];
  it("picks the year covering today, not the newest future one", () => {
    expect(currentFiscalYear(years, "2026-11-11")).toBe(years[1]);
  });
  it("falls back to the newest, or undefined when none exist", () => {
    expect(currentFiscalYear(years, "2030-01-01")).toBe(years[0]);
    expect(currentFiscalYear([], "2026-11-11")).toBeUndefined();
  });
});

describe("pending annual budget amount", () => {
  const base = { key: "a", accountNumber: "3010", accountName: "", amounts: ["", "", "", ""], annual: null };
  it("counts as an unsaved change and is distributed before saving", () => {
    const typed = { ...base, annual: "1200" };
    expect(rowsSignature([typed])).not.toBe(rowsSignature([base]));
    expect(hasPendingAnnual(typed)).toBe(true);
    expect(distributePending(typed).amounts.map(Number)).toEqual([300, 300, 300, 300]);
  });
  it("leaves an emptied Summa field alone", () => {
    const cleared = { ...base, amounts: ["1", "2", "3", "4"], annual: "" };
    expect(distributePending(cleared)).toBe(cleared);
  });
});
