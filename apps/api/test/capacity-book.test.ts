import { describe, expect, it } from "vitest";
import {
  chooseResource,
  createCapacityBook,
  MIN_PLAN_MINUTES,
  nextOperationFloor,
  operationChain,
  PLAN_HORIZON_WEEKS,
  roundPlanDays,
  type CapacityBookInput,
  type PlanWorkCenter,
} from "../src/modules/planning/service/capacity-book.js";
import type { CapacityOperationRow, PlannedDay } from "../src/modules/planning/service/capacity-calc.js";
import { queueGapDays } from "../src/modules/planning/service/manufacturing-lead-time.js";

// Pure tests — no database. Monday 2026-10-19 is today unless a test says
// otherwise; the book counts per DAY (#18). 110 works Mon–Fri, 8 h a day.
const TODAY = "2026-10-19";
const MON = "2026-10-19";
const TUE = "2026-10-20";
const WED = "2026-10-21";
const THU = "2026-10-22";
const FRI = "2026-10-23";
const SAT = "2026-10-24";
const MON2 = "2026-10-26";
const TUE2 = "2026-10-27";
const W44 = MON2; // the Monday of week 44

const wc1: PlanWorkCenter = {
  workCenterId: "wc-1",
  code: "110",
  name: "Kantpress",
  type: "machine",
  weekScheduleId: "ws-40",
  hoursPerDay: null,
  capacityFactor: 1,
  leadTimeDays: null,
  queueTimeDays: null,
};

function existing(
  workCenterId: string,
  dueDate: string | null,
  hours: number,
  extra: Partial<CapacityOperationRow> = {}
): CapacityOperationRow {
  return {
    moOperationId: `mo-op-${workCenterId}-${dueDate}-${hours}`,
    manufacturingOrderId: "mo-x",
    orderNumber: "TO-X",
    articleNumber: "X",
    articleName: "X",
    workCenterId,
    orderQuantity: 1,
    dueDate,
    sequenceNo: 10,
    setupTime: hours * 60,
    runTimePerUnit: 0,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
    ...extra,
  };
}

const SCHEDULE: CapacityBookInput["schedule"] = {
  weekScheduleDays: [
    ...[1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
    // A four-day schedule: Monday–Thursday.
    ...[1, 2, 3, 4].map((weekday) => ({ weekScheduleId: "ws-32", weekday, dayScheduleId: "ds-480" })),
  ],
  daySchedules: [
    { id: "ds-480", netMinutes: 480 },
    { id: "ds-240", netMinutes: 240 },
  ],
  holidays: [],
};

function book(partial: Partial<CapacityBookInput> = {}) {
  return createCapacityBook({
    today: TODAY,
    offDays: new Set(),
    workCenters: new Map([["wc-1", wc1]]),
    schedule: SCHEDULE,
    existingOperations: [],
    ...partial,
  });
}

const h = (hours: number) => hours * 60;
const days = (...list: [string, number][]): PlannedDay[] => list.map(([date, hours]) => ({ date, minutes: h(hours) }));
const placedDays = (p: ReturnType<ReturnType<typeof book>["place"]>) => (p.horizonExceeded ? null : p.days);

describe("capacity book — placement day by day", () => {
  it("shares the check's horizon: 104 weeks from the Monday of today's week", () => {
    expect(PLAN_HORIZON_WEEKS).toBe(104);
    expect(book().horizonDate).toBe("2028-10-16");
    expect(book({ today: WED }).horizonDate).toBe("2028-10-16");
  });

  it("places an operation day by day on free capacity: ready the day its last minute is placed", () => {
    expect(book().place(wc1, h(20), { floor: TODAY })).toEqual({
      horizonExceeded: false,
      days: days([MON, 8], [TUE, 8], [WED, 4]),
      fromDate: MON,
      toDate: WED,
      readyDate: WED,
      unscheduled: false,
    });
  });

  it("books what it places: the next placement sees it", () => {
    const b = book();
    expect(b.place(wc1, h(4), { floor: TODAY })).toMatchObject({ days: days([MON, 4]), readyDate: MON });
    expect(b.place(wc1, h(10), { floor: TODAY })).toMatchObject({ days: days([MON, 4], [TUE, 6]), fromDate: MON, toDate: TUE });
    expect(b.freeMinutes(wc1, MON)).toBe(0);
    expect(b.freeMinutes(wc1, TUE)).toBe(h(2));
  });

  it("today counts as a whole day and nothing is placed before it", () => {
    const b = book({ today: WED });
    expect(b.dayCapacity(wc1, TUE)).toBe(0);
    expect(b.dayCapacity(wc1, WED)).toBe(h(8));
    // A floor in the past is today.
    expect(b.place(wc1, h(20), { floor: MON })).toMatchObject({ days: days([WED, 8], [THU, 8], [FRI, 4]), readyDate: FRI });
  });

  it("a floor is the first day capacity may be used, and a weekend is jumped", () => {
    expect(book().place(wc1, h(12), { floor: FRI })).toMatchObject({ days: days([FRI, 8], [MON2, 4]), fromDate: FRI, toDate: MON2 });
    expect(book().place(wc1, h(2), { floor: SAT })).toMatchObject({ days: days([MON2, 2]), fromDate: MON2 });
  });

  it("existing unplanned load lies on its due date and rolls forward day by day", () => {
    // 20 h due Wednesday on an 8 h day: Wed and Thu full, 4 h on Friday.
    const b = book({ existingOperations: [existing("wc-1", WED, 20)] });
    expect([MON, TUE, WED, THU, FRI].map((d) => b.freeMinutes(wc1, d))).toEqual([h(8), h(8), 0, 0, h(4)]);
    expect(b.place(wc1, h(22), { floor: TODAY })).toMatchObject({ days: days([MON, 8], [TUE, 8], [FRI, 4], [MON2, 2]) });
  });

  it("an over-full day rolls into the next; a passed due date or plan lies on today", () => {
    const overfull = book({ existingOperations: [existing("wc-1", FRI, 12, { plannedDays: days([MON, 12]) })] });
    expect([overfull.freeMinutes(wc1, MON), overfull.freeMinutes(wc1, TUE)]).toEqual([0, h(4)]);
    // Planned last Friday and not worked, and one due last week: both today.
    const passed = book({
      existingOperations: [
        existing("wc-1", FRI, 6, { plannedDays: days(["2026-10-16", 6]) }),
        existing("wc-1", "2026-10-14", 4, { moOperationId: "old" }),
      ],
    });
    expect([passed.freeMinutes(wc1, MON), passed.freeMinutes(wc1, TUE)]).toEqual([0, h(6)]);
  });

  it("a röd dag has no capacity and a kortdag its own day schedule — the load rolls past them", () => {
    const red = book({
      schedule: { ...SCHEDULE, holidays: [{ date: WED, dayScheduleId: null }] },
      existingOperations: [existing("wc-1", TUE, 20)],
    });
    expect(red.dayCapacity(wc1, WED)).toBe(0);
    expect([TUE, WED, THU, FRI].map((d) => red.freeMinutes(wc1, d))).toEqual([0, 0, 0, h(4)]);
    expect(red.place(wc1, h(10), { floor: TUE })).toMatchObject({ days: days([FRI, 4], [MON2, 6]) });

    const short = book({
      schedule: { ...SCHEDULE, holidays: [{ date: WED, dayScheduleId: "ds-240" }] },
      existingOperations: [existing("wc-1", TUE, 14)],
    });
    expect(short.dayCapacity(wc1, WED)).toBe(h(4));
    expect([TUE, WED, THU].map((d) => short.freeMinutes(wc1, d))).toEqual([0, 0, h(6)]);
    // An empty kortdag takes its four hours.
    expect(book({ schedule: { ...SCHEDULE, holidays: [{ date: WED, dayScheduleId: "ds-240" }] } }).place(wc1, h(22), { floor: TUE })).toMatchObject({
      days: days([TUE, 8], [WED, 4], [THU, 8], [FRI, 2]),
    });
  });

  it("a four-day schedule: Friday is no day for the resource", () => {
    const fourDays: PlanWorkCenter = { ...wc1, workCenterId: "wc-4", code: "140", weekScheduleId: "ws-32" };
    const b = book({ workCenters: new Map([["wc-4", fourDays]]), existingOperations: [existing("wc-4", MON, 40)] });
    expect(b.weekCapacity(fourDays, MON)).toBe(h(32));
    expect([THU, FRI, MON2, TUE2].map((d) => b.freeMinutes(fourDays, d))).toEqual([0, 0, 0, h(8)]);
    expect(book().place(fourDays, h(36), { floor: WED })).toMatchObject({ days: days([WED, 8], [THU, 8], [MON2, 8], [TUE2, 8], ["2026-10-28", 4]) });
  });

  it("existing planned load counts on its planned days — the remaining time filled from the back", () => {
    // 20 h planned Mon 8 / Tue 8 / Wed 4, 10 h reported ⇒ Tue 6, Wed 4 left.
    const b = book({
      existingOperations: [
        existing("wc-1", FRI, 0, {
          setupTime: 0,
          runTimePerUnit: 60,
          orderQuantity: 20,
          quantityCompleted: 10,
          plannedDays: days([MON, 8], [TUE, 8], [WED, 4]),
        }),
      ],
    });
    expect([MON, TUE, WED].map((d) => b.freeMinutes(wc1, d))).toEqual([h(8), h(2), h(4)]);
  });

  it("a forced start takes the day's WHOLE capacity even when it is full, then continues on free capacity", () => {
    const b = book({ existingOperations: [existing("wc-1", FRI, 12, { plannedDays: days([WED, 8], [THU, 4]) })] });
    // Not forced: Wednesday is full, so Thursday.
    expect(b.peek(wc1, h(2), { floor: WED })).toMatchObject({ days: days([THU, 2]) });
    // Forced on Wednesday: 8 h there (overload), the rest on what is free after it.
    expect(b.place(wc1, h(14), { floor: TODAY, forceStartDate: WED })).toMatchObject({
      days: days([WED, 8], [THU, 4], [FRI, 2]),
      fromDate: WED,
      toDate: FRI,
    });
    // The forced floor wins over a later floor too.
    expect(b.peek(wc1, h(1), { floor: MON2, forceStartDate: TUE })).toMatchObject({ fromDate: TUE });
  });

  it("a forced start on a day without capacity starts the first day that has some — a move compares fromDate", () => {
    // A Saturday, and a röd dag: the placement starts later (the service refuses the move).
    expect(book().place(wc1, h(2), { floor: TODAY, forceStartDate: SAT })).toMatchObject({ fromDate: MON2, days: days([MON2, 2]) });
    const red = book({ schedule: { ...SCHEDULE, holidays: [{ date: WED, dayScheduleId: null }] } });
    expect(red.place(wc1, h(2), { floor: TODAY, forceStartDate: WED })).toMatchObject({ fromDate: THU });
    // In the past: today.
    expect(book().place(wc1, h(2), { floor: TODAY, forceStartDate: "2026-10-05" })).toMatchObject({ days: days([MON, 2]) });
  });

  it("started on a Saturday: forced from today, the first working day takes it whatever the load", () => {
    const b = book({ today: SAT, existingOperations: [existing("wc-1", MON2, 8, { plannedDays: days([MON2, 8]) })] });
    expect(b.place(wc1, h(10), { floor: SAT, forceStartDate: SAT })).toMatchObject({ days: days([MON2, 8], [TUE2, 2]), fromDate: MON2 });
  });

  it("a resource without a calendar is unlimited: everything on the floor's working day, never a Saturday", () => {
    const noCalendar: PlanWorkCenter = { ...wc1, workCenterId: "wc-2", code: "200", weekScheduleId: null };
    const b = book({ workCenters: new Map([["wc-2", noCalendar]]), offDays: new Set([MON2]) });
    expect(b.place(noCalendar, h(100), { floor: WED })).toEqual({
      horizonExceeded: false,
      days: days([WED, 100]),
      fromDate: WED,
      toDate: WED,
      readyDate: WED,
      unscheduled: true,
    });
    // The company's working days: Saturday ⇒ Tuesday (Monday is a holiday).
    expect(b.place(noCalendar, h(1), { floor: SAT })).toMatchObject({ days: days([TUE2, 1]), readyDate: TUE2 });
    expect(b.place(noCalendar, h(1), { floor: TODAY, forceStartDate: SAT })).toMatchObject({ fromDate: TUE2 });
    // An unknown resource is treated the same.
    expect(b.place(null, h(1), { floor: TODAY })).toMatchObject({ unscheduled: true, days: days([MON, 1]) });
  });

  it("hours per day give capacity without a week schedule", () => {
    const perDay: PlanWorkCenter = { ...wc1, weekScheduleId: null, hoursPerDay: 4 };
    expect(book().place(perDay, h(10), { floor: TODAY })).toMatchObject({ days: days([MON, 4], [TUE, 4], [WED, 2]), unscheduled: false });
  });

  it("a lego operation is ready Ledtid + Kötid working days after the floor, rounded up; null = 0", () => {
    const lego: PlanWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", type: "subcontract", weekScheduleId: null, leadTimeDays: 3 };
    const b = book({ offDays: new Set([WED]) });
    expect(b.subcontract(lego, TODAY)).toBe(FRI); // Wednesday off
    expect(b.subcontract({ ...lego, leadTimeDays: null }, TODAY)).toBe(TODAY);
    expect(b.subcontract({ ...lego, leadTimeDays: 2.5 }, TODAY)).toBe(FRI); // rounded up
    // Ledtid 2 + Kötid 1.5 = 3.5 ⇒ 4 working days (S6).
    expect(book().subcontract({ ...lego, leadTimeDays: 2, queueTimeDays: 1.5 }, TODAY)).toBe(FRI);
    expect(book().subcontract({ ...lego, leadTimeDays: null, queueTimeDays: 2 }, TODAY)).toBe(WED);
  });

  it("the horizon: what was booked stays booked, the rest is reported as partial", () => {
    const b = book({ horizonWeeks: 1 });
    expect(b.horizonDate).toBe(MON2);
    const week = days([MON, 8], [TUE, 8], [WED, 8], [THU, 8], [FRI, 8]);
    expect(b.place(wc1, h(50), { floor: TODAY })).toEqual({ horizonExceeded: true, searchedFrom: MON, searchedTo: "2026-10-25", partial: week });
    // Every day is full now — a later placement sees that load.
    expect(b.place(wc1, h(1), { floor: TODAY })).toMatchObject({ horizonExceeded: true, partial: [] });
    // A floor beyond the horizon is reported from the floor.
    expect(book({ horizonWeeks: 1 }).place(wc1, h(1), { floor: TUE2 })).toMatchObject({
      horizonExceeded: true,
      searchedFrom: TUE2,
      searchedTo: "2026-10-25",
      partial: [],
    });
  });

  it("release gives bookings back — Planera's rule when the operation is not planned", () => {
    const b = book({ horizonWeeks: 1 });
    const placed = b.place(wc1, h(50), { floor: TODAY });
    b.release(wc1, placed.horizonExceeded ? placed.partial : []);
    expect([MON, FRI].map((d) => b.freeMinutes(wc1, d))).toEqual([h(8), h(8)]);
    expect(b.place(wc1, h(10), { floor: TODAY })).toMatchObject({ horizonExceeded: false, days: days([MON, 8], [TUE, 2]) });
    // Releasing nothing, or on a resource without bookings, is harmless.
    b.release(wc1, []);
    b.release({ ...wc1, workCenterId: "wc-9" }, days([MON, 5]));
    expect(b.freeMinutes(wc1, TUE)).toBe(h(6));
  });

  it("the first-free-day pointer never changes an answer: full days, a release, a forced start and a peek without", () => {
    const b = book({ existingOperations: [existing("wc-1", FRI, 8, { moOperationId: "own", plannedDays: days([MON, 8]) })] });
    // Monday is full (existing), Tuesday–Wednesday get booked full.
    expect(b.place(wc1, h(16), { floor: TODAY })).toMatchObject({ days: days([TUE, 8], [WED, 8]) });
    expect(b.place(wc1, h(1), { floor: TODAY })).toMatchObject({ days: days([THU, 1]) });
    // A peek without the existing operation's own load sees Monday free.
    expect(b.peek(wc1, h(1), { floor: TODAY, without: days([MON, 8]) })).toMatchObject({ days: days([MON, 1]) });
    // The bare capacity is searched from the floor.
    expect(b.peek(wc1, h(1), { floor: TODAY, ignoreLoad: true })).toMatchObject({ days: days([MON, 1]) });
    // A forced start sees the full day itself.
    expect(b.peek(wc1, h(1), { floor: TODAY, forceStartDate: TUE })).toMatchObject({ days: days([TUE, 1]) });
    // Released days are free again.
    b.release(wc1, days([TUE, 8]));
    expect(b.place(wc1, h(2), { floor: TODAY })).toMatchObject({ days: days([TUE, 2]) });
    expect(b.place(wc1, h(8), { floor: TODAY })).toMatchObject({ days: days([TUE, 6], [THU, 2]) });
  });

  it("undated existing load is left out of the capacity and reported per resource", () => {
    const b = book({ existingOperations: [existing("wc-1", null, 40)] });
    expect(b.undatedMinutes("wc-1")).toBe(h(40));
    expect(b.undatedMinutes("wc-9")).toBe(0);
    expect(b.place(wc1, h(2), { floor: TODAY })).toMatchObject({ days: days([MON, 2]) });
  });

  it("never books less than a hundredth of a minute: a tiny rest goes with the last whole piece", () => {
    // 8 h + 0.0003 min: the day's 8 h is the last whole piece, the rest
    // (a row the CHECK would refuse) joins it instead of a day of its own.
    const placed = book().place(wc1, h(8) + 0.0003, { floor: TODAY });
    expect(placed).toMatchObject({ horizonExceeded: false, fromDate: MON, toDate: MON });
    expect(placedDays(placed)).toEqual([{ date: MON, minutes: h(8) + 0.0003 }]);
  });

  it("a day with less than a hundredth of a minute free is skipped, and an operation under the threshold books nothing", () => {
    const b = book({ existingOperations: [existing("wc-1", MON, 0, { setupTime: h(8) - 0.0004 })] });
    expect(b.freeMinutes(wc1, MON)).toBe(0);
    expect(b.place(wc1, h(2), { floor: TODAY })).toMatchObject({ horizonExceeded: false, days: days([TUE, 2]), fromDate: TUE });
    // 0.0003 min on its own: no day at all — the caller clears the plan.
    const tiny = b.place(wc1, 0.0003, { floor: TODAY });
    expect(tiny).toMatchObject({ horizonExceeded: false });
    expect(placedDays(tiny)).toEqual([]);
    expect(MIN_PLAN_MINUTES).toBe(0.01);
  });

  it("the capacity factor scales the day; the week is the sum of its days", () => {
    const doubled: PlanWorkCenter = { ...wc1, capacityFactor: 2 };
    const one = book();
    expect([one.dayCapacity(wc1, MON2), one.dayCapacity(doubled, MON2), one.dayCapacity(wc1, SAT)]).toEqual([h(8), h(16), 0]);
    expect([one.weekCapacity(wc1, W44), one.weekCapacity(wc1, W44), one.weekCapacity(doubled, W44)]).toEqual([h(40), h(40), h(80)]);
    // The current week only counts from today.
    expect(book({ today: WED }).weekCapacity(wc1, MON)).toBe(h(24));
    expect(book().place(doubled, h(20), { floor: TODAY })).toMatchObject({ days: days([MON, 16], [TUE, 4]) });
  });
});

describe("roundPlanDays — what the database holds", () => {
  const sum = (list: PlannedDay[]) => list.reduce((s, d) => s + d.minutes, 0);

  it("two decimals, no row under 0.01, the total kept", () => {
    // A trailing 0.0003 joins the day before it; a leading 0.0004 the day after.
    expect(roundPlanDays([{ date: MON, minutes: 480 }, { date: TUE, minutes: 0.0003 }])).toEqual([{ date: MON, minutes: 480 }]);
    expect(roundPlanDays([{ date: MON, minutes: 0.0004 }, { date: TUE, minutes: 600 }])).toEqual([{ date: TUE, minutes: 600 }]);
    // A tiny middle day joins the previous one; unsorted input is sorted.
    const middle = roundPlanDays([{ date: WED, minutes: 100.004 }, { date: MON, minutes: 50.003 }, { date: TUE, minutes: 0.004 }]);
    expect(middle).toEqual([{ date: MON, minutes: 50.01 }, { date: WED, minutes: 100 }]);
    expect(sum(middle)).toBeCloseTo(150.01, 10); // = round2(150.011)
    // Rounding residuals land in the last row so the rows add up to the
    // total: 3 × 1.004 = 3.012 ⇒ 3.01, not 3.00.
    expect(roundPlanDays([{ date: MON, minutes: 1.004 }, { date: TUE, minutes: 1.004 }, { date: WED, minutes: 1.004 }])).toEqual([
      { date: MON, minutes: 1 },
      { date: TUE, minutes: 1 },
      { date: WED, minutes: 1.01 },
    ]);
    // Duplicate dates are summed (one row per day); all tiny ⇒ nothing.
    expect(roundPlanDays([{ date: MON, minutes: 5 }, { date: MON, minutes: 2.5 }])).toEqual([{ date: MON, minutes: 7.5 }]);
    expect(roundPlanDays([{ date: MON, minutes: 0.0003 }, { date: TUE, minutes: 0.0004 }])).toEqual([]);
    expect(roundPlanDays([])).toEqual([]);
  });

  it("properties over random allocations: ascending, one row per day, ≥ 0.01, two decimals, the total at two decimals, idempotent", () => {
    let seed = 20261119;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const dates = [MON, TUE, WED, THU, FRI, MON2, TUE2];
    for (let run = 0; run < 300; run++) {
      const input: PlannedDay[] = [];
      const n = 1 + Math.floor(random() * 9);
      for (let i = 0; i < n; i++) {
        const tiny = random() < 0.3;
        input.push({ date: dates[Math.floor(random() * dates.length)]!, minutes: tiny ? random() * 0.02 : random() * 500 });
      }
      const out = roundPlanDays(input);
      const total = Math.round(sum(input) * 100);
      for (let i = 0; i < out.length; i++) {
        expect(out[i]!.minutes).toBeGreaterThanOrEqual(MIN_PLAN_MINUTES);
        expect(Math.abs(out[i]!.minutes * 100 - Math.round(out[i]!.minutes * 100))).toBeLessThan(1e-6);
        if (i > 0) expect(out[i]!.date > out[i - 1]!.date).toBe(true);
      }
      // The total is kept to the cent — except when everything rounds away.
      if (out.length > 0) expect(Math.abs(Math.round(sum(out) * 100) - total)).toBeLessThanOrEqual(1);
      else expect(total).toBeLessThanOrEqual(1);
      expect(roundPlanDays(out)).toEqual(out);
    }
  });
});

describe("nextOperationFloor and queueGapDays — the wait between operations (#18, S3/S4)", () => {
  const none = new Set<string>();

  it("without a queue time the next operation starts the next working day", () => {
    expect(nextOperationFloor(MON, 1, 0, none)).toBe(TUE);
    expect(nextOperationFloor(FRI, 1, 0, none)).toBe(MON2); // Friday → Monday
    expect(nextOperationFloor(SAT, 1, 0, none)).toBe(MON2); // ready on a Saturday (the resource's own calendar)
    expect(nextOperationFloor(MON, 1, 0, new Set([TUE]))).toBe(WED); // a holiday
    expect(nextOperationFloor(THU, 1, 0, new Set([FRI, MON2]))).toBe(TUE2);
  });

  it("a whole queue time adds its days to every gap, in the company's working days", () => {
    expect(nextOperationFloor(MON, 1, 1, none)).toBe(WED);
    expect(nextOperationFloor(MON, 5, 1, none)).toBe(WED);
    expect(nextOperationFloor(THU, 1, 1, none)).toBe(MON2);
    expect(nextOperationFloor(MON, 1, 2, new Set([WED]))).toBe(FRI);
  });

  it("a decimal queue time is rounded up on the accumulated sum, never per gap", () => {
    const gaps = (q: number, n: number) => Array.from({ length: n }, (_, i) => queueGapDays(i + 1, q));
    expect(gaps(0, 4)).toEqual([0, 0, 0, 0]);
    expect(gaps(1, 4)).toEqual([1, 1, 1, 1]);
    expect(gaps(0.5, 4)).toEqual([1, 0, 1, 0]); // three gaps = 2 days, like the lead time
    expect(gaps(1.5, 4)).toEqual([2, 1, 2, 1]);
    expect(gaps(0.1, 11)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    // The gaps 1..n always sum to ceil(n × q) — float noise included (0.7 × 10, 0.1 × 3).
    for (const q of [0.1, 0.3, 0.5, 0.7, 1, 1.5, 2.3]) {
      for (let n = 1; n <= 30; n++) {
        expect(gaps(q, n).reduce((a, b) => a + b, 0)).toBe(Math.ceil(Number((n * q).toFixed(6))));
      }
    }
    expect(queueGapDays(0, 1)).toBe(0);
    expect(queueGapDays(1, -2)).toBe(0);
    // The floor follows: q = 0.5 ⇒ +2, +1, +2 working days.
    expect([1, 2, 3].map((k) => nextOperationFloor(MON, k, 0.5, none))).toEqual([WED, TUE, WED]);
    expect([1, 2].map((k) => nextOperationFloor(MON, k, 1.5, none))).toEqual([THU, WED]);
  });

  it("operationChain: no gap before the first operation, then one per operation that took a place", () => {
    const chain = operationChain(MON, 0.5, none);
    expect([chain.floor(), chain.ready, chain.previousReady]).toEqual([MON, MON, null]);
    chain.advance(TUE); // the first operation is ready Tuesday
    expect([chain.floor(), chain.previousReady]).toEqual([THU, TUE]); // + 1 + gap 1 (1 day)
    chain.advance(THU);
    expect(chain.floor()).toBe(FRI); // gap 2 of q = 0.5 is 0 days
    // An operation ready EARLIER (a forced start) never pulls the chain back.
    chain.advance(MON);
    expect([chain.ready, chain.floor()]).toEqual([THU, MON2]); // gap 3: 1 day ⇒ Fri + … = Monday
  });
});

// --- Alternativa resurser (#15): provplacering and Valregeln ---------------

const wc2: PlanWorkCenter = { ...wc1, workCenterId: "wc-2", code: "120", name: "Kantpress 2" };
const wc3: PlanWorkCenter = { ...wc1, workCenterId: "wc-3", code: "130", name: "Kantpress 3" };
const noCapacity: PlanWorkCenter = { ...wc1, workCenterId: "wc-n", code: "150", name: "Utan kapacitet", weekScheduleId: null };
const inactive: PlanWorkCenter = { ...wc1, workCenterId: "wc-i", code: "160", name: "Inaktiv", active: false };
const lego: PlanWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Lego", type: "subcontract", weekScheduleId: null, leadTimeDays: 5 };

// A book where `load` hours sit on each resource on the given days.
function loadedBook(load: [workCenterId: string, date: string, hours: number][], partial: Partial<CapacityBookInput> = {}) {
  return book({
    workCenters: new Map([wc1, wc2, wc3, noCapacity, inactive, lego].map((w) => [w.workCenterId, w])),
    existingOperations: load.map(([workCenterId, date, hours], i) =>
      existing(workCenterId, date, hours, { moOperationId: `load-${i}`, plannedDays: [{ date, minutes: h(hours) }] })
    ),
    ...partial,
  });
}
const cand = (workCenter: PlanWorkCenter | null, hours: number) => ({ workCenter, minutes: h(hours) });
const fullWeek = (workCenterId: string): [string, string, number][] => [MON, TUE, WED, THU, FRI].map((d) => [workCenterId, d, 8]);

describe("capacity book — peek (provplacering)", () => {
  it("gives exactly what place gives, and books nothing", () => {
    const b = loadedBook([["wc-1", MON, 6]]);
    const peeked = b.peek(wc1, h(6), { floor: TODAY });
    expect(peeked).toEqual({
      horizonExceeded: false,
      days: days([MON, 2], [TUE, 4]),
      fromDate: MON,
      toDate: TUE,
      readyDate: TUE,
      unscheduled: false,
    });
    // Nothing booked: the same peek again, and place agrees with it.
    expect(b.peek(wc1, h(6), { floor: TODAY })).toEqual(peeked);
    expect(b.freeMinutes(wc1, MON)).toBe(h(2));
    expect(b.place(wc1, h(6), { floor: TODAY })).toEqual(peeked);
    // place booked: the next peek sees it.
    expect(b.freeMinutes(wc1, MON)).toBe(0);
    expect(b.peek(wc1, h(6), { floor: TODAY })).toMatchObject({ days: days([TUE, 4], [WED, 2]), toDate: WED });
  });

  it("with ignoreLoad searches the bare capacity, from the floor", () => {
    const b = loadedBook([["wc-1", MON, 8], ["wc-1", TUE, 8]]);
    expect(b.peek(wc1, h(10), { floor: TODAY, ignoreLoad: true })).toMatchObject({ days: days([MON, 8], [TUE, 2]), toDate: TUE });
    expect(b.peek(wc1, h(10), { floor: THU, ignoreLoad: true })).toMatchObject({ days: days([THU, 8], [FRI, 2]), toDate: FRI });
    expect(b.freeMinutes(wc1, MON)).toBe(0);
  });

  it("with without leaves the given days out of the existing load before it is rolled", () => {
    // 8 h on Monday and 8 h on Tuesday, of which 6 h on Tuesday are the operation's own.
    const b = loadedBook([["wc-1", MON, 8], ["wc-1", TUE, 8]]);
    expect(b.peek(wc1, h(4), { floor: TODAY })).toMatchObject({ days: days([WED, 4]), toDate: WED });
    expect(b.peek(wc1, h(4), { floor: TODAY, without: days([TUE, 6]) })).toMatchObject({ days: days([TUE, 4]), toDate: TUE });
    // A backlog rolls: 12 h on Monday spills 4 h into Tuesday — without 4 of them nothing spills.
    const backlog = loadedBook([["wc-1", MON, 12]]);
    expect(backlog.peek(wc1, h(6), { floor: TODAY })).toMatchObject({ days: days([TUE, 4], [WED, 2]) });
    expect(backlog.peek(wc1, h(6), { floor: TODAY, without: days([MON, 4]) })).toMatchObject({ days: days([TUE, 6]) });
    // Nothing booked, and the book's own load is untouched by the trial.
    expect(b.freeMinutes(wc1, TUE)).toBe(0);
  });

  it("a resource without a calendar is never booked", () => {
    const b = loadedBook([]);
    expect(b.peek(noCapacity, h(5), { floor: TODAY })).toMatchObject({ toDate: MON, unscheduled: true });
    expect(b.place(noCapacity, h(500), { floor: TODAY })).toMatchObject({ toDate: MON, unscheduled: true });
    expect(b.place(noCapacity, h(500), { floor: TODAY })).toMatchObject({ toDate: MON, unscheduled: true });
  });
});

describe("chooseResource — Valregeln, in days (#18, S9)", () => {
  it("without an alternative that can be tried it gives the base and makes no trial at all", () => {
    const b = loadedBook([["wc-1", MON, 8]]);
    const base = { index: 0, baseFull: false, baseToDate: null, toDate: null, placement: null };
    expect(chooseResource(b, [cand(wc1, 4)], TODAY, "trial")).toEqual(base);
    // A resource without capacity, an inactive one, a legoresurs and an
    // unknown one are never tried — the book sees no capacity as unlimited.
    expect(chooseResource(b, [cand(wc1, 4), cand(noCapacity, 1), cand(inactive, 1), cand(lego, 1), cand(null, 1)], TODAY, "trial")).toEqual(base);
    expect(chooseResource(b, [cand(wc1, 4), cand(noCapacity, 1)], TODAY, { stored: WED })).toEqual({ ...base, baseToDate: WED, toDate: WED });
  });

  it("a base that is not full gives no alternative, even when an alternative is faster", () => {
    // 12 h on an empty 110: two days even without load. 120 would do it in one.
    const choice = chooseResource(loadedBook([]), [cand(wc1, 12), cand(wc2, 4)], TODAY, "trial");
    expect(choice).toMatchObject({ index: 0, baseFull: false, baseToDate: TUE, toDate: TUE });
    expect(choice.placement).toMatchObject({ days: days([MON, 8], [TUE, 4]) });
  });

  it("a full base gives the alternative ready on the earliest day, and a tie goes to the lowest rank", () => {
    // 110 is full today: 4 h waits until Tuesday. 120 is full too, 130 is free.
    const b = loadedBook([["wc-1", MON, 8], ["wc-2", MON, 8]]);
    const choice = chooseResource(b, [cand(wc1, 4), cand(wc2, 4), cand(wc3, 4)], TODAY, "trial");
    expect(choice).toMatchObject({ index: 2, baseFull: true, baseToDate: TUE, toDate: MON });
    expect(choice.placement).toMatchObject({ days: days([MON, 4]), readyDate: MON });
    // Both alternatives free: the same day, so rank 1 wins.
    const tie = chooseResource(loadedBook([["wc-1", MON, 8]]), [cand(wc1, 4), cand(wc2, 4), cand(wc3, 4)], TODAY, "trial");
    expect(tie).toMatchObject({ index: 1, toDate: MON });
    // Nothing was booked by the choice.
    expect(b.freeMinutes(wc3, MON)).toBe(h(8));
  });

  it("days, not weeks: a day won inside the same week is a day won", () => {
    // 110 is full Monday and Tuesday (ready Wednesday), 120 full Monday
    // (ready Tuesday), 130 free (ready today): the earliest day wins, not
    // the lowest rank of the same week.
    const b = loadedBook([["wc-1", MON, 8], ["wc-1", TUE, 8], ["wc-2", MON, 8]]);
    expect(chooseResource(b, [cand(wc1, 4), cand(wc2, 4), cand(wc3, 4)], TODAY, "trial")).toMatchObject({
      index: 2,
      baseToDate: WED,
      toDate: MON,
    });
    expect(chooseResource(b, [cand(wc1, 4), cand(wc2, 4)], TODAY, "trial")).toMatchObject({ index: 1, baseToDate: WED, toDate: TUE });
  });

  it("an alternative wins only on an EARLIER day than the base — a tie keeps the base", () => {
    // 110: 2 h left today, so 4 h finishes Tuesday (full: bare it is today).
    // 120: 1 h left — also Tuesday.
    const b = loadedBook([["wc-1", MON, 6], ["wc-2", MON, 7]]);
    expect(chooseResource(b, [cand(wc1, 4), cand(wc2, 4)], TODAY, "trial")).toMatchObject({
      index: 0,
      baseFull: true,
      baseToDate: TUE,
      toDate: TUE,
    });
  });

  it("a base beyond the horizon gives an alternative; all beyond the horizon gives the base", () => {
    const horizon = { horizonWeeks: 1 };
    const b = loadedBook(fullWeek("wc-1"), horizon);
    expect(chooseResource(b, [cand(wc1, 4), cand(wc2, 4)], TODAY, "trial")).toMatchObject({ index: 1, baseFull: true, baseToDate: null, toDate: MON });
    const all = loadedBook([...fullWeek("wc-1"), ...fullWeek("wc-2")], horizon);
    expect(chooseResource(all, [cand(wc1, 4), cand(wc2, 4)], TODAY, "trial")).toEqual({
      index: 0,
      baseFull: true,
      baseToDate: null,
      toDate: null,
      placement: null,
    });
  });

  it("never tries a resource without capacity or an inactive one, even when the base is full", () => {
    const b = loadedBook([["wc-1", MON, 8]]);
    // Only untried ones: the base without a trial, as without alternatives.
    expect(chooseResource(b, [cand(wc1, 4), cand(noCapacity, 4), cand(inactive, 4)], TODAY, "trial")).toMatchObject({ index: 0, placement: null });
    expect(chooseResource(b, [cand(wc1, 4), cand(noCapacity, 4), cand(inactive, 4), cand(wc3, 4)], TODAY, "trial")).toMatchObject({
      index: 3,
      toDate: MON,
    });
  });

  it("tries each alternative with its own minutes — own times or som ordinarie", () => {
    // 120 has 2 h left today.
    const b = loadedBook([["wc-1", MON, 8], ["wc-2", MON, 6]]);
    // Som ordinarie: the same 4 h as 110 — Tuesday on 120 too, no better than the base.
    expect(chooseResource(b, [cand(wc1, 4), cand(wc2, 4)], TODAY, "trial")).toMatchObject({ index: 0, baseToDate: TUE });
    // Its own, shorter time: 2 h fits today.
    expect(chooseResource(b, [cand(wc1, 4), cand(wc2, 2)], TODAY, "trial")).toMatchObject({ index: 1, toDate: MON });
  });

  it("measures the förslag's stored base by a trial with the load minus its own days — the plan's age never decides", () => {
    // A stale plan: nothing loads 110 now, the stored plan ends Wednesday.
    // The trial finishes today like the bare base — not full, the base keeps
    // it (and its day is the trial's, the earlier of the two).
    expect(chooseResource(loadedBook([]), [cand(wc1, 4), cand(wc2, 4)], TODAY, { stored: WED })).toEqual({
      index: 0,
      baseFull: false,
      baseToDate: MON,
      toDate: MON,
      placement: null,
    });
    // The load pushes it: 110 is full Monday–Tuesday, the operation's own
    // 4 h sit on Wednesday (left out of its own trial). Full, and 120 is free today.
    const pushed = loadedBook([["wc-1", MON, 8], ["wc-1", TUE, 8], ["wc-1", WED, 4]]);
    expect(chooseResource(pushed, [cand(wc1, 4), cand(wc2, 4)], TODAY, { stored: WED, without: days([WED, 4]) })).toMatchObject({
      index: 1,
      baseFull: true,
      baseToDate: WED,
      toDate: MON,
      placement: { days: days([MON, 4]) },
    });
    // A stored day EARLIER than the trial (load added since) keeps the
    // stored day as the one to beat: 120 would be Wednesday too — no förslag.
    const later = loadedBook([["wc-1", MON, 8], ["wc-1", TUE, 8], ["wc-2", MON, 8], ["wc-2", TUE, 8]]);
    expect(chooseResource(later, [cand(wc1, 4), cand(wc2, 4)], TODAY, { stored: TUE })).toMatchObject({
      index: 0,
      baseFull: true,
      baseToDate: TUE,
    });
    // Unplanned (stored null) is measured by its trial too: free ⇒ not full.
    expect(chooseResource(loadedBook([]), [cand(wc1, 4), cand(wc2, 4)], TODAY, { stored: null })).toMatchObject({
      index: 0,
      baseFull: false,
      baseToDate: MON,
    });
    // …and its own unplanned load (on its due date) is not its competitor.
    const unplanned = loadedBook([["wc-1", MON, 8]]);
    expect(chooseResource(unplanned, [cand(wc1, 8), cand(wc2, 8)], TODAY, { stored: null, without: days([MON, 8]) })).toMatchObject({
      index: 0,
      baseFull: false,
      baseToDate: MON,
    });
    expect(chooseResource(unplanned, [cand(wc1, 8), cand(wc2, 8)], TODAY, { stored: null })).toMatchObject({ index: 1, baseToDate: TUE, toDate: MON });
    // Beyond the horizon with nothing stored: full, any alternative that fits wins.
    const horizon = loadedBook(fullWeek("wc-1"), { horizonWeeks: 1 });
    expect(chooseResource(horizon, [cand(wc1, 4), cand(wc2, 4)], TODAY, { stored: null })).toMatchObject({ index: 1, baseToDate: null, toDate: MON });
  });

  it("compares from the floor: a later floor moves both the bare base and the alternatives", () => {
    const b = loadedBook([["wc-1", TUE, 8]]);
    // From Tuesday: 110 is full there (4 h → Wednesday), 120 is free Tuesday.
    expect(chooseResource(b, [cand(wc1, 4), cand(wc2, 4)], TUE, "trial")).toMatchObject({ index: 1, baseToDate: WED, toDate: TUE });
    // From today the base is not full: Monday is free.
    expect(chooseResource(b, [cand(wc1, 4), cand(wc2, 4)], TODAY, "trial")).toMatchObject({ index: 0, baseFull: false, baseToDate: MON });
  });
});
