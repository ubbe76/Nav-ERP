import { describe, expect, it } from "vitest";
import { proposeMatches } from "../src/modules/banking/service/match-proposals.js";
import { reconciliationSummary } from "../src/modules/banking/service/reconciliation-summary.js";

const entry = (id: string, amount: number, bookingDate = "2024-10-09", references: string[] = []) => ({ id, amount, bookingDate, references });
const row = (id: string, amount: number, date = "2024-10-09", references: string[] = []) => ({ id, amount, date, references });

describe("proposeMatches — referens", () => {
  it("pairs an entry with the row booked from the same camt.054 reference", () => {
    const proposals = proposeMatches([entry("e1", -18450, "2024-10-09", ["2024100984030001", "BO-7-1"])], [row("r1", -18450, "2024-10-07", ["BO-7-1"]), row("r2", -18450, "2024-10-09")]);
    expect(proposals).toEqual([{ entryIds: ["e1"], rowIds: ["r1"], basis: "reference", ambiguous: false }]);
  });

  it("matches a collective entry against all the payments booked from its transactions when the sum agrees", () => {
    const proposals = proposeMatches(
      [entry("e1", 26180, "2024-10-09", ["X", "T1", "T2", "T3"])],
      [row("r1", 10000, "2024-10-09", ["T1"]), row("r2", 9930, "2024-10-09", ["T2"]), row("r3", 6250, "2024-10-09", ["T3"]), row("r4", 26180, "2024-10-09")]
    );
    expect(proposals).toEqual([{ entryIds: ["e1"], rowIds: ["r1", "r2", "r3"], basis: "reference", ambiguous: false }]);
  });

  it("a reference hit with another amount is ambiguous, never matched", () => {
    const proposals = proposeMatches([entry("e1", 500, "2024-10-09", ["BO-9-2"])], [row("r1", 450, "2024-10-09", ["BO-9-2"]), row("r2", 600, "2024-10-09", ["BO-9-2"])]);
    expect(proposals).toEqual([{ entryIds: ["e1"], rowIds: ["r1", "r2"], basis: "reference", ambiguous: true }]);
  });
});

describe("proposeMatches — belopp + datum", () => {
  it("pairs the one row with the same amount within ±3 days", () => {
    const proposals = proposeMatches([entry("e1", -150, "2024-10-09")], [row("r1", -150, "2024-10-12"), row("r2", -150, "2024-10-13"), row("r3", 150, "2024-10-09")]);
    expect(proposals).toEqual([{ entryIds: ["e1"], rowIds: ["r1"], basis: "amount_date", ambiguous: false }]);
  });

  it("the window is inclusive on both sides", () => {
    expect(proposeMatches([entry("e1", 10, "2024-10-09")], [row("r1", 10, "2024-10-06")])[0]!.ambiguous).toBe(false);
    expect(proposeMatches([entry("e1", 10, "2024-10-09")], [row("r1", 10, "2024-10-05")])).toEqual([]);
  });

  it("two rows with the same amount in the window are ambiguous", () => {
    const proposals = proposeMatches([entry("e1", 1200, "2024-10-09")], [row("r1", 1200, "2024-10-08"), row("r2", 1200, "2024-10-10")]);
    expect(proposals).toEqual([{ entryIds: ["e1"], rowIds: ["r1", "r2"], basis: "amount_date", ambiguous: true }]);
  });

  it("two entries competing for one row are both ambiguous", () => {
    const proposals = proposeMatches([entry("e1", 1200, "2024-10-09"), entry("e2", 1200, "2024-10-10")], [row("r1", 1200, "2024-10-09")]);
    expect(proposals).toEqual([
      { entryIds: ["e1"], rowIds: ["r1"], basis: "amount_date", ambiguous: true },
      { entryIds: ["e2"], rowIds: ["r1"], basis: "amount_date", ambiguous: true },
    ]);
  });

  it("a row taken by a reference match is not offered again; amounts compare in öre", () => {
    const proposals = proposeMatches([entry("e1", 100, "2024-10-09", ["R"]), entry("e2", 100, "2024-10-09")], [row("r1", 100, "2024-10-09", ["R"]), row("r2", 100.004, "2024-10-10")]);
    expect(proposals).toEqual([
      { entryIds: ["e1"], rowIds: ["r1"], basis: "reference", ambiguous: false },
      { entryIds: ["e2"], rowIds: ["r2"], basis: "amount_date", ambiguous: false },
    ]);
  });

  it("nothing in common gives no proposals", () => {
    expect(proposeMatches([entry("e1", 5)], [row("r1", 7)])).toEqual([]);
    expect(proposeMatches([], [row("r1", 7)])).toEqual([]);
  });
});

describe("reconciliationSummary", () => {
  it("explains the difference by the unmatched sums", () => {
    const summary = reconciliationSummary({ statementBalance: 107580, statementBalanceDate: "2024-10-09", ledgerBalance: 107730, unmatchedEntriesSum: -150, unmatchedRowsSum: 0 });
    expect(summary).toMatchObject({ difference: -150, explained: true });
  });

  it("flags a deviation the unmatched items do not explain", () => {
    expect(reconciliationSummary({ statementBalance: 1000, statementBalanceDate: "2024-10-09", ledgerBalance: 900, unmatchedEntriesSum: 0, unmatchedRowsSum: 0 })).toMatchObject({ difference: 100, explained: false });
    expect(reconciliationSummary({ statementBalance: 1000, statementBalanceDate: "2024-10-09", ledgerBalance: 1300, unmatchedEntriesSum: 200, unmatchedRowsSum: 500 })).toMatchObject({ difference: -300, explained: true });
  });

  it("has no difference without a statement balance", () => {
    expect(reconciliationSummary({ statementBalance: null, statementBalanceDate: null, ledgerBalance: 10.005, unmatchedEntriesSum: 0, unmatchedRowsSum: 0 })).toMatchObject({ difference: null, explained: false, ledgerBalance: 10.01 });
  });
});
