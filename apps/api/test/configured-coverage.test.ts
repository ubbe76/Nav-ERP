import { describe, expect, it } from "vitest";
import { uncoveredConfiguredQuantity } from "../src/modules/planning/service/configured-coverage.js";

// `received` = manufacturing_orders.quantity_received (delinleverans).
const mo = (status: string, quantity: number, received = 0) => ({ status, quantity, received });

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

  // Delinleverans (review 2026-11-10): what an open TO has already received
  // counts as finished, only the rest as open — before, the full quantity
  // was open AND the delivered units were subtracted again.
  it("a partly received open TO whose units are delivered is counted once", () => {
    // Row 10, TO 6 with 3 received and delivered: 3 still open, 3 gone ⇒ 4 (was 1).
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 10, quantityDelivered: 3, linkedOrders: [mo("in_progress", 6, 3)] })).toBe(4);
  });
  it("a partly received open TO whose units are still in stock covers the same", () => {
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 10, quantityDelivered: 0, linkedOrders: [mo("in_progress", 6, 3)] })).toBe(4);
  });
  it("an over-received open TO has no open part — never a negative one", () => {
    // TO 6 with 8 received: open 0, finished 8 ⇒ 10 − 0 − 8 = 2.
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 10, quantityDelivered: 0, linkedOrders: [mo("in_progress", 6, 8)] })).toBe(2);
    // …and delivered beyond what was received wins the max.
    expect(uncoveredConfiguredQuantity({ quantityOrdered: 10, quantityDelivered: 9, linkedOrders: [mo("in_progress", 6, 8)] })).toBe(1);
  });
});
