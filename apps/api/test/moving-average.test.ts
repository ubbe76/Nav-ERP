import { describe, expect, it } from "vitest";
import { computeMovingAverage } from "../src/modules/stock/service/moving-average.js";

// Pure arithmetic tests — no database. Rows arrive in chronological order,
// exactly as the valuation service feeds them.

function row(delta: number, cost: number | null = null) {
  return { quantityDelta: delta, unitCost: cost };
}

describe("computeMovingAverage", () => {
  it("returns null average for an empty history", () => {
    expect(computeMovingAverage([])).toEqual({ quantity: 0, average: null });
  });

  it("takes the first priced inflow's cost as the average", () => {
    expect(computeMovingAverage([row(10, 100)])).toEqual({ quantity: 10, average: 100 });
  });

  it("weights a second inflow at a different price", () => {
    // 10 @ 100 + 10 @ 200 -> 20 @ 150
    expect(computeMovingAverage([row(10, 100), row(10, 200)])).toEqual({
      quantity: 20,
      average: 150,
    });
  });

  it("weights by quantity, not by count", () => {
    // 30 @ 100 + 10 @ 200 -> 40 @ 125
    expect(computeMovingAverage([row(30, 100), row(10, 200)])).toEqual({
      quantity: 40,
      average: 125,
    });
  });

  it("leaves the average unchanged on an outflow", () => {
    expect(computeMovingAverage([row(10, 100), row(-4)])).toEqual({ quantity: 6, average: 100 });
  });

  it("leaves the average unchanged on an unpriced inflow", () => {
    // Pre-D0 rows and articles without a standard cost inflow without a cost:
    // the quantity grows but the average must not be dragged toward zero.
    expect(computeMovingAverage([row(10, 100), row(5, null)])).toEqual({
      quantity: 15,
      average: 100,
    });
  });

  it("starts the average from an unpriced-then-priced sequence correctly", () => {
    // First inflow unpriced (average unknown), then a priced one: the priced
    // inflow cannot be weighted against an unknown, so it SETS the average.
    expect(computeMovingAverage([row(5, null), row(10, 100)])).toEqual({
      quantity: 15,
      average: 100,
    });
  });

  it("resets the average when a priced inflow arrives at zero or negative stock", () => {
    // Sell everything, then buy again at a new price: the old average is
    // history for stock that no longer exists.
    expect(
      computeMovingAverage([row(10, 100), row(-10), row(10, 200)])
    ).toEqual({ quantity: 10, average: 200 });

    // Negative stock (over-delivery), then a priced inflow: same reset —
    // the weighted formula is undefined across the zero crossing.
    expect(
      computeMovingAverage([row(10, 100), row(-15), row(10, 200)])
    ).toEqual({ quantity: 5, average: 200 });
  });

  it("rounds the average to 2 decimals at every step", () => {
    // 3 @ 10 + 1 @ 11 -> 4 @ 10.25; then + 2 @ 10 -> 6 @ 10.166... -> 10.17
    expect(computeMovingAverage([row(3, 10), row(1, 11), row(2, 10)])).toEqual({
      quantity: 6,
      average: 10.17,
    });
  });

  it("handles fractional quantities (numeric(14,4) domain)", () => {
    // 2.5 @ 40 + 2.5 @ 60 -> 5 @ 50
    expect(computeMovingAverage([row(2.5, 40), row(2.5, 60)])).toEqual({
      quantity: 5,
      average: 50,
    });
  });

  it("keeps the last known average when stock runs out", () => {
    // Everything consumed: quantity 0, but the average survives as the best
    // guess for the NEXT valuation question — the caller decides what a zero
    // quantity is worth (nothing).
    expect(computeMovingAverage([row(10, 100), row(-10)])).toEqual({
      quantity: 0,
      average: 100,
    });
  });

  it("treats a zero-cost priced inflow as a real price, not as unpriced", () => {
    // cost 0 is a claim ("this stock is worthless"), null is "unknown" —
    // the D0 writers never stamp 0 for unknown, so 0 must dilute the average.
    expect(computeMovingAverage([row(10, 100), row(10, 0)])).toEqual({
      quantity: 20,
      average: 50,
    });
  });
});
