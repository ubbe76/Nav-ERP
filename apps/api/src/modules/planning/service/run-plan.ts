// Körplan — the list of a resource's coming work, in the order it is to be
// done (spec 2026-11-12). Pure, no database imports, and NO rule of its own:
// every figure is another reader's rule applied to the same row.
//   - Vecka        operationStartWeek (capacity-calc.ts): the plan's first
//                  week, else the due date's week — Beläggning's bucket for
//                  an unplanned operation, before its clamp to this week.
//   - Tid kvar     remainingOperationMinutes / setupDoneOnCurrentResource
//                  (capacity-calc.ts) — Beläggning's remaining hours.
//   - Antal kvar   remainingOperationQuantity (terminal-readiness.ts).
//   - Status       computeReadiness over ALL the order's operations
//                  (terminal-readiness.ts) — the terminal's beredskap.
//   - Resurserna   the terminal's stations (active, not lego) in
//                  compareStationCodes order.
// Nothing is stored: the körplan is derived at every read.
import { round2 } from "@navet/shared";
import { isoWeekOf } from "../../timereport/service/schedule.service.js";
import { compareStationCodes } from "../../manufacturing/service/station-order.js";
import {
  computeReadiness,
  previousSequenceNumbers,
  remainingOperationQuantity,
  type Readiness,
} from "../../manufacturing/service/terminal-readiness.js";
import {
  mondayOf,
  operationStartWeek,
  plannedWeekRange,
  remainingOperationMinutes,
  setupDoneOnCurrentResource,
  type CapacityOperationRow,
} from "./capacity-calc.js";

// A Planerad TO's operation on the resource: a capacity row that may lack an
// mo_operations id (a plain planned TO's operations are still the article's
// route — they are snapshotted at release).
export type RunPlanPlannedOperation = Omit<CapacityOperationRow, "moOperationId"> & { moOperationId: string | null };

export interface RunPlanWorkCenter {
  id: string;
  code: string;
  name: string;
  type: "machine" | "personnel" | "subcontract";
  active: boolean;
}

export interface RunPlanStation {
  id: string;
  code: string;
  name: string;
}

// "planned_order" = the TO is Planerad (not released) — kommande, nothing to
// stamp on yet; otherwise the terminal's beredskap.
export type RunPlanStatus = "planned_order" | Readiness;

export interface RunPlanRow {
  // Unique per row: the operation's id, or order + sequence number for a
  // Planerad TO's route operation.
  key: string;
  // null = a Planerad TO whose operations are not snapshotted yet.
  moOperationId: string | null;
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  sequenceNo: number;
  description: string | null;
  orderQuantity: number;
  // Antal kvar: order quantity − the operation's OK, never below 0.
  remainingQuantity: number;
  // Tid kvar — the setup only while it is not done on the current resource.
  remainingMinutes: number;
  remainingHours: number;
  setupDone: boolean;
  dueDate: string | null;
  // Veckonyckeln (a Monday): the plan's first week, else the due date's
  // week; null = neither (Ej planerad). `late` = a week before the current.
  week: string | null;
  late: boolean;
  planned: boolean;
  plannedStartWeek: string | null;
  plannedEndWeek: string | null;
  planLocked: boolean;
  status: RunPlanStatus;
  // What the readiness rule lets the operator work on now (the terminal's
  // `available`); null for a Planerad TO.
  available: number | null;
  // The previous operation's number when the row waits for it (partial or
  // not ready) — "Väntar på op N"; else null.
  waitingForSequenceNo: number | null;
}

// One group of the list, in list order: Försenad first (every week before
// the current one together), then each week, Ej planerad last.
export interface RunPlanWeek {
  kind: "late" | "week" | "unplanned";
  week: string | null; // the Monday for kind "week", else null
  isoYear: number | null;
  isoWeek: number | null;
  late: boolean;
  rows: number;
  minutes: number;
  hours: number;
}

export interface RunPlanResult {
  // null = no resource chosen yet: only `stations` (and the default week).
  workCenter: { id: string; code: string; name: string } | null;
  today: string;
  currentWeek: string;
  toWeek: string;
  rows: RunPlanRow[];
  weeks: RunPlanWeek[];
  totalMinutes: number;
  totalHours: number;
  stations: RunPlanStation[];
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// T.o.m. vecka when none is given: next week (innevarande och nästa vecka).
export function defaultRunPlanToWeek(today: string): string {
  return addDays(mondayOf(today), 7);
}

// The resource picker: the terminal's stations — active, never lego.
export function runPlanStations(workCenters: RunPlanWorkCenter[]): RunPlanStation[] {
  return workCenters
    .filter((w) => w.active && w.type !== "subcontract")
    .map((w) => ({ id: w.id, code: w.code, name: w.name }))
    .sort(compareStationCodes);
}

const compareNullLast = (a: string | null, b: string | null) => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? -1 : 1;
};

export function buildRunPlan(input: {
  today: string; // Stockholm day
  toWeek: string; // Monday, inclusive
  workCenter: RunPlanWorkCenter;
  stations: RunPlanStation[];
  // EVERY operation of the open orders (released / in progress) that have
  // work on the resource — the readiness is computed over the whole order.
  operations: CapacityOperationRow[];
  // The Planerade TO:s operations on the resource.
  plannedOrderOperations: RunPlanPlannedOperation[];
}): RunPlanResult {
  const currentWeek = mondayOf(input.today);

  const byOrder = new Map<string, CapacityOperationRow[]>();
  for (const op of input.operations) byOrder.set(op.manufacturingOrderId, [...(byOrder.get(op.manufacturingOrderId) ?? []), op]);
  const readiness = new Map<string, { readiness: Readiness; available: number }>();
  const previous = new Map<string, number | null>();
  for (const ops of byOrder.values()) {
    const siblings = ops.map((op) => ({
      id: op.moOperationId,
      sequenceNo: op.sequenceNo,
      status: op.operationStatus,
      quantityCompleted: op.quantityCompleted == null ? null : String(op.quantityCompleted),
    }));
    for (const [id, r] of computeReadiness(ops[0]!.orderQuantity, siblings)) readiness.set(id, r);
    for (const [id, seq] of previousSequenceNumbers(siblings)) previous.set(id, seq);
  }

  const toRow = (op: RunPlanPlannedOperation, plannedOrder: boolean): RunPlanRow & { minutes: number } => {
    const minutes = remainingOperationMinutes(op);
    const week = operationStartWeek(op);
    const range = plannedWeekRange(op);
    const ready = plannedOrder || op.moOperationId == null ? null : readiness.get(op.moOperationId)!;
    return {
      key: op.moOperationId ?? `${op.manufacturingOrderId}:${op.sequenceNo}`,
      moOperationId: op.moOperationId,
      manufacturingOrderId: op.manufacturingOrderId,
      orderNumber: op.orderNumber,
      articleNumber: op.articleNumber,
      articleName: op.articleName,
      sequenceNo: op.sequenceNo,
      description: op.description?.trim() || null,
      orderQuantity: op.orderQuantity,
      remainingQuantity: remainingOperationQuantity(op.orderQuantity, op.quantityCompleted),
      remainingMinutes: round2(minutes),
      remainingHours: round2(minutes / 60),
      setupDone: setupDoneOnCurrentResource(op),
      dueDate: op.dueDate,
      week,
      late: week != null && week < currentWeek,
      planned: range != null,
      plannedStartWeek: range?.start ?? null,
      plannedEndWeek: range?.end ?? null,
      planLocked: op.planLocked ?? false,
      status: ready ? ready.readiness : "planned_order",
      available: ready ? ready.available : null,
      waitingForSequenceNo: ready && ready.readiness !== "ready" ? (previous.get(op.moOperationId!) ?? null) : null,
      minutes,
    };
  };

  const candidates = [
    ...input.operations
      .filter((op) => op.workCenterId === input.workCenter.id && op.operationStatus === "pending")
      .map((op) => toRow(op, false)),
    ...input.plannedOrderOperations.map((op) => toRow(op, true)),
  ];

  // Försenade and Ej planerade are always in; a week up to and including
  // T.o.m. vecka.
  const listed = candidates
    .filter((row) => row.week == null || row.late || row.week <= input.toWeek)
    .sort(
      (a, b) =>
        compareNullLast(a.week, b.week) ||
        compareNullLast(a.dueDate, b.dueDate) ||
        a.orderNumber.localeCompare(b.orderNumber, "sv", { numeric: true }) ||
        a.sequenceNo - b.sequenceNo
    );

  const groups: (Omit<RunPlanWeek, "minutes" | "hours"> & { sum: number })[] = [];
  for (const row of listed) {
    const kind: RunPlanWeek["kind"] = row.late ? "late" : row.week == null ? "unplanned" : "week";
    const week = kind === "week" ? row.week : null;
    let group = groups.find((g) => g.kind === kind && g.week === week);
    if (!group) {
      const iso = week ? isoWeekOf(week) : null;
      group = { kind, week, isoYear: iso?.isoYear ?? null, isoWeek: iso?.isoWeek ?? null, late: kind === "late", rows: 0, sum: 0 };
      groups.push(group);
    }
    group.rows += 1;
    group.sum += row.minutes;
  }
  const total = listed.reduce((sum, row) => sum + row.minutes, 0);

  return {
    workCenter: { id: input.workCenter.id, code: input.workCenter.code, name: input.workCenter.name },
    today: input.today,
    currentWeek,
    toWeek: input.toWeek,
    rows: listed.map(({ minutes: _minutes, ...row }) => row),
    weeks: groups.map(({ sum, ...g }) => ({ ...g, minutes: round2(sum), hours: round2(sum / 60) })),
    totalMinutes: round2(total),
    totalHours: round2(total / 60),
    stations: input.stations,
  };
}
