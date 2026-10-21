import { describe, expect, it } from "vitest";
import type { QuoteFollowupSourceRow } from "../src/modules/reports/repository/quote-followup.repository.js";
import { buildQuoteFollowup, NO_LOSS_REASON_LABEL, quoteOutcome } from "../src/modules/reports/service/quote-followup.js";

// Offertuppföljning — the pure builder: outcomes, the hit rate with a zero
// denominator, cancelled quotes outside the hit rate, and the groupings.

const TODAY = "2030-03-04";

let n = 0;
function row(over: Partial<QuoteFollowupSourceRow> = {}): QuoteFollowupSourceRow {
  n += 1;
  return {
    id: `id-${n}`,
    orderNumber: `KO-${1000 + n}`,
    customerId: "c-anna",
    customerNumber: "10001",
    customerName: "Anna Storkök AB",
    createdDate: "2030-01-15",
    quoteValidUntil: "2030-02-14",
    status: "quote",
    lostReasonId: null,
    lostReasonCode: null,
    lostReasonName: null,
    lostNote: null,
    value: 1000,
    ...over,
  };
}

const lost = (reason: { id: string; code: string; name: string } | null, value = 1000, note: string | null = null) =>
  row({
    status: "lost",
    lostReasonId: reason?.id ?? null,
    lostReasonCode: reason?.code ?? null,
    lostReasonName: reason?.name ?? null,
    lostNote: note,
    value,
  });

const PRIS = { id: "r-pris", code: "PRIS", name: "Pris" };
const LEVTID = { id: "r-levtid", code: "LEVTID", name: "Leveranstid" };

describe("quoteOutcome", () => {
  it("maps every status: won for the order statuses, lost, cancelled, else open", () => {
    expect(quoteOutcome("confirmed")).toBe("won");
    expect(quoteOutcome("in_production")).toBe("won");
    expect(quoteOutcome("delivered")).toBe("won");
    expect(quoteOutcome("invoiced")).toBe("won");
    expect(quoteOutcome("lost")).toBe("lost");
    expect(quoteOutcome("cancelled")).toBe("cancelled");
    expect(quoteOutcome("quote")).toBe("open");
  });
});

describe("buildQuoteFollowup", () => {
  it("counts and values every outcome, marks expired open quotes and computes both hit rates", () => {
    const result = buildQuoteFollowup(
      [
        row({ status: "confirmed", value: 3000 }),
        row({ status: "invoiced", value: 1000 }),
        lost(PRIS, 2000),
        row({ status: "quote", quoteValidUntil: "2030-03-03", value: 500 }), // expired yesterday
        row({ status: "quote", quoteValidUntil: TODAY, value: 400 }), // valid today
        row({ status: "quote", quoteValidUntil: null, value: 300 }), // never expires
        row({ status: "cancelled", value: 9000 }),
      ],
      TODAY
    );
    expect(result.totals).toEqual({
      count: 7,
      value: 16200,
      won: 2,
      wonValue: 4000,
      lost: 1,
      lostValue: 2000,
      open: 3,
      openValue: 1200,
      expired: 1,
      expiredValue: 500,
      cancelled: 1,
      cancelledValue: 9000,
      // 2 / (2 + 1), 4000 / (4000 + 2000) — the cancelled 9000 never counts.
      hitRateCount: 0.6667,
      hitRateValue: 0.6667,
    });
    expect(result.quotes.map((q) => [q.outcome, q.expired])).toEqual([
      ["won", false],
      ["won", false],
      ["lost", false],
      ["open", true],
      ["open", false],
      ["open", false],
      ["cancelled", false],
    ]);
  });

  it("gives null hit rates when nothing is decided — open and cancelled only", () => {
    const result = buildQuoteFollowup([row(), row({ status: "cancelled" })], TODAY);
    expect(result.totals.hitRateCount).toBeNull();
    expect(result.totals.hitRateValue).toBeNull();
    expect(result.lossReasons).toEqual([]);
  });

  it("hit rate 0 (all lost) and 1 (all won) are numbers, not null", () => {
    expect(buildQuoteFollowup([lost(PRIS)], TODAY).totals.hitRateCount).toBe(0);
    expect(buildQuoteFollowup([row({ status: "confirmed" })], TODAY).totals.hitRateValue).toBe(1);
  });

  it("groups per customer, sorted on quoted value, each with its own hit rate", () => {
    const result = buildQuoteFollowup(
      [
        row({ customerId: "c-anna", customerName: "Anna Storkök AB", status: "confirmed", value: 100 }),
        row({ customerId: "c-bert", customerNumber: "10002", customerName: "Bert Restaurang AB", status: "quote", value: 5000 }),
        { ...lost(PRIS, 300), customerId: "c-anna", customerName: "Anna Storkök AB" },
      ],
      TODAY
    );
    expect(result.customers.map((c) => [c.customerName, c.count, c.value, c.hitRateCount, c.hitRateValue])).toEqual([
      ["Bert Restaurang AB", 1, 5000, null, null],
      ["Anna Storkök AB", 2, 400, 0.5, 0.25],
    ]);
  });

  it("groups per month in chronological order on the Stockholm creation day", () => {
    const result = buildQuoteFollowup(
      [
        row({ createdDate: "2030-03-01", status: "confirmed" }),
        row({ createdDate: "2030-01-31" }),
        row({ createdDate: "2030-01-02", status: "lost" }),
      ],
      TODAY
    );
    expect(result.months.map((m) => [m.month, m.count, m.won, m.lost, m.open, m.hitRateCount])).toEqual([
      ["2030-01", 2, 0, 1, 1, 0],
      ["2030-03", 1, 1, 0, 0, 1],
    ]);
  });

  it("groups the lost quotes per reason with the share of the lost, 'Ingen orsak angiven' as its own row", () => {
    const result = buildQuoteFollowup(
      [lost(PRIS, 100), lost(PRIS, 200), lost(LEVTID, 50), lost(null, 999), row({ status: "confirmed" })],
      TODAY
    );
    expect(result.lossReasons).toEqual([
      { reasonId: "r-pris", code: "PRIS", name: "Pris", count: 2, value: 300, share: 0.5 },
      { reasonId: null, code: null, name: NO_LOSS_REASON_LABEL, count: 1, value: 999, share: 0.25 },
      { reasonId: "r-levtid", code: "LEVTID", name: "Leveranstid", count: 1, value: 50, share: 0.25 },
    ]);
  });

  it("carries the reason and note on a lost quote only, and rounds values to öre", () => {
    const result = buildQuoteFollowup(
      [lost(PRIS, 10.005, "För dyrt"), row({ status: "confirmed", lostNote: "stale", value: 1.004 })],
      TODAY
    );
    expect(result.quotes[0]!.lostReason).toEqual(PRIS);
    expect(result.quotes[0]!.lostNote).toBe("För dyrt");
    expect(result.quotes[0]!.value).toBe(10.01);
    expect(result.quotes[1]!.lostReason).toBeNull();
    expect(result.quotes[1]!.lostNote).toBeNull();
    expect(result.quotes[1]!.value).toBe(1);
  });

  it("is empty for no rows", () => {
    const result = buildQuoteFollowup([], TODAY);
    expect(result.totals.count).toBe(0);
    expect(result.customers).toEqual([]);
    expect(result.months).toEqual([]);
    expect(result.quotes).toEqual([]);
  });
});
