import { describe, expect, it } from "vitest";
import {
  createCapacityBook,
  PLAN_HORIZON_WEEKS,
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
    expect(b.weekFinishDay(wc1, W43, "2026-10-24")).toBe("2026-10-24"); // floor after the last working day
  });

  it("the capacity factor scales the week", () => {
    const doubled: PlanWorkCenter = { ...wc1, capacityFactor: 2 };
    expect(book().weekCapacity(doubled, W44)).toBe(h(80));
    expect(book().place(doubled, h(60), { floor: TODAY })).toMatchObject({ weeks: weeks([W43, 60]) });
  });
});
