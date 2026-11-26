// Strukturvyn (/tillverkning/struktur) — the pure parts: which rows are
// shown, where a bar or a mark lands on the day axis and the texts of a row
// (web-structure.test.ts). Nothing is decided here: the tree, the late flags
// and the planned days are the API's (planning/service/structure-tree.ts),
// and every date is read from the response's `axis`/`today`, never from the
// browser's clock.
import type { MoveTarget } from "../components/planning/MoveOperationDialog";
import { COMPONENT_LATE_LABEL, outlookDate, outlookLabel, outlookTone, type OutlookTone } from "./deliveryOutlook";
import { formatQuantity } from "./format";
import { MANUFACTURING_ORDER_STATUS_PILL, type CoverageGoesTo, type StructureNode, type StructureOperation, type StructureResult } from "./types";

export type StructureAxis = StructureResult["axis"];
export type StructureOrderNode = Extract<StructureNode, { kind: "order" }>;

// POST /planning/unlock-orders takes at most this many orders per call.
export const UNLOCK_ORDERS_MAX = 200;
// The phone list indents at most this many steps, then shows the level.
export const NARROW_MAX_INDENT = 4;
// Operations are unfolded by default on the tree's two top levels.
export const OPERATIONS_OPEN_LEVEL = 1;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// --- Which rows are shown ---------------------------------------------------

// The nodes to draw, in the response's order (depth first): a collapsed
// node hides its whole branch, and a material row covered by stock alone is
// hidden with its leaf unless `showStock` (Visa material i lager).
export function visibleNodes(nodes: readonly StructureNode[], collapsed: ReadonlySet<string>, showStock: boolean): StructureNode[] {
  const hidden = new Set<string>();
  const out: StructureNode[] = [];
  for (const node of nodes) {
    const parentId = node.parentId;
    if (parentId !== null && (hidden.has(parentId) || collapsed.has(parentId))) {
      hidden.add(node.id);
      continue;
    }
    if (!showStock && node.kind === "material" && node.fromStockOnly) {
      hidden.add(node.id);
      continue;
    }
    out.push(node);
  }
  return out;
}

// The material rows Visa material i lager (N) unfolds.
export function stockOnlyCount(nodes: readonly StructureNode[]): number {
  return nodes.filter((n) => n.kind === "material" && n.fromStockOnly).length;
}

// The ids of the nodes that have something to fold: a child that is drawn
// with the current Visa material i lager.
export function foldableIds(nodes: readonly StructureNode[], showStock: boolean): Set<string> {
  const out = new Set<string>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    if (!showStock && node.kind === "material" && node.fromStockOnly) continue;
    out.add(node.parentId);
  }
  return out;
}

// The nodes above `id`, nearest first — what must be unfolded to show it.
export function ancestorIds(nodes: readonly StructureNode[], id: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (let parent = byId.get(id)?.parentId ?? null; parent !== null; parent = byId.get(parent)?.parentId ?? null) {
    if (out.includes(parent)) break;
    out.push(parent);
  }
  return out;
}

// Every TO in the tree once, in the order drawn (Lås upp strukturen).
export function structureOrderIds(nodes: readonly StructureNode[]): string[] {
  const ids = new Set<string>();
  for (const node of nodes) if (node.kind === "order") ids.add(node.manufacturingOrderId);
  return [...ids];
}

export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// The orders (drawn once) that have a locked operation.
export function lockedOrderCount(nodes: readonly StructureNode[]): number {
  return nodes.filter((n) => n.kind === "order" && n.repeatOf === null && n.lockedOperations > 0).length;
}

export function unlockStructureQuestion(operations: number, orders: number): string {
  return `Lås upp ${plural(operations, "operation", "operationer")} på ${plural(orders, "tillverkningsorder", "tillverkningsordrar")}? Dagarna står kvar tills nästa Planera.`;
}

export function unlockOrderQuestion(node: Pick<StructureOrderNode, "orderNumber" | "lockedOperations">): string {
  return `Lås upp ${plural(node.lockedOperations, "operation", "operationer")} på ${node.orderNumber}? Dagarna står kvar tills nästa Planera.`;
}

// The TO has a manufactured material nothing covers (Skapa saknade
// halvfabrikat…) / a halvfabrikat TO below it (Flytta halvfabrikaten…).
export function orderChildFacts(nodes: readonly StructureNode[], orderNodeId: string): { missingManufacturable: boolean; componentOrders: boolean } {
  const materialIds = new Set(nodes.filter((n) => n.kind === "material" && n.parentId === orderNodeId).map((n) => n.id));
  let missingManufacturable = false;
  let componentOrders = false;
  for (const node of nodes) {
    if (node.parentId === null || !materialIds.has(node.parentId)) continue;
    if (node.kind === "missing" && node.manufacturable) missingManufacturable = true;
    if (node.kind === "order") componentOrders = true;
  }
  return { missingManufacturable, componentOrders };
}

// --- The day axis -----------------------------------------------------------

// The column of a date; null outside the axis.
export function markerIndex(date: string | null, axis: StructureAxis): number | null {
  if (date === null || date < axis.from || date > axis.to) return null;
  const index = axis.days.findIndex((d) => d.date === date);
  return index === -1 ? null : index;
}

// A passed date is drawn on today, like the API's axis and bars.
export function flooredAtToday(date: string | null, today: string): string | null {
  return date !== null && date < today ? today : date;
}

export interface BarSegment {
  fromIndex: number;
  toIndex: number;
  hours: number;
}

// An operation's planned days as bars: consecutive axis days are one
// segment, a gap (a weekend, a red day) starts a new one. Days outside the
// axis are left out.
export function barSegments(op: Pick<StructureOperation, "days">, axis: StructureAxis): BarSegment[] {
  const indexed = op.days
    .map((d) => ({ index: markerIndex(d.date, axis), hours: d.hours }))
    .filter((d): d is { index: number; hours: number } => d.index !== null)
    .sort((a, b) => a.index - b.index);
  const out: BarSegment[] = [];
  for (const day of indexed) {
    const last = out[out.length - 1];
    if (last && day.index <= last.toIndex + 1) {
      last.toIndex = Math.max(last.toIndex, day.index);
      last.hours += day.hours;
    } else out.push({ fromIndex: day.index, toIndex: day.index, hours: day.hours });
  }
  return out;
}

// The TO's thin summary bar: first to last planned day, clipped to the axis.
export function spanSegment(start: string | null, end: string | null, axis: StructureAxis, today: string): { fromIndex: number; toIndex: number } | null {
  const from = flooredAtToday(start, today);
  const to = flooredAtToday(end ?? start, today);
  if (from === null || to === null || to < axis.from || from > axis.to) return null;
  const fromIndex = markerIndex(from < axis.from ? axis.from : from, axis);
  const toIndex = markerIndex(to > axis.to ? axis.to : to, axis);
  return fromIndex === null || toIndex === null ? null : { fromIndex, toIndex };
}

// The header's week row: one cell per ISO week with its number of columns.
export function axisWeeks(axis: StructureAxis): { isoWeek: number; fromIndex: number; span: number }[] {
  const out: { isoWeek: number; fromIndex: number; span: number }[] = [];
  axis.days.forEach((day, index) => {
    const last = out[out.length - 1];
    if (last && last.isoWeek === day.isoWeek) last.span += 1;
    else out.push({ isoWeek: day.isoWeek, fromIndex: index, span: 1 });
  });
  return out;
}

const WEEKDAY_LETTERS = ["M", "T", "O", "T", "F", "L", "S"];
export const weekdayLetter = (weekday: number): string => WEEKDAY_LETTERS[weekday - 1] ?? "";

// --- Texts ------------------------------------------------------------------

const quantity = (value: number) => formatQuantity(value);
const hours = (value: number) => value.toLocaleString("sv-SE", { maximumFractionDigits: 1 });

// "1–3 dec", "28 nov–2 dec", with the year when it is not today's.
export function dateRange(start: string, end: string | null, today: string): string {
  if (end === null || end === start) return outlookDate(start, today);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  return sameMonth ? `${Number(start.slice(8, 10))}–${outlookDate(end, today)}` : `${outlookDate(start, today)}–${outlookDate(end, today)}`;
}

export function daysLateText(days: number): string {
  return days > 0 ? `${plural(days, "dag", "dagar")} för sent` : "för sent";
}

// The row's first line: what the node is.
export function nodeTitle(node: StructureNode): { label: string; detail: string } {
  switch (node.kind) {
    case "sales_row":
      return { label: node.row.articleNumber, detail: node.row.articleName };
    case "order":
      return { label: node.orderNumber, detail: `${node.articleNumber} — ${node.articleName}` };
    case "material":
      return { label: node.articleNumber, detail: node.articleName };
    case "supply":
      return node.supply === "stock"
        ? { label: "Lager", detail: quantity(node.quantity) }
        : { label: node.documentNumber ?? "–", detail: `${quantity(node.quantity)}${node.isDraft ? " (utkast)" : ""}` };
    default:
      return { label: "Saknas", detail: quantity(node.quantity) };
  }
}

export function nodeHref(node: StructureNode): string | null {
  if (node.kind === "order") return `/tillverkning/ordrar/${node.manufacturingOrderId}`;
  if (node.kind === "supply" && node.supply === "purchase_order" && node.documentId !== null) return `/inkop/ordrar/${node.documentId}`;
  return null;
}

// One part of the row's second line. `onAxis` = the day axis shows the same
// thing (a bar or a mark), so the wide layout leaves the words out; a date
// beyond the axis is always said in words.
export interface NodeDate {
  text: string;
  onAxis: boolean;
}

// The row's second line: quantities and dates as text.
export function nodeDates(node: StructureNode, today: string, axis: StructureAxis): NodeDate[] {
  const out: NodeDate[] = [];
  const said = (text: string) => out.push({ text, onAxis: false });
  const drawn = (text: string, ...dates: (string | null)[]) =>
    out.push({ text, onAxis: dates.every((d) => d !== null && markerIndex(flooredAtToday(d, today), axis) !== null) });
  switch (node.kind) {
    case "sales_row":
      said(`rest ${quantity(node.row.restQuantity)}`);
      if (node.row.promisedShipDate) drawn(`avsändning ${outlookDate(node.row.promisedShipDate, today)}`, node.row.promisedShipDate);
      if (node.row.status === "late" && node.row.estimatedShipDate) said(`beräknad ${outlookDate(node.row.estimatedShipDate, today)}`);
      break;
    case "order": {
      said(`antal ${quantity(node.link?.quantity ?? node.remainingQuantity)}`);
      if (node.repeatOf !== null) break;
      const status = orderStatusNote(node.orderStatus);
      const lastDay = node.plannedEndDate ?? node.plannedStartDate;
      if (status) said(status);
      else if (node.plannedStartDate) drawn(`planerad ${dateRange(node.plannedStartDate, node.plannedEndDate, today)}`, node.plannedStartDate, lastDay);
      else said("ej planerad");
      // A lego last: ready after the last planned day.
      if (!status && node.plannedFinish && node.plannedFinish !== lastDay) said(`klar ${outlookDate(node.plannedFinish, today)}`);
      said(node.dueDate ? `färdigt ${outlookDate(node.dueDate, today)}` : "saknar färdigdatum");
      if (node.link?.needDate) drawn(`behövs ${outlookDate(node.link.needDate, today)}`, node.link.needDate);
      break;
    }
    case "material":
      said(`behov ${quantity(node.quantity)}`);
      if (node.needDate) drawn(`behövs ${outlookDate(node.needDate, today)}`, node.needDate);
      break;
    case "supply":
      if (node.supply === "purchase_order") said(node.undated || node.readyDate === null ? "saknar datum" : `inleverans ${outlookDate(node.readyDate, today)}`);
      break;
    default:
      break;
  }
  return out;
}

// A TO that is not in the plan: planned (not released), done or closed.
export function orderStatusNote(status: string): string | null {
  if (status === "released" || status === "in_progress" || status === "") return null;
  const known = (MANUFACTURING_ORDER_STATUS_PILL as Record<string, { label: string } | undefined>)[status];
  return known ? known.label.toLowerCase() : null;
}

export interface StructureMark {
  label: string;
  tone: OutlookTone;
  // The pill's tooltip, where the short label needs one.
  title?: string;
}

// The row's marks, worst first. `text` marks are drawn as coloured text
// (N dagar för sent), the others as pills.
export function nodeMarks(node: StructureNode): { pills: StructureMark[]; late: string | null; locked: number } {
  const pills: StructureMark[] = [];
  let late: string | null = null;
  let locked = 0;
  switch (node.kind) {
    case "sales_row":
      pills.push({ label: outlookLabel(node.row), tone: outlookTone(node.row) });
      if (node.row.componentLate) pills.push({ label: COMPONENT_LATE_LABEL, tone: "delayed" });
      break;
    case "order":
      if (node.link?.late) late = daysLateText(node.link.daysLate);
      else if (node.link?.undated) late = "saknar färdigdatum";
      if (node.repeatOf !== null) break;
      if (node.late) pills.push({ label: "Sen", tone: "delayed", title: "Planerad klar efter färdigdatumet" });
      if (node.componentLate) {
        pills.push({ label: COMPONENT_LATE_LABEL, tone: "delayed", title: "En halvfabrikat-TO som ordern behöver blir klar efter behovet" });
      }
      locked = node.lockedOperations;
      break;
    case "supply":
      if (node.late) late = daysLateText(node.daysLate);
      break;
    default:
      break;
  }
  return { pills, late, locked };
}

export const lockedText = (count: number): string => plural(count, "låst", "låsta");

// "op 10 Skär · 110"
export function operationTitle(op: Pick<StructureOperation, "sequenceNo" | "description" | "workCenterCode">): string {
  return `op ${op.sequenceNo}${op.description ? ` ${op.description}` : ""}${op.workCenterCode ? ` · ${op.workCenterCode}` : ""}`;
}

// The operation's own text: Lego · N dagar, klar, the planned days.
export function operationDates(op: StructureOperation, today: string): string {
  if (op.status === "done") return "klar";
  if (op.subcontract) return op.subcontractDays === null ? "Lego" : `Lego · ${plural(op.subcontractDays, "dag", "dagar")}`;
  const planned = op.plannedStartDate ? dateRange(op.plannedStartDate, op.plannedEndDate, today) : "ej planerad";
  return `${planned} · ${hours(op.remainingHours)} h kvar`;
}

// Flytta… is offered on an own operation that is not done.
export const operationMovable = (op: Pick<StructureOperation, "status" | "subcontract">): boolean => op.status === "pending" && !op.subcontract;

// The tree's operation as MoveOperationDialog's target (no day loads: the
// tree never loaded the resource's days).
export function moveTargetOf(node: StructureOrderNode, op: StructureOperation): MoveTarget {
  return {
    order: {
      moOperationId: op.moOperationId,
      orderNumber: node.orderNumber,
      articleNumber: node.articleNumber,
      articleName: node.articleName,
      sequenceNo: op.sequenceNo,
      remainingHours: op.remainingHours,
      plannedStartDate: op.plannedStartDate,
      plannedEndDate: op.plannedEndDate,
      planLocked: op.planLocked,
    },
    resource: { code: op.workCenterCode, name: op.workCenterName },
  };
}

// "3 tillverkningsordrar · 1 sen · 1 halvfabrikat sent · 2 låsta operationer · 1 saknas"
export function totalsText(totals: StructureResult["totals"]): string {
  const parts = [plural(totals.orders, "tillverkningsorder", "tillverkningsordrar")];
  if (totals.lateOrders > 0) parts.push(plural(totals.lateOrders, "sen", "sena"));
  if (totals.componentLate > 0) parts.push(`${totals.componentLate} med halvfabrikat sent`);
  if (totals.lockedOperations > 0) parts.push(plural(totals.lockedOperations, "låst operation", "låsta operationer"));
  if (totals.missing > 0) parts.push(`${totals.missing} saknas`);
  return parts.join(" · ");
}

export function truncatedNotices(truncated: StructureResult["truncated"], limits = { depth: 10, nodes: 600 }): string[] {
  const out: string[] = [];
  if (truncated.depth || truncated.nodes) {
    const why = [truncated.depth ? `fler än ${limits.depth} nivåer` : null, truncated.nodes ? `fler än ${limits.nodes} rader` : null].filter(Boolean).join(" / ");
    out.push(`Trädet är avkortat (${why})`);
  }
  for (const articleNumber of truncated.cycle) out.push(`Strukturen går runt på artikel ${articleNumber}`);
  return out;
}

// Går till (S24): one level up — the parent TO's or the kundorder's own
// structure; a negative stock balance has none.
export function goesToLink(g: Pick<CoverageGoesTo, "kind" | "documentId" | "documentNumber">): { href: string; label: string } | null {
  if (g.documentId === null || g.kind === "stock") return null;
  const param = g.kind === "sales_order" ? "ko" : "to";
  return { href: `/tillverkning/struktur?${param}=${g.documentId}`, label: `Öppna strukturen för ${g.documentNumber ?? "ordern"}` };
}

export function goesToText(g: CoverageGoesTo, today: string): string {
  const parts = [g.kind === "stock" ? "Negativt lagersaldo" : `${g.documentNumber ?? "–"}${g.partner ? ` · ${g.partner}` : ""}`];
  parts.push(`antal ${quantity(g.quantity)}`);
  parts.push(g.needDate ? `behövs ${outlookDate(g.needDate, today)}` : "saknar datum");
  if (g.late) parts.push(daysLateText(g.daysLate));
  return parts.join(" · ");
}

export const structureHref = (root: { to: string } | { ko: string }): string =>
  "to" in root ? `/tillverkning/struktur?to=${root.to}` : `/tillverkning/struktur?ko=${root.ko}`;
