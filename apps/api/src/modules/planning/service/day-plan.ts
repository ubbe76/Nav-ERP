// Dagplan — every resource's work ONE day, in körordning (spec 2026-11-26).
// Pure, no database imports, and no rule of its own:
//   - Resurserna   runPlanStations (run-plan.ts): active, never lego, in
//                  compareStationCodes order.
//   - Raderna      buildRunPlan per resource up to and including the day —
//                  the körplan's rows, order and `reorderable`.
//   - Lasten       resourceDayLoads (capacity-calc.ts), handed in.
//   - Dagarna      the company's working days (delivery-days.ts).
// Nothing is stored: the dagplan is derived at every read.
import { round2 } from "@navet/shared";
import { isoWeekOf } from "../../timereport/service/schedule.service.js";
import { addDays, addWorkingDays, previousWorkingDay } from "../../system/service/delivery-days.js";
import type {
  CapacityDayLoad,
  CapacityOperationRow,
  CapacityProductionGroup,
  CapacityWorkCenter,
} from "./capacity-calc.js";
import {
  buildRunPlan,
  runPlanStations,
  type RunPlanOperationMaterials,
  type RunPlanRow,
  type RunPlanStamp,
} from "./run-plan.js";

// The window: today and this many days ahead, never a passed day (S5 — the
// same window as Beläggning's day view at its widest).
export const DAY_PLAN_MAX_AHEAD_DAYS = 41;

export interface DayPlanPresent {
  employeeId: string;
  name: string;
}

export interface DayPlanResource {
  workCenter: { id: string; code: string; name: string };
  productionGroupId: string | null;
  // resourceDayLoads for (the resource, the day).
  load: CapacityDayLoad;
  // Kvar från tidigare (S6): today the körplan's Försenad; a later day the
  // planned operations that started an earlier day (also before today) and
  // still lie on the day.
  carried: RunPlanRow[];
  // The day's operations in the körplan's order.
  rows: RunPlanRow[];
  // Tid kvar of carried + rows, in hours.
  rowHours: number;
  // The körplan's Ej planerad on the resource (a counter with a link).
  unplannedRows: number;
  present: DayPlanPresent[];
}

export interface DayPlanResult {
  today: string;
  date: string;
  weekday: number; // ISO 1 = Monday … 7 = Sunday
  isoWeek: number;
  // The previous / next working day; null outside [today, today + 41].
  previousDate: string | null;
  nextDate: string | null;
  productionGroups: { id: string; code: string; name: string }[];
  resources: DayPlanResource[]; // compareStationCodes order
  totals: { rows: number; hours: number; unlinkedOperations: number; shortMaterials: number };
}

const isoWeekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

const minutesOf = (rows: RunPlanRow[]) => rows.reduce((sum, row) => sum + row.remainingMinutes, 0);

export function buildDayPlan(input: {
  today: string; // Stockholm day
  date: string; // the day shown, within [today, today + DAY_PLAN_MAX_AHEAD_DAYS]
  offDays: ReadonlySet<string>; // full-day holidays
  workCenters: CapacityWorkCenter[]; // all — the selection is made here
  productionGroups: CapacityProductionGroup[];
  productionGroupId: string | null; // null = every resource
  // EVERY operation of the open orders — the readiness is computed over the
  // whole order.
  operations: CapacityOperationRow[];
  dayLoads: ReadonlyMap<string, CapacityDayLoad>;
  materials: ReadonlyMap<string, RunPlanOperationMaterials>;
  stamps: ReadonlyMap<string, RunPlanStamp[]>;
  // Per workCenterId; the reader only loads it for today.
  present: ReadonlyMap<string, DayPlanPresent[]>;
}): DayPlanResult {
  const { today, date } = input;
  const lastDate = addDays(today, DAY_PLAN_MAX_AHEAD_DAYS);

  const workCenterOf = new Map(input.workCenters.map((w) => [w.workCenterId, w]));
  const stations = runPlanStations(
    input.workCenters.map((w) => ({ id: w.workCenterId, code: w.code, name: w.name, type: w.type, active: w.active }))
  ).filter(
    (station) => input.productionGroupId == null || workCenterOf.get(station.id)!.productionGroupId === input.productionGroupId
  );

  // The orders with a pending operation on each resource, in ONE pass — so
  // the readiness is computed for a resource's own orders only.
  const operationsByOrder = new Map<string, CapacityOperationRow[]>();
  const ordersByWorkCenter = new Map<string, Set<string>>();
  for (const op of input.operations) {
    const ops = operationsByOrder.get(op.manufacturingOrderId);
    if (ops) ops.push(op);
    else operationsByOrder.set(op.manufacturingOrderId, [op]);
    if (op.operationStatus !== "pending") continue;
    const orders = ordersByWorkCenter.get(op.workCenterId);
    if (orders) orders.add(op.manufacturingOrderId);
    else ordersByWorkCenter.set(op.workCenterId, new Set([op.manufacturingOrderId]));
  }

  const resources: DayPlanResource[] = stations.map((station) => {
    const workCenter = workCenterOf.get(station.id)!;
    const plan = buildRunPlan({
      today,
      toDate: date,
      workCenter: { id: station.id, code: station.code, name: station.name, type: workCenter.type, active: workCenter.active },
      stations: [],
      operations: [...(ordersByWorkCenter.get(station.id) ?? [])].flatMap((orderId) => operationsByOrder.get(orderId)!),
      plannedOrderOperations: [],
      materials: input.materials,
      stamps: input.stamps,
    });
    // In the order buildRunPlan gave.
    const rows = plan.rows.filter((row) => row.date === date && !row.late);
    // A later day: every planned operation that started an earlier day and
    // still lies on the day — also one started before today (Försenad today),
    // whose remaining load the bucket rule puts on its later plan days too.
    const carried = plan.rows.filter((row) =>
      date === today ? row.late : row.planned && row.plannedStartDate! < date && row.plannedEndDate! >= date
    );
    return {
      workCenter: station,
      productionGroupId: workCenter.productionGroupId,
      load: input.dayLoads.get(station.id) ?? { date, loadHours: 0, availableHours: null, overloaded: false },
      carried,
      rows,
      rowHours: round2((minutesOf(carried) + minutesOf(rows)) / 60),
      unplannedRows: plan.rows.filter((row) => row.date === null).length,
      present: input.present.get(station.id) ?? [],
    };
  });

  const shown = resources.flatMap((r) => [...r.carried, ...r.rows]);
  const previous = previousWorkingDay(date, input.offDays);
  const next = addWorkingDays(date, 1, input.offDays);
  return {
    today,
    date,
    weekday: isoWeekdayOf(date),
    isoWeek: isoWeekOf(date).isoWeek,
    previousDate: previous >= today && previous < date ? previous : null,
    nextDate: next <= lastDate && next > date ? next : null,
    productionGroups: [...input.productionGroups]
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .map((g) => ({ id: g.productionGroupId, code: g.code, name: g.name })),
    resources,
    totals: {
      rows: shown.length,
      hours: round2(minutesOf(shown) / 60),
      unlinkedOperations: shown.filter((row) => !row.materialLinked).length,
      shortMaterials: shown.reduce((sum, row) => sum + row.materials.filter((m) => m.status === "short").length, 0),
    },
  };
}
