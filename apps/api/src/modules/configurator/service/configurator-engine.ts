// apps/api/src/modules/configurator/service/configurator-engine.ts
import { fromSek, isOnNumberStep, round2 } from "@navet/shared";
import type {
  ConfiguratorCondition, ConfiguratorEvaluation, ConfiguratorEvaluationGroup, ConfiguratorRuleTarget, ConfiguratorSelection, PriceSource,
} from "@navet/shared";

// Produktkonfigurator — the pure engine (no DB imports). One function decides
// validity, available alternatives, effective number ranges and price for a
// template + selection. Rules never CHANGE the user's selection (they only
// remove alternatives, narrow ranges and add errors), but an excluded DEFAULT is
// cleared. That takes two passes: A tests the exclude rules against a snapshot
// of the step-2 values and clears excluded defaults (order-independent); B runs
// all rules once against the cleared values. Rule order only decides the order
// errors are reported in.

// articleId: the alternative's article (used by the structure derivation); optional so callers that only
// evaluate need not set it.
export type EngineValue = { id: string; code: string; name: string; priceAdd: number; sortOrder: number; active: boolean; articleId?: string | null };
export type EngineGroup = {
  id: string; code: string; name: string; kind: "choice" | "boolean" | "number"; required: boolean; sortOrder: number;
  priceAdd: number; defaultValueId: string | null; unit: string | null; minValue: number | null; maxValue: number | null;
  step: number | null; defaultNumber: number | null; pricePerUnit: number; priceBaseValue: number; values: EngineValue[];
};
export type EngineRule = {
  id: string; effect: "exclude" | "require" | "limit"; conditions: ConfiguratorCondition[]; target: ConfiguratorRuleTarget;
  message: string; sortOrder: number; active: boolean;
};
export type EngineTemplate = { groups: EngineGroup[]; rules: EngineRule[]; basePrice: number | null };
export type EngineCustomerPrice = { unitPrice: number; discountPercent: number; source: PriceSource } | null;

export const BASE_PRICE_MISSING_WARNING = "Grundpris saknas — ange försäljningspris på artikeln";
const STEP_TOLERANCE = 1e-9;

// value = alternative code / boolean / number; null = no value.
export type EffectiveValue = { value: string | boolean | number | null; valueId: string | null; defaulted: boolean };

// Exact: an absolute tolerance on n×10⁴ misjudges large numbers.
const hasAtMost4Decimals = (n: number) => Number(n.toFixed(4)) === n;
const sv = (n: number) => String(Number(n.toFixed(4))).replace(".", ",");

export function normalizeNumber(value: number): string {
  return String(Number(value.toFixed(4)));
}

export function conditionHolds(
  condition: ConfiguratorCondition,
  groupsById: Map<string, EngineGroup>,
  effective: Map<string, EffectiveValue>
): boolean {
  const group = groupsById.get(condition.groupId);
  if (!group) return false;
  const current = effective.get(group.id);
  switch (condition.op) {
    case "is":
      return current?.valueId != null && condition.valueIds.includes(current.valueId);
    case "is_not":
      return current?.valueId == null || !condition.valueIds.includes(current.valueId);
    case "selected":
      return current?.value === true;
    case "not_selected":
      return current?.value !== true;
    default: {
      if (typeof current?.value !== "number") return false;
      const v = current.value;
      const c = condition.value;
      switch (condition.op) {
        case "eq": return Math.abs(v - c) < STEP_TOLERANCE;
        case "ne": return Math.abs(v - c) >= STEP_TOLERANCE;
        case "lt": return v < c - STEP_TOLERANCE;
        case "le": return v <= c + STEP_TOLERANCE;
        case "gt": return v > c + STEP_TOLERANCE;
        case "ge": return v >= c - STEP_TOLERANCE;
      }
    }
  }
}

export function evaluateConfiguration(
  template: EngineTemplate,
  selection: ConfiguratorSelection,
  customerPrice?: EngineCustomerPrice,
  exchangeRate?: number
): ConfiguratorEvaluation {
  return resolveConfiguration(template, selection, customerPrice, exchangeRate).evaluation;
}

/**
 * The engine proper. Besides the evaluation it returns the effective values (keyed by group id) AFTER pass A —
 * an excluded default is cleared — so conditions on structure lines/operations are judged exactly like rules.
 */
//
// Valuta: exchangeRate (SEK per 1 unit of the document's currency; omitted =
// SEK) prices the configuration in another currency. The template's base
// price and every addition are SEK and are converted, each to the öre
// (fromSek — an addition after its own SEK rounding, so a number group's
// amount is (value − base) × price per unit in SEK first); a customerPrice
// is already in the document's currency (the sales chain priced it so).
export function resolveConfiguration(
  template: EngineTemplate,
  selection: ConfiguratorSelection,
  customerPrice?: EngineCustomerPrice,
  exchangeRate?: number
): { evaluation: ConfiguratorEvaluation; effective: Map<string, EffectiveValue> } {
  const inCurrency = (amountSek: number) => (exchangeRate === undefined || exchangeRate === 1 ? amountSek : fromSek(amountSek, exchangeRate));
  const groups = [...template.groups].sort((a, b) => a.sortOrder - b.sortOrder);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const byCode = new Map(groups.map((g) => [g.code, g]));
  const errors: string[] = [];
  const groupErrors = new Map<string, string[]>(groups.map((g) => [g.id, []]));
  const addError = (groupId: string, message: string) => groupErrors.get(groupId)!.push(message);

  // 1. unknown codes
  for (const code of Object.keys(selection)) if (!byCode.has(code)) errors.push(`Okänd valgrupp: ${code}`);

  // 2. effective values
  // Delprojekt 5: null = medvetet tomt (slår ut förvalet); saknad nyckel = förval.
  // A cleared group is not `defaulted`, so pass A below (which only clears
  // excluded DEFAULTS) leaves it alone; a required group cleared this way gets
  // the ordinary required error in step 4.
  const effective = new Map<string, EffectiveValue>();
  for (const g of groups) {
    const raw = selection[g.code];
    const cleared = raw === null;
    const given = raw !== undefined && !cleared;
    if (cleared) {
      effective.set(g.id, g.kind === "boolean" ? { value: false, valueId: null, defaulted: false } : { value: null, valueId: null, defaulted: false });
      continue;
    }
    if (g.kind === "choice") {
      if (given) {
        if (typeof raw !== "string") { addError(g.id, "Välj ett alternativ i listan"); effective.set(g.id, { value: null, valueId: null, defaulted: false }); continue; }
        const v = g.values.find((x) => x.code === raw);
        if (!v) { addError(g.id, "Okänt alternativ"); effective.set(g.id, { value: null, valueId: null, defaulted: false }); continue; }
        if (!v.active) { addError(g.id, "Alternativet är inte längre valbart"); effective.set(g.id, { value: null, valueId: null, defaulted: false }); continue; }
        effective.set(g.id, { value: v.code, valueId: v.id, defaulted: false });
      } else {
        const d = g.values.find((x) => x.id === g.defaultValueId && x.active);
        effective.set(g.id, d ? { value: d.code, valueId: d.id, defaulted: true } : { value: null, valueId: null, defaulted: false });
      }
    } else if (g.kind === "boolean") {
      if (given && typeof raw !== "boolean") { addError(g.id, "Ange ja eller nej"); effective.set(g.id, { value: false, valueId: null, defaulted: false }); continue; }
      effective.set(g.id, { value: given ? (raw as boolean) : false, valueId: null, defaulted: !given });
    } else {
      if (given && typeof raw !== "number") { addError(g.id, `Ange ${g.name} som ett tal`); effective.set(g.id, { value: null, valueId: null, defaulted: false }); continue; }
      const value = given ? (raw as number) : g.defaultNumber;
      effective.set(g.id, { value: value ?? null, valueId: null, defaulted: !given && value != null });
    }
  }

  // 3. rules, two passes (terminating). Pass A: only `exclude` rules, against the
  // step-2 values, clear DEFAULTED values they exclude. Pass B: all rules once
  // against the cleared values — it alone decides alternatives, ranges and errors.
  const activeRules = template.rules.filter((r) => r.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const step2 = new Map(effective); // snapshot: pass A is independent of rule order
  for (const r of activeRules) {
    if (r.effect !== "exclude") continue;
    if (!r.conditions.every((c) => conditionHolds(c, groupsById, step2))) continue;
    const t = r.target as { groupId: string; valueIds: string[] };
    const cur = effective.get(t.groupId);
    if (cur?.defaulted && cur.valueId && t.valueIds.includes(cur.valueId)) {
      effective.set(t.groupId, { value: null, valueId: null, defaulted: false });
    }
  }
  const available = new Map<string, Set<string>>(
    groups.filter((g) => g.kind === "choice").map((g) => [g.id, new Set(g.values.filter((v) => v.active).map((v) => v.id))])
  );
  const range = new Map<string, { min: number; max: number }>(
    groups.filter((g) => g.kind === "number").map((g) => [g.id, { min: g.minValue!, max: g.maxValue! }])
  );
  const excludeErrored = new Set<string>(); // groups already given an exclude error
  const emptyRange = new Set<string>();
  for (const r of activeRules) {
    if (!r.conditions.every((c) => conditionHolds(c, groupsById, effective))) continue;
    if (r.effect === "exclude") {
      const t = r.target as { groupId: string; valueIds: string[] };
      if (!groupsById.has(t.groupId)) continue;
      for (const valueId of t.valueIds) available.get(t.groupId)?.delete(valueId);
      const cur = effective.get(t.groupId);
      if (cur?.valueId && t.valueIds.includes(cur.valueId) && !excludeErrored.has(t.groupId)) {
        excludeErrored.add(t.groupId);
        addError(t.groupId, r.message);
      }
    } else if (r.effect === "limit") {
      const t = r.target as { groupId: string; min?: number; max?: number };
      const cur = range.get(t.groupId);
      if (!cur) continue;
      if (t.min !== undefined) cur.min = Math.max(cur.min, t.min);
      if (t.max !== undefined) cur.max = Math.min(cur.max, t.max);
      if (cur.min > cur.max && !emptyRange.has(t.groupId)) { emptyRange.add(t.groupId); addError(t.groupId, r.message); }
    } else {
      const target = r.target as ConfiguratorCondition;
      if (!groupsById.has(target.groupId)) continue;
      if (!conditionHolds(target, groupsById, effective)) addError(target.groupId, r.message);
    }
  }

  // 4–5. required, number range/decimals/step
  for (const g of groups) {
    const cur = effective.get(g.id)!;
    if (g.kind === "choice" && g.required && cur.value === null && groupErrors.get(g.id)!.length === 0) addError(g.id, `Välj ${g.name}`);
    if (g.kind === "number") {
      if (cur.value === null) {
        if (g.required && groupErrors.get(g.id)!.length === 0) addError(g.id, `Ange ${g.name}`);
        continue;
      }
      const v = cur.value as number;
      const unit = g.unit ? ` ${g.unit}` : "";
      const r = range.get(g.id)!;
      if (!hasAtMost4Decimals(v)) { addError(g.id, `${g.name} får ha högst 4 decimaler`); continue; }
      if (!emptyRange.has(g.id) && (v < r.min - STEP_TOLERANCE || v > r.max + STEP_TOLERANCE)) addError(g.id, `${g.name} ska vara mellan ${sv(r.min)} och ${sv(r.max)}${unit}`);
      if (g.step !== null && !isOnNumberStep(v, g.minValue, g.step)) addError(g.id, `${g.name} ska anges i steg om ${sv(g.step)}${unit}`);
    }
  }

  // price
  const additions: ConfiguratorEvaluation["price"]["additions"] = [];
  for (const g of groups) {
    const cur = effective.get(g.id)!;
    if (g.kind === "choice" && cur.valueId) {
      const v = g.values.find((x) => x.id === cur.valueId)!;
      if (v.priceAdd !== 0) additions.push({ groupCode: g.code, label: `${g.name}: ${v.name}`, amount: inCurrency(round2(v.priceAdd)) });
    } else if (g.kind === "boolean" && cur.value === true && g.priceAdd !== 0) {
      additions.push({ groupCode: g.code, label: g.name, amount: inCurrency(round2(g.priceAdd)) });
    } else if (g.kind === "number" && typeof cur.value === "number" && g.pricePerUnit > 0) {
      const amount = inCurrency(round2(Math.max(0, cur.value - g.priceBaseValue) * g.pricePerUnit));
      if (amount !== 0) additions.push({ groupCode: g.code, label: `${g.name}: ${sv(cur.value)}${g.unit ? ` ${g.unit}` : ""}`, amount });
    }
  }
  let base = template.basePrice === null ? null : inCurrency(template.basePrice);
  let discountPercent = 0;
  let source: PriceSource | null = base === null ? null : "article";
  if (customerPrice) {
    base = customerPrice.unitPrice;
    discountPercent = customerPrice.discountPercent;
    source = customerPrice.source;
  }
  const warnings = base === null ? [BASE_PRICE_MISSING_WARNING] : [];
  const unitPrice = base === null ? null : round2(base + additions.reduce((s, a) => s + a.amount, 0));

  const resultGroups: ConfiguratorEvaluationGroup[] = groups.map((g) => {
    const cur = effective.get(g.id)!;
    const out: ConfiguratorEvaluationGroup = { code: g.code, kind: g.kind, value: cur.value, defaulted: cur.defaulted, errors: groupErrors.get(g.id)! };
    if (g.kind === "choice") {
      const ids = available.get(g.id)!;
      out.availableValueCodes = [...g.values].sort((a, b) => a.sortOrder - b.sortOrder).filter((v) => ids.has(v.id)).map((v) => v.code);
    }
    if (g.kind === "number") Object.assign(out, range.get(g.id)!);
    return out;
  });
  const valid = errors.length === 0 && resultGroups.every((g) => g.errors.length === 0);
  const evaluation: ConfiguratorEvaluation = {
    valid, key: valid ? canonicalKey(groups, effective) : null, groups: resultGroups, errors, price: { base, additions, unitPrice, discountPercent, source }, warnings,
  };
  // `effective` is only written in steps 2 and pass A; a copy keeps callers from mutating engine state.
  return { evaluation, effective: new Map(effective) };
}

function canonicalKey(groups: EngineGroup[], effective: Map<string, EffectiveValue>): string {
  return [...groups]
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .flatMap((g) => {
      const v = effective.get(g.id)!.value;
      if (v === null || v === false) return [];
      if (v === true) return [g.code];
      return [`${g.code}=${typeof v === "number" ? normalizeNumber(v) : v}`];
    })
    .join(";");
}
