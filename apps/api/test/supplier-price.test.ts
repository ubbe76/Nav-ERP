import { describe, expect, it } from "vitest";
import { resolveSupplierPrice } from "../src/modules/purchase/service/supplier-price.js";

// Pure — no database. The spec for stafflade leverantörspriser: grundpris
// for quantity 1, absolute break prices from their from_quantity, highest
// break <= quantity wins.

const breaks = [
  { fromQuantity: 100, price: 8 },
  { fromQuantity: 10, price: 9 },
];

describe("resolveSupplierPrice", () => {
  it("returns the grundpris when the row has no breaks", () => {
    expect(resolveSupplierPrice({ price: 10, priceBreaks: [] }, 500)).toEqual({
      price: 10,
      fromQuantity: 1,
      source: "base",
    });
  });

  it("returns the grundpris below the lowest break", () => {
    expect(resolveSupplierPrice({ price: 10, priceBreaks: breaks }, 9)).toEqual({
      price: 10,
      fromQuantity: 1,
      source: "base",
    });
  });

  it("switches exactly at the break quantity", () => {
    expect(resolveSupplierPrice({ price: 10, priceBreaks: breaks }, 10)).toEqual({
      price: 9,
      fromQuantity: 10,
      source: "break",
    });
  });

  it("keeps the lower break between two breaks and takes the higher from its quantity", () => {
    expect(resolveSupplierPrice({ price: 10, priceBreaks: breaks }, 99).price).toBe(9);
    expect(resolveSupplierPrice({ price: 10, priceBreaks: breaks }, 100).price).toBe(8);
    expect(resolveSupplierPrice({ price: 10, priceBreaks: breaks }, 1000).price).toBe(8);
  });

  it("does not depend on the breaks being sorted", () => {
    const unsorted = [
      { fromQuantity: 50, price: 7 },
      { fromQuantity: 10, price: 9 },
      { fromQuantity: 100, price: 8 },
    ];
    expect(resolveSupplierPrice({ price: 10, priceBreaks: unsorted }, 60)).toEqual({
      price: 7,
      fromQuantity: 50,
      source: "break",
    });
  });

  it("a matching break wins even when the grundpris is missing", () => {
    expect(resolveSupplierPrice({ price: null, priceBreaks: breaks }, 10).price).toBe(9);
  });

  it("yields null when nothing applies", () => {
    expect(resolveSupplierPrice({ price: null, priceBreaks: breaks }, 5)).toEqual({
      price: null,
      fromQuantity: null,
      source: null,
    });
    expect(resolveSupplierPrice({ price: null, priceBreaks: [] }, 5).price).toBeNull();
  });

  it("falls back to the grundpris for a non-positive or non-finite quantity", () => {
    expect(resolveSupplierPrice({ price: 10, priceBreaks: breaks }, 0).source).toBe("base");
    expect(resolveSupplierPrice({ price: 10, priceBreaks: breaks }, Number.NaN).source).toBe("base");
  });
});
