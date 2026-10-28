import { describe, expect, it } from "vitest";
import {
  minutesPerUnitToSecondsPerUnit,
  minutesPerUnitToUnitsPerHour,
  roundUpToMultiple,
  runTimeInUnit,
  runTimeToMinutes,
  secondsPerUnitToMinutesPerUnit,
  toBasePrice,
  toBaseQuantity,
  toUnitPrice,
  toUnitQuantity,
  unitsPerHourToMinutesPerUnit,
} from "@navet/shared";

// Factor semantics: quantity_per_base = how many of the alternative unit one
// base unit equals (st article weighing 5 kg apiece → kg factor is 5).
describe("unit conversion helpers", () => {
  it("converts entered quantity to base quantity (500 kg @ factor 5 → 100 st)", () => {
    expect(toBaseQuantity(500, 5)).toBe(100);
  });

  it("converts base quantity to display quantity (100 st @ factor 5 → 500 kg)", () => {
    expect(toUnitQuantity(100, 5)).toBe(500);
  });

  it("converts prices in the opposite direction (12 kr/kg → 60 kr/st and back)", () => {
    expect(toBasePrice(12, 5)).toBe(60);
    expect(toUnitPrice(60, 5)).toBe(12);
  });

  it("treats factor 1, null and undefined as identity", () => {
    expect(toBaseQuantity(42.5, 1)).toBe(42.5);
    expect(toBaseQuantity(42.5, null)).toBe(42.5);
    expect(toUnitQuantity(42.5, undefined)).toBe(42.5);
    expect(toBasePrice(9.99, null)).toBe(9.99);
    expect(toUnitPrice(9.99, undefined)).toBe(9.99);
  });

  it("rounds to 4 decimals (the numeric(14,4) storage scale)", () => {
    // 1 st = 3 kg → 100 kg = 33.3333 st
    expect(toBaseQuantity(100, 3)).toBe(33.3333);
    // ...and back: honest rounding, not a fabricated exact round-trip.
    expect(toUnitQuantity(33.3333, 3)).toBe(99.9999);
  });

  it("accepts factors as strings (numeric columns come back as strings)", () => {
    expect(toBaseQuantity(500, "5")).toBe(100);
    expect(toUnitQuantity(100, "5.000000")).toBe(500);
    expect(toUnitPrice(60, "5")).toBe(12);
  });

  it("keeps kr/öre amounts exact through the round trip", () => {
    // 500 kg @ 12 kr/kg ⇒ stored 100 st @ 60 kr/st ⇒ row total 6000 exact.
    const baseQty = toBaseQuantity(500, 5);
    const basePrice = toBasePrice(12, 5);
    expect(baseQty * basePrice).toBe(6000);
    expect(toUnitQuantity(baseQty, 5)).toBe(500);
    expect(toUnitPrice(basePrice, 5)).toBe(12);
  });
});

// operation_time_unit — runTimePerUnit is always stored/returned in minutes
// per unit; st/h is a pure display preference converted at the edges.
describe("operation time-unit conversion helpers", () => {
  it("converts units per hour to minutes per unit, rounded to 4 decimals", () => {
    // 7 st/h = 60/7 = 8.571428... min/st
    expect(unitsPerHourToMinutesPerUnit(7)).toBe(8.5714);
  });

  it("converts minutes per unit to units per hour, rounded to 2 decimals", () => {
    expect(minutesPerUnitToUnitsPerHour(8.5714)).toBe(7);
  });

  it("round-trips 7 st/h → 8.5714 min/st → 7 st/h", () => {
    const minutesPerUnit = unitsPerHourToMinutesPerUnit(7);
    expect(minutesPerUnit).toBe(8.5714);
    expect(minutesPerUnitToUnitsPerHour(minutesPerUnit)).toBe(7);
  });

  it("converts seconds per unit to minutes (4 decimals) and back (2 decimals)", () => {
    expect(secondsPerUnitToMinutesPerUnit(30)).toBe(0.5);
    expect(secondsPerUnitToMinutesPerUnit(7)).toBe(0.1167);
    expect(minutesPerUnitToSecondsPerUnit(0.1167)).toBe(7);
    expect(minutesPerUnitToSecondsPerUnit(1.5)).toBe(90);
    // 0 is a valid run time in seconds, unlike st/h.
    expect(secondsPerUnitToMinutesPerUnit(0)).toBe(0);
    expect(minutesPerUnitToSecondsPerUnit(0)).toBe(0);
  });

  it("round-trips typed seconds unchanged — 7 s, 0,5 s and 12,25 s", () => {
    for (const seconds of [7, 0.5, 12.25]) {
      expect(minutesPerUnitToSecondsPerUnit(secondsPerUnitToMinutesPerUnit(seconds))).toBe(seconds);
    }
  });

  it("runTimeInUnit / runTimeToMinutes cover all three display units", () => {
    expect(runTimeInUnit(2, "minutes_per_unit")).toBe(2);
    expect(runTimeInUnit(2, "seconds_per_unit")).toBe(120);
    expect(runTimeInUnit(8.5714, "units_per_hour")).toBe(7);
    expect(runTimeToMinutes(2, "minutes_per_unit")).toBe(2);
    expect(runTimeToMinutes(45, "seconds_per_unit")).toBe(0.75);
    expect(runTimeToMinutes(7, "units_per_hour")).toBe(8.5714);
  });
});

// articles.rounding (Avrundning) — order rows and proposals are rounded UP to
// the nearest multiple of the step, in the article's base unit.
describe("roundUpToMultiple", () => {
  it("rounds up to whole units with step 1", () => {
    expect(roundUpToMultiple(2.3, 1)).toBe(3);
    expect(roundUpToMultiple(3, 1)).toBe(3);
  });

  it("rounds up to the nearest multiple of 5", () => {
    expect(roundUpToMultiple(21, 5)).toBe(25);
    expect(roundUpToMultiple(25, 5)).toBe(25);
    expect(roundUpToMultiple(0.5, 5)).toBe(5);
  });

  it("accepts fractional steps (a 7.38 kg bar) and rounds to 4 decimals", () => {
    expect(roundUpToMultiple(1.1, 0.25)).toBe(1.25);
    expect(roundUpToMultiple(100, 7.38)).toBe(103.32);
  });

  it("leaves the quantity untouched without a usable step", () => {
    expect(roundUpToMultiple(2.3, null)).toBe(2.3);
    expect(roundUpToMultiple(2.3, undefined)).toBe(2.3);
    expect(roundUpToMultiple(2.3, 0)).toBe(2.3);
    expect(roundUpToMultiple(2.3, -5)).toBe(2.3);
    expect(roundUpToMultiple(2.3, "")).toBe(2.3);
  });

  it("accepts the step as the numeric string the database returns", () => {
    expect(roundUpToMultiple(12, "5.000")).toBe(15);
  });

  it("never rounds a zero or negative quantity up", () => {
    expect(roundUpToMultiple(0, 5)).toBe(0);
  });

  it("guards against float noise pushing the quotient to the next multiple", () => {
    // 0.1 + 0.2 = 0.30000000000000004 — without the epsilon guard the quotient
    // 1.0000000000000002 would ceil to 2 multiples.
    expect(roundUpToMultiple(0.1 + 0.2, 0.3)).toBeCloseTo(0.3, 9);
  });
});
