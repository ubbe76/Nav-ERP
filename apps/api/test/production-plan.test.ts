import { describe, expect, it } from "vitest";
import {
  compareOrderPriority,
  planProduction,
  type PlanOperation,
  type PlanOrder,
  type PlanProductionInput,
  type PlanProductionResult,
} from "../src/modules/planning/service/production-plan.js";
import type { PlanWorkCenter } from "../src/modules/planning/service/capacity-book.js";
import type { CapacityOperationRow, PlannedWeek } from "../src/modules/planning/service/capacity-calc.js";

// Pure tests — no database. Monday 2026-10-19 is today; week 43 is Mon 19 –
// Sun 25, week 44 Mon 26 – Sun 1 Nov, week 45 Mon 2 Nov, week 46 Mon 9 Nov.
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
const lego: PlanWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Ytbehandling", type: "subcontract", weekScheduleId: null, leadTimeDays: 5 };
const noCalendar: PlanWorkCenter = { ...wc1, workCenterId: "wc-2", code: "200", weekScheduleId: null };
const wc3: PlanWorkCenter = { ...wc1, workCenterId: "wc-3", code: "120", name: "Svets" };

const h = (hours: number) => hours * 60;
const weeks = (...list: [string, number][]): PlannedWeek[] => list.map(([monday, hours]) => ({ monday, minutes: h(hours) }));

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
    schedule: {
      weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
      daySchedules: [{ id: "ds-480", netMinutes: 480 }],
      holidays: [],
    },
    ...partial,
  });
}

const plansOf = (r: PlanProductionResult) => r.plans.map((p) => [p.operationId, p.weeks] as const);

describe("Planera — priority and sequence", () => {
  it("plans TOs by due date ascending, null last, then order number; operations in sequence", () => {
    const result = plan({
      orders: [
        order("b", "TO-2", "2026-11-06", (o) => [pop(o, 10, 30)]),
        order("c", "TO-3", null, (o) => [pop(o, 10, 30)]),
        order("a", "TO-1", "2026-10-30", (o) => [pop(o, 20, 10), pop(o, 10, 20)]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", weeks([W43, 20])],
      ["a:20", weeks([W43, 10])],
      ["b:10", weeks([W43, 10], [W44, 20])],
      ["c:10", weeks([W44, 20], [W45, 10])],
    ]);
    expect(result.plans.map((p) => [p.startWeek, p.endWeek])).toEqual([[W43, W43], [W43, W43], [W43, W44], [W44, W45]]);
    expect(result.orders.map((o) => [o.orderNumber, o.plannedFinish, o.late])).toEqual([
      ["TO-1", "2026-10-23", false],
      ["TO-2", "2026-10-30", false],
      ["TO-3", "2026-11-06", false],
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

  it("the next operation may use what is left of the finishing week", () => {
    const result = plan({ orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 50), pop(o, 20, 10)])] });
    expect(plansOf(result)).toEqual([
      ["a:10", weeks([W43, 40], [W44, 10])],
      ["a:20", weeks([W44, 10])],
    ]);
  });

  it("other open operations are existing load — planned ones in their planned weeks", () => {
    const result = plan({
      existingOperations: [existing(40, "2026-10-21", { plannedWeeks: weeks([W44, 40]) })],
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 50)])],
    });
    // Week 43 is free (the existing load is planned in week 44), week 44 is full.
    expect(plansOf(result)).toEqual([["a:10", weeks([W43, 40], [W45, 10])]]);
  });
});

describe("Planera — locked, started, done", () => {
  it("a locked operation is existing load before anything is placed and is never replanned", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", "2026-10-23", (o) => [pop(o, 10, 30)]),
        order("b", "TO-2", "2026-12-18", (o) => [pop(o, 10, 30, { planLocked: true, plannedWeeks: weeks([W43, 30]) })]),
      ],
    });
    expect(plansOf(result)).toEqual([["a:10", weeks([W43, 10], [W44, 20])]]);
    expect(result.clear).toEqual([]);
    expect(result.warnings.map((w) => w.kind)).toEqual(["late"]);
  });

  it("a locked operation sets the floor for the operations after it", () => {
    const result = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 10, { planLocked: true, plannedWeeks: weeks([W45, 10]) }), pop(o, 20, 10)])],
    });
    expect(plansOf(result)).toEqual([["a:20", weeks([W45, 10])]]);
    expect(result.orders[0]!.plannedFinish).toBe("2026-11-06");
  });

  it("a locked operation starting before the previous one is done is a sequence break — a warning, never a block", () => {
    const result = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 70), pop(o, 20, 10, { planLocked: true, plannedWeeks: weeks([W43, 10]) })])],
    });
    // The locked 10 h in week 43 count first: Op 10 gets 30 h there + 40 h in week 44.
    expect(plansOf(result)).toEqual([["a:10", weeks([W43, 30], [W44, 40])]]);
    expect(result.warnings).toEqual([
      {
        kind: "sequence",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        sequenceNo: 20,
        workCenterCode: "110",
        message: "Op 20 på 110 är låst i veckan som börjar 2026-10-19, före föregående operation är klar (2026-10-30)",
      },
    ]);
  });

  it("a started operation is forced into the current week even when it is full", () => {
    const started = { orderQuantity: 10, setupTime: 0, runTimePerUnit: 60, quantityCompleted: 2, started: true };
    const result = plan({
      existingOperations: [existing(40, "2026-10-21")],
      orders: [
        order("a", "TO-1", "2026-10-23", (o) => [pop(o, 10, 0, started)]),
        order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 0, { ...started, quantityCompleted: null, started: false })]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", weeks([W43, 8])], // 8 left of 10, in the full week
      ["b:10", weeks([W44, 10])], // not started: the next free week
    ]);
  });

  it("done operations and 0-minute operations have their plans cleared and do not move the floor", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 10, { operationStatus: "done", plannedWeeks: weeks([W45, 10]) }),
          pop(o, 20, 0, { plannedWeeks: weeks([W45, 1]) }),
          pop(o, 30, 10, { operationStatus: "done" }), // no plan — nothing to clear
          pop(o, 40, 10),
        ]),
      ],
    });
    expect(result.clear).toEqual(["a:10", "a:20"]);
    expect(plansOf(result)).toEqual([["a:40", weeks([W43, 10])]]);
  });

  it("a locked operation with nothing left is ignored", () => {
    const result = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 10, { planLocked: true, plannedWeeks: weeks([W46, 10]), quantityCompleted: 1, quantityScrapped: 0 }), pop(o, 20, 10)])],
    });
    // Op 10 is complete (quantity 1 done) — Op 20 starts today, not after week 46.
    expect(plansOf(result)).toEqual([["a:20", weeks([W43, 10])]]);
  });
});

describe("Planera — lego, resources without calendar, horizon, Sen", () => {
  it("a lego operation takes its lead time and is never allocated", () => {
    const result = plan({
      orders: [order("a", "TO-1", "2026-10-28", (o) => [pop(o, 10, 4), pop(o, 20, 0, { workCenterId: "wc-l", plannedWeeks: weeks([W43, 1]) }), pop(o, 30, 4)])],
    });
    // Op 10 ready Friday 23, + 5 working days = Friday 30, Op 30 in week 44.
    expect(plansOf(result)).toEqual([
      ["a:10", weeks([W43, 4])],
      ["a:30", weeks([W44, 4])],
    ]);
    expect(result.clear).toEqual(["a:20"]);
    expect(result.orders[0]).toMatchObject({ plannedFinish: "2026-10-30", late: true });
  });

  it("Sen is the last pending operation's finish — a lego operation last in the route counts through its lead time", () => {
    const result = plan({
      orders: [order("a", "TO-1", "2026-10-28", (o) => [pop(o, 10, 4), pop(o, 20, 0, { workCenterId: "wc-l" })])],
    });
    expect(result.warnings).toEqual([
      {
        kind: "late",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        dueDate: "2026-10-28",
        plannedFinish: "2026-10-30",
        message: "TO-1 blir klar 2026-10-30, efter färdigdatumet 2026-10-28",
      },
    ]);
  });

  it("an undated TO is never late; a dated one finishing on its due date is not late", () => {
    const result = plan({
      orders: [
        order("a", "TO-1", null, (o) => [pop(o, 10, 50)]),
        order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 10)]),
      ],
    });
    expect(result.warnings).toEqual([]);
    expect(result.orders.map((o) => o.late)).toEqual([false, false]);
  });

  it("a resource without a calendar plans everything in one week with a warning per resource and TO", () => {
    const result = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 100, { workCenterId: "wc-2" }), pop(o, 20, 100, { workCenterId: "wc-2" })])],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", weeks([W43, 100])],
      ["a:20", weeks([W43, 100])],
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
  });

  it("the horizon leaves the operation and everything after it unplanned, what fit before stays", () => {
    const result = plan({
      horizonWeeks: 1,
      orders: [
        order("a", "TO-1", "2026-10-23", (o) => [
          pop(o, 10, 10),
          pop(o, 20, 50, { plannedWeeks: weeks([W43, 50]) }),
          pop(o, 30, 5, { plannedWeeks: weeks([W44, 5]) }),
          pop(o, 40, 5, { planLocked: true, plannedWeeks: weeks([W43, 5]) }), // locked: untouched
        ]),
        // Another TO on another resource is unaffected.
        order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 10, { workCenterId: "wc-3" })]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", weeks([W43, 10])],
      ["b:10", weeks([W43, 10])],
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
        order("a", "TO-1", "2026-10-23", (o) => [pop(o, 10, 10), pop(o, 20, 50)]),
        // Due later, so planned after TO-1: week 43 has 30 h left once
        // TO-1's partial 30 h of Op 20 are given back.
        order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 20)]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:10", weeks([W43, 10])],
      ["b:10", weeks([W43, 20])],
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
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 0, { setupTime: 0.0003, plannedWeeks: weeks([W43, 1]) }), pop(o, 20, 10)])],
    });
    expect(result.clear).toEqual(["a:10"]);
    expect(plansOf(result)).toEqual([["a:20", weeks([W43, 10])]]);
  });
});

describe("Planera — Flytta (forced start on one operation)", () => {
  it("places the moved operation in the chosen week and the following unlocked ones after it", () => {
    const result = plan({
      forceStart: { operationId: "a:20", weekMonday: W45 },
      orders: [
        order("a", "TO-1", null, (o) => [
          pop(o, 10, 10, { planLocked: true, plannedWeeks: weeks([W43, 10]) }),
          pop(o, 20, 10, { plannedWeeks: weeks([W43, 10]) }),
          pop(o, 30, 10, { plannedWeeks: weeks([W43, 10]) }),
        ]),
      ],
    });
    expect(plansOf(result)).toEqual([
      ["a:20", weeks([W45, 10])],
      ["a:30", weeks([W45, 10])],
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("moves a locked operation again, taking the week's whole capacity", () => {
    const result = plan({
      existingOperations: [existing(40, "2026-11-04")], // week 45 is full
      forceStart: { operationId: "a:10", weekMonday: W45 },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 50, { planLocked: true, plannedWeeks: weeks([W43, 50]) })])],
    });
    expect(plansOf(result)).toEqual([["a:10", weeks([W45, 40], [W46, 10])]]);
  });

  it("moving a later operation backwards is a sequence break", () => {
    const result = plan({
      forceStart: { operationId: "a:20", weekMonday: W43 },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 10, { planLocked: true, plannedWeeks: weeks([W44, 10]) }), pop(o, 20, 10)])],
    });
    expect(plansOf(result)).toEqual([["a:20", weeks([W43, 10])]]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "sequence", sequenceNo: 20, message: "Op 20 på 110 är flyttad i veckan som börjar 2026-10-19, före föregående operation är klar (2026-10-30)" }),
    ]);
  });

  it("moving forward without the following operations (passed as locked) is a sequence break on them", () => {
    const result = plan({
      forceStart: { operationId: "a:10", weekMonday: W46 },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 10), pop(o, 20, 10, { planLocked: true, plannedWeeks: weeks([W44, 10]) })])],
    });
    expect(plansOf(result)).toEqual([["a:10", weeks([W46, 10])]]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ kind: "sequence", sequenceNo: 20, message: "Op 20 på 110 är låst i veckan som börjar 2026-10-26, före föregående operation är klar (2026-11-13)" }),
    ]);
  });

  it("an operation kept where it is by a move (fixed, not locked) says so in the sequence-break text", () => {
    const result = plan({
      forceStart: { operationId: "a:10", weekMonday: W46 },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 10), pop(o, 20, 10, { fixed: true, plannedWeeks: weeks([W44, 10]) })])],
    });
    // Kept as fixed load: not replanned, not cleared.
    expect(plansOf(result)).toEqual([["a:10", weeks([W46, 10])]]);
    expect(result.clear).toEqual([]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        kind: "sequence",
        sequenceNo: 20,
        message: "Op 20 på 110 är planerad och ligger fast i veckan som börjar 2026-10-26, före föregående operation är klar (2026-11-13)",
      }),
    ]);
  });

  it("a started later operation forced into the current week before the previous one is done is a sequence break", () => {
    const started = { orderQuantity: 10, setupTime: 0, runTimePerUnit: 60, quantityCompleted: 2, started: true };
    // Planera: Op 10 (50 h) finishes in week 44, Op 20 is under way and
    // starts this week regardless.
    const planned = plan({
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 50), pop(o, 20, 0, started)])],
    });
    expect(plansOf(planned)).toEqual([
      ["a:10", weeks([W43, 40], [W44, 10])],
      ["a:20", weeks([W43, 8])],
    ]);
    expect(planned.warnings).toEqual([
      {
        kind: "sequence",
        manufacturingOrderId: "a",
        orderNumber: "TO-1",
        sequenceNo: 20,
        workCenterCode: "110",
        message: "Op 20 på 110 är påbörjad i veckan som börjar 2026-10-19, före föregående operation är klar (2026-10-30)",
      },
    ]);
    // Flytta Op 10 to week 45 with the started Op 20 following: same break.
    const moved = plan({
      forceStart: { operationId: "a:10", weekMonday: W45 },
      orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 10), pop(o, 20, 0, started)])],
    });
    expect(plansOf(moved)).toEqual([
      ["a:10", weeks([W45, 10])],
      ["a:20", weeks([W43, 8])],
    ]);
    expect(moved.warnings).toEqual([expect.objectContaining({ kind: "sequence", sequenceNo: 20 })]);
    // In the same week as the previous one finishes: no break.
    const same = plan({ orders: [order("a", "TO-1", null, (o) => [pop(o, 10, 10), pop(o, 20, 0, started)])] });
    expect(same.warnings).toEqual([]);
  });
});

describe("Planera — determinism", () => {
  const orders = () => [
    order("c", "TO-3", "2026-11-13", (o) => [pop(o, 10, 20), pop(o, 20, 0, { workCenterId: "wc-l" }), pop(o, 30, 15)]),
    order("a", "TO-1", "2026-10-30", (o) => [pop(o, 10, 25, { planLocked: true, plannedWeeks: weeks([W44, 25]) }), pop(o, 20, 10)]),
    order("d", "TO-4", null, (o) => [pop(o, 10, 60, { workCenterId: "wc-2" }), pop(o, 20, 30)]),
    order("b", "TO-2", "2026-10-30", (o) => [pop(o, 10, 35, { orderQuantity: 10, setupTime: 0, runTimePerUnit: 210, quantityCompleted: 4, started: true })]),
  ];

  it("two runs on the same input give the same plan", () => {
    expect(plan({ orders: orders() })).toEqual(plan({ orders: orders() }));
  });

  it("a run on its own output gives the same plan again", () => {
    const first = plan({ orders: orders() });
    const planned = new Map(first.plans.map((p) => [p.operationId, p.weeks]));
    const cleared = new Set(first.clear);
    const replanned = orders().map((o) => ({
      ...o,
      operations: o.operations.map((op) =>
        planned.has(op.moOperationId)
          ? { ...op, plannedWeeks: planned.get(op.moOperationId)!, plannedAt: "2026-10-19T08:00:00.000Z" }
          : cleared.has(op.moOperationId)
            ? { ...op, plannedWeeks: null }
            : op
      ),
    }));
    const second = plan({ orders: replanned });
    expect(second.plans).toEqual(first.plans);
    expect(second.warnings).toEqual(first.warnings);
    expect(second.orders).toEqual(first.orders);
    expect(second.clear).toEqual([]); // nothing left to clear
  });
});
