import { describe, expect, it } from "vitest";
import { groupOrderMargin, type MarginRowInput } from "../src/modules/reports/service/order-margin-calc.js";

const row = (o: Partial<MarginRowInput>): MarginRowInput => ({
  month: "2026-08",
  customerId: "c1",
  customerName: "Kund AB",
  articleId: "a1",
  articleNumber: "ART-1",
  articleName: "Artikel",
  quantity: 10,
  netAmount: 1000,
  ...o,
});

const costs = new Map([["a1", 60]]);

describe("groupOrderMargin", () => {
  it("measures contribution against the invoiced net amount", () => {
    // 10 units at a self cost of 60 = 600 against 1000 net.
    const result = groupOrderMargin([row({})], costs, "month");
    expect(result.groups[0]!.netRevenue).toBe(1000);
    expect(result.groups[0]!.cost).toBe(600);
    expect(result.groups[0]!.contribution).toBe(400);
    expect(result.groups[0]!.marginPercent).toBeCloseTo(40, 10);
  });

  it("counts rows without a calculation separately instead of costing them at zero", () => {
    const result = groupOrderMargin([row({}), row({ articleId: "a2", netAmount: 5000 })], costs, "month");
    const g = result.groups[0]!;

    expect(g.netRevenue).toBe(6000); // all revenue is real
    expect(g.costedNetRevenue).toBe(1000); // only what we can measure
    // Subtracting 600 from 6000 would claim a 5400 kr contribution on a month
    // where most of the revenue was never calculated.
    expect(g.contribution).toBe(400);
    expect(g.rowsWithoutCost).toBe(1);
  });

  it("groups by customer and by article", () => {
    const rows = [row({}), row({ customerId: "c2", customerName: "Annan AB", articleId: "a2" })];

    const byCustomer = groupOrderMargin(rows, costs, "customer");
    expect(byCustomer.groups.map((g) => g.label).sort()).toEqual(["Annan AB", "Kund AB"]);

    const byArticle = groupOrderMargin(rows, costs, "article");
    expect(byArticle.groups.some((g) => g.label === "ART-1 — Artikel")).toBe(true);
  });

  it("keeps a free-text invoice line in the revenue, under its own label", () => {
    // articleId is nullable on invoice_rows; dropping such a line would make
    // the report's revenue disagree with the sales statistics beside it.
    const result = groupOrderMargin([row({ articleId: null, netAmount: 250 })], costs, "article");
    expect(result.total.netRevenue).toBe(250);
    expect(result.total.rowsWithoutCost).toBe(1);
    expect(result.groups[0]!.label).toBe("Utan artikel");
  });

  it("flips nothing itself — a credit row arrives already negative", () => {
    const result = groupOrderMargin([row({}), row({ quantity: -10, netAmount: -1000 })], costs, "month");
    // The credit cancels the invoice exactly, cost included.
    expect(result.total.netRevenue).toBe(0);
    expect(result.total.cost).toBe(0);
    expect(result.total.contribution).toBe(0);
  });

  it("sorts months chronologically and other groupings by size", () => {
    const rows = [
      row({ month: "2026-09", netAmount: 100 }),
      row({ month: "2026-07", netAmount: 900 }),
    ];
    expect(groupOrderMargin(rows, costs, "month").groups.map((g) => g.key)).toEqual(["2026-07", "2026-09"]);

    const byCustomer = groupOrderMargin(
      [row({ customerId: "small", customerName: "Liten", netAmount: 10 }), row({ customerId: "big", customerName: "Stor", netAmount: 900 })],
      costs,
      "customer"
    );
    expect(byCustomer.groups.map((g) => g.label)).toEqual(["Stor", "Liten"]);
  });

  it("reports no contribution at all when nothing in the period was calculated", () => {
    const result = groupOrderMargin([row({ articleId: "unknown" })], costs, "month");
    expect(result.total.cost).toBeNull();
    expect(result.total.contribution).toBeNull();
    expect(result.total.marginPercent).toBeNull();
  });

  it("a configured row's own self cost wins over the article's; null stays unknown", () => {
    const rows = [
      { ...row({ articleId: "T", quantity: 1, netAmount: 1000 }), rowSelfCostPerUnit: 400 },
      { ...row({ articleId: "T", quantity: 1, netAmount: 1000 }), rowSelfCostPerUnit: null },
      row({ articleId: "T", quantity: 1, netAmount: 1000 }),
    ];
    const r = groupOrderMargin(rows, new Map([["T", 900]]), "article");
    expect(r.total).toMatchObject({ cost: 1300, rowsWithoutCost: 1 });
  });

  it("is empty-safe", () => {
    const result = groupOrderMargin([], costs, "month");
    expect(result.groups).toEqual([]);
    expect(result.total.netRevenue).toBe(0);
  });
});
