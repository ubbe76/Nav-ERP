import { describe, expect, it } from "vitest";
import { weightedActualCosts, type DrawRow, type HistoryRow } from "../src/modules/costing/service/actual-cost.js";
import { resolveUnitCost } from "../src/modules/costing/service/markup.js";

// Pure tests for Verklig kostnad: an outflow carries no price of its own (D0
// stamps unit_cost on inflows only), so its cost is the moving average as of
// the moment it happened.

const at = (minute: number) => new Date(Date.UTC(2026, 6, 1, 12, minute));

function receipt(id: string, articleId: string, quantity: number, unitCost: number | null, minute: number): HistoryRow {
  return { id, articleId, quantityDelta: String(quantity), unitCost: unitCost === null ? null : String(unitCost), createdAt: at(minute) };
}
function draw(id: string, articleId: string, quantity: number, minute: number): HistoryRow {
  return { id, articleId, quantityDelta: String(-quantity), unitCost: null, createdAt: at(minute) };
}
const asDraw = (row: HistoryRow): DrawRow => ({
  articleId: row.articleId,
  quantityDelta: row.quantityDelta,
  createdAt: row.createdAt,
  id: row.id,
});

describe("weightedActualCosts", () => {
  it("values a draw at the moving average of everything received before it", () => {
    // 10 @ 100 then 10 @ 200 → average 150 for the 5 drawn afterwards.
    const history = [
      receipt("r1", "a", 10, 100, 0),
      receipt("r2", "a", 10, 200, 1),
      draw("d1", "a", 5, 2),
    ];
    const result = weightedActualCosts([asDraw(history[2]!)], history);
    expect(result.get("a")).toBe(150);
  });

  it("does not let a later receipt change what an earlier draw cost", () => {
    // The 300 arrives AFTER the draw — binding as-of the moment is the whole
    // point, otherwise a post-calculation would drift every time stock moved.
    const history = [
      receipt("r1", "a", 10, 100, 0),
      draw("d1", "a", 5, 1),
      receipt("r2", "a", 10, 300, 2),
    ];
    const result = weightedActualCosts([asDraw(history[1]!)], history);
    expect(result.get("a")).toBe(100);
  });

  it("weights several draws of the same article by quantity", () => {
    // 2 units at 100, then (after a 300-receipt lifts the average to 200)
    // 6 units at 200 → (2×100 + 6×200) / 8 = 175.
    const history = [
      receipt("r1", "a", 10, 100, 0),
      draw("d1", "a", 2, 1),
      receipt("r2", "a", 8, 300, 2),
      draw("d2", "a", 6, 3),
    ];
    const result = weightedActualCosts([asDraw(history[1]!), asDraw(history[3]!)], history);
    expect(result.get("a")).toBeCloseTo(175, 10);
  });

  it("answers null when a draw happened before any priced receipt", () => {
    // An average cannot be invented, and half-deriving one is harder to explain
    // than falling back to the standard cost.
    const history = [receipt("r1", "a", 10, null, 0), draw("d1", "a", 5, 1)];
    const result = weightedActualCosts([asDraw(history[1]!)], history);
    expect(result.get("a")).toBeNull();
  });

  it("ignores draws belonging to other manufacturing orders", () => {
    const history = [
      receipt("r1", "a", 10, 100, 0),
      draw("other", "a", 5, 1),
      receipt("r2", "a", 5, 400, 2),
      draw("mine", "a", 2, 3),
    ];
    // Only "mine" is passed as a draw; "other" still moves the quantity in the
    // replay, so the average it leaves behind is what "mine" is valued at.
    const result = weightedActualCosts([asDraw(history[3]!)], history);
    expect(result.get("a")).toBeCloseTo(250, 10);
  });

  it("keeps articles apart", () => {
    const history = [
      receipt("r1", "a", 10, 100, 0),
      draw("d1", "a", 1, 1),
      receipt("r2", "b", 10, 700, 0),
      draw("d2", "b", 1, 1),
    ];
    const result = weightedActualCosts([asDraw(history[1]!), asDraw(history[3]!)], history);
    expect(result.get("a")).toBe(100);
    expect(result.get("b")).toBe(700);
  });
});

describe("resolveUnitCost — verklig kostnad", () => {
  it("uses the derived actual cost and records the source", () => {
    const r = resolveUnitCost({ standardCost: "10", supplierPrice: "20", actualCost: 150 }, "actual");
    expect(r).toEqual({ cost: 150, used: "moving_average", warning: null });
  });

  it("falls back to the standard cost with a warning when none could be derived", () => {
    const r = resolveUnitCost({ standardCost: "10", supplierPrice: null, actualCost: null }, "actual");
    expect(r.cost).toBe(10);
    expect(r.used).toBe("standard");
    expect(r.warning).toBe("ingen verklig kostnad vid förbrukningen, använder standardpris");
  });

  it("reports an honest zero when there is neither", () => {
    const r = resolveUnitCost({ standardCost: null, supplierPrice: null, actualCost: null }, "actual");
    expect(r).toEqual({
      cost: 0,
      used: "none",
      warning: "varken verklig kostnad eller standardpris, antar 0",
    });
  });

  it("treats a derived cost of 0 as a real price, not as missing", () => {
    // 0 means "worthless", not "unknown" — the same distinction
    // computeMovingAverage documents.
    const r = resolveUnitCost({ standardCost: "10", supplierPrice: null, actualCost: 0 }, "actual");
    expect(r.cost).toBe(0);
    expect(r.used).toBe("moving_average");
  });
});
