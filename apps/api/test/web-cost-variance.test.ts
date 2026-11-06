import { describe, expect, it } from "vitest";
// costVariance.ts only imports types, so vitest can load it directly.
import { deviationTone, hasRateDeviation, isZeroAmount, varianceSummaryLines } from "../../web/lib/costVariance.js";
import type { CostVarianceAnalysis } from "../../web/lib/types.js";

const parts = { price: 0, quantity: 0, scrap: 0, rate: 0, setup: 0, run: 0, unclassified: 0, markups: 0 };

function analysis(over: Partial<typeof parts>, ops: CostVarianceAnalysis["operationRows"] = []): CostVarianceAnalysis {
  return {
    outputQuantity: 10,
    preliminary: false,
    basePricedAt: "2026-11-01T10:00:00.000Z",
    baseMaterialSource: "standard",
    base: 0,
    actual: 0,
    deviation: 0,
    parts: { ...parts, ...over },
    materialRows: [],
    operationRows: ops,
  };
}

const timeRow = (split: boolean, hours: number) =>
  ({
    kind: "time",
    id: null,
    sequenceNo: 10,
    workCenterId: "w",
    workCenterCode: "100",
    workCenterName: "Svets",
    baseSetupHours: 0.5,
    baseRunHours: 1,
    baseHourlyRate: 500,
    hours,
    setupHours: null,
    runHours: null,
    unclassifiedHours: hours,
    hourlyRate: 500,
    split,
    base: 0,
    actual: 0,
    deviation: 0,
    parts,
  }) as CostVarianceAnalysis["operationRows"][number];

describe("deviation tone", () => {
  it("treats positive as dearer, negative as cheaper and sub-öre as none", () => {
    expect(deviationTone(12.5)).toBe("dearer");
    expect(deviationTone(-0.01)).toBe("cheaper");
    expect(deviationTone(0.004)).toBe("none");
    expect(isZeroAmount(-0.004)).toBe(true);
  });
});

describe("varianceSummaryLines", () => {
  it("always shows Pris and Mängd, and Ej uppdelad for unsplit time", () => {
    const lines = varianceSummaryLines(analysis({ unclassified: 40 }, [timeRow(false, 3)]));
    expect(lines.map((l) => l.key)).toEqual(["price", "quantity", "unclassified"]);
  });

  it("adds varav kassation as an indented line that is not a summand", () => {
    const lines = varianceSummaryLines(analysis({ quantity: 100, scrap: 30 }));
    const scrap = lines.find((l) => l.key === "scrap");
    expect(scrap).toMatchObject({ sub: true, amount: 30, label: "varav kassation" });
  });

  it("shows Påslag only when nonzero and Ställ/Stycke only for split time", () => {
    expect(varianceSummaryLines(analysis({})).map((l) => l.key)).toEqual(["price", "quantity"]);
    const keys = varianceSummaryLines(analysis({ setup: 5, run: 7, markups: 2 }, [timeRow(true, 2)])).map((l) => l.key);
    expect(keys).toEqual(["price", "quantity", "setup", "run", "markups"]);
  });
});

// Timpris (#14 etapp 4): a column on the specification's Operationer, and a
// summary line, only when some operation's rate differed from T₀'s.
describe("Timpris", () => {
  it("shows the column only when some row has a rate deviation", () => {
    const withRate = { ...timeRow(false, 1.5), parts: { ...parts, rate: 60 } } as CostVarianceAnalysis["operationRows"][number];
    expect(hasRateDeviation([timeRow(false, 1.5), timeRow(true, 2)])).toBe(false);
    expect(hasRateDeviation([timeRow(false, 1.5), withRate])).toBe(true);
    // Under half an öre is no deviation.
    expect(hasRateDeviation([{ parts: { rate: 0.004 } }])).toBe(false);
  });

  it("adds a Timpris line to the summary when nonzero, after Mängd", () => {
    const keys = varianceSummaryLines(analysis({ rate: 60, unclassified: 300 }, [timeRow(false, 1.5)])).map((l) => l.key);
    expect(keys).toEqual(["price", "quantity", "rate", "unclassified"]);
  });
});
