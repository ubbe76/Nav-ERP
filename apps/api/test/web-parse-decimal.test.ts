import { describe, expect, it } from "vitest";
import { parseDecimal } from "../../web/components/configurator/parseDecimal";

// The configurator forms' measure fields: comma or dot, a leading decimal
// point is allowed, half-typed input holds the evaluation back (null).
describe("parseDecimal", () => {
  it("accepts comma and dot, with or without an integer part", () => {
    expect(parseDecimal("12,5")).toBe(12.5);
    expect(parseDecimal("12.5")).toBe(12.5);
    expect(parseDecimal(" 1200 ")).toBe(1200);
    expect(parseDecimal(",5")).toBe(0.5);
    expect(parseDecimal(".5")).toBe(0.5);
    expect(parseDecimal("-,25")).toBe(-0.25);
    expect(parseDecimal("-3")).toBe(-3);
  });
  it("treats half-typed and foreign input as not yet a number", () => {
    for (const raw of ["", "12,", "12.", "-", ",", ".", "1,2,3", "12 mm", "1e3", "abc"]) expect(parseDecimal(raw)).toBeNull();
  });
});
