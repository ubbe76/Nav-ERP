import { describe, expect, it } from "vitest";
import {
  planStructure,
  structurePlanOrder,
  type ReplanOrder,
  type StructurePlan,
} from "../src/modules/planning/service/structure-replan.js";
import { planProduction, type MoveWorld } from "../src/modules/planning/service/production-plan.js";
import type { PlanWorkCenter } from "../src/modules/planning/service/capacity-book.js";
import {
  orderPlanStatus,
  plannedDateRange,
  type CapacityOperationRow,
  type PlannedDay,
} from "../src/modules/planning/service/capacity-calc.js";
import {
  checkDeliveryTime,
  type DeliveryTimeCheckInput,
  type DtcArticle,
  type DtcOperation,
} from "../src/modules/planning/service/delivery-time-check.js";

// Planera om strukturen (pure) — no database. Monday 2026-10-19 is today;
// 110 and 120 work Mon–Fri, 8 h; 900 is lego, five days. Every placement is
// Planera's engine (planProduction): the tests here are about the walk —
// children first, one world, the golv.
const TODAY = "2026-10-19";
const MON = "2026-10-19";
const TUE = "2026-10-20";
const WED = "2026-10-21";
const THU = "2026-10-22";
const FRI = "2026-10-23";
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
const lego: PlanWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Ytbehandling", type: "subcontract", weekScheduleId: null, leadTimeDays: 5 };

const h = (hours: number) => hours * 60;
const days = (...list: [string, number][]): PlannedDay[] => list.map(([date, hours]) => ({ date, minutes: h(hours) }));

// An operation of `hours` (as setup, nothing reported) on wc-1; the id is
// "<order>:<sequence>" and the order number "TO-<ORDER>".
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

const SCHEDULE: MoveWorld["schedule"] = {
  weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
  daySchedules: [{ id: "ds-480", netMinutes: 480 }],
  holidays: [],
};

function world(operations: CapacityOperationRow[], over: Partial<MoveWorld> = {}): MoveWorld {
  return {
    today: TODAY,
    offDays: new Set(),
    workCenters: new Map([
      ["wc-1", wc1],
      ["wc-3", wc3],
      ["wc-l", lego],
    ]),
    schedule: SCHEDULE,
    queueDays: 0,
    longOperationWeeks: 0,
    operations,
    ...over,
  };
}

// A chosen TO: `to("p", 0, null, ["h"])` = the top with the child h.
function to(id: string, level: number, parentOrderId: string | null, childOrderIds: string[] = [], extra: Partial<ReplanOrder> = {}): ReplanOrder {
  return {
    manufacturingOrderId: id,
    orderNumber: `TO-${id.toUpperCase()}`,
    parentOrderId,
    level,
    dueDate: null,
    externalReady: [],
    childOrderIds,
    ...extra,
  };
}

const NONE: ReadonlySet<string> = new Set();
const daysOf = (plan: StructurePlan, id: string) => plan.plans.find((p) => p.operationId === id)?.days;
const after = (plan: StructurePlan, id: string) => plan.operationsAfter.find((o) => o.moOperationId === id)!;

describe("structurePlanOrder — children before parents", () => {
  it("the deepest level first, order number in natural order within a level", () => {
    const orders = [
      to("p", 0, null, ["h10", "h9"]),
      to("h10", 1, "p", ["s"]),
      to("h9", 1, "p"),
      to("s", 2, "h10"),
    ];
    expect(structurePlanOrder(orders).map((o) => o.manufacturingOrderId)).toEqual(["s", "h9", "h10", "p"]);
    // The input is not reordered.
    expect(orders.map((o) => o.manufacturingOrderId)).toEqual(["p", "h10", "h9", "s"]);
  });

  it("a TO that covers two places of the tree comes before every parent it is a child of", () => {
    // P needs H and S, H needs S: S is drawn once, on level 1 under P — and
    // must still be planned before H ("TO-A" sorts before "TO-S").
    const orders = [to("p", 0, null, ["a", "s"]), to("a", 1, "p", ["s"]), to("s", 1, "p")];
    expect(structurePlanOrder(orders).map((o) => o.manufacturingOrderId)).toEqual(["s", "a", "p"]);
  });

  it("a cycle in the input ends", () => {
    const orders = [to("a", 0, null, ["b"]), to("b", 1, "a", ["a"])];
    expect(structurePlanOrder(orders)).toHaveLength(2);
  });
});

describe("planStructure — the golv", () => {
  it("the parent may start the SAME day its halvfabrikat is ready (S29)", () => {
    // H: 12 h on 110 = Monday 8 + Tuesday 4. P on 120 starts on Tuesday.
    const plan = planStructure(world([op("p", 10, 4, { workCenterId: "wc-3" }), op("h", 10, 12)]), NONE, [
      to("p", 0, null, ["h"]),
      to("h", 1, "p"),
    ]);
    expect(daysOf(plan, "h:10")).toEqual(days([MON, 8], [TUE, 4]));
    expect(daysOf(plan, "p:10")).toEqual(days([TUE, 4]));
    expect([...plan.finishOf]).toEqual([
      ["h", TUE],
      ["p", TUE],
    ]);
    expect([...plan.floorOf]).toEqual([["p", { date: TUE, source: { kind: "manufacturing_order", documentNumber: "TO-H" } }]]);
    expect(plan.notes).toEqual([]);
    expect(plan.blocked).toEqual([]);
  });

  it("without anything to wait for there is no golv: the TO is planned from today", () => {
    const plan = planStructure(world([op("p", 10, 4)]), NONE, [
      to("p", 0, null, [], { externalReady: [{ date: "2026-10-12", kind: "purchase_order", documentNumber: "IO-1" }, { date: TODAY, kind: "manufacturing_order", documentNumber: "TO-9" }] }),
    ]);
    expect(daysOf(plan, "p:10")).toEqual(days([MON, 4]));
    expect(plan.floorOf.size).toBe(0);
  });

  it("the golv is the latest of the children and what else covers the material", () => {
    const orders = (ioDate: string) => [
      to("p", 0, null, ["h"], {
        externalReady: [
          { date: ioDate, kind: "purchase_order", documentNumber: "IO-88" },
          { date: MON, kind: "manufacturing_order", documentNumber: "TO-77" },
        ],
      }),
      to("h", 1, "p"),
    ];
    const ops = () => [op("p", 10, 4, { workCenterId: "wc-3" }), op("h", 10, 12)];
    // The IO comes on Thursday, after H is ready (Tuesday).
    const io = planStructure(world(ops()), NONE, orders(THU));
    expect(daysOf(io, "p:10")).toEqual(days([THU, 4]));
    expect(io.floorOf.get("p")).toEqual({ date: THU, source: { kind: "purchase_order", documentNumber: "IO-88" } });
    // The IO comes today: the child decides.
    const child = planStructure(world(ops()), NONE, orders(MON));
    expect(daysOf(child, "p:10")).toEqual(days([TUE, 4]));
    expect(child.floorOf.get("p")?.source).toEqual({ kind: "manufacturing_order", documentNumber: "TO-H" });
  });

  it("a halvfabrikat that was not chosen counts with its stored ready day and is left as it is", () => {
    const shared = op("s", 10, 8, { plannedDays: days([WED, 8]), planLocked: true });
    const plan = planStructure(world([op("p", 10, 4, { workCenterId: "wc-3" }), shared]), NONE, [
      to("p", 0, null, [], { externalReady: [{ date: WED, kind: "manufacturing_order", documentNumber: "TO-S" }] }),
    ]);
    expect(daysOf(plan, "p:10")).toEqual(days([WED, 4]));
    expect(after(plan, "s:10")).toEqual(shared);
    expect(plan.plans.map((p) => p.operationId)).toEqual(["p:10"]);
    expect(plan.lockIds).toEqual(["p:10"]);
    expect(plan.finishOf.has("s")).toBe(false);
  });

  it("lego last in the halvfabrikat pushes the parent's golv — and is never planned or locked", () => {
    // H: Op 10 Monday, Op 20 lego sent Tuesday, back five working days later.
    const plan = planStructure(
      world([op("p", 10, 4), op("h", 10, 4), op("h", 20, 0, { workCenterId: "wc-l" })]),
      NONE,
      [to("p", 0, null, ["h"]), to("h", 1, "p")]
    );
    expect(plan.finishOf.get("h")).toBe(TUE2);
    expect(daysOf(plan, "p:10")).toEqual(days([TUE2, 4]));
    expect(plan.plans.map((p) => p.operationId)).toEqual(["h:10", "p:10"]);
    expect(plan.lockIds.sort()).toEqual(["h:10", "p:10"]);
    expect(after(plan, "h:20")).toMatchObject({ plannedDays: null, planLocked: false });
  });

  it("lego first in the parent counts from the golv", () => {
    // H ready Tuesday; P's lego is sent Tuesday, back Tuesday 27, Op 20 the day after.
    const plan = planStructure(
      world([op("p", 10, 0, { workCenterId: "wc-l" }), op("p", 20, 4), op("h", 10, 12)]),
      NONE,
      [to("p", 0, null, ["h"]), to("h", 1, "p")]
    );
    expect(daysOf(plan, "p:20")).toEqual(days([WED2, 4]));
    expect(plan.finishOf.get("p")).toBe(WED2);
  });

  it("the Standardkötid is waited inside each TO, never between the halvfabrikat and its parent", () => {
    const plan = planStructure(
      world([op("p", 10, 4), op("p", 20, 4), op("h", 10, 4), op("h", 20, 4)], { queueDays: 1 }),
      NONE,
      [to("p", 0, null, ["h"]), to("h", 1, "p")]
    );
    expect(plan.plans.map((p) => [p.operationId, p.startDate])).toEqual([
      ["h:10", MON],
      ["h:20", WED],
      ["p:10", WED],
      ["p:20", FRI],
    ]);
  });
});

describe("planStructure — one world", () => {
  it("the parent sees the halvfabrikat's bookings on a shared resource", () => {
    // H fills Monday and Tuesday on 110; P (also 110) may start Tuesday but
    // the day is full: Wednesday.
    const w = world([op("p", 10, 4), op("h", 10, 16)]);
    const plan = planStructure(w, NONE, [to("p", 0, null, ["h"]), to("h", 1, "p")]);
    expect(daysOf(plan, "h:10")).toEqual(days([MON, 8], [TUE, 8]));
    expect(daysOf(plan, "p:10")).toEqual(days([WED, 4]));
    expect(plan.floorOf.get("p")?.date).toBe(TUE);
    // The world afterwards: both planned and locked; the input is untouched.
    expect(plan.operationsAfter.map((o) => [o.moOperationId, o.plannedDays, o.planLocked])).toEqual([
      ["p:10", days([WED, 4]), true],
      ["h:10", days([MON, 8], [TUE, 8]), true],
    ]);
    expect(w.operations.every((o) => o.plannedDays === undefined)).toBe(true);
  });

  it("each TO is exactly Planera's engine on the world the TOs before it left", () => {
    const w = world([op("p", 10, 6), op("h", 10, 12), op("x", 10, 6, { plannedDays: days([TUE, 6]) })]);
    const plan = planStructure(w, NONE, [to("p", 0, null, ["h"]), to("h", 1, "p")]);
    const base = { today: TODAY, offDays: w.offDays, workCenters: w.workCenters, schedule: w.schedule, queueDays: 0, longOperationWeeks: 0 };
    const first = planProduction({
      ...base,
      orders: [{ id: "h", orderNumber: "TO-H", dueDate: null, operations: [{ ...w.operations[1]!, started: false }] }],
      // P waits for its turn: it is no load for its own halvfabrikat.
      existingOperations: [w.operations[2]!],
    });
    expect(daysOf(plan, "h:10")).toEqual(first.plans[0]!.days);
    const second = planProduction({
      ...base,
      orders: [
        { id: "p", orderNumber: "TO-P", dueDate: null, operations: [{ ...w.operations[0]!, started: false }], earliestStart: first.orders[0]!.plannedFinish },
      ],
      existingOperations: [{ ...w.operations[1]!, plannedDays: first.plans[0]!.days, planLocked: true }, w.operations[2]!],
    });
    expect(daysOf(plan, "p:10")).toEqual(second.plans[0]!.days);
    // Load outside the tree is never moved.
    expect(after(plan, "x:10")).toEqual(w.operations[2]);
  });

  it("the tree's own old load is released: alone on the resource it starts today, not after its own old plan", () => {
    const plan = planStructure(
      world([
        op("p", 10, 8, { plannedDays: days([MON2, 8]) }),
        op("h", 10, 8, { plannedDays: days([MON, 8]) }),
      ]),
      NONE,
      [to("p", 0, null, ["h"]), to("h", 1, "p")]
    );
    // Not released, H's old Monday would have pushed H itself to Tuesday.
    expect(daysOf(plan, "h:10")).toEqual(days([MON, 8]));
    expect(daysOf(plan, "p:10")).toEqual(days([TUE, 8]));
    expect(plan.clear).toEqual([]);
  });

  it("a parent due today with a lot left on the same resource is no load for its halvfabrikat: the child starts today", () => {
    // P: 40 h on 110, due today (and once: passed) — unplanned, the book
    // would put it all on today and roll it through the week. H: 8 h on 110.
    for (const due of [TODAY, "2026-10-12"]) {
      const plan = planStructure(
        world([
          op("p", 10, 40, { dueDate: due, plannedDays: days([MON, 8], [TUE, 8], [WED, 8], [THU, 8], [FRI, 8]) }),
          op("h", 10, 8, { dueDate: FRI, plannedDays: days([MON2, 8]) }),
        ]),
        NONE,
        [to("p", 0, null, ["h"], { dueDate: due }), to("h", 1, "p", [], { dueDate: FRI })]
      );
      expect(daysOf(plan, "h:10"), due).toEqual(days([MON, 8]));
      // H is ready today: no golv, and P takes what H left.
      expect(plan.floorOf.get("p")).toBeUndefined();
      expect(daysOf(plan, "p:10"), due).toEqual(days([TUE, 8], [WED, 8], [THU, 8], [FRI, 8], [MON2, 8]));
    }
  });

  it("a later sibling is no load either — but a sibling already planned in the run is", () => {
    // H1 and H2 (both 110, 8 h) under P. H2 is due today; H1 is planned
    // first (order number) and must not be pushed by H2's released load.
    const plan = planStructure(
      world([op("p", 10, 4, { dueDate: MON2 }), op("h1", 10, 8, { dueDate: FRI }), op("h2", 10, 8, { dueDate: TODAY })]),
      NONE,
      [to("p", 0, null, ["h1", "h2"], { dueDate: MON2 }), to("h1", 1, "p", [], { dueDate: FRI }), to("h2", 1, "p", [], { dueDate: TODAY })]
    );
    expect(daysOf(plan, "h1:10")).toEqual(days([MON, 8]));
    expect(daysOf(plan, "h2:10")).toEqual(days([TUE, 8]));
    expect(daysOf(plan, "p:10")).toEqual(days([WED, 4]));
  });

  it("the färdigdatum never decide the placing (S30): any dates give the same days", () => {
    // P → H → S on shared resources, load outside the tree, a queue time.
    const run = (due: Record<"p" | "h" | "s", string | null>) => {
      const operations = [
        op("p", 10, 12, { dueDate: due.p }),
        op("p", 20, 6, { dueDate: due.p, workCenterId: "wc-3" }),
        op("h", 10, 10, { dueDate: due.h }),
        op("h", 20, 5, { dueDate: due.h, workCenterId: "wc-3" }),
        op("s", 10, 14, { dueDate: due.s }),
        op("x", 10, 6, { dueDate: WED, plannedDays: days([TUE, 6]) }),
        op("y", 10, 20, { dueDate: THU }),
      ];
      return planStructure(world(operations, { queueDays: 0.5 }), NONE, [
        to("p", 0, null, ["h"], { dueDate: due.p }),
        to("h", 1, "p", ["s"], { dueDate: due.h }),
        to("s", 2, "h", [], { dueDate: due.s }),
      ]);
    };
    const reference = run({ p: null, h: null, s: null });
    expect(reference.plans).toHaveLength(5);
    const variants: Record<"p" | "h" | "s", string | null>[] = [
      { p: TODAY, h: null, s: null },
      { p: "2026-10-01", h: WED, s: TUE },
      { p: "2027-03-01", h: "2026-10-05", s: "2027-01-01" },
      { p: WED, h: TODAY, s: TODAY },
    ];
    for (const due of variants) {
      const plan = run(due);
      expect(plan.plans, JSON.stringify(due)).toEqual(reference.plans);
      expect([...plan.finishOf], JSON.stringify(due)).toEqual([...reference.finishOf]);
      expect([...plan.floorOf], JSON.stringify(due)).toEqual([...reference.floorOf]);
    }
    // Only Sen reads them.
    expect(run({ p: TODAY, h: null, s: null }).warnings.some((w) => w.kind === "late" && w.manufacturingOrderId === "p")).toBe(true);
    expect(reference.warnings.filter((w) => w.kind === "late")).toEqual([]);
  });

  it("a component shared by two places of the tree is planned once, before both, and both wait for it", () => {
    // P needs A and S, A needs S. S: Monday–Tuesday. A (120) from Tuesday,
    // two days. P (120) from A's finish day, Wednesday — after A's booking.
    const plan = planStructure(
      world([op("p", 10, 4, { workCenterId: "wc-3" }), op("a", 10, 12, { workCenterId: "wc-3" }), op("s", 10, 12)]),
      NONE,
      [to("p", 0, null, ["a", "s"]), to("a", 1, "p", ["s"]), to("s", 1, "p")]
    );
    expect(plan.plans.map((p) => p.operationId)).toEqual(["s:10", "a:10", "p:10"]);
    expect(daysOf(plan, "s:10")).toEqual(days([MON, 8], [TUE, 4]));
    expect(daysOf(plan, "a:10")).toEqual(days([TUE, 8], [WED, 4]));
    expect(daysOf(plan, "p:10")).toEqual(days([WED, 4]));
    expect(plan.floorOf.get("a")).toEqual({ date: TUE, source: { kind: "manufacturing_order", documentNumber: "TO-S" } });
    expect(plan.floorOf.get("p")).toEqual({ date: WED, source: { kind: "manufacturing_order", documentNumber: "TO-A" } });
  });
});

describe("planStructure — locked, started, done", () => {
  it("operations that were locked are planned again and listed (S28)", () => {
    const plan = planStructure(
      world([
        op("p", 10, 4, { plannedDays: days([WED2, 4]), planLocked: true }),
        op("p", 20, 4, { plannedDays: days(["2026-10-29", 4]), planLocked: true }),
        op("h", 10, 4, { plannedDays: days([MON2, 4]), planLocked: true }),
        op("h", 20, 4),
      ]),
      NONE,
      [to("p", 0, null, ["h"]), to("h", 1, "p")]
    );
    expect(plan.plans.map((p) => [p.operationId, p.startDate])).toEqual([
      ["h:10", MON],
      ["h:20", TUE],
      ["p:10", TUE],
      ["p:20", WED],
    ]);
    expect(plan.relockedIds.sort()).toEqual(["h:10", "p:10", "p:20"]);
    expect(plan.notes).toEqual([
      "TO-H: 1 operation var låst och planeras om",
      "TO-P: 2 operationer var låsta och planeras om",
    ]);
    expect(plan.lockIds.sort()).toEqual(["h:10", "h:20", "p:10", "p:20"]);
    expect(plan.warnings).toEqual([]);
  });

  it("a started operation is forced to today whatever the golv says — with a note when it lies before it", () => {
    // Op 10: one of four reported — three left, 4 h.
    const ops = [op("p", 10, 0, { workCenterId: "wc-3", orderQuantity: 4, runTimePerUnit: 80, quantityCompleted: 1 }), op("p", 20, 4, { workCenterId: "wc-3" }), op("h", 10, 12)];
    const orders = [to("p", 0, null, ["h"]), to("h", 1, "p")];
    const plan = planStructure(world(ops), NONE, orders);
    expect(daysOf(plan, "p:10")).toEqual(days([MON, 4]));
    // Op 20 waits for the material (Tuesday) and the gap after it.
    expect(daysOf(plan, "p:20")).toEqual(days([WED, 4]));
    expect(plan.notes).toEqual(["TO-P op 10 är påbörjad och ligger före att TO-H är klar (2026-10-20)"]);

    // Stamped in counts as started too; the IO's text.
    const stamped = planStructure(world([op("p", 10, 4)]), new Set(["p:10"]), [
      to("p", 0, null, [], { externalReady: [{ date: THU, kind: "purchase_order", documentNumber: "IO-88" }] }),
    ]);
    expect(daysOf(stamped, "p:10")).toEqual(days([MON, 4]));
    expect(stamped.notes).toEqual(["TO-P op 10 är påbörjad och ligger före att IO-88 har kommit (2026-10-22)"]);

    // Started without a golv: today, and nothing to say.
    const free = planStructure(world([op("p", 10, 4)]), new Set(["p:10"]), [to("p", 0, null)]);
    expect(daysOf(free, "p:10")).toEqual(days([MON, 4]));
    expect(free.notes).toEqual([]);
  });

  it("lockIds are only the operations with days; done, 0-minute and lego ones are cleared when they had days", () => {
    const plan = planStructure(
      world([
        op("p", 10, 4, { operationStatus: "done", plannedDays: days([MON, 4]), planLocked: true }),
        op("p", 20, 0, { plannedDays: days([TUE, 1]) }),
        op("p", 30, 0, { workCenterId: "wc-l" }),
        op("p", 40, 4),
        op("p", 50, 0),
      ]),
      NONE,
      [to("p", 0, null)]
    );
    // Lego is sent Monday, back Monday 26; Op 40 the day after.
    expect(plan.plans.map((p) => [p.operationId, p.days])).toEqual([["p:40", days([TUE2, 4])]]);
    expect(plan.lockIds).toEqual(["p:40"]);
    expect(plan.clear.sort()).toEqual(["p:10", "p:20"]);
    // A done operation's lock is not a "was locked and is moved".
    expect(plan.relockedIds).toEqual([]);
    expect(after(plan, "p:10")).toMatchObject({ plannedDays: null, planLocked: false });
  });

  it("the finish day is the one Sen reads from the plan afterwards", () => {
    const w = world([op("p", 10, 4), op("p", 20, 6, { workCenterId: "wc-3" }), op("h", 10, 4), op("h", 20, 0, { workCenterId: "wc-l" })]);
    const plan = planStructure(w, NONE, [to("p", 0, null, ["h"], { dueDate: MON2 }), to("h", 1, "p", [], { dueDate: FRI })]);
    for (const id of ["p", "h"]) {
      const status = orderPlanStatus(plan.operationsAfter.filter((o) => o.manufacturingOrderId === id), {
        today: TODAY,
        offDays: w.offDays,
        workCenters: w.workCenters,
        queueDays: 0,
      });
      expect(status.plannedFinish, id).toBe(plan.finishOf.get(id));
      expect(status.late, id).toBe(true);
    }
    // Sen counts on the due date the run was given, and the rows carry it.
    expect(plan.warnings.map((w) => [w.kind, w.orderNumber])).toEqual([
      ["late", "TO-H"],
      ["late", "TO-P"],
    ]);
    expect(after(plan, "p:10").dueDate).toBe(MON2);
    expect(after(plan, "h:10").dueDate).toBe(FRI);
  });
});

describe("planStructure — missing material and the horizon (S32)", () => {
  it("material without cover and supply without a date give a note and no golv — never a stop", () => {
    const plan = planStructure(world([op("p", 10, 4)]), NONE, [
      to("p", 0, null, [], {
        missingMaterial: [{ articleNumber: "1001" }, { articleNumber: "1002" }, { articleNumber: "1001" }],
        undatedSupply: [{ kind: "purchase_order", documentNumber: "IO-5" }],
      }),
    ]);
    expect(daysOf(plan, "p:10")).toEqual(days([MON, 4]));
    expect(plan.floorOf.size).toBe(0);
    expect(plan.blocked).toEqual([]);
    expect(plan.notes).toEqual([
      "TO-P: IO-5 saknar datum — räknas inte i när materialet är klart",
      "TO-P: material saknar täckning (1001, 1002) — räknas inte i när materialet är klart",
    ]);
    expect(plan.lockIds).toEqual(["p:10"]);
  });

  it("a TO beyond the horizon blocks the plan; its parent gets no golv from it", () => {
    // Two years of 110 are 104 × 40 h: 5 000 h never fit.
    const plan = planStructure(
      world([
        op("p", 10, 4, { workCenterId: "wc-3" }),
        op("h", 10, 4, { workCenterId: "wc-3", plannedDays: days([WED, 4]), planLocked: true }),
        op("h", 20, 5000, { plannedDays: days([THU, 8]) }),
        op("h", 30, 4, { plannedDays: days([FRI, 4]) }),
      ]),
      NONE,
      [to("p", 0, null, ["h"]), to("h", 1, "p")]
    );
    expect(plan.blocked).toEqual([{ manufacturingOrderId: "h", orderNumber: "TO-H" }]);
    expect(plan.finishOf.get("h")).toBeNull();
    expect(plan.warnings.map((w) => [w.kind, w.orderNumber, w.sequenceNo])).toEqual([["horizon", "TO-H", 20]]);
    // What fit before it is planned; the rest had days and has none now.
    expect(plan.plans.map((p) => [p.operationId, p.startDate])).toEqual([
      ["h:10", MON],
      ["p:10", MON],
    ]);
    expect(plan.clear.sort()).toEqual(["h:20", "h:30"]);
    expect(plan.lockIds.sort()).toEqual(["h:10", "p:10"]);
    // P is planned without a golv — and the partial booking is given back.
    expect(plan.floorOf.has("p")).toBe(false);
    expect(plan.operationsAfter.filter((o) => plannedDateRange(o) !== null).map((o) => o.moOperationId).sort()).toEqual(["h:10", "p:10"]);
  });
});

// "Samma dagar som reservationen": Leveranstidskontrollen schedules a
// structure it would make (scheduleOperations, golv max(materialReady, t0));
// Planera om strukturen on the same TOs, on an empty book, gives every
// operation the same days and every TO the same ready day.
describe("planStructure — the same days as the Leveranstidskontroll's reservation", () => {
  const article = (articleId: string, type: DtcArticle["type"]): DtcArticle => ({ articleId, articleNumber: `NR-${articleId}`, name: articleId, type, rounding: null });
  const rop = (sequenceNo: number, hours: number, workCenterId = "wc-1"): DtcOperation => ({
    sequenceNo,
    workCenterId,
    description: null,
    setupTime: h(hours),
    runTimePerUnit: 0,
  });

  it.each([0, 0.5, 1])("P → H → S with a bought material, lego and two resources (queue %s)", (queueDays) => {
    const routings = new Map([
      ["p", [rop(10, 6), rop(20, 10, "wc-3")]],
      ["h", [rop(10, 12), rop(20, 0, "wc-l"), rop(30, 3)]],
      ["s", [rop(10, 5, "wc-3"), rop(20, 14)]],
    ]);
    const base = world([], { queueDays });
    const input: DeliveryTimeCheckInput = {
      today: TODAY,
      offDays: base.offDays,
      articles: new Map(["p", "h", "s"].map((id) => [id, article(id, "manufactured")] as const).concat([["m", article("m", "purchased")]])),
      overviews: new Map(),
      excludeSalesOrderId: null,
      bomEdges: [
        { parentArticleId: "p", componentArticleId: "h", quantity: 1 },
        { parentArticleId: "h", componentArticleId: "s", quantity: 1 },
        { parentArticleId: "s", componentArticleId: "m", quantity: 1 },
      ],
      phantomIds: new Set(),
      routings,
      workCenters: base.workCenters,
      schedule: base.schedule,
      existingOperations: [],
      queueDays,
      // Ordered today, three working days: the material is there Thursday.
      suppliers: new Map([["m", { supplierName: "Stål AB", leadTimeDays: 3, settings: { weekdays: [], mode: "arrival" as const, transitDays: 0 } }]]),
      customer: null,
      rows: [{ key: "r", articleId: "p", quantity: 1 }],
    };
    const check = checkDeliveryTime(input);
    expect(check.batches.map((b) => [b.articleId, b.level])).toEqual([
      ["s", 3],
      ["h", 2],
      ["p", 1],
    ]);
    // The check's own floor for S: the day the material comes.
    expect(check.batches[0]!.operations[0]!.days[0]!.date).toBe(THU);

    // The same TOs as they stand right after a reservation was unlocked and
    // their days removed: no plan at all.
    const operations = check.batches.flatMap((b) =>
      routings.get(b.articleId)!.map((o) => op(b.articleId, o.sequenceNo, o.setupTime / 60, { workCenterId: o.workCenterId }))
    );
    const plan = planStructure(world(operations, { queueDays }), NONE, [
      to("p", 0, null, ["h"]),
      to("h", 1, "p", ["s"]),
      to("s", 2, "h", [], { externalReady: [{ date: THU, kind: "purchase_order", documentNumber: "IO-1" }] }),
    ]);
    for (const batch of check.batches) {
      for (const o of batch.operations) {
        expect(daysOf(plan, `${batch.articleId}:${o.sequenceNo}`) ?? [], `${batch.articleId} op ${o.sequenceNo}`).toEqual(o.days);
      }
      expect(plan.finishOf.get(batch.articleId), batch.articleId).toBe(batch.readyDate);
    }
    expect(plan.blocked).toEqual([]);
    expect(plan.notes).toEqual([]);
  });
});
