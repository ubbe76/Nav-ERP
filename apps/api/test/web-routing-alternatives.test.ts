import { describe, expect, it } from "vitest";
import { MAX_ROUTING_ALTERNATIVES as SHARED_MAX } from "@navet/shared";
import { MAX_ROUTING_ALTERNATIVES, moveItem, workCenterHasCapacity } from "../../web/lib/routingAlternatives.js";

describe("web routing alternatives helpers", () => {
  it("keeps the limit in step with the shared schema", () => {
    expect(MAX_ROUTING_ALTERNATIVES).toBe(SHARED_MAX);
  });

  it("moves a row one step and leaves the ends alone", () => {
    expect(moveItem(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    const rows = ["a", "b"];
    expect(moveItem(rows, 0, -1)).toBe(rows);
    expect(moveItem(rows, 1, 1)).toBe(rows);
  });

  it("needs a week schedule or hours per day for capacity", () => {
    expect(workCenterHasCapacity({ weekScheduleId: null, hoursPerDay: null })).toBe(false);
    expect(workCenterHasCapacity({ weekScheduleId: "x", hoursPerDay: null })).toBe(true);
    expect(workCenterHasCapacity({ weekScheduleId: null, hoursPerDay: "8" })).toBe(true);
  });
});
