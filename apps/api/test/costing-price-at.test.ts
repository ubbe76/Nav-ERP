import { describe, expect, it } from "vitest";
import { primarySupplierAt, standardCostAt, type SupplierSnapshotRow } from "../src/modules/costing/service/price-at.js";

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
