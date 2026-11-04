// Tillverkningsledtid (manufacturing lead time) and a TO's start date — the
// rules every reader of "when must this be started" shares: the
// behovsberäkning's proposals, the färdigdatumsförslag, the article overview
// and Skapa ordrar. Pure, like requirements-calc.ts: the callers load the
// article field, the routing and the resources, this module owns the rules
// (ONE implementation, so the proposals and the TO they become agree).
//
// All dates are Stockholm days (YYYY-MM-DD) and lead times count WORKING
// days (delivery-days.ts).
import { addWorkingDays, nextWorkingDayOnOrAfter, subtractWorkingDays } from "../../system/service/delivery-days.js";
import { routingOperationMinutes } from "./capacity-calc.js";

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
// Neither touches Planera or Leveranstidskontrollen's capacity book — they
// only move the lead time and thereby the start date.
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

// The remaining operations' summed time plus the queue time between them,
// rounded UP to whole working days — a TO that needs 1.1 days of work cannot
// start the day before it is due. The rounding happens on the SUM (time +
// queues), never per operation. Reported-done operations are skipped: they
// take no time and no queue is waited for them, so a partly reported TO has
// max(0, remaining − 1) queues. No remaining operations ⇒ 0. toFixed(6)
// guards float noise (2.0000000000000004) from ceiling into an extra day.
export function leadDaysFromWork(work: readonly LeadTimeWork[], queueDays = 0): number {
  const remaining = work.filter((w) => !w.done);
  const days = remaining.reduce((sum, w) => sum + Math.max(workDays(w), 0), 0);
  const queues = Math.max(0, remaining.length - 1) * Math.max(0, queueDays);
  return Math.ceil(Number((days + queues).toFixed(6)));
}

// The article's lead time in working days, in this order:
// 1. the field Ledtid (dagar) (articles.manufacturing_lead_time_days) WINS
//    when set — a total throughput time independent of quantity;
// 2. the operations (a routing, or an existing TO's own operations) without
//    capacity, plus the Standardkötid between them (leadDaysFromWork);
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
// weeks only win when the plan is binding or later:
// - `planFixed` (an operation is locked by a move, or already reported on):
//   the Monday of the earliest planned week — the work is under way or was
//   placed by hand, so that is when the material is used;
// - a planned week LATER than the base (overload pushed the work back): the
//   material is not needed before the work can start.
// An earlier planned week is ignored on purpose (user decision 2026-11-01):
// Planera fills free capacity forward from today, so almost every new TO is
// planned for the current week however far off its due date is, and
// following that would make nearly every purchased component urgent.
// Without a due date the planned week is all there is; without either, null
// (an undated TO — as before). Shared by the article overview, the
// behovsberäkning and the färdigdatumsförslag, so a component's need never
// sits on a different day in one of them.
export function moStartDate(i: {
  plannedStartWeeks: readonly (string | null | undefined)[]; // mo_operations.planned_start_week (Mondays)
  planFixed: boolean;
  dueDate: string | null;
  leadDays: number;
  offDays: ReadonlySet<string>;
}): string | null {
  let earliest: string | null = null;
  for (const week of i.plannedStartWeeks) {
    if (week && (earliest === null || week < earliest)) earliest = week;
  }
  const base = i.dueDate === null ? null : subtractWorkingDays(i.dueDate, Math.max(0, i.leadDays), i.offDays);
  if (earliest === null) return base;
  if (base === null || i.planFixed || earliest > base) return earliest;
  return base;
}

// Lego (subcontract) operations are never placed on capacity (Planera clears
// their weeks), so their dates come BACKWARD from the TO's färdigdatum
// (user decision 2026-11-04):
// - `finishDate`: when the goods must be back from the supplier — the due
//   date minus the operations after the lego operation (their time without
//   capacity plus one Standardkötid before each of them: one between the
//   lego operation and the next, then between the following ones). The lego
//   IO row's Önskat leveransdatum (legoReturnDate).
// - `startDate`: when the goods must be AT the supplier — the finish minus
//   the resource's Ledtid + Kötid. The behovsberäkning's need date of the
//   lego row (its latest-order date is this minus Ledtid beställning).
// Rounded up on the sums (after, after + lego) like leadDaysFromWork, so the
// two dates never drift apart by a rounding. Done operations after it take
// no time and no queue. The article's field Ledtid (dagar) is a throughput
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
  const legoDays = Math.max(legoWorkDays(i.lego), 0);
  if (i.dueDate === null) {
    if (i.fallbackStart === null) return { startDate: null, finishDate: null };
    return { startDate: i.fallbackStart, finishDate: addWorkingDays(i.fallbackStart, ceilDays(legoDays), i.offDays) };
  }
  const remaining = i.after.filter((w) => !w.done);
  const afterDays =
    remaining.reduce((sum, w) => sum + Math.max(workDays(w), 0), 0) + remaining.length * Math.max(0, i.queueDays);
  return {
    finishDate: subtractWorkingDays(i.dueDate, ceilDays(afterDays), i.offDays),
    startDate: subtractWorkingDays(i.dueDate, ceilDays(afterDays + legoDays), i.offDays),
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

// toFixed(6): the same float-noise guard as leadDaysFromWork.
function ceilDays(days: number): number {
  return Math.ceil(Number(days.toFixed(6)));
}
