import { describe, expect, it } from "vitest";
import {
  changedMarkups,
  keptReasonText,
  parseMarkupField,
  repricingMessage,
} from "../../web/lib/markupRepricing";
import { calculatedUnavailableText } from "../../web/lib/priceQuote";
import type { MarkupRepricingPlan } from "../../web/lib/types";

const plan: MarkupRepricingPlan = {
  changed: true,
  before: { generalMarkupPercent: null, materialMarkupPercent: null },
  after: { generalMarkupPercent: 30, materialMarkupPercent: null },
  currency: "SEK",
  exchangeRate: 1,
  rows: [
    {
      rowId: "r1",
      articleId: "a1",
      articleNumber: "3001",
      quantity: 1,
      before: { unitPrice: 4087.92, discountPercent: 0, priceOrigin: "calculated" },
      after: { unitPrice: 4428.58, discountPercent: 0, source: "calculated", priceOrigin: "calculated" },
      calculatedPrice: true,
    },
  ],
  kept: [
    { rowId: "r2", articleNumber: "3002", reason: "manual" },
    { rowId: "r3", articleNumber: "3003", reason: "delivered" },
  ],
};

describe("Påslag på order (web helpers)", () => {
  it("parses the markup fields: empty inherits, bad input is NaN, two decimals", () => {
    expect(parseMarkupField("")).toBeNull();
    expect(parseMarkupField(" 12,345 ")).toBe(12.35);
    expect(parseMarkupField("0")).toBe(0);
    expect(parseMarkupField("-1")).toBeNaN();
    expect(parseMarkupField("1001")).toBeNaN();
    expect(parseMarkupField("abc")).toBeNaN();
  });

  it("sends only the fields that changed", () => {
    expect(changedMarkups({ general: null, material: null }, { general: null, material: null })).toEqual({});
    expect(changedMarkups({ general: "20.00", material: null }, { general: 20, material: null })).toEqual({});
    expect(changedMarkups({ general: "20.00", material: null }, { general: 30, material: null })).toEqual({
      generalMarkupPercent: 30,
    });
    expect(changedMarkups({ general: "20.00", material: "5.00" }, { general: 20, material: null })).toEqual({
      materialMarkupPercent: null,
    });
    // 0 is an explicit 0 %, not the same as inheriting.
    expect(changedMarkups({ general: null, material: null }, { general: 0, material: null })).toEqual({
      generalMarkupPercent: 0,
    });
  });

  it("words the kept reasons in Swedish", () => {
    expect(keptReasonText("manual")).toBe("handskrivet pris");
    expect(keptReasonText("delivered")).toBe("levererad");
    expect(keptReasonText("invoiced")).toBe("fakturerad");
    expect(keptReasonText("unchanged")).toBe("samma pris som förut");
    expect(keptReasonText("no-price")).toBe("priskedjan ger inget pris");
    expect(keptReasonText("deleted")).toBe("borttagen");
  });

  it("lists rows before and after and the kept rows with reasons — no limitation any more", () => {
    const text = repricingMessage(plan);
    expect(text).toContain("räknar om à-priset på 1 rad som prissatts av priskedjan");
    expect(text).toContain("3001: 4 087,92 → 4 428,58 SEK");
    expect(text).toContain("3002: handskrivet pris");
    expect(text).toContain("3003: levererad");
    expect(text).toContain("Handskrivna priser och levererade eller fakturerade rader ändras inte.");
    expect(text).not.toContain("räknas aldrig om");
  });

  // The review of etapp 3: only the markups the save changes are listed.
  it("names only the markups that change", () => {
    expect(repricingMessage(plan)).toContain("(generellt påslag ärvs → 30 %).");
    expect(repricingMessage(plan)).not.toContain("materialpåslag");
    const both = {
      ...plan,
      before: { generalMarkupPercent: 20, materialMarkupPercent: null },
      after: { generalMarkupPercent: 30, materialMarkupPercent: 0 },
    };
    expect(repricingMessage(both)).toContain("(generellt påslag 20 % → 30 %, materialpåslag ärvs → 0 %).");
    const material = {
      ...plan,
      before: { generalMarkupPercent: 30, materialMarkupPercent: 5 },
      after: { generalMarkupPercent: 30, materialMarkupPercent: 0 },
    };
    expect(repricingMessage(material)).toContain("(materialpåslag 5 % → 0 %).");
    expect(repricingMessage(material)).not.toContain("generellt påslag");
  });

  it("says when a row's price changes step: now the Kalkylpris, or no longer", () => {
    const row = plan.rows[0]!;
    const steps = {
      ...plan,
      rows: [
        { ...row, rowId: "r4", articleNumber: "3004", before: { ...row.before, priceOrigin: "chain" as const } },
        {
          ...row,
          rowId: "r5",
          articleNumber: "3005",
          after: { ...row.after, source: "article", priceOrigin: "chain" as const },
          calculatedPrice: false,
        },
      ],
    };
    const text = repricingMessage(steps);
    expect(text).toContain("3004: 4 087,92 → 4 428,58 SEK (nu Kalkylpris)");
    expect(text).toContain("3005: 4 087,92 → 4 428,58 SEK (inte längre Kalkylpris)");
    expect(repricingMessage(plan)).not.toContain("Kalkylpris)");
  });

  it("shows prices in the row's own unit and caps a long kept list", () => {
    const many = { ...plan, kept: Array.from({ length: 13 }, (_, i) => ({ rowId: `k${i}`, articleNumber: `9${i}`, reason: "manual" as const })) };
    const text = repricingMessage(many, { priceOf: (_id, price) => price * 5 });
    expect(text).toContain("20 439,60 → 22 142,90");
    expect(text).toContain("… och 3 till");
  });

  it("explains an outdated calculation", () => {
    expect(calculatedUnavailableText({ price: null, calculatedPriceUnavailable: "calculation-outdated" })).toContain(
      "förkalkylen är sparad före ändringen av påslagskedjan"
    );
  });
});
