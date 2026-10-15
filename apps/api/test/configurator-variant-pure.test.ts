// apps/api/test/configurator-variant-pure.test.ts
import { describe, expect, it } from "vitest";
import type { ConfiguratorSelection, VariantSelectionEntry } from "@navet/shared";
import type { EffectiveValue, EngineGroup, EngineTemplate } from "../src/modules/configurator/service/configurator-engine.js";
import type { DerivedMaterialCore, DerivedOperationCore } from "../src/modules/configurator/service/configurator-derive.js";
import {
  MAX_VARIANT_COMBINATIONS, TooManyCombinationsError, VariantSetError, expandCombinations,
} from "../src/modules/configurator/service/variant-expand.js";
import {
  ARTICLE_NAME_MAX, ARTICLE_NUMBER_MAX, selectionEntries, selectionFromEntries, svNumber, variantArticleFields, variantIdentity,
} from "../src/modules/configurator/service/variant-identity.js";
import {
  mergeVariantMaterials, variantRoutingRows, type TemplateRoutingRow,
} from "../src/modules/configurator/service/variant-structure.js";

const id = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

function choice(code: string, name: string, values: [string, string][], extra: Partial<EngineGroup> = {}): EngineGroup {
  return {
    id: id(code), code, name, kind: "choice", required: false, sortOrder: 1,
    priceAdd: 0, defaultValueId: null, unit: null, minValue: null, maxValue: null, step: null, defaultNumber: null,
    pricePerUnit: 0, priceBaseValue: 0,
    values: values.map(([c, n], i) => ({ id: id(`${code}${c}`), code: c, name: n, priceAdd: 0, sortOrder: i, active: true, articleId: null })),
    ...extra,
  };
}

// LOCK (Lås) A/B · FARG (Färg) RD/BL default RD · HJUL boolean · BREDD number 500–2000 mm · TILL optional choice, no default
const LOCK = choice("LOCK", "Lås", [["A", "A"], ["B", "B"]], { sortOrder: 1, required: true });
const FARG = choice("FARG", "Färg", [["RD", "Röd"], ["BL", "Blå"]], { sortOrder: 2, defaultValueId: id("FARGRD") });
const HJUL: EngineGroup = { ...choice("HJUL", "Hjul", []), kind: "boolean", sortOrder: 3 };
const BREDD: EngineGroup = { ...choice("BREDD", "Bredd", []), kind: "number", unit: "mm", minValue: 500, maxValue: 2000, sortOrder: 4 };
const TILL = choice("TILL", "Tillval", [["X", "Extra"]], { sortOrder: 5 });
const template: EngineTemplate = { groups: [TILL, BREDD, HJUL, FARG, LOCK], rules: [], basePrice: 1000 }; // deliberately unsorted

const ARTICLE = { articleNumber: "63000", name: "Papperskorg 50 l" };

const eff = (value: string | boolean | number | null, valueId: string | null = null): EffectiveValue => ({ value, valueId, defaulted: false });
function effective(parts: {
  lock?: "A" | "B" | null; farg?: "RD" | "BL" | null; hjul?: boolean; bredd?: number | null; till?: "X" | null;
}): Map<string, EffectiveValue> {
  const m = new Map<string, EffectiveValue>();
  const lock = parts.lock ?? null;
  const farg = parts.farg ?? null;
  const till = parts.till ?? null;
  m.set(id("LOCK"), eff(lock, lock ? id(`LOCK${lock}`) : null));
  m.set(id("FARG"), eff(farg, farg ? id(`FARG${farg}`) : null));
  m.set(id("HJUL"), eff(parts.hjul ?? false));
  m.set(id("BREDD"), eff(parts.bredd ?? null));
  m.set(id("TILL"), eff(till, till ? id(`TILL${till}`) : null));
  return m;
}

describe("expandCombinations", () => {
  it("builds the Cartesian product in group order (sortOrder), values in the given order", () => {
    const combos = expandCombinations(template, { LOCK: ["A", "B"], FARG: ["RD", "BL"] });
    expect(combos).toEqual<ConfiguratorSelection[]>([
      { LOCK: "A", FARG: "RD" }, { LOCK: "A", FARG: "BL" }, { LOCK: "B", FARG: "RD" }, { LOCK: "B", FARG: "BL" },
    ]);
  });

  it("orders by group sortOrder even when sets are given in another order", () => {
    const combos = expandCombinations(template, { FARG: ["RD", "BL"], LOCK: ["A", "B"] });
    expect(combos.map((c) => `${c.LOCK}-${c.FARG}`)).toEqual(["A-RD", "A-BL", "B-RD", "B-BL"]);
  });

  it("leaves an omitted group out of every selection (the engine applies its default)", () => {
    const combos = expandCombinations(template, { LOCK: ["A", "B"] });
    expect(combos).toEqual([{ LOCK: "A" }, { LOCK: "B" }]);
    for (const c of combos) expect("FARG" in c).toBe(false);
  });

  it("expands booleans and numbers", () => {
    expect(expandCombinations(template, { HJUL: [true, false] })).toEqual([{ HJUL: true }, { HJUL: false }]);
    expect(expandCombinations(template, { BREDD: [1200, 12.5] })).toEqual([{ BREDD: 1200 }, { BREDD: 12.5 }]);
  });

  it("returns one empty selection for empty sets", () => {
    expect(expandCombinations(template, {})).toEqual([{}]);
  });

  it("rejects an unknown group", () => {
    expect(() => expandCombinations(template, { XYZ: ["A"] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { XYZ: ["A"] })).toThrow("Valgruppen XYZ finns inte");
  });

  it("rejects an alternative that is not in the group, naming the group", () => {
    expect(() => expandCombinations(template, { LOCK: ["A", "Q"] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { LOCK: ["A", "Q"] })).toThrow("Alternativet Q finns inte i Lås");
  });

  it("rejects the wrong value type for the group kind", () => {
    expect(() => expandCombinations(template, { LOCK: [1, 2] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { HJUL: ["ja"] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { BREDD: ["1200"] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { BREDD: ["1200"] })).toThrow("Bredd");
  });

  it("rejects duplicate values and an empty set", () => {
    expect(() => expandCombinations(template, { LOCK: ["A", "A"] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { HJUL: [true, true] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { BREDD: [1200, 1200] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { LOCK: [] })).toThrow(VariantSetError);
  });

  it("reads a boolean set's null as false (the engine's reading), so [false, null] is a duplicate", () => {
    expect(() => expandCombinations(template, { HJUL: [false, null] })).toThrow("Hjul har samma värde flera gånger");
    expect(expandCombinations(template, { HJUL: [null] })).toEqual([{ HJUL: false }]);
    // A choice/number null stays the engine's "deliberately empty".
    expect(expandCombinations(template, { LOCK: [null] })).toEqual([{ LOCK: null }]);
  });

  it("stops above the cap and reports the real count", () => {
    expect(MAX_VARIANT_COMBINATIONS).toBe(200);
    const widths = Array.from({ length: 15 }, (_, i) => 500 + i * 100);
    const big = choice("STOR", "Storlek", Array.from({ length: 14 }, (_, i) => [`S${i}`, `S${i}`] as [string, string]), { sortOrder: 6 });
    const t: EngineTemplate = { ...template, groups: [...template.groups, big] };
    let caught: unknown;
    try { expandCombinations(t, { BREDD: widths, STOR: big.values.map((v) => v.code) }); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(TooManyCombinationsError);
    expect((caught as TooManyCombinationsError).count).toBe(210);
    // exactly the cap is allowed
    expect(expandCombinations(t, { BREDD: widths.slice(0, 10), STOR: big.values.map((v) => v.code) })).toHaveLength(140);
  });
});

describe("variantIdentity", () => {
  it("builds number and name from the groups in order", () => {
    const r = variantIdentity(template, ARTICLE, effective({ lock: "A", farg: "RD", hjul: true, bredd: 1200 }));
    expect(r.ok).toBe(true);
    expect(r.articleNumber).toBe("63000-A-RD-HJUL-1200");
    expect(r.name).toBe("Papperskorg 50 l, A, Röd, Hjul, Bredd 1200 mm");
  });

  it("writes measures with a decimal comma", () => {
    expect(svNumber(12.5)).toBe("12,5");
    expect(svNumber(1200)).toBe("1200");
    expect(svNumber(1.00001)).toBe("1");
    const r = variantIdentity(template, ARTICLE, effective({ lock: "B", farg: "BL", bredd: 12.5 }));
    expect(r.articleNumber).toBe("63000-B-BL-12,5");
    expect(r.name).toBe("Papperskorg 50 l, B, Blå, Bredd 12,5 mm");
  });

  it("omits a measure's unit when the group has none", () => {
    const t: EngineTemplate = { ...template, groups: template.groups.map((g) => (g.code === "BREDD" ? { ...g, unit: null } : g)) };
    const r = variantIdentity(t, ARTICLE, effective({ lock: "A", bredd: 700 }));
    expect(r.name).toBe("Papperskorg 50 l, A, Bredd 700");
  });

  it("adds nothing for false booleans and empty groups", () => {
    const r = variantIdentity(template, ARTICLE, effective({ lock: "A", farg: null, hjul: false, bredd: null, till: null }));
    expect(r.articleNumber).toBe("63000-A");
    expect(r.name).toBe("Papperskorg 50 l, A");
  });

  it("returns one selection entry per group in group order, including empty ones", () => {
    const r = variantIdentity(template, ARTICLE, effective({ lock: "A", farg: "RD", hjul: true, bredd: 1200 }));
    expect(r.selection).toEqual([
      { groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: "A", valueName: "A", value: "A", unit: null },
      { groupCode: "FARG", groupName: "Färg", kind: "choice", valueCode: "RD", valueName: "Röd", value: "RD", unit: null },
      { groupCode: "HJUL", groupName: "Hjul", kind: "boolean", valueCode: null, valueName: null, value: true, unit: null },
      { groupCode: "BREDD", groupName: "Bredd", kind: "number", valueCode: null, valueName: null, value: 1200, unit: "mm" },
      { groupCode: "TILL", groupName: "Tillval", kind: "choice", valueCode: null, valueName: null, value: null, unit: null },
    ]);
    const empty = variantIdentity(template, ARTICLE, effective({ lock: null, hjul: false }));
    expect(empty.selection.map((e) => e.value)).toEqual([null, null, false, null, null]);
  });

  it("rejects a number longer than 50 characters", () => {
    expect(ARTICLE_NUMBER_MAX).toBe(50);
    // "63000" + "-A" + "-RD" + "-HJUL" = 15 chars; a 36-char width part would hit 51 — use a long template number instead
    const forty = { articleNumber: "6".repeat(40), name: "Kort" }; // 40 + "-A-RD-HJUL" (10) = 50 → ok
    const ok = variantIdentity(template, forty, effective({ lock: "A", farg: "RD", hjul: true }));
    expect(ok.ok).toBe(true);
    expect(ok.articleNumber).toHaveLength(50);
    const r = variantIdentity(template, { ...forty, articleNumber: "6".repeat(41) }, effective({ lock: "A", farg: "RD", hjul: true }));
    expect(r.ok).toBe(false);
    expect(r.articleNumber).toHaveLength(51);
    if (!r.ok) expect(r.error).toBe("Artikelnumret blir längre än 50 tecken");
    expect(r.selection).toHaveLength(5);
  });

  it("rejects a name longer than 255 characters, number error first", () => {
    expect(ARTICLE_NAME_MAX).toBe(255);
    // "<name>, A, Röd" → name part adds 8 chars
    const ok = variantIdentity(template, { articleNumber: "63000", name: "N".repeat(247) }, effective({ lock: "A", farg: "RD" }));
    expect(ok.ok).toBe(true);
    expect(ok.name).toHaveLength(255);
    const r = variantIdentity(template, { articleNumber: "63000", name: "N".repeat(248) }, effective({ lock: "A", farg: "RD" }));
    expect(r.ok).toBe(false);
    expect(r.name).toHaveLength(256);
    if (!r.ok) expect(r.error).toBe("Benämningen blir längre än 255 tecken");
    const both = variantIdentity(template, { articleNumber: "6".repeat(60), name: "N".repeat(300) }, effective({ lock: "A" }));
    if (both.ok) throw new Error("expected failure");
    expect(both.error).toBe("Artikelnumret blir längre än 50 tecken");
  });

  it("selectionEntries is what variantIdentity stores, one entry per group in group order", () => {
    const t: EngineTemplate = {
      groups: [
        choice("LOCK", "Lås", [["A", "Lås A"], ["B", "Lås B"]], { sortOrder: 2 }),
        { ...choice("BREDD", "Bredd", []), kind: "number", unit: "mm", sortOrder: 1 },
      ],
      rules: [], basePrice: 1000,
    };
    const eff2 = new Map<string, EffectiveValue>([
      [id("LOCK"), { value: "B", valueId: id("LOCKB"), defaulted: false }],
      [id("BREDD"), { value: 1200, valueId: null, defaulted: false }],
    ]);
    const entries = selectionEntries(t, eff2);
    expect(entries.map((e) => e.groupCode)).toEqual(["BREDD", "LOCK"]);
    expect(entries).toEqual<VariantSelectionEntry[]>([
      { groupCode: "BREDD", groupName: "Bredd", kind: "number", valueCode: null, valueName: null, value: 1200, unit: "mm" },
      { groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: "B", valueName: "Lås B", value: "B", unit: null },
    ]);
    expect(variantIdentity(t, { articleNumber: "63000", name: "Korg" }, eff2)).toMatchObject({
      ok: true, articleNumber: "63000-1200-B", name: "Korg, Bredd 1200 mm, Lås B", selection: entries,
    });
  });
});

describe("expandCombinations with null (delprojekt 5)", () => {
  it("passes null through as a cleared value for a choice and a measure", () => {
    expect(expandCombinations(template, { LOCK: ["A"], FARG: [null], BREDD: [null] })).toEqual([{ LOCK: "A", FARG: null, BREDD: null }]);
  });
  it("still rejects a duplicate null and a wrong type", () => {
    expect(() => expandCombinations(template, { FARG: [null, null] })).toThrow(VariantSetError);
    expect(() => expandCombinations(template, { FARG: [1] as never })).toThrow(VariantSetError);
  });
});

describe("variantArticleFields", () => {
  const groups = (field: "colour" | "surface_treatment" | null) => [
    { id: id("LOCK"), articleField: null, values: LOCK.values },
    { id: id("FARG"), articleField: field, values: FARG.values },
  ];

  it("takes the chosen alternative's name for a coupled group", () => {
    expect(variantArticleFields(groups("colour"), effective({ farg: "RD" }))).toEqual({ colour: "Röd" });
    expect(variantArticleFields(groups("surface_treatment"), effective({ farg: "BL" }))).toEqual({ surfaceTreatment: "Blå" });
  });

  it("returns no keys when no group is coupled", () => {
    expect(variantArticleFields(groups(null), effective({ farg: "RD" }))).toEqual({});
  });

  it("returns null for a coupled group without a value", () => {
    expect(variantArticleFields(groups("colour"), effective({ farg: null }))).toEqual({ colour: null });
  });
});

const ART = { plat: id("A1"), skruv: id("A2"), hjul: id("A5") };
const labels = new Map([[ART.plat, "1001 Plåt"], [ART.skruv, "1002 Skruv"], [ART.hjul, "1005 Hjul"]]);
const label = (articleId: string) => labels.get(articleId) ?? articleId;

function material(m: Partial<DerivedMaterialCore> & Pick<DerivedMaterialCore, "componentArticleId" | "quantity">): DerivedMaterialCore {
  return { source: "line", lineId: id("L1"), baseRowId: null, unitId: null, unitFactor: null, operation: null, ...m };
}
const op = (sequenceNo: number) => ({ kind: "base" as const, id: id(`O${sequenceNo}`), sequenceNo });

describe("mergeVariantMaterials", () => {
  it("merges rows of the same component, summing quantities and keeping a shared operation", () => {
    const r = mergeVariantMaterials([
      material({ componentArticleId: ART.plat, quantity: 2.5, operation: op(10) }),
      material({ componentArticleId: ART.skruv, quantity: 8 }),
      material({ componentArticleId: ART.plat, quantity: 1.00007, operation: op(10) }),
    ], label);
    expect(r.warnings).toEqual([]);
    expect(r.rows).toEqual([
      { componentArticleId: ART.plat, quantity: 3.5001, unitId: null, unitFactor: null, operationSequenceNo: 10 },
      { componentArticleId: ART.skruv, quantity: 8, unitId: null, unitFactor: null, operationSequenceNo: null },
    ]);
  });

  it("keeps a shared null operation without a warning", () => {
    const r = mergeVariantMaterials([
      material({ componentArticleId: ART.skruv, quantity: 4 }),
      material({ componentArticleId: ART.skruv, quantity: 4 }),
    ], label);
    expect(r.rows).toEqual([{ componentArticleId: ART.skruv, quantity: 8, unitId: null, unitFactor: null, operationSequenceNo: null }]);
    expect(r.warnings).toEqual([]);
  });

  it("takes the lowest operation and warns when the rows differ", () => {
    const r = mergeVariantMaterials([
      material({ componentArticleId: ART.plat, quantity: 1, operation: op(30) }),
      material({ componentArticleId: ART.plat, quantity: 1, operation: op(10) }),
    ], label);
    expect(r.rows[0]!.operationSequenceNo).toBe(10);
    expect(r.warnings).toEqual(["Komponent 1001 Plåt kopplad till flera operationer — dras i operation 10"]);
  });

  it("treats null and a number as different operations", () => {
    const r = mergeVariantMaterials([
      material({ componentArticleId: ART.hjul, quantity: 2 }),
      material({ componentArticleId: ART.hjul, quantity: 2, operation: op(20) }),
    ], label);
    expect(r.rows[0]!.operationSequenceNo).toBe(20);
    expect(r.warnings).toEqual(["Komponent 1005 Hjul kopplad till flera operationer — dras i operation 20"]);
  });

  it("keeps the display unit of a single row and of rows that agree", () => {
    const one = mergeVariantMaterials([material({ componentArticleId: ART.plat, quantity: 2, unitId: id("KG"), unitFactor: "0.5" })], label);
    expect(one.rows[0]).toMatchObject({ unitId: id("KG"), unitFactor: "0.5" });
    const same = mergeVariantMaterials([
      material({ componentArticleId: ART.plat, quantity: 2, unitId: id("KG"), unitFactor: "0.5" }),
      material({ componentArticleId: ART.plat, quantity: 3, unitId: id("KG"), unitFactor: "0.5" }),
    ], label);
    expect(same.rows[0]).toMatchObject({ quantity: 5, unitId: id("KG"), unitFactor: "0.5" });
  });

  it("falls back to the base unit when the rows' units differ", () => {
    const r = mergeVariantMaterials([
      material({ componentArticleId: ART.plat, quantity: 2, unitId: id("KG"), unitFactor: "0.5" }),
      material({ componentArticleId: ART.plat, quantity: 3 }),
    ], label);
    expect(r.rows[0]).toMatchObject({ quantity: 5, unitId: null, unitFactor: null });
    const factor = mergeVariantMaterials([
      material({ componentArticleId: ART.plat, quantity: 2, unitId: id("KG"), unitFactor: "0.5" }),
      material({ componentArticleId: ART.plat, quantity: 3, unitId: id("KG"), unitFactor: "0.25" }),
    ], label);
    expect(factor.rows[0]).toMatchObject({ unitId: null, unitFactor: null });
  });
});

describe("variantRoutingRows", () => {
  const W = { press: id("W1"), lego: id("W2") };
  const workCenters = new Map([
    [W.press, { type: "machine", supplierId: null }],
    [W.lego, { type: "subcontract", supplierId: id("S1") }],
  ]);
  const templateRow: TemplateRoutingRow = {
    id: id("O10"), articleId: id("T"), sequenceNo: 10, workCenterId: W.press, description: "Klipp", setupTime: "15", runTimePerUnit: "2",
    timeUnit: "units_per_hour", costingOnly: true, comment: "Se ritning", printOnWorkCard: true, packingInstructions: null,
    subcontractSupplierId: null, setupPrice: null, unitPrice: null, showNetWeight: true, useArticleDrawing: false,
  };
  const derived = (o: Partial<DerivedOperationCore> & Pick<DerivedOperationCore, "kind" | "id" | "sequenceNo" | "workCenterId">): DerivedOperationCore => ({
    description: null, setupTime: 0, runTimePerUnit: 0, costingOnly: false, setupPrice: null, unitPrice: null, ...o,
  });

  it("copies the template row for a base operation and takes the derived times", () => {
    const rows = variantRoutingRows(
      [derived({ kind: "base", id: id("O10"), sequenceNo: 10, workCenterId: W.press, description: "Klipp", setupTime: 15, runTimePerUnit: 2, costingOnly: true })],
      new Map([[id("O10"), templateRow]]),
      workCenters
    );
    expect(rows).toEqual([{
      sequenceNo: 10, workCenterId: W.press, description: "Klipp", setupTime: 15, runTimePerUnit: 2, costingOnly: true,
      setupPrice: null, unitPrice: null, subcontractSupplierId: null, copyFrom: templateRow,
    }]);
  });

  it("gives a conditional subcontract operation the resource's supplier and keeps its prices", () => {
    const rows = variantRoutingRows(
      [derived({ kind: "configurator", id: id("C1"), sequenceNo: 25, workCenterId: W.lego, description: "Lackering", setupTime: 0, runTimePerUnit: 5, setupPrice: 200, unitPrice: 12.5 })],
      new Map(),
      workCenters
    );
    expect(rows).toEqual([{
      sequenceNo: 25, workCenterId: W.lego, description: "Lackering", setupTime: 0, runTimePerUnit: 5, costingOnly: false,
      setupPrice: 200, unitPrice: 12.5, subcontractSupplierId: id("S1"), copyFrom: null,
    }]);
  });

  it("leaves subcontractSupplierId null for a conditional machine operation", () => {
    const rows = variantRoutingRows(
      [derived({ kind: "configurator", id: id("C2"), sequenceNo: 15, workCenterId: W.press, setupTime: 3, runTimePerUnit: 1 })],
      new Map(),
      workCenters
    );
    expect(rows[0]).toMatchObject({ subcontractSupplierId: null, copyFrom: null, costingOnly: false });
  });

  it("sorts by sequence number", () => {
    const rows = variantRoutingRows(
      [
        derived({ kind: "configurator", id: id("C1"), sequenceNo: 25, workCenterId: W.lego }),
        derived({ kind: "base", id: id("O10"), sequenceNo: 10, workCenterId: W.press }),
        derived({ kind: "configurator", id: id("C2"), sequenceNo: 15, workCenterId: W.press }),
      ],
      new Map([[id("O10"), templateRow]]),
      workCenters
    );
    expect(rows.map((r) => r.sequenceNo)).toEqual([10, 15, 25]);
  });

  it("refuses a base operation whose template row is missing", () => {
    expect(() => variantRoutingRows(
      [derived({ kind: "base", id: id("O99"), sequenceNo: 99, workCenterId: W.press })],
      new Map(),
      workCenters
    )).toThrow(/O99|99/);
  });
});

describe("selectionFromEntries", () => {
  // Delprojekt 5: an empty entry is written as null ("deliberately empty"),
  // no longer skipped — otherwise a default added to the template later would
  // come back when a saved row/variant is re-evaluated.
  it("maps stored entries back to the engine selection, null for an empty one", () => {
    const entries: VariantSelectionEntry[] = [
      { groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: "B", valueName: "Lås B", value: "B", unit: null },
      { groupCode: "FARG", groupName: "Färg", kind: "choice", valueCode: null, valueName: null, value: null, unit: null },
      { groupCode: "EXTRA", groupName: "Extra", kind: "boolean", valueCode: null, valueName: null, value: false, unit: null },
      { groupCode: "BREDD", groupName: "Bredd", kind: "number", valueCode: null, valueName: null, value: 1200, unit: "mm" },
    ];
    expect(selectionFromEntries(entries)).toEqual({ LOCK: "B", FARG: null, EXTRA: false, BREDD: 1200 });
  });

  it("selectionFromEntries skriver null för en tom post", () => {
    expect(selectionFromEntries([
      { groupCode: "LOCK", groupName: "Lås", kind: "choice", valueCode: null, valueName: null, value: null, unit: null },
      { groupCode: "BREDD", groupName: "Bredd", kind: "number", valueCode: null, valueName: null, value: 1200, unit: "mm" },
    ])).toEqual({ LOCK: null, BREDD: 1200 });
  });

  it("round-trips the engine's entries: a cleared group comes back as null, never as the default", () => {
    const entries = selectionEntries(template, effective({ lock: "A", farg: null, hjul: false, bredd: 1200, till: null }));
    expect(selectionFromEntries(entries)).toEqual({ LOCK: "A", FARG: null, HJUL: false, BREDD: 1200, TILL: null });
  });
});
