// apps/api/test/configuration-lines.test.ts
import { describe, expect, it } from "vitest";
import type { VariantSelectionEntry } from "@navet/shared";
import { configurationLines, formatMeasure } from "../src/modules/configurator/service/configuration-lines.js";
import { configurationLines as webLines, formatMeasure as webMeasure } from "../../web/lib/configurationLines";

const choice = (groupCode: string, groupName: string, valueCode: string | null, valueName: string | null): VariantSelectionEntry =>
  ({ groupCode, groupName, kind: "choice", valueCode, valueName, value: valueCode, unit: null });
const bool = (groupCode: string, groupName: string, on: boolean): VariantSelectionEntry =>
  ({ groupCode, groupName, kind: "boolean", valueCode: null, valueName: null, value: on, unit: null });
const measure = (groupCode: string, groupName: string, value: number | null, unit: string | null): VariantSelectionEntry =>
  ({ groupCode, groupName, kind: "number", valueCode: null, valueName: null, value, unit });

describe("configurationLines", () => {
  it("prints Grupp: Värde per kind in selection order, skipping Nej and empty groups", () => {
    const lines = configurationLines([
      choice("LOCK", "Lock", "B", "Lock B"),
      bool("AVLOPP", "Avlopp", true),
      bool("HYLLA", "Hylla", false),
      measure("BREDD", "Bredd", 1200, "mm"),
      measure("DJUP", "Djup", 12.5, null),
      choice("FARG", "Färg", null, null),
      measure("HOJD", "Höjd", null, "mm"),
    ]);
    expect(lines).toEqual(["Lock: Lock B", "Avlopp: Ja", "Bredd: 1 200 mm", "Djup: 12,5"]);
  });

  it("appends the group's summed addition, omitting zero, with ASCII minus", () => {
    const lines = configurationLines(
      [choice("LOCK", "Lock", "B", "Lock B"), measure("BREDD", "Bredd", 1200, "mm"), bool("AVLOPP", "Avlopp", true)],
      [{ groupCode: "LOCK", amount: 200 }, { groupCode: "LOCK", amount: 40 }, { groupCode: "BREDD", amount: 0 }, { groupCode: "AVLOPP", amount: -150 }]
    );
    expect(lines).toEqual(["Lock: Lock B (+ 240,00)", "Bredd: 1 200 mm", "Avlopp: Ja (- 150,00)"]);
  });

  it("prints no price suffix at all when additions are not passed (pick list / delivery note)", () => {
    expect(configurationLines([choice("LOCK", "Lock", "B", "Lock B")])).toEqual(["Lock: Lock B"]);
  });

  it("formatMeasure: thousands separator, decimal comma, no trailing zeros", () => {
    expect(formatMeasure(1200)).toBe("1 200");
    expect(formatMeasure(1234567.5)).toBe("1 234 567,5");
    expect(formatMeasure(0.25)).toBe("0,25");
    expect(formatMeasure(-0)).toBe("0");
  });
});

// The web mirror (apps/web/lib/configurationLines.ts) must print exactly what the PDFs print.
describe("web mirror", () => {
  const selection = [
    choice("LOCK", "Lock", "B", "Lock B"),
    bool("AVLOPP", "Avlopp", true),
    bool("HYLLA", "Hylla", false),
    measure("BREDD", "Bredd", 1200, "mm"),
    measure("DJUP", "Djup", 12.5, null),
    choice("FARG", "Färg", null, null),
    measure("HOJD", "Höjd", null, "mm"),
  ];
  const additions = [{ groupCode: "LOCK", amount: 1240 }, { groupCode: "AVLOPP", amount: -150 }, { groupCode: "BREDD", amount: 0 }];

  it("gives identical lines with and without additions", () => {
    expect(webLines(selection)).toEqual(configurationLines(selection));
    expect(webLines(selection, additions)).toEqual(configurationLines(selection, additions));
  });

  it("formats measures identically", () => {
    for (const n of [0, -0, 12, 1200, 1234567.5, 0.25, 12.3456, 1999.99]) expect(webMeasure(n)).toBe(formatMeasure(n));
  });
});
