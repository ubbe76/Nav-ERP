// Körplan — the list of a resource's coming work, in the order it is to be
// done (spec 2026-11-12). Pure, no database imports, and NO rule of its own:
// every figure is another reader's rule applied to the same row.
//   - Dag          operationStartDate (capacity-calc.ts): the plan's first
//                  day, else the due date — Beläggning's bucket for an
//                  unplanned operation, before its clamp to today (#18).
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
  operationStartDate,
  plannedDateRange,
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
  // Dagnyckeln: the plan's first day, else the due date; null = neither
  // (Ej planerad). `late` = a day before today (Försenad — day granular,
  // like Beläggning's overdue: a passed plan lies on today in the book until
  // Planera runs, and the körplan says so).
  date: string | null;
  late: boolean;
  planned: boolean;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  planLocked: boolean;
  // The place within the day set by hand (PUT /planning/run-plan/order);
  // null = none — such a row comes after the ordered ones. Always null for
  // a Planerad TO's route operation.
  runPosition: number | null;
  status: RunPlanStatus;
  // What the readiness rule lets the operator work on now (the terminal's
  // `available`); null for a Planerad TO.
  available: number | null;
  // The previous operation's number when the row waits for it (partial or
  // not ready) — "Väntar på op N"; else null.
  waitingForSequenceNo: number | null;
  // The row takes part in Ordningen inom dagen: an open TO's operation in a
  // day group whose PLANNED start day is that day — exactly the set
  // lockRunPlanDayOperations counts, so the day's reorderable ids are the
  // list PUT /planning/run-plan/order wants. An unplanned operation lies on
  // its due date and a Planerad TO's operation has no place: both false.
  reorderable: boolean;
  // The co-run materials (B3); [] for a Planerad TO and for an operation
  // without any — and when the reader did not load them.
  materials: RunPlanMaterial[];
  // The operation has at least one linked row on a PURCHASED article,
  // whatever is left of it; false = "saknar kopplat material".
  materialLinked: boolean;
  // Open/paused stamp sessions on the operation.
  activeStamps: RunPlanStamp[];
}

// Where a missing material is expected from (pegging) — only on a short row.
export interface RunPlanMaterialSupply {
  kind: "purchase_order" | "manufacturing_order";
  documentId: string;
  documentNumber: string;
  date: string | null; // null = undated
  isDraft: boolean;
}

// One co-run material of the operation (B3: purchased, linked to the
// operation, something left to draw) with what the shelf holds.
export interface RunPlanMaterial {
  articleId: string;
  articleNumber: string;
  articleName: string;
  unit: string | null;
  // The operation's row: planned − consumed.
  remainingQuantity: number;
  // onHandByArticle(...).usable, round4 — the article's whole usable balance.
  usableOnHand: number;
  // available ⇔ usableOnHand >= remainingQuantity (per row against the
  // whole balance — Materialbrist's base, not pegging).
  status: "available" | "short";
  missingQuantity: number; // 0 when available
  supply: RunPlanMaterialSupply | null; // only when short
}

// An open or paused stamp session on the operation.
export interface RunPlanStamp {
  employeeId: string;
  name: string;
  paused: boolean;
}

// What the reader loaded per operation (moOperationId) — buildRunPlan only
// puts it on the rows.
export interface RunPlanOperationMaterials {
  materials: RunPlanMaterial[];
  linked: boolean;
}

// One group of the list, in list order: Försenad first (every day before
// today together), then each day, Ej planerad last.
export interface RunPlanDay {
  kind: "late" | "day" | "unplanned";
  date: string | null; // the day for kind "day", else null
  weekday: number | null; // ISO 1 = Monday … 7 = Sunday
  isoWeek: number | null;
  late: boolean;
  rows: number;
  minutes: number;
  hours: number;
  // The group holds rows that can be ordered by hand (RunPlanRow.reorderable
  // says which): only a day, and only its planned operations — a day can
  // also hold an unplanned operation on its due date or a Planerad TO's
  // operation. Försenad is sorted on its old days and places, Ej planerad
  // has no day to be ordered within.
  reorderable: boolean;
}

export interface RunPlanResult {
  // null = no resource chosen yet: only `stations` (and the default T.o.m.).
  workCenter: { id: string; code: string; name: string } | null;
  today: string;
  toDate: string;
  rows: RunPlanRow[];
  days: RunPlanDay[];
  totalMinutes: number;
  totalHours: number;
  stations: RunPlanStation[];
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// T.o.m. when none is given: the Sunday of next week (innevarande och nästa
// vecka — the same selection as before the plan counted in days, S12).
export function defaultRunPlanToDate(today: string): string {
  return addDays(mondayOf(today), 13);
}

const isoWeekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

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

const comparePosition = (a: number | null, b: number | null) => {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
};

export function buildRunPlan(input: {
  today: string; // Stockholm day
  toDate: string; // inclusive
  workCenter: RunPlanWorkCenter;
  stations: RunPlanStation[];
  // EVERY operation of the open orders (released / in progress) that have
  // work on the resource — the readiness is computed over the whole order.
  operations: CapacityOperationRow[];
  // The Planerade TO:s operations on the resource.
  plannedOrderOperations: RunPlanPlannedOperation[];
  // Per moOperationId, loaded by the reader. Left out (fixtures, readers
  // that do not show them) = no materials, not linked, no stamps. Never
  // read by the order, the selection, the dagnyckel or `reorderable`.
  materials?: ReadonlyMap<string, RunPlanOperationMaterials>;
  stamps?: ReadonlyMap<string, RunPlanStamp[]>;
}): RunPlanResult {
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
    const date = operationStartDate(op);
    const range = plannedDateRange(op);
    const ready = plannedOrder || op.moOperationId == null ? null : readiness.get(op.moOperationId)!;
    const extrasId = plannedOrder ? null : op.moOperationId;
    const material = extrasId == null ? undefined : input.materials?.get(extrasId);
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
      date,
      late: date != null && date < input.today,
      planned: range != null,
      plannedStartDate: range?.start ?? null,
      plannedEndDate: range?.end ?? null,
      planLocked: op.planLocked ?? false,
      runPosition: plannedOrder || op.moOperationId == null || range == null ? null : (op.runPosition ?? null),
      status: ready ? ready.readiness : "planned_order",
      available: ready ? ready.available : null,
      waitingForSequenceNo: ready && ready.readiness !== "ready" ? (previous.get(op.moOperationId!) ?? null) : null,
      reorderable: !plannedOrder && op.moOperationId != null && range != null && range.start >= input.today,
      materials: material?.materials ?? [],
      materialLinked: material?.linked ?? false,
      activeStamps: (extrasId == null ? undefined : input.stamps?.get(extrasId)) ?? [],
      minutes,
    };
  };

  const candidates = [
    ...input.operations
      .filter((op) => op.workCenterId === input.workCenter.id && op.operationStatus === "pending")
      .map((op) => toRow(op, false)),
    ...input.plannedOrderOperations.map((op) => toRow(op, true)),
  ];

  // Försenade and Ej planerade are always in; a day up to and including
  // T.o.m. Within a day: the place set by hand first (rows without one after
  // the ordered ones — the places need not be dense), then the standard
  // order.
  const listed = candidates
    .filter((row) => row.date == null || row.late || row.date <= input.toDate)
    .sort(
      (a, b) =>
        compareNullLast(a.date, b.date) ||
        comparePosition(a.runPosition, b.runPosition) ||
        compareNullLast(a.dueDate, b.dueDate) ||
        a.orderNumber.localeCompare(b.orderNumber, "sv", { numeric: true }) ||
        a.sequenceNo - b.sequenceNo
    );

  const groups: (Omit<RunPlanDay, "minutes" | "hours"> & { sum: number })[] = [];
  for (const row of listed) {
    const kind: RunPlanDay["kind"] = row.late ? "late" : row.date == null ? "unplanned" : "day";
    const date = kind === "day" ? row.date : null;
    // The list is sorted on the day, so a group's rows are consecutive.
    let group = groups[groups.length - 1];
    if (!group || group.kind !== kind || group.date !== date) {
      group = {
        kind,
        date,
        weekday: date ? isoWeekdayOf(date) : null,
        isoWeek: date ? isoWeekOf(date).isoWeek : null,
        late: kind === "late",
        reorderable: false,
        rows: 0,
        sum: 0,
      };
      groups.push(group);
    }
    group.rows += 1;
    group.sum += row.minutes;
    if (row.reorderable) group.reorderable = true;
  }
  const total = listed.reduce((sum, row) => sum + row.minutes, 0);

  return {
    workCenter: { id: input.workCenter.id, code: input.workCenter.code, name: input.workCenter.name },
    today: input.today,
    toDate: input.toDate,
    rows: listed.map(({ minutes: _minutes, ...row }) => row),
    days: groups.map(({ sum, ...g }) => ({ ...g, minutes: round2(sum), hours: round2(sum / 60) })),
    totalMinutes: round2(total),
    totalHours: round2(total / 60),
    stations: input.stations,
  };
}
