import { describe, expect, it } from "vitest";
import { isIsoDate } from "../../web/lib/bankReconciliation.js";

describe("web isIsoDate", () => {
  it("accepts dates in the API's 1900-2999 range", () => {
    expect(isIsoDate("2026-11-11")).toBe(true);
    expect(isIsoDate("1900-01-01")).toBe(true);
    expect(isIsoDate("2999-12-31")).toBe(true);
  });

  it("refuses the half-typed years a date input sends while typing", () => {
    expect(isIsoDate("0002-10-11")).toBe(false);
    expect(isIsoDate("0202-10-11")).toBe(false);
    expect(isIsoDate("1899-12-31")).toBe(false);
    expect(isIsoDate("3000-01-01")).toBe(false);
  });

  it("refuses malformed and impossible values", () => {
    expect(isIsoDate("")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-1-1")).toBe(false);
  });
});
