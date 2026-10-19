import { describe, expect, it } from "vitest";
import {
  pairCalculationOutcomes,
  type CalcRowInput,
} from "../src/modules/reports/service/calc-outcome-calc.js";

// Pure pairing tests — no database. Spec for för- vs efterkalkylutfall: a
// förkalkyl lives on the ARTICLE (no MO), an efterkalkyl on its MO, and each
// MO's latest post is measured against the article's latest pre saved at or
// before it.

const RANGE = { from: "2026-08", to: "2026-08" };

const BASE: CalcRowInput = {
  articleId: "art-1",
  manufacturingOrderId: null,
  orderNumber: null,
  configured: false,
  articleNumber: "ART-1",
  articleName: "Artikel",
  type: "pre",
  quantity: 10,
  calculatedAt: "2026-08-10T10:00:00.000Z",
  materialCost: 100,
  materialOverhead: 10,
  laborCost: 50,
  overhead: 20,
  subcontractCost: 0,
  subcontractOverhead: 0,
  semiFinishedCost: 0,
  multiLevel: false,
};

// Article-level pre-calculation — what the Kalkyl tab saves (MO null).
function pre(overrides: Partial<CalcRowInput> = {}): CalcRowInput {
  return { ...BASE, type: "pre", calculatedAt: "2026-08-05T10:00:00.000Z", ...overrides };
}

// MO-linked post-calculation — what Efterkalkylera saves.
function post(overrides: Partial<CalcRowInput> = {}): CalcRowInput {
  return {
    ...BASE,
    type: "post",
    manufacturingOrderId: "mo-1",
    orderNumber: "TO-1",
    calculatedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

describe("pairCalculationOutcomes", () => {
  it("pairs an MO's post with the article-level pre — the regression where every order was 'endast efterkalkyl'", () => {
    // The pre carries no MO at all (manufacturingOrderId null), exactly as
    // costing.service saves it. Pairing by MO alone can never match it.
    const result = pairCalculationOutcomes([pre(), post()], RANGE);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.manufacturingOrderId).toBe("mo-1");
    expect(result.rows[0]!.orderNumber).toBe("TO-1");
    expect(result.rows[0]!.preCalculatedAt).toBe("2026-08-05T10:00:00.000Z");
    expect(result.notComparable).toEqual({ onlyPost: 0, invalidQuantity: 0 });
  });

  it("counts the halvfabrikat bucket in TVK and flags a multi-level pre-calculation", () => {
    // The bucket is invisible in the report if tvk() forgets it: nothing
    // crashes, the deviation is simply wrong. Pre TVK 180 + 120 = 300 over 10
    // units → 30/unit, against a post at 20/unit.
    const result = pairCalculationOutcomes(
      [
        pre({ semiFinishedCost: 120, multiLevel: true }),
        post({ quantity: 5, materialCost: 60, materialOverhead: 0, laborCost: 30, overhead: 10 }),
      ],
      RANGE
    );

    expect(result.rows[0]!.preTvkPerUnit).toBe(30);
    expect(result.rows[0]!.postTvkPerUnit).toBe(20);
    expect(result.rows[0]!.preMultiLevel).toBe(true);
  });

  it("compares per-unit TVK across differing lot sizes", () => {
    // Pre: TVK 180 for 10 units → 18/unit. Post: TVK 100 for 5 units → 20/unit.
    const result = pairCalculationOutcomes(
      [pre(), post({ quantity: 5, materialCost: 60, materialOverhead: 0, laborCost: 30, overhead: 10 })],
      RANGE
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.preTvkPerUnit).toBe(18);
    expect(row.postTvkPerUnit).toBe(20);
    expect(row.deltaPerUnit).toBeCloseTo(2, 9);
    expect(row.deltaPct).toBeCloseTo(11.1, 1); // (20-18)/18
    expect(row.quantity).toBe(5);
    expect(result.summary.count).toBe(1);
  });

  it("uses the MO's latest post and the article's latest pre saved at or before it", () => {
    const result = pairCalculationOutcomes(
      [
        pre({ calculatedAt: "2026-08-01T10:00:00.000Z", materialCost: 999 }),
        pre({ calculatedAt: "2026-08-05T10:00:00.000Z" }), // in force at the post: TVK 180
        pre({ calculatedAt: "2026-08-25T10:00:00.000Z", materialCost: 555 }), // after the post — hindsight, ignored
        post({ calculatedAt: "2026-08-10T10:00:00.000Z", materialCost: 999 }),
        post({ calculatedAt: "2026-08-20T10:00:00.000Z" }), // latest post: TVK 180
      ],
      RANGE
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.preCalculatedAt).toBe("2026-08-05T10:00:00.000Z");
    expect(result.rows[0]!.preTvkPerUnit).toBe(18);
    expect(result.rows[0]!.postTvkPerUnit).toBe(18);
    expect(result.rows[0]!.deltaPct).toBe(0);
  });

  it("accepts a pre saved at the very same instant as the post", () => {
    const at = "2026-08-15T10:00:00.000Z";
    const result = pairCalculationOutcomes([pre({ calculatedAt: at }), post({ calculatedAt: at })], RANGE);
    expect(result.rows).toHaveLength(1);
  });

  it("gives two MOs of the same article each the pre that was in force when they were costed", () => {
    const result = pairCalculationOutcomes(
      [
        pre({ calculatedAt: "2026-08-01T10:00:00.000Z" }), // TVK 180 → 18/st
        pre({ calculatedAt: "2026-08-12T10:00:00.000Z", materialCost: 220 }), // TVK 300 → 30/st
        post({ manufacturingOrderId: "mo-a", orderNumber: "TO-A", calculatedAt: "2026-08-10T10:00:00.000Z" }),
        post({ manufacturingOrderId: "mo-b", orderNumber: "TO-B", calculatedAt: "2026-08-20T10:00:00.000Z" }),
      ],
      RANGE
    );
    const byOrder = Object.fromEntries(result.rows.map((r) => [r.orderNumber, r.preTvkPerUnit]));
    expect(byOrder).toEqual({ "TO-A": 18, "TO-B": 30 });
  });

  it("never pairs across articles", () => {
    const result = pairCalculationOutcomes([pre({ articleId: "art-other" }), post()], RANGE);
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0 });
  });

  it("counts an MO post with no earlier article pre as onlyPost — a pre on its own counts nothing", () => {
    const result = pairCalculationOutcomes(
      [
        pre({ articleId: "art-pre-only" }),
        post({ calculatedAt: "2026-08-15T10:00:00.000Z" }),
        pre({ calculatedAt: "2026-08-16T10:00:00.000Z" }), // saved after the post — not in force
      ],
      RANGE
    );
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0 });
  });

  it("does not measure a beställningsvara's TO against the template article's own pre", () => {
    // The configured TO's estimate is its configuration's förkalkyl; the
    // template's article-level calculation describes a different structure.
    const result = pairCalculationOutcomes([pre(), post({ configured: true })], RANGE);
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0 });
  });

  it("ignores a pre-calculation that carries an MO", () => {
    // No code path saves one; if it ever appears it must not pose as the
    // article's estimate.
    const result = pairCalculationOutcomes([pre({ manufacturingOrderId: "mo-1", orderNumber: "TO-1" }), post()], RANGE);
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable.onlyPost).toBe(1);
  });

  it("scopes the counters to the post's month — no all-time counts under a filtered table", () => {
    const result = pairCalculationOutcomes(
      [
        post({ manufacturingOrderId: "mo-old", orderNumber: "TO-OLD", calculatedAt: "2024-05-01T10:00:00.000Z" }),
        pre({ articleId: "art-2", calculatedAt: "2026-08-20T10:00:00.000Z" }),
        post({ manufacturingOrderId: "mo-new", orderNumber: "TO-NEW", articleId: "art-2" }), // pre is later → onlyPost
      ],
      RANGE
    );
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0 });
  });

  it("null deltaPct when pre TVK is zero, excluded from the average", () => {
    const result = pairCalculationOutcomes(
      [
        pre({ materialCost: 0, materialOverhead: 0, laborCost: 0, overhead: 0 }),
        post(),
        pre({ articleId: "art-2" }),
        post({
          articleId: "art-2",
          manufacturingOrderId: "mo-2",
          orderNumber: "TO-2",
          calculatedAt: "2026-08-16T10:00:00.000Z",
          materialCost: 190,
          materialOverhead: 10,
          laborCost: 50,
          overhead: 20,
        }), // TVK 270 vs 180 → +50 %
      ],
      RANGE
    );
    expect(result.rows).toHaveLength(2);
    const zeroPre = result.rows.find((r) => r.orderNumber === "TO-1")!;
    expect(zeroPre.deltaPct).toBeNull();
    expect(result.summary.avgDeviationPct).toBe(50); // only TO-2 counts
  });

  it("excludes zero-quantity calculations and counts them", () => {
    const result = pairCalculationOutcomes([pre({ quantity: 0 }), post()], RANGE);
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable.invalidQuantity).toBe(1);
  });

  it("filters on the post calculation's Stockholm month and sorts newest first", () => {
    const result = pairCalculationOutcomes(
      [
        pre({ calculatedAt: "2026-07-01T10:00:00.000Z" }),
        post({ manufacturingOrderId: "mo-jul", orderNumber: "TO-JUL", calculatedAt: "2026-07-20T10:00:00.000Z" }),
        post({ manufacturingOrderId: "mo-a", orderNumber: "TO-A", calculatedAt: "2026-08-12T10:00:00.000Z" }),
        post({ manufacturingOrderId: "mo-b", orderNumber: "TO-B", calculatedAt: "2026-08-25T10:00:00.000Z" }),
        // 31 July 23:30 UTC is 1 August in Stockholm.
        post({ manufacturingOrderId: "mo-edge", orderNumber: "TO-EDGE", calculatedAt: "2026-07-31T23:30:00.000Z" }),
      ],
      RANGE
    );
    expect(result.rows.map((r) => r.orderNumber)).toEqual(["TO-B", "TO-A", "TO-EDGE"]);
  });

  it("handles empty input", () => {
    const result = pairCalculationOutcomes([], RANGE);
    expect(result.rows).toEqual([]);
    expect(result.summary).toEqual({ count: 0, avgDeviationPct: null });
    expect(result.notComparable).toEqual({ onlyPost: 0, invalidQuantity: 0 });
  });
});
