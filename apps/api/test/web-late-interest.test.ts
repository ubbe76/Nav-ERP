import { describe, expect, it } from "vitest";
// The late-interest helpers have no imports, so vitest can load them directly.
import {
  customerSummaries,
  defaultSelection,
  formatRatePercent,
  halfYearLabel,
  halfYearStart,
  halfYearStartBefore,
  halfYearStartOf,
  parsePercent,
  periodText,
  rateText,
  runItems,
  type LateInterestRow,
} from "../../web/lib/lateInterest.js";

function row(over: Partial<LateInterestRow> & { invoiceId: string }): LateInterestRow {
  return {
    customerId: "c1",
    customerName: "Kund AB",
    fromDate: "2026-09-02",
    toDate: "2026-09-20",
    days: 19,
    rate: 12,
    rates: [12],
    interest: 100,
    fee: 0,
    belowMinimum: false,
    rateMissing: false,
    ...over,
  };
}

describe("default selection", () => {
  it("marks interest rows except belowMinimum and rateMissing, and every fee", () => {
    const rows = [
      row({ invoiceId: "a", interest: 250 }),
      row({ invoiceId: "b", interest: 20, belowMinimum: true }),
      row({ invoiceId: "c", interest: null, rateMissing: true, fee: 450 }),
      row({ invoiceId: "d", interest: 0, fee: 450 }),
    ];
    const sel = defaultSelection(rows);
    expect([...sel.interest]).toEqual(["a"]);
    expect([...sel.fee].sort()).toEqual(["c", "d"]);
  });
});

describe("customer summaries", () => {
  const rows = [
    row({ invoiceId: "a", interest: 60, fee: 450 }),
    row({ invoiceId: "b", interest: 30 }),
    row({ invoiceId: "c", customerId: "c2", customerName: "Andra AB", interest: 40 }),
  ];
  const all = { interest: new Set(["a", "b", "c"]), fee: new Set(["a"]) };

  it("sums interest and fee per customer in row order", () => {
    const s = customerSummaries(rows, all, 50);
    expect(s.map((x) => x.customerId)).toEqual(["c1", "c2"]);
    expect(s[0]).toMatchObject({ interest: 90, fee: 450, total: 540, interestBelowMinimum: false });
  });

  it("applies the minimum to the customer's sum, not each invoice", () => {
    const s = customerSummaries(rows, all, 100);
    // c1: 90 < 100 -> interest dropped, the fee still gets its invoice.
    expect(s[0]).toMatchObject({ interest: 90, total: 450, interestBelowMinimum: true });
    // c2: 40 < 100, nothing else -> no invoice.
    expect(s[1]).toMatchObject({ total: 0, interestBelowMinimum: true });
  });

  it("skips customers with nothing selected and unchargeable rows", () => {
    const s = customerSummaries(
      [row({ invoiceId: "x", interest: null, rateMissing: true })],
      { interest: new Set(["x"]), fee: new Set() },
      100
    );
    expect(s).toEqual([]);
  });
});

describe("run items", () => {
  it("sends one item per row with something selected, with the row's own period start", () => {
    const rows = [
      row({ invoiceId: "a", fromDate: "2026-09-02", fee: 450 }),
      row({ invoiceId: "b", fromDate: "2026-08-01" }),
      row({ invoiceId: "c", interest: 0, fee: 450, fromDate: "2026-07-05" }),
    ];
    const items = runItems(rows, { interest: new Set(["a"]), fee: new Set(["c"]) });
    expect(items).toEqual([
      { invoiceId: "a", fromDate: "2026-09-02", includeInterest: true, includeFee: false, fee: 450 },
      { invoiceId: "c", fromDate: "2026-07-05", includeInterest: false, includeFee: true, fee: 450 },
    ]);
  });
});

describe("texts", () => {
  it("formats rates with a comma and shows several rates across a half-year shift", () => {
    expect(formatRatePercent(12)).toBe("12,00 %");
    expect(rateText(row({ invoiceId: "a", rate: 12 }))).toBe("12,00 %");
    expect(rateText(row({ invoiceId: "a", rate: null, rates: [10, 12] }))).toBe("10,00 / 12,00 %");
    expect(rateText(row({ invoiceId: "a", rate: null, rates: [], interest: null, rateMissing: true }))).toBe("Saknas");
  });

  it("writes the period or a dash", () => {
    expect(periodText(row({ invoiceId: "a" }))).toBe("2026-09-02–2026-09-20");
    expect(periodText(row({ invoiceId: "a", days: 0 }))).toBe("–");
  });

  it("names half years and finds their starts", () => {
    expect(halfYearLabel("2026-01-01")).toBe("första halvåret 2026");
    expect(halfYearLabel("2026-07-01")).toBe("andra halvåret 2026");
    expect(halfYearStart(2026, 2)).toBe("2026-07-01");
    expect(halfYearStartOf("2026-06-30")).toBe("2026-01-01");
    expect(halfYearStartOf("2026-07-01")).toBe("2026-07-01");
    expect(halfYearStartBefore("2026-10-25", 3)).toBe("2025-01-01");
    expect(halfYearStartBefore("2026-03-01", 1)).toBe("2025-07-01");
  });

  it("parses typed percentages", () => {
    expect(parsePercent("12,5")).toBe(12.5);
    expect(parsePercent(" -0.5 ")).toBe(-0.5);
    expect(parsePercent("")).toBeNull();
    expect(parsePercent("abc")).toBeNull();
  });
});
