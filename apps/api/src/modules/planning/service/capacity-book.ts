// Kapacitetsboken — the one placement rule Leveranstidskontrollen, Planera
// and the planning of a new TO share: an operation's minutes are placed
// week by week on what is free of a resource's capacity after the existing
// load (rolled forward: what does not fit a week is worked the next) and
// what this run has already booked.
//
// Pure, like capacity-calc.ts: no database imports, the caller loads flat
// rows. The book is stateful for ONE run — every `place` books its minutes
// so the next operation (or the next row of the check) sees them.
import {
  buildScheduleLookups,
  hasCapacityCalendar,
  mondayOf,
  operationLoadWeeks,
  resourceDayMinutes,
  weekFinishDay,
  type CapacityOperationRow,
  type DayScheduleNetRow,
  type HolidayRow,
  type PlannedWeek,
  type ScheduleLookups,
  type WeekScheduleDayRow,
} from "./capacity-calc.js";
import { addDays, addWorkingDays } from "../../system/service/delivery-days.js";

// Capacity is searched this many weeks ahead before an operation gives up
// (the check's "Kapaciteten räcker inte inom två år").
export const PLAN_HORIZON_WEEKS = 104;

export interface PlanWorkCenter {
  workCenterId: string;
  code: string;
  name: string;
  type: "machine" | "personnel" | "subcontract";
  weekScheduleId: string | null;
  hoursPerDay: number | null; // Kapacitet (timmar per dag) — when there is no week schedule
  capacityFactor: number;
  leadTimeDays: number | null; // legoresurs: working days the supplier takes
}

// Existing load: the open operations as the matrix sees them — planned ones
// in their planned weeks (remaining time filled from the back), unplanned
// ones in their due date's week.
export type ExistingOperation = CapacityOperationRow;

export interface CapacityBookInput {
  today: string;
  offDays: ReadonlySet<string>;
  horizonWeeks?: number; // default PLAN_HORIZON_WEEKS
  workCenters: Map<string, PlanWorkCenter>;
  schedule: { weekScheduleDays: WeekScheduleDayRow[]; daySchedules: DayScheduleNetRow[]; holidays: HolidayRow[] };
  existingOperations: ExistingOperation[];
}

export type Placement =
  | {
      horizonExceeded: false;
      weeks: PlannedWeek[]; // the allocation — what mo_operation_plan_weeks stores
      fromWeek: string; // Monday of the first week that books
      toWeek: string; // Monday of the week it finishes
      readyDate: string; // klar-datum: the last day the resource works in toWeek, never before the floor
      unscheduled: boolean; // the resource has no capacity calendar — everything in the floor's week
    }
  | {
      horizonExceeded: true;
      searchedFrom: string; // Monday of the first week searched (or booked)
      searchedTo: string; // Monday of the last week inside the horizon
      partial: PlannedWeek[]; // what was booked before the horizon — it stays booked
    };

export interface PlaceOptions {
  floor: string; // the first day capacity may be used (material ready, previous operation)
  // Tvingad start (a hand move, a started operation): the operation starts
  // in this week no matter what is free there — up to the week's WHOLE
  // capacity, overload allowed — and continues on free capacity after it.
  forceStartWeek?: string;
}

const EPS = 1e-9;
const maxDate = (a: string, b: string) => (a > b ? a : b);

export interface CapacityBook {
  readonly today: string;
  readonly firstMonday: string;
  readonly horizonMonday: string; // the first Monday outside the horizon
  readonly lookups: ScheduleLookups;
  place(wc: PlanWorkCenter | null, minutes: number, options: PlaceOptions): Placement;
  // A lego operation: ready `leadTimeDays` working days after `floor`
  // (null = 0 days). Books nothing — the supplier's capacity is not ours.
  subcontract(wc: PlanWorkCenter, floor: string): string;
  // Existing load without a due date on a resource — left out of the
  // capacity (noted by the check).
  undatedMinutes(workCenterId: string): number;
  // Capacity of the whole week counting days from `fromDay` (today in the
  // current week) — the week's full capacity for a forced start.
  weekCapacity(wc: PlanWorkCenter, monday: string): number;
  // What is free of the week after existing load and this run's bookings,
  // counting only days from `fromDay`.
  freeMinutes(wc: PlanWorkCenter, monday: string, fromDay: string): number;
  weekFinishDay(wc: PlanWorkCenter | null, monday: string, floor: string): string;
}

export function createCapacityBook(input: CapacityBookInput): CapacityBook {
  const { today, offDays } = input;
  const lookups = buildScheduleLookups(input.schedule.weekScheduleDays, input.schedule.daySchedules, input.schedule.holidays);
  const firstMonday = mondayOf(today);
  const horizonMonday = addDays(firstMonday, (input.horizonWeeks ?? PLAN_HORIZON_WEEKS) * 7);

  // --- Existing load per resource and week (beläggningsvyns hinkar) -------
  const existingLoad = new Map<string, Map<string, number>>(); // wc -> monday -> minutes
  const undatedLoad = new Map<string, number>(); // wc -> minutes
  for (const op of input.existingOperations) {
    for (const chunk of operationLoadWeeks(op, firstMonday)) {
      if (chunk.monday == null) {
        undatedLoad.set(op.workCenterId, (undatedLoad.get(op.workCenterId) ?? 0) + chunk.minutes);
        continue;
      }
      const weeks = existingLoad.get(op.workCenterId) ?? new Map<string, number>();
      weeks.set(chunk.monday, (weeks.get(chunk.monday) ?? 0) + chunk.minutes);
      existingLoad.set(op.workCenterId, weeks);
    }
  }
  const booked = new Map<string, Map<string, number>>(); // this run's own bookings

  function weekCapacityFrom(wc: PlanWorkCenter, monday: string, fromDay: string): number {
    let minutes = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      if (day < fromDay) continue;
      minutes += resourceDayMinutes(lookups, wc, day);
    }
    return minutes * wc.capacityFactor;
  }
  const weekCapacity = (wc: PlanWorkCenter, monday: string) => weekCapacityFrom(wc, monday, maxDate(monday, today));

  // Existing load as it will actually be worked: week by week from its
  // bucket, what does not fit the week's capacity (from today in the current
  // week) rolls into the next — a backlog never vanishes just because its
  // week is over-full. Only resources with a capacity calendar are rolled
  // (the others are unlimited anyway); undated load stays out (noted).
  const rolledLoadByResource = new Map<string, Map<string, number>>();
  function rolledLoad(wc: PlanWorkCenter): Map<string, number> {
    let rolled = rolledLoadByResource.get(wc.workCenterId);
    if (rolled) return rolled;
    rolled = new Map();
    const buckets = existingLoad.get(wc.workCenterId) ?? new Map<string, number>();
    const lastBucket = [...buckets.keys()].reduce((a, b) => maxDate(a, b), firstMonday);
    let carry = 0;
    for (let monday = firstMonday; monday < horizonMonday && (carry > EPS || monday <= lastBucket); monday = addDays(monday, 7)) {
      const load = (buckets.get(monday) ?? 0) + carry;
      const capacity = weekCapacity(wc, monday);
      rolled.set(monday, Math.min(load, capacity));
      carry = Math.max(0, load - capacity);
    }
    rolledLoadByResource.set(wc.workCenterId, rolled);
    return rolled;
  }

  // Minutes a resource can still take in week `monday`, counting only days
  // from `fromDay`: never more than what is left of the whole week (from
  // today) after the existing load and this run's bookings.
  function freeMinutes(wc: PlanWorkCenter, monday: string, fromDay: string): number {
    const left = weekCapacity(wc, monday) - (rolledLoad(wc).get(monday) ?? 0) - (booked.get(wc.workCenterId)?.get(monday) ?? 0);
    return Math.max(0, Math.min(weekCapacityFrom(wc, monday, maxDate(fromDay, today)), left));
  }
  function book(wc: PlanWorkCenter, monday: string, minutes: number) {
    const weeks = booked.get(wc.workCenterId) ?? new Map<string, number>();
    weeks.set(monday, (weeks.get(monday) ?? 0) + minutes);
    booked.set(wc.workCenterId, weeks);
  }
  const finishDay = (wc: PlanWorkCenter | null, monday: string, floor: string) =>
    weekFinishDay(lookups, offDays, wc, monday, floor);

  function place(wc: PlanWorkCenter | null, minutes: number, options: PlaceOptions): Placement {
    // A forced start moves the floor to that week (never into the past).
    const floor = options.forceStartWeek ? maxDate(maxDate(options.forceStartWeek, firstMonday), today) : options.floor;
    const startMonday = mondayOf(floor);
    if (!wc || !hasCapacityCalendar(wc)) {
      // No calendar: unlimited — everything in the floor's week.
      if (wc) book(wc, startMonday, minutes);
      return {
        horizonExceeded: false,
        weeks: [{ monday: startMonday, minutes }],
        fromWeek: startMonday,
        toWeek: startMonday,
        readyDate: finishDay(null, startMonday, floor),
        unscheduled: true,
      };
    }
    const weeks: PlannedWeek[] = [];
    let monday = startMonday;
    let rest = minutes;
    let dayFloor = floor;
    let forced = !!options.forceStartWeek;
    while (rest > EPS) {
      if (monday >= horizonMonday) {
        return {
          horizonExceeded: true,
          searchedFrom: weeks[0]?.monday ?? startMonday,
          searchedTo: addDays(horizonMonday, -7),
          partial: weeks,
        };
      }
      const room = forced ? weekCapacity(wc, monday) : freeMinutes(wc, monday, dayFloor);
      const take = Math.min(rest, room);
      if (take > EPS) {
        book(wc, monday, take);
        weeks.push({ monday, minutes: take });
        rest -= take;
      }
      forced = false;
      if (rest > EPS) {
        monday = addDays(monday, 7);
        dayFloor = monday;
      }
    }
    return {
      horizonExceeded: false,
      weeks,
      fromWeek: weeks[0]?.monday ?? monday,
      toWeek: monday,
      readyDate: finishDay(wc, monday, floor),
      unscheduled: false,
    };
  }

  return {
    today,
    firstMonday,
    horizonMonday,
    lookups,
    place,
    subcontract: (wc, floor) => addWorkingDays(floor, Math.ceil(wc.leadTimeDays ?? 0), offDays),
    undatedMinutes: (workCenterId) => undatedLoad.get(workCenterId) ?? 0,
    weekCapacity,
    freeMinutes,
    weekFinishDay: finishDay,
  };
}
