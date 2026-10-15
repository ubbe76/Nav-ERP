import { describe, expect, it } from "vitest";
import { computeLineMargin, sumMargins } from "../src/modules/costing/service/margin.js";

describe("computeLineMargin", () => {
  it("computes TB and TG from the net revenue after discount", () => {
    // 10 x 100 with 10 % off = 900 net, against 10 x 60 = 600.
    const m = computeLineMargin({ quantity: 10, unitPrice: 100, discountPercent: 10, selfCostPerUnit: 60 });
    expect(m.netRevenue).toBe(900);
    expect(m.cost).toBe(600);
    expect(m.contribution).toBe(300);
    expect(m.marginPercent).toBeCloseTo(33.3333, 4);
  });

  it("answers null, never 0, when the article has no calculation", () => {
    // Unknown and free are different claims; treating unknown as free would
    // overstate every margin it touched.
    const m = computeLineMargin({ quantity: 5, unitPrice: 100, discountPercent: 0, selfCostPerUnit: null });
    expect(m.netRevenue).toBe(500);
    expect(m.cost).toBeNull();
    expect(m.contribution).toBeNull();
    expect(m.marginPercent).toBeNull();
  });

  it("returns a negative contribution as-is", () => {
    const m = computeLineMargin({ quantity: 1, unitPrice: 50, discountPercent: 0, selfCostPerUnit: 80 });
    expect(m.contribution).toBe(-30);
    expect(m.marginPercent).toBeCloseTo(-60, 10);
  });

  it("has no margin percent to report when the line is free", () => {
    const m = computeLineMargin({ quantity: 2, unitPrice: 0, discountPercent: 0, selfCostPerUnit: 10 });
    expect(m.netRevenue).toBe(0);
    expect(m.contribution).toBe(-20);
    expect(m.marginPercent).toBeNull();
  });

  it("treats a 100 % discount as zero revenue", () => {
    const m = computeLineMargin({ quantity: 4, unitPrice: 25, discountPercent: 100, selfCostPerUnit: 5 });
    expect(m.netRevenue).toBe(0);
    expect(m.contribution).toBe(-20);
  });
});

describe("sumMargins", () => {
  const costed = computeLineMargin({ quantity: 10, unitPrice: 100, discountPercent: 0, selfCostPerUnit: 60 });
  const uncosted = computeLineMargin({ quantity: 10, unitPrice: 200, discountPercent: 0, selfCostPerUnit: null });

  it("adds up the costed lines and counts the rest separately", () => {
    const total = sumMargins([costed, uncosted]);

    // Revenue covers everything — that is the order's value.
    expect(total.netRevenue).toBe(3000);
    // Contribution is measured only against the revenue it has a cost for.
    // Subtracting 600 from 3000 would claim a 2400 kr contribution on an
    // order where half the lines were never calculated.
    expect(total.costedNetRevenue).toBe(1000);
    expect(total.cost).toBe(600);
    expect(total.contribution).toBe(400);
    expect(total.marginPercent).toBeCloseTo(40, 10);
    expect(total.linesWithoutCost).toBe(1);
  });

  it("reports no contribution at all when nothing was calculated", () => {
    const total = sumMargins([uncosted, uncosted]);
    expect(total.netRevenue).toBe(4000);
    expect(total.cost).toBeNull();
    expect(total.contribution).toBeNull();
    expect(total.marginPercent).toBeNull();
    expect(total.linesWithoutCost).toBe(2);
  });

  it("is empty-safe", () => {
    const total = sumMargins([]);
    expect(total.netRevenue).toBe(0);
    expect(total.contribution).toBeNull();
    expect(total.linesWithoutCost).toBe(0);
  });
});
