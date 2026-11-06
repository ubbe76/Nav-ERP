import { describe, expect, it } from "vitest";
import {
  allocateOutflow,
  compareOutflowLocations,
  withRemainder,
  type OutflowCandidate,
} from "../src/modules/stock/service/outflow-allocation.js";

// Uttag där saldot finns — the pure split rule (no database).

function candidate(over: Partial<OutflowCandidate> & { locationId: string }): OutflowCandidate {
  return {
    warehouseName: "Huvudlager",
    locationName: over.locationId,
    quantityOnHand: 0,
    isDefault: false,
    active: true,
    blocked: false,
    ...over,
  };
}

describe("allocateOutflow", () => {
  it("takes the article's own location first, up to its positive balance", () => {
    const { parts, remainder } = allocateOutflow(5, [
      candidate({ locationId: "A1", quantityOnHand: 10 }),
      candidate({ locationId: "Z9", quantityOnHand: 3, isDefault: true }),
    ]);
    expect(parts).toEqual([
      { locationId: "Z9", quantity: 3 },
      { locationId: "A1", quantity: 2 },
    ]);
    expect(remainder).toBe(0);
  });

  it("then the other locations in pick-list order (warehouse, location), *** last", () => {
    const { parts } = allocateOutflow(25, [
      candidate({ locationId: "fallback", locationName: "***", warehouseName: "***", quantityOnHand: 100 }),
      candidate({ locationId: "B-A10", warehouseName: "B-lager", locationName: "A10", quantityOnHand: 5 }),
      candidate({ locationId: "B-A2", warehouseName: "B-lager", locationName: "A2", quantityOnHand: 5 }),
      candidate({ locationId: "A-C1", warehouseName: "A-lager", locationName: "C1", quantityOnHand: 5 }),
    ]);
    expect(parts.map((p) => p.locationId)).toEqual(["A-C1", "B-A2", "B-A10", "fallback"]);
    expect(parts.at(-1)!.quantity).toBe(10);
  });

  it("skips negative, empty, inactive and blocked locations", () => {
    const { parts, remainder } = allocateOutflow(4, [
      candidate({ locationId: "neg", quantityOnHand: -3, isDefault: true }),
      candidate({ locationId: "zero", quantityOnHand: 0 }),
      candidate({ locationId: "inactive", quantityOnHand: 9, active: false }),
      candidate({ locationId: "counted", quantityOnHand: 9, blocked: true }),
      candidate({ locationId: "ok", quantityOnHand: 1 }),
    ]);
    expect(parts).toEqual([{ locationId: "ok", quantity: 1 }]);
    expect(remainder).toBe(3);
  });

  // Spärrade lagerplatser (0185): outflow-locations.ts marks a blocked place
  // as `blocked` just like a place under a blocking stock count — even the
  // article's own Lagerplats.
  it("skips a Spärrad lagerplats exactly like a place under a blocking count, own place included", () => {
    const { parts, remainder } = allocateOutflow(6, [
      candidate({ locationId: "own-karantan", quantityOnHand: 50, isDefault: true, blocked: true }),
      candidate({ locationId: "B2", quantityOnHand: 4 }),
    ]);
    expect(parts).toEqual([{ locationId: "B2", quantity: 4 }]);
    expect(remainder).toBe(2);
  });

  it("reports what is missing as the remainder, at 4 decimals", () => {
    const { parts, remainder } = allocateOutflow(1, [candidate({ locationId: "A1", quantityOnHand: 0.3333 })]);
    expect(parts).toEqual([{ locationId: "A1", quantity: 0.3333 }]);
    expect(remainder).toBe(0.6667);
    expect(allocateOutflow(0, [candidate({ locationId: "A1", quantityOnHand: 5 })])).toEqual({ parts: [], remainder: 0 });
  });
});

describe("withRemainder", () => {
  it("adds the remainder on the fallback location, merged with an existing part there", () => {
    expect(withRemainder([{ locationId: "A1", quantity: 3 }], 2, "A1")).toEqual([{ locationId: "A1", quantity: 5 }]);
    expect(withRemainder([{ locationId: "A1", quantity: 3 }], 2, "***")).toEqual([
      { locationId: "A1", quantity: 3 },
      { locationId: "***", quantity: 2 },
    ]);
    expect(withRemainder([], 2, "A1")).toEqual([{ locationId: "A1", quantity: 2 }]);
    const parts = [{ locationId: "A1", quantity: 3 }];
    expect(withRemainder(parts, 0, "A1")).toBe(parts);
  });
});

describe("compareOutflowLocations", () => {
  it("is the pick list's order: own location, then warehouse and location naturally, *** last", () => {
    const sorted = [
      { warehouseName: "***", locationName: "***", isDefault: false },
      { warehouseName: "Huvudlager", locationName: "A10", isDefault: false },
      { warehouseName: "Huvudlager", locationName: "A2", isDefault: false },
      { warehouseName: "Annex", locationName: "Z", isDefault: false },
      { warehouseName: "Huvudlager", locationName: "B1", isDefault: true },
    ].sort(compareOutflowLocations);
    expect(sorted.map((l) => l.locationName)).toEqual(["B1", "Z", "A2", "A10", "***"]);
  });
});
