import { describe, expect, it } from "vitest";
import {
  confirmableRows,
  fillWithWantedDates,
  initialConfirmationEntries,
  rowConfirmationCell,
  rowConfirmationPatches,
  rowConfirmedDate,
  rowsFollowQuestion,
  rowsKeepingOwnConfirmedDate,
  rowWantedDate,
  type ConfirmationOrder,
  type ConfirmationRow,
} from "../../web/lib/purchaseRowConfirmation";

// Bekräfta rader on the inköpsorder card: the supplier's Bekräftat
// leveransdatum per row — the row's own date, else the order's (the same
// rule as the IO list's Bekräftad av leverantör).

const order = (over: Partial<ConfirmationOrder> = {}): ConfirmationOrder => ({
  status: "confirmed",
  expectedDeliveryDate: "2026-12-01",
  confirmedDeliveryDate: null,
  ...over,
});
const row = (id: string, over: Partial<ConfirmationRow> = {}): ConfirmationRow => ({
  id,
  quantityOrdered: "10",
  quantityReceived: "0",
  expectedDeliveryDate: null,
  confirmedDeliveryDate: null,
  ...over,
});

describe("Bekräfta rader", () => {
  it("a row counts the order's dates when it has none of its own", () => {
    expect(rowConfirmedDate(row("a"), order())).toBeNull();
    expect(rowConfirmedDate(row("a"), order({ confirmedDeliveryDate: "2026-12-03" }))).toBe("2026-12-03");
    expect(rowConfirmedDate(row("a", { confirmedDeliveryDate: "2026-12-05" }), order({ confirmedDeliveryDate: "2026-12-03" }))).toBe("2026-12-05");
    expect(rowWantedDate(row("a"), order())).toBe("2026-12-01");
    expect(rowWantedDate(row("a", { expectedDeliveryDate: "2026-12-09" }), order())).toBe("2026-12-09");
    expect(rowWantedDate(row("a"), order({ expectedDeliveryDate: null }))).toBeNull();
  });

  it("the Bekräftat column: the date, Nej while a rest is owed on an open order, – otherwise", () => {
    expect(rowConfirmationCell(row("a", { confirmedDeliveryDate: "2026-12-05" }), order())).toEqual({ kind: "date", date: "2026-12-05" });
    expect(rowConfirmationCell(row("a"), order({ confirmedDeliveryDate: "2026-12-03" }))).toEqual({ kind: "date", date: "2026-12-03" });
    expect(rowConfirmationCell(row("a"), order())).toEqual({ kind: "missing" });
    expect(rowConfirmationCell(row("a"), order({ status: "draft" }))).toEqual({ kind: "missing" });
    expect(rowConfirmationCell(row("a"), order({ status: "partially_received" }))).toEqual({ kind: "missing" });
    // Fully received row, or an order with nothing more to come.
    expect(rowConfirmationCell(row("a", { quantityReceived: "10" }), order())).toEqual({ kind: "none" });
    for (const status of ["received", "closed", "cancelled"]) {
      expect(rowConfirmationCell(row("a"), order({ status }))).toEqual({ kind: "none" });
    }
  });

  it("lists the rows with a rest, starts at each row's own date and sends only what changed", () => {
    const rows = [
      row("open"),
      row("own", { confirmedDeliveryDate: "2026-12-05", expectedDeliveryDate: "2026-12-09" }),
      row("part", { quantityReceived: "4" }),
      row("done", { quantityReceived: "10" }),
    ];
    const listed = confirmableRows(rows);
    expect(listed.map((r) => r.id)).toEqual(["open", "own", "part"]);

    const start = initialConfirmationEntries(listed);
    expect(start).toEqual({ open: "", own: "2026-12-05", part: "" });
    expect(rowConfirmationPatches(listed, start)).toEqual([]);

    // Alla som önskat: each row its own wanted date (the order's when the
    // row has none).
    const filled = fillWithWantedDates(listed, order(), start);
    expect(filled).toEqual({ open: "2026-12-01", own: "2026-12-09", part: "2026-12-01" });
    expect(rowConfirmationPatches(listed, filled)).toEqual([
      { rowId: "open", confirmedDeliveryDate: "2026-12-01" },
      { rowId: "own", confirmedDeliveryDate: "2026-12-09" },
      { rowId: "part", confirmedDeliveryDate: "2026-12-01" },
    ]);

    // An emptied field clears the row's own date — it follows the order again.
    expect(rowConfirmationPatches(listed, { ...start, own: "" })).toEqual([{ rowId: "own", confirmedDeliveryDate: null }]);

    // A row without any Önskat keeps its entry; one with its own still fills.
    expect(fillWithWantedDates(listed, order({ expectedDeliveryDate: null }), start)).toEqual({ open: "", own: "2026-12-09", part: "" });
  });
});

// A new Bekräftat leveransdatum in the header (the user 2026-11-22): which
// rows keep a date of their own, and the question the card asks.
describe("raderna och orderns nya bekräftade datum", () => {
  it("lists the rows still to come with another own date — only when the header gets a new date", () => {
    const rows = [
      row("a", { confirmedDeliveryDate: "2026-11-19" }),
      row("b"),
      row("c", { confirmedDeliveryDate: "2026-11-26" }),
      row("d", { confirmedDeliveryDate: "2026-11-19", quantityReceived: "10" }),
    ];
    expect(rowsKeepingOwnConfirmedDate(rows, null, "2026-11-26").map((r) => r.id)).toEqual(["a"]);
    expect(rowsKeepingOwnConfirmedDate(rows, "2026-11-26", "2026-11-26")).toEqual([]);
    expect(rowsKeepingOwnConfirmedDate(rows, "2026-11-26", null)).toEqual([]);
  });

  it("asks with the number of rows and their dates", () => {
    expect(rowsFollowQuestion([row("a", { confirmedDeliveryDate: "2026-11-19" })], "2026-11-26")).toMatch(
      /^En rad har ett eget bekräftat leveransdatum \(2026-11-19\)\. Ska den följa orderns nya datum 2026-11-26\?/
    );
    const many = [
      row("a", { confirmedDeliveryDate: "2026-11-20" }),
      row("b", { confirmedDeliveryDate: "2026-11-19" }),
      row("c", { confirmedDeliveryDate: "2026-11-19" }),
    ];
    expect(rowsFollowQuestion(many, "2026-11-26")).toMatch(/^3 rader har ett eget bekräftat leveransdatum \(2026-11-19, 2026-11-20\)\. Ska de följa/);
  });
});
