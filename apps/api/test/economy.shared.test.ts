import { describe, expect, it } from "vitest";
import {
  balanceSheetQuerySchema,
  createAccountSchema,
  createPostingRuleSchema,
  generalLedgerQuerySchema,
  incomeStatementQuerySchema,
  postingVatRateSchema,
  updateAccountSchema,
  updatePostingRuleSchema,
  vatBoxSettingSchema,
  verificationListReportQuerySchema,
} from "@navet/shared";

describe("momsruta på kontot", () => {
  it("accepts every reportable box, 'none' and null, and rejects box 49 and junk", () => {
    for (const box of ["05", "10", "11", "12", "35", "36", "42", "48", "none"]) {
      expect(vatBoxSettingSchema.safeParse(box).success).toBe(true);
    }
    expect(vatBoxSettingSchema.safeParse("49").success).toBe(false);
    expect(vatBoxSettingSchema.safeParse("5").success).toBe(false);
    expect(createAccountSchema.safeParse({ number: "3010", name: "X", vatBox: null }).success).toBe(true);
  });

  it("keeps an omitted vatBox undefined on create (the service applies the BAS default)", () => {
    const parsed = createAccountSchema.parse({ number: "3010", name: "X" });
    expect("vatBox" in parsed ? parsed.vatBox : undefined).toBeUndefined();
  });

  it("lets a PATCH carry only vatBox, including null", () => {
    expect(updateAccountSchema.parse({ vatBox: null })).toEqual({ vatBox: null });
    expect(updateAccountSchema.parse({ vatBox: "05" })).toEqual({ vatBox: "05" });
  });
});

describe("postingVatRateSchema", () => {
  it("accepts the four rates the poster resolves", () => {
    for (const rate of [0, 6, 12, 25]) {
      expect(postingVatRateSchema.parse(rate)).toBe(rate);
    }
  });

  it("coerces numeric strings (query params, form inputs)", () => {
    expect(postingVatRateSchema.parse("25")).toBe(25);
  });

  it("rejects rates outside the whitelist", () => {
    expect(() => postingVatRateSchema.parse(21.5)).toThrow();
    expect(() => postingVatRateSchema.parse(100)).toThrow();
    expect(() => postingVatRateSchema.parse(-25)).toThrow();
  });

  // Number("") is 0, so plain coercion would turn an empty field into a
  // silent 0 % rule instead of a validation error.
  it("rejects a blank string instead of coercing it to a 0 % rule", () => {
    expect(() => postingVatRateSchema.parse("")).toThrow();
    expect(() => postingVatRateSchema.parse("   ")).toThrow();
  });
});

describe("createPostingRuleSchema", () => {
  const articleGroupId = "11111111-1111-1111-1111-111111111111";
  const accountId = "22222222-2222-2222-2222-222222222222";

  it("defaults vatRate/accounts to null (the group's catch-all rule) when only one account is set", () => {
    const parsed = createPostingRuleSchema.parse({ articleGroupId, revenueAccountId: accountId });
    expect(parsed).toEqual({
      articleGroupId,
      vatRate: null,
      revenueAccountId: accountId,
      costAccountId: null,
    });
  });

  it("accepts a rule with only costAccountId set", () => {
    expect(() => createPostingRuleSchema.parse({ articleGroupId, costAccountId: accountId })).not.toThrow();
  });

  // An API consumer sending an empty vatRate must be told, not handed a
  // 0 % rule (Number("") === 0).
  it("rejects a blank vatRate instead of creating a 0 % rule", () => {
    expect(() =>
      createPostingRuleSchema.parse({ articleGroupId, vatRate: "", revenueAccountId: accountId })
    ).toThrow();
  });

  it("accepts a rule with both accounts set", () => {
    expect(() =>
      createPostingRuleSchema.parse({ articleGroupId, revenueAccountId: accountId, costAccountId: accountId })
    ).not.toThrow();
  });

  it("rejects a rule with neither account set", () => {
    expect(() => createPostingRuleSchema.parse({ articleGroupId })).toThrow();
    expect(() =>
      createPostingRuleSchema.parse({ articleGroupId, revenueAccountId: null, costAccountId: null })
    ).toThrow();
  });
});

describe("updatePostingRuleSchema", () => {
  const accountId = "22222222-2222-2222-2222-222222222222";

  it("rejects an empty patch", () => {
    expect(() => updatePostingRuleSchema.parse({})).toThrow();
  });

  it("accepts a patch that only touches vatRate (accounts untouched)", () => {
    expect(() => updatePostingRuleSchema.parse({ vatRate: 6 })).not.toThrow();
  });

  it("rejects a blank vatRate in a patch (never silently 0 %)", () => {
    expect(() => updatePostingRuleSchema.parse({ vatRate: "" })).toThrow();
  });

  it("rejects a patch that explicitly nulls out both accounts", () => {
    expect(() => updatePostingRuleSchema.parse({ revenueAccountId: null, costAccountId: null })).toThrow();
  });

  it("accepts a patch that sets one account, leaving the other untouched", () => {
    expect(() => updatePostingRuleSchema.parse({ costAccountId: accountId })).not.toThrow();
  });
});

describe("balanceSheetQuerySchema", () => {
  it("accepts a valid date", () => {
    expect(balanceSheetQuerySchema.parse({ asOf: "2026-12-31" }).asOf).toBe("2026-12-31");
  });

  it("rejects a malformed date and a missing one", () => {
    expect(() => balanceSheetQuerySchema.parse({ asOf: "2026-13-01" })).toThrow();
    expect(() => balanceSheetQuerySchema.parse({})).toThrow();
  });
});

describe("incomeStatementQuerySchema", () => {
  it("accepts a range and a single day", () => {
    expect(() => incomeStatementQuerySchema.parse({ from: "2026-01-01", to: "2026-12-31" })).not.toThrow();
    expect(() => incomeStatementQuerySchema.parse({ from: "2026-05-05", to: "2026-05-05" })).not.toThrow();
  });

  it("rejects to before from", () => {
    expect(() => incomeStatementQuerySchema.parse({ from: "2026-12-31", to: "2026-01-01" })).toThrow();
  });
});

describe("generalLedgerQuerySchema", () => {
  const range = { from: "2026-01-01", to: "2026-12-31" };

  it("accepts a bare range and defaults onlyWithMovement to true", () => {
    expect(generalLedgerQuerySchema.parse(range).onlyWithMovement).toBe(true);
  });

  it("only turns onlyWithMovement off for the literal string false", () => {
    expect(generalLedgerQuerySchema.parse({ ...range, onlyWithMovement: "false" }).onlyWithMovement).toBe(false);
    expect(generalLedgerQuerySchema.parse({ ...range, onlyWithMovement: "true" }).onlyWithMovement).toBe(true);
  });

  it("rejects an account number that is not exactly four digits", () => {
    expect(() => generalLedgerQuerySchema.parse({ ...range, accountFrom: "193" })).toThrow();
    expect(() => generalLedgerQuerySchema.parse({ ...range, accountFrom: "19300" })).toThrow();
  });

  it("rejects accountTo before accountFrom but allows one without the other", () => {
    expect(() =>
      generalLedgerQuerySchema.parse({ ...range, accountFrom: "3000", accountTo: "1000" })
    ).toThrow();
    expect(() => generalLedgerQuerySchema.parse({ ...range, accountFrom: "3000" })).not.toThrow();
    expect(() => generalLedgerQuerySchema.parse({ ...range, accountTo: "3000" })).not.toThrow();
  });
});

describe("verificationListReportQuerySchema", () => {
  it("accepts an empty query — the printout may be unfiltered", () => {
    expect(() => verificationListReportQuerySchema.parse({})).not.toThrow();
  });

  it("parses a comma-separated status list", () => {
    expect(verificationListReportQuerySchema.parse({ status: "draft,booked" }).status).toEqual([
      "draft",
      "booked",
    ]);
  });

  it("rejects an unknown status and a reversed date range", () => {
    expect(() => verificationListReportQuerySchema.parse({ status: "posted" })).toThrow();
    expect(() =>
      verificationListReportQuerySchema.parse({ from: "2026-12-31", to: "2026-01-01" })
    ).toThrow();
  });
});
