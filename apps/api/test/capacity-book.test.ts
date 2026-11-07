import { describe, expect, it } from "vitest";
import {
  chooseResource,
  createCapacityBook,
  MIN_PLAN_MINUTES,
  PLAN_HORIZON_WEEKS,
  roundPlanWeeks,
  type CapacityBookInput,
  type PlanWorkCenter,
} from "../src/modules/planning/service/capacity-book.js";
import type { CapacityOperationRow, PlannedWeek } from "../src/modules/planning/service/capacity-calc.js";

// Pure tests — no database. Monday 2026-10-19 is today unless a test says
// otherwise; week 43 is Mon 19 – Sun 25, week 44 Mon 26 – Sun 1 Nov, week
// 45 Mon 2 Nov.
const TODAY = "2026-10-19";
const W43 = "2026-10-19";
const W44 = "2026-10-26";
const W45 = "2026-11-02";
const W46 = "2026-11-09";

const wc1: PlanWorkCenter = {
  workCenterId: "wc-1",
  code: "110",
  name: "Kantpress",
  type: "machine",
  weekScheduleId: "ws-40",
  hoursPerDay: null,
  capacityFactor: 1,
  leadTimeDays: null,
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

function book(partial: Partial<CapacityBookInput> = {}) {
  return createCapacityBook({
    today: TODAY,
    offDays: new Set(),
    workCenters: new Map([["wc-1", wc1]]),
    schedule: {
      weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
      daySchedules: [{ id: "ds-480", netMinutes: 480 }],
      holidays: [],
    },
    existingOperations: [],
    ...partial,
  });
}

const h = (hours: number) => hours * 60;
const weeks = (...list: [string, number][]): PlannedWeek[] => list.map(([monday, hours]) => ({ monday, minutes: h(hours) }));

describe("capacity book — placement", () => {
  it("shares the check's horizon", () => {
    expect(PLAN_HORIZON_WEEKS).toBe(104);
    expect(book().horizonMonday).toBe("2028-10-16");
  });

  it("places an operation week by week on free capacity: start, finish and ready day", () => {
    const placed = book().place(wc1, h(50), { floor: TODAY });
    expect(placed).toEqual({
      horizonExceeded: false,
      weeks: weeks([W43, 40], [W44, 10]),
      fromWeek: W43,
      toWeek: W44,
      readyDate: "2026-10-30",
      unscheduled: false,
    });
  });

  it("books what it places: the next operation may use what is left of the finishing week", () => {
    const b = book();
    const first = b.place(wc1, h(4), { floor: TODAY });
    expect(first).toMatchObject({ weeks: weeks([W43, 4]), readyDate: "2026-10-23" });
    // Floor = the Monday of the finishing week (exactly the check's rule).
    const second = b.place(wc1, h(38), { floor: W43 });
    expect(second).toMatchObject({ weeks: weeks([W43, 36], [W44, 2]), fromWeek: W43, toWeek: W44 });
    expect(b.freeMinutes(wc1, W43, TODAY)).toBe(0);
    expect(b.freeMinutes(wc1, W44, W44)).toBe(h(38));
  });

  it("the current week only counts from today", () => {
    // Wednesday: 3 days × 8 h = 24 h left this week.
    const placed = book({ today: "2026-10-21" }).place(wc1, h(30), { floor: "2026-10-21" });
    expect(placed).toMatchObject({ weeks: weeks([W43, 24], [W44, 6]), readyDate: "2026-10-30" });
  });

  it("a floor mid-week only leaves the rest of that week", () => {
    const placed = book().place(wc1, h(30), { floor: "2026-10-21" });
    expect(placed).toMatchObject({ weeks: weeks([W43, 24], [W44, 6]) });
  });

  it("existing unplanned load rolls forward from its due week before anything is placed", () => {
    // 75 h due this week on a 40 h resource: week 43 full, 35 h spill into
    // week 44 (5 h free), so 11 h is 5 h in week 44 + 6 h in week 45.
    const placed = book({ existingOperations: [existing("wc-1", "2026-10-21", 75)] }).place(wc1, h(11), { floor: TODAY });
    expect(placed).toMatchObject({ weeks: weeks([W44, 5], [W45, 6]), fromWeek: W44, toWeek: W45, readyDate: "2026-11-06" });
  });

  it("existing planned load counts in its planned weeks, not its due week", () => {
    // Due this week but planned 60 h in week 44: week 43 is free, week 44
    // is full and 20 h roll into week 45.
    const b = book({ existingOperations: [existing("wc-1", "2026-10-21", 60, { plannedWeeks: weeks([W44, 60]) })] });
    expect(b.place(wc1, h(45), { floor: TODAY })).toMatchObject({ weeks: weeks([W43, 40], [W45, 5]), toWeek: W45 });
  });

  it("existing planned load is the remaining time filled from the back", () => {
    // 60 h planned v.44: 40 / v.45: 20, 30 h reported ⇒ 10 h in v.44, 20 in v.45.
    const b = book({
      existingOperations: [
        existing("wc-1", "2026-10-21", 0, { setupTime: 0, runTimePerUnit: 60, orderQuantity: 60, quantityCompleted: 30, plannedWeeks: weeks([W44, 40], [W45, 20]) }),
      ],
    });
    expect(b.freeMinutes(wc1, W44, W44)).toBe(h(30));
    expect(b.freeMinutes(wc1, W45, W45)).toBe(h(20));
  });

  it("a forced start takes the week's whole capacity even when it is full, then continues on free capacity", () => {
    const b = book({ existingOperations: [existing("wc-1", "2026-10-21", 40)] });
    // Not forced: week 43 is full, so week 44.
    expect(b.place(wc1, h(10), { floor: TODAY })).toMatchObject({ weeks: weeks([W44, 10]) });
    // Forced into week 43: 40 h there (overload), the rest after the 10 h
    // already booked in week 44.
    expect(b.place(wc1, h(50), { floor: TODAY, forceStartWeek: W43 })).toMatchObject({
      weeks: weeks([W43, 40], [W44, 10]),
      fromWeek: W43,
      toWeek: W44,
    });
  });

  it("a forced start in the past is clamped to the current week", () => {
    expect(book().place(wc1, h(10), { floor: TODAY, forceStartWeek: "2026-10-05" })).toMatchObject({ weeks: weeks([W43, 10]) });
  });

  it("a resource without a calendar is unlimited: everything in the floor's week", () => {
    const noCalendar: PlanWorkCenter = { ...wc1, workCenterId: "wc-2", code: "200", weekScheduleId: null };
    const placed = book({ workCenters: new Map([["wc-2", noCalendar]]) }).place(noCalendar, h(100), { floor: TODAY });
    expect(placed).toEqual({
      horizonExceeded: false,
      weeks: weeks([W43, 100]),
      fromWeek: W43,
      toWeek: W43,
      readyDate: "2026-10-23", // the last working day of the week
      unscheduled: true,
    });
    // An unknown resource is treated the same.
    expect(book().place(null, h(1), { floor: TODAY })).toMatchObject({ unscheduled: true, weeks: weeks([W43, 1]) });
  });

  it("a forced start on a resource without a calendar puts everything in the forced week", () => {
    const noCalendar: PlanWorkCenter = { ...wc1, workCenterId: "wc-2", code: "200", weekScheduleId: null };
    expect(book().place(noCalendar, h(100), { floor: TODAY, forceStartWeek: W46 })).toMatchObject({
      weeks: weeks([W46, 100]),
      readyDate: "2026-11-13",
    });
  });

  it("hours per day give capacity without a week schedule", () => {
    // 4 h a day: 20 h a week, so 30 h is week 43 + 10 h of week 44.
    const perDay: PlanWorkCenter = { ...wc1, weekScheduleId: null, hoursPerDay: 4 };
    expect(book().place(perDay, h(30), { floor: TODAY })).toMatchObject({ weeks: weeks([W43, 20], [W44, 10]), unscheduled: false });
  });

  it("a lego operation is ready after the resource's lead time in working days; null = 0", () => {
    const lego: PlanWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", type: "subcontract", weekScheduleId: null, leadTimeDays: 3 };
    const b = book({ offDays: new Set(["2026-10-21"]) });
    expect(b.subcontract(lego, TODAY)).toBe("2026-10-23"); // Wednesday off
    expect(b.subcontract({ ...lego, leadTimeDays: null }, TODAY)).toBe(TODAY);
    expect(b.subcontract({ ...lego, leadTimeDays: 2.5 }, TODAY)).toBe("2026-10-23"); // rounded up
  });

  it("the horizon: what was booked stays booked, the rest is reported as partial", () => {
    const b = book({ horizonWeeks: 2 });
    const placed = b.place(wc1, h(100), { floor: TODAY });
    expect(placed).toEqual({
      horizonExceeded: true,
      searchedFrom: W43,
      searchedTo: W44,
      partial: weeks([W43, 40], [W44, 40]),
    });
    // Both weeks are full now — a later placement sees that load.
    expect(b.place(wc1, h(1), { floor: TODAY })).toMatchObject({ horizonExceeded: true, partial: [] });
  });

  it("release gives the partial bookings back — Planera's rule when the operation is not planned", () => {
    const b = book({ horizonWeeks: 2 });
    const placed = b.place(wc1, h(100), { floor: TODAY });
    expect(placed).toMatchObject({ horizonExceeded: true, partial: weeks([W43, 40], [W44, 40]) });
    b.release(wc1, placed.horizonExceeded ? placed.partial : []);
    expect(b.freeMinutes(wc1, W43, TODAY)).toBe(h(40));
    expect(b.freeMinutes(wc1, W44, W44)).toBe(h(40));
    expect(b.place(wc1, h(10), { floor: TODAY })).toMatchObject({ horizonExceeded: false, weeks: weeks([W43, 10]) });
    // Releasing nothing, or on a resource without bookings, is harmless.
    b.release(wc1, []);
    b.release({ ...wc1, workCenterId: "wc-9" }, weeks([W43, 5]));
    expect(b.freeMinutes(wc1, W43, TODAY)).toBe(h(30));
  });

  it("a floor beyond the horizon is reported from the floor's week", () => {
    const placed = book({ horizonWeeks: 2 }).place(wc1, h(1), { floor: W45 });
    expect(placed).toMatchObject({ horizonExceeded: true, searchedFrom: W45, searchedTo: W44, partial: [] });
  });

  it("undated existing load is left out of the capacity and reported per resource", () => {
    const b = book({ existingOperations: [existing("wc-1", null, 40)] });
    expect(b.undatedMinutes("wc-1")).toBe(h(40));
    expect(b.undatedMinutes("wc-9")).toBe(0);
    expect(b.place(wc1, h(2), { floor: TODAY })).toMatchObject({ weeks: weeks([W43, 2]) });
  });

  it("weekFinishDay: the last day the resource works, never before the floor", () => {
    const b = book({ offDays: new Set(["2026-10-23"]) });
    expect(b.weekFinishDay(wc1, W43, TODAY)).toBe("2026-10-23"); // the resource's own calendar, not offDays
    expect(b.weekFinishDay(null, W43, TODAY)).toBe("2026-10-22"); // no calendar: company working days
    expect(b.weekFinishDay(wc1, W43, "2026-10-24")).toBe("2026-10-26"); // floor after the last working day: the next working day, never a Saturday
  });

  it("never books less than a hundredth of a minute: a tiny rest goes with the last whole piece", () => {
    // 40 h + 0.0003 min: the week's 40 h is the last whole piece, the rest
    // (under the threshold, a row the CHECK would refuse) joins it instead
    // of becoming a week of its own.
    const b = book();
    const placed = b.place(wc1, h(40) + 0.0003, { floor: TODAY });
    expect(placed).toMatchObject({ horizonExceeded: false, fromWeek: W43, toWeek: W43 });
    expect(placed.horizonExceeded ? [] : placed.weeks).toEqual([{ monday: W43, minutes: h(40) + 0.0003 }]);
    // The total is preserved and no row is under the threshold.
    const total = (placed.horizonExceeded ? [] : placed.weeks).reduce((s, w) => s + w.minutes, 0);
    expect(total).toBeCloseTo(h(40) + 0.0003, 6);
    expect((placed.horizonExceeded ? [] : placed.weeks).every((w) => w.minutes >= MIN_PLAN_MINUTES)).toBe(true);
  });

  it("a week with less than a hundredth of a minute free is skipped, and an operation under the threshold books nothing", () => {
    // 0.0004 min free in week 43: nothing is booked there, the operation
    // starts in week 44.
    const b = book({ existingOperations: [existing("wc-1", "2026-10-21", 0, { setupTime: h(40) - 0.0004 })] });
    expect(b.freeMinutes(wc1, W43, TODAY)).toBeCloseTo(0.0004, 6);
    const placed = b.place(wc1, h(10), { floor: TODAY });
    expect(placed).toMatchObject({ horizonExceeded: false, fromWeek: W44, toWeek: W44 });
    expect(placed.horizonExceeded ? [] : placed.weeks).toEqual(weeks([W44, 10]));
    // 0.0003 min on its own: no week at all — the caller clears the plan.
    const tiny = b.place(wc1, 0.0003, { floor: TODAY });
    expect(tiny).toMatchObject({ horizonExceeded: false, fromWeek: W43, toWeek: W43 });
    expect(tiny.horizonExceeded ? null : tiny.weeks).toEqual([]);
    expect(MIN_PLAN_MINUTES).toBe(0.01);
  });

  it("roundPlanWeeks: what the database holds — two decimals, no row under 0.01, the total kept", () => {
    const sum = (list: PlannedWeek[]) => list.reduce((s, w) => s + w.minutes, 0);
    // A trailing 0.0003 joins the week before it; a leading 0.0004 the week after.
    expect(roundPlanWeeks([{ monday: W43, minutes: 2400 }, { monday: W44, minutes: 0.0003 }])).toEqual([{ monday: W43, minutes: 2400 }]);
    expect(roundPlanWeeks([{ monday: W43, minutes: 0.0004 }, { monday: W44, minutes: 600 }])).toEqual([{ monday: W44, minutes: 600 }]);
    // A tiny middle week joins the previous one; unsorted input is sorted.
    const middle = roundPlanWeeks([{ monday: W45, minutes: 100.004 }, { monday: W43, minutes: 50.003 }, { monday: W44, minutes: 0.004 }]);
    expect(middle).toEqual([{ monday: W43, minutes: 50.01 }, { monday: W45, minutes: 100 }]);
    expect(sum(middle)).toBeCloseTo(150.01, 10); // = round2(150.011)
    expect(middle.every((w) => w.minutes >= MIN_PLAN_MINUTES)).toBe(true);
    // Rounding residuals land in the last row so the rows add up to the
    // total: 3 × 1.004 = 3.012 ⇒ 3.01, not 3.00.
    expect(roundPlanWeeks([{ monday: W43, minutes: 1.004 }, { monday: W44, minutes: 1.004 }, { monday: W45, minutes: 1.004 }])).toEqual([
      { monday: W43, minutes: 1 },
      { monday: W44, minutes: 1 },
      { monday: W45, minutes: 1.01 },
    ]);
    // Duplicate Mondays are summed (one row per week); all tiny ⇒ nothing.
    expect(roundPlanWeeks([{ monday: W43, minutes: 5 }, { monday: W43, minutes: 2.5 }])).toEqual([{ monday: W43, minutes: 7.5 }]);
    expect(roundPlanWeeks([{ monday: W43, minutes: 0.0003 }, { monday: W44, minutes: 0.0004 }])).toEqual([]);
    expect(roundPlanWeeks([])).toEqual([]);
  });

  it("the capacity factor scales the week", () => {
    const doubled: PlanWorkCenter = { ...wc1, capacityFactor: 2 };
    expect(book().weekCapacity(doubled, W44)).toBe(h(80));
    expect(book().place(doubled, h(60), { floor: TODAY })).toMatchObject({ weeks: weeks([W43, 60]) });
  });
});

// --- Alternativa resurser (#15): provplacering and Valregeln ---------------

const wc2: PlanWorkCenter = { ...wc1, workCenterId: "wc-2", code: "120", name: "Kantpress 2" };
const wc3: PlanWorkCenter = { ...wc1, workCenterId: "wc-3", code: "130", name: "Kantpress 3" };
const noCapacity: PlanWorkCenter = { ...wc1, workCenterId: "wc-n", code: "150", name: "Utan kapacitet", weekScheduleId: null };
const inactive: PlanWorkCenter = { ...wc1, workCenterId: "wc-i", code: "160", name: "Inaktiv", active: false };
const lego: PlanWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Lego", type: "subcontract", weekScheduleId: null, leadTimeDays: 5 };

// A book where `load` hours sit on each resource in the given weeks.
function loadedBook(load: [workCenterId: string, monday: string, hours: number][], partial: Partial<CapacityBookInput> = {}) {
  return book({
    workCenters: new Map([wc1, wc2, wc3, noCapacity, inactive, lego].map((w) => [w.workCenterId, w])),
    existingOperations: load.map(([workCenterId, monday, hours], i) =>
      existing(workCenterId, monday, hours, { moOperationId: `load-${i}`, plannedWeeks: [{ monday, minutes: h(hours) }] })
    ),
    ...partial,
  });
}
const cand = (workCenter: PlanWorkCenter | null, hours: number) => ({ workCenter, minutes: h(hours) });

describe("capacity book — peek (provplacering)", () => {
  it("gives exactly what place gives, and books nothing", () => {
    const b = loadedBook([["wc-1", W43, 30]]);
    const peeked = b.peek(wc1, h(20), { floor: TODAY });
    expect(peeked).toEqual({
      horizonExceeded: false,
      weeks: weeks([W43, 10], [W44, 10]),
      fromWeek: W43,
      toWeek: W44,
      readyDate: "2026-10-30",
      unscheduled: false,
    });
    // Nothing booked: the same peek again, and place agrees with it.
    expect(b.peek(wc1, h(20), { floor: TODAY })).toEqual(peeked);
    expect(b.freeMinutes(wc1, W43, TODAY)).toBe(h(10));
    expect(b.place(wc1, h(20), { floor: TODAY })).toEqual(peeked);
    // place booked: the next peek sees it.
    expect(b.freeMinutes(wc1, W43, TODAY)).toBe(0);
    expect(b.peek(wc1, h(20), { floor: TODAY })).toMatchObject({ weeks: weeks([W44, 20]), toWeek: W44 });
  });

  it("with ignoreLoad searches the bare capacity, from the floor", () => {
    const b = loadedBook([["wc-1", W43, 40], ["wc-1", W44, 40]]);
    expect(b.peek(wc1, h(50), { floor: TODAY, ignoreLoad: true })).toMatchObject({ weeks: weeks([W43, 40], [W44, 10]), toWeek: W44 });
    // From Thursday: two days (16 h) left of the floor's week.
    expect(b.peek(wc1, h(20), { floor: "2026-10-22", ignoreLoad: true })).toMatchObject({ weeks: weeks([W43, 16], [W44, 4]), toWeek: W44 });
    expect(b.freeMinutes(wc1, W43, TODAY)).toBe(0);
  });

  it("does not book a resource without a calendar either", () => {
    const b = loadedBook([]);
    expect(b.peek(noCapacity, h(5), { floor: TODAY })).toMatchObject({ toWeek: W43, unscheduled: true });
    expect(b.place(noCapacity, h(5), { floor: TODAY })).toMatchObject({ toWeek: W43, unscheduled: true });
  });
});

describe("chooseResource — Valregeln", () => {
  it("without an alternative that can be tried it gives the base and makes no trial at all", () => {
    const b = loadedBook([["wc-1", W43, 40]]);
    const base = { index: 0, baseFull: false, baseToWeek: null, toWeek: null, placement: null };
    expect(chooseResource(b, [cand(wc1, 10)], TODAY, "trial")).toEqual(base);
    // A resource without capacity, an inactive one, a legoresurs and an
    // unknown one are never tried — the book sees no capacity as unlimited.
    expect(chooseResource(b, [cand(wc1, 10), cand(noCapacity, 1), cand(inactive, 1), cand(lego, 1), cand(null, 1)], TODAY, "trial")).toEqual(base);
    expect(chooseResource(b, [cand(wc1, 10), cand(noCapacity, 1)], TODAY, { stored: W45 })).toEqual({ ...base, baseToWeek: W45, toWeek: W45 });
  });

  it("a base that is not full gives no alternative, even when an alternative is faster", () => {
    // 50 h on an empty 110: two weeks even without load. 120 would do it in one.
    const b = loadedBook([]);
    const choice = chooseResource(b, [cand(wc1, 50), cand(wc2, 30)], TODAY, "trial");
    expect(choice).toMatchObject({ index: 0, baseFull: false, baseToWeek: W44, toWeek: W44 });
    expect(choice.placement).toMatchObject({ weeks: weeks([W43, 40], [W44, 10]) });
  });

  it("a full base gives the alternative ready in the earliest week, and a tie in week goes to the lowest rank", () => {
    // 110 is full this week: 10 h waits until W44. 120 is full too, 130 is free.
    const b = loadedBook([["wc-1", W43, 40], ["wc-2", W43, 40]]);
    const choice = chooseResource(b, [cand(wc1, 10), cand(wc2, 10), cand(wc3, 10)], TODAY, "trial");
    expect(choice).toMatchObject({ index: 2, baseFull: true, baseToWeek: W44, toWeek: W43 });
    expect(choice.placement).toMatchObject({ weeks: weeks([W43, 10]), readyDate: "2026-10-23" });
    // Both alternatives free: the same week, so rank 1 wins.
    const tie = chooseResource(loadedBook([["wc-1", W43, 40]]), [cand(wc1, 10), cand(wc2, 10), cand(wc3, 10)], TODAY, "trial");
    expect(tie).toMatchObject({ index: 1, toWeek: W43 });
    // Weeks, not days: 130 would be ready Tuesday, 120 Friday — same week, rank wins.
    const days = chooseResource(loadedBook([["wc-1", W43, 40], ["wc-2", W43, 30]]), [cand(wc1, 10), cand(wc2, 10), cand(wc3, 2)], TODAY, "trial");
    expect(days).toMatchObject({ index: 1, toWeek: W43 });
    // Nothing was booked by the choice.
    expect(b.freeMinutes(wc3, W43, TODAY)).toBe(h(40));
  });

  it("an alternative wins only in an EARLIER week than the base — a tie keeps the base", () => {
    // 110: 5 h left this week, so 10 h finishes in W44 (full: bare it is W43).
    // 120: 2 h left — also W44.
    const b = loadedBook([["wc-1", W43, 35], ["wc-2", W43, 38]]);
    expect(chooseResource(b, [cand(wc1, 10), cand(wc2, 10)], TODAY, "trial")).toMatchObject({
      index: 0,
      baseFull: true,
      baseToWeek: W44,
      toWeek: W44,
    });
  });

  it("a base beyond the horizon gives an alternative; all beyond the horizon gives the base", () => {
    const horizon = { horizonWeeks: 2 };
    const b = loadedBook([["wc-1", W43, 40], ["wc-1", W44, 40]], horizon);
    expect(chooseResource(b, [cand(wc1, 10), cand(wc2, 10)], TODAY, "trial")).toMatchObject({ index: 1, baseFull: true, baseToWeek: null, toWeek: W43 });
    const all = loadedBook([["wc-1", W43, 40], ["wc-1", W44, 40], ["wc-2", W43, 40], ["wc-2", W44, 40]], horizon);
    expect(chooseResource(all, [cand(wc1, 10), cand(wc2, 10)], TODAY, "trial")).toEqual({
      index: 0,
      baseFull: true,
      baseToWeek: null,
      toWeek: null,
      placement: null,
    });
  });

  it("never tries a resource without capacity or an inactive one, even when the base is full", () => {
    const b = loadedBook([["wc-1", W43, 40]]);
    // Only untried ones: the base without a trial, as without alternatives.
    expect(chooseResource(b, [cand(wc1, 10), cand(noCapacity, 10), cand(inactive, 10)], TODAY, "trial")).toMatchObject({ index: 0, placement: null });
    expect(chooseResource(b, [cand(wc1, 10), cand(noCapacity, 10), cand(inactive, 10), cand(wc3, 10)], TODAY, "trial")).toMatchObject({
      index: 3,
      toWeek: W43,
    });
  });

  it("tries each alternative with its own minutes — own times or som ordinarie", () => {
    // 120 has 10 h left this week.
    const b = loadedBook([["wc-1", W43, 40], ["wc-2", W43, 30]]);
    // Som ordinarie: the same 20 h as 110 — W44 on 120 too, no better than the base.
    expect(chooseResource(b, [cand(wc1, 20), cand(wc2, 20)], TODAY, "trial")).toMatchObject({ index: 0, baseToWeek: W44 });
    // Its own, shorter time: 8 h fits this week.
    expect(chooseResource(b, [cand(wc1, 20), cand(wc2, 8)], TODAY, "trial")).toMatchObject({ index: 1, toWeek: W43 });
  });

  it("compares the förslag's stored base without a trial on it, and the check's base by a trial with the load", () => {
    const b = loadedBook([]);
    // Stored: nothing loads 110 now, but the stored plan ends in W45 — later
    // than the bare W43, so it is full; unplanned (null) is full too.
    expect(chooseResource(b, [cand(wc1, 10), cand(wc2, 10)], TODAY, { stored: W45 })).toMatchObject({
      index: 1,
      baseFull: true,
      baseToWeek: W45,
      toWeek: W43,
      placement: { weeks: weeks([W43, 10]) },
    });
    expect(chooseResource(b, [cand(wc1, 10), cand(wc2, 10)], TODAY, { stored: null })).toMatchObject({ index: 1, baseToWeek: null, toWeek: W43 });
    expect(chooseResource(b, [cand(wc1, 10), cand(wc2, 10)], TODAY, { stored: W43 })).toEqual({
      index: 0,
      baseFull: false,
      baseToWeek: W43,
      toWeek: W43,
      placement: null,
    });
    // Trial: the same empty book — 110 is not full, so the base with its trial.
    expect(chooseResource(b, [cand(wc1, 10), cand(wc2, 10)], TODAY, "trial")).toMatchObject({
      index: 0,
      baseFull: false,
      baseToWeek: W43,
      placement: { weeks: weeks([W43, 10]) },
    });
  });

  it("compares from the floor: a later floor moves both the bare base and the alternatives", () => {
    const b = loadedBook([["wc-1", W44, 40]]);
    // From W44: 110 is full there (10 h → W45), 120 is free in W44.
    expect(chooseResource(b, [cand(wc1, 10), cand(wc2, 10)], W44, "trial")).toMatchObject({ index: 1, baseToWeek: W45, toWeek: W44 });
    // From today the base is not full: W43 is free.
    expect(chooseResource(b, [cand(wc1, 10), cand(wc2, 10)], TODAY, "trial")).toMatchObject({ index: 0, baseFull: false, baseToWeek: W43 });
  });
});
