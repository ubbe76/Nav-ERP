// Kapacitetsboken — the one placement rule Leveranstidskontrollen, Planera
// and the planning of a new TO share: an operation's minutes are placed
// week by week on what is free of a resource's capacity after the existing
// load (rolled forward: what does not fit a week is worked the next) and
// what this run has already booked.
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
  // Valregeln never tries an inactive resource (#15). Optional: left out =
  // active, so the engine's fixtures read as before.
  active?: boolean;
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

export interface PeekOptions extends PlaceOptions {
  // The resource's bare capacity: the existing load and this run's bookings
  // are ignored — Valregeln's "the base without load".
  ignoreLoad?: boolean;
  // The existing load minus these weeks (an operation's own stored load, as
  // the book holds it — operationLoadWeeks): a stored plan measured against
  // the load as it is now, without competing with itself (#15 granskningen).
  without?: readonly PlannedWeek[];
}

// The smallest piece the book places in a week — mo_operation_plan_weeks
// stores minutes with two decimals under CHECK minutes > 0, so anything
// under a hundredth of a minute would round to a row the database refuses.
// Free time under it counts as none, and a rest under it goes with the
// last whole piece instead of becoming a week of its own.
export const MIN_PLAN_MINUTES = 0.01;

// An allocation as mo_operation_plan_weeks can hold it (writeOperationPlans
// runs every allocation through this): ascending weeks, one row per Monday,
// two decimals, every row ≥ MIN_PLAN_MINUTES. Minutes a week would lose to
// the rounding go to the previous kept week (the first week's to the next),
// and the rounding residual lands in the last row so the rows add up to the
// total at two decimals. [] when the whole allocation rounds away — the
// caller clears the operation.
export function roundPlanWeeks(weeks: PlannedWeek[]): PlannedWeek[] {
  const byMonday = new Map<string, number>();
  for (const w of weeks) byMonday.set(w.monday, (byMonday.get(w.monday) ?? 0) + w.minutes);
  const sorted = [...byMonday].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const total = sorted.reduce((sum, [, minutes]) => sum + minutes, 0);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const kept: PlannedWeek[] = [];
  let carry = 0;
  for (const [monday, raw] of sorted) {
    const minutes = raw + carry;
    carry = 0;
    if (round2(minutes) < MIN_PLAN_MINUTES) {
      if (kept.length > 0) kept[kept.length - 1]!.minutes += minutes;
      else carry = minutes;
      continue;
    }
    kept.push({ monday, minutes });
  }
  if (carry > 0 && kept.length > 0) kept[kept.length - 1]!.minutes += carry;
  const rounded = kept.map((w) => ({ monday: w.monday, minutes: round2(w.minutes) })).filter((w) => w.minutes >= MIN_PLAN_MINUTES);
  if (rounded.length === 0) return [];
  const last = rounded[rounded.length - 1]!;
  last.minutes = round2(last.minutes + (round2(total) - rounded.reduce((sum, w) => sum + w.minutes, 0)));
  return last.minutes >= MIN_PLAN_MINUTES ? rounded : rounded.slice(0, -1);
}

const EPS = 1e-9;
const maxDate = (a: string, b: string) => (a > b ? a : b);

export interface CapacityBook {
  readonly today: string;
  readonly firstMonday: string;
  readonly horizonMonday: string; // the first Monday outside the horizon
  readonly lookups: ScheduleLookups;
  place(wc: PlanWorkCenter | null, minutes: number, options: PlaceOptions): Placement;
  // Provplacering (#15): the same loop as `place`, but nothing is booked —
  // `place` is `peek` plus the booking. With `ignoreLoad` the resource's bare
  // capacity is searched.
  peek(wc: PlanWorkCenter | null, minutes: number, options: PeekOptions): Placement;
  // Gives booked weeks back — Planera's rule for an operation that hit the
  // horizon: its partial bookings must not stay as phantom load for the
  // TOs planned after it (Leveranstidskontrollen keeps them on purpose).
  release(wc: PlanWorkCenter, weeks: PlannedWeek[]): void;
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

  // Capacity per (resource, Monday, from-day), computed once per book: the
  // placement loop, the rolled load and every peek of Valregeln ask the same
  // weeks again and again. Keyed on the resource object (one per resource in
  // a run), so two differently configured objects never share an entry.
  const capacityCache = new WeakMap<PlanWorkCenter, Map<string, number>>();
  function weekCapacityFrom(wc: PlanWorkCenter, monday: string, fromDay: string): number {
    const from = maxDate(fromDay, monday);
    let cache = capacityCache.get(wc);
    if (!cache) {
      cache = new Map();
      capacityCache.set(wc, cache);
    }
    const key = `${monday}|${from}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let minutes = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      if (day < from) continue;
      minutes += resourceDayMinutes(lookups, wc, day);
    }
    const capacity = minutes * wc.capacityFactor;
    cache.set(key, capacity);
    return capacity;
  }
  const weekCapacity = (wc: PlanWorkCenter, monday: string) => weekCapacityFrom(wc, monday, maxDate(monday, today));

  // Existing load as it will actually be worked: week by week from its
  // bucket, what does not fit the week's capacity (from today in the current
  // week) rolls into the next — a backlog never vanishes just because its
  // week is over-full. Only resources with a capacity calendar are rolled
  // (the others are unlimited anyway); undated load stays out (noted).
  function rollBuckets(wc: PlanWorkCenter, buckets: ReadonlyMap<string, number>): Map<string, number> {
    const rolled = new Map<string, number>();
    const lastBucket = [...buckets.keys()].reduce((a, b) => maxDate(a, b), firstMonday);
    let carry = 0;
    for (let monday = firstMonday; monday < horizonMonday && (carry > EPS || monday <= lastBucket); monday = addDays(monday, 7)) {
      const load = (buckets.get(monday) ?? 0) + carry;
      const capacity = weekCapacity(wc, monday);
      rolled.set(monday, Math.min(load, capacity));
      carry = Math.max(0, load - capacity);
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
  // The same rolled load with some weeks taken out of the buckets first (an
  // operation's own stored load) — never cached, the caller's weeks differ.
  function rolledLoadWithout(wc: PlanWorkCenter, without: readonly PlannedWeek[]): Map<string, number> {
    if (without.length === 0) return rolledLoad(wc);
    const buckets = new Map(existingLoad.get(wc.workCenterId) ?? []);
    for (const w of without) buckets.set(w.monday, Math.max(0, (buckets.get(w.monday) ?? 0) - w.minutes));
    return rollBuckets(wc, buckets);
  }

  // Minutes a resource can still take in week `monday`, counting only days
  // from `fromDay`: never more than what is left of the whole week (from
  // today) after the existing load and this run's bookings.
  function freeMinutesOn(wc: PlanWorkCenter, monday: string, fromDay: string, rolled: Map<string, number>): number {
    const left = weekCapacity(wc, monday) - (rolled.get(monday) ?? 0) - (booked.get(wc.workCenterId)?.get(monday) ?? 0);
    return Math.max(0, Math.min(weekCapacityFrom(wc, monday, maxDate(fromDay, today)), left));
  }
  const freeMinutes = (wc: PlanWorkCenter, monday: string, fromDay: string) => freeMinutesOn(wc, monday, fromDay, rolledLoad(wc));
  function book(wc: PlanWorkCenter, monday: string, minutes: number) {
    const weeks = booked.get(wc.workCenterId) ?? new Map<string, number>();
    weeks.set(monday, (weeks.get(monday) ?? 0) + minutes);
    booked.set(wc.workCenterId, weeks);
  }
  function release(wc: PlanWorkCenter, weeks: PlannedWeek[]) {
    const own = booked.get(wc.workCenterId);
    if (!own) return;
    for (const w of weeks) own.set(w.monday, Math.max(0, (own.get(w.monday) ?? 0) - w.minutes));
  }
  const finishDay = (wc: PlanWorkCenter | null, monday: string, floor: string) =>
    weekFinishDay(lookups, offDays, wc, monday, floor);

  // The one placement loop behind `place` (commit = book what it takes) and
  // `peek` (commit = false: the same answer, nothing booked).
  function placeOn(wc: PlanWorkCenter | null, minutes: number, options: PeekOptions, commit: boolean): Placement {
    // A forced start moves the floor to that week (never into the past).
    const floor = options.forceStartWeek ? maxDate(maxDate(options.forceStartWeek, firstMonday), today) : options.floor;
    const startMonday = mondayOf(floor);
    if (!wc || !hasCapacityCalendar(wc)) {
      // No calendar: unlimited — everything in the floor's week (nothing at
      // all under the threshold).
      const whole = minutes >= MIN_PLAN_MINUTES;
      if (commit && wc && whole) book(wc, startMonday, minutes);
      return {
        horizonExceeded: false,
        weeks: whole ? [{ monday: startMonday, minutes }] : [],
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
    const rolled = options.ignoreLoad ? null : options.without ? rolledLoadWithout(wc, options.without) : rolledLoad(wc);
    while (rest >= MIN_PLAN_MINUTES) {
      if (monday >= horizonMonday) {
        return {
          horizonExceeded: true,
          searchedFrom: weeks[0]?.monday ?? startMonday,
          searchedTo: addDays(horizonMonday, -7),
          partial: weeks,
        };
      }
      const room = forced
        ? weekCapacity(wc, monday)
        : options.ignoreLoad
          ? weekCapacityFrom(wc, monday, maxDate(dayFloor, today))
          : freeMinutesOn(wc, monday, dayFloor, rolled!);
      let take = Math.min(rest, room);
      // What would be left after this week is under the threshold: it goes
      // here, with the last whole piece, never as a week of its own.
      if (rest - take < MIN_PLAN_MINUTES) take = rest;
      if (take >= MIN_PLAN_MINUTES) {
        if (commit) book(wc, monday, take);
        weeks.push({ monday, minutes: take });
        rest -= take;
      }
      forced = false;
      if (rest >= MIN_PLAN_MINUTES) {
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
    place: (wc, minutes, options) => placeOn(wc, minutes, { floor: options.floor, forceStartWeek: options.forceStartWeek }, true),
    peek: (wc, minutes, options) => placeOn(wc, minutes, options, false),
    release,
    subcontract: (wc, floor) => addWorkingDays(floor, Math.ceil(wc.leadTimeDays ?? 0), offDays),
    undatedMinutes: (workCenterId) => undatedLoad.get(workCenterId) ?? 0,
    weekCapacity,
    freeMinutes,
    weekFinishDay: finishDay,
  };
}

// --- Valregeln (#15, Alternativa resurser) ---------------------------------
// ONE rule the förslag (resource-suggestions.ts) and Leveranstidskontrollen
// share, each with its own base. Still one placement rule: every try is a
// `peek` on the same book.

export interface ResourceCandidate {
  workCenter: PlanWorkCenter | null;
  // The operation's minutes on THIS resource — an alternative's own times,
  // or the ordinarie's where it has none (resolved by the caller).
  minutes: number;
}

// Where the base's klar-vecka comes from. The check: a trial placement on
// the base with the load. The förslag: the STORED plan's last week (null =
// unplanned, or a plan whose weeks have passed) measured against a trial
// with the load minus the operation's own stored weeks (`without`, as the
// book holds them) — the plan's age never decides, the load does (#15
// granskningen av etapp 2).
export type ChoiceBase = "trial" | { stored: string | null; without?: readonly PlannedWeek[] };

export type PlacedPlacement = Extract<Placement, { horizonExceeded: false }>;

export interface ResourceChoice {
  index: number; // 0 = the base, n = candidates[n]
  baseFull: boolean; // the load pushes the base's klar-vecka (or it does not fit within the horizon)
  baseToWeek: string | null; // the base's klar-vecka as compared; null = beyond the horizon (or unplanned and not tried)
  toWeek: string | null; // the chosen resource's klar-vecka (Monday); the base's = baseToWeek
  placement: PlacedPlacement | null; // the chosen resource's trial with the load; null when none was made (or the base is stored)
}

// Never tried as an alternative: an inactive resource, a legoresurs, and a
// resource without capacity (no week schedule, no hours per day) — the book
// sees that one as unlimited and it would always win. It can still be
// chosen by hand.
export const triesAsAlternative = (wc: PlanWorkCenter | null): wc is PlanWorkCenter =>
  wc != null && wc.type !== "subcontract" && wc.active !== false && hasCapacityCalendar(wc);

export interface BaseMeasure {
  // The load pushes the base: its trial WITH the load finishes in a later
  // week than its trial on the bare resource from the same floor, or it does
  // not fit within the horizon.
  full: boolean;
  // The base's klar-vecka: the trial's week; for a stored base the earlier
  // of the stored week and the trial (a stale plan that would now finish
  // earlier counts as the trial, one the load has since pushed keeps the
  // week the planner sees). null = beyond the horizon and nothing stored.
  toWeek: string | null;
  trial: PlacedPlacement | null; // the trial with the load; null beyond the horizon
}

// ONE measure of the base — Valregeln's "is it full" and the förslag walk's
// floor (resource-suggestions.ts) read the same numbers. `forceStartWeek`
// mirrors Planera's påbörjad operation (the floor walk only).
export function measureBase(
  book: CapacityBook,
  base: ResourceCandidate,
  floor: string,
  choiceBase: ChoiceBase,
  opts: { forceStartWeek?: string } = {}
): BaseMeasure {
  const stored = choiceBase === "trial" ? null : choiceBase.stored;
  const without = choiceBase === "trial" ? undefined : choiceBase.without;
  const tried = book.peek(base.workCenter, base.minutes, { floor, without, forceStartWeek: opts.forceStartWeek });
  const trial = tried.horizonExceeded ? null : tried;
  const bare = book.peek(base.workCenter, base.minutes, { floor, ignoreLoad: true, forceStartWeek: opts.forceStartWeek });
  const full = trial === null || (!bare.horizonExceeded && trial.toWeek > bare.toWeek);
  const toWeek = trial === null ? stored : stored === null || trial.toWeek < stored ? trial.toWeek : stored;
  return { full, toWeek, trial };
}

// candidates[0] is the base (the förslag: the operation's current resource;
// the check: the routing's ordinarie), the rest the other resources in rank
// order. Nothing is booked — the caller books the choice if it should.
// 1. Without an alternative that can be tried: the base, no trial at all
//    (the existing suites and figures are untouched).
// 2. The base is full when the load pushes its klar-vecka (measureBase): a
//    trial with the load finishes later than a trial on the bare base from
//    the same floor, or does not fit within the horizon. A base that is not
//    full wins even when an alternative is faster (beslut 2: the ordinarie
//    is the beredare's first choice).
// 3. A full base: each alternative is tried WITH the load, with its own
//    minutes; the earliest klar-VECKA wins, a tie goes to the lowest rank,
//    and an alternative counts only when it is ready in an earlier week
//    than the base's klar-vecka — a tie with the base keeps the base. Weeks,
//    not days: the plan counts in weeks and the next operation's floor is
//    the klar-vecka, so a four-day week must not win a day inside the same
//    week.
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
  if (tried.length === 0) return { index: 0, baseFull: false, baseToWeek: stored, toWeek: stored, placement: null };

  const measured = measureBase(book, first, floor, base);
  const baseToWeek = measured.toWeek;
  const keepBase: ResourceChoice = {
    index: 0,
    baseFull: measured.full,
    baseToWeek,
    toWeek: baseToWeek,
    placement: base === "trial" ? measured.trial : null,
  };
  if (!measured.full) return keepBase;

  let best: { index: number; placement: PlacedPlacement } | null = null;
  for (const { c, index } of tried) {
    const trial = book.peek(c.workCenter, c.minutes, { floor });
    if (trial.horizonExceeded) continue;
    if (best === null || trial.toWeek < best.placement.toWeek) best = { index, placement: trial };
  }
  if (best !== null && (baseToWeek === null || best.placement.toWeek < baseToWeek)) {
    return { index: best.index, baseFull: true, baseToWeek, toWeek: best.placement.toWeek, placement: best.placement };
  }
  return keepBase;
}
