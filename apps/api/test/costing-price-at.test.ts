import { describe, expect, it } from "vitest";
import {
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
