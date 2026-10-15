// Beläggning light (E2) — pure capacity-load calculation.
// No database imports: the repository loads flat rows and this module owns
// every business rule — remaining-time formula, ISO-week bucketing, resource
// calendar resolution (week schedule + holidays, deliberately NOT payroll's
// employee-bound resolveEmployeeCalendar) and the group/resource matrix —
// fully unit-testable without a database (same pattern as requirements-calc).
import { isoWeekOf, isoWeekRange } from "../../timereport/service/schedule.service.js";

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
  active: boolean;
}

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
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  sequenceNo: number;
  dueDate: string | null;
  overdue: boolean;
  remainingHours: number;
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

export interface CapacityResult {
  weeks: CapacityWeek[];
  groups: CapacityGroupBlock[];
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
interface ScheduleLookups {
  netByDaySchedule: Map<string, number>;
  daysBySchedule: Map<string, Map<number, string>>; // weekScheduleId -> weekday -> dayScheduleId
  holidayByDate: Map<string, HolidayRow>;
}

function buildScheduleLookups(
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
  weekScheduleId: string,
  capacityFactor: number,
  isoYear: number,
  isoWeek: number
): number {
  const dayByWeekday = lookups.daysBySchedule.get(weekScheduleId) ?? new Map<number, string>();
  const { monday } = isoWeekRange(isoYear, isoWeek);
  let minutes = 0;
  for (let i = 0; i < 7; i++) {
    const dayScheduleId = dayByWeekday.get(i + 1);
    if (!dayScheduleId) continue; // day off in the schedule — a holiday never adds
    const holiday = lookups.holidayByDate.get(addDays(monday, i));
    if (holiday) {
      minutes += holiday.dayScheduleId ? (lookups.netByDaySchedule.get(holiday.dayScheduleId) ?? 0) : 0;
    } else {
      minutes += lookups.netByDaySchedule.get(dayScheduleId) ?? 0;
    }
  }
  return (minutes / 60) * capacityFactor;
}

// Public convenience wrapper (used directly by the unit tests) — builds the
// lookups itself; computeCapacity builds them once per run instead.
export function resolveResourceWeekHours(args: {
  weekScheduleId: string;
  capacityFactor: number;
  isoYear: number;
  isoWeek: number;
  weekScheduleDays: WeekScheduleDayRow[];
  daySchedules: DayScheduleNetRow[];
  holidays: HolidayRow[];
}): number {
  return resolveWeekHoursFromLookups(
    buildScheduleLookups(args.weekScheduleDays, args.daySchedules, args.holidays),
    args.weekScheduleId,
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
  options: { today: string; weeks: number }
): CapacityResult {
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

  for (const operation of input.operations) {
    const minutes = remainingOperationMinutes(operation);
    if (minutes <= 0) continue;
    const buckets = bucketsFor(operation.workCenterId);

    let cell: CapacityCell;
    // Overdue at DAY granularity — a due date earlier this week is already
    // passed even though it buckets into the current week column.
    const overdue = operation.dueDate != null && operation.dueDate < options.today;
    if (operation.dueDate == null) {
      cell = buckets.undated;
    } else if (operation.dueDate < firstMonday) {
      // Past due — the work can't happen in the past; roll into current week.
      cell = buckets.weeks[0]!;
    } else if (operation.dueDate > horizonSunday) {
      cell = buckets.later;
    } else {
      const { isoYear, isoWeek } = isoWeekOf(operation.dueDate);
      const index = weeks.findIndex((w) => w.isoYear === isoYear && w.isoWeek === isoWeek);
      cell = buckets.weeks[index]!;
    }

    const hours = round2(minutes / 60);
    cell.loadHours += minutes / 60;
    cell.orders.push({
      manufacturingOrderId: operation.manufacturingOrderId,
      orderNumber: operation.orderNumber,
      articleNumber: operation.articleNumber,
      articleName: operation.articleName,
      sequenceNo: operation.sequenceNo,
      dueDate: operation.dueDate,
      overdue,
      remainingHours: hours,
    });
  }

  // Resource rows: active always, inactive only when carrying load.
  const carriesLoad = (b: Buckets | undefined) =>
    !!b && (b.later.loadHours > 0 || b.undated.loadHours > 0 || b.weeks.some((c) => c.loadHours > 0));
  const included = input.workCenters.filter((w) => w.active || carriesLoad(bucketsByResource.get(w.workCenterId)));

  const lookups = buildScheduleLookups(input.weekScheduleDays, input.daySchedules, input.holidays);
  const resourceRows = new Map<string, CapacityResourceRow>();
  for (const workCenter of included) {
    const buckets = bucketsFor(workCenter.workCenterId);
    const hasSchedule = workCenter.weekScheduleId != null;
    if (hasSchedule) {
      for (let i = 0; i < weeks.length; i++) {
        buckets.weeks[i]!.availableHours = resolveWeekHoursFromLookups(
          lookups,
          workCenter.weekScheduleId!,
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

  return { weeks, groups };
}
