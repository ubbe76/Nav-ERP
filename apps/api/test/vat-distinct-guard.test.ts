import { describe, expect, it } from "vitest";
import {
  VatAccountsNotDistinctError,
  assertSettlementAccountsOutsideBoxes,
  findSettlementAccountProblems,
} from "../src/modules/economy/service/vat-report.service.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";

// Pure guard tests — no database. The momsomföring empties every account
// whose box enters ruta 49 (10, 11, 12, 30, 31, 32, 48, 60, 61, 62), so the
// redovisningskonto and the öres account must not carry such a box.

const base = { ...DEFAULT_POSTING_SETTINGS };
const chart = [
  { number: "2650", vatBox: "none" },
  { number: "3740", vatBox: "none" },
  { number: "2610", vatBox: "10" },
  { number: "2645", vatBox: "48" },
  { number: "3001", vatBox: "05" },
];

describe("assertSettlementAccountsOutsideBoxes", () => {
  it("accepts the default settings", () => {
    expect(() => assertSettlementAccountsOutsideBoxes(base, chart)).not.toThrow();
  });

  it("rejects a redovisningskonto that carries an emptied box", () => {
    expect(() => assertSettlementAccountsOutsideBoxes({ ...base, postingVatSettlement: "2645" }, chart)).toThrow(
      VatAccountsNotDistinctError
    );
  });

  it("rejects an öres account that carries an emptied box", () => {
    expect(() => assertSettlementAccountsOutsideBoxes({ ...base, postingPaymentWriteOff: "2610" }, chart)).toThrow(
      VatAccountsNotDistinctError
    );
  });

  it("accepts an account with a box outside the settlement (or none, or unknown)", () => {
    expect(() => assertSettlementAccountsOutsideBoxes({ ...base, postingPaymentWriteOff: "3001" }, chart)).not.toThrow();
    expect(() => assertSettlementAccountsOutsideBoxes({ ...base, postingVatSettlement: "2651" }, chart)).not.toThrow();
  });
});

describe("findSettlementAccountProblems — the report's warning form of the same rule", () => {
  it("is empty for the default settings and names each role whose account carries an emptied box", () => {
    expect(findSettlementAccountProblems(base, chart)).toEqual([]);
    const problems = findSettlementAccountProblems({ ...base, postingVatSettlement: "2645", postingPaymentWriteOff: "2610" }, chart);
    expect(problems.map((problem) => [problem.role, problem.accountNumber, problem.vatBox])).toEqual([
      ["settlement", "2645", "48"],
      ["rounding", "2610", "10"],
    ]);
    expect(problems[0]!.message).toMatch(/^Redovisningskontot för moms 2645 har ruta 48/);
  });
});
