import type {
  ConfiguratorBomLineDetail, ConfiguratorCondition, ConfiguratorGroupKind, ConfiguratorMode, ConfiguratorOperationDetail,
  ConfiguratorRuleDetail, ConfiguratorRuleEffect, ConfiguratorRuleTarget,
} from "@navet/shared";
import type { EngineGroup, EngineRule, EngineTemplate } from "./configurator-engine.js";
import { formulaReferences, formulaValueReferences, validateFormula, type FormulaGroupInfo } from "./configurator-formula.js";
import {
  ConfiguratorModeNotAllowedError, ConfiguratorSequenceTakenError, InvalidConfiguratorFormulaError, InvalidConfiguratorGroupError,
  InvalidConfiguratorLineError, InvalidConfiguratorOperationError, InvalidConfiguratorRuleError,
} from "./configurator.errors.js";

// Produktkonfigurator — pure save validation (no DB imports). Together with the
// delete guard (templateReferences) and the rename lock (formulaUsers) it makes
// it impossible to store a rule, structure line, operation or formula that
// points at something outside the template: the engine and the derivation
// trust what is stored (they do not check op vs group kind), so this is the
// only guard.

const KIND_LABEL: Record<ConfiguratorGroupKind, string> = { choice: "listval", boolean: "ja/nej", number: "mått/tal" };

const OPS_FOR_KIND: Record<ConfiguratorGroupKind, readonly ConfiguratorCondition["op"][]> = {
  choice: ["is", "is_not"],
  boolean: ["selected", "not_selected"],
  number: ["eq", "ne", "lt", "le", "gt", "ge"],
};

// What is being validated decides the message's subject and the error class.
type Subject = { name: "Regeln" | "Strukturraden" | "Operationen"; fail: (message: string) => Error };
const RULE: Subject = { name: "Regeln", fail: (m) => new InvalidConfiguratorRuleError(m) };
const LINE: Subject = { name: "Strukturraden", fail: (m) => new InvalidConfiguratorLineError(m) };
const OPERATION: Subject = { name: "Operationen", fail: (m) => new InvalidConfiguratorOperationError(m) };

function requireGroup(groupsById: Map<string, EngineGroup>, groupId: string, subject: Subject): EngineGroup {
  const group = groupsById.get(groupId);
  if (!group) throw subject.fail(`${subject.name} pekar på en valgrupp som inte finns i konfiguratorn`);
  return group;
}

function assertValuesInGroup(group: EngineGroup, valueIds: string[], subject: Subject) {
  const own = new Set(group.values.map((v) => v.id));
  if (!valueIds.every((id) => own.has(id))) {
    throw subject.fail(`${subject.name} pekar på ett alternativ som inte hör till valgruppen ${group.name}`);
  }
}

function assertCondition(groupsById: Map<string, EngineGroup>, condition: ConfiguratorCondition, subject: Subject) {
  const group = requireGroup(groupsById, condition.groupId, subject);
  if (!OPS_FOR_KIND[group.kind].includes(condition.op)) {
    throw subject.fail(`Villkoret passar inte valgruppen ${group.name} (${KIND_LABEL[group.kind]})`);
  }
  if ("valueIds" in condition) assertValuesInGroup(group, condition.valueIds, subject);
}

export function validateRuleInput(
  template: EngineTemplate,
  effect: ConfiguratorRuleEffect,
  conditions: ConfiguratorCondition[],
  target: ConfiguratorRuleTarget
): void {
  const groupsById = new Map(template.groups.map((g) => [g.id, g]));
  for (const condition of conditions) assertCondition(groupsById, condition, RULE);

  if (effect === "exclude") {
    const t = target as { groupId: string; valueIds: string[] };
    const group = requireGroup(groupsById, t.groupId, RULE);
    if (group.kind !== "choice") throw new InvalidConfiguratorRuleError("Utesluter kan bara riktas mot ett listval");
    assertValuesInGroup(group, t.valueIds, RULE);
  } else if (effect === "limit") {
    const t = target as { groupId: string; min?: number; max?: number };
    const group = requireGroup(groupsById, t.groupId, RULE);
    if (group.kind !== "number") throw new InvalidConfiguratorRuleError("Begränsar kan bara riktas mot ett mått/tal");
    if (t.min === undefined && t.max === undefined) throw new InvalidConfiguratorRuleError("Ange min eller max");
    if (t.min !== undefined && t.max !== undefined && t.min > t.max) {
      throw new InvalidConfiguratorRuleError("Min får inte vara större än max");
    }
  } else {
    assertCondition(groupsById, target as ConfiguratorCondition, RULE);
  }

  if (conditions.some((c) => c.groupId === target.groupId)) {
    throw new InvalidConfiguratorRuleError("Målgruppen kan inte stå i regelns egna villkor");
  }
}

// --- structure lines and operations -----------------------------------------

// The merged row (stored ∪ patch) the service validates — the update schema is
// a strict partial, so the CHECK-constraint invariants are re-checked here.
export type LineFields = {
  conditions: ConfiguratorCondition[];
  source: "article" | "group";
  componentArticleId: string | null;
  componentGroupId: string | null;
  quantity: number | null;
  quantityFormula: string | null;
  routingOperationId: string | null;
  configuratorOperationId: string | null;
  note: string | null;
};
export type OperationFields = {
  conditions: ConfiguratorCondition[];
  sequenceNo: number;
  workCenterId: string;
  description: string | null;
  setupTime: number | null;
  setupFormula: string | null;
  runTimePerUnit: number | null;
  runFormula: string | null;
  setupPrice: number | null;
  unitPrice: number | null;
};

// What a line may link to: the template's own route and its conditional operations.
export type LineContext = {
  templateArticleId: string;
  routingOperationIds: ReadonlySet<string>;
  configuratorOperationIds: ReadonlySet<string>;
};
// Numbers an operation may not take: the ordinary route's and the OTHER conditional operations'.
export type OperationContext = {
  baseSequenceNos: ReadonlySet<number>;
  otherSequenceNos: ReadonlySet<number>;
};

export const TEMPLATE_IN_COMPONENT = "Komponenten kan inte innehålla mallen själv";
export const TEMPLATE_IN_VALUE_ARTICLE = "Alternativets artikel kan inte innehålla mallen själv";

export function formulaGroups(template: EngineTemplate): FormulaGroupInfo[] {
  return template.groups.map((g) => ({ code: g.code, kind: g.kind, valueCodes: g.values.map((v) => v.code) }));
}

function assertFormula(field: "Antal" | "Ställtid" | "Stycktid", source: string, groups: FormulaGroupInfo[]) {
  const error = validateFormula(source, groups);
  if (error) throw new InvalidConfiguratorFormulaError(field, error.message);
}

// Everything but the two async checks (component article exists / contains the template), which the service does.
export function validateLineInput(template: EngineTemplate, line: LineFields, ctx: LineContext): void {
  const groupsById = new Map(template.groups.map((g) => [g.id, g]));
  for (const condition of line.conditions) assertCondition(groupsById, condition, LINE);

  if (line.source === "article") {
    if (!line.componentArticleId) throw new InvalidConfiguratorLineError("Ange komponentartikel");
    if (line.componentGroupId) throw new InvalidConfiguratorLineError("Källan Artikel tar ingen grupp");
    if (line.componentArticleId === ctx.templateArticleId) throw new InvalidConfiguratorLineError(TEMPLATE_IN_COMPONENT);
  } else {
    if (!line.componentGroupId) throw new InvalidConfiguratorLineError("Ange valgrupp");
    if (line.componentArticleId) throw new InvalidConfiguratorLineError("Källan Från val tar ingen artikel");
    const group = groupsById.get(line.componentGroupId);
    if (!group || group.kind !== "choice") throw new InvalidConfiguratorLineError("Från val kräver ett listval i mallen");
  }

  if ((line.quantity === null) === (line.quantityFormula === null)) {
    throw new InvalidConfiguratorLineError("Ange antingen fast antal eller formel");
  }
  if (line.quantity !== null && !(line.quantity > 0)) throw new InvalidConfiguratorLineError("Antalet ska vara större än 0");
  if (line.quantityFormula !== null) assertFormula("Antal", line.quantityFormula, formulaGroups(template));

  if (line.routingOperationId && line.configuratorOperationId) throw new InvalidConfiguratorLineError("Högst en operationskoppling");
  if (line.routingOperationId && !ctx.routingOperationIds.has(line.routingOperationId)) {
    throw new InvalidConfiguratorLineError("Operationen finns inte i mallens rutt");
  }
  if (line.configuratorOperationId && !ctx.configuratorOperationIds.has(line.configuratorOperationId)) {
    throw new InvalidConfiguratorLineError("Operationen finns inte bland mallens villkorade operationer");
  }
}

export function validateOperationInput(template: EngineTemplate, op: OperationFields, ctx: OperationContext): void {
  const groupsById = new Map(template.groups.map((g) => [g.id, g]));
  for (const condition of op.conditions) assertCondition(groupsById, condition, OPERATION);

  if ((op.setupTime === null) === (op.setupFormula === null)) {
    throw new InvalidConfiguratorOperationError("Ange antingen fast ställtid eller formel");
  }
  if ((op.runTimePerUnit === null) === (op.runFormula === null)) {
    throw new InvalidConfiguratorOperationError("Ange antingen fast stycktid eller formel");
  }
  if ((op.setupTime !== null && op.setupTime < 0) || (op.runTimePerUnit !== null && op.runTimePerUnit < 0)) {
    throw new InvalidConfiguratorOperationError("Tiderna får inte vara negativa");
  }
  const groups = formulaGroups(template);
  if (op.setupFormula !== null) assertFormula("Ställtid", op.setupFormula, groups);
  if (op.runFormula !== null) assertFormula("Stycktid", op.runFormula, groups);

  if (ctx.baseSequenceNos.has(op.sequenceNo) || ctx.otherSequenceNos.has(op.sequenceNo)) {
    throw new ConfiguratorSequenceTakenError(op.sequenceNo);
  }
}

// --- references --------------------------------------------------------------

type Refs = { groupIds: Set<string>; valueIds: Set<string> };

function collectRefs(items: unknown[]): Refs {
  const groupIds = new Set<string>();
  const valueIds = new Set<string>();
  for (const ref of items as { groupId?: unknown; valueIds?: unknown }[]) {
    if (typeof ref?.groupId === "string") groupIds.add(ref.groupId);
    if (Array.isArray(ref?.valueIds)) for (const id of ref.valueIds) if (typeof id === "string") valueIds.add(id);
  }
  return { groupIds, valueIds };
}

// Every group and alternative a rule points at (conditions + target).
export function ruleReferences(rule: Pick<EngineRule, "conditions" | "target">): Refs {
  return collectRefs([...rule.conditions, rule.target]);
}

// A line references its conditions' groups/alternatives and its component group.
export function lineReferences(line: Pick<ConfiguratorBomLineDetail, "conditions" | "componentGroupId">): Refs {
  const refs = collectRefs(line.conditions);
  if (line.componentGroupId) refs.groupIds.add(line.componentGroupId);
  return refs;
}

export function operationReferences(op: Pick<ConfiguratorOperationDetail, "conditions">): Refs {
  return collectRefs(op.conditions);
}

export type TemplateRows = {
  rules: Pick<ConfiguratorRuleDetail, "conditions" | "target" | "message">[];
  bomLines: Pick<ConfiguratorBomLineDetail, "conditions" | "componentGroupId" | "sortOrder" | "quantityFormula">[];
  operations: Pick<ConfiguratorOperationDetail, "conditions" | "sequenceNo" | "setupFormula" | "runFormula">[];
};

// "Strukturrad N" counts the lines in display order — the same N as the
// derivation's labels, independent of gaps in sort_order after deletes.
function linePosition<T extends { sortOrder: number }>(lines: T[]): [T, number][] {
  return [...lines].sort((a, b) => a.sortOrder - b.sortOrder).map((l, i) => [l, i + 1]);
}

// What a delete of groups/alternatives must not leave dangling: ids (conditions,
// component source) and the codes formulas spell them by — `codes` are group
// codes, `pairs` are `GROUP=ALT` for alternatives (a literal "EP" compared
// against another group is NOT a reference to FARG's EP).
export type ReferenceTargets = { groupIds?: string[]; valueIds?: string[]; codes?: string[]; pairs?: string[] };

function formulaUses(formula: string | null, codes: Set<string>, pairs: Set<string>): boolean {
  if (formula === null || (codes.size === 0 && pairs.size === 0)) return false;
  if (codes.size > 0 && [...formulaReferences(formula)].some((c) => codes.has(c))) return true;
  return pairs.size > 0 && [...formulaValueReferences(formula)].some((p) => pairs.has(p));
}

// Where the template refers to any of the targets — in conditions, as
// component source or in a formula — as the delete guard lists them:
// "Regel: <meddelande>", "Strukturrad <N>", "Operation <nr>" (each once).
export function templateReferences(template: TemplateRows, refs: ReferenceTargets): string[] {
  const groupIds = refs.groupIds ?? [];
  const valueIds = refs.valueIds ?? [];
  const codes = new Set(refs.codes ?? []);
  const pairs = new Set(refs.pairs ?? []);
  const hit = (r: Refs) => groupIds.some((id) => r.groupIds.has(id)) || valueIds.some((id) => r.valueIds.has(id));
  const out: string[] = [];
  for (const rule of template.rules) if (hit(ruleReferences(rule))) out.push(`Regel: ${rule.message}`);
  for (const [line, n] of linePosition(template.bomLines)) {
    if (hit(lineReferences(line)) || formulaUses(line.quantityFormula, codes, pairs)) out.push(`Strukturrad ${n}`);
  }
  for (const op of template.operations) {
    if (hit(operationReferences(op)) || formulaUses(op.setupFormula, codes, pairs) || formulaUses(op.runFormula, codes, pairs)) {
      out.push(`Operation ${op.sequenceNo}`);
    }
  }
  return out;
}

// Where a formula uses any of the codes/pairs — the rename lock for group and
// alternative codes (a code a formula spells may not change).
export function formulaUsers(template: Pick<TemplateRows, "bomLines" | "operations">, refs: Pick<ReferenceTargets, "codes" | "pairs">): string[] {
  return templateReferences({ rules: [], ...template }, refs);
}

// Both modes need a manufactured article (to_order: a TO is made from the
// template; variants: every variant is a manufactured article with the
// derived structure and route); a phantom is never a template.
export function assertModeAllowed(article: { type: string; isPhantom: boolean }, mode: ConfiguratorMode): void {
  if (article.isPhantom) throw new ConfiguratorModeNotAllowedError("En fantomartikel kan inte vara konfigurerbar");
  if (mode === "to_order" && article.type !== "manufactured") {
    throw new ConfiguratorModeNotAllowedError("Beställningsvara kräver en tillverkad artikel");
  }
  if (mode === "variants" && article.type !== "manufactured") {
    throw new ConfiguratorModeNotAllowedError("Variantartiklar kräver en tillverkad artikel");
  }
}

const FIELD_LABEL: Record<string, string> = {
  required: "Obligatorisk",
  priceAdd: "Tillägg",
  defaultValueId: "Förval",
  articleField: "Fyller artikelns fält",
  unit: "Enhet",
  minValue: "Min",
  maxValue: "Max",
  step: "Steg",
  defaultNumber: "Förval",
  pricePerUnit: "Pris per enhet",
  priceBaseValue: "Grundmått",
};

const FIELDS_FOR_KIND: Record<ConfiguratorGroupKind, ReadonlySet<string>> = {
  choice: new Set(["code", "name", "required", "defaultValueId", "articleField"]),
  boolean: new Set(["code", "name", "priceAdd"]),
  number: new Set(["code", "name", "required", "unit", "minValue", "maxValue", "step", "defaultNumber", "pricePerUnit", "priceBaseValue"]),
};

// The kind never changes, so a PATCH may only carry the fields of the group's
// own kind (the CHECK constraints would otherwise surface as a 500).
export function assertGroupFieldsMatchKind(kind: ConfiguratorGroupKind, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || FIELDS_FOR_KIND[kind].has(key)) continue;
    throw new InvalidConfiguratorGroupError(`${FIELD_LABEL[key] ?? key} gäller inte för ett ${KIND_LABEL[kind]}`);
  }
}
