// Beläggning's drag-to-move in the day view — pure rules and texts (no fetch,
// no React). Nothing is decided here that the server does not decide again:
// the drop only picks a day, POST …/move/preview says what the move would do
// and POST …/move does it (S33/S34 in the spec).
import { plannedDateLabel, weekdayShortDate } from "./planning";
import type { CapacityCellOrder, CapacityDay, CapacityDayLoad, MoveOperationPreview } from "./types";

// Flytta never changes the resource.
export const OTHER_RESOURCE_TEXT = "Byt resurs görs på TO-kortet";

type DragOrder = Pick<CapacityCellOrder, "moOperationId" | "orderNumber" | "sequenceNo" | "plannedStartDate">;

const hours = (value: number): string => value.toLocaleString("sv-SE", { maximumFractionDigits: 1 });

// An operation gets a grip only in the day view and only for users with
// Tillverkning (the page adds: a fine pointer, and no read or write running).
export function draggableOrder(order: Pick<CapacityCellOrder, "moOperationId">, granularity: "week" | "day", canPlan: boolean): boolean {
  return canPlan && granularity === "day" && !!order.moOperationId;
}

// Where a drag may end. Only a day cell of a resource row carries a date;
// Senare, Odaterat and the Summa row are "other".
export type DropTarget =
  | { kind: "day"; workCenterId: string; date: string; availableHours: number | null }
  | { kind: "other" };

export type DropRefusal = "same_day" | "other_resource" | "no_capacity" | "not_a_day";

// May the operation (on the resource `resourceId`) be dropped on the target?
// A day without capacity is the matrix's own flag (dayLoads' availableHours =
// 0) — no calendar rule of our own; a resource without a calendar
// (availableHours null) allows every day and the server decides.
export function dropAllowed(
  order: Pick<CapacityCellOrder, "plannedStartDate">,
  resourceId: string,
  target: DropTarget
): { ok: true } | { ok: false; reason: DropRefusal } {
  if (target.kind !== "day") return { ok: false, reason: "not_a_day" };
  if (target.workCenterId !== resourceId) return { ok: false, reason: "other_resource" };
  if (target.date === order.plannedStartDate) return { ok: false, reason: "same_day" };
  if (target.availableHours !== null && target.availableHours <= 0) return { ok: false, reason: "no_capacity" };
  return { ok: true };
}

// The body of the preview and of the move after a drop: the following
// operations always come along (the dialog's default — the dialog is the way
// to choose otherwise), and the start day the view showed is the
// precondition (null = it showed the operation unplanned).
export function moveBody(order: Pick<CapacityCellOrder, "plannedStartDate">, date: string): {
  date: string;
  moveFollowing: true;
  expectedStartDate: string | null;
} {
  return { date, moveFollowing: true, expectedStartDate: order.plannedStartDate };
}

// Keyboard move: the next day index from `from` in the direction of `step`
// (−1/+1) that has capacity; days without capacity are skipped, and at the
// edge the index stays. `from` −1 = not on a visible day yet.
export function nextDropIndex(days: readonly Pick<CapacityDay, "date">[], dayLoads: readonly CapacityDayLoad[], from: number, step: -1 | 1): number {
  const available = new Map(dayLoads.map((d) => [d.date, d.availableHours]));
  for (let i = from + step; i >= 0 && i < days.length; i += step) {
    const hoursThatDay = available.get(days[i]!.date);
    if (hoursThatDay === null || hoursThatDay === undefined || hoursThatDay > 0) return i;
  }
  return from;
}

// The index of the operation's start day among the visible days (−1 when it
// is unplanned or starts outside them).
export function startIndex(days: readonly Pick<CapacityDay, "date">[], order: Pick<CapacityCellOrder, "plannedStartDate">): number {
  return order.plannedStartDate === null ? -1 : days.findIndex((d) => d.date === order.plannedStartDate);
}

// "ons 2 dec — ledigt 3 h av 8", read out while the target moves.
export function dropDayText(date: string, load: CapacityDayLoad | undefined): string {
  const day = weekdayShortDate(date);
  if (!load || load.availableHours === null) return day;
  if (load.availableHours <= 0) return `${day} — ingen kapacitet`;
  return `${day} — ledigt ${hours(Math.max(0, load.availableHours - load.loadHours))} h av ${hours(load.availableHours)}`;
}

// "Dagens last 4,2 h → 9,8 h av 8 h (överbelagd)" — the target day on the
// resource before and after the move. Överbelagd is the API's flag.
export function dayLoadLine(dayLoad: MoveOperationPreview["dayLoad"]): string {
  const { before, after } = dayLoad;
  let text = `Dagens last ${hours(before.loadHours)} h → ${hours(after.loadHours)} h`;
  if (after.availableHours !== null) text += ` av ${hours(after.availableHours)} h`;
  return after.overloaded ? `${text} (överbelagd)` : text;
}

// "Planeras 2–3 dec" / "Planeras 2 dec" — the operation's days after the move.
export function newDaysLine(preview: Pick<MoveOperationPreview, "operation">): string | null {
  const label = plannedDateLabel(preview.operation.plannedStartDate, preview.operation.plannedEndDate);
  return label ? `Planeras ${label}` : null;
}

// "Följer med: op 30 (4 dec), op 40 (7–8 dec)" — null when nothing follows.
export function followingLine(preview: Pick<MoveOperationPreview, "following">): string | null {
  if (preview.following.length === 0) return null;
  const parts = preview.following.map((f) => {
    const label = plannedDateLabel(f.plannedStartDate, f.plannedEndDate);
    return label ? `op ${f.sequenceNo} (${label})` : `op ${f.sequenceNo}`;
  });
  return `Följer med: ${parts.join(", ")}`;
}

// "Flytta op 20 på TO-1050" — the grip's name and the question's opening.
export function moveLabel(order: Pick<DragOrder, "orderNumber" | "sequenceNo">): string {
  return `Flytta op ${order.sequenceNo} på ${order.orderNumber}`;
}

// The question confirmDialog asks after a drop — the preview in words: the
// new days, what follows, the day's load before → after and the warnings.
// One line per fact (the dialog keeps line breaks).
export function moveConfirmText(order: Pick<DragOrder, "orderNumber" | "sequenceNo">, date: string, preview: MoveOperationPreview): string {
  const lines = [
    `${moveLabel(order)} till ${weekdayShortDate(date)}? Efterföljande operationer följer med och operationen låses.`,
    "",
  ];
  const days = newDaysLine(preview);
  if (days) lines.push(days);
  const following = followingLine(preview);
  if (following) lines.push(following);
  lines.push(dayLoadLine(preview.dayLoad));
  if (preview.warnings.length > 0) {
    lines.push("", "Observera:");
    for (const w of preview.warnings) lines.push(`– ${w.message}`);
  }
  return lines.join("\n");
}
