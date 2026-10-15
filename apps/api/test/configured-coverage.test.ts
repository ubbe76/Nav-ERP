import { describe, expect, it } from "vitest";
import { uncoveredConfiguredQuantity } from "../src/modules/planning/service/configured-coverage.js";

const mo = (status: string, quantity: number) => ({ status, quantity });

describe("uncoveredConfiguredQuantity", () => {
  it("no TO, nothing delivered ⇒ the whole row", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 2, quantityDelivered: 0, linkedOrders: [] })).toBe(2);
  });
  it("an open TO covers its quantity", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 2, quantityDelivered: 0, linkedOrders: [mo("planned", 1)] })).toBe(1);
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 2, quantityDelivered: 0, linkedOrders: [mo("released", 2)] })).toBe(0);
  });
  it("a finished TO not yet delivered still covers", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 2, quantityDelivered: 0, linkedOrders: [mo("done", 1)] })).toBe(1);
  });
  it("a finished and delivered TO covers once, not twice", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 2, quantityDelivered: 1, linkedOrders: [mo("closed", 1)] })).toBe(1);
  });
  it("a delivery from a freely built unit needs no TO", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 1, quantityDelivered: 1, linkedOrders: [] })).toBe(0);
  });
  it("an open TO plus a delivery from a free unit", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 2, quantityDelivered: 1, linkedOrders: [mo("in_progress", 1)] })).toBe(0);
  });
  it("a finished TO plus an open TO", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 3, quantityDelivered: 0, linkedOrders: [mo("done", 1), mo("planned", 1)] })).toBe(1);
  });
  it("cancelled TOs do not count; never negative; float noise rounded", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 1, quantityDelivered: 0, linkedOrders: [mo("cancelled", 1)] })).toBe(1);
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 1, quantityDelivered: 0, linkedOrders: [mo("planned", 5)] })).toBe(0);
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 0.3, quantityDelivered: 0, linkedOrders: [mo("planned", 0.1), mo("planned", 0.2)] })).toBe(0);
  });
});
