// Beläggning light (E2) — pure capacity-load calculation.
// No database imports: the repository loads flat rows and this module owns
// every business rule — remaining-time formula, ISO-week bucketing, resource
// calendar resolution (week schedule + holidays, deliberately NOT payroll's
// employee-bound resolveEmployeeCalendar) and the group/resource matrix —
// fully unit-testable without a database (same pattern as requirements-calc).
import { isoWeekOf, isoWeekRange } from "../../timereport/service/schedule.service.js";
import { addWorkingDays, isWorkingDay } from "../../system/service/delivery-days.js";

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
  // Legoresurs: working days the supplier takes. Only read when a lego
  // operation is the last pending one of an MO (its finish decides Sen).
  leadTimeDays?: number | null;
}

// One week of an operation's plan: the Monday and the minutes planned there
// (a `mo_operation_plan_weeks` row). Ascending by Monday, minutes > 0.
export interface PlannedWeek {
  monday: string;
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
  setupTime: number; // minutes
  runTimePerUnit: number; // minutes
  operationStatus: "pending" | "done";
  quantityCompleted: number | null;
  // Needed to tell "untouched" from "started, everything scrapped" —
  // reportOperationQuantities writes quantityCompleted "0" on scrap-only
  // reports, but the setup is consumed either way once work has started.
  quantityScrapped: number;
  // The operation's plan (planerad vecka). Optional on purpose: rows without
  // one — older orders, data loaded before the plan existed — count exactly
  // as before, in the due date's week. Empty = unplanned too.
  plannedWeeks?: PlannedWeek[] | null;
  planLocked?: boolean;
  plannedAt?: string | null; // ISO timestamp of the run that planned it
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
  hoursInWeek: number; // its share in this cell — a planned operation spans cells
  planned: boolean;
  plannedStartWeek: string | null; // Mondays; null when unplanned
  plannedEndWeek: string | null;
  planLocked: boolean;
  late: boolean; // the MO's Sen — its last pending operation finishes after the due date
}

export interface CapacityCell {
  loadHours: number;
  availableHours: number | null; // null = no schedule (or undated/later columns)
  loadPercent: number | null; // null when availableHours is null or 0
  orders: CapacityCellOrder[];
}

export interface CapacityResourceRow {
  workCenterId: string;
  code: string;
  name: string;
  type: "machine" | "personnel" | "subcontract";
  active: boolean;
  capacityFactor: number;
  hasSchedule: boolean;
  weeks: CapacityCell[]; // index-aligned with CapacityResult.weeks
  later: CapacityCell; // due date beyond the horizon
  undated: CapacityCell; // no due date
}

export interface CapacityGroupBlock {
  productionGroupId: string | null; // null = "Ogrupperade resurser"
  code: string | null;
  name: string;
  resources: CapacityResourceRow[];
  weekTotals: CapacityCell[];
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
  overloadedCells: number; // resource × week cells with loadPercent > 100
  lateOrders: { manufacturingOrderId: string; orderNumber: string; dueDate: string | null; plannedFinish: string | null }[];
  unplannedOrders: { manufacturingOrderId: string; orderNumber: string }[];
}

export interface CapacityResult {
  weeks: CapacityWeek[];
  groups: CapacityGroupBlock[];
  summary: CapacitySummary;
}

// Remaining work in MINUTES for one operation. Setup is a one-off: it is
// consumed as soon as ANY quantity has been reported — OK or scrapped (a
// scrap-only report leaves quantityCompleted at "0" but the machine is
// already set up). Untouched operations keep the full setup.
export function remainingOperationMinutes(op: CapacityOperationRow): number {
  if (op.operationStatus === "done") return 0;
  const remainingQty = Math.max(op.orderQuantity - (op.quantityCompleted ?? 0), 0);
  const workStarted = (op.quantityCompleted ?? 0) > 0 || op.quantityScrapped > 0;
  return op.runTimePerUnit * remainingQty + (workStarted ? 0 : op.setupTime);
}

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

// The Monday of the week an operation's remaining load counts in: the week
// of its MO's due date, a past-due date in the first (current) week — the
// work can't happen in the past — and null for an undated MO (the matrix's
// "Utan datum" column; Leveranstidskontrollen leaves it out).
export function loadBucketMonday(dueDate: string | null, firstMonday: string): string | null {
  if (dueDate == null) return null;
  if (dueDate < firstMonday) return firstMonday;
  const { isoYear, isoWeek } = isoWeekOf(dueDate);
  return isoWeekRange(isoYear, isoWeek).monday;
}

// The Monday of the ISO week a date is in.
export function mondayOf(date: string): string {
  const { isoYear, isoWeek } = isoWeekOf(date);
  return isoWeekRange(isoYear, isoWeek).monday;
}

const EPS = 1e-9;

// How an operation's REMAINING time sits in its plan: the allocation is
// filled from the back — the work already done is assumed to have happened
// in the earliest weeks — so 600 min planned v.45: 400 / v.46: 200 with 300
// left is v.45: 100 / v.46: 200. More remaining than planned (Ångra
// rapportering) puts the excess in the last week. Weeks before `firstMonday`
// (the current week) are clamped to it: the work can't happen in the past.
// Returns ascending weeks with minutes > 0; [] when nothing remains.
export function remainingByPlannedWeeks(remaining: number, plannedWeeks: PlannedWeek[], firstMonday: string): PlannedWeek[] {
  if (remaining <= EPS || plannedWeeks.length === 0) return [];
  const clamped = new Map<string, number>();
  for (const w of [...plannedWeeks].sort((a, b) => (a.monday < b.monday ? -1 : a.monday > b.monday ? 1 : 0))) {
    const monday = w.monday < firstMonday ? firstMonday : w.monday;
    clamped.set(monday, (clamped.get(monday) ?? 0) + w.minutes);
  }
  const weeks = [...clamped].map(([monday, minutes]) => ({ monday, minutes }));
  const planned = weeks.reduce((sum, w) => sum + w.minutes, 0);
  const excess = Math.max(0, remaining - planned);
  const out: PlannedWeek[] = [];
  let rest = remaining;
  for (let i = weeks.length - 1; i >= 0 && rest > EPS; i--) {
    const room = weeks[i]!.minutes + (i === weeks.length - 1 ? excess : 0);
    const minutes = Math.min(room, rest);
    if (minutes > EPS) out.unshift({ monday: weeks[i]!.monday, minutes });
    rest -= minutes;
  }
  return out;
}

// The weeks an operation's remaining load counts in — the ONE bucketing rule
// the matrix, Leveranstidskontrollen and Planera share. Planned: the
// allocation filled from the back (above). Unplanned: today's rule — one
// bucket in the due date's week (null = undated).
export function operationLoadWeeks(
  op: CapacityOperationRow,
  firstMonday: string
): { monday: string | null; minutes: number }[] {
  const minutes = remainingOperationMinutes(op);
  if (minutes <= 0) return [];
  if (op.plannedWeeks && op.plannedWeeks.length > 0) return remainingByPlannedWeeks(minutes, op.plannedWeeks, firstMonday);
  return [{ monday: loadBucketMonday(op.dueDate, firstMonday), minutes }];
}

// The last day of week `monday` the resource works (a working day for a
// resource without a calendar), never before `floor` — the klar-datum of an
// operation finishing in that week.
export function weekFinishDay(
  lookups: ScheduleLookups,
  offDays: ReadonlySet<string>,
  calendar: ResourceCalendar | null,
  monday: string,
  floor: string
): string {
  for (let i = 6; i >= 0; i--) {
    const day = addDays(monday, i);
    if (day < floor) break;
    if (calendar && hasCapacityCalendar(calendar) ? resourceDayMinutes(lookups, calendar, day) > 0 : isWorkingDay(day, offDays)) return day;
  }
  return floor;
}

export interface PlanStatusWorkCenter extends ResourceCalendar {
  type: "machine" | "personnel" | "subcontract";
  leadTimeDays?: number | null;
}

// Sen: an MO's last pending operation (highest sequence number, a lego
// operation through its lead time) finishes after the due date. The finish
// is walked through the plan: a planned operation finishes on the last
// working day of its end week, a lego operation `leadTimeDays` working days
// after the previous one, both never before today. An MO with a pending
// operation that lacks a plan (other than lego/0 minutes) is unplanned —
// then Sen is today's Försenad: the due date has passed.
export function orderPlanStatus(
  operations: CapacityOperationRow[],
  ctx: {
    today: string;
    offDays: ReadonlySet<string>;
    lookups: ScheduleLookups;
    workCenters: Map<string, PlanStatusWorkCenter>;
  }
): { planned: boolean; plannedFinish: string | null; late: boolean } {
  const firstMonday = mondayOf(ctx.today);
  const pending = operations.filter((op) => op.operationStatus === "pending").sort((a, b) => a.sequenceNo - b.sequenceNo);
  const dueDate = operations[0]?.dueDate ?? null;
  let ready = ctx.today;
  for (const op of pending) {
    const wc = ctx.workCenters.get(op.workCenterId) ?? null;
    if (wc?.type === "subcontract") {
      ready = addWorkingDays(ready, Math.ceil(wc.leadTimeDays ?? 0), ctx.offDays);
      continue;
    }
    const weeks = operationLoadWeeks(op, firstMonday);
    if (weeks.length === 0) continue; // nothing left to do
    if (!op.plannedWeeks || op.plannedWeeks.length === 0) {
      return { planned: false, plannedFinish: null, late: dueDate != null && dueDate < ctx.today };
    }
    const endWeek = weeks[weeks.length - 1]!.monday!;
    const finish = weekFinishDay(ctx.lookups, ctx.offDays, wc, endWeek, ctx.today);
    if (finish > ready) ready = finish;
  }
  return { planned: true, plannedFinish: ready, late: dueDate != null && ready > dueDate };
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

const round2 = (n: number) => Math.round(n * 100) / 100;

function emptyCell(): CapacityCell {
  return { loadHours: 0, availableHours: null, loadPercent: null, orders: [] };
}

function finishCell(cell: CapacityCell): CapacityCell {
  cell.loadHours = round2(cell.loadHours);
  if (cell.availableHours != null) cell.availableHours = round2(cell.availableHours);
  cell.loadPercent =
    cell.availableHours != null && cell.availableHours > 0
      ? Math.round((cell.loadHours / cell.availableHours) * 100)
      : null;
  cell.orders.sort((a, b) =>
    a.orderNumber !== b.orderNumber ? (a.orderNumber < b.orderNumber ? -1 : 1) : a.sequenceNo - b.sequenceNo
  );
  return cell;
}

export function computeCapacity(
  input: CapacityInput,
  // offDays (full-day holidays) only matter for Sen: a lego operation's lead
  // time and the finish day of a resource without a calendar.
  options: { today: string; weeks: number; offDays?: ReadonlySet<string> }
): CapacityResult {
  const offDays = options.offDays ?? new Set<string>();
  const lookups = buildScheduleLookups(input.weekScheduleDays, input.daySchedules, input.holidays);

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
      { type: w.type, weekScheduleId: w.weekScheduleId, hoursPerDay: w.hoursPerDay, leadTimeDays: w.leadTimeDays ?? null },
    ])
  );
  const statusByOrder = new Map<string, ReturnType<typeof orderPlanStatus>>();
  for (const [orderId, ops] of operationsByOrder) {
    statusByOrder.set(orderId, orderPlanStatus(ops, { today: options.today, offDays, lookups, workCenters: statusWorkCenters }));
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

  // Week columns: the week containing `today` plus the following ones.
  const { firstMonday } = capacityHorizon(options.today, options.weeks);
  const weeks: CapacityWeek[] = [];
  for (let i = 0; i < options.weeks; i++) {
    const monday = addDays(firstMonday, i * 7);
    const { isoYear, isoWeek } = isoWeekOf(monday);
    weeks.push({ isoYear, isoWeek, monday, sunday: addDays(monday, 6) });
  }
  const horizonSunday = weeks[weeks.length - 1]!.sunday;

  // Per-resource buckets: weeks[i], later, undated.
  type Buckets = { weeks: CapacityCell[]; later: CapacityCell; undated: CapacityCell };
  const bucketsByResource = new Map<string, Buckets>();
  const bucketsFor = (workCenterId: string): Buckets => {
    let buckets = bucketsByResource.get(workCenterId);
    if (!buckets) {
      buckets = { weeks: weeks.map(emptyCell), later: emptyCell(), undated: emptyCell() };
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

    // Overdue at DAY granularity — a due date earlier this week is already
    // passed even though it buckets into the current week column.
    const overdue = operation.dueDate != null && operation.dueDate < options.today;
    const planned = !!operation.plannedWeeks && operation.plannedWeeks.length > 0;
    const plannedMondays = planned ? operation.plannedWeeks!.map((w) => w.monday).sort() : [];
    const hours = round2(minutes / 60);

    // A planned operation is spread over its weeks (its load filled from the
    // back); an unplanned one is one bucket in its due date's week.
    for (const chunk of operationLoadWeeks(operation, firstMonday)) {
      let cell: CapacityCell;
      if (chunk.monday == null) {
        cell = buckets.undated;
      } else if (chunk.monday > horizonSunday) {
        cell = buckets.later;
      } else {
        cell = buckets.weeks[weeks.findIndex((w) => w.monday === chunk.monday)]!;
      }
      cell.loadHours += chunk.minutes / 60;
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
        hoursInWeek: round2(chunk.minutes / 60),
        planned,
        plannedStartWeek: planned ? plannedMondays[0]! : null,
        plannedEndWeek: planned ? plannedMondays[plannedMondays.length - 1]! : null,
        planLocked: operation.planLocked ?? false,
        late: statusByOrder.get(operation.manufacturingOrderId)?.late ?? false,
      });
    }
  }

  // Resource rows: active always, inactive only when carrying load.
  const carriesLoad = (b: Buckets | undefined) =>
    !!b && (b.later.loadHours > 0 || b.undated.loadHours > 0 || b.weeks.some((c) => c.loadHours > 0));
  const included = input.workCenters.filter((w) => w.active || carriesLoad(bucketsByResource.get(w.workCenterId)));

  const resourceRows = new Map<string, CapacityResourceRow>();
  for (const workCenter of included) {
    const buckets = bucketsFor(workCenter.workCenterId);
    // hasSchedule (kept as the response's name) = the resource has a
    // capacity calendar — a week schedule or hours per day.
    const hasSchedule = hasCapacityCalendar(workCenter);
    if (hasSchedule) {
      for (let i = 0; i < weeks.length; i++) {
        buckets.weeks[i]!.availableHours = resolveWeekHoursFromLookups(
          lookups,
          workCenter,
          workCenter.capacityFactor,
          weeks[i]!.isoYear,
          weeks[i]!.isoWeek
        );
      }
    }
    resourceRows.set(workCenter.workCenterId, {
      workCenterId: workCenter.workCenterId,
      code: workCenter.code,
      name: workCenter.name,
      type: workCenter.type,
      active: workCenter.active,
      capacityFactor: workCenter.capacityFactor,
      hasSchedule,
      weeks: buckets.weeks.map(finishCell),
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

    groups.push({
      productionGroupId: block.productionGroupId,
      code: block.code,
      name: block.name,
      resources: members,
      weekTotals: weeks.map((_, i) => subtotal((row) => row.weeks[i]!)),
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
    (n, row) => n + row.weeks.filter((c) => c.loadPercent != null && c.loadPercent > 100).length,
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

  return { weeks, groups, summary: { plannedAt, overloadedCells, lateOrders, unplannedOrders } };
}
