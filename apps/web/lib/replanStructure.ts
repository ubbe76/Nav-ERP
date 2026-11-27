// Planera om strukturen — pure helpers (no fetch, no React). The API owns the
// tree, the choice (selectable/included), the days and every note; these only
// say what the dialog's form asks for, what a ticked box changes, what is
// sent and how the answer reads. Every date is the response's — never the
// browser's clock.
import { plannedDateLabel, shortDate } from "./planning";
import type {
  ReplanDateRange,
  ReplanExpectedOrder,
  ReplanStructureOrder,
  ReplanStructureRequest,
  ReplanStructureResult,
} from "./types";

// The dialog's form. `chosen` = the ticked halvfabrikat; null until the first
// preview has answered with the default choice.
export interface ReplanForm {
  dueDate: string; // the date field; "" = leave the top's färdigdatum
  moveComponentDueDates: boolean;
  chosen: readonly string[] | null;
}

// What the write takes: the preview's request with the choice the preview
// answered and its `expected`, unchanged.
export interface ReplanStructureWrite {
  dueDate: string | null;
  moveComponentDueDates: boolean;
  includeOrderIds: string[];
  expected: ReplanExpectedOrder[];
}

// The halvfabrikat the answer planned (the top is always in and never sent).
export function includedIds(result: Pick<ReplanStructureResult, "orders">): string[] {
  return result.orders.filter((o) => o.level > 0 && o.included).map((o) => o.manufacturingOrderId);
}

// The halvfabrikat that may be ticked in the shown answer: open, and the
// parent is chosen (the API's `selectable`).
export function selectableOrders(result: Pick<ReplanStructureResult, "orders">): ReplanStructureOrder[] {
  return result.orders.filter((o) => o.level > 0 && o.selectable);
}

// The top's färdigdatum as stored (the answer's `before`).
export function currentDueDate(result: Pick<ReplanStructureResult, "orders">): string | null {
  return result.orders[0]?.dueDate.before ?? null;
}

// A ticked or unticked box. Unticking takes the TO's whole branch with it (a
// halvfabrikat under a TO that is not chosen cannot be planned — the tree
// must hang together); ticking adds that TO only, and only when the shown
// answer says it may be chosen. The result is in the tree's order.
export function toggleInclude(
  result: Pick<ReplanStructureResult, "orders">,
  chosen: readonly string[],
  id: string
): string[] {
  const now = new Set(chosen);
  if (now.has(id)) {
    const gone = new Set([id]);
    // Depth first: a parent always stands before its children.
    for (const order of result.orders) {
      if (order.parentOrderId !== null && gone.has(order.parentOrderId)) gone.add(order.manufacturingOrderId);
    }
    for (const g of gone) now.delete(g);
  } else {
    const order = result.orders.find((o) => o.manufacturingOrderId === id);
    if (!order || order.level === 0 || !order.selectable) return [...chosen];
    now.add(id);
  }
  return result.orders.filter((o) => o.level > 0 && now.has(o.manufacturingOrderId)).map((o) => o.manufacturingOrderId);
}

// What the preview is asked: an empty field, or the date the top already
// has, is "leave it" (null); the choice is left out until there is one (the
// API then answers its default). The same function says what an ANSWER was
// the preview of: the form with the answer's own choice (includedIds).
export function replanRequest(form: ReplanForm, currentDue: string | null): ReplanStructureRequest {
  const dueDate = form.dueDate === "" || form.dueDate === currentDue ? null : form.dueDate;
  const request: ReplanStructureRequest = { dueDate, moveComponentDueDates: form.moveComponentDueDates };
  if (form.chosen !== null) request.includeOrderIds = [...form.chosen];
  return request;
}

// Two requests ask the same thing — the preview on screen is the preview of
// the form exactly when its request has the form's key.
export function requestKey(request: ReplanStructureRequest): string {
  return JSON.stringify([
    request.dueDate,
    request.moveComponentDueDates,
    request.includeOrderIds === undefined ? null : [...request.includeOrderIds].sort(),
  ]);
}

// The write: exactly what the shown preview was asked, the TOs it planned,
// and its `expected` — the same array, unchanged.
export function replanPayload(
  result: Pick<ReplanStructureResult, "orders" | "expected">,
  request: Pick<ReplanStructureRequest, "dueDate" | "moveComponentDueDates">
): ReplanStructureWrite {
  return {
    dueDate: request.dueDate,
    moveComponentDueDates: request.moveComponentDueDates,
    includeOrderIds: includedIds(result),
    expected: result.expected,
  };
}

// A changed date that has passed is not asked for (today or later; the date
// the top already has is "leave it" and always fine).
export function validDueDate(dueDate: string, currentDue: string | null, today: string | null): boolean {
  if (dueDate === "" || dueDate === currentDue) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(dueDate) && (today === null || dueDate >= today);
}

// --- The texts ---------------------------------------------------------------

// "1–3 dec → 4–8 dec"; the same before and after is said once.
export function changeText(before: string | null, after: string | null, none = "–"): string {
  const from = before ?? none;
  const to = after ?? none;
  return from === to ? from : `${from} → ${to}`;
}

const rangeLabel = (range: ReplanDateRange): string | null => plannedDateLabel(range.start, range.end);

// The TO's planned days before → after.
export function plannedChangeText(planned: { before: ReplanDateRange; after: ReplanDateRange }): string {
  return changeText(rangeLabel(planned.before), rangeLabel(planned.after), "ej planerad");
}

// The färdigdatum before → after.
export function dueDateChangeText(dueDate: { before: string | null; after: string | null }): string {
  return changeText(dueDate.before ? shortDate(dueDate.before) : null, dueDate.after ? shortDate(dueDate.after) : null, "saknas");
}

// "börjar tidigast 9 dec — när TO-1050 är klar" / "när IO-88 har kommit".
export function floorText(floor: ReplanStructureOrder["floor"]): string | null {
  if (!floor) return null;
  const day = `börjar tidigast ${shortDate(floor.date)}`;
  if (!floor.source) return `${day} — när materialet är klart`;
  return floor.source.kind === "purchase_order"
    ? `${day} — när ${floor.source.documentNumber} har kommit`
    : `${day} — när ${floor.source.documentNumber} är klar`;
}

// "delas med TO-1077 och KO-5010" — why a halvfabrikat is not preselected.
export function sharedText(order: Pick<ReplanStructureOrder, "sharedWith">): string | null {
  const names = order.sharedWith;
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} och ${names[names.length - 1]}`;
  return `delas med ${list}`;
}

// Why a TO that is not planned stands as it does.
export function notPlannedText(order: ReplanStructureOrder): string {
  const shared = sharedText(order);
  return shared ? `${shared} — planeras inte om` : "planeras inte om";
}

// "3 operationer · 2 var låsta och planeras om".
export function operationsText(order: Pick<ReplanStructureOrder, "operations" | "included">): string {
  const n = order.operations.length;
  const count = n === 1 ? "1 operation" : `${n} operationer`;
  const locked = order.included ? order.operations.filter((op) => op.wasLocked).length : 0;
  if (locked === 0) return count;
  return `${count} · ${locked === 1 ? "1 var låst och planeras om" : `${locked} var låsta och planeras om`}`;
}

// One operation: "op 10 · 101 · 1–2 dec → 4–5 dec".
export function operationText(op: ReplanStructureOrder["operations"][number]): string {
  const days = op.subcontract && !op.after.start && !op.before.start ? "lego" : changeText(rangeLabel(op.before), rangeLabel(op.after), "ej planerad");
  return `op ${op.sequenceNo} · ${op.workCenterCode} · ${days}`;
}

const hours = (value: number): string => value.toLocaleString("sv-SE", { maximumFractionDigits: 1 });

// "101 · 7 dec: 9,5 h av 8 h".
export function overloadedDayText(day: ReplanStructureResult["overloadedDays"][number]): string {
  const load = `${day.workCenterCode} · ${shortDate(day.date)}: ${hours(day.loadHours)} h`;
  if (day.availableHours === null) return load;
  return day.availableHours <= 0 ? `${load} · ingen kapacitet` : `${load} av ${hours(day.availableHours)} h`;
}

// Why Planera om is off: a chosen TO does not fit within the horizon.
export function blockedText(blocked: ReplanStructureResult["blocked"]): string | null {
  if (blocked.length === 0) return null;
  const numbers = blocked.map((b) => b.orderNumber).join(", ");
  return `${numbers} ryms inte inom planeringshorisonten (två år) — strukturen kan inte planeras om. Välj bort ${
    blocked.length === 1 ? "ordern" : "ordrarna"
  } eller frigör kapacitet.`;
}

// The notice after the write.
export function writtenText(result: Pick<ReplanStructureResult, "orders">): string {
  const n = result.orders.filter((o) => o.included).length;
  return `${n === 1 ? "1 tillverkningsorder är omplanerad" : `${n} tillverkningsordrar är omplanerade`} och operationerna är låsta på sina dagar.`;
}

// 409 replan-structure-changed carries the fresh preview in its body.
export function conflictResult(body: unknown): ReplanStructureResult | null {
  const result = (body as { result?: unknown } | null | undefined)?.result;
  if (!result || typeof result !== "object") return null;
  const r = result as Partial<ReplanStructureResult>;
  return Array.isArray(r.orders) && Array.isArray(r.expected) && r.orders.length > 0 ? (result as ReplanStructureResult) : null;
}

export const REPLAN_CHANGED_NOTICE = "Planen har ändrats — förhandsvisningen är uppdaterad. Kontrollera och planera om igen.";
