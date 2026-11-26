// Dagplan — pure display helpers (no fetch, no React). The API owns the
// selection, the order, the load and the material status; these only turn
// them into the page's texts and into the id list the order PUT wants.
import type { MoveTarget } from "../components/planning/MoveOperationDialog";
import { formatQuantity } from "./format";
import { shortDate } from "./planning";
import type { CapacityDayLoad, DayPlanResource, RunPlanMaterial, RunPlanRow } from "./types";

// The list with the item at `from` moved to index `to` (its place in the
// result). Out of range, or nothing to move: the same order back.
export function reorderIds<T>(ids: readonly T[], from: number, to: number): T[] {
  const next = [...ids];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

// Where a dragged row lands when it is dropped on the row at `target`: before
// it, or after it. The index is the one reorderIds takes.
export function dropIndex(from: number, target: number, after: boolean): number {
  const insertAt = after ? target + 1 : target;
  return from < insertAt ? insertAt - 1 : insertAt;
}

// The day's ids that take part in Ordningen inom dagen — exactly what
// PUT /planning/run-plan/order wants (never an unplanned row on its due date).
export function reorderableIds(rows: readonly RunPlanRow[]): string[] {
  return rows.flatMap((row) => (row.reorderable && row.moOperationId ? [row.moOperationId] : []));
}

// The readiness of a körplan row, in the PDF's words (Körplan and Dagplan).
export function runPlanStatusText(row: Pick<RunPlanRow, "status" | "available" | "waitingForSequenceNo">): string {
  switch (row.status) {
    case "planned_order":
      return "Planerad TO";
    case "ready":
      return "Redo";
    case "partial":
      return `${formatQuantity(row.available ?? 0)} redo · väntar på op ${row.waitingForSequenceNo ?? ""}`.trim();
    default:
      return `Väntar på op ${row.waitingForSequenceNo ?? ""}`.trim();
  }
}

// The StatusPill tone of each readiness.
export const RUN_PLAN_STATUS_PILL: Record<RunPlanRow["status"], "draft" | "done" | "delayed" | "stopped"> = {
  planned_order: "draft",
  ready: "done",
  partial: "delayed",
  not_ready: "stopped",
};

const hours = (value: number): string => value.toLocaleString("sv-SE", { maximumFractionDigits: 1 });

// "6,5 h av 8 h", "9 h av 8 h · överbelagd", "3 h · ingen kapacitet"; only
// the load when the resource has no capacity calendar. Överbelagd is the
// API's flag, never computed here.
export function loadText(load: CapacityDayLoad): string {
  if (load.availableHours === null) return `${hours(load.loadHours)} h`;
  if (load.availableHours <= 0) return load.loadHours > 0 ? `${hours(load.loadHours)} h · ingen kapacitet` : "ingen kapacitet";
  const text = `${hours(load.loadHours)} h av ${hours(load.availableHours)} h`;
  return load.overloaded ? `${text} · överbelagd` : text;
}

// The share of the day's capacity that is loaded, 0–100 for the bar; null
// when there is no capacity to measure against.
export function loadPercent(load: CapacityDayLoad): number | null {
  if (load.availableHours === null || load.availableHours <= 0) return null;
  return Math.min(100, Math.max(0, Math.round((load.loadHours / load.availableHours) * 100)));
}

export interface MaterialText {
  // ok = on the shelf; short = the row cannot be drawn from the usable stock.
  tone: "ok" | "short";
  // "finns", "saknas 4 st", "kommer 2 dec", "kommer, utan datum"
  text: string;
  // The document the missing material is expected on (IO or TO), if any.
  document: { kind: "purchase_order" | "manufacturing_order"; id: string; number: string; draft: boolean } | null;
}

// One material row of an operation as the page says it. The status is the
// API's (usable stock against this row alone); the supply is the pegging's.
export function materialText(m: RunPlanMaterial): MaterialText {
  if (m.status === "available") return { tone: "ok", text: "finns", document: null };
  if (m.supply) {
    return {
      tone: "short",
      text: m.supply.date ? `kommer ${shortDate(m.supply.date)}` : "kommer, utan datum",
      document: { kind: m.supply.kind, id: m.supply.documentId, number: m.supply.documentNumber, draft: m.supply.isDraft },
    };
  }
  return { tone: "short", text: `saknas ${formatQuantity(m.missingQuantity)}${m.unit ? ` ${m.unit}` : ""}`, document: null };
}

// The card the supply's document number links to.
export function materialDocumentHref(document: NonNullable<MaterialText["document"]>): string {
  return document.kind === "purchase_order" ? `/inkop/ordrar/${document.id}` : `/tillverkning/ordrar/${document.id}`;
}

// Pågår: "Anna", "Anna (paus)".
export function stampText(stamp: { name: string; paused: boolean }): string {
  return stamp.paused ? `${stamp.name} (paus)` : stamp.name;
}

// What Flytta… reads of a körplan row: the operation, and the shown day's
// load for "ledigt 3 h av 8". null for a row that is not an operation.
export function moveTargetOf(row: RunPlanRow, resource: Pick<DayPlanResource, "workCenter" | "load">): MoveTarget | null {
  if (!row.moOperationId) return null;
  return {
    order: {
      moOperationId: row.moOperationId,
      orderNumber: row.orderNumber,
      articleNumber: row.articleNumber,
      articleName: row.articleName,
      sequenceNo: row.sequenceNo,
      remainingHours: row.remainingHours,
      plannedStartDate: row.plannedStartDate,
      plannedEndDate: row.plannedEndDate,
      planLocked: row.planLocked,
    },
    resource: { code: resource.workCenter.code, name: resource.workCenter.name, dayLoads: [resource.load] },
  };
}

// The resources split into those with something to show and the rest (named
// on one closing line).
export function splitResources(resources: readonly DayPlanResource[]): { busy: DayPlanResource[]; idle: DayPlanResource[] } {
  const busy: DayPlanResource[] = [];
  const idle: DayPlanResource[] = [];
  for (const r of resources) (r.carried.length > 0 || r.rows.length > 0 || r.unplannedRows > 0 ? busy : idle).push(r);
  return { busy, idle };
}

// The page's own address with the day and the group ("?dag=&grupp="), for the
// link between the page and Mötesläget, and the page's view ("&visa=material").
export function dayPlanHref(base: string, params: { dag?: string | null; grupp?: string | null; visa?: string | null }): string {
  const qs = new URLSearchParams();
  if (params.dag) qs.set("dag", params.dag);
  if (params.grupp) qs.set("grupp", params.grupp);
  if (params.visa) qs.set("visa", params.visa);
  const query = qs.toString();
  return query ? `${base}?${query}` : base;
}
