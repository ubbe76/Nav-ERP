// Beläggning light (E2) — pure capacity-load calculation.
// No database imports: the repository loads flat rows and this module owns
// every business rule — remaining-time formula, day bucketing (#18), resource
// calendar resolution (week schedule + holidays, deliberately NOT payroll's
// employee-bound resolveEmployeeCalendar) and the group/resource matrix —
// fully unit-testable without a database (same pattern as requirements-calc).
import { isoWeekOf, isoWeekRange } from "../../timereport/service/schedule.service.js";
import { addWorkingDays, nextWorkingDayOnOrAfter } from "../../system/service/delivery-days.js";
import { ceilDays, MIN_PLAN_MINUTES, queueGapDays } from "./manufacturing-lead-time.js";
// Types only — resource-suggestions.ts computes the förslag on these rows.
import type { OperationResourceSuggestion, ResourceSuggestion } from "./resource-suggestions.js";
import { round2 } from "@navet/shared";

export interface CapacityWorkCenter {
  workCenterId: string;
  code: string;
  name: string;
  // Subcontract resources (legoresurser) never appear in the matrix — an
  // external supplier's capacity is not ours to plan. Excluded below.
  type: "machine" | "personnel" | "subcontract";
  productionGroupId: string | null;
  weekScheduleId: string | null;
  capacityFactor: number;
  // Kapacitet (timmar per dag) — used when there is no week schedule.
  hoursPerDay: number | null;
  active: boolean;
  // Legoresurs: working days the supplier takes (Ledtid + Kötid). Only read
  // when a lego operation is among an MO's pending ones (its finish decides
  // Sen).
  leadTimeDays?: number | null;
  queueTimeDays?: number | null;
}

// One day of an operation's plan: the Stockholm day and the minutes planned
// there (a `mo_operation_plan_days` row). Ascending by date, minutes > 0.
// The day is the plan's ONLY unit (#18) — a week is always derived from its
// days (mondayOf), never stored.
export interface PlannedDay {
  date: string;
  minutes: number;
}

// What a resource's daily capacity comes from: its week schedule, else its
// hours per day, else nothing (no capacity shown / not capacity-planned).
export interface ResourceCalendar {
  weekScheduleId: string | null;
  hoursPerDay: number | null;
}

export const hasCapacityCalendar = (r: ResourceCalendar) => r.weekScheduleId != null || r.hoursPerDay != null;

export interface CapacityProductionGroup {
  productionGroupId: string;
  code: string;
  name: string;
}

export interface CapacityOperationRow {
  moOperationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  workCenterId: string;
  orderQuantity: number;
  dueDate: string | null; // MO header due date (YYYY-MM-DD)
  sequenceNo: number;
  // The operation's benämning (mo_operations.description) — only the körplan
  // prints it; left out by the fixtures.
  description?: string | null;
  setupTime: number; // minutes
  runTimePerUnit: number; // minutes
  operationStatus: "pending" | "done";
  quantityCompleted: number | null;
  // Needed to tell "untouched" from "started, everything scrapped" —
  // reportOperationQuantities writes quantityCompleted "0" on scrap-only
  // reports, but the setup is consumed either way once work has started.
  quantityScrapped: number;
  // Reported time on the operation (#15, time_reports.work_center_id): on
  // the operation's current resource (a report without a resource counts
  // there), and on another resource — worked before a Byt resurs. Optional:
  // left out (fixtures) = no time, the quantity rule alone, as before.
  timeOnCurrentResource?: boolean;
  timeOnOtherResource?: boolean;
  // The operation's plan (planerade dagar). Optional on purpose: rows
  // without one count on the MO's due date. Empty = unplanned too.
  plannedDays?: PlannedDay[] | null;
  planLocked?: boolean;
  // The place among the resource's operations with the same planned start
  // day, set by hand in the körplan (mo_operations.run_position, #18). Read
  // ONLY by the körplan — never by the book, Sen or the matrix.
  runPosition?: number | null;
  plannedAt?: string | null; // ISO timestamp of the run that planned it
  // Alternativa resurser (#15): Vald för hand (mo_operations.resource_locked).
  resourceLocked?: boolean;
  // The operation's possible resources (mo_operation_resources, rank 0 = the
  // beredning's ordinarie). Left out or [] = no alternatives. Loaded only by
  // the readers that suggest (loadCapacityInput's `resources`).
  resources?: OperationResourceOption[];
  // Rörd (operationTouchedSql: reported, time, stamped or scrapped) — loaded
  // with `resources`; such an operation never gets a förslag. Left out =
  // only the row's own quantities and time flags count.
  touched?: boolean;
  // Instämplad: an open or paused stamp session (stampedOperationIds) —
  // loaded with `resources`. With the reported quantities it is Planera's
  // påbörjad (operationStarted), which the förslag's walk must share.
  stamped?: boolean;
}

export interface OperationResourceOption {
  workCenterId: string;
  rank: number;
  setupTime: number; // minutes, resolved at the snapshot
  runTimePerUnit: number;
}

export interface WeekScheduleDayRow {
  weekScheduleId: string;
  weekday: number; // ISO 1 = Monday … 7 = Sunday
  dayScheduleId: string;
}

export interface DayScheduleNetRow {
  id: string;
  netMinutes: number; // precomputed by the repository via computeDayScheduleNetMinutes
}

export interface HolidayRow {
  date: string;
  dayScheduleId: string | null; // null = fully off (röd dag), set = reduced day
}

export interface CapacityInput {
  workCenters: CapacityWorkCenter[];
  productionGroups: CapacityProductionGroup[];
  operations: CapacityOperationRow[];
  weekScheduleDays: WeekScheduleDayRow[];
  daySchedules: DayScheduleNetRow[];
  holidays: HolidayRow[];
}

export interface CapacityCellOrder {
  moOperationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  sequenceNo: number;
  dueDate: string | null;
  overdue: boolean;
  remainingHours: number; // the operation's whole remaining time
  // Its share in this cell's WEEK — a planned operation spans cells. In the
  // week view that is the cell itself; in the day view the sum of its days in
  // the ISO week of the cell's day (Senare/Utan datum: the cell's share).
  hoursInWeek: number;
  // Its share in this DAY cell (granularity=day); null in the week view.
  hoursInDay: number | null;
  planned: boolean;
  plannedStartDate: string | null; // the plan's first and last day; null when unplanned
  plannedEndDate: string | null;
  planLocked: boolean;
  late: boolean; // the MO's Sen — its last pending operation finishes after the due date
  // Pegging (#9): Halvfabrikat sent — a TO that covers one of this order's
  // material needs is late for it (the service computes the set once).
  componentLate: boolean;
  // Alternativa resurser (#15): Vald för hand; the ordinarie's code when the
  // operation is on an alternative (null on the ordinarie or without
  // alternatives); the förslag (derived at this read, never stored).
  resourceLocked: boolean;
  ordinaryWorkCenterCode: string | null;
  suggestion: OperationResourceSuggestion | null;
}

export interface CapacityCell {
  loadHours: number;
  availableHours: number | null; // null = no schedule (or undated/later columns)
  loadPercent: number | null; // null when availableHours is null or 0
  // Overload — the ONE rule, read by the summary's count and by the web's red
  // tone and list: more load than capacity (loadPercent > 100), or load in a
  // week whose schedule gives 0 h (a closed week, a week of holidays). The
  // second has no percentage to show — loadPercent stays null — but it is the
  // most overloaded a cell can be, not a neutral one. A resource WITHOUT a
  // schedule (availableHours null) is never overloaded: no capacity is known.
  overloaded: boolean;
  // The overloaded DAYS in the cell's span (S14): a week cell is red on the
  // week's sum, but a day in it can be over while the week is not — then
  // this says how many. A day cell: 1 or 0. Senare/Utan datum: 0.
  overloadedDays: number;
  orders: CapacityCellOrder[];
}

// One day of a resource without the orders: the load bucketed there and the
// capacity that day — what Flytta's "ledigt 3 h av 8" reads, in both views.
// The same finishCell rule as every cell (rounding, overload).
export interface CapacityDayLoad {
  date: string;
  loadHours: number;
  availableHours: number | null; // null = no capacity calendar
  overloaded: boolean;
}

export interface CapacityDay {
  date: string;
  isoWeek: number;
  weekday: number; // ISO 1 = Monday … 7 = Sunday
}

export interface CapacityResourceRow {
  workCenterId: string;
  code: string;
  name: string;
  type: "machine" | "personnel" | "subcontract";
  active: boolean;
  capacityFactor: number;
  hasSchedule: boolean;
  weeks: CapacityCell[]; // index-aligned with CapacityResult.weeks ([] in the day view)
  days: CapacityCell[]; // index-aligned with CapacityResult.days ([] in the week view)
  // Every day of the visible columns (week view: the first week's Monday to
  // the last week's Sunday; day view: the days), ascending.
  dayLoads: CapacityDayLoad[];
  later: CapacityCell; // due date beyond the horizon
  undated: CapacityCell; // no due date
}

export interface CapacityGroupBlock {
  productionGroupId: string | null; // null = "Ogrupperade resurser"
  code: string | null;
  name: string;
  resources: CapacityResourceRow[];
  weekTotals: CapacityCell[];
  dayTotals: CapacityCell[];
  laterTotal: CapacityCell;
  undatedTotal: CapacityCell;
}

export interface CapacityWeek {
  isoYear: number;
  isoWeek: number;
  monday: string;
  sunday: string;
}

export interface CapacitySummary {
  plannedAt: string | null; // the latest plan run (max plannedAt over the operations)
  // Resource cells with `overloaded` in the view's columns: resource × week
  // (week view), resource × day (day view).
  overloadedCells: number;
  // Resource × day cells with `overloaded` over the visible days — in the
  // week view the days a red OR a calm week cell hides.
  overloadedDays: number;
  lateOrders: { manufacturingOrderId: string; orderNumber: string; dueDate: string | null; plannedFinish: string | null }[];
  unplannedOrders: { manufacturingOrderId: string; orderNumber: string }[];
  // Förslag på resurs (#15): every open operation's förslag, by order number
  // and sequence (the räknare's list — not narrowed by the group filter).
  resourceSuggestions: ResourceSuggestion[];
  // "N låsta": the pending operations with a locked plan (Flytta, Samkör,
  // the reservation) among the loaded ones — not narrowed by the group
  // filter either. Strukturvyn's node counter is the same predicate.
  lockedOperations: number;
}

export interface CapacityResult {
  // The Stockholm day the server counted with — the web's "today" (Flytta's
  // earliest day) is this one, never the browser's.
  today: string;
  granularity: "week" | "day";
  weeks: CapacityWeek[]; // [] in the day view
  days: CapacityDay[]; // [] in the week view
  groups: CapacityGroupBlock[];
  summary: CapacitySummary;
}

// Remaining work in MINUTES for one operation. Setup is a one-off on the
// operation's CURRENT resource (setupDoneOnCurrentResource): consumed once
// that resource has worked it. Untouched operations keep the full setup.
// Narrowed to the fields it reads so the lead-time dating (requirements-
// dating.ts) can hand in a TO operation without the capacity row's labels.
export type RemainingMinutesOperation = Pick<
  CapacityOperationRow,
  | "operationStatus"
  | "orderQuantity"
  | "quantityCompleted"
  | "quantityScrapped"
  | "runTimePerUnit"
  | "setupTime"
  | "timeOnCurrentResource"
  | "timeOnOtherResource"
>;

// Has the operation's current resource been set up — the avvikelseanalys's
// ställregel (operationWorked in cost-variance.ts: time, OK or scrapped
// counts as worked) applied to the resource the operation is on now (#15):
// - time reported on the current resource ⇒ set up (e.g. Ställ klart, 0/0);
// - a reported quantity (OK or scrapped — a scrap-only report leaves
//   quantityCompleted at "0" but the machine is set up) ⇒ set up, unless the
//   time shows the work was done on another resource before a Byt resurs:
//   then the new resource's setup is still to come. The avvikelseanalys's
//   base also counts it once on the current resource (a switch is a new
//   plan), so the plan and the base expect the same setup.
export function setupDoneOnCurrentResource(op: RemainingMinutesOperation): boolean {
  if (op.timeOnCurrentResource) return true;
  const quantityReported = (op.quantityCompleted ?? 0) > 0 || op.quantityScrapped > 0;
  return quantityReported && !op.timeOnOtherResource;
}

export function remainingOperationMinutes(op: RemainingMinutesOperation): number {
  if (op.operationStatus === "done") return 0;
  const remainingQty = Math.max(op.orderQuantity - (op.quantityCompleted ?? 0), 0);
  return op.runTimePerUnit * remainingQty + (setupDoneOnCurrentResource(op) ? 0 : op.setupTime);
}

// The minute formula of an unstarted routing operation lives with the lead
// time (the root of these files' imports); its readers import it from here.
export { routingOperationMinutes } from "./manufacturing-lead-time.js";

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// Prebuilt lookups shared across every resource × week in a run — rebuilding
// them per resolver call would be O(R × W × dataset).
export interface ScheduleLookups {
  netByDaySchedule: Map<string, number>;
  daysBySchedule: Map<string, Map<number, string>>; // weekScheduleId -> weekday -> dayScheduleId
  holidayByDate: Map<string, HolidayRow>;
}

export function buildScheduleLookups(
  weekScheduleDays: WeekScheduleDayRow[],
  daySchedules: DayScheduleNetRow[],
  holidays: HolidayRow[]
): ScheduleLookups {
  const daysBySchedule = new Map<string, Map<number, string>>();
  for (const row of weekScheduleDays) {
    const days = daysBySchedule.get(row.weekScheduleId) ?? new Map<number, string>();
    days.set(row.weekday, row.dayScheduleId);
    daysBySchedule.set(row.weekScheduleId, days);
  }
  return {
    netByDaySchedule: new Map(daySchedules.map((d) => [d.id, d.netMinutes])),
    daysBySchedule,
    holidayByDate: new Map(holidays.map((h) => [h.date, h])),
  };
}

// Available hours for one resource in one calendar week: Monday–Sunday.
// A holiday only REDUCES capacity: on a scheduled day it replaces the day
// with the holiday's own day schedule (null = fully off); on a day the week
// schedule already has off it adds nothing. Deliberately NOT payroll's
// employee resolver — no employee overrides here.
function resolveWeekHoursFromLookups(
  lookups: ScheduleLookups,
  calendar: ResourceCalendar,
  capacityFactor: number,
  isoYear: number,
  isoWeek: number
): number {
  const { monday } = isoWeekRange(isoYear, isoWeek);
  let minutes = 0;
  for (let i = 0; i < 7; i++) minutes += resourceDayMinutes(lookups, calendar, addDays(monday, i));
  return (minutes / 60) * capacityFactor;
}

// One day's net minutes for a resource (before the capacity factor) — the
// single day rule the week sum and Leveranstidskontrollen's day-by-day
// booking share. A week schedule gives its day schedule; without one, hours
// per day count Monday–Friday. Either way a holiday only REDUCES: a full
// holiday is off, a shortened one (with its own day schedule) replaces the
// day, and a day the resource has off never gains anything.
export function resourceDayMinutes(lookups: ScheduleLookups, calendar: ResourceCalendar, date: string): number {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7; // ISO 1 = Monday … 7 = Sunday
  let normal: number;
  if (calendar.weekScheduleId != null) {
    const dayScheduleId = lookups.daysBySchedule.get(calendar.weekScheduleId)?.get(weekday);
    normal = dayScheduleId ? (lookups.netByDaySchedule.get(dayScheduleId) ?? 0) : 0;
  } else if (calendar.hoursPerDay != null) {
    normal = weekday <= 5 ? calendar.hoursPerDay * 60 : 0;
  } else {
    return 0;
  }
  if (normal <= 0) return 0;
  const holiday = lookups.holidayByDate.get(date);
  if (holiday) return holiday.dayScheduleId ? (lookups.netByDaySchedule.get(holiday.dayScheduleId) ?? 0) : 0;
  return normal;
}

// The day an UNPLANNED operation's remaining load counts on: its MO's due
// date, a passed due date today — the work can't happen in the past — and
// null for an undated MO (the matrix's "Utan datum" column;
// Leveranstidskontrollen leaves it out).
export function loadBucketDay(dueDate: string | null, today: string): string | null {
  if (dueDate == null) return null;
  return dueDate < today ? today : dueDate;
}

// The Monday of the ISO week a date is in.
export function mondayOf(date: string): string {
  const { isoYear, isoWeek } = isoWeekOf(date);
  return isoWeekRange(isoYear, isoWeek).monday;
}

const EPS = 1e-9;

// How an operation's REMAINING time sits in its plan: the allocation is
// filled from the back — the work already done is assumed to have happened
// on the earliest days — so 600 min planned Mon: 400 / Tue: 200 with 300
// left is Mon: 100 / Tue: 200. More remaining than planned (Ångra
// rapportering) puts the excess on the last day. Days before `today` are
// clamped to today: the work can't happen in the past (a plan from last
// Friday that was not worked lies on today until Planera runs — the book
// rolls it forward).
// Returns ascending days with minutes > 0; [] when nothing remains.
export function remainingByPlannedDays(remaining: number, plannedDays: PlannedDay[], today: string): PlannedDay[] {
  if (remaining <= EPS || plannedDays.length === 0) return [];
  const clamped = new Map<string, number>();
  for (const d of [...plannedDays].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const date = d.date < today ? today : d.date;
    clamped.set(date, (clamped.get(date) ?? 0) + d.minutes);
  }
  const days = [...clamped].map(([date, minutes]) => ({ date, minutes }));
  const planned = days.reduce((sum, d) => sum + d.minutes, 0);
  const excess = Math.max(0, remaining - planned);
  const out: PlannedDay[] = [];
  let rest = remaining;
  for (let i = days.length - 1; i >= 0 && rest > EPS; i--) {
    const room = days[i]!.minutes + (i === days.length - 1 ? excess : 0);
    const minutes = Math.min(room, rest);
    if (minutes > EPS) out.unshift({ date: days[i]!.date, minutes });
    rest -= minutes;
  }
  return out;
}

// An operation's planned days as a range: the first and last day of its
// allocation, null when unplanned. The ONE reading of "planerad" for the
// matrix's chips, the körplan and the TO readers.
export function plannedDateRange(op: Pick<CapacityOperationRow, "plannedDays">): { start: string; end: string } | null {
  if (!op.plannedDays || op.plannedDays.length === 0) return null;
  const dates = op.plannedDays.map((d) => d.date).sort();
  return { start: dates[0]!, end: dates[dates.length - 1]! };
}

// The day an operation is due to start, NOT clamped to today (the körplan's
// dagnyckel — a day before today is Försenad): the plan's first day when
// planned, else the MO's due date — the very day operationLoadDays buckets
// an unplanned operation on before it clamps the past to today
// (loadBucketDay). null = neither a plan nor a due date.
export function operationStartDate(op: Pick<CapacityOperationRow, "plannedDays" | "dueDate">): string | null {
  return plannedDateRange(op)?.start ?? op.dueDate;
}

// The days an operation's remaining load counts on — the ONE bucketing rule
// the matrix, the capacity book (Planera, Leveranstidskontrollen) and Sen
// share. Planned: the allocation filled from the back (above). Unplanned:
// one bucket on the due date (passed ⇒ today, null = undated).
export function operationLoadDays(op: CapacityOperationRow, today: string): { date: string | null; minutes: number }[] {
  const minutes = remainingOperationMinutes(op);
  if (minutes <= 0) return [];
  if (op.plannedDays && op.plannedDays.length > 0) return remainingByPlannedDays(minutes, op.plannedDays, today);
  return [{ date: loadBucketDay(op.dueDate, today), minutes }];
}

// Låst — a pending operation whose planned days Planera keeps (Flytta,
// Samkör, the reservation). ONE predicate for Beläggning's "N låsta" and
// Strukturvyn's counters.
export function isLockedOperation(op: Pick<CapacityOperationRow, "operationStatus" | "planLocked">): boolean {
  return op.operationStatus === "pending" && (op.planLocked ?? false);
}

// Påbörjad — ONE rule for Planera, Flytta, the replanning after a Byt and
// the förslag's walk: something reported (OK or scrap) or an open/paused
// stamp session. Such an operation is under way and starts TODAY whatever
// the chain says. (Not `touched`: a finished stamp without quantities is
// rörd — no förslag — but does not force today.)
export function operationStarted(
  op: Pick<CapacityOperationRow, "quantityCompleted" | "quantityScrapped">,
  stamped: boolean
): boolean {
  return (op.quantityCompleted ?? 0) > 0 || op.quantityScrapped > 0 || stamped;
}

// --- The chain of an order's operations (#18, beslut 2) --------------------
// The next operation starts the working day AFTER the previous one is ready,
// plus the Standardkötid — ONE pure function for Planera, the planning of a
// new TO, the förslag, Leveranstidskontrollen and Sen (capacity-book.ts
// re-exports it: it is the book's floor). Counted in the COMPANY's working
// days (Mon–Fri without full-day holidays, S3): the queue time is a system
// setting in working days and the lead time counts the same days; the
// resource's own calendar then decides where there is capacity from the
// floor. `gapIndex` is the gap's ordinal among the order's remaining
// operations with time or lego (1 = before the second); queueGapDays rounds
// the queue up on the accumulated sum (S4).
export function nextOperationFloor(
  readyDate: string,
  gapIndex: number,
  queueDays: number,
  offDays: ReadonlySet<string>
): string {
  return addWorkingDays(readyDate, 1 + queueGapDays(gapIndex, queueDays), offDays);
}

// A lego operation sent on `floor` is back the supplier's Ledtid + Kötid
// later, rounded up to whole working days (S6 — the lead time counts both).
// The floor is normalised to a working day HERE, for every reader: a chain
// that starts on `today` (Planera, orderPlanStatus, the förslag) would
// otherwise count the Monday after a Saturday as day 1, one working day
// earlier than Leveranstidskontrollen, which starts on the next working day.
export function subcontractReadyDate(
  wc: { leadTimeDays?: number | null; queueTimeDays?: number | null },
  floor: string,
  offDays: ReadonlySet<string>
): string {
  return addWorkingDays(nextWorkingDayOnOrAfter(floor, offDays), subcontractDays(wc), offDays);
}

// A lego resource's Ledtid + Kötid in whole working days — the days
// subcontractReadyDate adds after the floor, and Strukturvyn's text
// "Lego · N dagar" (ONE expression for both).
export function subcontractDays(wc: { leadTimeDays?: number | null; queueTimeDays?: number | null }): number {
  return ceilDays(Math.max(0, (wc.leadTimeDays ?? 0) + (wc.queueTimeDays ?? 0)));
}

// The walk every reader of the chain makes, so none of them can count the
// gaps differently (the förslag promising a day Byt does not give was
// exactly that kind of drift, #15 etapp 3): `floor()` is the day the next
// operation may use capacity from — `start` for the first one (no gap before
// it), else nextOperationFloor from the latest ready day so far —
// and `advance(readyDate)` is called for every operation that takes a place
// in the chain: an own operation with time, a lego operation. Done
// operations and operations without time are simply not advanced (S7: no
// day, no queue).
export interface OperationChain {
  readonly ready: string; // the latest ready day so far (`start` before any operation)
  readonly previousReady: string | null; // null until an operation has gone before
  floor(): string;
  advance(readyDate: string): void;
}

export function operationChain(start: string, queueDays: number, offDays: ReadonlySet<string>): OperationChain {
  let ready = start;
  let gaps = 0;
  return {
    get ready() {
      return ready;
    },
    get previousReady() {
      return gaps === 0 ? null : ready;
    },
    floor: () => (gaps === 0 ? start : nextOperationFloor(ready, gaps, queueDays, offDays)),
    advance(readyDate) {
      if (readyDate > ready) ready = readyDate;
      gaps += 1;
    },
  };
}

export interface PlanStatusWorkCenter extends ResourceCalendar {
  type: "machine" | "personnel" | "subcontract";
  leadTimeDays?: number | null;
  queueTimeDays?: number | null;
}

// Sen: an MO is ready after its due date. The finish is walked through the
// plan with the book's own chain (operationChain — so the status and Planera
// never disagree): a planned operation is ready on the LAST DAY of its
// remaining allocation (operationLoadDays, so never before today), a lego
// operation its Ledtid + Kötid after the floor the chain gives it
// (nextOperationFloor + subcontractReadyDate). plannedFinish is the latest of
// them. Ready ON the due date is in time. An MO with a pending operation
// that lacks a plan (other than lego/no time) is unplanned — then Sen is
// today's Försenad: the due date has passed.
export function orderPlanStatus(
  operations: CapacityOperationRow[],
  ctx: {
    today: string;
    offDays: ReadonlySet<string>;
    workCenters: Map<string, PlanStatusWorkCenter>;
    // Standardkötid — only a lego operation's floor reads it here (the own
    // operations' days are stored). Left out = 0.
    queueDays?: number;
  }
): { planned: boolean; plannedFinish: string | null; late: boolean } {
  const pending = operations.filter((op) => op.operationStatus === "pending").sort((a, b) => a.sequenceNo - b.sequenceNo);
  const dueDate = operations[0]?.dueDate ?? null;
  const chain = operationChain(ctx.today, ctx.queueDays ?? 0, ctx.offDays);
  for (const op of pending) {
    const wc = ctx.workCenters.get(op.workCenterId) ?? null;
    if (wc?.type === "subcontract") {
      chain.advance(subcontractReadyDate(wc, chain.floor(), ctx.offDays));
      continue;
    }
    // Nothing left to do, or less than the plan can hold (Planera clears it).
    if (remainingOperationMinutes(op) < MIN_PLAN_MINUTES) continue;
    if (!op.plannedDays || op.plannedDays.length === 0) {
      return { planned: false, plannedFinish: null, late: dueDate != null && dueDate < ctx.today };
    }
    const days = operationLoadDays(op, ctx.today);
    chain.advance(days[days.length - 1]!.date!);
  }
  return { planned: true, plannedFinish: chain.ready, late: dueDate != null && chain.ready > dueDate };
}

// Public convenience wrapper (used directly by the unit tests) — builds the
// lookups itself; computeCapacity builds them once per run instead.
export function resolveResourceWeekHours(args: {
  weekScheduleId: string | null;
  hoursPerDay?: number | null;
  capacityFactor: number;
  isoYear: number;
  isoWeek: number;
  weekScheduleDays: WeekScheduleDayRow[];
  daySchedules: DayScheduleNetRow[];
  holidays: HolidayRow[];
}): number {
  return resolveWeekHoursFromLookups(
    buildScheduleLookups(args.weekScheduleDays, args.daySchedules, args.holidays),
    { weekScheduleId: args.weekScheduleId, hoursPerDay: args.hoursPerDay ?? null },
    args.capacityFactor,
    args.isoYear,
    args.isoWeek
  );
}

// The single horizon authority — the service uses this for its holiday query
// bounds so the two derivations can never drift apart.
export function capacityHorizon(today: string, weeks: number): { firstMonday: string; horizonSunday: string } {
  const first = isoWeekOf(today);
  const firstMonday = isoWeekRange(first.isoYear, first.isoWeek).monday;
  return { firstMonday, horizonSunday: addDays(firstMonday, weeks * 7 - 1) };
}

function emptyCell(): CapacityCell {
  return { loadHours: 0, availableHours: null, loadPercent: null, overloaded: false, overloadedDays: 0, orders: [] };
}

function finishCell(cell: CapacityCell): CapacityCell {
  cell.loadHours = round2(cell.loadHours);
  if (cell.availableHours != null) cell.availableHours = round2(cell.availableHours);
  cell.loadPercent =
    cell.availableHours != null && cell.availableHours > 0
      ? Math.round((cell.loadHours / cell.availableHours) * 100)
      : null;
  // After the rounding above, so the flag and the figures shown agree.
  cell.overloaded = cell.loadPercent != null ? cell.loadPercent > 100 : cell.availableHours === 0 && cell.loadHours > 0;
  cell.orders.sort((a, b) =>
    a.orderNumber !== b.orderNumber ? (a.orderNumber < b.orderNumber ? -1 : 1) : a.sequenceNo - b.sequenceNo
  );
  return cell;
}

// A day without its orders, through the same finishCell (the ONE overload
// rule) as the cells.
function dayLoadOf(date: string, loadHours: number, availableHours: number | null): CapacityDayLoad {
  const cell = finishCell({ ...emptyCell(), loadHours, availableHours });
  return { date, loadHours: cell.loadHours, availableHours: cell.availableHours, overloaded: cell.overloaded };
}

// The load and the capacity of ONE day per resource — the same three rules
// computeCapacity puts together for `dayLoads`: operationLoadDays (the
// bucket), resourceDayMinutes × capacityFactor (the capacity) and dayLoadOf /
// finishCell (rounding, overload). Never a rule of its own: the test "equals
// the matrix's dayLoads" compares it with the day view for every resource
// and day. Keyed on workCenterId; every own resource is in (loadHours 0
// without load), legoresurser never — as in the matrix.
export function resourceDayLoads(
  input: Pick<CapacityInput, "workCenters" | "operations" | "weekScheduleDays" | "daySchedules" | "holidays">,
  today: string,
  date: string
): Map<string, CapacityDayLoad> {
  const lookups = buildScheduleLookups(input.weekScheduleDays, input.daySchedules, input.holidays);
  const workCenters = input.workCenters.filter((w) => w.type !== "subcontract");
  const loadHours = new Map<string, number>(workCenters.map((w) => [w.workCenterId, 0]));
  for (const operation of input.operations) {
    const hours = loadHours.get(operation.workCenterId);
    if (hours === undefined) continue;
    // Summed per operation in hours, as the matrix's day cell is.
    let minutes = 0;
    for (const chunk of operationLoadDays(operation, today)) if (chunk.date === date) minutes += chunk.minutes;
    if (minutes > 0) loadHours.set(operation.workCenterId, hours + minutes / 60);
  }
  return new Map(
    workCenters.map((w) => [
      w.workCenterId,
      dayLoadOf(
        date,
        loadHours.get(w.workCenterId)!,
        hasCapacityCalendar(w) ? (resourceDayMinutes(lookups, w, date) / 60) * w.capacityFactor : null
      ),
    ])
  );
}

export function computeCapacity(
  input: CapacityInput,
  // offDays (full-day holidays) and queueDays (Standardkötid) only matter for
  // Sen: a lego operation's floor and lead time.
  // resourceSuggestions: the förslag computed on the same input
  // (resourceSuggestions in resource-suggestions.ts) — on the cells and in
  // the summary; left out = none.
  // componentLateOrders: the orders with Halvfabrikat sent (pegging #9),
  // computed by the service in one batch; left out = none.
  options: {
    today: string;
    weeks: number;
    // The day view (#18): `days` columns from today instead of the weeks.
    // Left out = the week view.
    granularity?: "week" | "day";
    days?: number;
    offDays?: ReadonlySet<string>;
    queueDays?: number;
    resourceSuggestions?: ResourceSuggestion[];
    componentLateOrders?: ReadonlySet<string>;
  }
): CapacityResult {
  const offDays = options.offDays ?? new Set<string>();
  const lookups = buildScheduleLookups(input.weekScheduleDays, input.daySchedules, input.holidays);
  const suggestions = options.resourceSuggestions ?? [];
  const suggestionByOperation = new Map(
    suggestions.map((s) => [
      s.moOperationId,
      { workCenterId: s.toWorkCenterId, code: s.toCode, name: s.toName, toDate: s.toDate, currentToDate: s.currentToDate, reason: s.reason },
    ])
  );
  const codeOf = new Map(input.workCenters.map((w) => [w.workCenterId, w.code]));
  // On an alternative: the ordinarie (rank 0) is another resource.
  const ordinaryCodeOf = (op: CapacityOperationRow): string | null => {
    const ordinary = op.resources?.find((r) => r.rank === 0);
    return ordinary && ordinary.workCenterId !== op.workCenterId ? (codeOf.get(ordinary.workCenterId) ?? null) : null;
  };

  // Sen / planned per MO is walked over ALL its operations — lego included,
  // since a lego operation last in the route decides the finish — before
  // the lego operations leave the load below.
  const operationsByOrder = new Map<string, CapacityOperationRow[]>();
  for (const op of input.operations) {
    operationsByOrder.set(op.manufacturingOrderId, [...(operationsByOrder.get(op.manufacturingOrderId) ?? []), op]);
  }
  const statusWorkCenters = new Map<string, PlanStatusWorkCenter>(
    input.workCenters.map((w) => [
      w.workCenterId,
      {
        type: w.type,
        weekScheduleId: w.weekScheduleId,
        hoursPerDay: w.hoursPerDay,
        leadTimeDays: w.leadTimeDays ?? null,
        queueTimeDays: w.queueTimeDays ?? null,
      },
    ])
  );
  const statusByOrder = new Map<string, ReturnType<typeof orderPlanStatus>>();
  for (const [orderId, ops] of operationsByOrder) {
    statusByOrder.set(
      orderId,
      orderPlanStatus(ops, { today: options.today, offDays, workCenters: statusWorkCenters, queueDays: options.queueDays })
    );
  }

  // Legoresurser are excluded from the load entirely: their operations are
  // bought from a supplier (behovsberäkningen proposes the IO), not planned
  // against our own hours — a lego operation must never inflate a week's
  // load, and the resource itself never gets a row.
  const subcontractIds = new Set(
    input.workCenters.filter((w) => w.type === "subcontract").map((w) => w.workCenterId)
  );
  input = {
    ...input,
    workCenters: input.workCenters.filter((w) => !subcontractIds.has(w.workCenterId)),
    operations: input.operations.filter((op) => !subcontractIds.has(op.workCenterId)),
  };

  // Columns. Week view: the week containing `today` plus the following
  // ones. Day view: `days` days from today. Either way the load is bucketed
  // per DAY and every visible day is kept (`dates`), so a week cell is the
  // sum of its days and the two views can never disagree.
  const granularity = options.granularity ?? "week";
  const weeks: CapacityWeek[] = [];
  const days: CapacityDay[] = [];
  let firstDate: string;
  let lastDate: string;
  if (granularity === "day") {
    firstDate = options.today;
    lastDate = addDays(options.today, (options.days ?? 14) - 1);
  } else {
    const { firstMonday } = capacityHorizon(options.today, options.weeks);
    for (let i = 0; i < options.weeks; i++) {
      const monday = addDays(firstMonday, i * 7);
      const { isoYear, isoWeek } = isoWeekOf(monday);
      weeks.push({ isoYear, isoWeek, monday, sunday: addDays(monday, 6) });
    }
    firstDate = firstMonday;
    lastDate = weeks[weeks.length - 1]!.sunday;
  }
  const dates: string[] = [];
  for (let date = firstDate; date <= lastDate; date = addDays(date, 1)) dates.push(date);
  const dateIndexOf = new Map(dates.map((d, i) => [d, i]));
  if (granularity === "day") {
    for (const date of dates) {
      days.push({ date, isoWeek: isoWeekOf(date).isoWeek, weekday: new Date(`${date}T00:00:00Z`).getUTCDay() || 7 });
    }
  }
  // The column a visible day belongs to: its own (day view) or its week's.
  const columnOf = (dateIndex: number) => (granularity === "day" ? dateIndex : Math.floor(dateIndex / 7));
  const columnCount = granularity === "day" ? dates.length : weeks.length;

  // Per-resource buckets: the view's columns, the load per visible day
  // (minutes, index-aligned with `dates`), later, undated.
  type Buckets = { columns: CapacityCell[]; dayMinutes: number[]; later: CapacityCell; undated: CapacityCell };
  const bucketsByResource = new Map<string, Buckets>();
  const bucketsFor = (workCenterId: string): Buckets => {
    let buckets = bucketsByResource.get(workCenterId);
    if (!buckets) {
      buckets = {
        columns: Array.from({ length: columnCount }, emptyCell),
        dayMinutes: dates.map(() => 0),
        later: emptyCell(),
        undated: emptyCell(),
      };
      bucketsByResource.set(workCenterId, buckets);
    }
    return buckets;
  };

  let plannedAt: string | null = null;
  for (const operation of input.operations) {
    if (operation.plannedAt && (plannedAt == null || operation.plannedAt > plannedAt)) plannedAt = operation.plannedAt;
    const minutes = remainingOperationMinutes(operation);
    if (minutes <= 0) continue;
    const buckets = bucketsFor(operation.workCenterId);

    // Overdue: the due date has passed (its load is bucketed on today).
    const overdue = operation.dueDate != null && operation.dueDate < options.today;
    const plannedRange = plannedDateRange(operation);
    const planned = plannedRange != null;
    const hours = round2(minutes / 60);

    // The load is bucketed per DAY (operationLoadDays: a planned operation
    // on its days, filled from the back; an unplanned one on its due date).
    // A week cell is the sum of its days — one entry per operation and
    // cell, `hoursInWeek` its share of the week, `hoursInDay` of the day.
    const perCell = new Map<CapacityCell, { minutes: number; monday: string | null }>();
    const perWeek = new Map<string, number>();
    for (const chunk of operationLoadDays(operation, options.today)) {
      let cell: CapacityCell;
      let monday: string | null = null;
      if (chunk.date == null) {
        cell = buckets.undated;
      } else if (chunk.date > lastDate) {
        cell = buckets.later;
      } else {
        const dateIndex = dateIndexOf.get(chunk.date)!;
        cell = buckets.columns[columnOf(dateIndex)]!;
        buckets.dayMinutes[dateIndex]! += chunk.minutes;
        monday = mondayOf(chunk.date);
        perWeek.set(monday, (perWeek.get(monday) ?? 0) + chunk.minutes);
      }
      const entry = perCell.get(cell) ?? { minutes: 0, monday };
      entry.minutes += chunk.minutes;
      perCell.set(cell, entry);
    }
    for (const [cell, { minutes: cellMinutes, monday }] of perCell) {
      cell.loadHours += cellMinutes / 60;
      cell.orders.push({
        moOperationId: operation.moOperationId,
        manufacturingOrderId: operation.manufacturingOrderId,
        orderNumber: operation.orderNumber,
        articleNumber: operation.articleNumber,
        articleName: operation.articleName,
        sequenceNo: operation.sequenceNo,
        dueDate: operation.dueDate,
        overdue,
        remainingHours: hours,
        hoursInWeek: round2((monday != null ? perWeek.get(monday)! : cellMinutes) / 60),
        hoursInDay: granularity === "day" ? round2(cellMinutes / 60) : null,
        planned,
        plannedStartDate: plannedRange?.start ?? null,
        plannedEndDate: plannedRange?.end ?? null,
        planLocked: operation.planLocked ?? false,
        late: statusByOrder.get(operation.manufacturingOrderId)?.late ?? false,
        componentLate: options.componentLateOrders?.has(operation.manufacturingOrderId) ?? false,
        resourceLocked: operation.resourceLocked ?? false,
        ordinaryWorkCenterCode: ordinaryCodeOf(operation),
        suggestion: suggestionByOperation.get(operation.moOperationId) ?? null,
      });
    }
  }

  // Resource rows: active always, inactive only when carrying load.
  const carriesLoad = (b: Buckets | undefined) =>
    !!b && (b.later.loadHours > 0 || b.undated.loadHours > 0 || b.columns.some((c) => c.loadHours > 0));
  const included = input.workCenters.filter((w) => w.active || carriesLoad(bucketsByResource.get(w.workCenterId)));

  const resourceRows = new Map<string, CapacityResourceRow>();
  for (const workCenter of included) {
    const buckets = bucketsFor(workCenter.workCenterId);
    // hasSchedule (kept as the response's name) = the resource has a
    // capacity calendar — a week schedule or hours per day.
    const hasSchedule = hasCapacityCalendar(workCenter);
    // Capacity per visible day (resourceDayMinutes × the factor); a week's
    // is the sum of its seven days.
    const dayAvailable = hasSchedule
      ? dates.map((date) => (resourceDayMinutes(lookups, workCenter, date) / 60) * workCenter.capacityFactor)
      : null;
    if (dayAvailable) {
      for (let i = 0; i < dates.length; i++) {
        const cell = buckets.columns[columnOf(i)]!;
        cell.availableHours = (cell.availableHours ?? 0) + dayAvailable[i]!;
      }
    }
    const columns = buckets.columns.map(finishCell);
    // The days without their orders. In the day view they ARE the cells.
    const dayLoads =
      granularity === "day"
        ? columns.map((cell, i) => ({
            date: dates[i]!,
            loadHours: cell.loadHours,
            availableHours: cell.availableHours,
            overloaded: cell.overloaded,
          }))
        : dates.map((date, i) => dayLoadOf(date, buckets.dayMinutes[i]! / 60, dayAvailable ? dayAvailable[i]! : null));
    dayLoads.forEach((day, i) => {
      if (day.overloaded) columns[columnOf(i)]!.overloadedDays += 1;
    });
    resourceRows.set(workCenter.workCenterId, {
      workCenterId: workCenter.workCenterId,
      code: workCenter.code,
      name: workCenter.name,
      type: workCenter.type,
      active: workCenter.active,
      capacityFactor: workCenter.capacityFactor,
      hasSchedule,
      weeks: granularity === "day" ? [] : columns,
      days: granularity === "day" ? columns : [],
      dayLoads,
      later: finishCell(buckets.later),
      undated: finishCell(buckets.undated),
    });
  }

  // Group blocks: production groups by code, ungrouped resources last.
  const byCode = <T extends { code: string }>(a: T, b: T) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const groups: CapacityGroupBlock[] = [];
  const blocks: { productionGroupId: string | null; code: string | null; name: string }[] = [
    ...[...input.productionGroups].sort(byCode),
    { productionGroupId: null, code: null, name: "Ogrupperade resurser" },
  ].map((g) => ({ productionGroupId: g.productionGroupId, code: g.code, name: g.name }));

  for (const block of blocks) {
    const members = included
      .filter((w) => w.productionGroupId === block.productionGroupId)
      .sort(byCode)
      .map((w) => resourceRows.get(w.workCenterId)!);
    if (members.length === 0) continue;

    const subtotal = (pick: (row: CapacityResourceRow) => CapacityCell): CapacityCell => {
      const cell = emptyCell();
      for (const member of members) {
        const memberCell = pick(member);
        cell.loadHours += memberCell.loadHours;
        if (memberCell.availableHours != null) {
          cell.availableHours = (cell.availableHours ?? 0) + memberCell.availableHours;
        }
      }
      return finishCell(cell);
    };

    // The group's days (the members' summed), for a week total's
    // overloadedDays — the group can be over on a day no member is.
    const groupDays = dates.map((date, i) => {
      let loadHours = 0;
      let availableHours: number | null = null;
      for (const member of members) {
        const day = member.dayLoads[i]!;
        loadHours += day.loadHours;
        if (day.availableHours != null) availableHours = (availableHours ?? 0) + day.availableHours;
      }
      return dayLoadOf(date, loadHours, availableHours);
    });

    groups.push({
      productionGroupId: block.productionGroupId,
      code: block.code,
      name: block.name,
      resources: members,
      weekTotals: weeks.map((_, i) => {
        const total = subtotal((row) => row.weeks[i]!);
        total.overloadedDays = groupDays.slice(i * 7, i * 7 + 7).filter((d) => d.overloaded).length;
        return total;
      }),
      dayTotals: days.map((_, i) => {
        const total = subtotal((row) => row.days[i]!);
        total.overloadedDays = total.overloaded ? 1 : 0;
        return total;
      }),
      laterTotal: subtotal((row) => row.later),
      undatedTotal: subtotal((row) => row.undated),
    });
  }

  // The summary: overload per resource cell (the red ones), Sen and
  // unplanned per MO — only MOs that still carry load. Sorted so two loads
  // read the same.
  const byDueThenNumber = (
    a: { dueDate: string | null; orderNumber: string },
    b: { dueDate: string | null; orderNumber: string }
  ) => {
    if (a.dueDate !== b.dueDate) {
      if (a.dueDate == null) return 1;
      if (b.dueDate == null) return -1;
      return a.dueDate < b.dueDate ? -1 : 1;
    }
    return a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0;
  };
  const overloadedCells = [...resourceRows.values()].reduce(
    (n, row) => n + (granularity === "day" ? row.days : row.weeks).filter((c) => c.overloaded).length,
    0
  );
  const overloadedDays = [...resourceRows.values()].reduce(
    (n, row) => n + row.dayLoads.filter((d) => d.overloaded).length,
    0
  );
  const lateOrders: CapacitySummary["lateOrders"] = [];
  const unplannedOrders: CapacitySummary["unplannedOrders"] = [];
  for (const [orderId, ops] of operationsByOrder) {
    if (!ops.some((op) => remainingOperationMinutes(op) > 0)) continue;
    const status = statusByOrder.get(orderId)!;
    const head = { manufacturingOrderId: orderId, orderNumber: ops[0]!.orderNumber, dueDate: ops[0]!.dueDate };
    if (status.late) lateOrders.push({ ...head, plannedFinish: status.plannedFinish });
    if (!status.planned) unplannedOrders.push({ manufacturingOrderId: orderId, orderNumber: head.orderNumber });
  }
  lateOrders.sort(byDueThenNumber);
  unplannedOrders.sort((a, b) => (a.orderNumber < b.orderNumber ? -1 : a.orderNumber > b.orderNumber ? 1 : 0));

  const resourceSuggestions = [...suggestions].sort((a, b) =>
    a.orderNumber !== b.orderNumber ? (a.orderNumber < b.orderNumber ? -1 : 1) : a.sequenceNo - b.sequenceNo
  );

  return {
    today: options.today,
    granularity,
    weeks,
    days,
    groups,
    summary: {
      plannedAt,
      overloadedCells,
      overloadedDays,
      lateOrders,
      unplannedOrders,
      resourceSuggestions,
      lockedOperations: input.operations.filter(isLockedOperation).length,
    },
  };
}
