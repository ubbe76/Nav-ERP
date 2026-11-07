import { describe, expect, it } from "vitest";
import type { PlanWorkCenter } from "../src/modules/planning/service/capacity-book.js";
import { planProduction } from "../src/modules/planning/service/production-plan.js";
import type { CapacityOperationRow, OperationResourceOption, PlannedWeek } from "../src/modules/planning/service/capacity-calc.js";
import {
  mayGetResourceSuggestion,
  resourceSuggestions,
  type SuggestionWorld,
} from "../src/modules/planning/service/resource-suggestions.js";

// Förslag på alternativ resurs (#15, etapp 2) — pure, no database. Monday
// 2026-10-19 is today; week 43 is Mon 19 – Sun 25, then 44, 45, 46. Every own
// resource has a 40 h week. 110 is the ordinarie, 120 and 130 its
// alternatives, 140 a resource without alternatives, 900 a legoresurs.
const TODAY = "2026-10-19";
const W43 = "2026-10-19";
const W44 = "2026-10-26";
const W45 = "2026-11-02";
const W46 = "2026-11-09";

const machine = (workCenterId: string, code: string, name: string, extra: Partial<PlanWorkCenter> = {}): PlanWorkCenter => ({
  workCenterId,
  code,
  name,
  type: "machine",
  weekScheduleId: "ws-40",
  hoursPerDay: null,
  capacityFactor: 1,
  leadTimeDays: null,
  active: true,
  ...extra,
});
const r110 = machine("wc-110", "110", "Kantpress");
const r120 = machine("wc-120", "120", "Kantpress 2");
const r130 = machine("wc-130", "130", "Kantpress 3");
const r140 = machine("wc-140", "140", "Svets");
const lego = machine("wc-900", "900", "Ytbehandling", { type: "subcontract", weekScheduleId: null, leadTimeDays: 10 });

const h = (hours: number) => hours * 60;
const weeks = (...list: [string, number][]): PlannedWeek[] => list.map(([monday, hours]) => ({ monday, minutes: h(hours) }));

// 110 with 120 and 130 as alternatives, every resource "som ordinarie".
const ALTERNATIVES: OperationResourceOption[] = [
  { workCenterId: "wc-110", rank: 0, setupTime: 0, runTimePerUnit: 0 },
  { workCenterId: "wc-120", rank: 1, setupTime: 0, runTimePerUnit: 0 },
  { workCenterId: "wc-130", rank: 2, setupTime: 0, runTimePerUnit: 0 },
];

// An operation of `hours` (as setup on its current resource, nothing reported).
// The resources' times follow the operation's unless given.
function op(
  orderNumber: string,
  sequenceNo: number,
  hours: number,
  extra: Partial<CapacityOperationRow> & { altHours?: Record<string, number> } = {}
): CapacityOperationRow {
  const { altHours, ...rest } = extra;
  const resources = (rest.resources ?? []).map((r) => ({ ...r, setupTime: h(altHours?.[r.workCenterId] ?? hours) }));
  return {
    moOperationId: `${orderNumber}:${sequenceNo}`,
    manufacturingOrderId: `mo-${orderNumber}`,
    orderNumber,
    articleNumber: "ART",
    articleName: "Artikel",
    workCenterId: "wc-110",
    orderQuantity: 1,
    dueDate: null,
    sequenceNo,
    setupTime: h(hours),
    runTimePerUnit: 0,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
    touched: false,
    resourceLocked: false,
    ...rest,
    resources,
  };
}

// Load that is not a candidate: `hours` planned on a resource in a week.
const load = (workCenterId: string, monday: string, hours: number, n = 0) =>
  op(`LOAD-${workCenterId}-${monday}-${n}`, 10, hours, { workCenterId, plannedWeeks: weeks([monday, hours]) });

function world(operations: CapacityOperationRow[], extra: Partial<SuggestionWorld> = {}): SuggestionWorld {
  return {
    today: TODAY,
    offDays: new Set(),
    workCenters: new Map([r110, r120, r130, r140, lego].map((w) => [w.workCenterId, w])),
    schedule: {
      weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
      daySchedules: [{ id: "ds-480", netMinutes: 480 }],
      holidays: [],
    },
    operations,
    ...extra,
  };
}

const FULL_110 = [load("wc-110", W43, 40), load("wc-110", W44, 40)];

describe("resourceSuggestions — when the current resource is full", () => {
  it("suggests the alternative ready in the earliest week when the load pushes the stored klar-vecka", () => {
    // 110 is booked W43–W44, so the operation's plan ends in W45; bare it would be W43.
    const candidate = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    expect(resourceSuggestions(world([...FULL_110, load("wc-120", W43, 40), candidate]))).toEqual([
      {
        moOperationId: "TO-1:10",
        manufacturingOrderId: "mo-TO-1",
        orderNumber: "TO-1",
        sequenceNo: 10,
        fromWorkCenterId: "wc-110",
        fromCode: "110",
        // 120 is full this week (W44), 130 is free (W43).
        toWorkCenterId: "wc-130",
        toCode: "130",
        toName: "Kantpress 3",
        currentToWeek: W45,
        toWeek: W43,
        reason: "overloaded",
      },
    ]);
  });

  it("gives nothing when the current resource is not full, even if an alternative is faster", () => {
    // 50 h: two weeks on an empty 110 — the stored plan is the bare plan.
    const candidate = op("TO-1", 10, 50, { resources: ALTERNATIVES, plannedWeeks: weeks([W43, 40], [W44, 10]), altHours: { "wc-120": 20 } });
    expect(resourceSuggestions(world([candidate]))).toEqual([]);
  });

  it("keeps the current resource on a tie in week, and takes the lowest rank on a tie between alternatives", () => {
    const candidate = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W44, 10]) });
    // 110 is full W43 (stored W44); 120 and 130 too: nothing earlier.
    expect(resourceSuggestions(world([load("wc-110", W43, 40), load("wc-120", W43, 40), load("wc-130", W43, 40), candidate]))).toEqual([]);
    // 120 and 130 both free: the same week, rank 1 wins.
    expect(resourceSuggestions(world([load("wc-110", W43, 40), candidate])).map((s) => [s.toCode, s.toWeek])).toEqual([["120", W43]]);
  });

  it("measures an unplanned operation by its trial: pushed by the load ⇒ a förslag, free ⇒ none", () => {
    const candidate = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: null });
    expect(resourceSuggestions(world([...FULL_110, candidate]))).toEqual([
      expect.objectContaining({ toCode: "120", currentToWeek: null, toWeek: W43, reason: "unplanned" }),
    ]);
    // An empty 110 takes it this week: never planned is not the same as full.
    expect(resourceSuggestions(world([candidate]))).toEqual([]);
  });

  it("gives nothing for a stale plan: the load, not the plan's age, decides (another TO cancelled)", () => {
    // The plan ends in W45 because 110 WAS full W43–W44; that TO is gone, so
    // a trial now finishes in W43 like the bare 110 — no "overloaded".
    const candidate = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    expect(resourceSuggestions(world([...FULL_110, candidate]))).toHaveLength(1);
    expect(resourceSuggestions(world([candidate]))).toEqual([]);
  });

  it("compares with the trial when the load now finishes the stored plan earlier", () => {
    // Stored W46, but with the load as it is the operation finishes in W45
    // on 110 (W43–W44 full): full all the same, and the förslag says W45.
    const candidate = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W46, 10]) });
    expect(resourceSuggestions(world([...FULL_110, candidate])).map((s) => [s.toCode, s.currentToWeek, s.toWeek, s.reason])).toEqual([
      ["120", W45, W43, "overloaded"],
    ]);
  });

  it("tries the alternatives with their own times", () => {
    // 120 has 10 h left this week: som ordinarie (20 h) it ends in W44 like
    // the base, with its own 8 h it fits W43.
    const base = [load("wc-110", W43, 40), load("wc-120", W43, 30), load("wc-130", W43, 40)];
    const som = op("TO-1", 10, 20, { resources: ALTERNATIVES, plannedWeeks: weeks([W44, 20]) });
    expect(resourceSuggestions(world([...base, som]))).toEqual([]);
    const own = op("TO-1", 10, 20, { resources: ALTERNATIVES, plannedWeeks: weeks([W44, 20]), altHours: { "wc-120": 8 } });
    expect(resourceSuggestions(world([...base, own])).map((s) => [s.toCode, s.toWeek])).toEqual([["120", W43]]);
  });

  it("never tries an inactive alternative or one without capacity", () => {
    const candidate = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    const workCenters = new Map(
      [r110, { ...r120, active: false }, { ...r130, weekScheduleId: null }, r140, lego].map((w) => [w.workCenterId, w])
    );
    expect(resourceSuggestions(world([...FULL_110, candidate], { workCenters }))).toEqual([]);
  });

  it("suggests the way back to the ordinarie for an operation on an alternative that is not Vald för hand", () => {
    const candidate = op("TO-1", 10, 10, { workCenterId: "wc-120", resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    const out = resourceSuggestions(world([load("wc-120", W43, 40), load("wc-120", W44, 40), load("wc-130", W43, 40), candidate]));
    expect(out.map((s) => [s.fromCode, s.toCode, s.toWeek])).toEqual([["120", "110", W43]]);
  });
});

describe("resourceSuggestions — which operations", () => {
  const full = (extra: Partial<CapacityOperationRow>) =>
    resourceSuggestions(world([...FULL_110, op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]), ...extra })]));

  it("gives a plan-locked, a Vald för hand and a touched operation nothing", () => {
    expect(full({})).toHaveLength(1);
    expect(full({ planLocked: true })).toEqual([]);
    expect(full({ resourceLocked: true })).toEqual([]);
    expect(full({ touched: true })).toEqual([]);
    expect(full({ quantityCompleted: 1 })).toEqual([]);
    expect(full({ quantityScrapped: 1 })).toEqual([]);
    expect(full({ timeOnCurrentResource: true })).toEqual([]);
    expect(full({ operationStatus: "done" })).toEqual([]);
  });

  it("gives a lego operation nothing, even with rows — the walk takes its lead time instead", () => {
    // The snapshot never gives lego (or Kalkyl, which never reaches the TO)
    // any rows (mo-operation-resources.test.ts); the walk holds even so.
    const legoOp = op("TO-1", 10, 10, { workCenterId: "wc-900", resources: ALTERNATIVES, plannedWeeks: null });
    expect(resourceSuggestions(world([...FULL_110, legoOp]))).toEqual([]);
  });

  it("gives an operation without alternatives nothing — the world is not even read", () => {
    const plain = op("TO-1", 10, 10, { plannedWeeks: weeks([W45, 10]) });
    expect(mayGetResourceSuggestion(plain)).toBe(false);
    expect(resourceSuggestions(world([...FULL_110, plain]))).toEqual([]);
  });

  it("narrows to the given orders", () => {
    const a = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    const b = op("TO-2", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    expect(resourceSuggestions(world([...FULL_110, a, b]), new Set(["mo-TO-2"])).map((s) => s.orderNumber)).toEqual(["TO-2"]);
    expect(resourceSuggestions(world([...FULL_110, a, b])).map((s) => s.orderNumber)).toEqual(["TO-1", "TO-2"]);
  });
});

describe("resourceSuggestions — the floor and the walk", () => {
  it("starts after the previous operation's klar-vecka", () => {
    // Op 10 on 140 ends W45 (140 is full W43–W44); Op 20 on 110 is stored
    // W46 (110 full W45). 120 is free from W45.
    const op10 = op("TO-1", 10, 10, { workCenterId: "wc-140", plannedWeeks: weeks([W45, 10]) });
    const op20 = op("TO-1", 20, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W46, 10]) });
    const out = resourceSuggestions(world([load("wc-140", W43, 40), load("wc-140", W44, 40), load("wc-110", W45, 40), op10, op20]));
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.currentToWeek, s.toWeek])).toEqual([[20, "120", W46, W45]]);
  });

  it("measures the previous operation like the base: one that finished early, or whose stored week is stale, does not hold the floor", () => {
    // Op 10 was planned W45 and is done already: Op 20's stored W46 is stale,
    // 110 is empty — a trial finishes this week, so no förslag at all.
    const done10 = op("TO-1", 10, 10, { workCenterId: "wc-140", plannedWeeks: weeks([W45, 10]), operationStatus: "done", quantityCompleted: 1 });
    const op20 = op("TO-1", 20, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W46, 10]) });
    expect(resourceSuggestions(world([done10, op20]))).toEqual([]);
    // Pending but stale (140 is empty now): the floor is Op 10's trial (W43),
    // not its stored W45 — and from W43 110 is free.
    const stale10 = op("TO-1", 10, 10, { workCenterId: "wc-140", plannedWeeks: weeks([W45, 10]) });
    expect(resourceSuggestions(world([stale10, op20]))).toEqual([]);
  });

  it("does not clamp a previous operation whose week has passed into the current week", () => {
    // Op 10 on 140 was planned in W41 and has 40 h left; 140 is full this
    // week, so it finishes in W44 — not "this week", as the clamped stored
    // week would say. Op 20 (stored W45, 110 full in W44) is measured from
    // W44: 120 is free there, so the förslag is W44, not W43.
    const W41 = "2026-10-05";
    const op10 = op("TO-1", 10, 40, { workCenterId: "wc-140", plannedWeeks: weeks([W41, 40]) });
    const op20 = op("TO-1", 20, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    const out = resourceSuggestions(world([load("wc-140", W43, 40), load("wc-110", W44, 40), op10, op20]));
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.currentToWeek, s.toWeek])).toEqual([[20, "120", W45, W44]]);
  });

  it("starts after where Planera puts an overbooked previous operation — Byt gives exactly the förslag's week", () => {
    // Op 10 on 140 is stored in W43, but 140 is full there now (another TO
    // came in on a locked week): its trial ends in W44. Op 20 on 110 is
    // stored in W45 (110 full W44–W45); 120 is free. A floor from Op 10's
    // stored W43 would promise 120 in W43 — after the switch the order is
    // replanned with Planera's rules, Op 10 lands in W44 and Op 20 with it.
    const op10 = op("TO-1", 10, 10, { workCenterId: "wc-140", plannedWeeks: weeks([W43, 10]) });
    const op20 = op("TO-1", 20, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    const others = [load("wc-140", W43, 40), load("wc-110", W44, 40), load("wc-110", W45, 40)];
    const w = world([...others, op10, op20]);
    const out = resourceSuggestions(w);
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.currentToWeek, s.toWeek])).toEqual([[20, "120", W45, W44]]);

    // Byt till 120: Ändra replans the one order with Planera's rules
    // (replanOrderInTx) — every other order is existing load.
    const switched = { ...op20, workCenterId: "wc-120", resourceLocked: true };
    const replanned = planProduction({
      today: w.today,
      offDays: w.offDays,
      workCenters: w.workCenters,
      schedule: w.schedule,
      orders: [{ id: "mo-TO-1", orderNumber: "TO-1", dueDate: null, operations: [op10, switched].map((o) => ({ ...o, started: false })) }],
      existingOperations: others,
    });
    const endWeek = (id: string) => replanned.plans.find((p) => p.operationId === id)?.endWeek;
    expect([endWeek("TO-1:10"), endWeek("TO-1:20")]).toEqual([W44, out[0]!.toWeek]);

    // Not overbooked (140 has room in W43): the floor stays W43, and so does
    // the förslag.
    const free = resourceSuggestions(world([load("wc-110", W43, 40), load("wc-110", W44, 40), op10, op20]));
    expect(free.map((s) => [s.sequenceNo, s.toCode, s.toWeek])).toEqual([[20, "120", W43]]);
  });

  it("starts after a lego operation's lead time", () => {
    // 10 working days from Monday 19 Oct: Monday 2 Nov (W45).
    const op10 = op("TO-1", 10, 0, { workCenterId: "wc-900" });
    const op20 = op("TO-1", 20, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W46, 10]) });
    const out = resourceSuggestions(world([load("wc-110", W45, 40), op10, op20]));
    expect(out.map((s) => [s.toCode, s.toWeek])).toEqual([["120", W45]]);
  });

  it("gives nothing after an own operation with time but no plan — Planera's horizonHit", () => {
    // Op 10 did not fit (or was never planned): Planera plans nothing after
    // it, so Op 20 gets no förslag even though 110 is full and 120 free.
    const op10 = op("TO-1", 10, 10, { workCenterId: "wc-140", plannedWeeks: null });
    const op20 = op("TO-1", 20, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    expect(resourceSuggestions(world([...FULL_110, op10, op20]))).toEqual([]);
    // The unplanned operation itself may still get one, and the first
    // operation starts today.
    const first = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: null });
    expect(resourceSuggestions(world([...FULL_110, first, op20])).map((s) => [s.sequenceNo, s.reason, s.toWeek])).toEqual([[10, "unplanned", W43]]);
    // A lego operation or one without time left is no such stop.
    const empty10 = op("TO-1", 10, 0, { workCenterId: "wc-140", plannedWeeks: null });
    expect(resourceSuggestions(world([...FULL_110, empty10, op20])).map((s) => [s.sequenceNo, s.toWeek])).toEqual([[20, W43]]);
  });

  it("suggests for several operations in sequence, each from the plan of the one before (not from its förslag)", () => {
    const op10 = op("TO-1", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    const op20 = op("TO-1", 20, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) });
    const out = resourceSuggestions(world([...FULL_110, load("wc-110", W45, 20), op10, op20]));
    // Op 10: 120 in W43. Op 20's floor is Op 10's W45 on 110, where 110 is
    // not pushed by load beyond W45 — the bare 110 from W45 is W45 too.
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.toWeek])).toEqual([[10, "120", W43]]);
  });

  it("books nothing: two operations may be suggested the same free week", () => {
    // 120 has room for ONE 30 h operation in W43, yet both get it.
    const a = op("TO-1", 10, 30, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 30]) });
    const b = op("TO-2", 10, 30, { resources: ALTERNATIVES, plannedWeeks: weeks([W46, 30]) });
    const out = resourceSuggestions(world([...FULL_110, load("wc-130", W43, 40), a, b]));
    expect(out.map((s) => [s.orderNumber, s.toCode, s.toWeek])).toEqual([
      ["TO-1", "120", W43],
      ["TO-2", "120", W43],
    ]);
  });

  it("is deterministic: the same input in any order gives the same förslag", () => {
    const ops = [
      ...FULL_110,
      load("wc-120", W43, 20),
      op("TO-3", 10, 10, { resources: ALTERNATIVES, plannedWeeks: weeks([W45, 10]) }),
      op("TO-1", 10, 30, { resources: ALTERNATIVES, plannedWeeks: null }),
      op("TO-2", 20, 15, { resources: ALTERNATIVES, plannedWeeks: weeks([W46, 15]) }),
      op("TO-2", 10, 5, { workCenterId: "wc-140", plannedWeeks: weeks([W44, 5]) }),
      load("wc-140", W43, 40),
    ];
    const first = resourceSuggestions(world(ops));
    expect(first.map((s) => [s.orderNumber, s.sequenceNo, s.toCode, s.toWeek])).toEqual([
      ["TO-1", 10, "130", W43],
      ["TO-2", 20, "120", W44],
      ["TO-3", 10, "120", W43],
    ]);
    expect(resourceSuggestions(world([...ops].reverse()))).toEqual(first);
    expect(resourceSuggestions(world(ops))).toEqual(first);
  });
});
