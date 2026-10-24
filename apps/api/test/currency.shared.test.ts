import { describe, expect, it } from "vitest";
import {
  createExchangeRateSchema,
  documentSekAmounts,
  exchangeRateValueSchema,
  fetchExchangeRatesSchema,
  paymentExchangeDifference,
  releasedSek,
  sekShare,
  toleranceInCurrency,
  toSek,
} from "@navet/shared";

// Valuta: the ONE conversion — exact öre × micro-rate arithmetic, rounded
// half away from zero (Postgres' round(x, 2)), symmetric for credit notes.
describe("toSek", () => {
  it("converts to the öre", () => {
    expect(toSek(1234, 11.131)).toBe(13735.65); // 13 735,654
    expect(toSek(1250, 11.131)).toBe(13913.75);
    expect(toSek(0.01, 11.131)).toBe(0.11);
    expect(toSek(100, 1)).toBe(100);
  });

  it("rounds an exact half-öre away from zero, for credit notes too", () => {
    // 0,05 × 0,1 = 0,005 exactly.
    expect(toSek(0.05, 0.1)).toBe(0.01);
    expect(toSek(-0.05, 0.1)).toBe(-0.01);
    // A float product would land on 1.0049999… here: 0,67 × 1,5 = 1,005.
    expect(toSek(0.67, 1.5)).toBe(1.01);
    expect(toSek(-0.67, 1.5)).toBe(-1.01);
  });

  it("is exact where floating point is not", () => {
    // 1,15 × 100 is 114.99999999999999 in floats.
    expect(toSek(1.15, 100)).toBe(115);
    expect(toSek(99999999.99, 0.000001)).toBe(100);
    expect(toSek(-0, 11.131)).toBe(0);
    expect(Object.is(toSek(-0.0001, 11.131), -0)).toBe(false);
  });
});

describe("sekShare", () => {
  it("takes the proportional share of a fixed SEK total", () => {
    expect(sekShare(500, 1000, 11131)).toBe(5565.5);
    expect(sekShare(333.33, 1000, 11131)).toBe(3710.3); // 3 710,296…
    expect(sekShare(0, 1000, 11131)).toBe(0);
    expect(sekShare(10, 0, 100)).toBe(0);
  });
});

describe("documentSekAmounts (the supplier invoice's restmetod)", () => {
  it("keeps the debt exactly toSek(gross) and puts the rows' rounding on the remainder", () => {
    const sek = documentSekAmounts({ rate: 11.131, grossAmount: 1250, vatAmount: 250, rows: [333.33, 333.33] });
    expect(sek).toEqual({ grossAmount: 13913.75, vatAmount: 2782.75, netAmount: 11131, rows: [3710.3, 3710.3], remainder: 3710.4 });
    // The verification balances: debt = VAT + rows + remainder.
    expect(Math.round((sek.vatAmount + sek.rows[0]! + sek.rows[1]! + sek.remainder) * 100) / 100).toBe(sek.grossAmount);
  });

  it("returns a SEK document's own amounts", () => {
    expect(documentSekAmounts({ rate: 1, grossAmount: 1250, vatAmount: 250, rows: [900] })).toEqual({
      grossAmount: 1250,
      vatAmount: 250,
      netAmount: 1000,
      rows: [900],
      remainder: 100,
    });
  });

  it("handles a credit note", () => {
    expect(documentSekAmounts({ rate: 11.131, grossAmount: -125.06, vatAmount: -25.01, rows: [] })).toEqual({
      grossAmount: -1392.04,
      vatAmount: -278.39,
      netAmount: -1113.65,
      rows: [],
      remainder: -1113.65,
    });
  });
});

describe("releasedSek (frigjort SEK)", () => {
  const invoice = { currency: "EUR", grossAmount: 300, grossAmountSek: 11131.01 };

  it("releases exactly gross_amount_sek over three partial payments", () => {
    // 3 × 100 EUR of a 300 EUR invoice whose debt was booked at 11 131,01.
    // The proportional shares alone would be 3 × 3 710,34 = 11 131,02 — an
    // öre too much; the settling row takes the rest instead.
    const first = releasedSek({ ...invoice, previouslyReleasedSek: 0, appliedAmount: 100, writeOffAmount: 0, settles: false });
    const second = releasedSek({ ...invoice, previouslyReleasedSek: first.appliedAmountSek, appliedAmount: 100, writeOffAmount: 0, settles: false });
    const third = releasedSek({
      ...invoice,
      previouslyReleasedSek: first.appliedAmountSek + second.appliedAmountSek,
      appliedAmount: 100,
      writeOffAmount: 0,
      settles: true,
    });
    expect(first.appliedAmountSek).toBe(3710.34);
    expect(second.appliedAmountSek).toBe(3710.34);
    expect(third.appliedAmountSek).toBe(3710.33);
    expect(Math.round((first.appliedAmountSek + second.appliedAmountSek + third.appliedAmountSek) * 100) / 100).toBe(11131.01);
  });

  it("splits a settling row with a write-off into the write-off's share and the rest", () => {
    const released = releasedSek({
      currency: "EUR",
      grossAmount: 1000,
      grossAmountSek: 11131,
      previouslyReleasedSek: 0,
      appliedAmount: 999.6,
      writeOffAmount: 0.4,
      settles: true,
    });
    expect(released).toEqual({ appliedAmountSek: 11126.55, writeOffAmountSek: 4.45 });
  });

  it("is the amounts themselves on a SEK invoice", () => {
    expect(
      releasedSek({ currency: "SEK", grossAmount: 1000, grossAmountSek: 1000, previouslyReleasedSek: 300, appliedAmount: 695, writeOffAmount: 5, settles: true })
    ).toEqual({ appliedAmountSek: 695, writeOffAmountSek: 5 });
  });

  it("releases a credit note negatively", () => {
    const released = releasedSek({
      currency: "EUR",
      grossAmount: -100,
      grossAmountSek: -1100,
      previouslyReleasedSek: 0,
      appliedAmount: -100,
      writeOffAmount: 0,
      settles: true,
    });
    expect(released).toEqual({ appliedAmountSek: -1100, writeOffAmountSek: 0 });
  });
});

describe("toleranceInCurrency", () => {
  it("is the kronor tolerance on a SEK invoice", () => {
    expect(toleranceInCurrency(5, 1, "SEK")).toBe(5);
  });

  it("is what the tolerance is worth in the invoice's currency, rounded down", () => {
    expect(toleranceInCurrency(5, 11.131, "EUR")).toBe(0.44); // 0,4492…
    expect(toleranceInCurrency(5, 0.0712, "JPY")).toBe(70.22); // 70,224…
  });
});

describe("paymentExchangeDifference", () => {
  it("is positive (a loss) when more SEK left the bank than was released", () => {
    expect(paymentExchangeDifference({ amountSek: 11200, bankFeeSek: 50, appliedAmountsSek: [11131] })).toBe(19);
  });

  it("is negative (a gain) when less SEK left the bank", () => {
    expect(paymentExchangeDifference({ amountSek: 11000, bankFeeSek: 0, appliedAmountsSek: [5565.5, 5565.5] })).toBe(-131);
  });
});

describe("rate schemas", () => {
  it("accepts positive rates with at most six decimals (more are rounded)", () => {
    expect(exchangeRateValueSchema.parse("11.131")).toBe(11.131);
    expect(exchangeRateValueSchema.parse(11.1310004)).toBe(11.131);
    expect(exchangeRateValueSchema.safeParse(0).success).toBe(false);
    expect(exchangeRateValueSchema.safeParse(-1).success).toBe(false);
    expect(exchangeRateValueSchema.safeParse(0.0000001).success).toBe(false);
  });

  it("normalizes the currency and refuses SEK for a manual rate", () => {
    expect(createExchangeRateSchema.parse({ currency: "eur", date: "2026-10-23", rate: 11.131 }).currency).toBe("EUR");
    expect(createExchangeRateSchema.safeParse({ currency: "SEK", date: "2026-10-23", rate: 1 }).success).toBe(false);
    expect(createExchangeRateSchema.safeParse({ currency: "EURO", date: "2026-10-23", rate: 1 }).success).toBe(false);
  });

  it("caps Hämta från Riksbanken at 93 days and an ordered interval", () => {
    expect(fetchExchangeRatesSchema.safeParse({ currency: "EUR", from: "2026-07-01", to: "2026-10-02" }).success).toBe(true);
    expect(fetchExchangeRatesSchema.safeParse({ currency: "EUR", from: "2026-07-01", to: "2026-10-03" }).success).toBe(false);
    expect(fetchExchangeRatesSchema.safeParse({ currency: "EUR", from: "2026-10-03", to: "2026-10-01" }).success).toBe(false);
  });
});
