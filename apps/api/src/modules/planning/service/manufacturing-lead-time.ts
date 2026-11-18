// Tillverkningsledtid (manufacturing lead time) and a TO's start date — the
// rules every reader of "when must this be started" shares: the
// behovsberäkning's proposals, the färdigdatumsförslag, the article overview
// and Skapa ordrar. Pure, like requirements-calc.ts: the callers load the
// article field, the routing and the resources, this module owns the rules
// (ONE implementation, so the proposals and the TO they become agree).
//
// All dates are Stockholm days (YYYY-MM-DD) and lead times count WORKING
// days (delivery-days.ts).
//
// This file is the ROOT of the planning rules' imports (capacity-calc.ts and
// capacity-book.ts build on it, never the other way round): the day-rounding
// of the queue time (queueGapDays) is read by the capacity book's floor
// (nextOperationFloor) and by the lead time below, so the plan and the lead
// time can never round differently (#18, beslut 2).
import { addWorkingDays, nextWorkingDayOnOrAfter, subtractWorkingDays } from "../../system/service/delivery-days.js";

// The smallest time that is an operation at all: the plan stores minutes
// with two decimals under CHECK minutes > 0, so anything under a hundredth
// of a minute is never placed (capacity-book.ts re-exports the constant and
// explains the booking side). An operation under it takes no day and waits
// for no queue — in the book and in the lead time alike (#18, S7).
export const MIN_PLAN_MINUTES = 0.01;

// The work in MINUTES a routing operation takes for a quantity that has not
// been started yet (setup once, run time per unit). Leveranstidskontrollen
// and the manufacturing lead time share this one formula so a proposal's
// lead time and the check's capacity need never disagree. (Re-exported by
// capacity-calc.ts, where its other readers import it.)
export function routingOperationMinutes(op: { setupTime: number; runTimePerUnit: number }, quantity: number): number {
  return op.setupTime + op.runTimePerUnit * quantity;
}

// The resource as the lead time sees it. `type` decides the rule: our own
// resource turns minutes into days through its hours per day, a subcontract
// resource (legoresurs) is the supplier's lead time plus the queue time.
export interface LeadTimeResource {
  type: "machine" | "personnel" | "subcontract";
  hoursPerDay: number | null; // Kapacitet (timmar per dag); null ⇒ a normal 8 h day
  leadTimeDays: number | null; // legoresurs: working days the supplier takes
  queueTimeDays: number | null; // legoresurs: Kötid (dagar) on top of the lead time
}

// One operation's work: its minutes (unstarted routing operation = setup +
// run × quantity; an existing TO = remainingOperationMinutes) on a resource.
// A missing resource (deleted work center) counts as our own at 8 h/day —
// the honest guess, never a crash. `done` marks an existing TO's reported
// operation: it takes no more time and no queue time is waited for it, but
// it still proves the TO HAS operations (so the Standardledtid does not
// apply — a TO whose operations are all done needs 0 days, not the default).
export interface LeadTimeWork {
  minutes: number;
  resource: LeadTimeResource | null;
  done?: boolean;
}

// The system settings Standardledtid and Standardkötid (plan-settings.ts
// owns the keys and the decode; the planning repository loads them once per
// run with the rest of the dating inputs):
// - `defaultLeadDays`: the lead time of a manufactured article with neither
//   the field Ledtid (dagar) nor any operations;
// - `queueDays`: waiting time added BETWEEN consecutive operations (not
//   before the first or after the last) when the lead time comes from the
//   operations.
// The Standardledtid only moves the lead time. The Standardkötid is ALSO the
// capacity book's wait between operations (nextOperationFloor, #18) — the
// plan and the lead time count the same queue, rounded the same way
// (queueGapDays).
export interface LeadTimeDefaults {
  defaultLeadDays: number;
  queueDays: number;
}

export const NO_LEAD_TIME_DEFAULTS: LeadTimeDefaults = { defaultLeadDays: 0, queueDays: 0 };

const DEFAULT_HOURS_PER_DAY = 8;

// Days (fractional) one operation takes, without capacity: the time at a
// normal day on its own resource, or the supplier's lead + queue time.
function workDays(w: LeadTimeWork): number {
  if (w.resource?.type === "subcontract") {
    return (w.resource.leadTimeDays ?? 0) + (w.resource.queueTimeDays ?? 0);
  }
  const hours = w.resource?.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  return hours > 0 ? w.minutes / (hours * 60) : w.minutes / (DEFAULT_HOURS_PER_DAY * 60);
}

// toFixed(6) guards float noise (2.0000000000000004, 0.1 × 3) from ceiling
// into an extra day — the ONE day-rounding of the lead time, the queue time
// and the capacity book's lego days.
export function ceilDays(days: number): number {
  return Math.ceil(Number(days.toFixed(6)));
}

// The wait before the operation after gap `gapIndex` (1 = between the first
// and the second remaining operation), in whole working days. A decimal
// Standardkötid is rounded UP on the order's ACCUMULATED sum (#18, S4):
// ceil(k × q) − ceil((k − 1) × q). Three gaps of 0.5 day are 1 + 0 + 1 = 2
// days, exactly what the lead time counts for them (ceil(3 × 0.5)) — a
// rounding per gap would give 3. The gaps 1..n always sum to ceil(n × q).
export function queueGapDays(gapIndex: number, queueDays: number): number {
  const q = Math.max(0, queueDays);
  if (gapIndex < 1 || q === 0) return 0;
  return ceilDays(gapIndex * q) - ceilDays((gapIndex - 1) * q);
}

// Does the operation count in the chain: a lego operation always (the
// supplier's time), an own one only with time left (S7). Reported-done
// operations never.
const inChain = (w: LeadTimeWork) => !w.done && (w.resource?.type === "subcontract" || w.minutes >= MIN_PLAN_MINUTES);

// Whole working days ONE remaining operation takes, as the capacity book
// places it on an empty resource (#18, S5/S6): an own operation at least one
// whole day (ceil per operation — the next operation starts the working day
// after, so a 0.1-day operation still uses up its day). A lego operation
// takes the day it is SENT plus the supplier's Ledtid + Kötid rounded up —
// 1 + ceil(L + Q): the book sends it on its floor, has it back that many
// working days later, and starts the next operation the working day after
// it is back. L = Q = 0 is one day, like an own operation of a day.
function operationDays(w: LeadTimeWork): number {
  const days = ceilDays(Math.max(workDays(w), 0));
  return w.resource?.type === "subcontract" ? 1 + days : Math.max(1, days);
}

// The remaining operations' days plus the queue time between them — counted
// like the capacity book (#18, S5–S7; the property test "bok = ledtid" in
// production-plan.test.ts): every remaining own operation with time takes
// at least one whole day, a lego operation 1 + its Ledtid + Kötid rounded up,
// and the Standardkötid between the n operations that count is
// ceil((n − 1) × q) — the sum of their queueGapDays. Reported-done
// operations and operations without time are skipped: they take no day and
// no queue is waited for them. Nothing remaining ⇒ 0.
export function leadDaysFromWork(work: readonly LeadTimeWork[], queueDays = 0): number {
  const remaining = work.filter(inChain);
  const days = remaining.reduce((sum, w) => sum + operationDays(w), 0);
  return days + ceilDays(Math.max(0, remaining.length - 1) * Math.max(0, queueDays));
}

// The article's lead time in working days, in this order:
// 1. the field Ledtid (dagar) (articles.manufacturing_lead_time_days) WINS
//    when set — a total throughput time independent of quantity;
// 2. the operations (a routing, or an existing TO's own operations) on an
//    empty resource, plus the Standardkötid between them (leadDaysFromWork);
// 3. no operations at all — the article has no routing, or a planned TO
//    with no snapshot of an article without one — ⇒ the Standardledtid,
//    rounded up to whole days like the field;
// 4. nothing configured ⇒ 0.
// An existing TO whose operations are ALL done passes them as `done` work:
// that is case 2 with 0 days, not case 3.
export function manufacturingLeadDays(
  leadTimeDaysField: number | null | undefined,
  work: readonly LeadTimeWork[],
  defaults: LeadTimeDefaults = NO_LEAD_TIME_DEFAULTS
): number {
  if (leadTimeDaysField != null) return Math.max(0, Math.ceil(leadTimeDaysField));
  if (work.length === 0) return Math.max(0, Math.ceil(defaults.defaultLeadDays));
  return leadDaysFromWork(work, defaults.queueDays);
}

// The work of an unstarted routing (a proposal, a new TO) for a quantity —
// the same minute formula as Leveranstidskontrollen. Kalkyl (costing-only)
// operations must not be passed in, as there.
export function routingLeadWork(
  operations: readonly { workCenterId: string; setupTime: number; runTimePerUnit: number }[],
  quantity: number,
  resourceOf: (workCenterId: string) => LeadTimeResource | null | undefined
): LeadTimeWork[] {
  return operations.map((op) => ({
    minutes: routingOperationMinutes(op, quantity),
    resource: resourceOf(op.workCenterId) ?? null,
  }));
}

// When an existing TO starts (its material need date). The base is the due
// date minus the lead time in working days — the latest start that still
// finishes in time, the same rule the proposals use. The production plan's
// days only win when the plan is binding or later:
// - `planFixed` (an operation is locked by a move, or already reported on):
//   the earliest planned day — the work is under way or was placed by hand,
//   so that is when the material is used;
// - a planned day LATER than the base (overload pushed the work back): the
//   material is not needed before the work can start. The comparison is per
//   day (#18): two days of overload move the material date two days.
// An earlier planned day is ignored on purpose (user decision 2026-11-01):
// Planera fills free capacity forward from today, so almost every new TO is
// planned from today however far off its due date is, and following that
// would make nearly every purchased component urgent.
// Without a due date the planned day is all there is; without either, null
// (an undated TO — as before). Shared by the article overview, the
// behovsberäkning and the färdigdatumsförslag, so a component's need never
// sits on a different day in one of them.
export function moStartDate(i: {
  plannedStartDates: readonly (string | null | undefined)[]; // mo_operations.planned_start_date
  planFixed: boolean;
  dueDate: string | null;
  leadDays: number;
  offDays: ReadonlySet<string>;
}): string | null {
  let earliest: string | null = null;
  for (const date of i.plannedStartDates) {
    if (date && (earliest === null || date < earliest)) earliest = date;
  }
  const base = i.dueDate === null ? null : subtractWorkingDays(i.dueDate, Math.max(0, i.leadDays), i.offDays);
  if (earliest === null) return base;
  if (base === null || i.planFixed || earliest > base) return earliest;
  return base;
}

// Lego (subcontract) operations are never placed on capacity (Planera clears
// their plan), so their dates come BACKWARD from the TO's färdigdatum
// (user decision 2026-11-04):
// - `finishDate`: when the goods must be back from the supplier — the due
//   date minus the operations after the lego operation (their time without
//   capacity plus one Standardkötid before each of them: one between the
//   lego operation and the next, then between the following ones). The lego
//   IO row's Önskat leveransdatum (legoReturnDate).
// - `startDate`: when the goods must be AT the supplier — the finish minus
//   the resource's Ledtid + Kötid. The behovsberäkning's need date of the
//   lego row (its latest-order date is this minus Ledtid beställning).
// The operations after it are counted with leadDaysFromWork's own rule (#18:
// at least a day per own operation with time, a later lego operation
// 1 + its days, the queue rounded up on its sum), and the lego days are
// whole (S6) — the two dates are the capacity book's walk read backward:
// the goods are back (`finishDate`) the working day before the next
// operation starts, and were sent (`startDate`) ceil(Ledtid + Kötid) working
// days before that. Together the sent day and those days are the 1 + ceil
// the lead time counts for the operation. Done operations
// and operations without time after it take no day and no queue. The article's field Ledtid (dagar) is a throughput
// time for the whole TO and does not say where a single operation sits, so
// it is not read here. Without a due date the TO's start (moStartDate,
// `fallbackStart`) is the start and the finish follows it by the lego days;
// without either, both are null (undated).
export interface LegoOperationDates {
  startDate: string | null;
  finishDate: string | null;
}

export function legoOperationDates(i: {
  dueDate: string | null;
  fallbackStart: string | null;
  lego: LeadTimeResource | null;
  after: readonly LeadTimeWork[];
  queueDays: number;
  offDays: ReadonlySet<string>;
}): LegoOperationDates {
  const legoDays = ceilDays(Math.max(legoWorkDays(i.lego), 0));
  if (i.dueDate === null) {
    if (i.fallbackStart === null) return { startDate: null, finishDate: null };
    return { startDate: i.fallbackStart, finishDate: addWorkingDays(i.fallbackStart, legoDays, i.offDays) };
  }
  // One queue before EACH operation after the lego one (the lego operation
  // itself is the one before the first of them).
  const remaining = i.after.filter(inChain);
  const afterDays =
    remaining.reduce((sum, w) => sum + operationDays(w), 0) + ceilDays(remaining.length * Math.max(0, i.queueDays));
  return {
    finishDate: subtractWorkingDays(i.dueDate, afterDays, i.offDays),
    startDate: subtractWorkingDays(i.dueDate, afterDays + legoDays, i.offDays),
  };
}

// The lego IO row's Önskat leveransdatum: the operation's finish date, but
// never before the earliest return when ordered today — today + Ledtid
// beställning + Ledtid + Kötid (the same chain the proposal's latest-order
// date walks backward, so a row is `late` exactly when ordering today is
// past that date, give or take a rounding). An undated operation gets the
// earliest return, not late.
export function legoReturnDate(i: {
  finishDate: string | null;
  today: string;
  lego: LeadTimeResource | null;
  orderLeadTimeDays: number | null;
  offDays: ReadonlySet<string>;
}): { date: string; late: boolean } {
  const chain = Math.max(i.orderLeadTimeDays ?? 0, 0) + Math.max(legoWorkDays(i.lego), 0);
  const earliest = addWorkingDays(nextWorkingDayOnOrAfter(i.today, i.offDays), ceilDays(chain), i.offDays);
  if (i.finishDate === null || i.finishDate < earliest) return { date: earliest, late: i.finishDate !== null };
  return { date: i.finishDate, late: false };
}

function legoWorkDays(resource: LeadTimeResource | null): number {
  return workDays({ minutes: 0, resource: resource ?? { type: "subcontract", hoursPerDay: null, leadTimeDays: null, queueTimeDays: null } });
}
