// apps/api/src/modules/configurator/service/structure-coverage.ts
import type { ConfiguratorCondition } from "@navet/shared";
import type { EffectiveValue, EngineGroup } from "./configurator-engine.js";
import type { DeriveBomLine } from "./configurator-derive.js";

// Produktkonfigurator — täckningsvarning. Pure (no DB imports).
//
// Structure lines that differ only in one "is"-condition on a choice group form a FAMILY for that group: the
// painted lid per colour ("Typ av lock är Lock" + "Färg är X"), the painted body per colour ("Färg är X").
// The rest of the conditions is the family's context. A family of at least two lines that leaves an ACTIVE
// alternative of its group uncovered is a gap — typically a colour added to the group without its parts, which
// would otherwise derive a structure that silently lacks them. One line alone is never a family (a sticker
// only for black is deliberate). A line can sit in several families (one per "is"-condition). Rules that make
// a combination impossible are not consulted, so a gap may name a combination no one can choose — it is a
// warning, never a block.

export type CoverageGap = {
  groupId: string;
  missingValueIds: string[]; // in the group's alternative order
  context: ConfiguratorCondition[]; // the family's other conditions, as stored on its first line
  lineNumbers: number[]; // 1-based positions in sort order — the N in "Strukturrad N"
};

// Order-insensitive identity of a condition set (value lists sorted too).
function contextKey(conditions: ConfiguratorCondition[]): string {
  return conditions
    .map((c) => JSON.stringify("valueIds" in c ? { ...c, valueIds: [...c.valueIds].sort() } : c))
    .sort()
    .join("|");
}

export function findCoverageGaps(groups: EngineGroup[], lines: DeriveBomLine[]): CoverageGap[] {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const families = new Map<string, { groupId: string; context: ConfiguratorCondition[]; covered: Set<string>; lineNumbers: number[] }>();

  [...lines].sort((a, b) => a.sortOrder - b.sortOrder).forEach((l, i) => {
    l.conditions.forEach((c, ci) => {
      if (c.op !== "is" || groupsById.get(c.groupId)?.kind !== "choice") return;
      const context = l.conditions.filter((_, j) => j !== ci);
      if (context.some((o) => o.groupId === c.groupId)) return; // two conditions on the same group: not a split
      const key = `${c.groupId}#${contextKey(context)}`;
      const family = families.get(key) ?? { groupId: c.groupId, context, covered: new Set<string>(), lineNumbers: [] };
      c.valueIds.forEach((v) => family.covered.add(v));
      family.lineNumbers.push(i + 1);
      families.set(key, family);
    });
  });

  const gaps: CoverageGap[] = [];
  for (const f of families.values()) {
    if (f.lineNumbers.length < 2) continue;
    const group = groupsById.get(f.groupId)!;
    const missingValueIds = [...group.values]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter((v) => v.active && !f.covered.has(v.id))
      .map((v) => v.id);
    if (missingValueIds.length > 0) gaps.push({ groupId: f.groupId, missingValueIds, context: f.context, lineNumbers: f.lineNumbers });
  }
  return gaps;
}

const OP_TEXT: Record<ConfiguratorCondition["op"], string> = {
  is: "är", is_not: "är inte", selected: "är vald", not_selected: "är inte vald",
  eq: "=", ne: "≠", lt: "<", le: "≤", gt: ">", ge: "≥",
};

// "A", "A och B", "A, B och C".
function list(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} och ${items[items.length - 1]}`;
}

function valueName(groupsById: Map<string, EngineGroup>, groupId: string, valueId: string): string {
  return groupsById.get(groupId)?.values.find((v) => v.id === valueId)?.name ?? "?";
}

// Same wording as the rule editor: "Typ av lock är Lock", "Hjul är vald", "Bredd > 2000 mm".
function conditionText(c: ConfiguratorCondition, groupsById: Map<string, EngineGroup>): string {
  const group = groupsById.get(c.groupId);
  const name = group?.name ?? "?";
  if ("valueIds" in c) {
    return `${name} ${OP_TEXT[c.op]} ${c.valueIds.map((v) => valueName(groupsById, c.groupId, v)).join(" eller ")}`;
  }
  if (!("value" in c)) return `${name} ${OP_TEXT[c.op]}`;
  return `${name} ${OP_TEXT[c.op]} ${String(c.value).replace(".", ",")}${group?.unit ? ` ${group.unit}` : ""}`;
}

const contextText = (context: ConfiguratorCondition[], groupsById: Map<string, EngineGroup>) =>
  context.length === 0 ? "" : ` om ${context.map((c) => conditionText(c, groupsById)).join(" och ")}`;

const linesText = (numbers: number[]) => `strukturrad ${list(numbers.map(String))}`;

// The template's own list (fliken Konfigurator), one warning per gap.
export function coverageWarnings(groups: EngineGroup[], gaps: CoverageGap[]): string[] {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  return gaps.map((g) => {
    const names = g.missingValueIds.map((v) => valueName(groupsById, g.groupId, v));
    const alternatives = names.length === 1 ? `alternativet ${names[0]}` : `alternativen ${list(names)}`;
    return `${groupsById.get(g.groupId)?.name ?? "?"}: ${alternatives} saknar strukturrad${contextText(g.context, groupsById)} — ${linesText(g.lineNumbers)} täcker de övriga alternativen`;
  });
}

// The gaps one configuration falls into: its alternative is missing and the family's context holds.
export function selectionCoverageWarnings(
  groups: EngineGroup[],
  gaps: CoverageGap[],
  effective: Map<string, EffectiveValue>,
  holds: (conditions: ConfiguratorCondition[]) => boolean
): string[] {
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  return gaps
    .filter((g) => {
      const valueId = effective.get(g.groupId)?.valueId ?? null;
      return valueId !== null && g.missingValueIds.includes(valueId) && holds(g.context);
    })
    .map((g) => {
      const valueId = effective.get(g.groupId)!.valueId!;
      return `${groupsById.get(g.groupId)?.name ?? "?"} är ${valueName(groupsById, g.groupId, valueId)} men ingen strukturrad motsvarar ${linesText(g.lineNumbers)} — den delen kommer inte med`;
    });
}
