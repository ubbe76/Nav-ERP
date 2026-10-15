import { describe, expect, it } from "vitest";
import { codeFromName, errorBody } from "../src/modules/system/service/error-body.js";
import {
  DuplicateWorkCenterCodeError,
  WeekScheduleNotFoundError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { PriceListNotFoundError } from "../src/modules/sales/service/sales.errors.js";

// Pure derivation tests — no database. The envelope is additive: existing
// { error } consumers are untouched, code appears only for named domain errors.

describe("codeFromName", () => {
  it("kebab-cases the class name and strips the Error suffix", () => {
    expect(codeFromName("DuplicateWorkCenterCodeError")).toBe("duplicate-work-center-code");
    expect(codeFromName("PriceListNotFoundError")).toBe("price-list-not-found");
    expect(codeFromName("ZeroAmountPostingError")).toBe("zero-amount-posting");
  });

  it("handles consecutive capitals and digits", () => {
    expect(codeFromName("SiePriorBookkeepingError")).toBe("sie-prior-bookkeeping");
    expect(codeFromName("MOOperationNotFoundError")).toBe("mo-operation-not-found");
  });

  it("returns undefined for the plain Error name", () => {
    expect(codeFromName("Error")).toBeUndefined();
    expect(codeFromName("")).toBeUndefined();
  });
});

describe("errorBody", () => {
  it("keeps the message and adds the derived code for domain errors", () => {
    const body = errorBody(new DuplicateWorkCenterCodeError("101"));
    expect(body.error).toContain("101");
    expect(body.code).toBe("duplicate-work-center-code");
  });

  it("derives from real classes that set this.name", () => {
    expect(errorBody(new WeekScheduleNotFoundError("x")).code).toBe("week-schedule-not-found");
    expect(errorBody(new PriceListNotFoundError("x")).code).toBe("price-list-not-found");
  });

  it("omits code entirely for a plain Error", () => {
    const body = errorBody(new Error("boom"));
    expect(body).toEqual({ error: "boom" });
    expect("code" in body).toBe(false);
  });
});
