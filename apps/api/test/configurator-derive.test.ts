// apps/api/test/configurator-derive.test.ts
import { describe, expect, it } from "vitest";
import type { ConfiguratorCondition, ConfiguratorSelection } from "@navet/shared";
import {
  evaluateConfiguration, resolveConfiguration,
  type EngineGroup, type EngineRule, type EngineTemplate,
} from "../src/modules/configurator/service/configurator-engine.js";
import {
  deriveStructure,
  type BaseBomRow, type BaseOperation, type DeriveBomLine, type DeriveOperation,
} from "../src/modules/configurator/service/configurator-derive.js";

const id = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

function choice(code: string, values: [string, string | null][], extra: Partial<EngineGroup> = {}): EngineGroup {
  return {
    id: id(code), code, name: code.charAt(0) + code.slice(1).toLowerCase(), kind: "choice", required: false, sortOrder: 1,
    priceAdd: 0, defaultValueId: null, unit: null, minValue: null, maxValue: null, step: null, defaultNumber: null,
    pricePerUnit: 0, priceBaseValue: 0,
    values: values.map(([c, articleId], i) => ({ id: id(`${code}${c}`), code: c, name: c, priceAdd: 0, sortOrder: i, active: true, articleId })),
    ...extra,
  };
}
function bool(code: string): EngineGroup {
  return { ...choice(code, []), kind: "boolean", sortOrder: 2 };
}
function num(code: string, min: number, max: number, extra: Partial<EngineGroup> = {}): EngineGroup {
  return { ...choice(code, []), kind: "number", unit: "mm", minValue: min, maxValue: max, sortOrder: 3, ...extra };
}
function rule(r: Partial<EngineRule> & Pick<EngineRule, "effect" | "conditions" | "target" | "message">): EngineRule {
  return { id: id("R" + r.message.length), sortOrder: 1, active: true, ...r };
}

const ART = { plat: id("A1"), skruv: id("A2"), lockA: id("A3"), lockB: id("A4"), hjul: id("A5"), list: id("A6") };
const lock = () => choice("LOCK", [["A", ART.lockA], ["B", ART.lockB], ["C", null]]);
const hjul = () => bool("HJUL");
const bredd = () => num("BREDD", 800, 3000, { name: "Bredd" });
const groups = () => [lock(), hjul(), bredd()];
const tpl = (g: EngineGroup[] = groups(), rules: EngineRule[] = []): EngineTemplate => ({ groups: g, rules, basePrice: 1000 });

const isLock = (code: string): ConfiguratorCondition => ({ groupId: id("LOCK"), op: "is", valueIds: [id(`LOCK${code}`)] });
const hjulSelected: ConfiguratorCondition = { groupId: id("HJUL"), op: "selected" };

const BASE_OPS: BaseOperation[] = [
  { id: id("O10"), sequenceNo: 10, workCenterId: id("W1"), description: "Klipp", setupTime: 15, runTimePerUnit: 2, costingOnly: false },
  { id: id("O30"), sequenceNo: 30, workCenterId: id("W2"), description: "Bocka", setupTime: 10, runTimePerUnit: 1.5, costingOnly: false },
];
const BASE_BOM: BaseBomRow[] = [
  { id: id("B1"), componentArticleId: ART.plat, quantity: 2.5, unitId: id("U1"), unitFactor: "0.5", routingOperationId: id("O10") },
  { id: id("B2"), componentArticleId: ART.skruv, quantity: 8, unitId: null, unitFactor: null, routingOperationId: null },
];

let lineSeq = 0;
function line(l: Partial<DeriveBomLine>): DeriveBomLine {
  lineSeq++;
  return {
    id: id(`L${lineSeq}`), sortOrder: lineSeq, conditions: [], source: "article", componentArticleId: ART.hjul, componentGroupId: null,
    quantity: 1, quantityFormula: null, routingOperationId: null, configuratorOperationId: null, label: `Strukturrad ${lineSeq} (Hjul)`,
    ...l,
  };
}
function op(o: Partial<DeriveOperation> & Pick<DeriveOperation, "sequenceNo">): DeriveOperation {
  return {
    id: id(`C${o.sequenceNo}`), conditions: [], workCenterId: id("W3"), description: null,
    setupTime: 5, setupFormula: null, runTimePerUnit: 1, runFormula: null, ...o,
  };
}

function derive(
  selection: ConfiguratorSelection,
  parts: { lines?: DeriveBomLine[]; operations?: DeriveOperation[]; baseBom?: BaseBomRow[]; baseOperations?: BaseOperation[]; template?: EngineTemplate } = {}
) {
  const template = parts.template ?? tpl();
  const { evaluation, effective } = resolveConfiguration(template, selection);
  return deriveStructure({
    template, evaluation, effective,
    baseBom: parts.baseBom ?? BASE_BOM, baseOperations: parts.baseOperations ?? BASE_OPS,
    lines: parts.lines ?? [], operations: parts.operations ?? [],
  });
}

describe("resolveConfiguration", () => {
  it("returns the effective values after pass A: an excluded default is null", () => {
    const l = lock();
    l.defaultValueId = l.values[1]!.id; // B
    const h = hjul();
    const g = [l, h, bredd()];
    const rules = [rule({ effect: "exclude", conditions: [hjulSelected], target: { groupId: l.id, valueIds: [l.values[1]!.id] }, message: "Inte B med hjul" })];
    const { evaluation, effective } = resolveConfiguration(tpl(g, rules), { HJUL: true, BREDD: 1200 });
    expect(effective.get(l.id)).toEqual({ value: null, valueId: null, defaulted: false });
    expect(effective.get(h.id)).toEqual({ value: true, valueId: null, defaulted: false });
    expect(effective.get(id("BREDD"))).toEqual({ value: 1200, valueId: null, defaulted: false });
    expect(evaluation.groups[0]!.value).toBeNull();
    // without the excluding condition the default stays
    const r2 = resolveConfiguration(tpl(g, rules), {});
    expect(r2.effective.get(l.id)).toEqual({ value: "B", valueId: l.values[1]!.id, defaulted: true });
  });

  it("evaluateConfiguration is identical to resolveConfiguration().evaluation for a complex case", () => {
    const l = lock();
    l.defaultValueId = l.values[0]!.id;
    l.required = true;
    const h = hjul();
    const b = bredd();
    b.step = 10;
    b.pricePerUnit = 0.5;
    b.priceBaseValue = 1000;
    const g = [l, h, b];
    const rules = [
      rule({ effect: "exclude", conditions: [hjulSelected], target: { groupId: l.id, valueIds: [l.values[0]!.id] }, message: "Inte A med hjul" }),
      rule({ effect: "limit", conditions: [isLock("B")], target: { groupId: b.id, max: 2000 }, message: "Max 2000 med lock B" }),
      rule({ effect: "require", conditions: [{ groupId: b.id, op: "gt", value: 1500 }], target: hjulSelected, message: "Hjul krävs över 1500" }),
    ];
    const customer = { unitPrice: 900, discountPercent: 5, source: "customer_article" as const };
    const selections: ConfiguratorSelection[] = [{ HJUL: true, BREDD: 1600 }, { LOCK: "B", BREDD: 2500 }, { LOCK: "A", BREDD: 1205 }, {}, { XYZ: 1 }];
    for (const sel of selections) {
      expect(evaluateConfiguration(tpl(g, rules), sel)).toEqual(resolveConfiguration(tpl(g, rules), sel).evaluation);
      expect(evaluateConfiguration(tpl(g, rules), sel, customer)).toEqual(resolveConfiguration(tpl(g, rules), sel, customer).evaluation);
    }
  });
});

describe("deriveStructure", () => {
  it("rule 1: an invalid configuration derives nothing", () => {
    const r = derive({ BREDD: 5000, LOCK: "A" }, { lines: [line({})], operations: [op({ sequenceNo: 40 })] });
    expect(r).toEqual({ derivable: false, materials: [], operations: [], errors: ["Konfigurationen är inte giltig"], warnings: [] });
  });

  it("costing-only base operations are included and flagged; configurator operations are never costing-only", () => {
    const baseOperations = [{ ...BASE_OPS[0]!, costingOnly: true }, BASE_OPS[1]!];
    const r = derive({ BREDD: 1500 }, { baseOperations, operations: [op({ sequenceNo: 50 })] });
    expect(r.derivable).toBe(true);
    expect(r.operations.map((o) => [o.sequenceNo, o.costingOnly])).toEqual([[10, true], [30, false], [50, false]]);
  });

  it("rule 2: base rows and operations follow unchanged (unit and link kept), operations sorted on sequenceNo", () => {
    const r = derive({ BREDD: 1200 }, { baseOperations: [BASE_OPS[1]!, BASE_OPS[0]!] });
    expect(r.derivable).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.materials).toEqual([
      { source: "base", lineId: null, baseRowId: id("B1"), componentArticleId: ART.plat, quantity: 2.5, unitId: id("U1"), unitFactor: "0.5", operation: { kind: "base", id: id("O10"), sequenceNo: 10 } },
      { source: "base", lineId: null, baseRowId: id("B2"), componentArticleId: ART.skruv, quantity: 8, unitId: null, unitFactor: null, operation: null },
    ]);
    expect(r.operations).toEqual([
      { kind: "base", id: id("O10"), sequenceNo: 10, workCenterId: id("W1"), description: "Klipp", setupTime: 15, runTimePerUnit: 2, costingOnly: false },
      { kind: "base", id: id("O30"), sequenceNo: 30, workCenterId: id("W2"), description: "Bocka", setupTime: 10, runTimePerUnit: 1.5, costingOnly: false },
    ]);
  });

  it("rule 3: a line is included only when all its conditions hold; lines after base rows in sortOrder", () => {
    const l1 = line({ sortOrder: 2, conditions: [hjulSelected], componentArticleId: ART.hjul, quantity: 4 });
    const l2 = line({ sortOrder: 1, conditions: [hjulSelected, isLock("A")], componentArticleId: ART.list, quantity: 1 });
    const l3 = line({ sortOrder: 3, conditions: [isLock("B")], componentArticleId: ART.list, quantity: 2 });
    const r = derive({ HJUL: true, LOCK: "A", BREDD: 1200 }, { lines: [l1, l2, l3] });
    expect(r.derivable).toBe(true);
    expect(r.materials.map((m) => [m.source, m.lineId, m.componentArticleId, m.quantity])).toEqual([
      ["base", null, ART.plat, 2.5],
      ["base", null, ART.skruv, 8],
      ["line", l2.id, ART.list, 1],
      ["line", l1.id, ART.hjul, 4],
    ]);
    expect(r.materials[2]).toMatchObject({ unitId: null, unitFactor: null, operation: null });
    const none = derive({ HJUL: false, BREDD: 1200 }, { lines: [l1, l2, l3] });
    expect(none.materials.map((m) => m.source)).toEqual(["base", "base"]);
  });

  it("rule 3: a group line takes the selected alternative's article", () => {
    const l = line({ source: "group", componentArticleId: null, componentGroupId: id("LOCK"), quantity: 1, label: "Strukturrad 1 (Lock)" });
    const r = derive({ LOCK: "B", BREDD: 1200 }, { lines: [l] });
    expect(r.derivable).toBe(true);
    expect(r.materials[2]).toEqual({ source: "line", lineId: l.id, baseRowId: null, componentArticleId: ART.lockB, quantity: 1, unitId: null, unitFactor: null, operation: null });
  });

  it("rule 3: a group without a selected alternative is an error", () => {
    const l = line({ source: "group", componentArticleId: null, componentGroupId: id("LOCK"), label: "Strukturrad 3 (Lock)" });
    const r = derive({ BREDD: 1200 }, { lines: [l] });
    expect(r.derivable).toBe(false);
    expect(r.errors).toEqual(["Strukturrad 3 (Lock): Lock saknar valt alternativ"]);
    expect(r.materials.map((m) => m.source)).toEqual(["base", "base"]);
  });

  it("rule 3: an alternative without an article is an error", () => {
    const l = line({ source: "group", componentArticleId: null, componentGroupId: id("LOCK"), label: "Strukturrad 3 (Lock)" });
    const r = derive({ LOCK: "C", BREDD: 1200 }, { lines: [l] });
    expect(r.derivable).toBe(false);
    expect(r.errors).toEqual(["Strukturrad 3 (Lock): alternativet C i Lock saknar artikel"]);
  });

  it("rule 3: a formula reads a measure (and a boolean, and a choice in om)", () => {
    const l = line({ quantity: null, quantityFormula: "bredd / 1000 * 2 + hjul", label: "Strukturrad 1 (Plåt)" });
    const l2 = line({ quantity: null, quantityFormula: 'om(LOCK = "A"; 2; 3)', label: "Strukturrad 2 (List)" });
    const r = derive({ BREDD: 1250, HJUL: true, LOCK: "B" }, { lines: [l, l2] });
    expect(r.derivable).toBe(true);
    expect(r.materials[2]!.quantity).toBe(3.5);
    expect(r.materials[3]!.quantity).toBe(3);
  });

  it("rule 3: a formula error is an error on the line", () => {
    const l = line({ quantity: null, quantityFormula: "bredd / (hjul)", label: "Strukturrad 2 (Plåt)" });
    const r = derive({ BREDD: 1250, HJUL: false }, { lines: [l] });
    expect(r.derivable).toBe(false);
    expect(r.errors).toEqual(["Strukturrad 2 (Plåt): Division med noll"]);
  });

  it("rule 3: a quantity ≤ 0 is an error", () => {
    const l = line({ quantity: null, quantityFormula: "bredd - 1300", label: "Strukturrad 4 (Plåt)" });
    const r = derive({ BREDD: 1200 }, { lines: [l] });
    expect(r.errors).toEqual(["Strukturrad 4 (Plåt): antalet blev -100 — använd ett villkor om raden inte ska ingå"]);
    const zero = derive({ BREDD: 1300 }, { lines: [l] });
    expect(zero.errors).toEqual(["Strukturrad 4 (Plåt): antalet blev 0 — använd ett villkor om raden inte ska ingå"]);
    const frac = derive({ BREDD: 1299.5 }, { lines: [l] });
    expect(frac.errors).toEqual(["Strukturrad 4 (Plåt): antalet blev -0,5 — använd ett villkor om raden inte ska ingå"]);
  });

  it("rule 4: a conditional operation with formula times is included when its conditions hold", () => {
    const o = op({ sequenceNo: 20, conditions: [hjulSelected], description: "Montera hjul", setupTime: null, setupFormula: "5 + 5", runTimePerUnit: null, runFormula: "bredd / 1000" });
    const r = derive({ HJUL: true, BREDD: 1500 }, { operations: [o] });
    expect(r.derivable).toBe(true);
    expect(r.operations.map((x) => [x.kind, x.sequenceNo])).toEqual([["base", 10], ["configurator", 20], ["base", 30]]);
    expect(r.operations[1]).toEqual({ kind: "configurator", id: o.id, sequenceNo: 20, workCenterId: id("W3"), description: "Montera hjul", setupTime: 10, runTimePerUnit: 1.5, costingOnly: false });
    const without = derive({ HJUL: false, BREDD: 1500 }, { operations: [o] });
    expect(without.operations.map((x) => x.sequenceNo)).toEqual([10, 30]);
  });

  it("rule 4: fixed times are used as is", () => {
    const r = derive({ BREDD: 1500 }, { operations: [op({ sequenceNo: 50, setupTime: 7, runTimePerUnit: 0.25 })] });
    expect(r.operations[2]).toMatchObject({ kind: "configurator", sequenceNo: 50, setupTime: 7, runTimePerUnit: 0.25 });
  });

  it("rule 4: formula errors and negative times are errors on the operation", () => {
    const bad = op({ sequenceNo: 40, setupTime: null, setupFormula: "okand + 1" });
    const neg = op({ sequenceNo: 50, setupTime: null, setupFormula: "bredd - 2000", runTimePerUnit: null, runFormula: "1 - hjul * 2" });
    const r = derive({ BREDD: 1500, HJUL: true }, { operations: [bad, neg] });
    expect(r.derivable).toBe(false);
    expect(r.errors).toEqual([
      "Operation 40: Okänd kod OKAND",
      "Operation 50: ställtiden blev negativ",
      "Operation 50: stycktiden blev negativ",
    ]);
    expect(r.operations.map((x) => x.sequenceNo)).toEqual([10, 30]);
  });

  it("rule 5: a line linked to an included base or conditional operation keeps the link", () => {
    const o = op({ sequenceNo: 20, conditions: [hjulSelected] });
    const toBase = line({ routingOperationId: id("O30"), label: "Strukturrad 1 (Hjul)" });
    const toConf = line({ configuratorOperationId: o.id, label: "Strukturrad 2 (Hjul)" });
    const r = derive({ HJUL: true, BREDD: 1200 }, { lines: [toBase, toConf], operations: [o] });
    expect(r.derivable).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.materials[2]!.operation).toEqual({ kind: "base", id: id("O30"), sequenceNo: 30 });
    expect(r.materials[3]!.operation).toEqual({ kind: "configurator", id: o.id, sequenceNo: 20 });
  });

  it("rule 5: a line linked to a conditional operation that is not included becomes unlinked with a warning", () => {
    const o = op({ sequenceNo: 40, conditions: [hjulSelected] });
    const l = line({ configuratorOperationId: o.id, label: "Strukturrad 2 (Plåt)" });
    const r = derive({ HJUL: false, BREDD: 1200 }, { lines: [l], operations: [o] });
    expect(r.derivable).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.materials[2]!.operation).toBeNull();
    expect(r.warnings).toEqual(["Strukturrad 2 (Plåt) kopplad till operation 40 som inte ingår — dras vid slutrapporteringen"]);
  });

  it("rule 6: an operation number in both the route and the conditional operations is an error", () => {
    const r = derive({ BREDD: 1200 }, { operations: [op({ sequenceNo: 30 })] });
    expect(r.derivable).toBe(false);
    expect(r.errors).toEqual(["Operationsnummer 30 finns både i rutten och bland konfiguratorns operationer"]);
  });

  it("rule 7: the same component from two lines (and a base row) stays separate material rows", () => {
    const a = line({ componentArticleId: ART.plat, quantity: 1 });
    const b = line({ componentArticleId: ART.plat, quantity: 2 });
    const r = derive({ BREDD: 1200 }, { lines: [a, b] });
    expect(r.materials.filter((m) => m.componentArticleId === ART.plat).map((m) => [m.source, m.lineId, m.quantity])).toEqual([
      ["base", null, 2.5],
      ["line", a.id, 1],
      ["line", b.id, 2],
    ]);
  });
});

describe("deriveStructure — täckningsvarning", () => {
  // Lines per lock alternative A and B, none for C: choosing C derives a structure without that part.
  const perLock = (extra: ConfiguratorCondition[] = []) => [
    line({ conditions: [...extra, isLock("A")], componentArticleId: ART.lockA }),
    line({ conditions: [...extra, isLock("B")], componentArticleId: ART.lockB }),
  ];

  it("warns when the chosen alternative has no line in a family that covers the others", () => {
    const r = derive({ LOCK: "C", BREDD: 1200 }, { lines: perLock() });
    expect(r.derivable).toBe(true);
    expect(r.warnings).toEqual(["Lock är C men ingen strukturrad motsvarar strukturrad 1 och 2 — den delen kommer inte med"]);
  });

  it("does not warn for a covered alternative", () => {
    expect(derive({ LOCK: "A", BREDD: 1200 }, { lines: perLock() }).warnings).toEqual([]);
  });

  it("warns only when the family's other conditions hold", () => {
    const lines = perLock([hjulSelected]);
    expect(derive({ LOCK: "C", BREDD: 1200 }, { lines }).warnings).toEqual([]);
    expect(derive({ LOCK: "C", HJUL: true, BREDD: 1200 }, { lines }).warnings).toEqual([
      "Lock är C men ingen strukturrad motsvarar strukturrad 1 och 2 — den delen kommer inte med",
    ]);
  });
});
