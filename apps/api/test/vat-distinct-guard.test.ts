import { describe, expect, it } from "vitest";
import { assertDistinctVatAccounts } from "../src/modules/economy/service/vat-report.service.js";
import { VatAccountsNotDistinctError } from "../src/modules/economy/service/vat-report.service.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";

// Pure guard tests — no database. Since momsrutan moved onto the account,
// the guard only protects the momsomföring: each VAT role and the
// redovisningskonto on its own account. postingRevenue0 no longer feeds the
// report, so it is no longer constrained.

const base = { ...DEFAULT_POSTING_SETTINGS };

describe("assertDistinctVatAccounts", () => {
  it("accepts the default settings", () => {
    expect(() => assertDistinctVatAccounts(base)).not.toThrow();
  });

  it("rejects two VAT roles on the same account (the original rule)", () => {
    expect(() => assertDistinctVatAccounts({ ...base, postingVatIn: base.postingVatOut25 })).toThrow(
      VatAccountsNotDistinctError
    );
  });

  it("no longer constrains postingRevenue0 (boxes are per account)", () => {
    expect(() => assertDistinctVatAccounts({ ...base, postingRevenue0: "3108" })).not.toThrow();
  });

  it("rejects the redovisningskonto colliding with a VAT role account", () => {
    expect(() => assertDistinctVatAccounts({ ...base, postingVatSettlement: base.postingVatIn })).toThrow(
      VatAccountsNotDistinctError
    );
  });
});
