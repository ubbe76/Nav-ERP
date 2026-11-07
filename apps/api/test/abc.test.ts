import { describe, expect, it } from "vitest";
import { updateSystemSettingsSchema } from "@navet/shared";
import { abcValue, classifyAbc } from "../src/modules/planning/service/abc.js";
import {
  decodeAbcSettings,
  validAbcLimits,
  PLANNING_ABC_CLASS_A_PERCENT_KEY,
  PLANNING_ABC_CLASS_B_PERCENT_KEY,
  PLANNING_ABC_PERIOD_MONTHS_KEY,
} from "../src/modules/system/service/plan-settings.js";

// ABC-klassning (#10, etapp 2) — the pure rules (abc.ts) and the settings
// leaf's decode. The database side lives in abc.integration.test.ts.

const LIMITS = { aPercent: 80, bPercent: 95 };
const row = (articleNumber: string, consumed: number, standardCost: number | null = 1) => ({
  articleId: `id-${articleNumber}`,
  articleNumber,
  consumed,
  standardCost,
});

describe("classifyAbc", () => {
  it("sorts by value descending with the article number as the tie-break and classes by the cumulative share BEFORE the article", () => {
    // Values 50, 30, 10, 6, 4 = 100. Before: 0, 50, 80, 90, 96.
    const result = classifyAbc([row("E", 4), row("A", 50), row("C", 10), row("B", 30), row("D", 6)], LIMITS);
    expect(result.total).toBe(100);
    expect(result.rows.map((r) => [r.articleNumber, r.value, r.share, r.cumulativeShare, r.abcClass])).toEqual([
      ["A", 50, 50, 50, "A"],
      ["B", 30, 30, 80, "A"],
      // 80 before B is not below the A limit ⇒ B, even though A ends exactly there.
      ["C", 10, 10, 90, "B"],
      // 90 before D is still below the B limit (95) ⇒ B; E starts at 96 ⇒ C.
      ["D", 6, 6, 96, "B"],
      ["E", 4, 4, 100, "C"],
    ]);
    expect(result.summary).toEqual([
      { abcClass: "A", count: 2, value: 80, share: 80 },
      { abcClass: "B", count: 2, value: 16, share: 16 },
      { abcClass: "C", count: 1, value: 4, share: 4 },
    ]);
  });

  it("breaks ties on the article number and gives equal values the class their position earns", () => {
    const result = classifyAbc([row("X-2", 10), row("X-1", 10), row("X-3", 10), row("X-0", 10)], { aPercent: 50, bPercent: 75 });
    expect(result.rows.map((r) => [r.articleNumber, r.abcClass])).toEqual([
      ["X-0", "A"],
      ["X-1", "A"],
      ["X-2", "B"],
      ["X-3", "C"],
    ]);
  });

  it("multiplies the consumption by the standard cost, flags a missing standard cost with consumption and makes value 0 always C", () => {
    const result = classifyAbc(
      [row("PRICED", 10, 2.5), row("UNPRICED", 100, null), row("UNUSED-UNPRICED", 0, null), row("FREE", 10, 0), row("UNDONE", -3, 5)],
      LIMITS
    );
    const by = Object.fromEntries(result.rows.map((r) => [r.articleNumber, r]));
    expect(by["PRICED"]).toMatchObject({ value: 25, abcClass: "A", missingStandardCost: false, share: 100, cumulativeShare: 100 });
    expect(by["UNPRICED"]).toMatchObject({ value: 0, abcClass: "C", missingStandardCost: true, share: 0 });
    // No consumption ⇒ nothing to price: not flagged.
    expect(by["UNDONE"]).toMatchObject({ value: 0, abcClass: "C", missingStandardCost: false });
    expect(by["UNUSED-UNPRICED"]).toMatchObject({ value: 0, abcClass: "C", missingStandardCost: false });
    // A standard cost of 0 is a price (0), not a missing one.
    expect(by["FREE"]).toMatchObject({ value: 0, abcClass: "C", missingStandardCost: false });
    expect(result.total).toBe(25);
    expect(result.summary).toEqual([
      { abcClass: "A", count: 1, value: 25, share: 100 },
      { abcClass: "B", count: 0, value: 0, share: 0 },
      { abcClass: "C", count: 4, value: 0, share: 0 },
    ]);
    expect(abcValue({ consumed: 3, standardCost: 1.23456 })).toEqual({ value: 3.7037, missingStandardCost: false });
  });

  it("makes every article C when the total is 0, and answers an empty selection with an empty summary", () => {
    const zero = classifyAbc([row("A", 0, 10), row("B", 5, null), row("C", 0, null)], LIMITS);
    expect(zero.total).toBe(0);
    expect(zero.rows.map((r) => [r.articleNumber, r.abcClass, r.share, r.cumulativeShare])).toEqual([
      ["A", "C", 0, 0],
      ["B", "C", 0, 0],
      ["C", "C", 0, 0],
    ]);
    expect(zero.summary.map((s) => [s.abcClass, s.count, s.value, s.share])).toEqual([
      ["A", 0, 0, 0],
      ["B", 0, 0, 0],
      ["C", 3, 0, 0],
    ]);
    const empty = classifyAbc([], LIMITS);
    expect(empty).toEqual({
      rows: [],
      total: 0,
      summary: [
        { abcClass: "A", count: 0, value: 0, share: 0 },
        { abcClass: "B", count: 0, value: 0, share: 0 },
        { abcClass: "C", count: 0, value: 0, share: 0 },
      ],
    });
  });

  it("follows the limits: a single article is A (0 before it) and everything is A with B = 100 only when the limits say so", () => {
    expect(classifyAbc([row("ONLY", 1, 7)], LIMITS).rows[0]!.abcClass).toBe("A");
    // A = 1 %: only the first article is A; B = 100: nothing is C but a value 0.
    const r = classifyAbc([row("A", 60), row("B", 30), row("C", 10), row("D", 0)], { aPercent: 1, bPercent: 100 });
    expect(r.rows.map((x) => x.abcClass)).toEqual(["A", "B", "B", "C"]);
  });
});

describe("the ABC settings", () => {
  const settings = (values: Record<string, string | null>) => decodeAbcSettings((key) => values[key] ?? null);

  it("validAbcLimits is 1 ≤ A < B ≤ 100 in whole percent", () => {
    expect(validAbcLimits(80, 95)).toBe(true);
    expect(validAbcLimits(1, 100)).toBe(true);
    expect(validAbcLimits(0, 95)).toBe(false);
    expect(validAbcLimits(95, 95)).toBe(false);
    expect(validAbcLimits(96, 95)).toBe(false);
    expect(validAbcLimits(80, 101)).toBe(false);
    expect(validAbcLimits(80.5, 95)).toBe(false);
    expect(validAbcLimits(NaN, 95)).toBe(false);
  });

  it("decodes the defaults 12 / 80 / 95, a stored pair that breaks the rule to BOTH defaults, and junk per key", () => {
    expect(settings({})).toEqual({ periodMonths: 12, aPercent: 80, bPercent: 95 });
    expect(
      settings({ [PLANNING_ABC_PERIOD_MONTHS_KEY]: "6", [PLANNING_ABC_CLASS_A_PERCENT_KEY]: "70", [PLANNING_ABC_CLASS_B_PERCENT_KEY]: "90" })
    ).toEqual({ periodMonths: 6, aPercent: 70, bPercent: 90 });
    // A ≥ B: never a half-valid pair.
    expect(settings({ [PLANNING_ABC_CLASS_A_PERCENT_KEY]: "96", [PLANNING_ABC_CLASS_B_PERCENT_KEY]: "95" })).toMatchObject({ aPercent: 80, bPercent: 95 });
    // Only A stored, below the default B: the pair is valid as decoded.
    expect(settings({ [PLANNING_ABC_CLASS_A_PERCENT_KEY]: "50" })).toMatchObject({ aPercent: 50, bPercent: 95 });
    // Only A stored above the default B ⇒ defaults.
    expect(settings({ [PLANNING_ABC_CLASS_A_PERCENT_KEY]: "99" })).toMatchObject({ aPercent: 80, bPercent: 95 });
    expect(settings({ [PLANNING_ABC_CLASS_B_PERCENT_KEY]: "garbage" })).toMatchObject({ aPercent: 80, bPercent: 95 });
    expect(settings({ [PLANNING_ABC_PERIOD_MONTHS_KEY]: "37" })).toMatchObject({ periodMonths: 12 });
    expect(settings({ [PLANNING_ABC_PERIOD_MONTHS_KEY]: "0" })).toMatchObject({ periodMonths: 12 });
  });

  it("the PATCH schema takes the limits as a pair with A < B and refuses a half pair or a broken one (400)", () => {
    const ok = (input: unknown) => updateSystemSettingsSchema.safeParse(input).success;
    expect(ok({ planningAbcClassAPercent: 70, planningAbcClassBPercent: 90 })).toBe(true);
    expect(ok({ planningAbcClassAPercent: 1, planningAbcClassBPercent: 100 })).toBe(true);
    expect(ok({ planningAbcPeriodMonths: 36 })).toBe(true);
    expect(ok({ planningAbcClassAPercent: 90, planningAbcClassBPercent: 90 })).toBe(false);
    expect(ok({ planningAbcClassAPercent: 95, planningAbcClassBPercent: 80 })).toBe(false);
    expect(ok({ planningAbcClassAPercent: 80 })).toBe(false);
    expect(ok({ planningAbcClassBPercent: 95 })).toBe(false);
    expect(ok({ planningAbcClassAPercent: 0, planningAbcClassBPercent: 95 })).toBe(false);
    expect(ok({ planningAbcClassAPercent: 80, planningAbcClassBPercent: 101 })).toBe(false);
    expect(ok({ planningAbcClassAPercent: 80.5, planningAbcClassBPercent: 95 })).toBe(false);
    expect(ok({ planningAbcPeriodMonths: 0 })).toBe(false);
    expect(ok({ planningAbcPeriodMonths: 37 })).toBe(false);
    expect(ok({ planningAbcPeriodMonths: 1.5 })).toBe(false);
  });
});
