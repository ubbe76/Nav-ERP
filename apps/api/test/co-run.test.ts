import { describe, expect, it } from "vitest";
import { coRunOrder, groupRunPlanByMaterial, planCoRun } from "../src/modules/planning/service/co-run.js";
import {
  operationsWithPlan,
  planOperationMove,
  type MoveWorld,
} from "../src/modules/planning/service/production-plan.js";
import type { PlanWorkCenter } from "../src/modules/planning/service/capacity-book.js";
import {
  plannedDateRange,
  type CapacityOperationRow,
  type PlannedDay,
} from "../src/modules/planning/service/capacity-calc.js";
import {
  buildRunPlan,
  type RunPlanMaterial,
  type RunPlanOperationMaterials,
  type RunPlanPlannedOperation,
} from "../src/modules/planning/service/run-plan.js";

// Samkörning (pure) — no database. Monday 2026-10-19 is today; 110 and 120
// work Mon–Fri, 8 h. Every move is Flytta's rule (planOperationMove): the
// tests here are about the walk — one world, the pre-pass, the union.
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
const wc3: PlanWorkCenter = { ...wc1, workCenterId: "wc-3", code: "120", name: "Svets" };

const h = (hours: number) => hours * 60;
const days = (...list: [string, number][]): PlannedDay[] => list.map(([date, hours]) => ({ date, minutes: h(hours) }));

// An operation of `hours` (as setup, nothing reported) on wc-1; the id is
// "<order>:<sequence>".
function op(orderId: string, sequenceNo: number, hours: number, extra: Partial<CapacityOperationRow> = {}): CapacityOperationRow {
  return {
    moOperationId: `${orderId}:${sequenceNo}`,
    manufacturingOrderId: orderId,
    orderNumber: `TO-${orderId.toUpperCase()}`,
    articleNumber: "ART",
    articleName: "Artikel",
    workCenterId: "wc-1",
    orderQuantity: 1,
    dueDate: null,
    sequenceNo,
    setupTime: h(hours),
    runTimePerUnit: 0,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
    ...extra,
  };
}

function world(operations: CapacityOperationRow[], over: Partial<MoveWorld> = {}): MoveWorld {
  return {
    today: TODAY,
    offDays: new Set(),
    workCenters: new Map([
      ["wc-1", wc1],
      ["wc-3", wc3],
    ]),
    schedule: {
      weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
      daySchedules: [{ id: "ds-480", netMinutes: 480 }],
      holidays: [],
    },
    queueDays: 0,
    longOperationWeeks: 0,
    operations,
  };
}

const NONE: ReadonlySet<string> = new Set();
const daysOf = (plan: { plans: { operationId: string; days: PlannedDay[] }[] }, id: string) =>
  plan.plans.find((p) => p.operationId === id)?.days;
const after = (plan: { operationsAfter: CapacityOperationRow[] }, id: string) =>
  plan.operationsAfter.find((o) => o.moOperationId === id)!;

describe("planCoRun — one world", () => {
  it("the second move sees the first: its days after the forced one differ from an independent move", () => {
    const a = op("a", 10, 12, { plannedDays: days([MON2, 8], [TUE2, 4]) });
    const b = op("b", 10, 16, { plannedDays: days([WED2, 8], ["2026-10-29", 8]) });
    const w = world([a, b]);

    const plan = planCoRun(w, NONE, { date: WED, operationIds: ["a:10", "b:10"] });
    expect(plan.noCapacity).toBe(false);
    expect(daysOf(plan, "a:10")).toEqual(days([WED, 8], [THU, 4]));
    // b takes the whole of its forced day (overload), then what a left.
    expect(daysOf(plan, "b:10")).toEqual(days([WED, 8], [THU, 4], [FRI, 4]));

    // Moved on its own, b would have had Thursday to itself …
    const independent = planOperationMove(w, NONE, { operationId: "b:10", date: WED, moveFollowing: true });
    expect(daysOf(independent, "b:10")).toEqual(days([WED, 8], [THU, 8]));
    // … and the co-run's b is exactly Flytta's rule on the world after a.
    const first = planOperationMove(w, NONE, { operationId: "a:10", date: WED, moveFollowing: true });
    const worldAfterA = { ...w, operations: operationsWithPlan(w.operations, first).map((o) => (o.moOperationId === "a:10" ? { ...o, planLocked: true } : o)) };
    const second = planOperationMove(worldAfterA, NONE, { operationId: "b:10", date: WED, moveFollowing: true });
    expect(daysOf(plan, "b:10")).toEqual(daysOf(second, "b:10"));

    expect([...plan.outcomes]).toEqual([
      ["a:10", "moved"],
      ["b:10", "moved"],
    ]);
    expect(plan.lockIds).toEqual(["a:10", "b:10"]);
    expect(plan.clear).toEqual([]);
    // The world afterwards: both on the day, both locked — and the input untouched.
    expect(plannedDateRange(after(plan, "a:10"))).toEqual({ start: WED, end: THU });
    expect(plannedDateRange(after(plan, "b:10"))).toEqual({ start: WED, end: FRI });
    expect(after(plan, "a:10").planLocked).toBe(true);
    expect(after(plan, "b:10").planLocked).toBe(true);
    expect(w.operations).toEqual([a, b]);
    expect(a.planLocked).toBeUndefined();
  });

  it("the order given is the order walked", () => {
    const a = op("a", 10, 12);
    const b = op("b", 10, 16);
    const plan = planCoRun(world([a, b]), NONE, { date: WED, operationIds: ["b:10", "a:10"] });
    expect(daysOf(plan, "b:10")).toEqual(days([WED, 8], [THU, 8]));
    expect(daysOf(plan, "a:10")).toEqual(days([WED, 8], [FRI, 4]));
    expect(plan.lockIds).toEqual(["b:10", "a:10"]);
  });
});

describe("planCoRun — förpasset", () => {
  it("an operation already on the day is not planned again, is locked in the world, and an earlier operation of its order does not move it", () => {
    const first = op("x", 10, 4, { plannedDays: days([MON, 4]) });
    const onDay = op("x", 20, 4, { plannedDays: days([WED, 4]), runPosition: 2 });
    const other = op("y", 10, 4, { plannedDays: days([TUE, 4]) });
    const w = world([first, onDay, other]);

    // Selected LAST, and still fixed for the moves before it.
    const plan = planCoRun(w, NONE, { date: WED, operationIds: ["x:10", "y:10", "x:20"] });
    expect(plan.outcomes.get("x:20")).toBe("already_on_day");
    expect(plan.outcomes.get("x:10")).toBe("moved");
    expect(plan.plans.map((p) => p.operationId).sort()).toEqual(["x:10", "y:10"]);
    expect(plan.clear).toEqual([]);
    expect(after(plan, "x:20")).toEqual({ ...onDay, planLocked: true });
    expect(plan.lockIds).toEqual(["x:10", "y:10", "x:20"]);
    // Two of the same order on one day: the locked one breaks the sequence.
    expect(plan.warnings.filter((x) => x.kind === "sequence").map((x) => [x.orderNumber, x.sequenceNo])).toEqual([["TO-X", 20]]);
    expect(plan.warnings.find((x) => x.kind === "sequence")!.message).toContain(`låst på ${WED}`);

    // Not selected, the same operation follows the moved one (Flytta's moveFollowing).
    const without = planCoRun(w, NONE, { date: WED, operationIds: ["x:10", "y:10"] });
    expect(daysOf(without, "x:20")).toEqual(days([THU, 4]));
    expect(without.lockIds).toEqual(["x:10", "y:10"]);
    expect(after(without, "x:20").planLocked).toBeFalsy();
  });

  it("only the plan's START day counts as on the day", () => {
    const spans = op("a", 10, 12, { plannedDays: days([TUE, 8], [WED, 4]) });
    const b = op("b", 10, 2);
    const plan = planCoRun(world([spans, b]), NONE, { date: WED, operationIds: ["a:10", "b:10"] });
    expect(plan.outcomes.get("a:10")).toBe("moved");
    expect(daysOf(plan, "a:10")![0]!.date).toBe(WED);
  });
});

describe("planCoRun — what falls out of Flytta's rule", () => {
  it("two selected from the same order: the second is forced to the same day, with a sequence warning", () => {
    const plan = planCoRun(world([op("x", 10, 2), op("x", 20, 2), op("y", 10, 2)]), NONE, {
      date: WED,
      operationIds: ["x:10", "x:20"],
    });
    expect(daysOf(plan, "x:10")).toEqual(days([WED, 2]));
    expect(daysOf(plan, "x:20")).toEqual(days([WED, 2]));
    expect(plan.lockIds).toEqual(["x:10", "x:20"]);
    const sequence = plan.warnings.filter((x) => x.kind === "sequence");
    expect(sequence).toHaveLength(1);
    expect(sequence[0]).toMatchObject({ manufacturingOrderId: "x", sequenceNo: 20 });
    expect(sequence[0]!.message).toBe(`Op 20 på 110 är flyttad till ${WED}, före föregående operation är klar (${WED})`);
  });

  it("the following operations follow, a locked one stays, and other orders are only load", () => {
    const ops = [
      op("x", 10, 4, { plannedDays: days([MON, 4]) }),
      op("x", 20, 4, { plannedDays: days([TUE, 4]), workCenterId: "wc-3" }),
      op("x", 30, 4, { plannedDays: days([MON2, 4]), planLocked: true, workCenterId: "wc-3" }),
      op("y", 10, 4, { plannedDays: days([MON, 4]) }),
      op("z", 10, 4, { plannedDays: days([TUE, 4]) }),
    ];
    const plan = planCoRun(world(ops), NONE, { date: FRI, operationIds: ["x:10", "y:10"] });
    expect(daysOf(plan, "x:10")).toEqual(days([FRI, 4]));
    expect(daysOf(plan, "y:10")).toEqual(days([FRI, 4]));
    // x:20 follows from the working day after the new finish; x:30 is locked.
    expect(daysOf(plan, "x:20")).toEqual(days([MON2, 4]));
    expect(daysOf(plan, "x:30")).toBeUndefined();
    expect(daysOf(plan, "z:10")).toBeUndefined();
    expect(plan.clear).toEqual([]);
    expect(after(plan, "x:30")).toEqual(ops[2]);
    expect(after(plan, "z:10")).toEqual(ops[4]);
    // Only the selected are locked — the follower is not.
    expect(plan.lockIds).toEqual(["x:10", "y:10"]);
    expect(after(plan, "x:20").planLocked).toBeFalsy();
    expect([...plan.outcomes.keys()]).toEqual(["x:10", "y:10"]);
  });

  it("a started operation is forced to the chosen day, not to today", () => {
    // a: one of four reported (3 h left); b: an open stamp session.
    const reported = op("a", 10, 0, { orderQuantity: 4, runTimePerUnit: 60, quantityCompleted: 1 });
    const ops = [reported, op("b", 10, 4)];
    const plan = planCoRun(world(ops), new Set(["b:10"]), { date: THU, operationIds: ["a:10", "b:10"] });
    expect(daysOf(plan, "a:10")).toEqual(days([THU, 3]));
    expect(daysOf(plan, "b:10")).toEqual(days([THU, 4]));
  });
});

describe("planCoRun — ingen kapacitet och horisonten", () => {
  it("a day without capacity aborts: noCapacity, no plans, no locks, the world as it was", () => {
    const ops = [op("a", 10, 4, { plannedDays: days([MON, 4]) }), op("b", 10, 4)];
    const saturday = planCoRun(world(ops), NONE, { date: SAT, operationIds: ["a:10", "b:10"] });
    expect(saturday).toEqual({
      plans: [],
      clear: [],
      lockIds: [],
      outcomes: new Map(),
      noCapacity: true,
      warnings: [],
      operationsAfter: ops,
    });

    // A röd dag, and an operation already on it is no excuse: nothing is
    // planned, nothing locked.
    const onRed = op("c", 10, 4, { plannedDays: days([WED, 4]) });
    const red = world([...ops, onRed], { offDays: new Set([WED]) });
    red.schedule = { ...red.schedule, holidays: [{ date: WED, dayScheduleId: null }] };
    const plan = planCoRun(red, NONE, { date: WED, operationIds: ["c:10", "a:10", "b:10"] });
    expect(plan.noCapacity).toBe(true);
    expect(plan.plans).toEqual([]);
    expect(plan.clear).toEqual([]);
    expect(plan.lockIds).toEqual([]);
    expect(plan.outcomes.size).toBe(0);
    expect(plan.operationsAfter).toEqual([...ops, onRed]);
  });

  it("beyond the horizon: not_placed, cleared, never in lockIds — the others are still moved", () => {
    const ops = [
      op("a", 10, 4),
      // More than two years of the resource's capacity.
      op("huge", 10, 5000, { plannedDays: days([MON, 8]), planLocked: true }),
      op("b", 10, 4),
    ];
    const plan = planCoRun(world(ops), NONE, { date: WED, operationIds: ["a:10", "huge:10", "b:10"] });
    expect(plan.noCapacity).toBe(false);
    expect([...plan.outcomes]).toEqual([
      ["a:10", "moved"],
      ["huge:10", "not_placed"],
      ["b:10", "moved"],
    ]);
    expect(plan.lockIds).toEqual(["a:10", "b:10"]);
    expect(plan.plans.map((p) => p.operationId)).toEqual(["a:10", "b:10"]);
    expect(plan.clear).toEqual(["huge:10"]);
    expect(after(plan, "huge:10")).toMatchObject({ plannedDays: null, planLocked: false });
    expect(plan.warnings.map((x) => [x.kind, x.manufacturingOrderId])).toEqual([["horizon", "huge"]]);
    // What it booked before the horizon is given back: b has the day.
    expect(daysOf(plan, "b:10")).toEqual(days([WED, 4]));
  });
});

describe("planCoRun — varningarna", () => {
  it("per order the LAST run's warnings — another order's are kept", () => {
    const ops = [
      op("x", 10, 2, { dueDate: TUE }),
      op("x", 20, 2, { dueDate: TUE }),
      op("y", 10, 2, { dueDate: MON }),
    ];
    const w = world(ops);
    // After the first move alone, TO-X is late once.
    const one = planCoRun(w, NONE, { date: WED, operationIds: ["x:10", "y:10"] });
    expect(one.warnings.map((x) => [x.kind, x.manufacturingOrderId])).toEqual([
      ["late", "x"],
      ["late", "y"],
    ]);

    const plan = planCoRun(w, NONE, { date: WED, operationIds: ["x:10", "y:10", "x:20"] });
    // TO-Y's from its own run; TO-X's only from the run of x:20 (the late
    // warning once, with the finish that run gave).
    expect(plan.warnings.map((x) => [x.kind, x.manufacturingOrderId])).toEqual([
      ["late", "y"],
      ["sequence", "x"],
      ["late", "x"],
    ]);
    expect(plan.warnings.find((x) => x.kind === "late" && x.manufacturingOrderId === "x")).toMatchObject({
      dueDate: TUE,
      plannedFinish: WED,
    });
    expect(one.warnings.find((x) => x.manufacturingOrderId === "x")).toMatchObject({ plannedFinish: THU });
  });
});

describe("coRunOrder", () => {
  it("the ordered ones that are not selected first, in place order, then the block as selected", () => {
    const current = [
      { id: "c", runPosition: 3 },
      { id: "sel-2", runPosition: 1 },
      { id: "a", runPosition: 2 },
      { id: "sel-1", runPosition: null },
      { id: "loose", runPosition: null },
    ];
    expect(coRunOrder(current, ["sel-1", "sel-2"])).toEqual(["a", "c", "sel-1", "sel-2"]);
  });

  it("a selected operation that is not on the day (not placed) gets no place; unordered others are left out", () => {
    expect(coRunOrder([{ id: "s1", runPosition: null }, { id: "loose", runPosition: null }], ["s1", "gone"])).toEqual(["s1"]);
    expect(coRunOrder([], ["s1"])).toEqual([]);
  });
});

describe("groupRunPlanByMaterial", () => {
  const material = (over: Partial<RunPlanMaterial> = {}): RunPlanMaterial => ({
    articleId: "m-2",
    articleNumber: "PLÅT-2",
    articleName: "Plåt 2 mm",
    unit: "st",
    remainingQuantity: 4,
    usableOnHand: 10,
    status: "available",
    missingQuantity: 0,
    supply: null,
    ...over,
  });
  const plate10 = (over: Partial<RunPlanMaterial> = {}) =>
    material({ articleId: "m-10", articleNumber: "PLÅT-10", articleName: "Plåt 10 mm", usableOnHand: 3, ...over });

  // The körplan's own rows (buildRunPlan), so the keys and the order are the list's.
  const runPlan = (
    operations: CapacityOperationRow[],
    materials: [string, RunPlanOperationMaterials][],
    plannedOrderOperations: RunPlanPlannedOperation[] = []
  ) =>
    buildRunPlan({
      today: TODAY,
      toDate: FRI,
      workCenter: { id: "wc-1", code: "110", name: "Kantpress", type: "machine", active: true },
      stations: [],
      operations,
      plannedOrderOperations,
      materials: new Map(materials),
    });

  it("two materials ⇒ two groups in article number order, with sums, short and the unlinked rows", () => {
    const ops = [
      op("a", 10, 1, { plannedDays: days([MON, 1]) }),
      op("b", 10, 1, { plannedDays: days([TUE, 1]) }),
      op("c", 10, 1, { plannedDays: days([WED, 1]) }),
      op("d", 10, 1, { plannedDays: days([THU, 1]) }),
    ];
    const result = runPlan(
      ops,
      [
        ["a:10", { materials: [plate10({ remainingQuantity: 2 }), material({ remainingQuantity: 4.5 })], linked: true }],
        ["b:10", { materials: [material({ remainingQuantity: 5.5 })], linked: true }],
        // Linked, everything drawn: in no group, and not unlinked either.
        ["c:10", { materials: [], linked: true }],
      ],
      [{ ...op("p", 10, 1, { dueDate: WED }), moOperationId: null }]
    );
    const grouped = groupRunPlanByMaterial(result.rows);
    expect(grouped.groups).toEqual([
      {
        articleId: "m-2",
        articleNumber: "PLÅT-2",
        articleName: "Plåt 2 mm",
        unit: "st",
        totalRemainingQuantity: 10,
        usableOnHand: 10,
        short: false,
        rowKeys: ["a:10", "b:10"],
      },
      {
        articleId: "m-10",
        articleNumber: "PLÅT-10",
        articleName: "Plåt 10 mm",
        unit: "st",
        totalRemainingQuantity: 2,
        usableOnHand: 3,
        short: false,
        rowKeys: ["a:10"],
      },
    ]);
    // d has no linked material; the Planerad TO's operation is never listed.
    expect(grouped.unlinkedRowKeys).toEqual(["d:10"]);
    expect(result.rows.map((r) => r.status)).toContain("planned_order");
    // The körplan's answer carries exactly this.
    expect(result.materialGroups).toEqual(grouped.groups);
    expect(result.unlinkedRowKeys).toEqual(grouped.unlinkedRowKeys);
  });

  it("short is the group's sum against the balance — each row alone can be covered", () => {
    const ops = [op("a", 10, 1, { plannedDays: days([MON, 1]) }), op("b", 10, 1, { plannedDays: days([TUE, 1]) })];
    const { groups } = groupRunPlanByMaterial(
      runPlan(ops, [
        ["a:10", { materials: [material({ remainingQuantity: 6 })], linked: true }],
        ["b:10", { materials: [material({ remainingQuantity: 4.0001 })], linked: true }],
      ]).rows
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ totalRemainingQuantity: 10.0001, usableOnHand: 10, short: true });
  });

  it("the same article on two material rows of one operation: the operation once, both quantities in the total", () => {
    const ops = [op("a", 10, 1, { plannedDays: days([MON, 1]) }), op("b", 10, 1, { plannedDays: days([TUE, 1]) })];
    const { groups, unlinkedRowKeys } = groupRunPlanByMaterial(
      runPlan(ops, [
        ["a:10", { materials: [material({ remainingQuantity: 0.1 }), material({ remainingQuantity: 0.2 })], linked: true }],
        ["b:10", { materials: [material({ remainingQuantity: 1 })], linked: true }],
      ]).rows
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rowKeys).toEqual(["a:10", "b:10"]);
    expect(groups[0]!.totalRemainingQuantity).toBe(1.3);
    expect(unlinkedRowKeys).toEqual([]);
  });

  it("no rows ⇒ nothing", () => {
    expect(groupRunPlanByMaterial([])).toEqual({ groups: [], unlinkedRowKeys: [] });
  });
});
