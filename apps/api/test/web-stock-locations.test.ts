import { describe, expect, it } from "vitest";
// The web helper has no imports, so vitest loads it directly.
import { locationOptionLabel, outflowLocationChoices, withCurrentLocation } from "../../web/lib/stockLocations.js";

const open = { id: "a", warehouseName: "Huvudlager", name: "A1", blocked: false };
const blocked = { id: "b", warehouseName: "Huvudlager", name: "K1", blocked: true };

describe("web stockLocations", () => {
  it("labels a blocked location with a suffix", () => {
    expect(locationOptionLabel(open)).toBe("Huvudlager — A1");
    expect(locationOptionLabel(blocked)).toBe("Huvudlager — K1 (spärrad)");
  });

  it("treats a missing flag as not blocked", () => {
    expect(locationOptionLabel({ warehouseName: "H", name: "A1" })).toBe("H — A1");
  });

  it("adds inaktiv only when asked for", () => {
    const inactive = { ...open, active: false };
    expect(locationOptionLabel(inactive)).toBe("Huvudlager — A1");
    expect(locationOptionLabel(inactive, { inactive: true })).toBe("Huvudlager — A1 (inaktiv)");
    expect(locationOptionLabel({ ...blocked, active: false }, { inactive: true })).toBe(
      "Huvudlager — K1 (spärrad, inaktiv)"
    );
  });

  it("leaves blocked locations out of pure outflow choices", () => {
    expect(outflowLocationChoices([open, blocked])).toEqual([open]);
  });

  it("keeps a blocked current value in a field picker", () => {
    expect(withCurrentLocation([open, blocked], null)).toEqual([open]);
    expect(withCurrentLocation([open, blocked], "b")).toEqual([open, blocked]);
  });
});
