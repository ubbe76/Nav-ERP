import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAV_LABEL_SIZES as SHARED_SIZES } from "@navet/shared";
import { NAV_LABEL_LABELS, NAV_LABEL_SIZES, navLabelsOf } from "../../web/lib/navLabels";

// Namn under ikonerna (2026-11-25): the web's mirror of the setting's values,
// and a size in the menu's CSS for each of them.
describe("Namn under ikonerna", () => {
  it("the web mirror has the API's values, each with a label", () => {
    expect(NAV_LABEL_SIZES).toEqual(SHARED_SIZES);
    expect(Object.keys(NAV_LABEL_LABELS)).toEqual([...NAV_LABEL_SIZES]);
  });

  it("anything but a known value reads as off", () => {
    expect(navLabelsOf("large")).toBe("large");
    expect(navLabelsOf(undefined)).toBe("off");
    expect(navLabelsOf("huge")).toBe("off");
    expect(navLabelsOf(true)).toBe("off");
  });

  it("the menu's CSS gives every size a rail width and a text size", () => {
    const css = readFileSync(new URL("../../web/components/ui/Nav.module.css", import.meta.url), "utf8");
    for (const size of NAV_LABEL_SIZES.filter((s) => s !== "off")) {
      const rule = new RegExp(`\\.sidebar\\[data-rail-labels="${size}"\\]\\s*\\{[^}]*--rail-width:[^}]*--rail-label-size:`);
      expect(css).toMatch(rule);
    }
  });
});
