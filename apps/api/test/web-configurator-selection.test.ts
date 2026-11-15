import { describe, expect, it } from "vitest";
// The web helpers import only the web's own files, so vitest loads them directly.
import { rawFromSelection, selectionFromRaw } from "../../web/components/configurator/selectionFromRaw.js";
import type { ConfiguratorGroupDetail, ConfiguratorGroupKind, ConfiguratorSelection } from "../../web/lib/configurator.js";

// ConfigureModal/TestConfigurationPanel: the form's raw state and the
// selection the API evaluates. null = deliberately empty (delprojekt 5:
// — Välj — or a cleared measure), a missing key = the default applies.

function group(code: string, kind: ConfiguratorGroupKind): ConfiguratorGroupDetail {
  return {
    id: code, code, name: code, kind, required: false, sortOrder: 1, priceAdd: "0", defaultValueId: null, articleField: null,
    unit: kind === "number" ? "mm" : null, minValue: kind === "number" ? "0" : null, maxValue: kind === "number" ? "5000" : null,
    step: null, defaultNumber: null, pricePerUnit: "0", priceBaseValue: "0", values: [],
  };
}
const GROUPS = [group("LOCK", "choice"), group("BREDD", "number"), group("HJUL", "boolean")];

describe("selectionFromRaw", () => {
  it("omits an untouched group, sends — Välj — and an emptied measure as null, an unchecked ja/nej as false", () => {
    expect(selectionFromRaw(GROUPS, {})).toEqual({ selection: {}, pending: false });
    expect(selectionFromRaw(GROUPS, { LOCK: "", BREDD: "", HJUL: false })).toEqual({
      selection: { LOCK: null, BREDD: null, HJUL: false },
      pending: false,
    });
    expect(selectionFromRaw(GROUPS, { BREDD: "   " })).toEqual({ selection: { BREDD: null }, pending: false });
  });

  it("reads a decimal comma, and a half-typed measure is pending — not null, not the default", () => {
    expect(selectionFromRaw(GROUPS, { LOCK: "B", BREDD: "1200,5", HJUL: true })).toEqual({
      selection: { LOCK: "B", BREDD: 1200.5, HJUL: true },
      pending: false,
    });
    expect(selectionFromRaw(GROUPS, { BREDD: "12," }).pending).toBe(true);
    expect(selectionFromRaw(GROUPS, { BREDD: "abc" }).pending).toBe(true);
  });

  it("ignores keys for groups the template does not have", () => {
    expect(selectionFromRaw(GROUPS, { OKAND: "X", LOCK: "A" })).toEqual({ selection: { LOCK: "A" }, pending: false });
  });
});

describe("rawFromSelection", () => {
  it("shows a stored null as — Välj — / an empty measure / an unchecked box, and a missing key as untouched", () => {
    expect(rawFromSelection(GROUPS, { LOCK: null, BREDD: null, HJUL: null })).toEqual({ LOCK: "", BREDD: "", HJUL: false });
    expect(rawFromSelection(GROUPS, {})).toEqual({});
  });

  it("writes measures with a decimal comma and round-trips every value, null included", () => {
    const stored = { LOCK: "B", BREDD: 1200.5, HJUL: true };
    expect(rawFromSelection(GROUPS, stored)).toEqual({ LOCK: "B", BREDD: "1200,5", HJUL: true });
    const selections: ConfiguratorSelection[] = [stored, { LOCK: null, BREDD: null }, { LOCK: "A" }, { HJUL: false, BREDD: 800 }];
    for (const selection of selections) {
      expect(selectionFromRaw(GROUPS, rawFromSelection(GROUPS, selection))).toEqual({ selection, pending: false });
    }
  });
});
