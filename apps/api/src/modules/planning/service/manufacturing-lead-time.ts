// Tillverkningsledtid (manufacturing lead time) and a TO's start date — the
// rules every reader of "when must this be started" shares: the
// behovsberäkning's proposals, the färdigdatumsförslag, the article overview
// and Skapa ordrar. Pure, like requirements-calc.ts: the callers load the
// article field, the routing and the resources, this module owns the rules
// (ONE implementation, so the proposals and the TO they become agree).
//
// All dates are Stockholm days (YYYY-MM-DD) and lead times count WORKING
// days (delivery-days.ts).
import { subtractWorkingDays } from "../../system/service/delivery-days.js";
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
// the honest guess, never a crash.
export interface LeadTimeWork {
  minutes: number;
  resource: LeadTimeResource | null;
}

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

// The operations' summed time rounded UP to whole working days — a TO that
// needs 1.1 days of work cannot start the day before it is due. No
// operations ⇒ 0. toFixed(6) guards float noise (2.0000000000000004) from
// ceiling into an extra day.
export function leadDaysFromWork(work: readonly LeadTimeWork[]): number {
  const days = work.reduce((sum, w) => sum + Math.max(workDays(w), 0), 0);
  return Math.ceil(Number(days.toFixed(6)));
}

// The article's lead time in working days: the field Ledtid (dagar)
// (articles.manufacturing_lead_time_days) WINS when set — a total
// throughput time independent of quantity — otherwise the routing's
// operations without capacity (leadDaysFromWork).
export function manufacturingLeadDays(
  leadTimeDaysField: number | null | undefined,
  work: readonly LeadTimeWork[]
): number {
  if (leadTimeDaysField != null) return Math.max(0, Math.ceil(leadTimeDaysField));
  return leadDaysFromWork(work);
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

// When an existing TO starts (its material need date): the Monday of the
// EARLIEST planned week of its operations when any is planned, otherwise
// the due date minus the lead time in working days, otherwise null (an
// undated TO — as before). Shared by the article overview, the
// behovsberäkning and the färdigdatumsförslag, so a component's need never
// sits on a different day in one of them.
export function moStartDate(i: {
  plannedStartWeeks: readonly (string | null | undefined)[]; // mo_operations.planned_start_week (Mondays)
  dueDate: string | null;
  leadDays: number;
  offDays: ReadonlySet<string>;
}): string | null {
  let earliest: string | null = null;
  for (const week of i.plannedStartWeeks) {
    if (week && (earliest === null || week < earliest)) earliest = week;
  }
  if (earliest !== null) return earliest;
  if (i.dueDate === null) return null;
  return subtractWorkingDays(i.dueDate, Math.max(0, i.leadDays), i.offDays);
}
