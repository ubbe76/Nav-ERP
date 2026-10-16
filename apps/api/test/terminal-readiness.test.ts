import { describe, expect, it } from "vitest";
import { computeReadiness } from "../src/modules/manufacturing/service/terminal-readiness.js";

const op = (id: string, sequenceNo: number, ok: string | null, status: "pending" | "done" = "pending") => ({ id, sequenceNo, status, quantityCompleted: ok });

describe("computeReadiness", () => {
  it("first operation is always ready with Kvar available", () => {
    const r = computeReadiness(20, [op("a", 10, "5"), op("b", 20, null)]);
    expect(r.get("a")).toEqual({ readiness: "ready", available: 15 });
  });
  it("ready when the previous operation is done, available = Kvar", () => {
    const r = computeReadiness(20, [op("a", 10, "12", "done"), op("b", 20, "2")]);
    expect(r.get("b")).toEqual({ readiness: "ready", available: 18 });
  });
  it("partial when the previous has reported more OK than this one", () => {
    const r = computeReadiness(20, [op("a", 10, "8"), op("b", 20, null)]);
    expect(r.get("b")).toEqual({ readiness: "partial", available: 8 });
  });
  it("not ready when the previous has not reported more", () => {
    const r = computeReadiness(20, [op("a", 10, "3"), op("b", 20, "3"), op("c", 30, "3")]);
    expect(r.get("b")).toEqual({ readiness: "not_ready", available: 0 });
    expect(r.get("c")).toEqual({ readiness: "not_ready", available: 0 });
  });
  it("uses the nearest lower sequence number regardless of array order (a lego op counts)", () => {
    const r = computeReadiness(10, [op("c", 30, null), op("a", 10, "10", "done"), op("lego", 20, "4")]);
    expect(r.get("c")).toEqual({ readiness: "partial", available: 4 });
  });
  it("never reports a negative available (over-reported operation)", () => {
    const r = computeReadiness(10, [op("a", 10, "12")]);
    expect(r.get("a")).toEqual({ readiness: "ready", available: 0 });
  });
});
