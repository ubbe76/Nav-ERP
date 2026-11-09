import { describe, expect, it } from "vitest";
// The web helper has no imports, so vitest loads it directly.
import { mergeUntouched, reconcileWithRecomputed } from "../../web/lib/rowStateMerge.js";

type Row = { id: string; proposal: number };
type State = { quantity: string; touched: boolean };
const make = (row: Row): State => ({ quantity: String(row.proposal), touched: false });

describe("mergeUntouched — Behovsberäkningens radtillstånd", () => {
  it("rebuilds untouched rows from the fresh proposal, keeps touched ones and other pages' rows", () => {
    const prev: Record<string, State> = {
      a: { quantity: "30", touched: false }, // first seen as 30, untouched
      b: { quantity: "7", touched: true }, // the user typed 7
      c: { quantity: "5", touched: true }, // a selection on another page
    };
    const next = mergeUntouched(prev, [{ id: "a", proposal: 40 }, { id: "b", proposal: 12 }, { id: "d", proposal: 3 }], (r) => r.id, make);
    expect(next).toEqual({
      a: { quantity: "40", touched: false },
      b: { quantity: "7", touched: true },
      c: { quantity: "5", touched: true },
      d: { quantity: "3", touched: false },
    });
    // The input is not mutated.
    expect(prev.a!.quantity).toBe("30");
  });
});

type Line = { id: string; proposal: number; needDate: string };
type Choice = { quantity: string; needDate: string; selected: boolean; touched: boolean };
const makeChoice = (row: Line): Choice => ({ quantity: String(row.proposal), needDate: row.needDate, selected: true, touched: false });
const keep = (old: Choice, rebuilt: Choice): Choice => ({ ...rebuilt, selected: old.selected && rebuilt.selected, quantity: old.quantity, touched: true });

describe("reconcileWithRecomputed — after Uppdatera", () => {
  it("drops states whose proposal is gone, rebuilds untouched ones and keeps the user's choice on the new data", () => {
    const prev: Record<string, Choice> = {
      // On another page, untouched: the proposal moved from week 10 to 11.
      "purchase:a:2030-03-04": { quantity: "5", needDate: "2030-03-05", selected: true, touched: false },
      // On another page, touched: same week, but the behovsdatum moved.
      "purchase:b:2030-03-04": { quantity: "9", needDate: "2030-03-06", selected: true, touched: true },
      // Touched and deselected — stays deselected.
      "purchase:c:2030-03-04": { quantity: "1", needDate: "2030-03-04", selected: false, touched: true },
      // Untouched, same key: follows the new proposal.
      "purchase:d:2030-03-04": { quantity: "3", needDate: "2030-03-07", selected: true, touched: false },
    };
    const fresh: Line[] = [
      { id: "purchase:a:2030-03-11", proposal: 5, needDate: "2030-03-12" },
      { id: "purchase:b:2030-03-04", proposal: 4, needDate: "2030-03-04" },
      { id: "purchase:c:2030-03-04", proposal: 2, needDate: "2030-03-04" },
      { id: "purchase:d:2030-03-04", proposal: 6, needDate: "2030-03-05" },
    ];
    expect(reconcileWithRecomputed(prev, fresh, (r) => r.id, makeChoice, keep)).toEqual({
      "purchase:b:2030-03-04": { quantity: "9", needDate: "2030-03-04", selected: true, touched: true },
      "purchase:c:2030-03-04": { quantity: "1", needDate: "2030-03-04", selected: false, touched: true },
      "purchase:d:2030-03-04": { quantity: "6", needDate: "2030-03-05", selected: true, touched: false },
    });
    // A new proposal the user never saw is not added here (mergeUntouched
    // adds the shown page's lines).
  });
});
