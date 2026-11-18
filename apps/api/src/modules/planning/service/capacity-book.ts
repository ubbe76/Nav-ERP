// Kapacitetsboken — the one placement rule Leveranstidskontrollen, Planera
// and the planning of a new TO share: an operation's minutes are placed
// DAY BY DAY (#18) on what is free of a resource's capacity after the
// existing load (rolled forward: what does not fit a day is worked the next)
// and what this run has already booked. The day is the plan's only unit —
// a week is the sum of its days.
//
// Pure, like capacity-calc.ts: no database imports, the caller loads flat
// rows. The book is stateful for ONE run — every `place` books its minutes
// so the next operation (or the next row of the check) sees them; a `peek`
// (provplacering) runs the same loop and books nothing. Valregeln for
// alternativa resurser (`chooseResource`, #15) lives at the bottom.
import {
  buildScheduleLookups,
  hasCapacityCalendar,
  mondayOf,
  operationLoadDays,
  resourceDayMinutes,
  subcontractReadyDate,
  type CapacityOperationRow,
  type DayScheduleNetRow,
  type HolidayRow,
  type PlannedDay,
  type ScheduleLookups,
  type WeekScheduleDayRow,
} from "./capacity-calc.js";
import { addDays, nextWorkingDayOnOrAfter } from "../../system/service/delivery-days.js";
import { round2 } from "@navet/shared";

// The floor of the next operation in an order's chain and the walk that
// counts its gaps — the book's rule (#18, beslut 2), defined in
// capacity-calc.ts so Sen (orderPlanStatus) reads the very same functions.
export { nextOperationFloor, operationChain, type OperationChain } from "./capacity-calc.js";

// The smallest piece the book places on a day — mo_operation_plan_days
// stores minutes with two decimals under CHECK minutes > 0, so anything
// under a hundredth of a minute would round to a row the database refuses.
// Free time under it counts as none, and a rest under it goes with the
// last whole piece instead of becoming a day of its own. (Defined with the
// lead time, which skips the same operations.)
export { MIN_PLAN_MINUTES } from "./manufacturing-lead-time.js";
import { MIN_PLAN_MINUTES } from "./manufacturing-lead-time.js";

// Capacity is searched this many weeks ahead before an operation gives up
// (the check's "Kapaciteten räcker inte inom två år"): the first day outside
// is the Monday of today's week + 728 days.
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
  // Legoresurs: Kötid (dagar) on top of the lead time — the book counts both
  // (#18, S6), as the lead time always did.
  queueTimeDays: number | null;
  // Valregeln never tries an inactive resource (#15). Optional: left out =
  // active, so the engine's fixtures read as before.
  active?: boolean;
}

// Existing load: the open operations as the matrix sees them — planned ones
// on their planned days (remaining time filled from the back, passed days
// today), unplanned ones on their due date.
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
      days: PlannedDay[]; // the allocation — what mo_operation_plan_days stores
      fromDate: string; // the first day that books
      toDate: string; // the last day that books
      readyDate: string; // klar-datum = toDate: the day the last minute is placed
      unscheduled: boolean; // the resource has no capacity calendar — everything on the floor's working day
    }
  | {
      horizonExceeded: true;
      searchedFrom: string; // the first day searched (or booked)
      searchedTo: string; // the last day inside the horizon
      partial: PlannedDay[]; // what was booked before the horizon — it stays booked
    };

export interface PlaceOptions {
  floor: string; // the first day capacity may be used (material ready, previous operation)
  // Tvingad start (a hand move, a started operation): the floor moves to
  // this day (never before today), and the FIRST DAY WITH CAPACITY from it
  // takes up to that day's WHOLE capacity no matter what is free there —
  // overload allowed — the rest continues on free capacity the days after.
  // A hand move compares the placement's fromDate with the chosen day: a day
  // without capacity (weekend, röd dag, a day off in the schedule) starts
  // later, and the service refuses it.
  forceStartDate?: string;
}

export interface PeekOptions extends PlaceOptions {
  // The resource's bare capacity: the existing load and this run's bookings
  // are ignored — Valregeln's "the base without load".
  ignoreLoad?: boolean;
  // The existing load minus these days (an operation's own stored load, as
  // the book holds it — operationLoadDays): a stored plan measured against
  // the load as it is now, without competing with itself (#15 granskningen).
  // Taken out of the buckets BEFORE the load is rolled.
  without?: readonly PlannedDay[];
}

// An allocation as mo_operation_plan_days can hold it (writeOperationPlans
// runs every allocation through this): ascending days, one row per date,
// two decimals, every row ≥ MIN_PLAN_MINUTES. Minutes a day would lose to
// the rounding go to the previous kept day (the first day's to the next),
// and the rounding residual lands in the last row so the rows add up to the
// total at two decimals. [] when the whole allocation rounds away — the
// caller clears the operation.
export function roundPlanDays(days: PlannedDay[]): PlannedDay[] {
  const byDate = new Map<string, number>();
  for (const d of days) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.minutes);
  const sorted = [...byDate].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = sorted.reduce((sum, [, minutes]) => sum + minutes, 0);
  const kept: PlannedDay[] = [];
  let carry = 0;
  for (const [date, raw] of sorted) {
    const minutes = raw + carry;
    carry = 0;
    if (round2(minutes) < MIN_PLAN_MINUTES) {
      if (kept.length > 0) kept[kept.length - 1]!.minutes += minutes;
      else carry = minutes;
      continue;
    }
    kept.push({ date, minutes });
  }
  if (carry > 0 && kept.length > 0) kept[kept.length - 1]!.minutes += carry;
  const rounded = kept.map((d) => ({ date: d.date, minutes: round2(d.minutes) })).filter((d) => d.minutes >= MIN_PLAN_MINUTES);
  if (rounded.length === 0) return [];
  const last = rounded[rounded.length - 1]!;
  last.minutes = round2(last.minutes + (round2(total) - rounded.reduce((sum, d) => sum + d.minutes, 0)));
  return last.minutes >= MIN_PLAN_MINUTES ? rounded : rounded.slice(0, -1);
}

const EPS = 1e-9;
const maxDate = (a: string, b: string) => (a > b ? a : b);

export interface CapacityBook {
  readonly today: string;
  readonly firstMonday: string;
  readonly horizonDate: string; // the first day outside the horizon (a Monday)
  readonly lookups: ScheduleLookups;
  place(wc: PlanWorkCenter | null, minutes: number, options: PlaceOptions): Placement;
  // Provplacering (#15): the same loop as `place`, but nothing is booked —
  // `place` is `peek` plus the booking. With `ignoreLoad` the resource's bare
  // capacity is searched.
  peek(wc: PlanWorkCenter | null, minutes: number, options: PeekOptions): Placement;
  // Gives booked days back — Planera's rule for an operation that hit the
  // horizon: its partial bookings must not stay as phantom load for the
  // TOs planned after it (Leveranstidskontrollen keeps them on purpose).
  release(wc: PlanWorkCenter, days: PlannedDay[]): void;
  // A lego operation sent on `floor`: ready ceil(Ledtid + Kötid) working
  // days later (null = 0). Books nothing — the supplier's capacity is not
  // ours. The floor in and out of it is the chain's (nextOperationFloor).
  subcontract(wc: PlanWorkCenter, floor: string): string;
  // Existing load without a due date on a resource — left out of the
  // capacity (noted by the check).
  undatedMinutes(workCenterId: string): number;
  // One day's capacity (the resource's day × its factor); 0 before today —
  // today counts as a whole day whatever the time is (S8).
  dayCapacity(wc: PlanWorkCenter, date: string): number;
  // The sum of the week's days (so only from today in the current week).
  weekCapacity(wc: PlanWorkCenter, monday: string): number;
  // What is free of the day after the rolled existing load and this run's
  // bookings; under MIN_PLAN_MINUTES counts as 0.
  freeMinutes(wc: PlanWorkCenter, date: string): number;
}

export function createCapacityBook(input: CapacityBookInput): CapacityBook {
  const { today, offDays } = input;
  const lookups = buildScheduleLookups(input.schedule.weekScheduleDays, input.schedule.daySchedules, input.schedule.holidays);
  const firstMonday = mondayOf(today);
  const horizonDate = addDays(firstMonday, (input.horizonWeeks ?? PLAN_HORIZON_WEEKS) * 7);

  // --- Existing load per resource and day (beläggningsvyns hinkar) --------
  const existingLoad = new Map<string, Map<string, number>>(); // wc -> date -> minutes
  const undatedLoad = new Map<string, number>(); // wc -> minutes
  for (const op of input.existingOperations) {
    for (const chunk of operationLoadDays(op, today)) {
      if (chunk.date == null) {
        undatedLoad.set(op.workCenterId, (undatedLoad.get(op.workCenterId) ?? 0) + chunk.minutes);
        continue;
      }
      const days = existingLoad.get(op.workCenterId) ?? new Map<string, number>();
      days.set(chunk.date, (days.get(chunk.date) ?? 0) + chunk.minutes);
      existingLoad.set(op.workCenterId, days);
    }
  }
  const booked = new Map<string, Map<string, number>>(); // this run's own bookings

  // Capacity per (resource, day), computed once per book: the placement
  // loop, the rolled load and every peek of Valregeln ask the same days
  // again and again. Keyed on the resource object (one per resource in a
  // run), so two differently configured objects never share an entry.
  const capacityCache = new WeakMap<PlanWorkCenter, Map<string, number>>();
  function dayCapacity(wc: PlanWorkCenter, date: string): number {
    if (date < today) return 0;
    let cache = capacityCache.get(wc);
    if (!cache) {
      cache = new Map();
      capacityCache.set(wc, cache);
    }
    const hit = cache.get(date);
    if (hit !== undefined) return hit;
    const capacity = resourceDayMinutes(lookups, wc, date) * wc.capacityFactor;
    cache.set(date, capacity);
    return capacity;
  }
  function weekCapacity(wc: PlanWorkCenter, monday: string): number {
    let minutes = 0;
    for (let i = 0; i < 7; i++) minutes += dayCapacity(wc, addDays(monday, i));
    return minutes;
  }

  // Existing load as it will actually be worked: day by day from its
  // bucket, what does not fit the day's capacity rolls into the next — a
  // backlog never vanishes just because its day is over-full (and a plan on
  // a passed day, clamped to today, is worked from today on). Only resources
  // with a capacity calendar are rolled (the others are unlimited anyway);
  // undated load stays out (noted). Days without a bucket and without a
  // carry are jumped over; the walk stops at the horizon.
  function rollBuckets(wc: PlanWorkCenter, buckets: ReadonlyMap<string, number>): Map<string, number> {
    const rolled = new Map<string, number>();
    const dates = [...buckets.keys()].sort();
    let next = 0;
    let carry = 0;
    let day = today;
    while (day < horizonDate && (carry > EPS || next < dates.length)) {
      if (carry <= EPS && dates[next]! > day) {
        day = dates[next]!;
        continue;
      }
      let load = carry;
      // A bucket is never before `day` when it is read — operationLoadDays
      // clamps the past to today — but a caller's `without` must not stall
      // the walk either.
      while (next < dates.length && dates[next]! <= day) load += buckets.get(dates[next++]!) ?? 0;
      const capacity = dayCapacity(wc, day);
      const worked = Math.min(load, capacity);
      if (worked > 0) rolled.set(day, worked);
      carry = Math.max(0, load - capacity);
      day = addDays(day, 1);
    }
    return rolled;
  }
  const rolledLoadByResource = new Map<string, Map<string, number>>();
  function rolledLoad(wc: PlanWorkCenter): Map<string, number> {
    let rolled = rolledLoadByResource.get(wc.workCenterId);
    if (rolled) return rolled;
    rolled = rollBuckets(wc, existingLoad.get(wc.workCenterId) ?? new Map<string, number>());
    rolledLoadByResource.set(wc.workCenterId, rolled);
    return rolled;
  }
  // The same rolled load with some days taken out of the buckets first (an
  // operation's own stored load) — never cached, the caller's days differ.
  function rolledLoadWithout(wc: PlanWorkCenter, without: readonly PlannedDay[]): Map<string, number> {
    if (without.length === 0) return rolledLoad(wc);
    const buckets = new Map(existingLoad.get(wc.workCenterId) ?? []);
    for (const d of without) buckets.set(d.date, Math.max(0, (buckets.get(d.date) ?? 0) - d.minutes));
    return rollBuckets(wc, buckets);
  }

  // Minutes a resource can still take on `date` after the (rolled) existing
  // load and this run's bookings. Under the threshold counts as none.
  function freeMinutesOn(wc: PlanWorkCenter, date: string, rolled: ReadonlyMap<string, number>): number {
    const free = dayCapacity(wc, date) - (rolled.get(date) ?? 0) - (booked.get(wc.workCenterId)?.get(date) ?? 0);
    return free < MIN_PLAN_MINUTES ? 0 : free;
  }
  const freeMinutes = (wc: PlanWorkCenter, date: string) => freeMinutesOn(wc, date, rolledLoad(wc));

  // Första lediga dag per resurs: every day before it is full (against the
  // cached rolled load and the bookings), so a placement on a full resource
  // does not walk the same full days again. Monotone — bookings only take
  // free time away; `release` resets it. Not read by a peek with `without`
  // or `ignoreLoad` (another load).
  const firstFreeDay = new Map<string, string>();

  function book(wc: PlanWorkCenter, date: string, minutes: number) {
    const days = booked.get(wc.workCenterId) ?? new Map<string, number>();
    days.set(date, (days.get(date) ?? 0) + minutes);
    booked.set(wc.workCenterId, days);
  }
  function release(wc: PlanWorkCenter, days: PlannedDay[]) {
    const own = booked.get(wc.workCenterId);
    if (!own) return;
    for (const d of days) own.set(d.date, Math.max(0, (own.get(d.date) ?? 0) - d.minutes));
    firstFreeDay.delete(wc.workCenterId);
  }

  // The one placement loop behind `place` (commit = book what it takes) and
  // `peek` (commit = false: the same answer, nothing booked).
  function placeOn(wc: PlanWorkCenter | null, minutes: number, options: PeekOptions, commit: boolean): Placement {
    // A forced start moves the floor to that day (never into the past).
    const floor = options.forceStartDate ? maxDate(options.forceStartDate, today) : maxDate(options.floor, today);
    if (!wc || !hasCapacityCalendar(wc)) {
      // No calendar: unlimited — everything on the floor's working day (the
      // company's: never "ready on a Saturday"); nothing at all under the
      // threshold. Nothing to book: no capacity is counted.
      const day = nextWorkingDayOnOrAfter(floor, offDays);
      return {
        horizonExceeded: false,
        days: minutes >= MIN_PLAN_MINUTES ? [{ date: day, minutes }] : [],
        fromDate: day,
        toDate: day,
        readyDate: day,
        unscheduled: true,
      };
    }
    const days: PlannedDay[] = [];
    const rolled = options.ignoreLoad ? null : options.without ? rolledLoadWithout(wc, options.without) : rolledLoad(wc);
    // The pointer is only true for the cached load.
    const pointed = !options.ignoreLoad && !(options.without && options.without.length > 0);
    const pointer = () => (pointed ? (firstFreeDay.get(wc.workCenterId) ?? today) : today);
    let forced = !!options.forceStartDate;
    let rest = minutes;
    // A forced start must see the day itself, full or not.
    let day = forced ? floor : maxDate(floor, pointer());
    while (rest >= MIN_PLAN_MINUTES) {
      if (day >= horizonDate) {
        return { horizonExceeded: true, searchedFrom: days[0]?.date ?? floor, searchedTo: addDays(horizonDate, -1), partial: days };
      }
      let room: number;
      if (forced) {
        // The first day with capacity takes its WHOLE capacity.
        room = dayCapacity(wc, day);
        if (room >= MIN_PLAN_MINUTES) forced = false;
        else room = 0;
      } else {
        room = rolled === null ? dayCapacity(wc, day) : freeMinutesOn(wc, day, rolled);
        if (room < MIN_PLAN_MINUTES) room = 0;
      }
      let take = Math.min(rest, room);
      // What would be left after this day is under the threshold: it goes
      // here, with the last whole piece, never as a day of its own.
      if (take >= MIN_PLAN_MINUTES && rest - take < MIN_PLAN_MINUTES) take = rest;
      if (take >= MIN_PLAN_MINUTES) {
        if (commit) book(wc, day, take);
        days.push({ date: day, minutes: take });
        rest -= take;
      }
      if (pointed && day === pointer() && freeMinutesOn(wc, day, rolled!) === 0) firstFreeDay.set(wc.workCenterId, addDays(day, 1));
      if (rest >= MIN_PLAN_MINUTES) {
        day = addDays(day, 1);
        if (!forced && day < pointer()) day = pointer();
      }
    }
    const last = days[days.length - 1]?.date ?? day;
    return {
      horizonExceeded: false,
      days,
      fromDate: days[0]?.date ?? day,
      toDate: last,
      readyDate: last,
      unscheduled: false,
    };
  }

  return {
    today,
    firstMonday,
    horizonDate,
    lookups,
    place: (wc, minutes, options) => placeOn(wc, minutes, { floor: options.floor, forceStartDate: options.forceStartDate }, true),
    peek: (wc, minutes, options) => placeOn(wc, minutes, options, false),
    release,
    subcontract: (wc, floor) => subcontractReadyDate(wc, floor, offDays),
    undatedMinutes: (workCenterId) => undatedLoad.get(workCenterId) ?? 0,
    dayCapacity,
    weekCapacity,
    freeMinutes,
  };
}

// --- Valregeln (#15, Alternativa resurser) ---------------------------------
// ONE rule the förslag (resource-suggestions.ts) and Leveranstidskontrollen
// share, each with its own base. Still one placement rule: every try is a
// `peek` on the same book. Counted in DAYS since #18 (S9).

export interface ResourceCandidate {
  workCenter: PlanWorkCenter | null;
  // The operation's minutes on THIS resource — an alternative's own times,
  // or the ordinarie's where it has none (resolved by the caller).
  minutes: number;
  // An ALTERNATIVE's trial is made against the load minus these days (the
  // förslag: the order's own replannable load on that resource — a Byt
  // replans the whole order, so its own stored days are not in its way).
  // The base's come with the ChoiceBase. Left out = the whole load.
  without?: readonly PlannedDay[];
}

// Where the base's klar-dag comes from. The check: a trial placement on
// the base with the load. The förslag: the STORED plan's last day (null =
// unplanned, or a plan whose days have passed) measured against a trial
// with the load minus the operation's own stored days (`without`, as the
// book holds them) — the plan's age never decides, the load does (#15
// granskningen av etapp 2).
export type ChoiceBase = "trial" | { stored: string | null; without?: readonly PlannedDay[] };

export type PlacedPlacement = Extract<Placement, { horizonExceeded: false }>;

export interface ResourceChoice {
  index: number; // 0 = the base, n = candidates[n]
  baseFull: boolean; // the load pushes the base's klar-dag (or it does not fit within the horizon)
  baseToDate: string | null; // the base's klar-dag as compared; null = beyond the horizon (or unplanned and not tried)
  toDate: string | null; // the chosen resource's klar-dag; the base's = baseToDate
  placement: PlacedPlacement | null; // the chosen resource's trial with the load; null when none was made (or the base is stored)
}

// Never tried as an alternative: an inactive resource, a legoresurs, and a
// resource without capacity (no week schedule, no hours per day) — the book
// sees that one as unlimited and it would always win. It can still be
// chosen by hand.
export const triesAsAlternative = (wc: PlanWorkCenter | null): wc is PlanWorkCenter =>
  wc != null && wc.type !== "subcontract" && wc.active !== false && hasCapacityCalendar(wc);

export interface BaseMeasure {
  // The load pushes the base: its trial WITH the load finishes on a later
  // day than its trial on the bare resource from the same floor, or it does
  // not fit within the horizon.
  full: boolean;
  // The base's klar-dag AS COMPARED (Valregeln, the förslag's
  // currentToDate): the trial's day; for a stored base the earlier of the
  // stored day and the trial (a stale plan that would now finish earlier
  // counts as the trial, one the load has since pushed keeps the day the
  // planner sees). null = beyond the horizon and nothing stored.
  toDate: string | null;
  // The trial's own klar-dag — where Planera would put the base now
  // (null beyond the horizon). The förslag walk's floor reads THIS, not
  // `toDate`: a Byt replans the whole order with Planera's rules, so a
  // previous operation whose stored day is overbooked ends on the trial's
  // day, and a floor from the stored day would promise a day the switch
  // never gives (granskningen av etapp 3).
  trialToDate: string | null;
  trial: PlacedPlacement | null; // the trial with the load; null beyond the horizon
}

// ONE measure of the base — Valregeln's "is it full" and the förslag walk's
// floor (resource-suggestions.ts) read the same numbers. `forceStartDate`
// mirrors Planera's påbörjad operation (the floor walk only).
export function measureBase(
  book: CapacityBook,
  base: ResourceCandidate,
  floor: string,
  choiceBase: ChoiceBase,
  opts: { forceStartDate?: string } = {}
): BaseMeasure {
  const stored = choiceBase === "trial" ? null : choiceBase.stored;
  const without = choiceBase === "trial" ? undefined : choiceBase.without;
  const tried = book.peek(base.workCenter, base.minutes, { floor, without, forceStartDate: opts.forceStartDate });
  const trial = tried.horizonExceeded ? null : tried;
  const bare = book.peek(base.workCenter, base.minutes, { floor, ignoreLoad: true, forceStartDate: opts.forceStartDate });
  const full = trial === null || (!bare.horizonExceeded && trial.toDate > bare.toDate);
  const toDate = trial === null ? stored : stored === null || trial.toDate < stored ? trial.toDate : stored;
  return { full, toDate, trialToDate: trial?.toDate ?? null, trial };
}

// candidates[0] is the base (the förslag: the operation's current resource;
// the check: the routing's ordinarie), the rest the other resources in rank
// order. Nothing is booked — the caller books the choice if it should.
// 1. Without an alternative that can be tried: the base, no trial at all
//    (the existing suites and figures are untouched).
// 2. The base is full when the load pushes its klar-dag (measureBase): a
//    trial with the load finishes later than a trial on the bare base from
//    the same floor, or does not fit within the horizon. A base that is not
//    full wins even when an alternative is faster (beslut 2: the ordinarie
//    is the beredare's first choice).
// 3. A full base: each alternative is tried WITH the load, with its own
//    minutes; the earliest klar-DAG wins, a tie goes to the lowest rank,
//    and an alternative counts only when it is ready on an earlier day
//    than the base's klar-dag — a tie with the base keeps the base. Days,
//    with no threshold (#18, S9): the next operation's floor is the working
//    day after the klar-dag, so a day won here is a day won down the whole
//    chain. (While the plan counted in weeks the floor was the klar-vecka,
//    and a day inside the same week won nothing — that was why the rule
//    compared weeks.) Leveranstidskontrollen keeps its own guard: an
//    alternative only counts when the delivery date gets earlier, and the
//    beskärningspass drops the ones the date does not need.
export function chooseResource(
  book: CapacityBook,
  candidates: readonly ResourceCandidate[],
  floor: string,
  base: ChoiceBase
): ResourceChoice {
  const [first, ...others] = candidates;
  if (!first) throw new Error("chooseResource needs the base among the candidates");
  const stored = base === "trial" ? null : base.stored;
  const tried = others.map((c, i) => ({ c, index: i + 1 })).filter(({ c }) => triesAsAlternative(c.workCenter));
  if (tried.length === 0) return { index: 0, baseFull: false, baseToDate: stored, toDate: stored, placement: null };

  const measured = measureBase(book, first, floor, base);
  const baseToDate = measured.toDate;
  const keepBase: ResourceChoice = {
    index: 0,
    baseFull: measured.full,
    baseToDate,
    toDate: baseToDate,
    placement: base === "trial" ? measured.trial : null,
  };
  if (!measured.full) return keepBase;

  let best: { index: number; placement: PlacedPlacement } | null = null;
  for (const { c, index } of tried) {
    const trial = book.peek(c.workCenter, c.minutes, { floor, without: c.without });
    if (trial.horizonExceeded) continue;
    if (best === null || trial.toDate < best.placement.toDate) best = { index, placement: trial };
  }
  if (best !== null && (baseToDate === null || best.placement.toDate < baseToDate)) {
    return { index: best.index, baseFull: true, baseToDate, toDate: best.placement.toDate, placement: best.placement };
  }
  return keepBase;
}
