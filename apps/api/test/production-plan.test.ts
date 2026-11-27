import { describe, expect, it } from "vitest";
import {
  compareOrderPriority,
  longOperationWarnings,
  operationsWithPlan,
  planProduction,
  type PlanOperation,
  type PlanOrder,
  type PlanProductionInput,
  type PlanProductionResult,
} from "../src/modules/planning/service/production-plan.js";
import type { PlanWorkCenter } from "../src/modules/planning/service/capacity-book.js";
import { orderPlanStatus, type CapacityOperationRow, type PlannedDay } from "../src/modules/planning/service/capacity-calc.js";
import { manufacturingLeadDays, type LeadTimeResource, type LeadTimeWork } from "../src/modules/planning/service/manufacturing-lead-time.js";
import { addDays, addWorkingDays, isWorkingDay } from "../src/modules/system/service/delivery-days.js";

// Pure tests — no database. Monday 2026-10-19 is today unless a test says
// otherwise; the plan counts per DAY (#18). 110 and 120 work Mon–Fri, 8 h.
const TODAY = "2026-10-19";
const MON = "2026-10-19";
const TUE = "2026-10-20";
const WED = "2026-10-21";
const THU = "2026-10-22";
const FRI = "2026-10-23";
const SAT = "2026-10-24";
const MON2 = "2026-10-26";
const TUE2 = "2026-10-27";
const WED2 = "2026-10-28";
const THU2 = "2026-10-29";
const MON3 = "2026-11-02";

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
const lego: PlanWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Ytbehandling", type: "subcontract", weekScheduleId: null, leadTimeDays: 5 };
const noCalendar: PlanWorkCenter = { ...wc1, workCenterId: "wc-2", code: "200", weekScheduleId: null };
const wc3: PlanWorkCenter = { ...wc1, workCenterId: "wc-3", code: "120", name: "Svets" };

const h = (hours: number) => hours * 60;
const days = (...list: [string, number][]): PlannedDay[] => list.map(([date, hours]) => ({ date, minutes: h(hours) }));

// An operation of `hours` (as setup, nothing reported) on wc-1.
function pop(order: PlanOrder | { id: string; orderNumber: string; dueDate: string | null }, sequenceNo: number, hours: number, extra: Partial<PlanOperation> = {}): PlanOperation {
  return {
    moOperationId: `${order.id}:${sequenceNo}`,
    manufacturingOrderId: order.id,
    orderNumber: order.orderNumber,
    articleNumber: "ART",
    articleName: "Artikel",
    workCenterId: "wc-1",
    orderQuantity: 1,
    dueDate: order.dueDate,
    sequenceNo,
    setupTime: h(hours),
    runTimePerUnit: 0,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
    started: false,
    ...extra,
  };
}

function order(id: string, orderNumber: string, dueDate: string | null, ops: (o: PlanOrder) => PlanOperation[]): PlanOrder {
  const o: PlanOrder = { id, orderNumber, dueDate, operations: [] };
  o.operations = ops(o);
  return o;
}

function existing(hours: number, dueDate: string | null, extra: Partial<CapacityOperationRow> = {}): CapacityOperationRow {
  return { ...pop({ id: "mo-x", orderNumber: "TO-X", dueDate }, 10, hours), ...extra };
}

const SCHEDULE: PlanProductionInput["schedule"] = {
  weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
  daySchedules: [{ id: "ds-480", netMinutes: 480 }],
  holidays: [],
};

function plan(partial: Partial<PlanProductionInput> & { orders: PlanOrder[] }): PlanProductionResult {
  return planProduction({
    today: TODAY,
    offDays: new Set(),
    workCenters: new Map([
      ["wc-1", wc1],
      ["wc-l", lego],
      ["wc-2", noCalendar],
      ["wc-3", wc3],
    ]),
    schedule: SCHEDULE,
    queueDays: 0,
    ...partial,
  });
}

const plansOf = (r: PlanProductionResult) => r.plans.map((p) => [p.operationId, p.days] as const);
// One short operation per sequence number: where each one starts.
const startsOf = (r: PlanProductionResult) => r.plans.map((p) => [p.operationId, p.startDate] as const);

describe("Planera — priority and sequence", () => {
  it("plans TOs by due date ascending, null last, then order number; operations in sequence", () => {
    const result = plan({
      orders: [
        order("b", "TO-2", "2026-11-06", (o) => [pop(o, 10, 12)]),
        order("c", "TO-3", null, (o) => [pop(o, 10, 12)]),
        order("a", "TO-1", "2026-10-30", (o) => [pop(o, 20, 4), pop(o, 10, 12)]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", days([MON, 8], [TUE, 4])],
      ["a:20", days([WED, 4])], // the working day after Op 10 is ready
      ["b:10", days([TUE, 4], [WED, 4], [THU, 4])],
      ["c:10", days([THU, 4], [FRI, 8])],
    ]);
    expect(result.plans.map((p) => [p.startDate, p.endDate])).toEqual([[MON, TUE], [WED, WED], [TUE, THU], [THU, FRI]]);
    // Ready the day the last minute is placed — not the week's last day.
    expect(result.orders.map((o) => [o.orderNumber, o.plannedFinish, o.late])).toEqual([
      ["TO-1", WED, false],
      ["TO-2", THU, false],
      ["TO-3", FRI, false],
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.clear).toEqual([]);
  });

  it("compareOrderPriority never ties", () => {
    const a = order("a", "TO-1", null, () => []);
    const b = order("b", "TO-1", null, () => []);
    expect(compareOrderPriority(a, b)).toBeLessThan(0);
    expect(compareOrderPriority(order("x", "TO-9", "2026-10-20", () => []), order("y", "TO-1", null, () => []))).toBeLessThan(0);
  });

  it("the next operation starts the working day after the previous one is ready — never the same day", () => {
    const result = plan({ orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 12), pop(o, 20, 2), pop(o, 30, 24), pop(o, 40, 1)])] });
    expect(plansOf(result)).toEqual([
      ["a:10", days([MON, 8], [TUE, 4])],
      ["a:20", days([WED, 2])], // Tuesday has 4 h free, but Op 10 is ready that day
      ["a:30", days([THU, 8], [FRI, 8], [MON2, 8])],
      ["a:40", days([TUE2, 1])],
    ]);
    // Ready on a Friday ⇒ Monday.
    const friday = plan({ orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 40), pop(o, 20, 1)])] });
    expect(startsOf(friday)).toEqual([["a:10", MON], ["a:20", MON2]]);
  });

  it("the Standardkötid is waited between the operations, rounded up on the accumulated sum", () => {
    const four = () => [order("a", "TO-1", null, (o) => [pop(o, 10, 1), pop(o, 20, 1), pop(o, 30, 1), pop(o, 40, 1)])];
    expect(startsOf(plan({ orders: four() }))).toEqual([["a:10", MON], ["a:20", TUE], ["a:30", WED], ["a:40", THU]]);
    expect(startsOf(plan({ orders: four(), queueDays: 1 }))).toEqual([["a:10", MON], ["a:20", WED], ["a:30", FRI], ["a:40", TUE2]]);
    // 0.5: the gaps are 1, 0, 1 days — two days in all, as the lead time counts them.
    expect(startsOf(plan({ orders: four(), queueDays: 0.5 }))).toEqual([["a:10", MON], ["a:20", WED], ["a:30", THU], ["a:40", MON2]]);
    expect(startsOf(plan({ orders: four(), queueDays: 1.5 }))).toEqual([["a:10", MON], ["a:20", THU], ["a:30", MON2], ["a:40", THU2]]);
  });

  it("the gap is counted in the company's working days; the resource's own calendar decides from the floor", () => {
    const two = () => [order("a", "TO-1", null, (o) => [pop(o, 10, 1), pop(o, 20, 1)])];
    // A company holiday on Tuesday (the resource would work): the floor is Wednesday.
    expect(startsOf(plan({ orders: two(), offDays: new Set([TUE]) }))).toEqual([["a:10", MON], ["a:20", WED]]);
    // The resource is off Tuesday and Wednesday (its own calendar) though the
    // company works: the floor is Tuesday, the first capacity Thursday.
    const closed = { ...SCHEDULE, holidays: [{ date: TUE, dayScheduleId: null }, { date: WED, dayScheduleId: null }] };
    expect(startsOf(plan({ orders: two(), schedule: closed }))).toEqual([["a:10", MON], ["a:20", THU]]);
  });

  it("the gap index counts only operations that take a place: done and 0-minute ones are not gaps", () => {
    // With a queue of 0.5 the FIRST gap waits a day and the second none. If
    // the done Op 10 or the empty Op 30 counted, Op 20 would wait and the
    // days would shift.
    const result = plan({
      queueDays: 0.5,
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 1, { operationStatus: "done" }),
          pop(o, 20, 1),
          pop(o, 30, 0),
          pop(o, 40, 1),
          pop(o, 50, 1),
        ]),
      ],
    });
    expect(startsOf(result)).toEqual([["a:20", MON], ["a:40", WED], ["a:50", THU]]);
  });

  it("other open operations are existing load — planned ones on their planned days", () => {
    const result = plan({
      existingOperations: [existing(8, WED, { plannedDays: days([TUE, 8]) })],
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 12)])],
    });
    // Monday is free (the existing load is planned on Tuesday), Tuesday is full.
    expect(plansOf(result)).toEqual([["a:10", days([MON, 8], [WED, 4])]]);
  });

  it("mid-week and on a Friday: today is a whole day, the weekend is jumped", () => {
    const orders = () => [order("a", "TO-1", null, (o) => [pop(o, 10, 12), pop(o, 20, 1)])];
    expect(plansOf(plan({ today: WED, orders: orders() }))).toEqual([
      ["a:10", days([WED, 8], [THU, 4])],
      ["a:20", days([FRI, 1])],
    ]);
    const friday = plan({ today: FRI, orders: orders() });
    expect(plansOf(friday)).toEqual([
      ["a:10", days([FRI, 8], [MON2, 4])],
      ["a:20", days([TUE2, 1])],
    ]);
    expect(friday.orders[0]!.plannedFinish).toBe(TUE2);
    // One short operation on a Friday is ready that Friday.
    expect(plan({ today: FRI, orders: [order("a", "TO-1", FRI, (o) => [pop(o, 10, 1)])] }).orders[0]).toMatchObject({ plannedFinish: FRI, late: false });
  });
});

describe("Planera — locked, started, done", () => {
  it("a locked operation is existing load before anything is placed and is never replanned", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", TUE, (o) => [pop(o, 10, 12)]),
        order("b", "TO-2", "2026-12-18", (o) => [pop(o, 10, 6, { planLocked: true, plannedDays: days([MON, 6]) })]),
      ],
    });
    expect(plansOf(result)).toEqual([["a:10", days([MON, 2], [TUE, 8], [WED, 2])]]);
    expect(result.clear).toEqual([]);
    expect(result.warnings.map((w) => w.kind)).toEqual(["late"]);
  });

  it("after a locked operation the floor counts from its stored last day", () => {
    const locked = (queueDays: number, planned: PlannedDay[]) =>
      plan({
        queueDays,
        orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 12, { planLocked: true, plannedDays: planned }), pop(o, 20, 4)])],
      });
    const result = locked(0, days([WED, 8], [THU, 4]));
    expect(plansOf(result)).toEqual([["a:20", days([FRI, 4])]]);
    expect(result.orders[0]!.plannedFinish).toBe(FRI);
    expect(plansOf(locked(1, days([WED, 8], [THU, 4])))).toEqual([["a:20", days([MON2, 4])]]);
    // Locked on days that have passed: its load lies on today (and rolls on), the next one follows.
    expect(startsOf(locked(0, days(["2026-10-15", 8], ["2026-10-16", 4])))).toEqual([["a:20", TUE]]);
  });

  it("a locked operation starting before the previous one is ready is a sequence break — a warning, never a block", () => {
    const result = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 12), pop(o, 20, 2, { planLocked: true, plannedDays: days([MON, 2]) })])],
    });
    // The locked 2 h on Monday count first: Op 10 gets 6 h there + 6 h on Tuesday.
    expect(plansOf(result)).toEqual([["a:10", days([MON, 6], [TUE, 6])]]);
    expect(result.warnings).toEqual([
      {
        kind: "sequence",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        sequenceNo: 20,
        workCenterCode: "110",
        message: "Op 20 på 110 är låst på 2026-10-19, före föregående operation är klar (2026-10-20)",
      },
    ]);
  });

  it("a break is only BEFORE the previous one is ready — a start inside the queue time is none (S13)", () => {
    const lockedOn = (date: string) =>
      plan({
        queueDays: 2,
        orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4), pop(o, 20, 2, { planLocked: true, plannedDays: days([date, 2]) })])],
      }).warnings;
    // Op 10 is ready Monday; with the queue the floor would be Thursday.
    expect(lockedOn(TUE)).toEqual([]); // inside the queue: a choice, not an error
    expect(lockedOn(THU)).toEqual([]);
    expect(lockedOn(MON).map((w) => w.kind)).toEqual(["sequence"]); // the same day is before it is ready
  });

  it("a started operation is forced to today even when the day is full", () => {
    const started = { orderQuantity: 10, setupTime: 0, runTimePerUnit: 60, quantityCompleted: 2, started: true };
    const result = plan({
      existingOperations: [existing(8, MON)],
      orders: [
        order("a", "TO-1", "2026-10-23", (o) => [pop(o, 10, 0, started)]),
        order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 0, { ...started, quantityCompleted: null, started: false })]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", days([MON, 8])], // 8 left of 10, on the full day
      ["b:10", days([TUE, 8], [WED, 2])], // not started: the next free day
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("started on a Saturday: the first day with capacity takes it, and a started operation is today whatever the chain says", () => {
    const started = { orderQuantity: 10, setupTime: 0, runTimePerUnit: 60, quantityCompleted: 2, started: true };
    const weekend = plan({
      today: SAT,
      existingOperations: [existing(8, MON2, { plannedDays: days([MON2, 8]) })],
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 0, started)])],
    });
    expect(plansOf(weekend)).toEqual([["a:10", days([MON2, 8])]]);
    // Mid-week, the previous operation done: from today, no warning.
    const midweek = plan({
      today: WED,
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 1, { operationStatus: "done" }), pop(o, 20, 0, started), pop(o, 30, 1)])],
    });
    expect(plansOf(midweek)).toEqual([
      ["a:20", days([WED, 8])],
      ["a:30", days([THU, 1])],
    ]);
    expect(midweek.warnings).toEqual([]);
  });

  it("done operations and 0-minute operations have their plans cleared and do not move the floor", () => {
    const result = plan({
      queueDays: 1,
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 10, { operationStatus: "done", plannedDays: days([THU, 10]) }),
          pop(o, 20, 0, { plannedDays: days([THU, 1]) }),
          pop(o, 30, 10, { operationStatus: "done" }), // no plan — nothing to clear
          pop(o, 40, 4),
        ]),
      ],
    });
    expect(result.clear).toEqual(["a:10", "a:20"]);
    expect(plansOf(result)).toEqual([["a:40", days([MON, 4])]]);
  });

  it("a locked operation with nothing left is ignored", () => {
    const result = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 10, { planLocked: true, plannedDays: days([MON3, 10]), quantityCompleted: 1, quantityScrapped: 0 }), pop(o, 20, 4)])],
    });
    // Op 10 is complete (quantity 1 done) — Op 20 starts today, not after 2 November.
    expect(plansOf(result)).toEqual([["a:20", days([MON, 4])]]);
  });
});

describe("Planera — lego, resources without calendar, horizon, Sen", () => {
  it("a lego operation is sent the working day after the previous one, takes its lead time and is never allocated", () => {
    const result = plan({
      orders: [order("a", "TO-1", TUE2, (o) => [pop(o, 10, 4), pop(o, 20, 0, { workCenterId: "wc-l", plannedDays: days([MON, 1]) }), pop(o, 30, 4)])],
    });
    // Op 10 ready Monday, sent Tuesday + 5 working days = Tuesday 27, Op 30 the day after.
    expect(plansOf(result)).toEqual([
      ["a:10", days([MON, 4])],
      ["a:30", days([WED2, 4])],
    ]);
    expect(result.clear).toEqual(["a:20"]);
    expect(result.orders[0]).toMatchObject({ plannedFinish: WED2, late: true });
  });

  it("a lego operation takes Ledtid + Kötid, rounded up — and the Standardkötid around it like any operation", () => {
    const slow: PlanWorkCenter = { ...lego, leadTimeDays: 2, queueTimeDays: 1.5 }; // 4 working days
    const run = (queueDays: number) =>
      plan({
        queueDays,
        workCenters: new Map([["wc-1", wc1], ["wc-l", slow]]),
        orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4), pop(o, 20, 0, { workCenterId: "wc-l" }), pop(o, 30, 4)])],
      });
    // Sent Tuesday, back Monday 26, Op 30 on Tuesday 27.
    expect(plansOf(run(0))).toEqual([["a:10", days([MON, 4])], ["a:30", days([TUE2, 4])]]);
    // Queue 1: sent Wednesday, back Tuesday 27, Op 30 on Thursday 29.
    expect(plansOf(run(1))).toEqual([["a:10", days([MON, 4])], ["a:30", days([THU2, 4])]]);
    // First in the route: sent today, no gap before it.
    const first = plan({
      workCenters: new Map([["wc-1", wc1], ["wc-l", slow]]),
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 0, { workCenterId: "wc-l" }), pop(o, 20, 4)])],
    });
    expect(plansOf(first)).toEqual([["a:20", days([MON2, 4])]]);
  });

  it("lego first on a day off (Saturday, Sunday, a röd dag): sent the next working day — one klar-dag for Planera, orderPlanStatus and Leveranstidskontrollen", () => {
    const three: PlanWorkCenter = { ...lego, leadTimeDays: 3 };
    const workCenters = new Map([["wc-1", wc1], ["wc-l", three]]);
    const route = (o: PlanOrder) => [pop(o, 10, 0, { workCenterId: "wc-l" }), pop(o, 20, 4)];
    const statusOf = (today: string, offDays: ReadonlySet<string>, operations: CapacityOperationRow[]) =>
      orderPlanStatus(operations, { today, offDays, workCenters, queueDays: 0 });
    // Saturday 24, Sunday 25 and Monday 26 all send it Monday 26: back
    // Thursday 29 (not Wednesday 28 — Monday is the day it is sent, not day
    // 1 of the lead time), Op 20 on Friday 30.
    for (const today of [SAT, "2026-10-25", MON2]) {
      const result = plan({ today, workCenters, orders: [order("a", "TO-1", null, route)] });
      expect(plansOf(result), today).toEqual([["a:20", days(["2026-10-30", 4])]]);
      const legoOnly = plan({ today, workCenters, orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 0, { workCenterId: "wc-l" })])] });
      expect(legoOnly.orders[0]!.plannedFinish, today).toBe(THU2);
      // Sen reads the same day, with and without the planned operation after it.
      const o = order("a", "TO-1", null, route);
      expect(statusOf(today, new Set(), [o.operations[0]!]).plannedFinish, today).toBe(THU2);
      const planned = operationsWithPlan(o.operations, result);
      expect(statusOf(today, new Set(), planned), today).toMatchObject({ planned: true, plannedFinish: "2026-10-30" });
    }
    // A röd dag today (Monday 19): sent Tuesday, back Friday.
    const offDays = new Set([MON]);
    const holiday = plan({
      offDays,
      schedule: { ...SCHEDULE, holidays: [{ date: MON, dayScheduleId: null }] },
      workCenters,
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 0, { workCenterId: "wc-l" })])],
    });
    expect(holiday.orders[0]!.plannedFinish).toBe(FRI);
    expect(statusOf(MON, offDays, [pop({ id: "a", orderNumber: "TO-1", dueDate: null }, 10, 0, { workCenterId: "wc-l" })]).plannedFinish).toBe(FRI);
  });

  it("Sen: a lego operation last in the route counts through its lead time", () => {
    const result = plan({
      orders: [order("a", "TO-1", FRI, (o) => [pop(o, 10, 4), pop(o, 20, 0, { workCenterId: "wc-l" })])],
    });
    expect(result.warnings).toEqual([
      {
        kind: "late",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        dueDate: FRI,
        plannedFinish: TUE2,
        message: "TO-1 blir klar 2026-10-27, efter färdigdatumet 2026-10-23",
      },
    ]);
  });

  it("an undated TO is never late; a dated one ready ON its due date is not late", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", null, (o) => [pop(o, 10, 12)]),
        order("b", "TO-2", MON, (o) => [pop(o, 10, 4)]),
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.orders.map((o) => [o.orderNumber, o.plannedFinish, o.late])).toEqual([
      ["TO-2", MON, false],
      ["TO-1", TUE, false],
    ]);
    // The day after the due date is late.
    expect(plan({ orders: [order("b", "TO-2", MON, (o) => [pop(o, 10, 12)])] }).orders[0]).toMatchObject({ plannedFinish: TUE, late: true });
  });

  it("a resource without a calendar plans each operation on one working day, with a warning per resource and TO", () => {
    const result = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 100, { workCenterId: "wc-2" }), pop(o, 20, 100, { workCenterId: "wc-2" })])],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", days([MON, 100])],
      ["a:20", days([TUE, 100])],
    ]);
    expect(result.warnings).toEqual([
      {
        kind: "unscheduled_resource",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        sequenceNo: 10,
        workCenterCode: "200",
        message: "Resurs 200 saknar veckoschema och timmar per dag — Op 10 är planerad utan kapacitetsgräns",
      },
    ]);
    // Never "ready on a Saturday": today a Saturday ⇒ Monday.
    const weekend = plan({ today: SAT, orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 5, { workCenterId: "wc-2" })])] });
    expect(weekend.orders[0]!.plannedFinish).toBe(MON2);
  });

  it("the horizon leaves the operation and everything after it unplanned, what fit before stays", () => {
    const result = plan({
      horizonWeeks: 1,
      orders: [
        order("a", "TO-1", "2026-10-23", (o) => [
          pop(o, 10, 4),
          pop(o, 20, 50, { plannedDays: days([MON, 50]) }),
          pop(o, 30, 5, { plannedDays: days([MON2, 5]) }),
          pop(o, 40, 5, { planLocked: true, plannedDays: days([MON, 5]) }), // locked: untouched
        ]),
        // Another TO on another resource is unaffected.
        order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 4, { workCenterId: "wc-3" })]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", days([MON, 3], [TUE, 1])],
      ["b:10", days([MON, 4])],
    ]);
    expect(result.clear).toEqual(["a:20", "a:30"]);
    expect(result.warnings).toEqual([
      {
        kind: "horizon",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        sequenceNo: 20,
        workCenterCode: "110",
        message: "Kapaciteten räcker inte inom två år — Op 20 på 110 och efterföljande operationer är inte planerade",
      },
    ]);
    // No Sen for a TO without a finish whose due date is still ahead.
    expect(result.orders[0]).toMatchObject({ plannedFinish: null, late: false });
  });

  it("the horizon releases the partial bookings — a later TO in the same run may use that capacity", () => {
    const result = plan({
      horizonWeeks: 1,
      orders: [
        order("a", "TO-1", "2026-10-23", (o) => [pop(o, 10, 4), pop(o, 20, 50)]),
        // Due later, so planned after TO-1: the days Op 20 booked before the
        // horizon (Tue–Fri) are given back.
        order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 20)]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", days([MON, 4])],
      ["b:10", days([MON, 4], [TUE, 8], [WED, 8])],
    ]);
    expect(result.warnings.map((w) => [w.kind, w.orderNumber])).toEqual([["horizon", "TO-1"]]);
  });

  it("a TO that hit the horizon is Sen when its due date has passed — as the matrix says", () => {
    const result = plan({
      horizonWeeks: 1,
      orders: [order("a", "TO-1", "2026-10-16", (o) => [pop(o, 10, 50)])],
    });
    expect(result.plans).toEqual([]);
    expect(result.orders[0]).toEqual({ manufacturingOrderId: "a", orderNumber: "TO-1", dueDate: "2026-10-16", plannedFinish: null, late: true });
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "horizon", sequenceNo: 10 }),
      {
        kind: "late",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        dueDate: "2026-10-16",
        plannedFinish: null,
        message: "TO-1 är inte planerad och färdigdatumet 2026-10-16 har passerat",
      },
    ]);
  });

  it("an operation with less than a hundredth of a minute left is cleared, never planned", () => {
    const result = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 0, { setupTime: 0.0003, plannedDays: days([MON, 1]) }), pop(o, 20, 4)])],
    });
    expect(result.clear).toEqual(["a:10"]);
    expect(plansOf(result)).toEqual([["a:20", days([MON, 4])]]);
  });
});

describe("Planera — Flytta (forced start on one operation)", () => {
  it("places the moved operation on the chosen day and the following unlocked ones after it", () => {
    const result = plan({
      forceStart: { operationId: "a:20", date: THU },
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 4, { planLocked: true, plannedDays: days([MON, 4]) }),
          pop(o, 20, 4, { plannedDays: days([TUE, 4]) }),
          pop(o, 30, 4, { plannedDays: days([WED, 4]) }),
        ]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:20", days([THU, 4])],
      ["a:30", days([FRI, 4])],
    ]);
    expect(result.plans[0]).toMatchObject({ startDate: THU, endDate: THU });
    expect(result.warnings).toEqual([]);
  });

  it("moves a locked operation again, taking the day's whole capacity, then free capacity", () => {
    const result = plan({
      existingOperations: [existing(12, THU)], // Thursday is full, Friday has 4 h left
      forceStart: { operationId: "a:10", date: THU },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 14, { planLocked: true, plannedDays: days([MON, 8], [TUE, 6]) })])],
    });
    expect(plansOf(result)).toEqual([["a:10", days([THU, 8], [FRI, 4], [MON2, 2])]]);
  });

  it("a day without capacity is not taken: the plan starts later, and the service refuses on startDate ≠ the chosen day", () => {
    const moved = (date: string, extra: Partial<PlanProductionInput> = {}) =>
      plan({ forceStart: { operationId: "a:10", date }, orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4)])], ...extra }).plans[0]!.startDate;
    expect(moved(THU)).toBe(THU);
    expect(moved(SAT)).toBe(MON2); // a weekend
    expect(moved(WED, { schedule: { ...SCHEDULE, holidays: [{ date: WED, dayScheduleId: null }] } })).toBe(THU); // a röd dag
    // A resource without a calendar: not a working day.
    const unscheduled = plan({
      offDays: new Set([WED]),
      forceStart: { operationId: "a:10", date: WED },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4, { workCenterId: "wc-2" })])],
    });
    expect(unscheduled.plans[0]!.startDate).toBe(THU);
  });

  it("moving a later operation to before the previous one is ready is a sequence break", () => {
    const result = plan({
      forceStart: { operationId: "a:20", date: MON },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4, { planLocked: true, plannedDays: days([TUE, 4]) }), pop(o, 20, 4)])],
    });
    expect(plansOf(result)).toEqual([["a:20", days([MON, 4])]]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "sequence", sequenceNo: 20, message: "Op 20 på 110 är flyttad till 2026-10-19, före föregående operation är klar (2026-10-20)" }),
    ]);
  });

  it("moving into the queue time is no break; onto the previous operation's ready day is (S13)", () => {
    const moved = (date: string) =>
      plan({
        queueDays: 2,
        forceStart: { operationId: "a:20", date },
        orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4, { planLocked: true, plannedDays: days([TUE, 4]) }), pop(o, 20, 4)])],
      });
    expect(moved(WED).warnings).toEqual([]);
    expect(plansOf(moved(WED))).toEqual([["a:20", days([WED, 4])]]);
    expect(moved(TUE).warnings).toEqual([
      expect.objectContaining({ message: "Op 20 på 110 är flyttad till 2026-10-20, före föregående operation är klar (2026-10-20)" }),
    ]);
  });

  it("moving forward without the following operations (passed as locked) is a sequence break on them", () => {
    const result = plan({
      forceStart: { operationId: "a:10", date: THU },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4), pop(o, 20, 4, { planLocked: true, plannedDays: days([TUE, 4]) })])],
    });
    expect(plansOf(result)).toEqual([["a:10", days([THU, 4])]]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "sequence", sequenceNo: 20, message: "Op 20 på 110 är låst på 2026-10-20, före föregående operation är klar (2026-10-22)" }),
    ]);
  });

  it("an operation kept where it is by a move (fixed, not locked) says so in the sequence-break text", () => {
    const result = plan({
      forceStart: { operationId: "a:10", date: THU },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4), pop(o, 20, 4, { fixed: true, plannedDays: days([TUE, 4]) })])],
    });
    // Kept as fixed load: not replanned, not cleared.
    expect(plansOf(result)).toEqual([["a:10", days([THU, 4])]]);
    expect(result.clear).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        kind: "sequence",
        sequenceNo: 20,
        message: "Op 20 på 110 är planerad och ligger fast på 2026-10-20, före föregående operation är klar (2026-10-22)",
      }),
    ]);
  });

  it("a started later operation forced to today before the previous one is ready is a sequence break", () => {
    const started = { orderQuantity: 10, setupTime: 0, runTimePerUnit: 60, quantityCompleted: 2, started: true };
    // Planera: Op 10 (12 h) is ready Tuesday, Op 20 is under way and starts
    // today regardless — on the day's whole capacity.
    const planned = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 12), pop(o, 20, 0, started)])],
    });
    expect(plansOf(planned)).toEqual([
      ["a:10", days([MON, 8], [TUE, 4])],
      ["a:20", days([MON, 8])],
    ]);
    expect(planned.warnings).toEqual([
      {
        kind: "sequence",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        sequenceNo: 20,
        workCenterCode: "110",
        message: "Op 20 på 110 är påbörjad och planerad från 2026-10-19, före föregående operation är klar (2026-10-20)",
      },
    ]);
    // Flytta Op 10 to Thursday with the started Op 20 following: same break.
    const moved = plan({
      forceStart: { operationId: "a:10", date: THU },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 4), pop(o, 20, 0, started)])],
    });
    expect(plansOf(moved)).toEqual([
      ["a:10", days([THU, 4])],
      ["a:20", days([MON, 8])],
    ]);
    expect(moved.warnings).toEqual([expect.objectContaining({ kind: "sequence", sequenceNo: 20 })]);
    // The operation after the started one follows the LATEST ready day of the chain.
    const after = plan({ orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 12), pop(o, 20, 0, started), pop(o, 30, 1)])] });
    expect(startsOf(after)).toEqual([["a:10", MON], ["a:20", MON], ["a:30", WED]]);
  });
});

describe("Planera — earliestStart (materialet är klart, Planera om strukturen)", () => {
  // A fixture with everything the engine does: priority, the chain with a
  // queue, a locked and a started operation, done and 0-minute ones, lego,
  // a resource without calendar and existing load.
  const fixture = (earliestStart?: string | null): Partial<PlanProductionInput> & { orders: PlanOrder[] } => {
    const withFloor = (o: PlanOrder): PlanOrder => (earliestStart === undefined ? o : { ...o, earliestStart });
    return {
      queueDays: 0.5,
      existingOperations: [existing(6, TUE, { plannedDays: days([TUE, 6]) }), existing(8, THU)],
      orders: [
        order("a", "TO-1", FRI, (o) => [
          pop(o, 10, 4, { operationStatus: "done", plannedDays: days([MON, 4]) }),
          pop(o, 20, 12),
          pop(o, 30, 0),
          pop(o, 40, 0, { workCenterId: "wc-l" }),
          pop(o, 50, 6),
        ]),
        order("b", "TO-2", null, (o) => [
          pop(o, 10, 5, { started: true }),
          pop(o, 20, 3, { planLocked: true, plannedDays: days([WED2, 3]) }),
          pop(o, 30, 2, { workCenterId: "wc-2" }),
        ]),
        order("c", "TO-3", "2026-10-21", (o) => [pop(o, 10, 9, { workCenterId: "wc-3" }), pop(o, 20, 2)]),
      ].map(withFloor),
    };
  };

  it("left out, null, today or a day before today: the same result as before on the whole fixture", () => {
    const before = plan(fixture());
    expect(before.plans.length).toBeGreaterThan(4);
    for (const earliestStart of [null, TODAY, "2026-10-12"]) {
      expect(plan(fixture(earliestStart)), String(earliestStart)).toEqual(before);
    }
  });

  it("the first operation may start ON the day, never before it; the next ones follow the chain", () => {
    const route = (o: PlanOrder) => [pop(o, 10, 4), pop(o, 20, 4), pop(o, 30, 4, { workCenterId: "wc-3" })];
    const result = plan({ orders: [{ ...order("a", "TO-1", null, route), earliestStart: WED }] });
    expect(plansOf(result)).toEqual([
      ["a:10", days([WED, 4])],
      ["a:20", days([THU, 4])],
      ["a:30", days([FRI, 4])],
    ]);
    expect(result.orders[0]!.plannedFinish).toBe(FRI);
    expect(result.warnings).toEqual([]);
    // With the Standardkötid the gaps count from the floor's chain as from today's.
    const queued = plan({ queueDays: 1, orders: [{ ...order("a", "TO-1", null, route), earliestStart: WED }] });
    expect(startsOf(queued)).toEqual([["a:10", WED], ["a:20", FRI], ["a:30", TUE2]]);
  });

  it("the first day with capacity from the floor: a full day and a weekend are jumped", () => {
    const one = (o: PlanOrder) => [pop(o, 10, 4)];
    const full = plan({
      existingOperations: [existing(8, null, { plannedDays: days([WED, 8]) })],
      orders: [{ ...order("a", "TO-1", null, one), earliestStart: WED }],
    });
    expect(plansOf(full)).toEqual([["a:10", days([THU, 4])]]);
    const weekend = plan({ orders: [{ ...order("a", "TO-1", null, one), earliestStart: SAT }] });
    expect(plansOf(weekend)).toEqual([["a:10", days([MON2, 4])]]);
  });

  it("only the order that has it waits — the other is planned from today, and takes the capacity first by priority", () => {
    const result = plan({
      orders: [
        { ...order("a", "TO-1", "2026-10-20", (o) => [pop(o, 10, 6)]), earliestStart: TUE },
        order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 12)]),
      ],
    });
    // a (first by due date) books Tuesday 6 h; b fills Monday and what is left.
    expect(plansOf(result)).toEqual([
      ["a:10", days([TUE, 6])],
      ["b:10", days([MON, 8], [TUE, 2], [WED, 2])],
    ]);
  });

  it("a started operation is forced to today all the same; the operation after it follows the chain", () => {
    const result = plan({
      orders: [
        {
          ...order("a", "TO-1", null, (o) => [pop(o, 10, 4, { started: true }), pop(o, 20, 4)]),
          earliestStart: THU,
        },
      ],
    });
    // The chain's ready day starts on the floor (operationChain: the latest
    // ready day so far), so Op 20 waits for the material AND the gap after
    // it — the working day after Thursday, as after any ready day.
    expect(plansOf(result)).toEqual([
      ["a:10", days([MON, 4])],
      ["a:20", days([FRI, 4])],
    ]);
    // Nothing went before it in the chain: no sequence break.
    expect(result.warnings).toEqual([]);
  });

  it("a locked first operation keeps its days before the floor; the next one counts from it", () => {
    const result = plan({
      orders: [
        {
          ...order("a", "TO-1", null, (o) => [pop(o, 10, 4, { planLocked: true, plannedDays: days([MON, 4]) }), pop(o, 20, 4)]),
          earliestStart: THU,
        },
      ],
    });
    expect(plansOf(result)).toEqual([["a:20", days([FRI, 4])]]);
    expect(result.orders[0]!.plannedFinish).toBe(FRI);
  });

  it("lego first counts from the floor — also on a day off — and the finish day counts it", () => {
    const route = (o: PlanOrder) => [pop(o, 10, 0, { workCenterId: "wc-l" }), pop(o, 20, 4)];
    // Sent Wednesday 21, back five working days later (Wednesday 28), Op 20 the day after.
    const weekday = plan({ orders: [{ ...order("a", "TO-1", null, route), earliestStart: WED }] });
    expect(plansOf(weekday)).toEqual([["a:20", days([THU2, 4])]]);
    // Saturday 24: sent Monday 26, back Monday 2 November.
    const saturday = plan({ orders: [{ ...order("a", "TO-1", null, route), earliestStart: SAT }] });
    expect(plansOf(saturday)).toEqual([["a:20", days(["2026-11-03", 4])]]);
    const legoOnly = plan({
      orders: [{ ...order("a", "TO-1", MON2, (o) => [pop(o, 10, 0, { workCenterId: "wc-l" })]), earliestStart: SAT }],
    });
    expect(legoOnly.orders[0]).toMatchObject({ plannedFinish: MON3, late: true });
  });

  it("a hand move (forceStart) wins over the floor; what follows still waits for the material", () => {
    const result = plan({
      forceStart: { operationId: "a:10", date: TUE },
      orders: [{ ...order("a", "TO-1", null, (o) => [pop(o, 10, 4), pop(o, 20, 4)]), earliestStart: THU }],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", days([TUE, 4])],
      ["a:20", days([FRI, 4])],
    ]);
  });
});

describe("Planera — determinism", () => {
  const orders = () => [
    order("c", "TO-3", "2026-11-13", (o) => [pop(o, 10, 20), pop(o, 20, 0, { workCenterId: "wc-l" }), pop(o, 30, 15)]),
    order("a", "TO-1", "2026-10-30", (o) => [pop(o, 10, 25, { planLocked: true, plannedDays: days([MON2, 8], [TUE2, 8], [WED2, 8], [THU2, 1]) }), pop(o, 20, 10)]),
    order("d", "TO-4", null, (o) => [pop(o, 10, 60, { workCenterId: "wc-2" }), pop(o, 20, 30)]),
    order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 35, { orderQuantity: 10, setupTime: 0, runTimePerUnit: 210, quantityCompleted: 4, started: true })]),
    order("e", "TO-5", "2026-11-20", (o) => [pop(o, 10, 3.3333), pop(o, 20, 0.0001), pop(o, 30, 7.7777), pop(o, 40, 13)]),
  ];

  it("two runs on the same input give the same plan", () => {
    expect(plan({ orders: orders(), queueDays: 0.5 })).toEqual(plan({ orders: orders(), queueDays: 0.5 }));
  });

  it.each([0, 0.5, 1])("a run on its own output gives the same plan again (queue %s)", (queueDays) => {
    const first = plan({ orders: orders(), queueDays });
    // The operations as the writer leaves them (rounded, cleared).
    const replanned = orders().map((o) => ({
      ...o,
      operations: operationsWithPlan(o.operations, first).map((op, i) => ({ ...op, started: o.operations[i]!.started })),
    }));
    const second = plan({ orders: replanned, queueDays });
    expect(second.plans).toEqual(first.plans);
    expect(second.warnings).toEqual(first.warnings);
    expect(second.orders).toEqual(first.orders);
    expect(second.clear).toEqual([]); // nothing left to clear
    // …and as existing load for another run the plan is where it was placed:
    // a new TO finds exactly the days the first run left free.
    const fresh = () => [order("z", "TO-9", null, (o) => [pop(o, 10, 6)])];
    const asLoad = replanned.flatMap((o) => o.operations.map((op) => ({ ...op, planLocked: true })));
    // (Days compared: the stored load is rounded to hundredths of a minute.)
    const daysOfZ = (r: PlanProductionResult) => r.plans.filter((p) => p.manufacturingOrderId === "z").map((p) => p.days.map((d) => d.date));
    expect(daysOfZ(plan({ orders: fresh(), existingOperations: asLoad, queueDays }))).toEqual(
      daysOfZ(plan({ orders: [...replanned, ...fresh()], queueDays }))
    );
  });
});

// Beslut 2 of #18: the plan and the lead time count alike. On an empty
// resource with 8 h a day, a TO started on S is ready no later than S + its
// lead time in working days — whatever the route, the queue time and the
// holidays. (Without it a TO started on its latest start would be Sen.)
describe("bok = ledtid — Planera never finishes later than the lead time says", () => {
  const own: LeadTimeResource = { type: "machine", hoursPerDay: 8, leadTimeDays: null, queueTimeDays: null };
  let seed = 18;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;

  function scenario(legoShare: number) {
    // A random working day as S, with a few holidays after it (röd dag for
    // the resource and the company alike).
    let start = addDays("2030-01-07", Math.floor(random() * 200));
    const holidays: string[] = [];
    for (let i = 0; i < 4; i++) holidays.push(addDays(start, 1 + Math.floor(random() * 25)));
    const offDays = new Set(holidays);
    while (!isWorkingDay(start, offDays)) start = addDays(start, 1);
    const queueDays = pick([0, 0, 0.3, 0.5, 1, 1.5, 2]);
    // Several suppliers: no lead time at all, whole and decimal Ledtid/Kötid.
    const suppliers: PlanWorkCenter[] = [0, 1, 2].map((i) => ({
      ...lego,
      workCenterId: `wc-l${i}`,
      code: `90${i}`,
      leadTimeDays: pick([null, 0, 0.5, 1, 2.5, 4]),
      queueTimeDays: pick([null, 0, 0.2, 0.5, 1]),
    }));
    const n = 1 + Math.floor(random() * 7);
    const o = order("a", "TO-1", null, () => []);
    const work: LeadTimeWork[] = [];
    let legoCount = 0;
    for (let i = 0; i < n; i++) {
      const done = random() < 0.15;
      if (random() < legoShare) {
        const supplier = pick(suppliers);
        if (!done) legoCount += 1;
        o.operations.push(pop(o, (i + 1) * 10, 0, { workCenterId: supplier.workCenterId, operationStatus: done ? "done" : "pending" }));
        work.push({
          minutes: 0,
          resource: { type: "subcontract", hoursPerDay: null, leadTimeDays: supplier.leadTimeDays, queueTimeDays: supplier.queueTimeDays },
          done,
        });
        continue;
      }
      const kind = random();
      const minutes = kind < 0.15 ? 0 : kind < 0.5 ? 1 + Math.floor(random() * 479) : 1 + Math.floor(random() * 2400);
      o.operations.push(pop(o, (i + 1) * 10, 0, { setupTime: minutes, operationStatus: done ? "done" : "pending" }));
      work.push({ minutes: done ? 0 : minutes, resource: own, done });
    }
    const result = plan({
      today: start,
      offDays,
      queueDays,
      workCenters: new Map<string, PlanWorkCenter>([["wc-1", wc1], ...suppliers.map((w) => [w.workCenterId, w] as [string, PlanWorkCenter])]),
      schedule: { ...SCHEDULE, holidays: holidays.map((date) => ({ date, dayScheduleId: null })) },
      orders: [o],
    });
    const leadDays = manufacturingLeadDays(null, work, { defaultLeadDays: 0, queueDays });
    return { start, offDays, leadDays, legoCount, finish: result.orders[0]!.plannedFinish!, result };
  }

  // The same relation for every route: ready exactly on S + lead time − 1
  // working days — the day before the lead time is up, so a TO started on
  // its latest start (due − lead time) is ready the working day before due.
  function holds(legoShare: number, runs: number): number {
    let legoRoutes = 0;
    for (let run = 0; run < runs; run++) {
      const { start, offDays, leadDays, legoCount, finish, result } = scenario(legoShare);
      if (legoCount >= 2) legoRoutes += 1;
      expect(result.warnings.filter((w) => w.kind !== "long_operation")).toEqual([]);
      expect(finish <= addWorkingDays(start, leadDays, offDays)).toBe(true);
      expect(finish).toBe(addWorkingDays(start, Math.max(0, leadDays - 1), offDays));
    }
    return legoRoutes;
  }

  it("own operations only", () => {
    holds(0, 400);
  });

  it("with lego operations in the route — several of them, L = 0 and decimal Ledtid/Kötid included", () => {
    // A lego operation counts 1 + ceil(L + Q) in the lead time: the day it
    // is sent and the days until it is back.
    expect(holds(0.4, 600)).toBeGreaterThan(100);
    expect(holds(1, 200)).toBeGreaterThan(100); // nothing but lego
  });
});

describe("Planera — orimligt mycket tid", () => {
  it("warns for an operation over four normal weeks of its resource, with the routing values", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 0, { setupTime: 30, runTimePerUnit: 102, orderQuantity: 100 }), // 170,5 h on a 40 h week
          pop(o, 20, 160, { workCenterId: "wc-3" }), // exactly four weeks: within reason
        ]),
      ],
    });
    expect(result.warnings).toEqual([
      {
        kind: "long_operation",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        sequenceNo: 10,
        workCenterCode: "110",
        remainingHours: 170.5,
        message:
          "Op 10 på 110 (ART Artikel) har orimligt mycket tid: 170,5 h kvar, motsvarar 4,3 veckors kapacitet på resursen (40 h/vecka); " +
          "ställtid 30 min, stycktid 102 min/st, antal 100 st — kontrollera operationens tider och orderns antal",
      },
    ]);
    // Planned anyway.
    expect(result.plans.map((p) => p.operationId)).toEqual(["a:10", "a:20"]);
  });

  it("measures remaining time — reported quantity and a consumed setup count off", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 0, { setupTime: 600, runTimePerUnit: 102, orderQuantity: 100, quantityCompleted: 10, started: true }),
        ]),
      ],
    });
    expect(result.warnings).toEqual([]); // 90 × 102 min = 153 h
  });

  it("a holiday week does not lower the bar, the capacity factor does", () => {
    const holidays = [{ date: "2026-11-03", dayScheduleId: null }];
    const half: PlanWorkCenter = { ...wc3, capacityFactor: 0.5 };
    const result = plan({
      schedule: {
        weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
        daySchedules: [{ id: "ds-480", netMinutes: 480 }],
        holidays,
      },
      workCenters: new Map([
        ["wc-1", wc1],
        ["wc-3", half],
      ]),
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 150), pop(o, 20, 90, { workCenterId: "wc-3" })])],
    });
    expect(result.warnings.map((w) => [w.kind, w.sequenceNo, w.remainingHours])).toEqual([["long_operation", 20, 90]]);
    expect(result.warnings[0]!.message).toContain("motsvarar 4,5 veckors kapacitet på resursen (20 h/vecka)");
  });

  it("a resource without a calendar is measured against a 40-hour week; lego is never checked", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 200, { workCenterId: "wc-2" }),
          pop(o, 20, 500, { workCenterId: "wc-l" }),
        ]),
      ],
    });
    expect(result.warnings.map((w) => w.kind)).toEqual(["long_operation", "unscheduled_resource"]);
    expect(result.warnings[0]!.message).toContain("200 h kvar, motsvarar 5 veckor à 40 h — resursen saknar kapacitet;");
  });

  it("comes before the horizon warning it causes, and covers locked operations", () => {
    const result = plan({
      horizonWeeks: 2,
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 200),
          pop(o, 20, 170, { workCenterId: "wc-3", planLocked: true, plannedDays: days([MON, 40], [MON2, 40], [MON3, 40], ["2026-11-09", 50]) }),
        ]),
      ],
    });
    expect(result.warnings.map((w) => [w.kind, w.sequenceNo])).toEqual([
      ["long_operation", 10],
      ["horizon", 10],
      ["long_operation", 20],
    ]);
  });

  it("takes its limit from longOperationWeeks — decimals allowed, 0 turns it off", () => {
    const orders = [order("a", "TO-1", null, (o) => [pop(o, 10, 70)])];
    expect(plan({ orders }).warnings).toEqual([]);
    expect(plan({ orders, longOperationWeeks: 1.5 }).warnings.map((w) => [w.kind, w.remainingHours])).toEqual([["long_operation", 70]]);
    expect(plan({ orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 3000)])], longOperationWeeks: 0 }).warnings).toEqual([]);
  });

  it("longOperationWarnings checks without planning — done and lego operations skipped", () => {
    const warnings = longOperationWarnings({
      today: TODAY,
      offDays: new Set(),
      workCenters: new Map([
        ["wc-1", wc1],
        ["wc-l", lego],
      ]),
      schedule: {
        weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
        daySchedules: [{ id: "ds-480", netMinutes: 480 }],
        holidays: [],
      },
      longOperationWeeks: 1,
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 50, { operationStatus: "done" }),
          pop(o, 20, 50, { workCenterId: "wc-l" }),
          pop(o, 30, 50),
        ]),
      ],
    });
    expect(warnings.map((w) => [w.kind, w.orderNumber, w.sequenceNo])).toEqual([["long_operation", "TO-1", 30]]);
  });
});

// Alternativa resurser (#15, beslut 1): the engine places on the resource the
// operation has — a free alternative changes nothing. The förslag are
// resource-suggestions.ts's business.
describe("Planera — alternativa resurser", () => {
  it("plans an operation with alternatives on its current resource, even when an alternative is free", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 4, {
            resources: [
              { workCenterId: "wc-1", rank: 0, setupTime: h(4), runTimePerUnit: 0 },
              { workCenterId: "wc-3", rank: 1, setupTime: h(1), runTimePerUnit: 0 },
            ],
          }),
        ]),
      ],
      // wc-1 is full today; wc-3 (the alternative) is empty.
      existingOperations: [existing(8, MON)],
    });
    expect(plansOf(result)).toEqual([["a:10", days([TUE, 4])]]);
  });

  it("operationsWithPlan gives the operations as the writer leaves them: rounded days, cleared without days or lock", () => {
    const a = pop({ id: "a", orderNumber: "TO-1", dueDate: null }, 10, 1, { plannedDays: days([MON, 1]) });
    const b = pop({ id: "a", orderNumber: "TO-1", dueDate: null }, 20, 1, { plannedDays: days([MON, 1]), planLocked: true });
    const c = pop({ id: "a", orderNumber: "TO-1", dueDate: null }, 30, 1, { plannedDays: days([WED, 1]) });
    const out = operationsWithPlan([a, b, c], {
      plans: [{ operationId: a.moOperationId, manufacturingOrderId: "a", days: [{ date: TUE, minutes: 59.996 }], startDate: TUE, endDate: TUE }],
      clear: [b.moOperationId],
    });
    expect(out.map((op) => [op.moOperationId, op.plannedDays, op.planLocked ?? false])).toEqual([
      ["a:10", [{ date: TUE, minutes: 60 }], false],
      ["a:20", null, false],
      ["a:30", days([WED, 1]), false],
    ]);
  });
});
