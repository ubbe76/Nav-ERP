import { describe, expect, it } from "vitest";
import {
  planSuggestionNotice,
  suggestionCountLabel,
  suggestionShift,
  suggestionText,
} from "../../web/lib/resourceSuggestion.js";

// Days: 2026-11-16 = 16 nov, 2026-11-30 = 30 nov.
describe("resourceSuggestion texts", () => {
  it("names both days when the operation is planned on the full resource", () => {
    expect(suggestionText({ code: "120", toDate: "2026-11-16", currentToDate: "2026-11-30", reason: "overloaded" })).toBe(
      "Kan bli klar 16 nov på 120 (i stället för 30 nov)"
    );
  });

  it("uses its own wording when the current resource has no plan", () => {
    expect(suggestionText({ code: "120", toDate: "2026-11-16", currentToDate: null, reason: "unplanned" })).toBe(
      "Kan planeras klar 16 nov på 120 (saknar plan på nuvarande resurs)"
    );
  });

  it("shifts as from → to on codes and days", () => {
    expect(
      suggestionShift({ fromCode: "110", code: "120", toDate: "2026-11-16", currentToDate: "2026-11-30", reason: "overloaded" })
    ).toBe("110 → 120, 30 nov → 16 nov");
    expect(
      suggestionShift({ fromCode: "110", code: "120", toDate: "2026-11-16", currentToDate: null, reason: "unplanned" })
    ).toBe("110 → 120, 16 nov");
  });

  it("counts", () => {
    expect(suggestionCountLabel(2)).toBe("2 förslag på alternativ resurs");
    expect(planSuggestionNotice(1)).toBe("1 operation kan bli klar tidigare på en alternativ resurs");
    expect(planSuggestionNotice(3)).toBe("3 operationer kan bli klara tidigare på en alternativ resurs");
  });
});
