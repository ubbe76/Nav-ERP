// Planera — the production plan: every open TO's pending operations placed
// on free capacity through the shared capacity book, in priority order
// (earliest due date first), operations in sequence. Three calls, one
// engine: Planera (all open TOs), the planning of a new TO (`orders` = the
// new one, every other open operation as existing load) and a hand move
// (`forceStart` on one operation, the TO's other operations locked or
// following).
//
// Pure, like delivery-time-check.ts: the service loads the rows, writes the
// plans it gets back and logs the warnings. Deterministic — the same input
// gives the same plan, and a run on its own output gives it again.
import {
  mondayOf,
  operationLoadWeeks,
  remainingOperationMinutes,
  type CapacityOperationRow,
  type DayScheduleNetRow,
  type HolidayRow,
  type PlannedWeek,
  type WeekScheduleDayRow,
} from "./capacity-calc.js";
import { createCapacityBook, type PlanWorkCenter } from "./capacity-book.js";

export interface PlanOperation extends CapacityOperationRow {
  // Påbörjad: something reported (OK or scrap) or an open/paused stamp
  // session — the work is under way and starts in the current week.
  started: boolean;
}

export interface PlanOrder {
  id: string;
  orderNumber: string;
  dueDate: string | null;
  operations: PlanOperation[];
}

export interface PlanProductionInput {
  today: string;
  offDays: ReadonlySet<string>;
  workCenters: Map<string, PlanWorkCenter>;
  schedule: { weekScheduleDays: WeekScheduleDayRow[]; daySchedules: DayScheduleNetRow[]; holidays: HolidayRow[] };
  // The TOs to plan, each with ALL its operations (done ones included —
  // their allocations are cleared).
  orders: PlanOrder[];
  // Load that is not replanned: every other open operation (a new TO, a
  // move). Planned ones count in their planned weeks.
  existingOperations?: CapacityOperationRow[];
  // Flytta: this operation starts in `weekMonday` whatever is free there
  // (whole-week capacity, overload allowed), locked or not.
  forceStart?: { operationId: string; weekMonday: string };
  horizonWeeks?: number;
}

// An operation's new plan — what `writeOperationPlans` stores.
export interface OperationPlan {
  operationId: string; // mo_operations.id
  manufacturingOrderId: string;
  weeks: PlannedWeek[];
  startWeek: string; // = weeks[0].monday
  endWeek: string; // = weeks[last].monday
}

export interface PlanWarning {
  kind: "late" | "horizon" | "sequence" | "unscheduled_resource";
  manufacturingOrderId: string;
  orderNumber: string;
  sequenceNo?: number;
  workCenterCode?: string;
  dueDate?: string | null;
  plannedFinish?: string | null;
  message: string;
}

export interface PlannedOrderSummary {
  manufacturingOrderId: string;
  orderNumber: string;
  dueDate: string | null;
  plannedFinish: string | null; // null when the horizon was hit
  late: boolean;
}

export interface PlanProductionResult {
  plans: OperationPlan[];
  // Operations whose allocation is removed: done, 0 minutes, lego, or
  // beyond the horizon (and every unlocked operation after it in the TO).
  clear: string[];
  warnings: PlanWarning[];
  orders: PlannedOrderSummary[];
}

const EPS = 1e-9;
const maxDate = (a: string, b: string) => (a > b ? a : b);
const hasPlan = (op: CapacityOperationRow) => !!op.plannedWeeks && op.plannedWeeks.length > 0;

// Prioritet: due date ascending, null last, then order number (then id —
// never a tie, so the plan is deterministic).
export function compareOrderPriority(a: PlanOrder, b: PlanOrder): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate == null) return 1;
    if (b.dueDate == null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.orderNumber !== b.orderNumber) return a.orderNumber < b.orderNumber ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function planProduction(input: PlanProductionInput): PlanProductionResult {
  const { today } = input;
  const firstMonday = mondayOf(today);
  const forced = input.forceStart ?? null;
  const isForced = (op: PlanOperation) => forced !== null && forced.operationId === op.moOperationId;
  // Låst: a hand-moved operation keeps its weeks — it is existing load
  // before anything else is placed, and is never touched (unless it is the
  // one being moved again).
  const isLocked = (op: PlanOperation) => op.operationStatus === "pending" && !!op.planLocked && hasPlan(op) && !isForced(op);

  const book = createCapacityBook({
    today,
    offDays: input.offDays,
    horizonWeeks: input.horizonWeeks,
    workCenters: input.workCenters,
    schedule: input.schedule,
    existingOperations: [...(input.existingOperations ?? []), ...input.orders.flatMap((o) => o.operations.filter(isLocked))],
  });

  const plans: OperationPlan[] = [];
  const clear: string[] = [];
  const warnings: PlanWarning[] = [];
  const orders: PlannedOrderSummary[] = [];

  for (const order of [...input.orders].sort(compareOrderPriority)) {
    const head = { manufacturingOrderId: order.id, orderNumber: order.orderNumber };
    const unscheduledNoted = new Set<string>();
    let floor = today; // capacity may be used from this day
    let ready = floor; // the day the previous operation is done
    let prevEndWeek: string | null = null; // Monday of the week the previous operation finishes
    let horizonHit = false;

    const sequenceBreak = (op: PlanOperation, code: string, startWeek: string, what: string) => {
      if (prevEndWeek !== null && startWeek < prevEndWeek) {
        warnings.push({
          kind: "sequence",
          ...head,
          sequenceNo: op.sequenceNo,
          workCenterCode: code,
          message: `Op ${op.sequenceNo} på ${code} är ${what} i veckan som börjar ${startWeek}, före föregående operation är klar (${ready})`,
        });
      }
    };

    for (const op of [...order.operations].sort((a, b) => a.sequenceNo - b.sequenceNo)) {
      const wc = input.workCenters.get(op.workCenterId) ?? null;
      const code = wc?.code ?? "?";
      if (op.operationStatus === "done") {
        if (hasPlan(op)) clear.push(op.moOperationId);
        continue;
      }
      if (horizonHit) {
        // Nothing after the operation that did not fit is planned; a locked
        // one keeps its weeks (Planera never touches it).
        if (!isLocked(op) && hasPlan(op)) clear.push(op.moOperationId);
        continue;
      }
      if (isLocked(op)) {
        const chunks = operationLoadWeeks(op, firstMonday);
        if (chunks.length === 0) continue; // nothing left — the plan is moot
        const startWeek = chunks[0]!.monday!;
        const endWeek = chunks[chunks.length - 1]!.monday!;
        sequenceBreak(op, code, startWeek, "låst");
        ready = maxDate(ready, book.weekFinishDay(wc, endWeek, floor));
        floor = maxDate(floor, endWeek);
        prevEndWeek = endWeek;
        continue;
      }
      if (wc?.type === "subcontract") {
        ready = book.subcontract(wc, maxDate(ready, floor));
        floor = ready;
        prevEndWeek = mondayOf(ready);
        if (hasPlan(op)) clear.push(op.moOperationId);
        continue;
      }
      const minutes = remainingOperationMinutes(op);
      if (minutes <= EPS) {
        if (hasPlan(op)) clear.push(op.moOperationId);
        continue;
      }
      const forceStartWeek = isForced(op) ? forced!.weekMonday : op.started ? firstMonday : undefined;
      const placed = book.place(wc, minutes, forceStartWeek ? { floor, forceStartWeek } : { floor });
      if (placed.horizonExceeded) {
        warnings.push({
          kind: "horizon",
          ...head,
          sequenceNo: op.sequenceNo,
          workCenterCode: code,
          message: `Kapaciteten räcker inte inom två år — Op ${op.sequenceNo} på ${code} och efterföljande operationer är inte planerade`,
        });
        if (hasPlan(op)) clear.push(op.moOperationId);
        horizonHit = true;
        continue;
      }
      if (placed.unscheduled && !unscheduledNoted.has(code)) {
        unscheduledNoted.add(code);
        warnings.push({
          kind: "unscheduled_resource",
          ...head,
          sequenceNo: op.sequenceNo,
          workCenterCode: code,
          message: `Resurs ${code} saknar veckoschema och timmar per dag — Op ${op.sequenceNo} är planerad utan kapacitetsgräns`,
        });
      }
      if (isForced(op)) sequenceBreak(op, code, placed.fromWeek, "flyttad");
      plans.push({
        operationId: op.moOperationId,
        manufacturingOrderId: order.id,
        weeks: placed.weeks,
        startWeek: placed.fromWeek,
        endWeek: placed.toWeek,
      });
      ready = maxDate(ready, placed.readyDate);
      // The next operation may use what is left of the finishing week.
      floor = maxDate(floor, placed.toWeek);
      prevEndWeek = placed.toWeek;
    }

    // Sen: the last pending operation (lego through its lead time) finishes
    // after the due date. A TO that hit the horizon has no finish.
    const plannedFinish = horizonHit ? null : ready;
    const late = plannedFinish !== null && order.dueDate !== null && plannedFinish > order.dueDate;
    if (late) {
      warnings.push({
        kind: "late",
        ...head,
        dueDate: order.dueDate,
        plannedFinish,
        message: `${order.orderNumber} blir klar ${plannedFinish}, efter färdigdatumet ${order.dueDate}`,
      });
    }
    orders.push({ ...head, dueDate: order.dueDate, plannedFinish, late });
  }

  return { plans, clear, warnings, orders };
}
