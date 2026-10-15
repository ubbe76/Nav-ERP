import { describe, expect, it } from "vitest";
import {
  ACCRUAL_KIND_BALANCE_SIDE,
  YEAR_END_ACCRUAL_KIND_LABELS,
  YEAR_END_ROLE_LABELS,
  YEAR_END_STEP_LABELS,
  accrualRowInputSchema,
  bookAccrualsSchema,
  profitDispositionSchema,
  reopenYearEndClosingSchema,
} from "@navet/shared";
import { accrualAmounts, toDebitCredit } from "../src/modules/economy/service/year-end-calc.js";
import * as web from "../../web/lib/yearEnd.js";

const ROW = {
  kind: "prepaid_expense",
  balanceAccountId: "11111111-1111-4111-8111-111111111111",
  resultAccountId: "22222222-2222-4222-8222-222222222222",
  amount: "25000",
  description: "Hyra januari",
};

describe("year-end zod", () => {
  it("coerces the amount and refuses zero, equal accounts and blank text", () => {
    expect(accrualRowInputSchema.parse(ROW).amount).toBe(25000);
    expect(accrualRowInputSchema.safeParse({ ...ROW, amount: 0 }).success).toBe(false);
    expect(accrualRowInputSchema.safeParse({ ...ROW, resultAccountId: ROW.balanceAccountId }).success).toBe(false);
    expect(accrualRowInputSchema.safeParse({ ...ROW, description: "  " }).success).toBe(false);
  });

  // An amount that rounds to 0,00 would reach the poster as a zero row.
  it("refuses an amount with more than 2 decimals", () => {
    expect(accrualRowInputSchema.safeParse({ ...ROW, amount: 0.001 }).success).toBe(false);
    expect(accrualRowInputSchema.safeParse({ ...ROW, amount: "12.345" }).success).toBe(false);
    expect(accrualRowInputSchema.parse({ ...ROW, amount: "1234.56" }).amount).toBe(1234.56);
    expect(accrualRowInputSchema.parse({ ...ROW, amount: 0.07 }).amount).toBe(0.07);
  });

  it("caps the accrual set at 100 rows and accepts an empty set", () => {
    expect(bookAccrualsSchema.safeParse({ rows: [] }).success).toBe(true);
    expect(bookAccrualsSchema.safeParse({ rows: Array.from({ length: 101 }, () => ROW) }).success).toBe(false);
  });

  it("requires a reopen reason of at least 5 characters and defaults the dividend to 0", () => {
    expect(reopenYearEndClosingSchema.safeParse({ reason: "kort" }).success).toBe(false);
    expect(profitDispositionSchema.parse({ agmDate: "2025-05-20" }).dividendAmount).toBe(0);
    expect(profitDispositionSchema.safeParse({ agmDate: "2025-05-20", dividendAmount: -1 }).success).toBe(false);
  });
});

describe("year-end — web mirror", () => {
  it("has the same labels and sign table as @navet/shared", () => {
    expect(web.YEAR_END_ACCRUAL_KIND_LABELS).toEqual(YEAR_END_ACCRUAL_KIND_LABELS);
    expect(web.ACCRUAL_KIND_BALANCE_SIDE).toEqual(ACCRUAL_KIND_BALANCE_SIDE);
    expect(web.YEAR_END_STEP_LABELS).toEqual(YEAR_END_STEP_LABELS);
    expect(web.YEAR_END_ROLE_LABELS).toEqual(YEAR_END_ROLE_LABELS);
  });

  it("previews the same kontering the API books", () => {
    const rows = [
      { kind: "prepaid_expense" as const, balanceAccountId: "1710", resultAccountId: "5010", amount: 25000 },
      { kind: "accrued_expense" as const, balanceAccountId: "2990", resultAccountId: "5020", amount: 8400 },
      { kind: "prepaid_income" as const, balanceAccountId: "2990", resultAccountId: "3001", amount: 500.005 },
    ];
    expect(web.accrualPreview(rows)).toEqual(toDebitCredit(accrualAmounts(rows)));
  });

  it("defaults to the oldest ended open year, else the current one", () => {
    const years = [
      { id: "2026", startDate: "2026-01-01", endDate: "2026-12-31", status: "open" as const },
      { id: "2025", startDate: "2025-01-01", endDate: "2025-12-31", status: "open" as const },
      { id: "2024", startDate: "2024-01-01", endDate: "2024-12-31", status: "closed" as const },
    ];
    expect(web.defaultFiscalYearId(years, "2026-02-10")).toBe("2025");
    expect(web.defaultFiscalYearId(years.map((y) => ({ ...y, status: "closed" as const })), "2026-02-10")).toBe("2026");
    expect(web.defaultFiscalYearId([], "2026-02-10")).toBeNull();
  });

  // A reload restores new-1…new-N from localStorage; the next added row must
  // not reuse one of those keys.
  it("continues the new-row counter after the highest restored id", () => {
    expect(web.highestNewRowSeq([])).toBe(0);
    expect(web.highestNewRowSeq(["new-1", "new-3", "8f2c0e4a-0000-4000-8000-000000000000", "new-2"])).toBe(3);
    expect(web.highestNewRowSeq(["new-x", "renew-9"])).toBe(0);
  });
});
