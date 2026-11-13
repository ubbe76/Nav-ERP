import { describe, expect, it } from "vitest";
import { BatchInsufficientError } from "../src/modules/stock/service/batch.errors.js";
import {
  allocateBatchOutflow,
  compareBatchCells,
  compareBatches,
  withBatchRemainder,
  type BatchCell,
  type OutflowCandidate,
} from "../src/modules/stock/service/outflow-allocation.js";

// Batch (#8) — the pure split rule per cell (place, batch); no database.

function place(over: Partial<OutflowCandidate> & { locationId: string }): OutflowCandidate {
  return {
    warehouseName: "Huvudlager",
    locationName: over.locationId,
    quantityOnHand: 0,
    preference: null,
    active: true,
    blocked: false,
    ...over,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

// A named batch created `age` days after T0 — a lower age is an older batch.
function cell(locationId: string, batch: string | null, quantity: number, age = 0): BatchCell {
  return {
    locationId,
    batchId: batch === null ? null : `id-${batch}`,
    batchNumber: batch,
    batchCreatedAt: batch === null ? null : new Date(T0 + age * DAY),
    quantity,
  };
}

describe("compareBatches", () => {
  it("Okänd first, then the oldest, then the batch number (numeric), then the id", () => {
    const batches = [
      { batchId: "c", batchNumber: "L-10", batchCreatedAt: new Date(T0 + DAY) },
      { batchId: "b", batchNumber: "L-2", batchCreatedAt: new Date(T0 + DAY) },
      { batchId: "a", batchNumber: "Z", batchCreatedAt: new Date(T0) },
      { batchId: null, batchNumber: null, batchCreatedAt: null },
    ];
    expect([...batches].sort(compareBatches).map((b) => b.batchNumber)).toEqual([null, "Z", "L-2", "L-10"]);
    expect(compareBatches(batches[3]!, batches[3]!)).toBe(0);
    // Same age and number (cannot happen within one article): the id decides.
    const twin = { batchId: "d", batchNumber: "L-2", batchCreatedAt: new Date(T0 + DAY) };
    expect(compareBatches(batches[1]!, twin)).toBeLessThan(0);
  });

  it("compareBatchCells: the batch first, then the place in pick-list order", () => {
    const old = { batchId: "a", batchNumber: "A", batchCreatedAt: new Date(T0) };
    const young = { batchId: "b", batchNumber: "B", batchCreatedAt: new Date(T0 + DAY) };
    const own = { warehouseName: "Huvudlager", locationName: "Z9", preference: 0 };
    const other = { warehouseName: "Huvudlager", locationName: "A1", preference: null };
    const cells = [
      { batch: young, place: own },
      { batch: old, place: other },
      { batch: old, place: own },
    ];
    expect(cells.sort(compareBatchCells).map((c) => `${c.batch.batchNumber}@${c.place.locationName}`)).toEqual(["A@Z9", "A@A1", "B@Z9"]);
  });
});

describe("allocateBatchOutflow — Automatiskt", () => {
  it("draws Okänd first, then the oldest batch", () => {
    const { parts, remainder } = allocateBatchOutflow(
      12,
      [place({ locationId: "A1", quantityOnHand: 20 })],
      [cell("A1", "NY", 8, 5), cell("A1", "GAMMAL", 7, 1), cell("A1", null, 5)]
    );
    expect(parts).toEqual([
      { locationId: "A1", quantity: 5, batchId: null },
      { locationId: "A1", quantity: 7, batchId: "id-GAMMAL" },
    ]);
    expect(remainder).toBe(0);
  });

  it("the batch decides before the place: an old batch on another place goes before a young one on the huvudplats", () => {
    const { parts } = allocateBatchOutflow(
      6,
      [place({ locationId: "own", quantityOnHand: 10, preference: 0 }), place({ locationId: "B2", quantityOnHand: 4 })],
      [cell("own", "NY", 10, 9), cell("B2", "GAMMAL", 4, 1)]
    );
    expect(parts).toEqual([
      { locationId: "B2", quantity: 4, batchId: "id-GAMMAL" },
      { locationId: "own", quantity: 2, batchId: "id-NY" },
    ]);
  });

  it("within one batch the places come in pick-list order: huvudplats, alternatives, others, *** last", () => {
    const { parts } = allocateBatchOutflow(
      40,
      [
        place({ locationId: "fallback", warehouseName: "***", locationName: "***", quantityOnHand: 10 }),
        place({ locationId: "B1", quantityOnHand: 10 }),
        place({ locationId: "alt", quantityOnHand: 10, preference: 1 }),
        place({ locationId: "own", quantityOnHand: 10, preference: 0 }),
      ],
      [cell("fallback", "X", 10), cell("B1", "X", 10), cell("alt", "X", 10), cell("own", "X", 10)]
    );
    expect(parts.map((p) => p.locationId)).toEqual(["own", "alt", "B1", "fallback"]);
  });

  it("the place ceiling: a place never gives more than its net balance, the rest is the remainder", () => {
    // Batch X +10 and Okänd −3 on A1: physically 7 there.
    const { parts, remainder } = allocateBatchOutflow(
      10,
      [place({ locationId: "A1", quantityOnHand: 7 })],
      [cell("A1", "X", 10, 1), cell("A1", null, -3)]
    );
    expect(parts).toEqual([{ locationId: "A1", quantity: 7, batchId: "id-X" }]);
    expect(remainder).toBe(3);
  });

  it("the ceiling is shared by the batches of one place", () => {
    // X +6, Y +6, Okänd −4 on A1 (net 8); X +5 on B1.
    const { parts, remainder } = allocateBatchOutflow(
      20,
      [place({ locationId: "A1", quantityOnHand: 8, preference: 0 }), place({ locationId: "B1", quantityOnHand: 5 })],
      [cell("A1", "X", 6, 1), cell("A1", "Y", 6, 2), cell("A1", null, -4), cell("B1", "X", 5, 1)]
    );
    expect(parts).toEqual([
      { locationId: "A1", quantity: 6, batchId: "id-X" },
      { locationId: "B1", quantity: 5, batchId: "id-X" },
      { locationId: "A1", quantity: 2, batchId: "id-Y" },
    ]);
    expect(remainder).toBe(7);
  });

  it("skips blocked and inactive places and places without a net balance", () => {
    const { parts, remainder } = allocateBatchOutflow(
      9,
      [
        place({ locationId: "karantan", quantityOnHand: 50, blocked: true }),
        place({ locationId: "avstalld", quantityOnHand: 50, active: false }),
        place({ locationId: "netto0", quantityOnHand: 0 }),
        place({ locationId: "A1", quantityOnHand: 4 }),
      ],
      [cell("karantan", "X", 50), cell("avstalld", "X", 50), cell("netto0", "X", 5), cell("netto0", null, -5), cell("A1", "X", 4)]
    );
    expect(parts).toEqual([{ locationId: "A1", quantity: 4, batchId: "id-X" }]);
    expect(remainder).toBe(5);
  });

  it("no stock at all: everything is the remainder, and nothing or less than nothing gives no parts", () => {
    expect(allocateBatchOutflow(3, [], [])).toEqual({ parts: [], remainder: 3 });
    expect(allocateBatchOutflow(0, [place({ locationId: "A1", quantityOnHand: 5 })], [cell("A1", "X", 5)])).toEqual({ parts: [], remainder: 0 });
    expect(allocateBatchOutflow(-2, [place({ locationId: "A1", quantityOnHand: 5 })], [cell("A1", "X", 5)])).toEqual({ parts: [], remainder: 0 });
  });

  it("works at the stock column's four decimals and never makes a part of 0", () => {
    const { parts, remainder } = allocateBatchOutflow(
      0.3,
      [place({ locationId: "A1", quantityOnHand: 0.30004 })],
      [cell("A1", null, 0.00004), cell("A1", "X", 0.1, 1), cell("A1", "Y", 0.2, 2)]
    );
    expect(parts).toEqual([
      { locationId: "A1", quantity: 0.1, batchId: "id-X" },
      { locationId: "A1", quantity: 0.2, batchId: "id-Y" },
    ]);
    expect(remainder).toBe(0);
  });
});

describe("allocateBatchOutflow — a chosen batch", () => {
  const places = [place({ locationId: "own", quantityOnHand: 10, preference: 0 }), place({ locationId: "B1", quantityOnHand: 10 })];
  const cells = [cell("own", null, 4), cell("own", "X", 6, 1), cell("B1", "X", 3, 1), cell("B1", "Y", 7, 2)];

  it("takes only that batch's cells, in place order", () => {
    const { parts, remainder } = allocateBatchOutflow(8, places, cells, { batch: { batchId: "id-X" } });
    expect(parts).toEqual([
      { locationId: "own", quantity: 6, batchId: "id-X" },
      { locationId: "B1", quantity: 2, batchId: "id-X" },
    ]);
    expect(remainder).toBe(0);
  });

  it("a named batch never goes negative: 409 batch-insufficient with what there is", () => {
    const attempt = () => allocateBatchOutflow(12, places, cells, { batch: { batchId: "id-X" } });
    expect(attempt).toThrow(BatchInsufficientError);
    try {
      attempt();
    } catch (err) {
      expect(err).toMatchObject({ batchNumber: "X", available: 9, requested: 12 });
    }
  });

  it("…also when the place ceiling is what stops it, and a batch without stock is named by the caller", () => {
    expect(() =>
      allocateBatchOutflow(10, [place({ locationId: "A1", quantityOnHand: 7 })], [cell("A1", "X", 10, 1), cell("A1", null, -3)], {
        batch: { batchId: "id-X" },
      })
    ).toThrow(/Batch X räcker inte: 7 tillgängligt, 10 begärt/);
    expect(() => allocateBatchOutflow(1, places, cells, { batch: { batchId: "id-TOM", batchNumber: "TOM" } })).toThrow(
      /Batch TOM räcker inte: 0 tillgängligt, 1 begärt/
    );
  });

  it("chosen Okänd: only the cells without a batch, and the rest is the remainder (Okänd may go negative)", () => {
    const { parts, remainder } = allocateBatchOutflow(9, places, cells, { batch: { batchId: null } });
    expect(parts).toEqual([{ locationId: "own", quantity: 4, batchId: null }]);
    expect(remainder).toBe(5);
  });
});

describe("allocateBatchOutflow — a chosen place", () => {
  it("only that place's cells, oldest first, without the ceiling; the rest is the remainder", () => {
    // Okänd −3 and X +10 on A1: the chosen place may go negative as before.
    const { parts, remainder } = allocateBatchOutflow(
      12,
      [place({ locationId: "A1", quantityOnHand: 7 }), place({ locationId: "B1", quantityOnHand: 50 })],
      [cell("A1", "X", 10, 1), cell("A1", null, -3), cell("B1", "X", 50, 1)],
      { locationId: "A1" }
    );
    expect(parts).toEqual([{ locationId: "A1", quantity: 10, batchId: "id-X" }]);
    expect(remainder).toBe(2);
  });

  it("a blocked or inactive chosen place is the loader's business, not the rule's", () => {
    const { parts } = allocateBatchOutflow(2, [place({ locationId: "A1", quantityOnHand: 5, blocked: true })], [cell("A1", "X", 5)], {
      locationId: "A1",
    });
    expect(parts).toEqual([{ locationId: "A1", quantity: 2, batchId: "id-X" }]);
  });

  it("with a chosen named batch the cell must cover the quantity", () => {
    const cells = [cell("A1", "X", 3, 1), cell("B1", "X", 50, 1)];
    expect(() => allocateBatchOutflow(4, [], cells, { locationId: "A1", batch: { batchId: "id-X" } })).toThrow(BatchInsufficientError);
    expect(allocateBatchOutflow(3, [], cells, { locationId: "A1", batch: { batchId: "id-X" } }).parts).toEqual([
      { locationId: "A1", quantity: 3, batchId: "id-X" },
    ]);
  });
});

describe("withBatchRemainder", () => {
  it("books the remainder as Okänd on the resolved place", () => {
    expect(withBatchRemainder([{ locationId: "A1", quantity: 7, batchId: "x" }], 3, "A1")).toEqual([
      { locationId: "A1", quantity: 7, batchId: "x" },
      { locationId: "A1", quantity: 3, batchId: null },
    ]);
  });

  it("merges with a part already taken from Okänd on that place — never two rows in one cell", () => {
    expect(
      withBatchRemainder(
        [
          { locationId: "A1", quantity: 2, batchId: null },
          { locationId: "B1", quantity: 1, batchId: null },
        ],
        3,
        "A1"
      )
    ).toEqual([
      { locationId: "A1", quantity: 5, batchId: null },
      { locationId: "B1", quantity: 1, batchId: null },
    ]);
  });

  it("no remainder leaves the parts as they are", () => {
    const parts = [{ locationId: "A1", quantity: 2, batchId: "x" }];
    expect(withBatchRemainder(parts, 0, "A1")).toBe(parts);
  });
});
