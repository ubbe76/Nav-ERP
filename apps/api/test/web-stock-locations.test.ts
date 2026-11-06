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

import { articleLocationRole, moveInList, ownPrimaryLocationId } from "../../web/lib/stockLocations.js";

describe("web stockLocations: alternative order", () => {
  it("moves an item up or down and ignores the ends", () => {
    expect(moveInList(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveInList(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveInList(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveInList(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });

  it("names a location's role in the Plats column", () => {
    expect(articleLocationRole("p", "p", ["x"])).toBe("Huvudplats");
    expect(articleLocationRole("y", "p", ["x", "y"])).toBe("Alternativ 2");
    expect(articleLocationRole("z", "p", ["x"])).toBe("–");
    expect(articleLocationRole(null, "p", [])).toBe("–");
  });

  it("treats the *** reserve as huvudplats as no huvudplats of the article's own", () => {
    expect(ownPrimaryLocationId({ locationId: "p", name: "A1" })).toBe("p");
    expect(ownPrimaryLocationId({ locationId: "r", name: "***" })).toBeNull();
    expect(ownPrimaryLocationId(null)).toBeNull();
    expect(articleLocationRole("r", ownPrimaryLocationId({ locationId: "r", name: "***" }), ["x"])).toBe("–");
  });
});
