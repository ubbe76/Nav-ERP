import { describe, expect, it } from "vitest";
import { LATE_FEE_AMOUNT } from "@navet/shared";
import {
  accruedInterestText,
  daysBetween,
  fullyPaidDate,
  halfYearStart,
  halfYearStartsBetween,
  lateFeeAmount,
  lateFeeRowText,
  lateInterest,
  lateInterestRowText,
  nextHalfYearStart,
} from "../src/modules/sales/service/late-interest.js";

// Dröjsmålsränta — the pure rules (räntelagen 4 och 6 §§, inkassokostnads-
// lagen 4 a och 5 §§), pinned to the contract's examples.

const RATES = [
  { validFrom: "2026-01-01", rate: 2 },
  { validFrom: "2026-07-01", rate: 4 },
  { validFrom: "2027-01-01", rate: 2 },
];
const MARGIN = 8;

describe("lateInterest — day count", () => {
  it("the contract's case: due 2026-09-01, paid 2026-09-20 = 19 days from 09-02, 12,00 %", () => {
    const result = lateInterest({ principal: 10000, dueDate: "2026-09-01", through: "2026-09-20", payments: [], rates: RATES, margin: MARGIN });
    expect(result.days).toBe(19);
    expect(result.rateMissing).toEqual([]);
    expect(result.segments).toEqual([{ from: "2026-09-02", to: "2026-09-20", days: 19, rate: 12, amount: 62.47 }]);
    // 10 000 × 12 % × 19 / 365 = 62,4657…
    expect(result.amount).toBe(62.47);
  });

  it("paid on the due date = 0 days, 0 kr", () => {
    const result = lateInterest({ principal: 10000, dueDate: "2026-09-01", through: "2026-09-01", payments: [], rates: RATES, margin: MARGIN });
    expect(result).toEqual({ amount: 0, days: 0, segments: [], rateMissing: [] });
  });

  it("splits a period crossing 1 July into two parts with each half-year's rate", () => {
    const result = lateInterest({ principal: 36500, dueDate: "2026-06-20", through: "2026-07-10", payments: [], rates: RATES, margin: MARGIN });
    expect(result.days).toBe(20);
    expect(result.segments).toEqual([
      // 10 days at 10 %: 36 500 × 0,10 × 10 / 365 = 100
      { from: "2026-06-21", to: "2026-06-30", days: 10, rate: 10, amount: 100 },
      // 10 days at 12 %: 120
      { from: "2026-07-01", to: "2026-07-10", days: 10, rate: 12, amount: 120 },
    ]);
    expect(result.amount).toBe(220);
  });

  it("a partial payment lowers the capital from the day after the payment day", () => {
    const result = lateInterest({
      principal: 36500,
      dueDate: "2026-09-01",
      through: "2026-09-21",
      payments: [{ date: "2026-09-11", amount: 18250 }],
      rates: RATES,
      margin: MARGIN,
    });
    // 09-02..09-11 (10 days) on 36 500, 09-12..09-21 (10 days) on 18 250.
    expect(result.segments).toEqual([
      { from: "2026-09-02", to: "2026-09-11", days: 10, rate: 12, amount: 120 },
      { from: "2026-09-12", to: "2026-09-21", days: 10, rate: 12, amount: 60 },
    ]);
    expect(result.amount).toBe(180);
    expect(result.days).toBe(20);
  });

  it("takes payments in any order and never lets the capital go below 0", () => {
    const result = lateInterest({
      principal: 1000,
      dueDate: "2026-09-01",
      through: "2026-09-30",
      payments: [
        { date: "2026-09-20", amount: 600 },
        { date: "2026-09-10", amount: 500 },
      ],
      rates: RATES,
      margin: MARGIN,
    });
    expect(result.segments.map((s) => [s.from, s.to, s.amount])).toEqual([
      ["2026-09-02", "2026-09-10", 2.96],
      ["2026-09-11", "2026-09-20", 1.64],
      ["2026-09-21", "2026-09-30", 0],
    ]);
  });

  it("uses the customer's Avtalad räntesats instead of referensränta + marginal, with no rates at all", () => {
    const result = lateInterest({ principal: 36500, dueDate: "2026-06-20", through: "2026-07-10", payments: [], rates: [], margin: MARGIN, agreedRate: 15 });
    expect(result.rateMissing).toEqual([]);
    expect(result.segments).toEqual([{ from: "2026-06-21", to: "2026-07-10", days: 20, rate: 15, amount: 300 }]);
    expect(result.amount).toBe(300);
  });

  it("divides by 365 in a leap year too", () => {
    const result = lateInterest({ principal: 36500, dueDate: "2028-02-01", through: "2028-03-01", payments: [], rates: [{ validFrom: "2028-01-01", rate: 2 }], margin: MARGIN });
    // 2028-02-02..2028-03-01 = 29 days (leap day included), 36 500 × 10 % × 29 / 365 = 290
    expect(result.days).toBe(29);
    expect(result.amount).toBe(290);
  });

  it("reports the half-years without a referensränta and no amount", () => {
    const result = lateInterest({ principal: 1000, dueDate: "2026-12-20", through: "2027-01-10", payments: [], rates: [{ validFrom: "2026-07-01", rate: 4 }], margin: MARGIN });
    expect(result).toEqual({ amount: null, days: 21, segments: [], rateMissing: ["2027-01-01"] });
  });
});

describe("förseningsersättning and texts", () => {
  it("is 450 kr minus the påminnelseavgift already charged, never below 0", () => {
    expect(LATE_FEE_AMOUNT).toBe(450);
    expect(lateFeeAmount(0)).toBe(450);
    expect(lateFeeAmount(60)).toBe(390);
    expect(lateFeeAmount(450)).toBe(0);
    expect(lateFeeAmount(500)).toBe(0);
  });

  it("writes the row texts as the contract spells them", () => {
    expect(lateInterestRowText({ invoiceNumber: "FA-1234", from: "2026-09-02", to: "2026-09-20", days: 19, rates: [12] })).toBe(
      "Dröjsmålsränta FA-1234, 2026-09-02–2026-09-20 (19 dagar, 12,00 %)"
    );
    expect(lateInterestRowText({ invoiceNumber: "FA-1234", from: "2026-06-21", to: "2026-07-10", days: 20, rates: [10, 12] })).toBe(
      "Dröjsmålsränta FA-1234, 2026-06-21–2026-07-10 (20 dagar, 10,00/12,00 %)"
    );
    expect(lateInterestRowText({ invoiceNumber: "FA-1", from: "2026-09-02", to: "2026-09-02", days: 1, rates: [12] })).toBe(
      "Dröjsmålsränta FA-1, 2026-09-02–2026-09-02 (1 dag, 12,00 %)"
    );
    expect(lateFeeRowText("FA-1234")).toBe("Förseningsersättning FA-1234");
    expect(accruedInterestText("2026-10-25", 1234.5)).toBe("Upplupen dröjsmålsränta t.o.m. 2026-10-25: 1 234,50 kr");
  });

  it("finds the day the capital reaches 0 among payments up to `through`", () => {
    const payments = [
      { date: "2026-09-10", amount: 400 },
      { date: "2026-09-20", amount: 600 },
    ];
    expect(fullyPaidDate(1000, payments, "2026-09-30")).toBe("2026-09-20");
    expect(fullyPaidDate(1000, payments, "2026-09-15")).toBeNull();
    expect(fullyPaidDate(1000, [], "2026-09-30")).toBeNull();
    // Rounding: 999.996 paid of 1000 counts as paid.
    expect(fullyPaidDate(1000, [{ date: "2026-09-10", amount: 999.996 }], "2026-09-30")).toBe("2026-09-10");
  });

  it("half-year helpers", () => {
    expect(halfYearStart("2026-06-30")).toBe("2026-01-01");
    expect(halfYearStart("2026-07-01")).toBe("2026-07-01");
    expect(nextHalfYearStart("2026-12-31")).toBe("2027-01-01");
    expect(halfYearStartsBetween("2026-05-01", "2027-02-01")).toEqual(["2026-01-01", "2026-07-01", "2027-01-01"]);
    expect(halfYearStartsBetween("2026-05-01", "2026-04-01")).toEqual([]);
    expect(daysBetween("2026-09-02", "2026-09-20")).toBe(19);
    expect(daysBetween("2026-09-02", "2026-09-01")).toBe(0);
  });
});
