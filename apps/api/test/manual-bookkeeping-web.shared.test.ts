import { describe, expect, it } from "vitest";
import { allocationAmounts } from "../src/modules/economy/service/recurring-schedule.js";
// The web helpers have no imports, so vitest can load them directly — the
// allocation preview must show exactly what the server will book.
import * as webAllocation from "../../web/lib/allocation.js";
import { splitVat } from "../../web/lib/splitVat.js";

const MP25 = {
  code: "MP25",
  kind: "domestic",
  rate: 25,
  accounts: [
    { slot: "revenue", accountNumber: "3001" },
    { slot: "outputVat", accountNumber: "2610" },
    { slot: "inputVat", accountNumber: "2640" },
  ],
};
const MP12 = { ...MP25, code: "MP12", rate: 12, accounts: [{ slot: "outputVat", accountNumber: "2620" }, { slot: "inputVat", accountNumber: "2640" }] };
const IEUV25 = {
  code: "IEUV25",
  kind: "reverse_purchase",
  rate: 25,
  accounts: [
    { slot: "outputVat", accountNumber: "2614" },
    { slot: "inputVat", accountNumber: "2645" },
  ],
};

describe("Fördela över perioder: web preview mirrors the server", () => {
  it("allocationAmounts is identical", () => {
    for (const amount of [1000, 999.99, 12000, 0.12, 100000.01, 33.33, 7]) {
      for (const months of [2, 3, 7, 12, 36]) {
        if (Math.floor(Math.round(amount * 100) / months) < 1) continue;
        const server = allocationAmounts(amount, months);
        expect(webAllocation.allocationAmounts(amount, months)).toEqual(server);
        expect(Math.round(server.reduce((s, a) => s + a, 0) * 100)).toBe(Math.round(amount * 100));
        expect(server.every((a) => a > 0)).toBe(true);
      }
    }
  });
});

describe("splitVat (momshjälp)", () => {
  it("splits an amount including VAT on the debit side into net + ingående moms", () => {
    const result = splitVat(125, MP25, "debit");
    expect(result.error).toBeNull();
    expect(result.net).toBe(100);
    expect(result.rows).toEqual([expect.objectContaining({ accountNumber: "2640", side: "debit", amount: 25 })]);
  });

  it("puts utgående moms on the credit side and the öre remainder on the VAT row", () => {
    const result = splitVat(99.99, MP25, "credit");
    expect(result.net).toBe(79.99);
    expect(result.rows).toEqual([expect.objectContaining({ accountNumber: "2610", side: "credit", amount: 20 })]);
    const r12 = splitVat(100, MP12, "credit");
    expect(Math.round((r12.net + r12.rows[0]!.amount) * 100)).toBe(10000);
  });

  it("adds both utgående and ingående moms for an omvänd code and keeps the net", () => {
    const result = splitVat(1000.01, IEUV25, "debit");
    expect(result.net).toBe(1000.01);
    const byAccount = Object.fromEntries(result.rows.map((r) => [r.accountNumber, r]));
    expect(byAccount["2645"]).toEqual(expect.objectContaining({ side: "debit", amount: 250 }));
    expect(byAccount["2614"]).toEqual(expect.objectContaining({ side: "credit", amount: 250 }));
  });

  it("leaves the row untouched for zero, negative or VAT-free input", () => {
    expect(splitVat(0, MP25, "debit").rows).toEqual([]);
    expect(splitVat(-5, MP25, "debit").rows).toEqual([]);
    expect(splitVat(100, { ...MP25, rate: 0 }, "debit").rows).toEqual([]);
  });

  it("reports a missing account instead of splitting", () => {
    const result = splitVat(125, { ...MP25, accounts: [] }, "debit");
    expect(result.rows).toEqual([]);
    expect(result.net).toBe(125);
    expect(result.error).not.toBeNull();
  });
});
