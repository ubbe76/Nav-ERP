import { describe, expect, it } from "vitest";
import {
  accrualAmounts,
  addDays,
  addMonthsToDate,
  inventoryAmounts,
  mirrorAmounts,
  nextFiscalYearBounds,
  profitDispositionAmounts,
  resultTransferAmounts,
  sameAccrualSet,
  toDebitCredit,
} from "../src/modules/economy/service/year-end-calc.js";

describe("datum och nästa räkenskapsår", () => {
  it("adds days and months across year and month ends", () => {
    expect(addDays("2024-12-31", 1)).toBe("2025-01-01");
    expect(addDays("2025-01-01", -1)).toBe("2024-12-31");
    expect(addMonthsToDate("2025-01-01", 12)).toBe("2026-01-01");
    expect(addMonthsToDate("2024-01-31", 1)).toBe("2024-02-29");
  });

  it("proposes a calendar year after a calendar year", () => {
    expect(nextFiscalYearBounds({ endDate: "2024-12-31" })).toEqual({ label: "2025", startDate: "2025-01-01", endDate: "2025-12-31" });
  });

  // Review Focus 3: brutet år.
  it("proposes a brutet år after a brutet år, labelled start/end", () => {
    expect(nextFiscalYearBounds({ endDate: "2024-04-30" })).toEqual({
      label: "2024/25",
      startDate: "2024-05-01",
      endDate: "2025-04-30",
    });
    // A year ending on a leap day: the next one ends on 28 February.
    expect(nextFiscalYearBounds({ endDate: "2024-02-29" })).toEqual({
      label: "2024/25",
      startDate: "2024-03-01",
      endDate: "2025-02-28",
    });
  });
});

const INV = "inv-1460";
const CHANGE = "chg-4990";

describe("inventoryAmounts", () => {
  it("debits the inventory account on an increase", () => {
    expect(inventoryAmounts({ inventoryAccountId: INV, changeAccountId: CHANGE, value: 212450, ledgerBalance: 180000 })).toEqual({
      difference: 32450,
      amounts: [
        { accountId: INV, amount: 32450 },
        { accountId: CHANGE, amount: -32450 },
      ],
    });
  });

  it("credits the inventory account on a decrease and books nothing at zero", () => {
    expect(inventoryAmounts({ inventoryAccountId: INV, changeAccountId: CHANGE, value: 150000, ledgerBalance: 180000 }).amounts).toEqual([
      { accountId: INV, amount: -30000 },
      { accountId: CHANGE, amount: 30000 },
    ]);
    expect(inventoryAmounts({ inventoryAccountId: INV, changeAccountId: CHANGE, value: 180000, ledgerBalance: 180000 })).toEqual({
      difference: 0,
      amounts: [],
    });
  });
});

describe("accrualAmounts", () => {
  const rows = [
    { kind: "prepaid_expense" as const, balanceAccountId: "1710", resultAccountId: "5010", amount: 25000 },
    { kind: "accrued_expense" as const, balanceAccountId: "2990", resultAccountId: "5020", amount: 8400 },
    { kind: "accrued_income" as const, balanceAccountId: "1790", resultAccountId: "3001", amount: 12000 },
    { kind: "prepaid_income" as const, balanceAccountId: "2990", resultAccountId: "3001", amount: 500 },
  ];

  it("debits the balance account for asset kinds and credits it for liability kinds", () => {
    expect(accrualAmounts(rows)).toEqual([
      { accountId: "1710", amount: 25000 },
      { accountId: "5010", amount: -25000 },
      { accountId: "2990", amount: -8400 },
      { accountId: "5020", amount: 8400 },
      { accountId: "1790", amount: 12000 },
      { accountId: "3001", amount: -12000 },
      { accountId: "2990", amount: -500 },
      { accountId: "3001", amount: 500 },
    ]);
  });

  it("mirrors every amount for the reversal and nets per account in toDebitCredit", () => {
    expect(mirrorAmounts([{ accountId: "a", amount: 10 }])).toEqual([{ accountId: "a", amount: -10 }]);
    expect(toDebitCredit(accrualAmounts(rows))).toEqual([
      { accountId: "1710", debit: 25000, credit: 0 },
      { accountId: "5010", debit: 0, credit: 25000 },
      { accountId: "2990", debit: 0, credit: 8900 },
      { accountId: "5020", debit: 8400, credit: 0 },
      { accountId: "1790", debit: 12000, credit: 0 },
      { accountId: "3001", debit: 0, credit: 11500 },
    ]);
  });

  it("compares accrual sets field by field and in order", () => {
    const a = [{ ...rows[0]!, description: "Hyra" }];
    expect(sameAccrualSet(a, [{ ...rows[0]!, description: "Hyra" }])).toBe(true);
    expect(sameAccrualSet(a, [{ ...rows[0]!, description: "Hyra jan" }])).toBe(false);
    expect(sameAccrualSet(a, [{ ...rows[0]!, amount: 25000.004, description: "Hyra" }])).toBe(true);
    expect(sameAccrualSet(a, [])).toBe(false);
  });
});

describe("resultTransferAmounts", () => {
  it("debits 8999 and credits 2099 on a profit, the reverse on a loss, nothing at zero", () => {
    expect(resultTransferAmounts({ net: 437250, resultAccountId: "8999", equityAccountId: "2099" })).toEqual([
      { accountId: "8999", amount: 437250 },
      { accountId: "2099", amount: -437250 },
    ]);
    expect(resultTransferAmounts({ net: -85000, resultAccountId: "8999", equityAccountId: "2099" })).toEqual([
      { accountId: "8999", amount: -85000 },
      { accountId: "2099", amount: 85000 },
    ]);
    expect(resultTransferAmounts({ net: 0, resultAccountId: "8999", equityAccountId: "2099" })).toEqual([]);
  });
});

describe("profitDispositionAmounts", () => {
  const ids = { resultEquityAccountId: "2099", retainedAccountId: "2091", dividendAccountId: "2898" };

  it("empties 2099, credits the dividend and puts the rest on 2091", () => {
    expect(profitDispositionAmounts({ ...ids, resultAmount: 437250, dividend: 150000 })).toEqual([
      { accountId: "2099", amount: 437250 },
      { accountId: "2898", amount: -150000 },
      { accountId: "2091", amount: -287250 },
    ]);
  });

  it("handles a loss with and without a dividend", () => {
    expect(profitDispositionAmounts({ ...ids, resultAmount: -85000, dividend: 0 })).toEqual([
      { accountId: "2099", amount: -85000 },
      { accountId: "2091", amount: 85000 },
    ]);
    expect(profitDispositionAmounts({ ...ids, resultAmount: -85000, dividend: 50000 })).toEqual([
      { accountId: "2099", amount: -85000 },
      { accountId: "2898", amount: -50000 },
      { accountId: "2091", amount: 135000 },
    ]);
  });
});
