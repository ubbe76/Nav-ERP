// Planera — the production plan: every open TO's pending operations placed
// DAY BY DAY (#18) on free capacity through the shared capacity book, in
// priority order (earliest due date first), operations in sequence — each
// one from the working day after the previous is ready plus the
// Standardkötid (operationChain / nextOperationFloor). Three calls, one
// engine: Planera (all open TOs), the planning of a new TO (`orders` = the
// new one, every other open operation as existing load) and a hand move
// (`forceStart` on one operation, the TO's other operations locked or
// following).
//
// Pure, like delivery-time-check.ts: the service loads the rows, writes the
// plans it gets back and logs the warnings. Deterministic — the same input
// gives the same plan, and a run on its own output gives it again.
//
// Alternativa resurser (#15, beslut 1): every operation is placed on the
// resource it has (op.workCenterId), alternatives or not — the engine never
// switches one. A full resource gives a förslag (resource-suggestions.ts),
// and the planner switches by hand.
import {
  hasCapacityCalendar,
  mondayOf,
  operationLoadDays,
  operationStarted,
  remainingOperationMinutes,
  type CapacityOperationRow,
  type DayScheduleNetRow,
  type HolidayRow,
  type PlannedDay,
  type WeekScheduleDayRow,
} from "./capacity-calc.js";
import { addDays } from "../../system/service/delivery-days.js";
import { DEFAULT_LONG_OPERATION_WEEKS } from "../../system/service/plan-settings.js";
import {
  createCapacityBook,
  MIN_PLAN_MINUTES,
  operationChain,
  roundPlanDays,
  type CapacityBook,
  type PlanWorkCenter,
} from "./capacity-book.js";
import { roundToDecimals } from "@navet/shared";

// Orimligt mycket tid: an operation whose remaining time alone would fill its
// resource for more than `longOperationWeeks` normal weeks (the system
// setting planning_long_operation_weeks, plan-settings.ts) is most likely a
// data error (times in the wrong unit, a typo in the quantity). It is
// planned as usual, with a warning that names it.
// A normal week is the largest whole-week capacity (the sum of its days)
// among the weeks after the current one (a holiday week never sets the bar); a resource without a
// capacity calendar is measured against a 40-hour week.
const NORMAL_WEEK_SAMPLE = 8;
const STANDARD_WEEK_MINUTES = 40 * 60;

export interface PlanOperation extends CapacityOperationRow {
  // Påbörjad: something reported (OK or scrap) or an open/paused stamp
  // session — the work is under way and starts today.
  started: boolean;
  // Ligger fast: kept where it is by a move (the TO's other planned
  // operations) — treated like a locked one in this run, but it is not
  // locked, and the sequence-break text says so.
  fixed?: boolean;
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
  // move). Planned ones count on their planned days.
  existingOperations?: CapacityOperationRow[];
  // Standardkötid (planning_queue_time_days) as loaded for THIS run — the
  // wait between an order's operations on top of "the next working day".
  // Never a module constant (the setting changes; the tests change it).
  queueDays: number;
  // Flytta: this operation starts on `date` whatever is free there (the
  // day's whole capacity, overload allowed), locked or not. The service
  // compares the plan's startDate with `date`: a day without capacity
  // starts later and is refused before anything is written.
  forceStart?: { operationId: string; date: string };
  horizonWeeks?: number;
  // Orimligt mycket tid: the limit in normal weeks; 0 = no warning.
  // Default DEFAULT_LONG_OPERATION_WEEKS.
  longOperationWeeks?: number;
}

// An operation's new plan — what `writeOperationPlans` stores.
export interface OperationPlan {
  operationId: string; // mo_operations.id
  manufacturingOrderId: string;
  days: PlannedDay[];
  startDate: string; // = days[0].date
  endDate: string; // = days[last].date
}

export interface PlanWarning {
  kind: "late" | "horizon" | "sequence" | "unscheduled_resource" | "long_operation";
  manufacturingOrderId: string;
  orderNumber: string;
  sequenceNo?: number;
  workCenterCode?: string;
  dueDate?: string | null;
  plannedFinish?: string | null;
  remainingHours?: number; // long_operation: the operation's remaining time
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

const formatNumber = (n: number, decimals = 1) => n.toLocaleString("sv-SE", { maximumFractionDigits: decimals });
const hasPlan = (op: CapacityOperationRow) => !!op.plannedDays && op.plannedDays.length > 0;

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
  // Låst: a hand-moved operation keeps its days — it is existing load
  // before anything else is placed, and is never touched (unless it is the
  // one being moved again).
  const isLocked = (op: PlanOperation) =>
    op.operationStatus === "pending" && (!!op.planLocked || !!op.fixed) && hasPlan(op) && !isForced(op);

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
  const longOperation = longOperationChecker(book, firstMonday, input.longOperationWeeks);

  for (const order of [...input.orders].sort(compareOrderPriority)) {
    const head = { manufacturingOrderId: order.id, orderNumber: order.orderNumber };
    const unscheduledNoted = new Set<string>();
    // The chain: the first operation may use capacity from today, each next
    // one from the working day after the previous is ready + the queue time.
    // Done operations and operations without time never advance it (S7).
    const chain = operationChain(today, input.queueDays, input.offDays);
    let horizonHit = false;

    // Sekvensbrott (S13): the operation starts before the previous one is
    // READY (the same day counts — the next one starts the day after). A
    // start inside the queue time is no break: the queue is a planning
    // buffer, and a move into it is a choice.
    const sequenceBreak = (op: PlanOperation, code: string, startDate: string, what: string) => {
      const previousReady = chain.previousReady;
      if (previousReady !== null && startDate <= previousReady) {
        warnings.push({
          kind: "sequence",
          ...head,
          sequenceNo: op.sequenceNo,
          workCenterCode: code,
          message: `Op ${op.sequenceNo} på ${code} är ${what} ${startDate}, före föregående operation är klar (${previousReady})`,
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
      // Checked on every pending operation of our own resources — locked or
      // beyond the horizon too: the time is the data error, and the horizon
      // warning that may follow is usually its consequence.
      const long = longOperation(op, wc);
      if (long) warnings.push({ ...head, ...long });
      if (horizonHit) {
        // Nothing after the operation that did not fit is planned; a locked
        // one keeps its days (Planera never touches it).
        if (!isLocked(op) && hasPlan(op)) clear.push(op.moOperationId);
        continue;
      }
      if (isLocked(op)) {
        // Its stored days as the book holds them (the remaining load, passed
        // days today): the next operation's floor counts from its last day.
        const chunks = operationLoadDays(op, today);
        if (chunks.length === 0) continue; // nothing left — the plan is moot
        sequenceBreak(op, code, chunks[0]!.date!, op.planLocked ? "låst på" : "planerad och ligger fast på");
        chain.advance(chunks[chunks.length - 1]!.date!);
        continue;
      }
      if (wc?.type === "subcontract") {
        chain.advance(book.subcontract(wc, chain.floor()));
        if (hasPlan(op)) clear.push(op.moOperationId);
        continue;
      }
      const minutes = remainingOperationMinutes(op);
      if (minutes < MIN_PLAN_MINUTES) {
        if (hasPlan(op)) clear.push(op.moOperationId);
        continue;
      }
      const floor = chain.floor();
      // Påbörjad: the work is under way — it starts today (S8: today is a
      // whole day), whatever the chain says.
      const forceStartDate = isForced(op) ? forced!.date : op.started ? today : undefined;
      const placed = book.place(wc, minutes, forceStartDate ? { floor, forceStartDate } : { floor });
      if (placed.horizonExceeded) {
        // Not planned — what it booked before the horizon is given back, or
        // it would sit as phantom load for every TO planned after it.
        if (wc) book.release(wc, placed.partial);
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
      if (isForced(op)) sequenceBreak(op, code, placed.fromDate, "flyttad till");
      else if (op.started) sequenceBreak(op, code, placed.fromDate, "påbörjad och planerad från");
      plans.push({
        operationId: op.moOperationId,
        manufacturingOrderId: order.id,
        days: placed.days,
        startDate: placed.fromDate,
        endDate: placed.toDate,
      });
      chain.advance(placed.readyDate);
    }

    // Sen: the TO is ready (its latest operation, lego through its lead
    // time) after the due date — ready ON the due date is in time. A TO that hit the horizon has no finish — then Sen
    // is the matrix's rule for an unplanned TO (orderPlanStatus): the due
    // date has passed.
    const plannedFinish = horizonHit ? null : chain.ready;
    const late =
      order.dueDate !== null && (plannedFinish !== null ? plannedFinish > order.dueDate : order.dueDate < today);
    if (late) {
      warnings.push({
        kind: "late",
        ...head,
        dueDate: order.dueDate,
        plannedFinish,
        message:
          plannedFinish !== null
            ? `${order.orderNumber} blir klar ${plannedFinish}, efter färdigdatumet ${order.dueDate}`
            : `${order.orderNumber} är inte planerad och färdigdatumet ${order.dueDate} har passerat`,
      });
    }
    orders.push({ ...head, dueDate: order.dueDate, plannedFinish, late });
  }

  return { plans, clear, warnings, orders };
}

// The plan's world as a move reads it: the calendars, the resources as the
// book sees them and EVERY open operation with its allocation (the service's
// loadPlanWorld).
export interface MoveWorld {
  today: string;
  offDays: ReadonlySet<string>;
  workCenters: Map<string, PlanWorkCenter>;
  schedule: PlanProductionInput["schedule"];
  queueDays: number;
  longOperationWeeks?: number;
  operations: CapacityOperationRow[];
}

// Flytta's rule — ONE implementation for the hand move and Samkör (co-run.ts):
// the operation starts on `date` (the day's whole capacity, overload
// allowed). The TO's earlier operations and, without moveFollowing, its later
// ones keep their days (fixed load, like a lock); with moveFollowing the later
// unlocked ones are replanned from the new finish day (next working day +
// Standardkötid). Everything else is existing load. `stamped` = the
// operations with an open/paused stamp session (påbörjad, operationStarted).
// Never throws: the caller has already tested the status, lego and the time —
// and compares the operation's own plan with `date` (a day without capacity
// starts later). An operation that is not in the world gives an empty result.
export function planOperationMove(
  world: MoveWorld,
  stamped: ReadonlySet<string>,
  move: { operationId: string; date: string; moveFollowing: boolean }
): PlanProductionResult {
  const target = world.operations.find((o) => o.moOperationId === move.operationId);
  if (!target) return { plans: [], clear: [], warnings: [], orders: [] };
  const orderOps: PlanOperation[] = [];
  const fixed: CapacityOperationRow[] = [];
  for (const o of world.operations.filter((o) => o.manufacturingOrderId === target.manufacturingOrderId)) {
    const started = operationStarted(o, stamped.has(o.moOperationId));
    const replan =
      o.moOperationId === move.operationId ||
      o.operationStatus === "done" ||
      (o.sequenceNo > target.sequenceNo && move.moveFollowing && !o.planLocked);
    if (replan) orderOps.push({ ...o, started });
    // A lego operation always walks with the order: the engine never
    // books it, but it takes its place in the chain (its Ledtid and
    // its gap) exactly as in Planera — left out, the gaps after it
    // were counted one short (another day than the next Planera gives
    // with a Standardkötid in half days) and a move to before the lego
    // is back gave no sequence warning.
    else if (world.workCenters.get(o.workCenterId)?.type === "subcontract") orderOps.push({ ...o, started });
    // Kept as it is: planned ⇒ fixed load and the sequence floor, like a
    // lock but reported as "ligger fast" rather than "låst"; unplanned
    // ⇒ its due-date bucket, untouched.
    else if (hasPlan(o)) orderOps.push({ ...o, started, fixed: true });
    else fixed.push(o);
  }
  return planProduction({
    today: world.today,
    offDays: world.offDays,
    workCenters: world.workCenters,
    schedule: world.schedule,
    queueDays: world.queueDays,
    orders: [
      { id: target.manufacturingOrderId, orderNumber: target.orderNumber, dueDate: target.dueDate, operations: orderOps },
    ],
    existingOperations: [
      ...world.operations.filter((o) => o.manufacturingOrderId !== target.manufacturingOrderId),
      ...fixed,
    ],
    forceStart: { operationId: move.operationId, date: move.date },
    longOperationWeeks: world.longOperationWeeks,
  });
}

// The operations as writeOperationPlans leaves them after a run: a planned
// one with its rounded days (one that rounds away is cleared), a cleared one
// without days or lock. Planera's answer computes its förslag on this — the
// plan it just wrote, in memory, without reading it back (#15).
export function operationsWithPlan(
  operations: CapacityOperationRow[],
  result: Pick<PlanProductionResult, "plans" | "clear">
): CapacityOperationRow[] {
  const planned = new Map(result.plans.map((p) => [p.operationId, roundPlanDays(p.days)]));
  const cleared = new Set(result.clear);
  return operations.map((op) => {
    const days = planned.get(op.moOperationId);
    if (days !== undefined && days.length > 0) return { ...op, plannedDays: days };
    if (days !== undefined || cleared.has(op.moOperationId)) return { ...op, plannedDays: null, planLocked: false };
    return op;
  });
}

// Orimligt mycket tid for the operations of `orders` without planning them —
// the reservation writes Leveranstidskontrollen's days as they are, but its
// TOs get the same warning as one Planera places.
export function longOperationWarnings(
  input: Pick<PlanProductionInput, "today" | "offDays" | "workCenters" | "schedule" | "orders" | "longOperationWeeks">
): PlanWarning[] {
  const book = createCapacityBook({ ...input, existingOperations: [] });
  const check = longOperationChecker(book, mondayOf(input.today), input.longOperationWeeks);
  const warnings: PlanWarning[] = [];
  for (const order of input.orders) {
    for (const op of [...order.operations].sort((a, b) => a.sequenceNo - b.sequenceNo)) {
      if (op.operationStatus === "done") continue;
      const long = check(op, input.workCenters.get(op.workCenterId) ?? null);
      if (long) warnings.push({ manufacturingOrderId: order.id, orderNumber: order.orderNumber, ...long });
    }
  }
  return warnings;
}

type LongOperationWarning = Omit<PlanWarning, "manufacturingOrderId" | "orderNumber">;

// The check for one run: the normal week per resource is cached. Lego is
// never checked — the supplier's time is not our capacity.
function longOperationChecker(
  book: CapacityBook,
  firstMonday: string,
  limitWeeks = DEFAULT_LONG_OPERATION_WEEKS,
): (op: PlanOperation, wc: PlanWorkCenter | null) => LongOperationWarning | null {
  const cache = new Map<string, number | null>();
  const normalWeek = (wc: PlanWorkCenter | null): number | null => {
    if (!wc || !hasCapacityCalendar(wc)) return null;
    if (!cache.has(wc.workCenterId)) {
      let max = 0;
      for (let i = 1; i <= NORMAL_WEEK_SAMPLE; i++) max = Math.max(max, book.weekCapacity(wc, addDays(firstMonday, i * 7)));
      cache.set(wc.workCenterId, max > 0 ? max : null);
    }
    return cache.get(wc.workCenterId)!;
  };
  return (op, wc) => {
    if (limitWeeks <= 0 || wc?.type === "subcontract") return null;
    return longOperationWarning(op, wc, normalWeek(wc), limitWeeks);
  };
}

// The long_operation warning: remaining time, how many normal weeks it is
// and the routing values it comes from, so the planner can tell a wrong unit
// from a wrong quantity. null when the operation is within reason.
function longOperationWarning(
  op: PlanOperation,
  wc: PlanWorkCenter | null,
  weekMinutes: number | null,
  limitWeeks: number,
): LongOperationWarning | null {
  const minutes = remainingOperationMinutes(op);
  const week = weekMinutes ?? STANDARD_WEEK_MINUTES;
  if (minutes <= limitWeeks * week) return null;
  const code = wc?.code ?? "?";
  const remainingHours = roundToDecimals(minutes / 60, 1);
  const weeks = formatNumber(minutes / week);
  const scale =
    weekMinutes !== null
      ? `${weeks} veckors kapacitet på resursen (${formatNumber(weekMinutes / 60)} h/vecka)`
      : `${weeks} veckor à 40 h — resursen saknar kapacitet`;
  const routing = `ställtid ${formatNumber(op.setupTime, 2)} min, stycktid ${formatNumber(op.runTimePerUnit, 4)} min/st, antal ${formatNumber(op.orderQuantity, 3)} st`;
  return {
    kind: "long_operation",
    sequenceNo: op.sequenceNo,
    workCenterCode: code,
    remainingHours,
    message:
      `Op ${op.sequenceNo} på ${code} (${op.articleNumber} ${op.articleName}) har orimligt mycket tid: ` +
      `${formatNumber(remainingHours)} h kvar, motsvarar ${scale}; ${routing} — kontrollera operationens tider och orderns antal`,
  };
}
