import { describe, expect, it } from "vitest";
import { moveRowHighlight } from "../../web/lib/listKeyboard";

// Artikelregistret: the arrow keys in the search field walk a highlight over
// the result rows (null = no row marked, Enter then just searches).
describe("moveRowHighlight", () => {
  it("ArrowDown marks the first row, then walks down and stops at the last", () => {
    expect(moveRowHighlight(null, "ArrowDown", 3)).toBe(0);
    expect(moveRowHighlight(0, "ArrowDown", 3)).toBe(1);
    expect(moveRowHighlight(2, "ArrowDown", 3)).toBe(2);
  });

  it("ArrowUp walks up and leaves the rows from the first one", () => {
    expect(moveRowHighlight(2, "ArrowUp", 3)).toBe(1);
    expect(moveRowHighlight(0, "ArrowUp", 3)).toBeNull();
    expect(moveRowHighlight(null, "ArrowUp", 3)).toBeNull();
  });

  it("never marks a row in an empty list, and pulls a stale index back inside", () => {
    expect(moveRowHighlight(null, "ArrowDown", 0)).toBeNull();
    expect(moveRowHighlight(5, "ArrowDown", 2)).toBe(1);
    expect(moveRowHighlight(5, "ArrowUp", 2)).toBe(0);
  });
});
