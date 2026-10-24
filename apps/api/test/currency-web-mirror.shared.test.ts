import { describe, expect, it } from "vitest";
import {
  documentSekAmounts,
  fromSek,
  invoiceSekAmounts,
  receiptExchangeDifference,
  paymentExchangeDifference,
  releasedSek,
  revaluationDifference,
  sekShare,
  toleranceInCurrency,
  toSek,
} from "@navet/shared";
// The web mirror has no imports, so vitest can load it directly — this is
// what keeps the two copies from drifting (the web can't import @navet/shared).
import * as web from "../../web/lib/currency.js";

const AMOUNTS = [0, 0.01, 0.5, 1, 99.99, 100, 1234.56, 10000, -0.5, -1234.56, 987654.32];
const RATES = [1, 0.5, 0.012345, 1.000001, 9.94461, 11.131, 10.05791, 123.456789];

describe("currency web mirror", () => {
  it("toSek is identical", () => {
    for (const amount of AMOUNTS) for (const rate of RATES) expect(web.toSek(amount, rate)).toBe(toSek(amount, rate));
  });

  it("sekShare is identical", () => {
    for (const part of AMOUNTS) {
      for (const whole of [0, 1, 1234.56, -1234.56, 10000]) {
        expect(web.sekShare(part, whole, 13742.87)).toBe(sekShare(part, whole, 13742.87));
      }
    }
  });

  it("documentSekAmounts is identical", () => {
    for (const rate of RATES) {
      const input = { rate, grossAmount: 1250, vatAmount: 250, rows: [333.33, 333.33, 333.34, 0.01] };
      expect(web.documentSekAmounts(input)).toEqual(documentSekAmounts(input));
      const credit = { rate, grossAmount: -1250, vatAmount: -250, rows: [-1000] };
      expect(web.documentSekAmounts(credit)).toEqual(documentSekAmounts(credit));
    }
  });

  it("releasedSek is identical", () => {
    for (const currency of ["SEK", "EUR"]) {
      for (const settles of [true, false]) {
        for (const writeOffAmount of [0, 0.3, -0.2]) {
          const input = {
            currency,
            grossAmount: 1000,
            grossAmountSek: 11131,
            previouslyReleasedSek: 3339.3,
            appliedAmount: 699.7,
            writeOffAmount,
            settles,
          };
          expect(web.releasedSek(input)).toEqual(releasedSek(input));
        }
      }
    }
  });

  it("toleranceInCurrency and paymentExchangeDifference are identical", () => {
    for (const rate of RATES) {
      for (const currency of ["SEK", "EUR", "JPY"]) {
        expect(web.toleranceInCurrency(5, rate, currency)).toBe(toleranceInCurrency(5, rate, currency));
      }
    }
    const input = { amountSek: 11250, bankFeeSek: 25, appliedAmountsSek: [5565.5, 5565.5] };
    expect(web.paymentExchangeDifference(input)).toBe(paymentExchangeDifference(input));
  });

  // Valuta steg 3 (försäljning i valuta).
  it("fromSek, invoiceSekAmounts and receiptExchangeDifference are identical", () => {
    for (const amount of [...AMOUNTS, 12.3456]) for (const rate of RATES) expect(web.fromSek(amount, rate)).toBe(fromSek(amount, rate));
    for (const rate of RATES) {
      const input = {
        rate,
        rows: [
          { lineAmount: 333.33, vatAmount: 83.33 },
          { lineAmount: 333.33, vatAmount: 40 },
          { lineAmount: 333.34, vatAmount: 0 },
        ],
      };
      expect(web.invoiceSekAmounts(input)).toEqual(invoiceSekAmounts(input));
    }
    const receipt = { amountSek: 10800, bankFeeSek: 50, appliedAmountsSek: [5500, 5500] };
    expect(web.receiptExchangeDifference(receipt)).toBe(receiptExchangeDifference(receipt));
  });

  // Valuta steg 4 (valutaomvärdering i bokslutet).
  it("revaluationDifference is identical", () => {
    for (const amount of AMOUNTS) {
      for (const rate of RATES) {
        for (const booked of [0, 0.03, 11131, -11131, amount * 11]) {
          expect(web.revaluationDifference(amount, booked, rate)).toEqual(revaluationDifference(amount, booked, rate));
        }
      }
    }
  });
});
