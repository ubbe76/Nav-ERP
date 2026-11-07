import { describe, expect, it } from "vitest";
import {
  planSuggestionNotice,
  suggestionCountLabel,
  suggestionShift,
  suggestionText,
} from "../../web/lib/resourceSuggestion.js";

// Mondays: 2026-11-16 = v.47, 2026-11-30 = v.49.
describe("resourceSuggestion texts", () => {
  it("names both weeks when the operation is planned on the full resource", () => {
    expect(suggestionText({ code: "120", toWeek: "2026-11-16", currentToWeek: "2026-11-30", reason: "overloaded" })).toBe(
      "Kan bli klar v.47 på 120 (i stället för v.49)"
    );
  });

  it("uses its own wording when the current resource has no plan", () => {
    expect(suggestionText({ code: "120", toWeek: "2026-11-16", currentToWeek: null, reason: "unplanned" })).toBe(
      "Kan planeras klar v.47 på 120 (saknar plan på nuvarande resurs)"
    );
  });

  it("shifts as from → to on codes and weeks", () => {
    expect(
      suggestionShift({ fromCode: "110", code: "120", toWeek: "2026-11-16", currentToWeek: "2026-11-30", reason: "overloaded" })
    ).toBe("110 → 120, v.49 → v.47");
    expect(
      suggestionShift({ fromCode: "110", code: "120", toWeek: "2026-11-16", currentToWeek: null, reason: "unplanned" })
    ).toBe("110 → 120, v.47");
  });

  it("counts", () => {
    expect(suggestionCountLabel(2)).toBe("2 förslag på alternativ resurs");
    expect(planSuggestionNotice(1)).toBe("1 operation kan bli klar tidigare på en alternativ resurs");
    expect(planSuggestionNotice(3)).toBe("3 operationer kan bli klara tidigare på en alternativ resurs");
  });
});
