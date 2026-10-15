import { describe, expect, it } from "vitest";
import { round2 } from "@navet/shared";

describe("round2", () => {
  it("rounds to öre with EPSILON guard", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.674999)).toBe(2.67);
    expect(round2(-1.005)).toBe(-1); // The EPSILON nudge only affects positive half-öre values; negatives follow plain Math.round
  });
});
