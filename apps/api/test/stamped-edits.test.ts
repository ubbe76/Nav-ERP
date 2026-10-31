import { describe, expect, it } from "vitest";
import { editOf, withEdit, type StampedEdits } from "../../web/lib/stampedEdits";

// The bank file cards keep the user's edits per entry across router.refresh:
// booking one entry must not reset what was typed on the others.
describe("stampedEdits", () => {
  it("keeps an edit while the entry's state is unchanged and drops it once the state changes", () => {
    let edits: StampedEdits<string> = {};
    edits = withEdit(edits, { id: "a", state: "suggested" }, "fördelning A");
    edits = withEdit(edits, { id: "b", state: "unmatched" }, "fördelning B");

    // After a refresh in which A was booked and B was not.
    expect(editOf(edits, { id: "a", state: "booked" })).toBeUndefined();
    expect(editOf(edits, { id: "b", state: "unmatched" })).toBe("fördelning B");
    expect(editOf(edits, { id: "c", state: "matched" })).toBeUndefined();
  });

  it("keeps a false value — an unticked entry stays unticked", () => {
    const edits = withEdit<boolean>({}, { id: "a", state: "matched" }, false);
    expect(editOf(edits, { id: "a", state: "matched" })).toBe(false);
  });
});
