// Planera efter material och Samkör — pure helpers (no fetch, no React). The
// API owns the grouping (materialGroups / unlinkedRowKeys), the moves and the
// order; these only say which rows may be chosen, what the dialog starts on,
// what is sent and how the answer reads.
import { formatQuantity } from "./format";
import { plannedDateLabel, weekdayShortDate } from "./planning";
import type { CapacityDayLoad, CoRunInput, CoRunResult, RunPlanMaterial, RunPlanMaterialGroup, RunPlanRow } from "./types";

// Visa: Körordning | Material — the URL's ?visa=material.
export type RunPlanView = "order" | "material";

export function runPlanView(param: string | null | undefined): RunPlanView {
  return param === "material" ? "material" : "order";
}

// A row that can take part in a co-run: an operation of an open order (never
// a Planerad TO's row) with time left to plan.
export function selectableForCoRun(row: Pick<RunPlanRow, "moOperationId" | "status" | "remainingMinutes">): boolean {
  return row.moOperationId !== null && row.status !== "planned_order" && row.remainingMinutes >= 0.01;
}

// The day the dialog starts on: the earliest planned start among the chosen
// that has not passed, otherwise today (the server's Stockholm day).
export function defaultCoRunDate(rows: readonly Pick<RunPlanRow, "plannedStartDate">[], today: string): string {
  let earliest: string | null = null;
  for (const row of rows) {
    const start = row.plannedStartDate;
    if (start && start >= today && (earliest === null || start < earliest)) earliest = start;
  }
  return earliest ?? today;
}

// What both co-run routes take: the chosen operations in the order given
// (the order the list showed them), each once, with the start day the list
// showed — the write refuses when it no longer holds.
export function coRunPayload(
  workCenterId: string,
  date: string,
  rows: readonly Pick<RunPlanRow, "moOperationId" | "plannedStartDate">[]
): CoRunInput {
  const seen = new Set<string>();
  const operations: CoRunInput["operations"] = [];
  for (const row of rows) {
    if (!row.moOperationId || seen.has(row.moOperationId)) continue;
    seen.add(row.moOperationId);
    operations.push({ moOperationId: row.moOperationId, plannedStartDate: row.plannedStartDate });
  }
  return { workCenterId, date, operations };
}

// The chosen rows in the order of the list — a row standing in two material
// groups is one operation and comes once.
export function selectedInListOrder(rows: readonly RunPlanRow[], selected: ReadonlySet<string>): RunPlanRow[] {
  const seen = new Set<string>();
  const result: RunPlanRow[] = [];
  for (const row of rows) {
    const id = row.moOperationId;
    if (!id || !selected.has(id) || seen.has(id) || !selectableForCoRun(row)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
}

export interface MaterialSections {
  // One per material, in the API's order, with its rows in the list's order.
  groups: { group: RunPlanMaterialGroup; rows: RunPlanRow[] }[];
  // Utan kopplat material — the API's unlinkedRowKeys.
  unlinked: RunPlanRow[];
  // Materialet uttaget — linked purchased material, nothing left to draw.
  drawn: RunPlanRow[];
  // Whatever is left (a Planerad TO's row has no material rows yet).
  other: RunPlanRow[];
}

// Every listed row in at least one section, so nothing disappears in the
// Material view. The groups and the unlinked keys are the API's; a row in
// neither is either fully drawn or has no material rows at all.
export function materialSections(
  rows: readonly RunPlanRow[],
  groups: readonly RunPlanMaterialGroup[],
  unlinkedRowKeys: readonly string[]
): MaterialSections {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const placed = new Set<string>();
  const pick = (keys: readonly string[]): RunPlanRow[] =>
    keys.flatMap((key) => {
      const row = byKey.get(key);
      if (!row) return [];
      placed.add(key);
      return [row];
    });
  const grouped = groups.map((group) => ({ group, rows: pick(group.rowKeys) })).filter((g) => g.rows.length > 0);
  const unlinked = pick(unlinkedRowKeys);
  const drawn: RunPlanRow[] = [];
  const other: RunPlanRow[] = [];
  for (const row of rows) {
    if (placed.has(row.key)) continue;
    (row.materialLinked ? drawn : other).push(row);
  }
  return { groups: grouped, unlinked, drawn, other };
}

const withUnit = (quantity: number, unit: string | null): string => `${formatQuantity(quantity)}${unit ? ` ${unit}` : ""}`;

// "behov 14,5 st · användbart saldo 22 st" — the group together against the
// article's whole usable balance (the competition a row's own status hides).
export function materialGroupText(group: Pick<RunPlanMaterialGroup, "totalRemainingQuantity" | "usableOnHand" | "unit">): string {
  return `behov ${withUnit(group.totalRemainingQuantity, group.unit)} · användbart saldo ${withUnit(group.usableOnHand, group.unit)}`;
}

// The row's own need of one article ("4 st"); the same article on two
// material rows of the operation counts together. null = the row has none.
export function rowMaterialNeed(row: Pick<RunPlanRow, "materials">, articleId: string): { text: string; material: RunPlanMaterial } | null {
  const own = row.materials.filter((m) => m.articleId === articleId);
  if (own.length === 0) return null;
  const sum = own.reduce((total, m) => total + m.remainingQuantity, 0);
  // Four decimals, as the API rounds the group's total.
  return { text: withUnit(Number(sum.toFixed(4)), own[0]!.unit), material: own.find((m) => m.status === "short") ?? own[0]! };
}

// One chosen operation in the dialog: "tors 26 nov → ons 2 dec", "ligger
// redan på dagen", "ryms inte inom två år".
export function coRunOperationText(op: Pick<CoRunResult["operations"][number], "outcome" | "fromDate" | "plannedStartDate" | "plannedEndDate">): string {
  if (op.outcome === "already_on_day") return "ligger redan på dagen";
  if (op.outcome === "not_placed" || !op.plannedStartDate) return "ryms inte inom två år";
  const from = op.fromDate ? weekdayShortDate(op.fromDate) : "ej planerad";
  const to = weekdayShortDate(op.plannedStartDate);
  const end = op.plannedEndDate && op.plannedEndDate !== op.plannedStartDate ? ` (klar ${weekdayShortDate(op.plannedEndDate)})` : "";
  return `${from} → ${to}${end}`;
}

// Flyttas också: "tors 26 nov → 27–28 nov", "tors 26 nov → ej planerad".
export function coRunFollowingText(op: Pick<CoRunResult["following"][number], "fromStartDate" | "plannedStartDate" | "plannedEndDate">): string {
  const from = op.fromStartDate ? weekdayShortDate(op.fromStartDate) : "ej planerad";
  const to = op.plannedStartDate ? (plannedDateLabel(op.plannedStartDate, op.plannedEndDate) ?? "") : "ej planerad";
  return `${from} → ${to}`;
}

const hours = (value: number): string => value.toLocaleString("sv-SE", { maximumFractionDigits: 1 });

// Dagens last: "4,2 h → 9,8 h av 8 h", with "· överbelagd" / "· ingen
// kapacitet" from the API's own flags of the day afterwards.
export function coRunLoadText(load: { before: CapacityDayLoad; after: CapacityDayLoad }): string {
  const change = `${hours(load.before.loadHours)} h → ${hours(load.after.loadHours)} h`;
  const available = load.after.availableHours;
  if (available === null) return change;
  if (available <= 0) return `${change} · ingen kapacitet`;
  const text = `${change} av ${hours(available)} h`;
  return load.after.overloaded ? `${text} · överbelagd` : text;
}
