import type { ConfiguratorEvaluation, ConfiguratorGroupKind, VariantSelectionEntry } from "./configurator";

// Pure mirror of apps/api/src/modules/configurator/service/configuration-lines.ts
// (the web cannot import @navet/shared / the API). Guarded by
// apps/api/test/configuration-lines.test.ts.

const fmt = (n: number, decimals: number) =>
  n
    .toLocaleString("sv-SE", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace("−", "-")
    .replace(/[  ]/g, " ");

export function formatMeasure(n: number): string {
  if (n === 0) n = 0; // −0 would print "-0"
  const decimals = Number.isInteger(n) ? 0 : Math.min(4, (String(Number(n.toFixed(4))).split(".")[1] ?? "").length);
  return fmt(n, decimals);
}

export function configurationLines(
  selection: VariantSelectionEntry[],
  additions?: { groupCode: string; amount: number }[],
): string[] {
  const addedByGroup = new Map<string, number>();
  for (const a of additions ?? []) addedByGroup.set(a.groupCode, (addedByGroup.get(a.groupCode) ?? 0) + a.amount);
  const lines: string[] = [];
  for (const e of selection) {
    let value: string | null = null;
    if (e.kind === "choice") value = e.valueName;
    else if (e.kind === "boolean") value = e.value === true ? "Ja" : null;
    else if (typeof e.value === "number") value = `${formatMeasure(e.value)}${e.unit ? ` ${e.unit}` : ""}`;
    if (value === null) continue;
    const added = addedByGroup.get(e.groupCode) ?? 0;
    const suffix = additions && added !== 0 ? ` (${added > 0 ? "+" : "-"} ${fmt(Math.abs(added), 2)})` : "";
    lines.push(`${e.groupName}: ${value}${suffix}`);
  }
  return lines;
}

// The lines for a not-yet-saved configuration: the evaluation carries only
// group codes and value codes, so names come from the template's groups.
export function draftLines(
  groups: { code: string; name: string; kind: ConfiguratorGroupKind; unit: string | null; values: { code: string; name: string }[] }[],
  evaluation: ConfiguratorEvaluation,
): string[] {
  const entries: VariantSelectionEntry[] = groups.map((g) => {
    const v = evaluation.groups.find((x) => x.code === g.code)?.value ?? null;
    const value = g.kind === "choice" && typeof v === "string" ? g.values.find((x) => x.code === v) : undefined;
    return { groupCode: g.code, groupName: g.name, kind: g.kind, valueCode: value?.code ?? null, valueName: value?.name ?? null, value: v, unit: g.unit };
  });
  return configurationLines(entries);
}
