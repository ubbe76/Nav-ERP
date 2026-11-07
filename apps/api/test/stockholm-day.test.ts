import { afterEach, describe, expect, it, vi } from "vitest";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";

// Guards the test environment's day rule: 23:30 UTC the evening before is
// already the next Stockholm day (winter +01:00, summer +02:00).
describe("the Stockholm day in tests", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["2026-11-06T23:30:00Z", "2026-11-07"],
    ["2026-11-06T22:59:00Z", "2026-11-06"],
    ["2026-07-06T22:30:00Z", "2026-07-07"],
    ["2026-07-06T21:59:00Z", "2026-07-06"],
  ])("at %s the day is %s, for the helper and for the process-local day alike", (instant, day) => {
    vi.useFakeTimers({ now: new Date(instant) });
    expect(stockholmToday()).toBe(day);
    expect(new Date().toLocaleDateString("sv-SE")).toBe(day);
  });
});
