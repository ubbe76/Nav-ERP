import { describe, expect, it } from "vitest";
import { round2, round4, roundToDecimals } from "@navet/shared";

describe("round2", () => {
  it("rounds half away from zero to öre", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.674999)).toBe(2.67);
    // Symmetric (Postgres round): a credit mirrors its invoice.
    expect(round2(-1.005)).toBe(-1.01);
  });

  // The old `+ Number.EPSILON` nudge was smaller than a float's spacing
  // above ~2 kr (delatgranskningen 2026-11-11).
  it("rounds a half öre up above 2 kr too", () => {
    expect(round2(2.175)).toBe(2.18);
    expect(round2(10.075)).toBe(10.08);
    expect(round2(8597.755)).toBe(8597.76); // 25 % VAT on 34 391,02
    expect(round2(34391.02 * 0.25)).toBe(8597.76);
    expect(round2(8.54 * 0.25)).toBe(2.14);
    expect(round2(-2.175)).toBe(-2.18);
  });

  it("matches exact decimal rounding on every half öre up to 20 000 kr", () => {
    let wrong = 0;
    for (let k = 5; k < 20_000_000; k += 10) {
      // k / 1000 is x.xx5 kr; the exact answer is (k + 5) / 10 öre.
      if (round2(k / 1000) !== (k + 5) / 10 / 100) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it("never returns -0", () => {
    expect(Object.is(round2(-0.004), 0)).toBe(true);
    expect(Object.is(roundToDecimals(-0.4, 0), 0)).toBe(true);
  });
});

describe("round4 and roundToDecimals", () => {
  it("rounds half away from zero at four decimals and whole kronor", () => {
    expect(round4(1.00005)).toBe(1.0001);
    expect(round4(0.1 + 0.2)).toBe(0.3);
    expect(round4(-1.00005)).toBe(-1.0001);
    expect(roundToDecimals(2.5, 0)).toBe(3);
    expect(roundToDecimals(-2.5, 0)).toBe(-3);
    expect(roundToDecimals(4123456.4999999995, 0)).toBe(4123457);
  });
});
