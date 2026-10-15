import { describe, expect, it } from "vitest";
import { manufacturingCost, perUnit, selfCost } from "../src/modules/costing/service/cost-figures.js";

// Numbers as the in-flight calculation carries them.
const NUMERIC = {
  materialCost: 100,
  materialOverhead: 10,
  laborCost: 60,
  overhead: 6,
  subcontractCost: 40,
  subcontractOverhead: 2,
  semiFinishedCost: 300,
  businessOverhead: 51.8,
};

// The same figures as Drizzle hands numeric columns back.
const STRINGS = {
  materialCost: "100.0000",
  materialOverhead: "10.0000",
  laborCost: "60.0000",
  overhead: "6.0000",
  subcontractCost: "40.0000",
  subcontractOverhead: "2.0000",
  semiFinishedCost: "300.0000",
  businessOverhead: "51.8000",
};

describe("cost-figures — TVK and SVK", () => {
  it("sums every bucket, including halvfabrikat, into TVK", () => {
    expect(manufacturingCost(NUMERIC)).toBe(518);
  });

  it("adds Affo on top of TVK for SVK", () => {
    expect(selfCost(NUMERIC)).toBeCloseTo(569.8, 10);
  });

  it("reads the string form the database returns identically to the numeric form", () => {
    expect(manufacturingCost(STRINGS)).toBe(manufacturingCost(NUMERIC));
    expect(selfCost(STRINGS)).toBeCloseTo(selfCost(NUMERIC), 10);
  });

  it("counts a calculation saved before multi-level existed unchanged", () => {
    // semi_finished_cost defaults to '0', so an old row must produce exactly
    // the TVK it produced before the column was added.
    expect(manufacturingCost({ ...NUMERIC, semiFinishedCost: 0 })).toBe(218);
  });
});

describe("cost-figures — perUnit", () => {
  it("divides by the quantity", () => {
    expect(perUnit(500, 10)).toBe(50);
    expect(perUnit(500, "10.0000")).toBe(50);
  });

  it("answers null rather than 0 when the quantity cannot carry a per-unit figure", () => {
    // "no answer" and "free" are different claims — the same distinction
    // resolvePrice and computeMovingAverage make.
    expect(perUnit(500, 0)).toBeNull();
    expect(perUnit(500, -1)).toBeNull();
    expect(perUnit(500, "")).toBeNull();
  });
});
