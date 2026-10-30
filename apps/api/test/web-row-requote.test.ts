import { describe, expect, it } from "vitest";
// The web helper only imports the web's units helpers, so vitest loads it directly.
import { requoteFor } from "../../web/lib/rowRequote.js";

// Ändra on an order row: when the card asks for the price again (sales
// order price chain, purchase order stafflat leverantörspris).

const kg = { value: "kg", factor: 5 }; // 1 st = 5 kg: quantityPerBase

describe("requoteFor", () => {
  it("quotes a changed quantity and comes back to the first tier on 10 → 100 → 10", () => {
    let priced = 10; // the row's own base quantity when Ändra opens
    const ask = (quantity: string) => {
      const r = requoteFor({ quantity, unitId: "", unitOptions: [], pricedBaseQuantity: priced });
      if (r) priced = r.base; // the card remembers what it asked for
      return r;
    };
    expect(ask("10")).toBeNull();
    expect(ask("100")).toEqual({ base: 100, factor: 1 });
    expect(ask("100")).toBeNull();
    // The old rule compared with the row's original 10 and kept the 100-tier.
    expect(ask("10")).toEqual({ base: 10, factor: 1 });
  });

  it("never reprices a pure unit switch, and waits for the units before quoting", () => {
    // 500 kg = 100 st: the same base quantity in another unit.
    expect(requoteFor({ quantity: "500", unitId: "kg", unitOptions: [{ value: "", factor: 1 }, kg], pricedBaseQuantity: 100 })).toBeNull();
    // Units not loaded yet: the factor of "kg" is unknown — no quote (the
    // old fallback to 1 read 500 kg as 500 st and repriced on open).
    expect(requoteFor({ quantity: "500", unitId: "kg", unitOptions: [{ value: "", factor: 1 }], pricedBaseQuantity: 100 })).toBeNull();
    expect(requoteFor({ quantity: "600", unitId: "kg", unitOptions: [{ value: "", factor: 1 }, kg], pricedBaseQuantity: 100 })).toEqual({
      base: 120,
      factor: 5,
    });
  });

  it("ignores a quantity that is not a positive number", () => {
    for (const quantity of ["", "0", "-2", "abc"]) {
      expect(requoteFor({ quantity, unitId: "", unitOptions: [], pricedBaseQuantity: 1 })).toBeNull();
    }
  });
});
