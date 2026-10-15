import { describe, expect, it } from "vitest";
import {
  addMonths,
  disposalAmounts,
  disposalPostingRows,
  lastDepreciationMonth,
  missingMonths,
  monthEnd,
  monthKey,
  monthsBetween,
  monthStart,
} from "../src/modules/economy/service/depreciation-schedule.js";

describe("månadsaritmetik", () => {
  it("round-trips month keys and gives the real last day of a month", () => {
    expect(monthKey("2026-02-14")).toBe("2026-02");
    expect(monthStart("2026-02")).toBe("2026-02-01");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2028-02")).toBe("2028-02-29"); // skottår
    expect(monthEnd("2026-12")).toBe("2026-12-31");
    expect(monthEnd("2026-04")).toBe("2026-04-30");
  });

  it("adds months across year boundaries and counts the distance", () => {
    expect(addMonths("2026-11", 3)).toBe("2027-02");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthsBetween("2026-02", "2026-06")).toBe(4);
    expect(monthsBetween("2026-06", "2026-02")).toBe(-4);
    expect(lastDepreciationMonth("2026-02", 60)).toBe("2031-01");
  });

  // Review Focus 3: an acquisition on the 31st starts in its own month even
  // though later months lack a 31st — the plan only ever sees whole months.
  it("starts in the acquisition month regardless of the day", () => {
    expect(monthKey("2026-01-31")).toBe("2026-01");
    expect(monthEnd(addMonths(monthKey("2026-01-31"), 1))).toBe("2026-02-28");
  });
});

const PLAN = {
  acquisitionCost: 100_000,
  residualValue: 0,
  usefulLifeMonths: 36,
  depreciationStartMonth: "2026-02",
  bookedMonths: [] as { month: string; amount: number }[],
};

describe("missingMonths", () => {
  it("spreads 100 000 over 36 months with the remainder in the last month", () => {
    const rows = missingMonths(PLAN, "2029-01");
    expect(rows).toHaveLength(36);
    expect(rows[0]).toEqual({ month: "2026-02", amount: 2777.78 });
    // Recomputed per month: (100 000 − 21 × 2 777,78) / 15 = 2 777,7753 → 2 777,78
    // still, but from month 22 on the rounded remainder drifts by a öre now and
    // then (e.g. 2027-11 = 2 777,77); the last month takes whatever is left.
    expect(rows[21]).toEqual({ month: "2027-11", amount: 2777.77 });
    expect(rows[34]).toEqual({ month: "2028-12", amount: 2777.78 });
    expect(rows[35]).toEqual({ month: "2029-01", amount: 2777.77 });
    const sum = rows.reduce((total, row) => total + row.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(100_000);
  });

  it("stops at throughMonth and continues from the last booked month", () => {
    const first = missingMonths(PLAN, "2026-06");
    expect(first.map((row) => row.month)).toEqual(["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
    const second = missingMonths({ ...PLAN, bookedMonths: first }, "2026-09");
    expect(second.map((row) => row.month)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(second[0]!.amount).toBe(2777.78);
  });

  it("returns nothing before the start month, after the useful life, or when fully depreciated", () => {
    expect(missingMonths(PLAN, "2026-01")).toEqual([]);
    const all = missingMonths(PLAN, "2040-01");
    expect(all).toHaveLength(36);
    expect(missingMonths({ ...PLAN, bookedMonths: all }, "2040-01")).toEqual([]);
  });

  it("depreciates down to the residual value only", () => {
    const rows = missingMonths({ ...PLAN, residualValue: 10_000, usefulLifeMonths: 10 }, "2040-01");
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.amount === 9000)).toBe(true);
  });

  it("writes no rows when residual equals cost (mark)", () => {
    expect(missingMonths({ ...PLAN, residualValue: 100_000 }, "2040-01")).toEqual([]);
  });

  it("skips months whose amount rounds to zero, never writes a zero row, and still sums exactly", () => {
    // 0.1 / 60 rounds to 0.00, so early months are skipped; as the remaining
    // months shrink the per-month share reaches 0.005 and rounds up to 0.01.
    const rows = missingMonths({ ...PLAN, acquisitionCost: 0.1, usefulLifeMonths: 60 }, "2040-01");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.amount > 0)).toBe(true);
    expect(rows[0]!.month > "2026-02").toBe(true);
    expect(Math.round(rows.reduce((total, row) => total + row.amount, 0) * 100) / 100).toBe(0.1);
  });

  // Spec 2.2/6: framåtverkande ändring — 5 månader à 2 000 bokförda på
  // 120 000/60, sedan nyttjandetid 48 och restvärde 6 000.
  it("spreads the remaining base evenly over the remaining months after a prospective change", () => {
    const booked = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map((month) => ({ month, amount: 2000 }));
    const rows = missingMonths(
      { acquisitionCost: 120_000, residualValue: 6000, usefulLifeMonths: 48, depreciationStartMonth: "2026-02", bookedMonths: booked },
      "2040-01"
    );
    expect(rows).toHaveLength(43);
    expect(rows[0]).toEqual({ month: "2026-07", amount: 2418.6 });
    // 104 000 / 43 = 2 418,6046 → 2 418,60 per month, recomputed monthly so the
    // rounding drift is spread (2029-12 = 2 418,61) instead of piling up at the end.
    expect(rows[41]).toEqual({ month: "2029-12", amount: 2418.61 });
    expect(rows[42]).toEqual({ month: "2030-01", amount: 2418.6 });
    const sum = rows.reduce((total, row) => total + row.amount, 0);
    expect(Math.round(sum * 100) / 100).toBe(104_000);
  });
});

describe("missingMonths cadence independence", () => {
  const cases = [
    { name: "100 000 / 36", input: PLAN, through: "2029-01" },
    {
      name: "104 000 / 43 after a prospective change",
      input: {
        acquisitionCost: 120_000,
        residualValue: 6000,
        usefulLifeMonths: 48,
        depreciationStartMonth: "2026-02",
        bookedMonths: ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map((month) => ({ month, amount: 2000 })),
      },
      through: "2030-01",
    },
    { name: "100 / 7", input: { ...PLAN, acquisitionCost: 100, usefulLifeMonths: 7 }, through: "2026-08" },
    { name: "residual value", input: { ...PLAN, residualValue: 12_345.67 }, through: "2029-01" },
  ];

  it.each(cases)("$name: one call equals the concatenation of single-month calls", ({ input, through }) => {
    const oneCall = missingMonths(input, through);
    const stepped: { month: string; amount: number }[] = [];
    for (let month = input.depreciationStartMonth; month <= through; month = addMonths(month, 1)) {
      stepped.push(...missingMonths({ ...input, bookedMonths: [...input.bookedMonths, ...stepped] }, month));
    }
    expect(stepped).toEqual(oneCall);
    expect(oneCall.length).toBeGreaterThan(0);
  });
});

describe("disposalAmounts / disposalPostingRows", () => {
  it("computes book value, gain and loss", () => {
    expect(disposalAmounts({ acquisitionCost: 120_000, accumulatedDepreciation: 16_000, disposalPrice: 95_000 })).toEqual({
      bookValue: 104_000,
      gain: 0,
      loss: 9000,
    });
    expect(disposalAmounts({ acquisitionCost: 120_000, accumulatedDepreciation: 16_000, disposalPrice: 110_000 })).toEqual({
      bookValue: 104_000,
      gain: 6000,
      loss: 0,
    });
    expect(disposalAmounts({ acquisitionCost: 120_000, accumulatedDepreciation: 120_000, disposalPrice: 0 })).toEqual({
      bookValue: 0,
      gain: 0,
      loss: 0,
    });
  });

  it("lists the signed posting rows of spec section 6 (sale at a loss)", () => {
    expect(disposalPostingRows({ acquisitionCost: 120_000, accumulatedDepreciation: 16_000, disposalPrice: 95_000 })).toEqual([
      { role: "asset", amount: -120_000 },
      { role: "accumulated", amount: 16_000 },
      { role: "intermediate", amount: 95_000 },
      { role: "loss", amount: 9000 },
    ]);
  });

  it("omits zero rows: a scrap of a fully depreciated asset is just cost against accumulated", () => {
    expect(disposalPostingRows({ acquisitionCost: 120_000, accumulatedDepreciation: 120_000, disposalPrice: 0 })).toEqual([
      { role: "asset", amount: -120_000 },
      { role: "accumulated", amount: 120_000 },
    ]);
  });
});
