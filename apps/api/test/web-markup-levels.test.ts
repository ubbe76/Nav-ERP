import { describe, expect, it } from "vitest";
import { groupMarkupsText, markupLabel } from "../../web/lib/markupLevels";
import { chainLines } from "../../web/lib/costChain";

describe("markup levels (web)", () => {
  it("labels a markup with its percent and level", () => {
    expect(markupLabel("Generellt påslag", "25.00", "company")).toBe("Generellt påslag 25 % (företaget)");
    expect(markupLabel("Materialpåslag", "0.00", "trial")).toBe("Materialpåslag 0 % (prövat)");
    expect(markupLabel("Generellt påslag", "40.50", "group")).toBe("Generellt påslag 40,5 % (varugruppen)");
    expect(markupLabel("Generellt påslag", undefined, undefined)).toBe("Generellt påslag");
  });

  it("shows the group's own markups with a dash for inherited", () => {
    expect(groupMarkupsText("40.00", null)).toBe("40 % / —");
    expect(groupMarkupsText(null, null)).toBe("— / —");
    expect(groupMarkupsText("0.00", "10.00")).toBe("0 % / 10 %");
  });

  it("puts the level in the chain labels only when the calculation carries it", () => {
    const base = {
      materialCost: "100", materialOverhead: "0", laborCost: "0", overhead: "0", subcontractCost: "0",
      subcontractOverhead: "0", semiFinishedCost: "0", businessOverhead: "0", generalMarkup: "25",
      materialMarkup: "10", salesPrice: "135",
    };
    const plain = chainLines(base).map((l) => l.label);
    expect(plain).toContain("Generellt påslag");
    const levelled = chainLines({
      ...base, generalMarkupPercent: "25", generalMarkupLevel: "group", materialMarkupPercent: "10", materialMarkupLevel: "trial",
    }).map((l) => l.label);
    expect(levelled).toContain("Generellt påslag 25 % (varugruppen)");
    expect(levelled).toContain("Materialpåslag 10 % (prövat)");
  });
});
