import { describe, expect, it } from "vitest";
// The web helper has no imports, so vitest loads it directly.
import { purchaseOrderFallbackRate } from "../../web/lib/purchaseOrderFallbackRate.js";

// The Kurs a supplier invoice form shows when the invoice date has no rate:
// the linked purchase order's — the same rule as resolveRate on the server.
describe("purchaseOrderFallbackRate", () => {
  it("takes the order's rate in the invoice's currency", () => {
    expect(purchaseOrderFallbackRate({ currency: "EUR", exchangeRate: "11.131000" }, "EUR")).toBe(11.131);
    expect(purchaseOrderFallbackRate({ currency: "eur ", exchangeRate: 11.2 }, "EUR")).toBe(11.2);
  });

  it("has none without an order, in another currency, or with the SEK placeholder 1 or no rate", () => {
    expect(purchaseOrderFallbackRate(null, "EUR")).toBeNull();
    expect(purchaseOrderFallbackRate({ currency: "USD", exchangeRate: "10.5" }, "EUR")).toBeNull();
    expect(purchaseOrderFallbackRate({ currency: "EUR", exchangeRate: "1" }, "EUR")).toBeNull();
    expect(purchaseOrderFallbackRate({ currency: "EUR", exchangeRate: "0" }, "EUR")).toBeNull();
    expect(purchaseOrderFallbackRate({ currency: null, exchangeRate: null }, "EUR")).toBeNull();
    expect(purchaseOrderFallbackRate({ currency: "EUR", exchangeRate: "11" }, null)).toBeNull();
  });
});
