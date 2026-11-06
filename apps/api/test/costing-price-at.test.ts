import { describe, expect, it } from "vitest";
import {
  hourlyRateAt,
  laborAtWorkDays,
  pricedAtWithdrawal,
  primarySupplierAt,
  standardCostAt,
  type SupplierSnapshotRow,
} from "../src/modules/costing/service/price-at.js";

// Pure — prishistorik as of a moment, for the efterkalkyl. The latest row by
// then; before the first row, the first (D1's convention).

const at = (iso: string) => new Date(iso);

describe("standardCostAt", () => {
  const rows = [
    { cost: "10.0000", validFrom: at("2026-03-01T08:00:00Z") },
    { cost: "12.0000", validFrom: at("2026-03-10T08:00:00Z") },
  ];

  it("takes the latest row valid at the moment", () => {
    expect(standardCostAt(rows, at("2026-03-05T00:00:00Z"))).toBe("10.0000");
    expect(standardCostAt(rows, at("2026-03-10T08:00:00Z"))).toBe("12.0000");
    expect(standardCostAt(rows, at("2026-04-01T00:00:00Z"))).toBe("12.0000");
  });

  it("takes the first row before the history starts, and null without history", () => {
    expect(standardCostAt(rows, at("2026-01-01T00:00:00Z"))).toBe("10.0000");
    expect(standardCostAt([], at("2026-03-05T00:00:00Z"))).toBeNull();
  });
});

function snapshot(supplierId: string, validFrom: string, patch: Partial<SupplierSnapshotRow> = {}): SupplierSnapshotRow {
  return { supplierId, price: "10.0000", currency: "SEK", priceBreaks: [], isPrimary: true, removed: false, validFrom: at(validFrom), ...patch };
}

describe("primarySupplierAt", () => {
  it("follows the price of the primary supplier over time", () => {
    const rows = [snapshot("a", "2026-03-01T08:00:00Z"), snapshot("a", "2026-03-10T08:00:00Z", { price: "11.0000", currency: "EUR" })];
    expect(primarySupplierAt(rows, at("2026-03-05T00:00:00Z"))?.price).toBe("10.0000");
    expect(primarySupplierAt(rows, at("2026-03-11T00:00:00Z"))).toMatchObject({ price: "11.0000", currency: "EUR" });
  });

  it("follows a switch of primary supplier", () => {
    const rows = [
      snapshot("a", "2026-03-01T08:00:00Z"),
      // The switch: a demoted and b added, in one transaction.
      snapshot("a", "2026-03-10T08:00:00Z", { isPrimary: false }),
      snapshot("b", "2026-03-10T08:00:00Z", { price: "8.0000" }),
    ];
    expect(primarySupplierAt(rows, at("2026-03-05T00:00:00Z"))?.supplierId).toBe("a");
    expect(primarySupplierAt(rows, at("2026-03-12T00:00:00Z"))?.supplierId).toBe("b");
  });

  it("has no primary supplier after the row was removed, or before a supplier was added", () => {
    const removed = [snapshot("a", "2026-03-01T08:00:00Z"), snapshot("a", "2026-03-10T08:00:00Z", { removed: true, isPrimary: false })];
    expect(primarySupplierAt(removed, at("2026-03-12T00:00:00Z"))).toBeNull();

    const later = [snapshot("x", "2026-03-01T08:00:00Z", { isPrimary: false }), snapshot("a", "2026-03-10T08:00:00Z")];
    expect(primarySupplierAt(later, at("2026-03-05T00:00:00Z"))).toBeNull();
  });

  it("takes each supplier's first snapshot before the history starts", () => {
    const rows = [snapshot("a", "2026-03-01T08:00:00Z", { price: "9.0000" }), snapshot("a", "2026-03-10T08:00:00Z", { price: "11.0000" })];
    expect(primarySupplierAt(rows, at("2025-12-01T00:00:00Z"))?.price).toBe("9.0000");
    expect(primarySupplierAt([], at("2026-03-05T00:00:00Z"))).toBeNull();
  });
});

// The rule the efterkalkyl and Produkter i arbete share.
describe("pricedAtWithdrawal", () => {
  const histories = {
    standard: new Map([["c", [{ cost: "10.0000", validFrom: at("2026-03-01T08:00:00Z") }, { cost: "12.0000", validFrom: at("2026-03-10T08:00:00Z") }]]]),
    supplier: new Map([["c", [snapshot("a", "2026-03-01T08:00:00Z", { price: "2.0000", currency: "EUR" })]]]),
  };
  const basis = { componentArticleId: "c", standardCost: "99.0000", supplierPrice: "3.0000", supplierCurrency: "SEK", supplierPriceBreaks: [] };

  it("prices at the withdrawal and dates the row on its Stockholm day", () => {
    const [row] = pricedAtWithdrawal([basis], new Map([["c", at("2026-03-05T23:30:00Z")]]), histories, at("2026-04-01T00:00:00Z"));
    expect(row).toMatchObject({ standardCost: "10.0000", supplierPrice: "2.0000", supplierCurrency: "EUR", priceDate: "2026-03-06" });
  });

  it("prices a component without a withdrawal as of the fallback, and keeps the current cost without history", () => {
    const [row] = pricedAtWithdrawal([basis], new Map(), histories, at("2026-04-01T00:00:00Z"));
    expect(row).toMatchObject({ standardCost: "12.0000", priceDate: "2026-04-01" });
    const [bare] = pricedAtWithdrawal([basis], new Map(), { standard: new Map(), supplier: new Map() }, at("2026-04-01T00:00:00Z"));
    expect(bare).toMatchObject({ standardCost: "99.0000", supplierPrice: null, supplierCurrency: null, supplierPriceBreaks: [] });
  });
});

// Timkostnad per datum (#14 etapp 4): the same convention for the resource's
// hourly rate — at an instant (the base's T₀) or on a Stockholm work day.
describe("hourlyRateAt", () => {
  // 600 from 1 March; 720 from 10 May 14:00 Stockholm (12:00 UTC).
  const rows = [
    { hourlyRate: "600.00", validFrom: at("2026-03-01T08:00:00Z") },
    { hourlyRate: "720.00", validFrom: at("2026-05-10T12:00:00Z") },
  ];

  it("takes the latest row at an instant (T₀)", () => {
    expect(hourlyRateAt(rows, at("2026-05-10T11:59:59Z"))).toBe("600.00");
    expect(hourlyRateAt(rows, at("2026-05-10T12:00:00Z"))).toBe("720.00");
  });

  it("applies a change to the whole Stockholm day it was made on", () => {
    expect(hourlyRateAt(rows, "2026-05-09")).toBe("600.00");
    expect(hourlyRateAt(rows, "2026-05-10")).toBe("720.00");
    expect(hourlyRateAt(rows, "2026-06-01")).toBe("720.00");
    // 23:30 UTC on 9 May is already 10 May in Stockholm.
    expect(hourlyRateAt([rows[0]!, { hourlyRate: "650.00", validFrom: at("2026-05-09T23:30:00Z") }], "2026-05-10")).toBe("650.00");
  });

  it("takes the first row before the history starts, and null without history", () => {
    expect(hourlyRateAt(rows, "2026-01-15")).toBe("600.00");
    expect(hourlyRateAt(rows, at("2026-01-15T00:00:00Z"))).toBe("600.00");
    expect(hourlyRateAt([], "2026-05-10")).toBeNull();
  });
});

describe("laborAtWorkDays", () => {
  const rows = [
    { hourlyRate: "600.00", validFrom: at("2026-03-01T08:00:00Z") },
    { hourlyRate: "720.00", validFrom: at("2026-05-10T12:00:00Z") },
  ];

  it("prices each work day at that day's rate; the row's rate is the average", () => {
    const labor = laborAtWorkDays(
      [
        { date: "2026-05-09", hours: 1 },
        { date: "2026-05-10", hours: 0.5 },
      ],
      rows,
      720
    );
    // 1 × 600 + 0.5 × 720.
    expect(labor).toEqual({ hours: 1.5, laborAmount: 960, hourlyRate: 640 });
  });

  it("keeps the one rate when every day had it, and rounds an uneven average to öre", () => {
    expect(laborAtWorkDays([{ date: "2026-06-01", hours: 2 }, { date: "2026-06-02", hours: 1.25 }], rows, 999)).toEqual({
      hours: 3.25,
      laborAmount: 2340,
      hourlyRate: 720,
    });
    // 2 h at 600, 1.01 h at 720: 1927.20 over 3.01 h.
    const uneven = laborAtWorkDays([{ date: "2026-05-01", hours: 2 }, { date: "2026-05-11", hours: 1 }, { date: "2026-05-12", hours: 0.01 }], rows, 0);
    expect(uneven.laborAmount).toBeCloseTo(1200 + 720 + 7.2, 10);
    expect(uneven.hourlyRate).toBe(640.27); // 1927.2 / 3.01 = 640.2658…
  });

  it("uses the current rate without history and for an operation without hours", () => {
    expect(laborAtWorkDays([{ date: "2026-05-10", hours: 2 }], [], 500)).toEqual({ hours: 2, laborAmount: 1000, hourlyRate: 500 });
    expect(laborAtWorkDays([], rows, 720)).toEqual({ hours: 0, laborAmount: 0, hourlyRate: 720 });
  });
});
