// apps/api/test/configurator-engine.test.ts
import { describe, expect, it } from "vitest";
import {
  BASE_PRICE_MISSING_WARNING, evaluateConfiguration, normalizeNumber,
  type EngineGroup, type EngineRule, type EngineTemplate,
} from "../src/modules/configurator/service/configurator-engine.js";

const id = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;

function choice(code: string, values: [string, number, boolean?][], extra: Partial<EngineGroup> = {}): EngineGroup {
  return {
    id: id(code), code, name: code.charAt(0) + code.slice(1).toLowerCase(), kind: "choice", required: false, sortOrder: 1,
    priceAdd: 0, defaultValueId: null, unit: null, minValue: null, maxValue: null, step: null, defaultNumber: null,
    pricePerUnit: 0, priceBaseValue: 0,
    values: values.map(([c, p, active], i) => ({ id: id(`${code}${c}`), code: c, name: c, priceAdd: p, sortOrder: i, active: active ?? true })),
    ...extra,
  };
}
function bool(code: string, priceAdd = 0): EngineGroup {
  return { ...choice(code, []), kind: "boolean", priceAdd };
}
function num(code: string, min: number, max: number, extra: Partial<EngineGroup> = {}): EngineGroup {
  return { ...choice(code, []), kind: "number", unit: "mm", minValue: min, maxValue: max, ...extra };
}
let ruleSeq = 0;
function rule(r: Partial<EngineRule> & Pick<EngineRule, "effect" | "conditions" | "target" | "message">): EngineRule {
  return { id: id("R" + ++ruleSeq), sortOrder: 1, active: true, ...r };
}
function tpl(groups: EngineGroup[], rules: EngineRule[] = [], basePrice: number | null = 1000): EngineTemplate {
  return { groups, rules, basePrice };
}
const lock = () => choice("LOCK", [["A", 0], ["B", 150], ["C", 300]]);
const farg = () => choice("FARG", [["RD", 0], ["BL", 0], ["EP", 400]]);

describe("evaluateConfiguration", () => {
  it("prices base + additions and builds the key", () => {
    const r = evaluateConfiguration(tpl([lock(), farg(), bool("HJUL", 250)]), { LOCK: "B", FARG: "EP", HJUL: true });
    expect(r.valid).toBe(true);
    expect(r.price.base).toBe(1000);
    expect(r.price.additions.map((a) => [a.groupCode, a.amount])).toEqual([["LOCK", 150], ["FARG", 400], ["HJUL", 250]]);
    expect(r.price.unitPrice).toBe(1800);
    expect(r.key).toBe("FARG=EP;HJUL;LOCK=B");
  });

  it("applies an active default and marks it defaulted; an inactive default is ignored", () => {
    const g = lock();
    g.defaultValueId = g.values[1]!.id;
    const r = evaluateConfiguration(tpl([g]), {});
    expect(r.groups[0]).toMatchObject({ value: "B", defaulted: true });
    g.values[1]!.active = false;
    const r2 = evaluateConfiguration(tpl([{ ...g, required: true }]), {});
    expect(r2.groups[0]!.value).toBeNull();
    expect(r2.groups[0]!.errors).toEqual(["Välj Lock"]);
  });

  it("required number without value: Ange …", () => {
    const r = evaluateConfiguration(tpl([num("BREDD", 800, 3000, { name: "Bredd", required: true })]), {});
    expect(r.valid).toBe(false);
    expect(r.groups[0]!.errors).toEqual(["Ange Bredd"]);
  });

  it("type errors, unknown group code and unknown/inactive alternative", () => {
    const g = lock();
    g.values[2]!.active = false;
    const r = evaluateConfiguration(tpl([g, bool("HJUL"), num("BREDD", 800, 3000)]), { LOCK: "C", HJUL: "ja", BREDD: "1200", XYZ: 1 } as never);
    expect(r.errors).toEqual(["Okänd valgrupp: XYZ"]);
    expect(r.groups[0]!.errors).toEqual(["Alternativet är inte längre valbart"]);
    expect(r.groups[1]!.errors.length).toBe(1);
    expect(r.groups[2]!.errors.length).toBe(1);
    const r2 = evaluateConfiguration(tpl([lock()]), { LOCK: "Q" });
    expect(r2.groups[0]!.errors).toEqual(["Okänt alternativ"]);
  });

  it("exclude removes alternatives and errors on a selected excluded one", () => {
    const l = lock();
    const f = farg();
    const r = rule({
      effect: "exclude",
      conditions: [{ groupId: f.id, op: "is", valueIds: [f.values[2]!.id] }],
      target: { groupId: l.id, valueIds: [l.values[2]!.id] },
      message: "Elpolerad finns inte med lock C",
    });
    const ok = evaluateConfiguration(tpl([l, f], [r]), { FARG: "EP", LOCK: "B" });
    expect(ok.groups[0]!.availableValueCodes).toEqual(["A", "B"]);
    expect(ok.valid).toBe(true);
    const bad = evaluateConfiguration(tpl([l, f], [r]), { FARG: "EP", LOCK: "C" });
    expect(bad.groups[0]!.errors).toEqual(["Elpolerad finns inte med lock C"]);
    expect(bad.key).toBeNull();
  });

  it("excluded default is treated as empty (never valid, never in key)", () => {
    const l = { ...lock(), required: true };
    l.defaultValueId = l.values[2]!.id;
    const f = farg();
    const r = rule({
      effect: "exclude",
      conditions: [{ groupId: f.id, op: "is", valueIds: [f.values[2]!.id] }],
      target: { groupId: l.id, valueIds: [l.values[2]!.id] },
      message: "Elpolerad finns inte med lock C",
    });
    const res = evaluateConfiguration(tpl([l, f], [r]), { FARG: "EP" });
    expect(res.groups[0]!.value).toBeNull();
    expect(res.groups[0]!.errors).toEqual(["Välj Lock"]);
    expect(res.valid).toBe(false);
    const optional = evaluateConfiguration(tpl([{ ...l, required: false }, f], [r]), { FARG: "EP" });
    expect(optional.valid).toBe(true);
    expect(optional.key).toBe("FARG=EP");
  });

  it("require errors on the target group when the condition holds", () => {
    const hjul = bool("HJUL");
    const under = bool("UNDER");
    const r = rule({
      effect: "require",
      conditions: [{ groupId: hjul.id, op: "selected" }],
      target: { groupId: under.id, op: "selected" },
      message: "Hjul kräver underrede",
    });
    const bad = evaluateConfiguration(tpl([hjul, under], [r]), { HJUL: true });
    expect(bad.groups[1]!.errors).toEqual(["Hjul kräver underrede"]);
    expect(evaluateConfiguration(tpl([hjul, under], [r]), { HJUL: true, UNDER: true }).valid).toBe(true);
    expect(evaluateConfiguration(tpl([hjul, under], [r]), {}).valid).toBe(true);
  });

  it("limit narrows the range; empty intersection errors with the rule message", () => {
    const f = farg();
    const b = num("BREDD", 800, 3000, { name: "Bredd" });
    const lim = rule({
      effect: "limit",
      conditions: [{ groupId: f.id, op: "is", valueIds: [f.values[2]!.id] }],
      target: { groupId: b.id, max: 2400 },
      message: "Elpolerad högst 2400 mm",
    });
    const r = evaluateConfiguration(tpl([f, b], [lim]), { FARG: "EP", BREDD: 2500 });
    expect(r.groups[1]).toMatchObject({ min: 800, max: 2400 });
    expect(r.groups[1]!.errors).toEqual(["Bredd ska vara mellan 800 och 2400 mm"]);
    const empty = rule({ ...lim, target: { groupId: b.id, max: 500 }, message: "Omöjligt" });
    expect(evaluateConfiguration(tpl([f, b], [empty]), { FARG: "EP", BREDD: 900 }).groups[1]!.errors).toContain("Omöjligt");
  });

  it("reports errors in rule sort order; inactive rules are ignored", () => {
    const hjul = bool("HJUL");
    const under = bool("UNDER");
    const a = rule({ effect: "require", conditions: [{ groupId: hjul.id, op: "selected" }], target: { groupId: under.id, op: "selected" }, message: "Andra", sortOrder: 2 });
    const b = rule({ effect: "require", conditions: [], target: { groupId: under.id, op: "selected" }, message: "Första", sortOrder: 1 });
    const off = rule({ effect: "require", conditions: [], target: { groupId: hjul.id, op: "not_selected" }, message: "Av", active: false });
    const r = evaluateConfiguration(tpl([hjul, under], [a, b, off]), { HJUL: true });
    expect(r.groups[1]!.errors).toEqual(["Första", "Andra"]);
    expect(r.groups[0]!.errors).toEqual([]);
  });

  it("conditions on an unselected choice: is never holds, is_not always holds; number without value holds nothing", () => {
    const l = lock();
    const b = num("BREDD", 800, 3000);
    const h = bool("HJUL");
    const isRule = rule({ effect: "require", conditions: [{ groupId: l.id, op: "is", valueIds: [l.values[0]!.id] }], target: { groupId: h.id, op: "selected" }, message: "is" });
    const notRule = rule({ effect: "require", conditions: [{ groupId: l.id, op: "is_not", valueIds: [l.values[0]!.id] }], target: { groupId: h.id, op: "selected" }, message: "isnot" });
    const numRule = rule({ effect: "require", conditions: [{ groupId: b.id, op: "lt", value: 99999 }], target: { groupId: h.id, op: "selected" }, message: "num" });
    const r = evaluateConfiguration(tpl([l, b, h], [isRule, notRule, numRule]), {});
    expect(r.groups[2]!.errors).toEqual(["isnot"]);
  });

  it("every number operator", () => {
    const b = num("BREDD", 0, 5000);
    const h = bool("HJUL");
    const at = (op: "eq" | "ne" | "lt" | "le" | "gt" | "ge", value: number, bredd: number) =>
      evaluateConfiguration(
        tpl([b, h], [rule({ effect: "require", conditions: [{ groupId: b.id, op, value }], target: { groupId: h.id, op: "selected" }, message: "x" })]),
        { BREDD: bredd }
      ).valid === false;
    expect([at("eq", 1000, 1000), at("eq", 1000, 1001)]).toEqual([true, false]);
    expect([at("ne", 1000, 1001), at("ne", 1000, 1000)]).toEqual([true, false]);
    expect([at("lt", 1000, 999), at("lt", 1000, 1000)]).toEqual([true, false]);
    expect([at("le", 1000, 1000), at("le", 1000, 1001)]).toEqual([true, false]);
    expect([at("gt", 1000, 1001), at("gt", 1000, 1000)]).toEqual([true, false]);
    expect([at("ge", 1000, 1000), at("ge", 1000, 999)]).toEqual([true, false]);
  });

  it("step tolerance and decimals", () => {
    const g = (step: number, min = 0) => num("T", min, 10, { name: "T", step, unit: "mm" });
    expect(evaluateConfiguration(tpl([g(0.1)]), { T: 3.0 }).valid).toBe(true);
    expect(evaluateConfiguration(tpl([g(0.1)]), { T: 0.3 }).valid).toBe(true);
    expect(evaluateConfiguration(tpl([g(0.25)]), { T: 2.75 }).valid).toBe(true);
    expect(evaluateConfiguration(tpl([g(2.5)]), { T: 7.5 }).valid).toBe(true);
    expect(evaluateConfiguration(tpl([g(2.5)]), { T: 7 }).groups[0]!.errors).toEqual(["T ska anges i steg om 2,5 mm"]);
    expect(evaluateConfiguration(tpl([g(2.5, 1)]), { T: 6 }).valid).toBe(true); // steps counted from min
    expect(evaluateConfiguration(tpl([num("T", 0, 10, { name: "T" })]), { T: 1.23456 }).groups[0]!.errors).toEqual(["T får ha högst 4 decimaler"]);
    const big = tpl([num("T", 0, 1e10, { name: "T" })]);
    expect([1234567.1234, 1078213.6444, 9999999999.9999].map((T) => evaluateConfiguration(big, { T }).valid)).toEqual([true, true, true]);
    expect(evaluateConfiguration(big, { T: 1234567.12345 }).groups[0]!.errors).toEqual(["T får ha högst 4 decimaler"]);
  });

  it("number price: only the part above the base value; negative addition allowed on a choice", () => {
    const b = num("BREDD", 800, 3000, { pricePerUnit: 1.2, priceBaseValue: 1000 });
    expect(evaluateConfiguration(tpl([b]), { BREDD: 900 }).price.additions).toEqual([]);
    expect(evaluateConfiguration(tpl([b]), { BREDD: 1500 }).price.unitPrice).toBe(1600);
    const cheap = choice("LOCK", [["NONE", -100]]);
    expect(evaluateConfiguration(tpl([cheap]), { LOCK: "NONE" }).price.unitPrice).toBe(900);
  });

  it("missing base price: null price with warning, never 0", () => {
    const r = evaluateConfiguration(tpl([lock()], [], null), { LOCK: "B" });
    expect(r.price.base).toBeNull();
    expect(r.price.unitPrice).toBeNull();
    expect(r.warnings).toEqual([BASE_PRICE_MISSING_WARNING]);
    expect(r.price.additions).toEqual([{ groupCode: "LOCK", label: "Lock: B", amount: 150 }]);
  });

  it("customer price replaces the base and carries the discount; a null chain keeps the base", () => {
    const r = evaluateConfiguration(tpl([lock()]), { LOCK: "B" }, { unitPrice: 900, discountPercent: 10, source: "customer_article" });
    expect(r.price).toMatchObject({ base: 900, unitPrice: 1050, discountPercent: 10, source: "customer_article" });
    const none = evaluateConfiguration(tpl([lock()]), { LOCK: "B" }, null);
    expect(none.price).toMatchObject({ base: 1000, unitPrice: 1150, discountPercent: 0, source: "article" });
  });

  it("prices an invalid configuration too (valid decides use)", () => {
    const r = evaluateConfiguration(tpl([{ ...lock(), required: true }, bool("HJUL", 250)]), { HJUL: true });
    expect(r.valid).toBe(false);
    expect(r.price.unitPrice).toBe(1250);
  });

  it("key normalisation is independent of order, defaults and number spelling", () => {
    const l = lock();
    l.defaultValueId = l.values[1]!.id;
    const groups = [l, num("BREDD", 0, 5000), bool("HJUL")];
    const a = evaluateConfiguration(tpl(groups), { HJUL: true, BREDD: 1200 });
    const b = evaluateConfiguration(tpl(groups), { BREDD: 1200.0, LOCK: "B", HJUL: true });
    const c = evaluateConfiguration(tpl(groups), { LOCK: "B", BREDD: 1.2e3, HJUL: true });
    expect(a.key).toBe("BREDD=1200;HJUL;LOCK=B");
    expect(b.key).toBe(a.key);
    expect(c.key).toBe(a.key);
    expect(evaluateConfiguration(tpl(groups), { HJUL: false, BREDD: 1200 }).key).toBe("BREDD=1200;LOCK=B");
    expect(normalizeNumber(12.5)).toBe("12.5");
    expect(normalizeNumber(0.1 + 0.2)).toBe("0.3");
  });

  const excludeCDefault = (extra: EngineRule[]) => {
    const l = lock();
    l.defaultValueId = l.values[2]!.id; // C
    const f = farg();
    const r1 = rule({ effect: "exclude", conditions: [{ groupId: f.id, op: "is", valueIds: [f.values[2]!.id] }], target: { groupId: l.id, valueIds: [l.values[2]!.id] }, message: "R1" });
    return { l, f, rules: [r1, ...extra] };
  };

  it("an excluded default does not decide other rules (is_not is not satisfied by a cleared default)", () => {
    const { l, f, rules } = excludeCDefault([]);
    const u = bool("UNDER");
    const r2 = rule({ effect: "require", conditions: [{ groupId: l.id, op: "is_not", valueIds: [l.values[2]!.id] }], target: { groupId: u.id, op: "selected" }, message: "R2" });
    const res = evaluateConfiguration(tpl([l, f, u], [...rules, r2]), { FARG: "EP" });
    expect(res.valid).toBe(false);
    expect(res.groups.find((g) => g.code === "UNDER")!.errors).toEqual(["R2"]);
    expect(res.groups.find((g) => g.code === "LOCK")!.value).toBeNull();
  });

  it("an excluded default does not fire rules that need it (no phantom require)", () => {
    const { l, f, rules } = excludeCDefault([]);
    const h = bool("HJUL");
    const r3 = rule({ effect: "require", conditions: [{ groupId: l.id, op: "is", valueIds: [l.values[2]!.id] }], target: { groupId: h.id, op: "selected" }, message: "R3" });
    const res = evaluateConfiguration(tpl([l, f, h], [...rules, r3]), { FARG: "EP" });
    expect(res.groups.find((g) => g.code === "HJUL")!.errors).toEqual([]);
    expect(res.valid).toBe(true);
  });

  it("exclude error for a chosen value follows rule sort order relative to require", () => {
    const l = lock();
    const f = farg();
    const h = bool("HJUL");
    const ex = rule({ effect: "exclude", sortOrder: 1, conditions: [{ groupId: f.id, op: "is", valueIds: [f.values[2]!.id] }], target: { groupId: l.id, valueIds: [l.values[2]!.id] }, message: "Ex" });
    const rq = rule({ effect: "require", sortOrder: 2, conditions: [], target: { groupId: l.id, op: "is", valueIds: [l.values[0]!.id] }, message: "Rq" });
    const res = evaluateConfiguration(tpl([l, f, h], [rq, ex]), { FARG: "EP", LOCK: "C" });
    expect(res.groups[0]!.errors).toEqual(["Ex", "Rq"]);
  });

  it("step check is exact", () => {
    const g = num("T", 0, 2e9, { name: "T", step: 2.5 });
    expect(evaluateConfiguration(tpl([g]), { T: 1300000001 }).groups[0]!.errors).toEqual(["T ska anges i steg om 2,5 mm"]);
    const t = num("T", 0, 10, { name: "T", step: 0.1 });
    for (let i = 0; i <= 30; i++) {
      const v = Number((i / 10).toFixed(1));
      expect(evaluateConfiguration(tpl([t]), { T: v }).valid, String(v)).toBe(true);
      expect(evaluateConfiguration(tpl([t]), { T: Number((v + 0.0001).toFixed(4)) }).valid, `${v}+`).toBe(false);
    }
  });

  it("rules pointing at groups missing from the template are skipped", () => {
    const h = bool("HJUL");
    const ghost = id("GHOST");
    const r1 = rule({ effect: "require", conditions: [], target: { groupId: ghost, op: "selected" }, message: "g" });
    const r2 = rule({ effect: "exclude", conditions: [], target: { groupId: ghost, valueIds: [id("x")] }, message: "g2" });
    const r3 = rule({ effect: "limit", conditions: [], target: { groupId: ghost, max: 1 }, message: "g3" });
    expect(evaluateConfiguration(tpl([h], [r1, r2, r3]), {}).valid).toBe(true);
  });

  it("require on a choice (is) and a number (ge); limit with only min; defaulted number outside narrowed range", () => {
    const l = lock();
    const b = num("BREDD", 800, 3000, { name: "Bredd" });
    const h = bool("HJUL");
    const rc = rule({ effect: "require", conditions: [{ groupId: h.id, op: "selected" }], target: { groupId: l.id, op: "is", valueIds: [l.values[1]!.id] }, message: "needB" });
    expect(evaluateConfiguration(tpl([l, b, h], [rc]), { HJUL: true, LOCK: "A" }).groups[0]!.errors).toEqual(["needB"]);
    expect(evaluateConfiguration(tpl([l, b, h], [rc]), { HJUL: true, LOCK: "B" }).valid).toBe(true);
    const rn = rule({ effect: "require", conditions: [{ groupId: h.id, op: "selected" }], target: { groupId: b.id, op: "ge", value: 1000 }, message: "needW" });
    expect(evaluateConfiguration(tpl([l, b, h], [rn]), { HJUL: true, BREDD: 900 }).groups[1]!.errors).toEqual(["needW"]);
    expect(evaluateConfiguration(tpl([l, b, h], [rn]), { HJUL: true, BREDD: 1000 }).valid).toBe(true);
    const lim = rule({ effect: "limit", conditions: [], target: { groupId: b.id, min: 1000 }, message: "min" });
    const lr = evaluateConfiguration(tpl([b], [lim]), { BREDD: 900 });
    expect(lr.groups[0]).toMatchObject({ min: 1000, max: 3000 });
    expect(lr.groups[0]!.errors).toEqual(["Bredd ska vara mellan 1000 och 3000 mm"]);
    const d = num("BREDD", 800, 3000, { name: "Bredd", defaultNumber: 900 });
    const dr = evaluateConfiguration(tpl([d], [lim]), {});
    expect(dr.valid).toBe(false);
    expect(dr.groups[0]!.errors).toEqual(["Bredd ska vara mellan 1000 och 3000 mm"]);
  });

  it("pass A is independent of rule order (defaults cleared against the step-2 snapshot)", () => {
    // (a)
    const X = choice("X", [["A", 0], ["B", 0]]); X.defaultValueId = X.values[0]!.id;
    const Y = choice("Y", [["P", 0], ["Q", 0]]); Y.defaultValueId = Y.values[0]!.id;
    const Z = choice("Z", [["E", 0], ["F", 0]]);
    const ra = rule({ effect: "exclude", conditions: [{ groupId: Z.id, op: "is_not", valueIds: [Z.values[0]!.id] }], target: { groupId: X.id, valueIds: [X.values[0]!.id] }, message: "Ra" });
    const rb = rule({ effect: "exclude", conditions: [{ groupId: X.id, op: "is_not", valueIds: [X.values[0]!.id] }], target: { groupId: Y.id, valueIds: [Y.values[0]!.id] }, message: "Rb" });
    const o1 = evaluateConfiguration(tpl([X, Y, Z], [{ ...ra, sortOrder: 1 }, { ...rb, sortOrder: 2 }]), {});
    const o2 = evaluateConfiguration(tpl([X, Y, Z], [{ ...ra, sortOrder: 2 }, { ...rb, sortOrder: 1 }]), {});
    expect(o2).toEqual(o1);
    // (b)
    const F = choice("F", [["EP", 0], ["RD", 0]]); F.defaultValueId = F.values[0]!.id;
    const L = choice("L", [["C", 0], ["A", 0]]); L.defaultValueId = L.values[0]!.id;
    const r1 = rule({ effect: "exclude", conditions: [{ groupId: L.id, op: "is", valueIds: [L.values[0]!.id] }], target: { groupId: F.id, valueIds: [F.values[0]!.id] }, message: "r1" });
    const r2 = rule({ effect: "exclude", conditions: [{ groupId: F.id, op: "is", valueIds: [F.values[0]!.id] }], target: { groupId: L.id, valueIds: [L.values[0]!.id] }, message: "r2" });
    const p1 = evaluateConfiguration(tpl([F, L], [{ ...r1, sortOrder: 1 }, { ...r2, sortOrder: 2 }]), {});
    const p2 = evaluateConfiguration(tpl([F, L], [{ ...r1, sortOrder: 2 }, { ...r2, sortOrder: 1 }]), {});
    expect(p2.groups).toEqual(p1.groups);
    expect(p1.groups.map((g) => g.value)).toEqual([null, null]);
  });
});

// Delprojekt 5 (externt API): `null` in the selection is "deliberately empty"
// and beats the default; a MISSING key still takes the default.
describe("null i valen (delprojekt 5)", () => {
  const resolve = (template: EngineTemplate, selection: Parameters<typeof evaluateConfiguration>[1]) => evaluateConfiguration(template, selection);
  const group = (r: ReturnType<typeof evaluateConfiguration>, code: string) => {
    const g = r.groups.find((x) => x.code === code);
    if (!g) throw new Error(`no group ${code}`);
    return g;
  };
  // LOCK default A · AVLOPP ja/nej · BREDD 500–2000 default 1200 · KRAV required, default K1
  const lockWithDefault = () => { const g = lock(); g.defaultValueId = g.values[0]!.id; return g; };
  const krav = (withDefault: boolean) => {
    const g = choice("KRAV", [["K1", 0], ["K2", 0]], { name: "Krav", required: true });
    if (withDefault) g.defaultValueId = g.values[0]!.id;
    return g;
  };
  const template = tpl([lockWithDefault(), bool("AVLOPP", 100), num("BREDD", 500, 2000, { name: "Bredd", defaultNumber: 1200 }), krav(true)]);
  const templateWithoutDefaults = tpl([lockWithDefault(), bool("AVLOPP", 100), num("BREDD", 500, 2000, { name: "Bredd", defaultNumber: 1200 }), krav(false)]);
  const templateWithExclude = (() => {
    const l = lockWithDefault();
    const a = bool("AVLOPP", 100);
    return tpl([l, a], [rule({
      effect: "exclude",
      conditions: [{ groupId: a.id, op: "selected" }],
      target: { groupId: l.id, valueIds: [l.values[0]!.id] },
      message: "Avlopp finns inte med lock A",
    })]);
  })();

  it("null tömmer ett listvalsförval; saknad nyckel ger förvalet", () => {
    const withDefault = resolve(template, {});
    expect(group(withDefault, "LOCK")).toMatchObject({ value: "A", defaulted: true });
    const cleared = resolve(template, { LOCK: null });
    expect(group(cleared, "LOCK")).toMatchObject({ value: null, defaulted: false, errors: [] });
    // Not in the key, and no error — the group is optional.
    expect(cleared.key).toBe("BREDD=1200;KRAV=K1");
    expect(withDefault.key).toBe("BREDD=1200;KRAV=K1;LOCK=A");
  });

  it("null på ett mått tömmer defaultNumber; null på ja/nej är Nej", () => {
    const r = resolve(template, { BREDD: null, AVLOPP: null });
    expect(group(r, "BREDD")).toMatchObject({ value: null, defaulted: false, errors: [] });
    expect(group(r, "AVLOPP")).toMatchObject({ value: false, defaulted: false, errors: [] });
    expect(r.price.additions.map((a) => a.groupCode)).not.toContain("AVLOPP");
    expect(group(resolve(template, {}), "BREDD")).toMatchObject({ value: 1200, defaulted: true });
  });

  it("null på en obligatorisk grupp ger motorns obligatorisk-fel", () => {
    expect(group(resolve(template, {}), "KRAV")).toMatchObject({ value: "K1", defaulted: true, errors: [] });
    const r = resolve(template, { KRAV: null });
    expect(r.valid).toBe(false);
    expect(group(r, "KRAV").errors.length).toBeGreaterThan(0);
    // The same error as a required group that simply has no value (no default, no key).
    expect(group(r, "KRAV").errors).toEqual(group(resolve(templateWithoutDefaults, {}), "KRAV").errors);
    expect(group(r, "KRAV").errors).toEqual(["Välj Krav"]);
    // A required measure cleared with null errors the same way.
    const m = resolve(tpl([num("BREDD", 500, 2000, { name: "Bredd", required: true, defaultNumber: 1200 })]), { BREDD: null });
    expect(group(m, "BREDD").errors).toEqual(["Ange Bredd"]);
  });

  it("en exkluderingsregel rör inte ett tömt förval (det är inte defaulted)", () => {
    // regel: AVLOPP = Ja utesluter LOCK A; LOCK null ⇒ inget att rensa, inget fel
    const r = resolve(templateWithExclude, { LOCK: null, AVLOPP: true });
    expect(group(r, "LOCK")).toMatchObject({ value: null, defaulted: false, errors: [] });
    expect(group(r, "LOCK").availableValueCodes).toEqual(["B", "C"]);
    expect(r.valid).toBe(true);
    // Control: the missing key takes the default A, which the rule clears (dp1 behaviour, unchanged).
    expect(group(resolve(templateWithExclude, { AVLOPP: true }), "LOCK")).toMatchObject({ value: null, defaulted: false, errors: [] });
  });

  it("null på en okänd kod räknas fortfarande som okänd valgrupp", () => {
    const r = resolve(template, { XYZ: null });
    expect(r.errors).toEqual(["Okänd valgrupp: XYZ"]);
  });
});
