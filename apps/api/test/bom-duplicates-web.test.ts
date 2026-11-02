import { describe, expect, it } from "vitest";
import { alreadyInStructureText, bomDuplicateText, bomDuplicates } from "../../web/lib/bomDuplicates";

// Samma artikel flera gånger i en struktur (0176): the card's warnings,
// derived from its row list.
const row = (componentArticleId: string, componentArticleNumber: string, position: string | null = null) => ({
  componentArticleId,
  componentArticleNumber,
  position,
});

describe("bomDuplicates", () => {
  it("lists only components on more than one row, in first-seen order", () => {
    const rows = [row("k2", "K-2", "1"), row("k1", "K-1", "3"), row("k2", "K-2"), row("k3", "K-3"), row("k1", "K-1", "7")];
    const duplicates = bomDuplicates(rows);
    expect(duplicates.map((d) => [d.componentArticleNumber, d.count])).toEqual([
      ["K-2", 2],
      ["K-1", 2],
    ]);
    expect(duplicates.map(bomDuplicateText)).toEqual(["K-2 ingår 2 gånger (Pos. 1, —)", "K-1 ingår 2 gånger (Pos. 3, 7)"]);
    expect(bomDuplicateText(bomDuplicates([row("k", "K"), row("k", "K")])[0]!)).toBe("K ingår 2 gånger");
    expect(bomDuplicates([row("k1", "K-1"), row("k2", "K-2")])).toEqual([]);
  });

  it("warns in the add dialog when the picked component is already there", () => {
    const rows = [row("k1", "K-1", "3"), row("k2", "K-2"), row("k2", "K-2")];
    expect(alreadyInStructureText(rows, "k1")).toBe("Artikeln finns redan i strukturen (Pos. 3) — den läggs till som en ny rad.");
    expect(alreadyInStructureText(rows, "k2")).toBe("Artikeln finns redan i strukturen 2 gånger — den läggs till som en ny rad.");
    expect(alreadyInStructureText(rows, "k9")).toBeNull();
  });
});
