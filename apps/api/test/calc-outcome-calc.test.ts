import { describe, expect, it } from "vitest";
import type { CostVarianceAnalysis, CostVarianceOperationRow, CostVarianceParts } from "@navet/shared";
import {
  analysisOutcome,
  preCalculationOutcome,
  type AnalysisArticleRow,
  type AnalysisOrderRow,
  type AnalysisWorkCenterRow,
  type OutcomePostCalculation,
  type OutcomePreCalculation,
} from "../src/modules/reports/service/calc-outcome-calc.js";

// Kalkylutfall, pure — no database. The input is what the repository gives:
// every TO's latest efterkalkyl in the period (picking it is the
// repository's DISTINCT ON, tested in reports-calc-outcome.test.ts) and the
// article-level förkalkyler of their articles.

const BUCKETS = {
  materialCost: 100,
  materialOverhead: 10,
  laborCost: 70,
  subcontractCost: 0,
  subcontractOverhead: 0,
  semiFinishedCost: 0,
};

// Article-level förkalkyl — what the Kalkyl tab saves. TVK 180 for 10 = 18/st.
function pre(overrides: Partial<OutcomePreCalculation> = {}): OutcomePreCalculation {
  return { articleId: "art-1", quantity: 10, calculatedAt: "2026-08-05T10:00:00.000Z", multiLevel: false, ...BUCKETS, ...overrides };
}

// A TO's latest efterkalkyl, saved before the avvikelseanalys unless given one.
function post(overrides: Partial<OutcomePostCalculation> = {}): OutcomePostCalculation {
  return {
    calculationId: "calc-1",
    manufacturingOrderId: "mo-1",
    orderNumber: "TO-1",
    articleId: "art-1",
    articleNumber: "ART-1",
    articleName: "Artikel",
    quantity: 10,
    calculatedAt: "2026-08-15T10:00:00.000Z",
    configurationCost: null,
    analysis: null,
    ...BUCKETS,
    ...overrides,
  };
}

const ZERO: CostVarianceParts = { price: 0, quantity: 0, scrap: 0, rate: 0, setup: 0, run: 0, unclassified: 0, markups: 0 };

function analysis(overrides: Partial<CostVarianceAnalysis> = {}): CostVarianceAnalysis {
  return {
    outputQuantity: 10,
    preliminary: false,
    basePricedAt: "2026-08-01T08:00:00.000Z",
    baseMaterialSource: "standard",
    base: 180,
    actual: 180,
    deviation: 0,
    parts: ZERO,
    materialRows: [],
    operationRows: [],
    ...overrides,
  };
}

function timeRow(overrides: Partial<Extract<CostVarianceOperationRow, { kind: "time" }>> = {}): CostVarianceOperationRow {
  return {
    kind: "time",
    id: "op",
    sequenceNo: 10,
    workCenterId: "wc-svets",
    workCenterCode: "100",
    workCenterName: "Svets",
    baseSetupHours: 0.5,
    baseRunHours: 1,
    baseHourlyRate: 600,
    hours: 2,
    setupHours: null,
    runHours: null,
    unclassifiedHours: 2,
    hourlyRate: 600,
    split: false,
    base: 900,
    actual: 1200,
    deviation: 300,
    parts: { ...ZERO, unclassified: 300 },
    ...overrides,
  };
}

function legoRow(overrides: Partial<Extract<CostVarianceOperationRow, { kind: "subcontract" }>> = {}): CostVarianceOperationRow {
  return {
    kind: "subcontract",
    id: "lego",
    sequenceNo: 20,
    workCenterId: "wc-lack",
    workCenterCode: "900",
    workCenterName: "Lackering",
    baseQuantity: 4,
    baseUnitPrice: 100,
    baseOneOff: 500,
    subcontractQuantity: 5,
    base: 900,
    actual: 940,
    deviation: 40,
    parts: { ...ZERO, price: -60, quantity: 100 },
    ...overrides,
  };
}

describe("Kalkylutfall — Mot förkalkyl", () => {
  it("pairs a TO's efterkalkyl with the article-level förkalkyl", () => {
    const result = preCalculationOutcome([post()], [pre()]);
    expect(result.view).toBe("pre");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      calculationId: "calc-1",
      manufacturingOrderId: "mo-1",
      orderNumber: "TO-1",
      preSource: "article",
      preCalculatedAt: "2026-08-05T10:00:00.000Z",
      // Saved before the analysis: per the efterkalkyl's quantity, as before.
      perUnitBasis: "quantity",
      outputQuantity: null,
      preliminary: null,
      calculatedTvkPerUnit: null,
    });
    expect(result.notComparable).toEqual({ onlyPost: 0, invalidQuantity: 0, noOutput: 0 });
  });

  it("counts the halvfabrikat bucket in TVK and flags a multi-level förkalkyl", () => {
    // Förkalkyl TVK 180 + 120 = 300 over 10 → 30/st, against 20/st.
    const result = preCalculationOutcome(
      [post({ quantity: 5, materialCost: 60, materialOverhead: 0, laborCost: 40 })],
      [pre({ semiFinishedCost: 120, multiLevel: true })]
    );
    expect(result.rows[0]).toMatchObject({ preTvkPerUnit: 30, postTvkPerUnit: 20, preMultiLevel: true });
  });

  it("compares per-unit TVK across differing lot sizes", () => {
    const result = preCalculationOutcome([post({ quantity: 5, materialCost: 60, materialOverhead: 0, laborCost: 40 })], [pre()]);
    const row = result.rows[0]!;
    expect([row.preTvkPerUnit, row.postTvkPerUnit, row.quantity]).toEqual([18, 20, 5]);
    expect(row.deltaPerUnit).toBeCloseTo(2, 9);
    expect(row.deltaPct).toBeCloseTo(11.1, 1);
  });

  it("uses the article's latest förkalkyl saved at or before the efterkalkyl — never one saved after", () => {
    const result = preCalculationOutcome(
      [post({ calculatedAt: "2026-08-20T10:00:00.000Z" })],
      [
        pre({ calculatedAt: "2026-08-01T10:00:00.000Z", materialCost: 999 }),
        pre({ calculatedAt: "2026-08-05T10:00:00.000Z" }),
        pre({ calculatedAt: "2026-08-25T10:00:00.000Z", materialCost: 555 }),
      ]
    );
    expect(result.rows[0]).toMatchObject({ preCalculatedAt: "2026-08-05T10:00:00.000Z", preTvkPerUnit: 18, deltaPct: 0 });
  });

  it("accepts a förkalkyl saved at the very same instant, and gives two TOs each their own", () => {
    const at = "2026-08-15T10:00:00.000Z";
    expect(preCalculationOutcome([post({ calculatedAt: at })], [pre({ calculatedAt: at })]).rows).toHaveLength(1);
    const result = preCalculationOutcome(
      [
        post({ manufacturingOrderId: "mo-a", orderNumber: "TO-A", calculatedAt: "2026-08-10T10:00:00.000Z" }),
        post({ manufacturingOrderId: "mo-b", orderNumber: "TO-B", calculatedAt: "2026-08-20T10:00:00.000Z" }),
      ],
      [pre({ calculatedAt: "2026-08-01T10:00:00.000Z" }), pre({ calculatedAt: "2026-08-12T10:00:00.000Z", materialCost: 220 })]
    );
    expect(Object.fromEntries(result.rows.map((r) => [r.orderNumber, r.preTvkPerUnit]))).toEqual({ "TO-A": 18, "TO-B": 30 });
  });

  it("counts an efterkalkyl without a comparable förkalkyl as onlyPost and never pairs across articles", () => {
    const result = preCalculationOutcome([post()], [pre({ articleId: "art-other" }), pre({ calculatedAt: "2026-08-16T10:00:00.000Z" })]);
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0, noOutput: 0 });
  });

  it("measures a beställningsvara's TO against its configuration.cost, not the template's förkalkyl", () => {
    const result = preCalculationOutcome(
      [post({ configurationCost: { manufacturingCostPerUnit: 20, calculatedAt: "2026-08-02T09:00:00.000Z" } })],
      [pre()]
    );
    // 180 / 10 = 18 against the configuration's 20 — the template's 18 is not used.
    expect(result.rows[0]).toMatchObject({
      preSource: "configuration",
      preTvkPerUnit: 20,
      preCalculatedAt: "2026-08-02T09:00:00.000Z",
      postTvkPerUnit: 18,
      deltaPct: -10,
      // configuration.cost is the configurator's multi-level previewStructure.
      preMultiLevel: true,
    });
  });

  it("counts a configured TO whose configuration cost is unknown as not comparable", () => {
    const result = preCalculationOutcome(
      [post({ configurationCost: { manufacturingCostPerUnit: null, calculatedAt: "2026-08-02T09:00:00.000Z" } })],
      [pre()]
    );
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 1, invalidQuantity: 0, noOutput: 0 });
  });

  it("divides by N on a final analysis — a kortstängd 10 with 8 delivered — and shows Kalkylerat TVK/st", () => {
    const result = preCalculationOutcome([post({ analysis: analysis({ outputQuantity: 8, base: 160, actual: 180 }) })], [pre()]);
    expect(result.rows[0]).toMatchObject({
      quantity: 10,
      outputQuantity: 8,
      preliminary: false,
      perUnitBasis: "output",
      preTvkPerUnit: 18,
      calculatedTvkPerUnit: 20, // 160 / 8
      postTvkPerUnit: 22.5, // TVK 180 / 8
      deltaPct: 25,
    });
  });

  it("marks a preliminary analysis Ej klar and keeps the efterkalkyl's quantity as the divisor", () => {
    const result = preCalculationOutcome([post({ analysis: analysis({ preliminary: true, outputQuantity: 2 }) })], [pre()]);
    expect(result.rows[0]).toMatchObject({ preliminary: true, outputQuantity: 2, perUnitBasis: "quantity", postTvkPerUnit: 18, calculatedTvkPerUnit: null });
  });

  it("counts a final analysis with N = 0 as noOutput and zero quantities as invalidQuantity", () => {
    const result = preCalculationOutcome(
      [
        post({ analysis: analysis({ outputQuantity: 0 }) }),
        post({ manufacturingOrderId: "mo-2", articleId: "art-2", quantity: 0 }),
        post({ manufacturingOrderId: "mo-3", articleId: "art-3" }),
      ],
      [pre(), pre({ articleId: "art-2" }), pre({ articleId: "art-3", quantity: 0 })]
    );
    expect(result.rows).toHaveLength(0);
    expect(result.notComparable).toEqual({ onlyPost: 0, invalidQuantity: 2, noOutput: 1 });
  });

  it("gives a null deltaPct on a zero förkalkyl, outside the average, and sorts newest first", () => {
    const result = preCalculationOutcome(
      [
        post(),
        post({ manufacturingOrderId: "mo-2", orderNumber: "TO-2", articleId: "art-2", calculatedAt: "2026-08-16T10:00:00.000Z", materialCost: 190 }),
      ],
      [pre({ materialCost: 0, materialOverhead: 0, laborCost: 0 }), pre({ articleId: "art-2" })]
    );
    expect(result.rows.map((r) => r.orderNumber)).toEqual(["TO-2", "TO-1"]);
    expect(result.rows[1]!.deltaPct).toBeNull();
    expect(result.summary).toEqual({ count: 2, avgDeviationPct: 50 }); // TVK 270 vs 180
  });

  it("handles empty input", () => {
    expect(preCalculationOutcome([], [])).toEqual({
      view: "pre",
      rows: [],
      summary: { count: 0, avgDeviationPct: null },
      notComparable: { onlyPost: 0, invalidQuantity: 0, noOutput: 0 },
    });
  });
});

describe("Kalkylutfall — Avvikelseanalys", () => {
  // Two final orders of ART-1 and one of ART-2, one preliminary and one saved
  // before the analysis. Amounts in kronor, parts adding up per order.
  const posts = [
    post({
      calculationId: "c1",
      manufacturingOrderId: "mo-1",
      orderNumber: "TO-1",
      calculatedAt: "2026-08-10T10:00:00.000Z",
      analysis: analysis({
        outputQuantity: 8,
        base: 1800.1,
        actual: 2140.25,
        deviation: 340.15,
        parts: { ...ZERO, price: 20.05, quantity: 10, scrap: 5, unclassified: 300, markups: 10.1 },
        operationRows: [timeRow()],
      }),
    }),
    post({
      calculationId: "c2",
      manufacturingOrderId: "mo-2",
      orderNumber: "TO-2",
      calculatedAt: "2026-08-20T10:00:00.000Z",
      analysis: analysis({
        outputQuantity: 4,
        base: 900.3,
        actual: 900,
        deviation: -0.3,
        parts: { ...ZERO, price: -60.1, quantity: 99.8, unclassified: -40 },
        operationRows: [timeRow({ hours: 1, unclassifiedHours: 1, base: 640, actual: 600, deviation: -40, parts: { ...ZERO, unclassified: -40 } }), legoRow()],
      }),
    }),
    post({
      calculationId: "c3",
      manufacturingOrderId: "mo-3",
      orderNumber: "TO-3",
      articleId: "art-2",
      articleNumber: "ART-10",
      articleName: "Annan",
      calculatedAt: "2026-08-15T10:00:00.000Z",
      analysis: analysis({ outputQuantity: 1, base: 100, actual: 110, deviation: 10, parts: { ...ZERO, quantity: 10 } }),
    }),
    post({ calculationId: "c4", manufacturingOrderId: "mo-4", analysis: analysis({ preliminary: true, base: 1, actual: 99999, deviation: 99998 }) }),
    post({ calculationId: "c5", manufacturingOrderId: "mo-5" }),
  ];

  it("counts preliminary analyses and efterkalkyler without one, outside the sums", () => {
    const result = analysisOutcome(posts, "order");
    expect(result.counts).toEqual({ analysed: 3, preliminary: 1, withoutAnalysis: 1 });
    expect(result.rows.map((r) => (r as AnalysisOrderRow).orderNumber)).toEqual(["TO-2", "TO-3", "TO-1"]);
  });

  it("gives the KPIs over every analysed order, exactly: Avvikelse = Pris + Mängd + Tid + Påslag", () => {
    const { kpis } = analysisOutcome(posts, "workCenter");
    expect(kpis).toEqual({
      base: 2800.4,
      actual: 3150.25,
      deviation: 349.85,
      deviationPct: 12.5,
      price: -40.05,
      quantity: 119.8,
      scrap: 5,
      time: 260,
      markups: 10.1,
    });
    expect(Math.round((kpis.price + kpis.quantity + kpis.time + kpis.markups) * 100)).toBe(Math.round(kpis.deviation * 100));
  });

  it("groups per order with Inlevererat and the parts", () => {
    const result = analysisOutcome(posts, "order");
    expect(result.groupBy).toBe("order");
    const first = result.rows.find((r) => (r as AnalysisOrderRow).orderNumber === "TO-1") as AnalysisOrderRow;
    expect(first).toMatchObject({
      calculationId: "c1",
      manufacturingOrderId: "mo-1",
      articleNumber: "ART-1",
      outputQuantity: 8,
      base: 1800.1,
      actual: 2140.25,
      deviation: 340.15,
      deviationPct: 18.9,
    });
    expect(first.parts).toEqual({ ...ZERO, price: 20.05, quantity: 10, scrap: 5, unclassified: 300, markups: 10.1 });
    expect(result.totals).toMatchObject({ base: 2800.4, actual: 3150.25, deviation: 349.85 });
  });

  it("groups per article with Antal TO and Σ Inlevererat, sorted on the article number", () => {
    const result = analysisOutcome(posts, "article");
    const rows = result.rows as AnalysisArticleRow[];
    expect(rows.map((r) => [r.articleNumber, r.orderCount, r.outputQuantity])).toEqual([
      ["ART-1", 2, 12],
      ["ART-10", 1, 1],
    ]);
    expect(rows[0]).toMatchObject({ base: 2700.4, actual: 3040.25, deviation: 339.85 });
    expect(rows[0]!.parts).toMatchObject({ price: -40.05, quantity: 109.8, unclassified: 260, markups: 10.1 });
  });

  it("groups per resource from the operation rows: hours for time, quantities for lego", () => {
    const result = analysisOutcome(posts, "workCenter");
    const rows = result.rows as AnalysisWorkCenterRow[];
    expect(rows.map((r) => r.key)).toEqual(["wc-svets:time", "wc-lack:subcontract"]);
    expect(rows[0]).toMatchObject({
      workCenterCode: "100",
      kind: "time",
      operationCount: 2,
      orderCount: 2,
      baseSetupHours: 1,
      baseRunHours: 2,
      // Not split into ställ/produktion yet: no verklig ställ/stycke.
      setupHours: null,
      runHours: null,
      unclassifiedHours: 3,
      hours: 3,
      timeDeviation: 260,
      baseQuantity: null,
      base: 1540,
      actual: 1800,
      deviation: 260,
    });
    expect(rows[1]).toMatchObject({
      workCenterCode: "900",
      kind: "subcontract",
      baseSetupHours: null,
      hours: null,
      timeDeviation: null,
      baseQuantity: 4,
      subcontractQuantity: 5,
      base: 900,
      actual: 940,
    });
    expect(rows[1]!.parts).toMatchObject({ price: -60, quantity: 100 });
    // The table sums the operations only; the KPIs stay the orders'.
    expect(result.totals).toMatchObject({ base: 2440, actual: 2740, deviation: 300 });
    expect(result.kpis.deviation).toBe(349.85);
  });

  it("sums verklig ställ/stycke once an operation has its time split", () => {
    const split = post({
      analysis: analysis({
        operationRows: [
          timeRow({ setupHours: 0.75, runHours: 1.25, unclassifiedHours: 0, split: true, parts: { ...ZERO, setup: 150, run: 150 } }),
          timeRow({ id: "op2", hours: 0.3333, unclassifiedHours: 0.3333 }),
        ],
      }),
    });
    const [row] = analysisOutcome([split], "workCenter").rows as AnalysisWorkCenterRow[];
    expect(row).toMatchObject({ setupHours: 0.75, runHours: 1.25, unclassifiedHours: 0.3333, hours: 2.3333 });
  });

  it("handles no analysed orders", () => {
    const result = analysisOutcome([post()], "article");
    expect(result.rows).toEqual([]);
    expect(result.counts).toEqual({ analysed: 0, preliminary: 0, withoutAnalysis: 1 });
    expect(result.kpis).toMatchObject({ deviation: 0, deviationPct: null });
  });
});
