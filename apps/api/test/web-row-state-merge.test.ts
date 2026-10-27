import { describe, expect, it } from "vitest";
// The web helper has no imports, so vitest loads it directly.
import { mergeUntouched } from "../../web/lib/rowStateMerge.js";

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
