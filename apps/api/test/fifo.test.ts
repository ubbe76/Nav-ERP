import { describe, expect, it } from "vitest";
import { computeFifo, type FifoRow } from "../src/modules/stock/service/fifo.js";

const layer = (quantityDelta: number, unitCost: number | null, key?: string): FifoRow => ({
  quantityDelta,
  unitCost,
  kind: "layer",
  key,
});
const out = (quantityDelta: number): FifoRow => ({ quantityDelta, unitCost: null, kind: "other" });

describe("computeFifo", () => {
  it("prices what is left from the newest layers back", () => {
    // 10 @ 5, 10 @ 8, then 15 out: the 5 left are from the newest layer.
    expect(computeFifo([layer(10, 5), layer(10, 8), out(-15)])).toEqual({ quantity: 5, unitCost: 8 });
    // 12 left: 10 @ 8 and 2 @ 5 → 90 / 12.
    expect(computeFifo([layer(10, 5), layer(10, 8), out(-8)])).toEqual({ quantity: 12, unitCost: 7.5 });
  });

  it("keeps four decimals so the report's value is exact to the öre", () => {
    const result = computeFifo([layer(1, 1), layer(2, 2)]);
    expect(result).toEqual({ quantity: 3, unitCost: 1.6667 });
    expect(Math.round(result.quantity * result.unitCost! * 100) / 100).toBe(5);
  });

  it("restores the old layers when an outflow is returned", () => {
    // 15 out, then the delivery undone: everything is back.
    const rows = [layer(10, 5), layer(10, 8), out(-15), out(15)];
    expect(computeFifo(rows)).toEqual({ quantity: 20, unitCost: 6.5 });
  });

  it("takes an undone TO receipt back from its own layer", () => {
    const rows: FifoRow[] = [
      layer(10, 5, "po:1"),
      layer(4, 9, "mo:7"),
      { quantityDelta: -4, unitCost: null, kind: "reversal", key: "mo:7" },
    ];
    expect(computeFifo(rows)).toEqual({ quantity: 10, unitCost: 5 });
  });

  it("skips unpriced layers and values uncovered stock at the layers' average", () => {
    // The newest 10 have no cost: priced from the 10 @ 5 before them.
    expect(computeFifo([layer(10, 5), layer(10, null), out(-10)])).toEqual({ quantity: 10, unitCost: 5 });
    // 30 on hand, priced layers only cover 20 (10 @ 4, 10 @ 6): average 5.
    expect(computeFifo([out(10), layer(10, 4), layer(10, 6)])).toEqual({ quantity: 30, unitCost: 5 });
  });

  it("has no price without a priced layer, and the newest price when nothing is on hand", () => {
    expect(computeFifo([layer(5, null)])).toEqual({ quantity: 5, unitCost: null });
    expect(computeFifo([layer(5, 3), layer(5, 4), out(-12)])).toEqual({ quantity: -2, unitCost: 4 });
    expect(computeFifo([])).toEqual({ quantity: 0, unitCost: null });
  });

  it("treats a free layer (0) as a price, not as unknown", () => {
    expect(computeFifo([layer(10, 6), layer(10, 0), out(-10)])).toEqual({ quantity: 10, unitCost: 0 });
  });
});
