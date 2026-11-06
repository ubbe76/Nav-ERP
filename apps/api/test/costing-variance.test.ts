import { describe, expect, it } from "vitest";
import {
  costVarianceAnalysis,
  isPreliminaryStatus,
  materialOutput,
  materialScrap,
  materialVariance,
  oneOffCounts,
  operationOutput,
  operationWorked,
  plannedShare,
  roundAsNumeric,
  subcontractVariance,
  timeVariance,
  type VarianceHeader,
  type VarianceMaterialInput,
  type VarianceOperationInput,
} from "../src/modules/costing/service/cost-variance.js";

// Avvikelseanalys i efterkalkylen (#14) — the pure rules and formulas of
// cost-variance.ts. Amounts in öre inside the file, kronor out.

const header = (over: Partial<VarianceHeader> = {}): VarianceHeader => ({
  outputQuantity: 10,
  preliminary: false,
  basePricedAt: new Date("2026-03-01T09:00:00Z"),
  baseMaterialSource: "standard",
  moPercent: 0,
  loPercent: 0,
  ...over,
});

const material = (over: Partial<VarianceMaterialInput> = {}): VarianceMaterialInput => ({
  id: null,
  componentArticleId: "c1",
  articleNumber: "K-1",
  articleName: "Komponent",
  kind: "material",
  quantity: 20,
  unitCost: 10,
  amount: 200,
  baseQuantity: 20,
  baseUnitCost: 10,
  basePriceSource: "standard",
  scrapQuantity: 0,
  ...over,
});

const timeOp = (over: Partial<VarianceOperationInput> = {}): VarianceOperationInput => ({
  id: null,
  sequenceNo: 10,
  workCenterId: "w1",
  workCenterCode: "100",
  workCenterName: "Svets",
  hours: 3,
  setupHours: null,
  runHours: null,
  hourlyRate: 600,
  laborAmount: 1800,
  subcontractAmount: null,
  baseSetupHours: 0.5,
  baseRunHours: 2,
  baseHourlyRate: 600,
  baseQuantity: null,
  subcontractQuantity: null,
  baseUnitPrice: null,
  baseOneOff: null,
  ...over,
});

const legoOp = (over: Partial<VarianceOperationInput> = {}): VarianceOperationInput => ({
  ...timeOp(),
  sequenceNo: 20,
  workCenterId: "w2",
  workCenterCode: "900",
  workCenterName: "Ytbehandling",
  hours: 0,
  hourlyRate: 0,
  laborAmount: 0,
  subcontractAmount: 810,
  baseSetupHours: null,
  baseRunHours: null,
  baseHourlyRate: null,
  baseQuantity: 4,
  subcontractQuantity: 4,
  baseUnitPrice: 100,
  baseOneOff: 500,
  ...over,
});

// Σ parts (scrap is "varav" and not added) in öre.
function partsSum(parts: { price: number; quantity: number; rate: number; setup: number; run: number; unclassified: number; markups: number }) {
  return Math.round(
    (parts.price + parts.quantity + parts.rate + parts.setup + parts.run + parts.unclassified + parts.markups) * 100
  );
}
const ore = (kronor: number) => Math.round(kronor * 100);

describe("cost-variance — N and the setup rule", () => {
  it("is final on Klar and Stängd, preliminary otherwise", () => {
    expect(isPreliminaryStatus("done")).toBe(false);
    expect(isPreliminaryStatus("closed")).toBe(false);
    for (const status of ["planned", "released", "in_progress", "cancelled"]) expect(isPreliminaryStatus(status)).toBe(true);
  });

  it("uses the received quantity on a final order, whatever the operation reported", () => {
    const done = { preliminary: false, received: 8 };
    // Kortstängd: 8 of 10 received, the operation reported 9 OK.
    expect(operationOutput(done, 9)).toBe(8);
    expect(materialOutput(done, { completed: 9 })).toBe(8);
    expect(materialOutput(done, null)).toBe(8);
  });

  it("uses each operation's OK on a preliminary order, and the received quantity for unlinked material", () => {
    const open = { preliminary: true, received: 2 };
    expect(operationOutput(open, 5)).toBe(5);
    expect(materialOutput(open, { completed: 5 })).toBe(5);
    expect(materialOutput(open, null)).toBe(2);
  });

  it("gives N 0 on an order closed short at 0, and keeps the order's N when an operation over-reported", () => {
    expect(operationOutput({ preliminary: false, received: 0 }, 3)).toBe(0);
    // Överrapporterad: 12 OK on an order of 10 that received 10 — the 2 are a deviation.
    expect(operationOutput({ preliminary: false, received: 10 }, 12)).toBe(10);
    // Preliminary, the over-report is still work in progress.
    expect(operationOutput({ preliminary: true, received: 0 }, 12)).toBe(12);
  });

  it("counts the setup and the lego one-off once the operation is worked, or on a final order with N > 0", () => {
    expect(operationWorked({ hours: 0, completed: 0, scrapped: 0 })).toBe(false);
    expect(operationWorked({ hours: 0.5, completed: 0, scrapped: 0 })).toBe(true);
    expect(operationWorked({ hours: 0, completed: 1, scrapped: 0 })).toBe(true);
    expect(operationWorked({ hours: 0, completed: 0, scrapped: 1 })).toBe(true);
    expect(operationWorked({ hours: 0, completed: 0, scrapped: 0, received: true })).toBe(true);

    expect(oneOffCounts({ preliminary: true, received: 0 }, false)).toBe(false);
    expect(oneOffCounts({ preliminary: true, received: 0 }, true)).toBe(true);
    expect(oneOffCounts({ preliminary: false, received: 4 }, false)).toBe(true);
    expect(oneOffCounts({ preliminary: false, received: 0 }, false)).toBe(false);
    expect(oneOffCounts({ preliminary: false, received: 0 }, true)).toBe(true);
  });

  it("takes the planned share of a quantity, and 0 on an order quantity of 0", () => {
    expect(plannedShare(20, 10, 8)).toBe(16);
    expect(plannedShare(1, 3, 3)).toBe(1);
    expect(plannedShare(20, 0, 8)).toBe(0);
  });

  it("counts the scrap of the row's own operation, and of later operations only on a final order", () => {
    const ops = [
      { sequenceNo: 5, scrapped: 4 },
      { sequenceNo: 10, scrapped: 1 },
      { sequenceNo: 20, scrapped: 2 },
    ];
    const linked = ops[1]!;
    expect(materialScrap({ preliminary: false, received: 7 }, linked, ops)).toBe(3);
    expect(materialScrap({ preliminary: true, received: 0 }, linked, ops)).toBe(1);
    // Unlinked material is drawn at the receipt: never scrap.
    expect(materialScrap({ preliminary: false, received: 7 }, null, ops)).toBe(0);
  });
});

describe("cost-variance — material rows", () => {
  it("splits into price on the actual quantity and the rest as quantity", () => {
    // SQ 16 × SP 10 = 160; AQ 18 × AP 12 = 216.
    const v = materialVariance(material({ baseQuantity: 16, baseUnitCost: 10, quantity: 18, unitCost: 12, amount: 216, scrapQuantity: 2 }));
    expect(v.base).toBe(16000);
    expect(v.actual).toBe(21600);
    expect(v.parts.price).toBe(3600); // (12 − 10) × 18
    expect(v.parts.quantity).toBe(2000); // (18 − 16) × 10
    expect(v.parts.scrap).toBe(2000); // 10 × 2, varav kassation
    expect(v.parts.price + v.parts.quantity).toBe(v.actual - v.base);
  });

  it("rounds the price part with round2 and puts the rest on quantity, so the row sums exactly", () => {
    // base round2(3 × 3.3333) = 10.00, actual round2(7 × 3.3337) = 23.34,
    // price round2(0.0004 × 7) = 0.00 ⇒ quantity 13.34 (13.3332 unrounded).
    const v = materialVariance(material({ baseQuantity: 3, baseUnitCost: 3.3333, quantity: 7, unitCost: 3.3337, amount: 23.3359 }));
    expect([v.base, v.actual, v.parts.price, v.parts.quantity]).toEqual([1000, 2334, 0, 1334]);
    for (const row of [
      material({ baseQuantity: 1.2345, baseUnitCost: 7.7777, quantity: 1.3, unitCost: 8.1234, amount: 10.56042 }),
      material({ baseQuantity: 0.3333, baseUnitCost: 0.015, quantity: 0.5, unitCost: 0.005, amount: 0.0025 }),
      material({ baseQuantity: 99.9999, baseUnitCost: 1234.5678, quantity: 100.0001, unitCost: 1234.5679, amount: 123456.9135 }),
    ]) {
      const r = materialVariance(row);
      expect(r.parts.price + r.parts.quantity).toBe(r.actual - r.base);
    }
  });

  it("gives material that was planned but never drawn a negative quantity", () => {
    const v = materialVariance(material({ quantity: 0, unitCost: 10, amount: 0 }));
    expect(v.parts.quantity).toBe(-20000);
    expect(v.parts.price).toBe(0);
  });

  it("gives a cheaper price a negative price part, and returned material less quantity", () => {
    // Drew 20, returned 5 through Ångra: AQ is the net 15, at 8.
    const v = materialVariance(material({ quantity: 15, unitCost: 8, amount: 120 }));
    expect(v.parts.price).toBe(-3000); // (8 − 10) × 15
    expect(v.parts.quantity).toBe(-5000); // (15 − 20) × 10
  });

  it("is all zero when nothing was planned and nothing drawn", () => {
    const v = materialVariance(material({ baseQuantity: 0, quantity: 0, amount: 0 }));
    expect([v.base, v.actual, v.parts.price, v.parts.quantity, v.parts.scrap]).toEqual([0, 0, 0, 0, 0]);
  });

  it("counts a row without a base wholly as quantity", () => {
    const v = materialVariance(material({ baseQuantity: null, baseUnitCost: null, basePriceSource: null, scrapQuantity: null }));
    expect([v.base, v.actual, v.parts.price, v.parts.quantity, v.parts.scrap]).toEqual([0, 20000, 0, 20000, 0]);
  });
});

describe("cost-variance — operations with time", () => {
  it("puts the whole time deviation in Tid (ej uppdelad) when the time is not split", () => {
    // Base (0.5 + 2) × 600 = 1500, actual 3 × 600 = 1800.
    const v = timeVariance(timeOp());
    expect(v.split).toBe(false);
    expect(v.unclassifiedHours).toBe(3);
    expect([v.base, v.actual, v.parts.unclassified, v.parts.setup, v.parts.run, v.parts.rate]).toEqual([150000, 180000, 30000, 0, 0, 0]);
  });

  it("splits into ställ and stycke when every hour is registered as one or the other", () => {
    // Hs 1 (planned 0.5), Hr 2 (planned 2).
    const v = timeVariance(timeOp({ setupHours: 1, runHours: 2 }));
    expect(v.split).toBe(true);
    expect([v.parts.setup, v.parts.run, v.parts.unclassified]).toEqual([30000, 0, 0]);
  });

  it("does not split a half classified operation", () => {
    const v = timeVariance(timeOp({ setupHours: 1, runHours: null }));
    expect(v.split).toBe(false);
    expect(v.unclassifiedHours).toBe(2);
    expect([v.parts.setup, v.parts.run, v.parts.unclassified]).toEqual([0, 0, 30000]);
  });

  it("splits an operation without time into missing setup and run time", () => {
    const v = timeVariance(timeOp({ hours: 0, laborAmount: 0 }));
    expect(v.split).toBe(true);
    expect([v.parts.setup, v.parts.run, v.parts.unclassified]).toEqual([-30000, -120000, 0]);
  });

  it("has a timpris of 0 while R₀ = R, and (R − R₀) × H otherwise, with the rest on the time part", () => {
    expect(timeVariance(timeOp()).parts.rate).toBe(0);
    // R 650, R₀ 600, H 3: rate 150; actual 1950 − base 1500 = 450 ⇒ ej uppdelad 300.
    const v = timeVariance(timeOp({ hourlyRate: 650, laborAmount: 1950 }));
    expect([v.parts.rate, v.parts.unclassified]).toEqual([15000, 30000]);
  });

  it("counts an operation without a base wholly as unsplit time", () => {
    const v = timeVariance(timeOp({ baseSetupHours: null, baseRunHours: null, baseHourlyRate: null }));
    expect([v.base, v.parts.rate, v.parts.unclassified]).toEqual([0, 0, 180000]);
  });
});

describe("cost-variance — lego operations", () => {
  it("prices a receipt: à-pris and ställpris in Pris, the quantity in Mängd", () => {
    // Kalkylerat 500 + 100 × 4 = 900; IO 450 + 90 × 4 = 810.
    const v = subcontractVariance(legoOp());
    expect([v.base, v.actual, v.parts.price, v.parts.quantity]).toEqual([90000, 81000, -9000, 0]);
  });

  it("gives the fallback (no IO, OK × snapshot price) no price deviation", () => {
    // Preliminary, 2 OK: A = 500 + 100 × 2, Qa = N = 2.
    const v = subcontractVariance(legoOp({ subcontractAmount: 700, subcontractQuantity: 2, baseQuantity: 2 }));
    expect([v.base, v.actual, v.parts.price, v.parts.quantity]).toEqual([70000, 70000, 0, 0]);
  });

  it("sums two IO rows and prices the extra quantity at P₀", () => {
    // Two IO rows: 450 + 90 × 3 and 0 + 110 × 2 ⇒ A 940, Qa 5; N 4.
    const v = subcontractVariance(legoOp({ subcontractAmount: 940, subcontractQuantity: 5 }));
    expect(v.parts.quantity).toBe(10000); // (5 − 4) × 100
    expect(v.parts.price).toBe(-6000); // 940 − 500 − 100 × 5
    expect(v.parts.price + v.parts.quantity).toBe(v.actual - v.base);
  });

  it("counts the one-off only through the stored F₀ — 0 while it does not count", () => {
    const v = subcontractVariance(legoOp({ baseOneOff: 0, baseQuantity: 0, subcontractQuantity: 0, subcontractAmount: 500 }));
    expect([v.base, v.parts.price, v.parts.quantity]).toEqual([0, 50000, 0]);
  });
});

describe("cost-variance — the whole analysis", () => {
  it("is null without a base (a förkalkyl or an efterkalkyl saved before the analysis)", () => {
    expect(costVarianceAnalysis(header({ outputQuantity: null, preliminary: null, basePricedAt: null, baseMaterialSource: null }), [material()], [])).toBeNull();
    expect(costVarianceAnalysis(header({ baseMaterialSource: "actual" }), [material()], [])).toBeNull();
  });

  it("adds the rows and the markups up exactly: Utfall − Kalkylerat = Σ delar + Påslag", () => {
    const analysis = costVarianceAnalysis(
      header({ moPercent: 12.5, loPercent: 7 }),
      [
        material({ baseQuantity: 16.6667, baseUnitCost: 3.3333, quantity: 18, unitCost: 3.4567, amount: 62.2206, scrapQuantity: 1.6667 }),
        material({ componentArticleId: "s1", kind: "subcontract", baseQuantity: 10, baseUnitCost: 12.345, quantity: 10, unitCost: 13, amount: 130 }),
      ],
      [timeOp({ hours: 2.3333, laborAmount: 1399.98, baseRunHours: 1.6667 }), legoOp({ subcontractAmount: 833.3333, subcontractQuantity: 4.5 })]
    )!;
    const rows = [...analysis.materialRows, ...analysis.operationRows];
    expect(ore(analysis.actual) - ore(analysis.base)).toBe(ore(analysis.deviation));
    expect(partsSum(analysis.parts)).toBe(ore(analysis.deviation));
    for (const row of rows) expect(partsSum(row.parts)).toBe(ore(row.deviation));
    // The order's sides are the rows' sums plus each side's markup.
    const rowBase = rows.reduce((t, r) => t + ore(r.base), 0);
    const rowActual = rows.reduce((t, r) => t + ore(r.actual), 0);
    const materialBase = ore(analysis.materialRows[0]!.base) / 100;
    const legoBase = (ore(analysis.materialRows[1]!.base) + ore(analysis.operationRows[1]!.base)) / 100;
    const baseMarkup = Math.round((materialBase * 0.125 + legoBase * 0.07) * 100);
    expect(ore(analysis.base)).toBe(rowBase + baseMarkup);
    expect(ore(analysis.actual) - rowActual - (ore(analysis.base) - rowBase)).toBe(ore(analysis.parts.markups));
    // Rows carry no markup; scrap is informational, not part of the sum.
    expect(rows.every((r) => r.parts.markups === 0)).toBe(true);
    expect(analysis.parts.scrap).toBe(analysis.materialRows[0]!.parts.scrap);
    expect(analysis.parts.scrap).toBeGreaterThan(0);
  });

  it("puts the markup only on material and lego, and none on the time", () => {
    const analysis = costVarianceAnalysis(header({ moPercent: 10, loPercent: 20 }), [material({ quantity: 22, amount: 220 })], [
      timeOp({ hours: 4, laborAmount: 2400 }),
      legoOp({ subcontractAmount: 950, subcontractQuantity: 4 }),
    ])!;
    // ΔMO = 10 % × 20, ΔLO = 20 % × 50.
    expect(analysis.parts.markups).toBe(12);
    expect(analysis.parts.quantity).toBe(20);
    expect(analysis.parts.price).toBe(50);
    expect(analysis.parts.unclassified).toBe(900);
    expect(analysis.deviation).toBe(982);
  });

  it("is all zero when the outcome is the calculation", () => {
    const analysis = costVarianceAnalysis(header({ moPercent: 10 }), [material()], [
      timeOp({ hours: 2.5, laborAmount: 1500 }),
      legoOp({ subcontractAmount: 900 }),
    ])!;
    expect([analysis.base, analysis.actual, analysis.deviation]).toEqual([2620, 2620, 0]);
    expect(Object.values(analysis.parts).every((p) => p === 0)).toBe(true);
  });

  it("carries the header and the rows' facts", () => {
    const analysis = costVarianceAnalysis(header({ preliminary: true, outputQuantity: 3 }), [material({ scrapQuantity: 2 })], [
      timeOp(),
      legoOp(),
    ])!;
    expect(analysis).toMatchObject({
      outputQuantity: 3,
      preliminary: true,
      basePricedAt: "2026-03-01T09:00:00.000Z",
      baseMaterialSource: "standard",
    });
    expect(analysis.materialRows[0]).toMatchObject({ baseQuantity: 20, baseUnitCost: 10, quantity: 20, unitCost: 10, scrapQuantity: 2 });
    expect(analysis.materialRows[0]!.parts.scrap).toBe(20);
    expect(analysis.operationRows.map((r) => r.kind)).toEqual(["time", "subcontract"]);
    expect(analysis.operationRows[0]).toMatchObject({ baseSetupHours: 0.5, baseRunHours: 2, hours: 3, unclassifiedHours: 3, split: false });
    expect(analysis.operationRows[1]).toMatchObject({ baseQuantity: 4, baseUnitPrice: 100, baseOneOff: 500, subcontractQuantity: 4 });
  });
});

describe("cost-variance — roundAsNumeric", () => {
  it("rounds the decimal text half away from zero, as a numeric column stores String(value)", () => {
    // 12.34565 is 12.3456499… in binary: Math.round gives 12.3456, Postgres
    // (reading the text "12.34565") stores 12.3457.
    expect(Math.round(12.34565 * 10000) / 10000).toBe(12.3456);
    expect(roundAsNumeric(12.34565, 4)).toBe(12.3457);
    expect(roundAsNumeric(-12.34565, 4)).toBe(-12.3457);
    expect(roundAsNumeric(0.00015, 4)).toBe(0.0002);
    expect(roundAsNumeric(12.34496, 4)).toBe(12.345);
    expect(roundAsNumeric(12.344, 4)).toBe(12.344);
    expect(roundAsNumeric(0.125, 2)).toBe(0.13);
    expect(roundAsNumeric(8, 4)).toBe(8);
    expect(roundAsNumeric(0, 4)).toBe(0);
    // String() writes these with an exponent; Postgres reads the same value.
    expect(roundAsNumeric(1e-7, 4)).toBe(0);
    expect(roundAsNumeric(5e-7, 6)).toBe(0.000001);
    expect(roundAsNumeric(1.25e-7, 8)).toBe(0.00000013);
    expect(roundAsNumeric(4 / 60, 8)).toBe(0.06666667);
    expect(roundAsNumeric(1e21, 4)).toBe(1e21);
  });
});
