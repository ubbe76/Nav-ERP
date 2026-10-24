import { describe, expect, it } from "vitest";
import { fromSek, invoiceSekAmounts, receiptExchangeDifference, releasedSek, toSek } from "@navet/shared";
import { evaluateConfiguration, type EngineGroup, type EngineTemplate } from "../src/modules/configurator/service/configurator-engine.js";
import { matchIncomingEntry, type MatchingLookup, type OpenReceivable } from "../src/modules/banking/service/incoming-matching.js";
import { computeOcrNumber } from "../src/modules/system/service/ocr.js";

// Valuta steg 3 (försäljning i valuta) — the pure pieces: the SEK → document
// currency conversion, the customer invoice's restmetod, the incoming
// payment's exchange difference, the configurator's prices in a currency and
// the camt.054 credit matching in the invoice's currency.

describe("fromSek", () => {
  it("converts a SEK amount to the document currency, to the öre", () => {
    expect(fromSek(1000, 11.131)).toBe(89.84); // 89,839…
    expect(fromSek(111.31, 11.131)).toBe(10);
    expect(fromSek(0.05, 11.131)).toBe(0);
    expect(fromSek(0.06, 11.131)).toBe(0.01);
  });

  it("reads the SEK amount at four decimals (an article price) before rounding once", () => {
    // 12,3456 / 1 would be 12,35 — a SEK price is never rounded by the chain
    // (resolvePrice skips fromSek for SEK), but in another currency the four
    // decimals count: 12,3456 / 0,5 = 24,6912 → 24,69, not 12,35 / 0,5 = 24,70.
    expect(fromSek(12.3456, 0.5)).toBe(24.69);
    expect(fromSek(12.345, 1)).toBe(12.35); // half away from zero
  });

  it("is symmetric for negative amounts and rejects a non-positive rate", () => {
    expect(fromSek(-1000, 11.131)).toBe(-89.84);
    expect(() => fromSek(100, 0)).toThrow();
  });

  it("round-trips with toSek within an öre of the rate", () => {
    for (const amount of [1, 99.99, 1234.56, 50000]) {
      const back = toSek(fromSek(amount, 11.131), 11.131);
      expect(Math.abs(back - amount)).toBeLessThanOrEqual(0.06);
    }
  });
});

describe("invoiceSekAmounts (kundfakturans restmetod)", () => {
  it("SEK (rate 1) returns the document's own amounts", () => {
    const rows = [
      { lineAmount: 100, vatAmount: 25 },
      { lineAmount: 33.33, vatAmount: 4 },
    ];
    expect(invoiceSekAmounts({ rate: 1, rows })).toEqual({ grossAmount: 162.33, vatAmount: 29, netAmount: 133.33, rows });
  });

  it("the receivable is exactly toSek(brutto) and the rows balance against it", () => {
    const rate = 11.131;
    const rows = [
      { lineAmount: 333.33, vatAmount: 83.33 },
      { lineAmount: 333.33, vatAmount: 40 }, // 12 %
      { lineAmount: 333.34, vatAmount: 0 }, // 0 %
      { lineAmount: 0.01, vatAmount: 0 },
    ];
    const gross = 333.33 + 83.33 + 333.33 + 40 + 333.34 + 0.01;
    const sek = invoiceSekAmounts({ rate, rows });
    expect(sek.grossAmount).toBe(toSek(gross, rate));
    expect(sek.vatAmount).toBe(toSek(83.33 + 40, rate));
    const total = sek.rows.reduce((sum, row) => sum + Math.round(row.lineAmount * 100) + Math.round(row.vatAmount * 100), 0);
    expect(total).toBe(Math.round(sek.grossAmount * 100));
    // A 0 % row never gets VAT from the remainder.
    expect(sek.rows[2]!.vatAmount).toBe(0);
    expect(sek.rows[3]!.vatAmount).toBe(0);
  });

  it("puts the öre the rows leave over on the largest row", () => {
    // Three rows of 0,33 at 1,5: toSek(0,99) = 1,49 (1,485), each row 0,50
    // (0,495) ⇒ the rows say 1,50 — the largest (first) row gives an öre back.
    const sek = invoiceSekAmounts({ rate: 1.5, rows: [0.33, 0.33, 0.33].map((lineAmount) => ({ lineAmount, vatAmount: 0 })) });
    expect(sek.grossAmount).toBe(1.49);
    expect(sek.rows.map((row) => row.lineAmount)).toEqual([0.49, 0.5, 0.5]);
  });

  it("an empty invoice is zero", () => {
    expect(invoiceSekAmounts({ rate: 11.131, rows: [] })).toEqual({ grossAmount: 0, vatAmount: 0, netAmount: 0, rows: [] });
  });
});

describe("receiptExchangeDifference", () => {
  it("positive = less SEK came in than the receivable was booked at (kursförlust)", () => {
    expect(receiptExchangeDifference({ amountSek: 10800, bankFeeSek: 50, appliedAmountsSek: [11000] })).toBe(150);
  });
  it("negative = kursvinst; a SEK payment is 0", () => {
    expect(receiptExchangeDifference({ amountSek: 11200, bankFeeSek: 0, appliedAmountsSek: [11000] })).toBe(-200);
    expect(receiptExchangeDifference({ amountSek: 500, bankFeeSek: 0, appliedAmountsSek: [200, 300] })).toBe(0);
  });
  it("a refund of a credit note: the bank movement is negative", () => {
    // A credit note booked at −1 113 SEK, refunded with −1 110 SEK leaving the
    // bank of which 10 SEK was the bank's fee ⇒ a 13 SEK gain.
    expect(receiptExchangeDifference({ amountSek: -1110, bankFeeSek: 10, appliedAmountsSek: [-1113] })).toBe(-13);
  });
  it("frigjort SEK of three partial payments adds up to the receivable (customer side)", () => {
    const grossAmount = 1000;
    const grossAmountSek = toSek(grossAmount, 11.131);
    let released = 0;
    for (const [applied, settles] of [[333.33, false], [333.33, false], [333.34, true]] as const) {
      const part = releasedSek({ currency: "EUR", grossAmount, grossAmountSek, previouslyReleasedSek: released, appliedAmount: applied, writeOffAmount: 0, settles });
      released = Math.round((released + part.appliedAmountSek) * 100) / 100;
    }
    expect(released).toBe(grossAmountSek);
  });
});

// --- the configurator's prices in a currency ---

const gid = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
function group(over: Partial<EngineGroup>): EngineGroup {
  return {
    id: gid(over.code ?? "G"), code: "G", name: "G", kind: "choice", required: false, sortOrder: 1, priceAdd: 0, defaultValueId: null,
    unit: null, minValue: null, maxValue: null, step: null, defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0, values: [],
    ...over,
  };
}
const template: EngineTemplate = {
  basePrice: 1000,
  rules: [],
  groups: [
    group({ code: "LOCK", values: [{ id: gid("LB"), code: "B", name: "B", priceAdd: 150, sortOrder: 0, active: true }] }),
    group({ code: "HJUL", kind: "boolean", priceAdd: 250, sortOrder: 2 }),
    group({ code: "BREDD", kind: "number", minValue: 0, maxValue: 5000, pricePerUnit: 0.5, priceBaseValue: 1000, sortOrder: 3 }),
  ],
};

describe("configurator engine — prices in a currency", () => {
  it("without a rate the prices are SEK, exactly as before", () => {
    const r = evaluateConfiguration(template, { LOCK: "B", HJUL: true, BREDD: 1201 });
    expect(r.price.base).toBe(1000);
    expect(r.price.additions.map((a) => a.amount)).toEqual([150, 250, 100.5]);
    expect(r.price.unitPrice).toBe(1500.5);
  });

  it("converts the base price and every SEK addition with the rate, each to the öre", () => {
    const r = evaluateConfiguration(template, { LOCK: "B", HJUL: true, BREDD: 1201 }, undefined, 11.131);
    expect(r.price.base).toBe(fromSek(1000, 11.131)); // 89,84
    // The number group's addition is (1201 − 1000) × 0,5 = 100,50 SEK first.
    expect(r.price.additions.map((a) => a.amount)).toEqual([fromSek(150, 11.131), fromSek(250, 11.131), fromSek(100.5, 11.131)]);
    expect(r.price.unitPrice).toBe(Math.round((89.84 + 13.48 + 22.46 + 9.03) * 100) / 100);
  });

  it("a customer price from the chain is already in the currency — only the additions are converted", () => {
    const r = evaluateConfiguration(template, { LOCK: "B" }, { unitPrice: 80, discountPercent: 5, source: "price_list" }, 11.131);
    expect(r.price.base).toBe(80);
    expect(r.price.unitPrice).toBe(Math.round((80 + fromSek(150, 11.131)) * 100) / 100);
    expect(r.price.discountPercent).toBe(5);
  });
});

// --- camt.054 credit: an instructed amount in the invoice's currency ---

const OCR = computeOcrNumber("FA-1");

function receivable(over: Partial<OpenReceivable>): OpenReceivable {
  return {
    invoiceId: "inv-1", invoiceNumber: "FA-1", ocrNumber: OCR, customerId: "c-1", customerName: "Kund AB", dueDate: "2026-11-01",
    openAmount: 1000, currency: "EUR", exchangeRate: 11.131, ...over,
  };
}
function lookup(items: OpenReceivable[]): MatchingLookup {
  return {
    openByOcr: new Map(items.filter((r) => r.ocrNumber).map((r) => [r.ocrNumber!, r])),
    closedByOcr: new Map(),
    candidatesByAmount: items,
    openByCustomer: new Map(),
    customers: [],
  };
}
const ocrRef = [{ type: "SCOR" as const, value: OCR, amount: null }];

describe("matchIncomingEntry — Valuta", () => {
  it("matches an EUR payment on OCR against the EUR invoice", () => {
    const p = matchIncomingEntry({ id: "e1", amount: 1000, currency: "EUR", counterpartyName: null, remittance: ocrRef }, lookup([receivable({})]), 5);
    expect(p).toMatchObject({ state: "matched", basis: "ocr", rows: [{ invoiceId: "inv-1", appliedAmount: 1000 }] });
  });

  it("the tolerance is the kronor setting in the invoice's currency", () => {
    // 5 kr at 11,131 = 0,44 EUR: 999,60 is within it, 999,50 is not.
    const within = matchIncomingEntry({ id: "e1", amount: 999.6, currency: "EUR", counterpartyName: null, remittance: ocrRef }, lookup([receivable({})]), 5);
    expect(within.rows[0]!.outcome).toMatchObject({ ok: true, kind: "closes_with_writeoff" });
    const outside = matchIncomingEntry({ id: "e1", amount: 999.5, currency: "EUR", counterpartyName: null, remittance: ocrRef }, lookup([receivable({})]), 5);
    expect(outside.rows[0]!.outcome).toMatchObject({ ok: true, kind: "partial" });
  });

  it("a SEK payment on the OCR of an EUR invoice is not matched (the amounts are not comparable)", () => {
    const p = matchIncomingEntry({ id: "e1", amount: 11131, currency: "SEK", counterpartyName: null, remittance: ocrRef }, lookup([receivable({})]), 5);
    expect(p.state).toBe("unmatched");
    expect(p.reason).toContain("FA-1 är i EUR men betalningen är i SEK");
  });

  it("amount suggestions only look at open items in the payment's currency", () => {
    const sekInvoice = receivable({ invoiceId: "inv-2", invoiceNumber: "FA-2", ocrNumber: null, currency: "SEK", exchangeRate: 1 });
    const p = matchIncomingEntry({ id: "e1", amount: 1000, currency: "EUR", counterpartyName: null, remittance: [] }, lookup([sekInvoice, receivable({ ocrNumber: null })]), 5);
    expect(p).toMatchObject({ state: "suggested", basis: "amount_only", rows: [{ invoiceId: "inv-1" }] });
  });

  it("an entry and items without a currency are SEK (the matching before the feature)", () => {
    const sek = { ...receivable({ currency: undefined, exchangeRate: undefined }) };
    const p = matchIncomingEntry({ id: "e1", amount: 1000, counterpartyName: null, remittance: ocrRef }, lookup([sek]), 5);
    expect(p.state).toBe("matched");
  });
});
