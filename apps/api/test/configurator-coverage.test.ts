// apps/api/test/configurator-coverage.test.ts
import { describe, expect, it } from "vitest";
import type { ConfiguratorCondition } from "@navet/shared";
import type { EngineGroup } from "../src/modules/configurator/service/configurator-engine.js";
import type { DeriveBomLine } from "../src/modules/configurator/service/configurator-derive.js";
import {
  coverageWarnings, findCoverageGaps,
} from "../src/modules/configurator/service/structure-coverage.js";

const id = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

function choice(code: string, name: string, values: [string, string, boolean?][]): EngineGroup {
  return {
    id: id(code), code, name, kind: "choice", required: true, sortOrder: 1,
    priceAdd: 0, defaultValueId: null, unit: null, minValue: null, maxValue: null, step: null, defaultNumber: null,
    pricePerUnit: 0, priceBaseValue: 0,
    values: values.map(([c, n, active], i) => ({ id: id(`${code}${c}`), code: c, name: n, priceAdd: 0, sortOrder: i, active: active ?? true, articleId: null })),
  };
}
const farg = (extra: [string, string, boolean?][] = []) =>
  choice("F", "Färg", [["SV", "Svart"], ["SI", "Silver"], ["GR", "Grön"], ...extra]);
const lock = () => choice("L", "Typ av lock", [["LOCK", "Lock"], ["INKAST", "Inkastlock"]]);

const is = (group: string, ...codes: string[]): ConfiguratorCondition => ({ groupId: id(group), op: "is", valueIds: codes.map((c) => id(`${group}${c}`)) });

let seq = 0;
function line(conditions: ConfiguratorCondition[]): DeriveBomLine {
  seq++;
  return {
    id: id(`LN${seq}`), sortOrder: seq, conditions, source: "article", componentArticleId: id(`A${seq}`), componentGroupId: null,
    quantity: 1, quantityFormula: null, routingOperationId: null, configuratorOperationId: null, label: `Strukturrad ${seq} (Del)`,
  };
}

// The 63000 shape: a painted lid per colour (only with a lid), a painted body per colour.
function paintedLines(colours: string[]) {
  return [
    ...colours.map((c) => line([is("L", "LOCK"), is("F", c)])),
    ...colours.map((c) => line([is("F", c)])),
  ];
}

describe("findCoverageGaps", () => {
  it("finds nothing when every colour has its lid and body line", () => {
    seq = 0;
    expect(findCoverageGaps([farg(), lock()], paintedLines(["SV", "SI", "GR"]))).toEqual([]);
  });

  it("reports a new colour missing from both the lid family and the body family", () => {
    seq = 0;
    const gaps = findCoverageGaps([farg([["BL", "Blå"]]), lock()], paintedLines(["SV", "SI", "GR"]));
    expect(gaps).toEqual([
      { groupId: id("F"), missingValueIds: [id("FBL")], context: [is("L", "LOCK")], lineNumbers: [1, 2, 3] },
      { groupId: id("F"), missingValueIds: [id("FBL")], context: [], lineNumbers: [4, 5, 6] },
    ]);
  });

  it("reports only the family the new colour is missing from", () => {
    seq = 0;
    const lines = [...paintedLines(["SV", "SI", "GR"]), line([is("F", "BL")])];
    const gaps = findCoverageGaps([farg([["BL", "Blå"]]), lock()], lines);
    expect(gaps.map((g) => g.lineNumbers)).toEqual([[1, 2, 3]]);
  });

  it("ignores inactive alternatives", () => {
    seq = 0;
    expect(findCoverageGaps([farg([["BL", "Blå", false]]), lock()], paintedLines(["SV", "SI", "GR"]))).toEqual([]);
  });

  it("does not treat a single conditional line as a family", () => {
    seq = 0;
    expect(findCoverageGaps([farg(), lock()], [line([is("F", "SV")])])).toEqual([]);
  });

  it("counts every value a line lists", () => {
    seq = 0;
    const lines = [line([is("F", "SV", "SI")]), line([is("F", "GR")])];
    expect(findCoverageGaps([farg(), lock()], lines)).toEqual([]);
  });

  it("keeps families with different contexts apart", () => {
    seq = 0;
    // Lid lines per colour exist only for LOCK; INKAST lines cover two colours — the inkast family misses GR.
    const lines = [
      ...["SV", "SI", "GR"].map((c) => line([is("L", "LOCK"), is("F", c)])),
      ...["SV", "SI"].map((c) => line([is("L", "INKAST"), is("F", c)])),
    ];
    const gaps = findCoverageGaps([farg(), lock()], lines);
    expect(gaps).toEqual([
      { groupId: id("F"), missingValueIds: [id("FGR")], context: [is("L", "INKAST")], lineNumbers: [4, 5] },
    ]);
  });

  it("numbers lines by sort order, like the Strukturrad labels", () => {
    seq = 0;
    const lines = paintedLines(["SV", "SI"]).reverse();
    const gaps = findCoverageGaps([farg(), lock()], lines);
    expect(gaps.map((g) => g.lineNumbers)).toEqual([[1, 2], [3, 4]]);
  });
});

describe("coverageWarnings", () => {
  it("names the group, the missing alternative, the context and the lines", () => {
    seq = 0;
    const groups = [farg([["BL", "Blå"]]), lock()];
    expect(coverageWarnings(groups, findCoverageGaps(groups, paintedLines(["SV", "SI", "GR"])))).toEqual([
      "Färg: alternativet Blå saknar strukturrad om Typ av lock är Lock — strukturrad 1, 2 och 3 täcker de övriga alternativen",
      "Färg: alternativet Blå saknar strukturrad — strukturrad 4, 5 och 6 täcker de övriga alternativen",
    ]);
  });

  it("lists several missing alternatives in one warning", () => {
    seq = 0;
    const groups = [farg([["BL", "Blå"], ["GU", "Gul"]]), lock()];
    const lines = [line([is("F", "SV")]), line([is("F", "SI")])];
    expect(coverageWarnings(groups, findCoverageGaps(groups, lines))).toEqual([
      "Färg: alternativen Grön, Blå och Gul saknar strukturrad — strukturrad 1 och 2 täcker de övriga alternativen",
    ]);
  });
});
