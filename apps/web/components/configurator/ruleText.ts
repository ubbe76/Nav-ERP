import {
  CONDITION_OP_LABELS,
  type ConfiguratorCondition,
  type ConfiguratorGroupDetail,
  type ConfiguratorRuleDetail,
} from "../../lib/configurator";

const MISSING = "(borttagen)";

function plain(n: number | string): string {
  return String(Number(n));
}

function valueNames(group: ConfiguratorGroupDetail | undefined, ids: string[]): string[] {
  return ids.map((id) => group?.values.find((v) => v.id === id)?.name ?? MISSING);
}

// "Ytbehandling är Elpolerad eller Blästrad", "Hjul är vald", "Bredd > 2000 mm".
export function conditionText(c: ConfiguratorCondition, groups: ConfiguratorGroupDetail[]): string {
  const group = groups.find((g) => g.id === c.groupId);
  const name = group?.name ?? MISSING;
  const op = CONDITION_OP_LABELS[c.op];
  if (c.op === "is" || c.op === "is_not") {
    return `${name} ${op} ${valueNames(group, c.valueIds).join(" eller ")}`;
  }
  if (c.op === "selected" || c.op === "not_selected") return `${name} ${op}`;
  const value = (c as { value: number }).value;
  return `${name} ${op} ${plain(value)}${group?.unit ? ` ${group.unit}` : ""}`;
}

// "Alltid" or "Om A är X och B är vald" — the condition part of rules, lines and operations.
export function conditionsText(conditions: ConfiguratorCondition[], groups: ConfiguratorGroupDetail[]): string {
  return conditions.length === 0 ? "Alltid" : `Om ${conditions.map((c) => conditionText(c, groups)).join(" och ")}`;
}

// Reads like the rule editor: "Om A är X → utesluter B: Y — ..." (the message is
// appended by the caller).
export function ruleText(
  rule: Pick<ConfiguratorRuleDetail, "effect" | "conditions" | "target">,
  groups: ConfiguratorGroupDetail[],
): string {
  const when = conditionsText(rule.conditions, groups);
  const target = rule.target;
  const group = groups.find((g) => g.id === target.groupId);
  let then: string;
  if (rule.effect === "exclude") {
    const ids = "valueIds" in target ? target.valueIds : [];
    then = `utesluter ${group?.name ?? MISSING}: ${valueNames(group, ids).join(", ")}`;
  } else if (rule.effect === "require") {
    then = `kräver ${conditionText(target as ConfiguratorCondition, groups)}`;
  } else {
    const t = target as { min?: number; max?: number };
    const unit = group?.unit ? ` ${group.unit}` : "";
    let range: string;
    if (t.min !== undefined && t.max !== undefined) range = `${plain(t.min)}–${plain(t.max)}`;
    else if (t.max !== undefined) range = `högst ${plain(t.max)}`;
    else range = `minst ${plain(t.min ?? 0)}`;
    then = `begränsar ${group?.name ?? MISSING} till ${range}${unit}`;
  }
  return `${when} → ${then}`;
}
