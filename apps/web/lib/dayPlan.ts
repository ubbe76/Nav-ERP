// Dagplan — pure display helpers (no fetch, no React). The API owns the
// selection, the order, the load and the material status; these only turn
// them into the page's texts and into the id list the order PUT wants.
import type { MoveTarget } from "../components/planning/MoveOperationDialog";
import { formatQuantity } from "./format";
import { SUPPLIER_CONFIRMATION_TEXT } from "./overviewCardRows";
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
  // "finns", "saknas 4 st", "kommer 2 dec", "kommer, utan datum",
  // "försenad sedan 25 nov"
  text: string;
  // The document the missing material is expected on (IO or TO), if any.
  document: { kind: "purchase_order" | "manufacturing_order"; id: string; number: string; draft: boolean } | null;
  // The supply's own day has passed: not "coming" any more.
  overdue: boolean;
  // With a supply on its way: what nothing covers of the row all the same
  // ("saknas 8 st"), said after the document. null = the supply covers it.
  rest: string | null;
}

const missingText = (quantity: number, unit: string | null): string => `saknas ${formatQuantity(quantity)}${unit ? ` ${unit}` : ""}`;

// One material row of an operation as the page says it. The status is the
// API's (usable stock against this row alone); the supply is the pegging's.
export function materialText(m: RunPlanMaterial): MaterialText {
  if (m.status === "available") return { tone: "ok", text: "finns", document: null, overdue: false, rest: null };
  if (m.supply) {
    // An overdue supply carries its own day — never "kommer <today>".
    const text = !m.supply.date ? "kommer, utan datum" : m.supply.late ? `försenad sedan ${shortDate(m.supply.date)}` : `kommer ${shortDate(m.supply.date)}`;
    return {
      tone: "short",
      text,
      document: { kind: m.supply.kind, id: m.supply.documentId, number: m.supply.documentNumber, draft: m.supply.isDraft },
      overdue: m.supply.late,
      rest: m.missingQuantity > 0 ? missingText(m.missingQuantity, m.unit) : null,
    };
  }
  return { tone: "short", text: missingText(m.missingQuantity, m.unit), document: null, overdue: false, rest: null };
}

// The colour of a material state: on the shelf, on its way, or missing — an
// overdue supply is missing, not on its way.
export function materialTone(t: Pick<MaterialText, "tone" | "document" | "overdue">): "ok" | "coming" | "short" {
  if (t.tone === "ok") return "ok";
  return t.document && !t.overdue ? "coming" : "short";
}

// The whole state as one text: "kommer 2 dec · IO-88 · saknas 8 st",
// "försenad sedan 25 nov · IO-88 (utkast)". The cells render the same parts
// with the document as a link.
export function materialLine(t: Pick<MaterialText, "text" | "document" | "rest">): string {
  const document = t.document ? `${t.document.number}${t.document.draft ? " (utkast)" : ""}` : null;
  return [t.text, document, t.rest].filter((part): part is string => !!part).join(" · ");
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

// --- Visa: the view and its address --------------------------------------

// Körordning and Material are the körplan's two (lib/coRun.ts); Utleveranser
// and Inleveranser list the day's kundorder and inköpsorder rows
// (GET /planning/day-plan/orders) and are offered only with a menu — the
// API's read rule (customers and suppliers are office data).
export type DayPlanView = "order" | "material" | "shipments" | "arrivals";
export type DayPlanOrdersView = "shipments" | "arrivals";

const VISA_PARAMS: Record<DayPlanView, string | null> = {
  order: null,
  material: "material",
  shipments: "utleveranser",
  arrivals: "inleveranser",
};

// ?visa= → the view; an order list without the right is Körordning.
export function dayPlanView(param: string | null | undefined, canSeeOrders: boolean): DayPlanView {
  if (param === "material") return "material";
  if (canSeeOrders && param === "utleveranser") return "shipments";
  if (canSeeOrders && param === "inleveranser") return "arrivals";
  return "order";
}

// The view → ?visa= (null = Körordning, no parameter).
export function dayPlanVisa(view: DayPlanView): string | null {
  return VISA_PARAMS[view];
}

export function isOrdersView(view: DayPlanView): view is DayPlanOrdersView {
  return view === "shipments" || view === "arrivals";
}

// --- Utleveranser och Inleveranser -----------------------------------------

// "5 st" — the base unit after the quantity, when the article has one.
export function orderRowQuantity(quantity: number, unit: string | null): string {
  return unit ? `${formatQuantity(quantity)} ${unit}` : formatQuantity(quantity);
}

// Whether the supplier has given a date — the Översikten card's words
// (worded apart from the status Bekräftad, which only says it is sent).
export function arrivalConfirmationText(confirmed: boolean): string {
  return SUPPLIER_CONFIRMATION_TEXT[confirmed ? "confirmed" : "none"];
}

// A legorad: the TO operation the goods come back from.
export function legoText(lego: { orderNumber: string; sequenceNo: number }): string {
  return `Lego · ${lego.orderNumber} op ${lego.sequenceNo}`;
}

// The list's two parts: Försenade (the day has passed — only today) first,
// then the day's own rows, each in the API's order.
export function splitOverdue<T extends { overdue: boolean }>(rows: readonly T[]): { overdue: T[]; day: T[] } {
  return { overdue: rows.filter((r) => r.overdue), day: rows.filter((r) => !r.overdue) };
}

// The summary line: "4 rader på 3 ordrar".
export function orderRowsSummary(rows: readonly { orderNumber: string }[]): string {
  const orders = new Set(rows.map((r) => r.orderNumber)).size;
  return `${rows.length} ${rows.length === 1 ? "rad" : "rader"} på ${orders} ${orders === 1 ? "order" : "ordrar"}`;
}
