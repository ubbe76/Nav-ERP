import { describe, expect, it } from "vitest";
import {
  isDoneAt,
  isEmptyWipRow,
  relievedValue,
  workInProgressRow,
  workInProgressTotals,
} from "../src/modules/costing/service/work-in-progress.js";

// Produkter i arbete (#25) — the pure rules: avräknat, the row and the
// underlag, klar vid D, the totals.

const COSTS = { materialCost: 1000, laborCost: 600, subcontractCost: 400, materialOverhead: 100, subcontractOverhead: 40 };

describe("relievedValue — avräknat at the stock price", () => {
  it("values each receipt at its own unit cost", () => {
    expect(
      relievedValue([
        { quantityDelta: 2, unitCost: 150 },
        { quantityDelta: 3, unitCost: 160 },
      ])
    ).toEqual({ quantity: 5, value: 780 });
  });

  it("takes an undone receipt back from the newest earlier receipt", () => {
    // 2 @ 150, 3 @ 160, then 3 undone: the 3 @ 160 go back, 2 @ 150 remain.
    expect(
      relievedValue([
        { quantityDelta: 2, unitCost: 150 },
        { quantityDelta: 3, unitCost: 160 },
        { quantityDelta: -3, unitCost: null },
      ])
    ).toEqual({ quantity: 2, value: 300 });
  });

  it("spills an undo over to the receipt before when the newest is already taken back", () => {
    expect(
      relievedValue([
        { quantityDelta: 2, unitCost: 150 },
        { quantityDelta: 1, unitCost: 160 },
        { quantityDelta: -2, unitCost: null },
      ])
    ).toEqual({ quantity: 1, value: 150 });
  });

  it("is unknown when a counted receipt has no price", () => {
    expect(
      relievedValue([
        { quantityDelta: 2, unitCost: 150 },
        { quantityDelta: 1, unitCost: null },
      ])
    ).toEqual({ quantity: 3, value: null });
  });

  it("is known again once the unpriced receipt is undone", () => {
    expect(
      relievedValue([
        { quantityDelta: 2, unitCost: 150 },
        { quantityDelta: 1, unitCost: null },
        { quantityDelta: -1, unitCost: null },
      ])
    ).toEqual({ quantity: 2, value: 300 });
  });

  it("is unknown when an undo finds nothing to take back from", () => {
    expect(relievedValue([{ quantityDelta: -1, unitCost: null }])).toEqual({ quantity: -1, value: null });
  });

  it("is 0 without receipts", () => {
    expect(relievedValue([])).toEqual({ quantity: 0, value: 0 });
  });
});

describe("workInProgressRow — the two underlag", () => {
  it("Tillverkningskostnad adds MO and LO to material, lön and lego", () => {
    expect(workInProgressRow(COSTS, 500, "manufacturing_cost")).toEqual({
      material: 1000,
      labor: 600,
      subcontract: 400,
      overhead: 140,
      accumulated: 2140,
      relieved: 500,
      value: 1640,
      capped: false,
    });
  });

  it("Direkta kostnader leaves MO and LO out", () => {
    expect(workInProgressRow(COSTS, 500, "direct")).toMatchObject({ overhead: 0, accumulated: 2000, value: 1500, capped: false });
  });

  it("caps at 0 when avräknat exceeds upparbetat", () => {
    expect(workInProgressRow(COSTS, 2500, "direct")).toMatchObject({ accumulated: 2000, relieved: 2500, value: 0, capped: true });
  });

  it("is unvalued when avräknat is unknown", () => {
    expect(workInProgressRow(COSTS, null, "manufacturing_cost")).toMatchObject({ accumulated: 2140, relieved: null, value: null, capped: false });
  });

  it("rounds every column to öre and adds the rounded columns", () => {
    const row = workInProgressRow(
      { materialCost: 10.005, laborCost: 0.333, subcontractCost: 0, materialOverhead: 0.0049, subcontractOverhead: 0 },
      0,
      "manufacturing_cost"
    );
    expect(row).toMatchObject({ material: 10.01, labor: 0.33, overhead: 0, accumulated: 10.34, value: 10.34 });
  });

  it("is empty with nothing accumulated and nothing relieved", () => {
    expect(isEmptyWipRow(workInProgressRow({ materialCost: 0, laborCost: 0, subcontractCost: 0, materialOverhead: 0, subcontractOverhead: 0 }, 0, "direct"))).toBe(true);
    expect(isEmptyWipRow(workInProgressRow({ materialCost: 0, laborCost: 0, subcontractCost: 0, materialOverhead: 0, subcontractOverhead: 0 }, null, "direct"))).toBe(false);
  });
});

describe("isDoneAt — klar vid D", () => {
  const base = { asOf: "2025-12-31", quantity: 10, receivedQuantity: 4 };

  it("(a) a completion report alive on D", () => {
    expect(isDoneAt({ ...base, completedReports: [{ createdOn: "2025-12-31", undoneOn: null }] })).toBe(true);
  });

  it("(a) a completion report undone after D still made the order done on D", () => {
    expect(isDoneAt({ ...base, completedReports: [{ createdOn: "2025-12-20", undoneOn: "2026-01-02" }] })).toBe(true);
  });

  it("(a) a completion report undone on or before D does not count", () => {
    expect(isDoneAt({ ...base, completedReports: [{ createdOn: "2025-12-20", undoneOn: "2025-12-31" }] })).toBe(false);
    expect(isDoneAt({ ...base, completedReports: [{ createdOn: "2025-12-20", undoneOn: "2025-12-22" }] })).toBe(false);
  });

  it("(a) a completion report created after D does not count", () => {
    expect(isDoneAt({ ...base, completedReports: [{ createdOn: "2026-01-01", undoneOn: null }] })).toBe(false);
  });

  it("(b) the quantity received by D covers the order", () => {
    expect(isDoneAt({ ...base, receivedQuantity: 10, completedReports: [] })).toBe(true);
    expect(isDoneAt({ ...base, receivedQuantity: 9.9999, completedReports: [] })).toBe(false);
  });
});

describe("workInProgressTotals", () => {
  it("sums the rounded rows and leaves unvalued rows out of the value", () => {
    const rows = [
      workInProgressRow(COSTS, 500, "manufacturing_cost"),
      workInProgressRow(COSTS, null, "manufacturing_cost"),
      workInProgressRow(COSTS, 3000, "manufacturing_cost"),
    ];
    expect(workInProgressTotals(rows)).toEqual({
      totals: { material: 3000, labor: 1800, subcontract: 1200, overhead: 420, accumulated: 6420, relieved: 3500 },
      totalValue: 1640,
      unvaluedCount: 1,
      cappedCount: 1,
    });
  });
});
