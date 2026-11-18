import { describe, expect, it } from "vitest";
import type { PlanWorkCenter } from "../src/modules/planning/service/capacity-book.js";
import { planProduction } from "../src/modules/planning/service/production-plan.js";
import { operationStarted, type CapacityOperationRow, type OperationResourceOption, type PlannedDay } from "../src/modules/planning/service/capacity-calc.js";
import {
  mayGetResourceSuggestion,
  resourceSuggestions,
  type SuggestionWorld,
} from "../src/modules/planning/service/resource-suggestions.js";

// Förslag på alternativ resurs (#15, etapp 2; in days since #18) — pure, no
// database. Monday 2026-10-19 is today. Every own resource works Mon–Fri,
// 8 h a day. 110 is the ordinarie, 120 and 130 its alternatives, 140 a
// resource without alternatives, 900 a legoresurs.
const TODAY = "2026-10-19";
const MON = "2026-10-19";
const TUE = "2026-10-20";
const WED = "2026-10-21";
const THU = "2026-10-22";
const FRI = "2026-10-23";

const machine = (workCenterId: string, code: string, name: string, extra: Partial<PlanWorkCenter> = {}): PlanWorkCenter => ({
  workCenterId,
  code,
  name,
  type: "machine",
  weekScheduleId: "ws-40",
  hoursPerDay: null,
  capacityFactor: 1,
  leadTimeDays: null,
  queueTimeDays: null,
  active: true,
  ...extra,
});
const r110 = machine("wc-110", "110", "Kantpress");
const r120 = machine("wc-120", "120", "Kantpress 2");
const r130 = machine("wc-130", "130", "Kantpress 3");
const r140 = machine("wc-140", "140", "Svets");
const lego = machine("wc-900", "900", "Ytbehandling", { type: "subcontract", weekScheduleId: null, leadTimeDays: 10 });

const h = (hours: number) => hours * 60;
const days = (...list: [string, number][]): PlannedDay[] => list.map(([date, hours]) => ({ date, minutes: h(hours) }));

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

// Load that is not a candidate: `hours` planned on a resource on a day.
const load = (workCenterId: string, date: string, hours: number, n = 0) =>
  op(`LOAD-${workCenterId}-${date}-${n}`, 10, hours, { workCenterId, plannedDays: days([date, hours]) });

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
    queueDays: 0,
    ...extra,
  };
}

// 110 is full Monday and Tuesday: free from Wednesday.
const FULL_110 = [load("wc-110", MON, 8), load("wc-110", TUE, 8)];

describe("resourceSuggestions — when the current resource is full", () => {
  it("suggests the alternative ready on the earliest day when the load pushes the stored klar-dag", () => {
    // 110 is booked Mon–Tue, so the operation's plan is Wednesday; bare it would be today.
    const candidate = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([WED, 4]) });
    expect(resourceSuggestions(world([...FULL_110, load("wc-120", MON, 8), candidate]))).toEqual([
      {
        moOperationId: "TO-1:10",
        manufacturingOrderId: "mo-TO-1",
        orderNumber: "TO-1",
        sequenceNo: 10,
        fromWorkCenterId: "wc-110",
        fromCode: "110",
        // 120 is full today (Tuesday), 130 is free (today) — a day won is a day won.
        toWorkCenterId: "wc-130",
        toCode: "130",
        toName: "Kantpress 3",
        currentToDate: WED,
        toDate: MON,
        reason: "overloaded",
      },
    ]);
  });

  it("gives nothing when the current resource is not full, even if an alternative is faster", () => {
    // 12 h: two days on an empty 110 — the stored plan is the bare plan.
    const candidate = op("TO-1", 10, 12, { resources: ALTERNATIVES, plannedDays: days([MON, 8], [TUE, 4]), altHours: { "wc-120": 4 } });
    expect(resourceSuggestions(world([candidate]))).toEqual([]);
  });

  it("keeps the current resource on a tie in day, and takes the lowest rank on a tie between alternatives", () => {
    const candidate = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([TUE, 4]) });
    // 110 is full today (stored Tuesday); 120 and 130 too: nothing earlier.
    expect(resourceSuggestions(world([load("wc-110", MON, 8), load("wc-120", MON, 8), load("wc-130", MON, 8), candidate]))).toEqual([]);
    // 120 and 130 both free: the same day, rank 1 wins.
    expect(resourceSuggestions(world([load("wc-110", MON, 8), candidate])).map((s) => [s.toCode, s.toDate])).toEqual([["120", MON]]);
  });

  it("measures an unplanned operation by its trial: pushed by the load ⇒ a förslag, free ⇒ none", () => {
    const candidate = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: null });
    expect(resourceSuggestions(world([...FULL_110, candidate]))).toEqual([
      expect.objectContaining({ toCode: "120", currentToDate: null, toDate: MON, reason: "unplanned" }),
    ]);
    // An empty 110 takes it today: never planned is not the same as full.
    expect(resourceSuggestions(world([candidate]))).toEqual([]);
  });

  it("gives nothing for a stale plan: the load, not the plan's age, decides (another TO cancelled)", () => {
    // The plan is Wednesday because 110 WAS full Mon–Tue; that TO is gone, so
    // a trial now finishes today like the bare 110 — no "overloaded".
    const candidate = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([WED, 4]) });
    expect(resourceSuggestions(world([...FULL_110, candidate]))).toHaveLength(1);
    expect(resourceSuggestions(world([candidate]))).toEqual([]);
  });

  it("compares with the trial when the load now finishes the stored plan earlier", () => {
    // Stored Thursday, but with the load as it is the operation finishes
    // Wednesday on 110 (Mon–Tue full): full all the same, and the förslag says Wednesday.
    const candidate = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([THU, 4]) });
    expect(resourceSuggestions(world([...FULL_110, candidate])).map((s) => [s.toCode, s.currentToDate, s.toDate, s.reason])).toEqual([
      ["120", WED, MON, "overloaded"],
    ]);
  });

  it("a stored plan whose days have passed is no plan: the trial decides, and the reason is the load", () => {
    // Planned last Thursday and not worked. 110 is full Mon–Tue, so it would
    // be Wednesday now; 120 is free today.
    const candidate = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days(["2026-10-15", 4]) });
    expect(resourceSuggestions(world([...FULL_110, candidate])).map((s) => [s.toCode, s.currentToDate, s.toDate])).toEqual([["120", WED, MON]]);
    // Nothing else on 110: its own passed load (lying on today) is not its competitor.
    expect(resourceSuggestions(world([candidate]))).toEqual([]);
  });

  it("tries the alternatives with their own times", () => {
    // 120 has 2 h left today: som ordinarie (4 h) it ends Tuesday like the
    // base, with its own 2 h it fits today.
    const base = [load("wc-110", MON, 8), load("wc-120", MON, 6), load("wc-130", MON, 8)];
    const som = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([TUE, 4]) });
    expect(resourceSuggestions(world([...base, som]))).toEqual([]);
    const own = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([TUE, 4]), altHours: { "wc-120": 2 } });
    expect(resourceSuggestions(world([...base, own])).map((s) => [s.toCode, s.toDate])).toEqual([["120", MON]]);
  });

  it("never tries an inactive alternative or one without capacity", () => {
    const candidate = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([WED, 4]) });
    const workCenters = new Map(
      [r110, { ...r120, active: false }, { ...r130, weekScheduleId: null }, r140, lego].map((w) => [w.workCenterId, w])
    );
    expect(resourceSuggestions(world([...FULL_110, candidate], { workCenters }))).toEqual([]);
  });

  it("suggests the way back to the ordinarie for an operation on an alternative that is not Vald för hand", () => {
    const candidate = op("TO-1", 10, 4, { workCenterId: "wc-120", resources: ALTERNATIVES, plannedDays: days([WED, 4]) });
    const out = resourceSuggestions(world([load("wc-120", MON, 8), load("wc-120", TUE, 8), load("wc-130", MON, 8), candidate]));
    expect(out.map((s) => [s.fromCode, s.toCode, s.toDate])).toEqual([["120", "110", MON]]);
  });
});

describe("resourceSuggestions — which operations", () => {
  const full = (extra: Partial<CapacityOperationRow>) =>
    resourceSuggestions(world([...FULL_110, op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([WED, 4]), ...extra })]));

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
    const legoOp = op("TO-1", 10, 4, { workCenterId: "wc-900", resources: ALTERNATIVES, plannedDays: null });
    expect(resourceSuggestions(world([...FULL_110, legoOp]))).toEqual([]);
  });

  it("gives an operation without alternatives nothing — the world is not even read", () => {
    const plain = op("TO-1", 10, 4, { plannedDays: days([WED, 4]) });
    expect(mayGetResourceSuggestion(plain)).toBe(false);
    expect(resourceSuggestions(world([...FULL_110, plain]))).toEqual([]);
  });

  it("narrows to the given orders", () => {
    const a = op("TO-1", 10, 2, { resources: ALTERNATIVES, plannedDays: days([WED, 2]) });
    const b = op("TO-2", 10, 2, { resources: ALTERNATIVES, plannedDays: days([WED, 2]) });
    expect(resourceSuggestions(world([...FULL_110, a, b]), new Set(["mo-TO-2"])).map((s) => s.orderNumber)).toEqual(["TO-2"]);
    expect(resourceSuggestions(world([...FULL_110, a, b])).map((s) => s.orderNumber)).toEqual(["TO-1", "TO-2"]);
  });
});

// Byt till X replans the one order with Planera's rules (replanOrderInTx) —
// every other order is existing load. The day the switched operation gets.
function dayAfterSwitch(w: SuggestionWorld, orderNumber: string, sequenceNo: number, toWorkCenterId: string): string | undefined {
  const mine = w.operations.filter((o) => o.orderNumber === orderNumber);
  const replanned = planProduction({
    today: w.today,
    offDays: w.offDays,
    workCenters: w.workCenters,
    schedule: w.schedule,
    queueDays: w.queueDays,
    orders: [
      {
        id: `mo-${orderNumber}`,
        orderNumber,
        dueDate: null,
        operations: mine.map((o) => ({
          ...(o.sequenceNo === sequenceNo ? { ...o, workCenterId: toWorkCenterId, resourceLocked: true } : o),
          // Planera's own påbörjad-rule (groupOrders in the service).
          started: operationStarted(o, o.stamped === true),
        })),
      },
    ],
    existingOperations: w.operations.filter((o) => o.orderNumber !== orderNumber),
  });
  return replanned.plans.find((p) => p.operationId === `${orderNumber}:${sequenceNo}`)?.endDate;
}

describe("resourceSuggestions — the floor and the walk", () => {
  it("starts the working day after the previous operation's klar-dag, plus the Standardkötid", () => {
    // Op 10 on 140 is Wednesday (140 is full Mon–Tue); Op 20 on 110 is
    // stored Friday (110 full Thursday). 120 is free.
    const op10 = op("TO-1", 10, 4, { workCenterId: "wc-140", plannedDays: days([WED, 4]) });
    const op20 = op("TO-1", 20, 4, { resources: ALTERNATIVES, plannedDays: days([FRI, 4]) });
    const ops = [load("wc-140", MON, 8), load("wc-140", TUE, 8), load("wc-110", THU, 8), op10, op20];
    const out = resourceSuggestions(world(ops));
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.currentToDate, s.toDate])).toEqual([[20, "120", FRI, THU]]);
    // With a queue of one day the floor is Friday — where 110 is free: no förslag.
    expect(resourceSuggestions(world(ops, { queueDays: 1 }))).toEqual([]);
  });

  it("measures the previous operation like the base: one that finished early, or whose stored day is stale, does not hold the floor", () => {
    // Op 10 was planned Wednesday and is done already: Op 20's stored
    // Thursday is stale, 110 is empty — a trial finishes today, so no förslag.
    const done10 = op("TO-1", 10, 4, { workCenterId: "wc-140", plannedDays: days([WED, 4]), operationStatus: "done", quantityCompleted: 1 });
    const op20 = op("TO-1", 20, 4, { resources: ALTERNATIVES, plannedDays: days([THU, 4]) });
    expect(resourceSuggestions(world([done10, op20]))).toEqual([]);
    // Pending but stale (140 is empty now): the floor follows Op 10's trial
    // (today), not its stored Wednesday — and from Tuesday 110 is free.
    const stale10 = op("TO-1", 10, 4, { workCenterId: "wc-140", plannedDays: days([WED, 4]) });
    expect(resourceSuggestions(world([stale10, op20]))).toEqual([]);
  });

  it("does not take a previous operation whose days have passed as ready today", () => {
    // Op 10 on 140 was planned last Thursday and has 12 h left; 140 is full
    // today, so it is ready Wednesday — not "today", as the clamped stored
    // day would say. Op 20 (stored Friday, 110 full Thursday) is measured
    // from Thursday: 120 is free there, so the förslag is Thursday, not Tuesday.
    const op10 = op("TO-1", 10, 12, { workCenterId: "wc-140", plannedDays: days(["2026-10-15", 12]) });
    const op20 = op("TO-1", 20, 4, { resources: ALTERNATIVES, plannedDays: days([FRI, 4]) });
    const w = world([load("wc-140", MON, 8), load("wc-110", THU, 8), op10, op20]);
    const out = resourceSuggestions(w);
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.currentToDate, s.toDate])).toEqual([[20, "120", FRI, THU]]);
    expect(dayAfterSwitch(w, "TO-1", 20, "wc-120")).toBe(THU);
  });

  it.each([
    [0, WED],
    [1, THU],
  ])("starts after where Planera puts an overbooked previous operation — Byt gives exactly the förslag's day (queue %s)", (queueDays, expected) => {
    // Op 10 on 140 is stored today, but 140 is full today now (another TO
    // came in on a locked day): its trial is Tuesday. Op 20 on 110 is stored
    // Friday (110 full Tue–Thu); 120 is free. A floor from Op 10's stored
    // Monday would promise 120 a day early — after the switch the order is
    // replanned with Planera's rules, Op 10 lands on Tuesday and Op 20 after it.
    const op10 = op("TO-1", 10, 4, { workCenterId: "wc-140", plannedDays: days([MON, 4]) });
    const op20 = op("TO-1", 20, 4, { resources: ALTERNATIVES, plannedDays: days([FRI, 4]) });
    const others = [load("wc-140", MON, 8), load("wc-110", TUE, 8), load("wc-110", WED, 8), load("wc-110", THU, 8)];
    const w = world([...others, op10, op20], { queueDays });
    const out = resourceSuggestions(w);
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.currentToDate, s.toDate])).toEqual([[20, "120", FRI, expected]]);
    expect(dayAfterSwitch(w, "TO-1", 20, "wc-120")).toBe(out[0]!.toDate);
  });

  it("measures against the load Byt replans against: the order's own other operations are not in its way (#18)", () => {
    // Op 10 (110) is stored today, but 110 is full today now: Planera puts
    // it on Tuesday. Op 20 (110, never planned) lies on its due date —
    // Tuesday — in the load, but a replanning takes the whole order out
    // first, so it does not push Op 10 to Wednesday. Op 20 may start
    // Wednesday: 110 is full then, 120 free.
    const op10 = op("TO-1", 10, 4, { plannedDays: days([MON, 4]) });
    const op20 = op("TO-1", 20, 8, { resources: ALTERNATIVES, dueDate: TUE });
    for (const [queueDays, expected] of [[0, WED], [1, THU]] as const) {
      const w = world([load("wc-110", MON, 8), load("wc-110", WED, 8), load("wc-110", THU, 8), op10, op20], { queueDays });
      const out = resourceSuggestions(w);
      expect(out.map((s) => [s.sequenceNo, s.toCode, s.currentToDate, s.toDate, s.reason])).toEqual([[20, "120", null, expected, "unplanned"]]);
      expect(dayAfterSwitch(w, "TO-1", 20, "wc-120")).toBe(expected);
    }
  });

  it("a previous operation that is stamped in but has nothing reported is påbörjad, as in Planera: it is today, and the floor follows", () => {
    // Op 10 on 140 is today. Op 20 on 140 would wait for it (Tuesday), but
    // it is begun already — an open stamp, nothing reported — and Planera
    // forces a påbörjad operation to today. So Op 30 may start Tuesday: 110
    // is full then (stored Wednesday), 120 is free ⇒ a förslag for Tuesday,
    // the day Byt gives.
    const op10 = op("TO-1", 10, 4, { workCenterId: "wc-140", plannedDays: days([MON, 4]) });
    const op20 = (date: string, extra: Partial<CapacityOperationRow>) =>
      op("TO-1", 20, 4, { workCenterId: "wc-140", plannedDays: days([date, 4]), ...extra });
    const op30 = op("TO-1", 30, 4, { resources: ALTERNATIVES, plannedDays: days([WED, 4]) });
    const stampedIn = world([load("wc-110", TUE, 8), op10, op20(MON, { stamped: true }), op30]);
    const out = resourceSuggestions(stampedIn);
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.currentToDate, s.toDate])).toEqual([[30, "120", WED, TUE]]);
    expect(dayAfterSwitch(stampedIn, "TO-1", 30, "wc-120")).toBe(TUE);
    // The same with something reported (the rule's other half).
    const reported = world([load("wc-110", TUE, 8), op10, op20(MON, { quantityScrapped: 1 }), op30]);
    expect(resourceSuggestions(reported).map((s) => [s.sequenceNo, s.toCode, s.toDate])).toEqual([[30, "120", TUE]]);
    // Not begun: Op 20 is Tuesday and Op 30 may start Wednesday, where 110
    // is free — no förslag, and a Byt would give Wednesday too.
    const waiting = world([load("wc-110", TUE, 8), op10, op20(TUE, {}), op30]);
    expect(resourceSuggestions(waiting)).toEqual([]);
    expect(dayAfterSwitch(waiting, "TO-1", 30, "wc-120")).toBe(WED);
  });

  it("not overbooked: the floor follows the previous operation's own day", () => {
    const op10 = op("TO-1", 10, 4, { workCenterId: "wc-140", plannedDays: days([MON, 4]) });
    const op20 = op("TO-1", 20, 4, { resources: ALTERNATIVES, plannedDays: days([FRI, 4]) });
    const w = world([load("wc-110", TUE, 8), load("wc-110", WED, 8), load("wc-110", THU, 8), op10, op20]);
    expect(resourceSuggestions(w).map((s) => [s.sequenceNo, s.toCode, s.toDate])).toEqual([[20, "120", TUE]]);
    expect(dayAfterSwitch(w, "TO-1", 20, "wc-120")).toBe(TUE);
  });

  it("counts the gaps exactly as Planera does: done operations and operations without time take no place", () => {
    // Queue 0.5: the first gap waits a day, the second none. Op 5 is done
    // and Op 15 has no time — if either counted as a gap the floors would
    // shift and the förslag would promise a day Byt does not give.
    const ops = [
      op("TO-1", 5, 2, { workCenterId: "wc-140", operationStatus: "done", quantityCompleted: 1 }),
      op("TO-1", 10, 2, { workCenterId: "wc-140", plannedDays: days([MON, 2]) }),
      op("TO-1", 15, 0, { workCenterId: "wc-140" }),
      op("TO-1", 20, 2, { workCenterId: "wc-140", plannedDays: days([WED, 2]) }),
      op("TO-1", 30, 4, { resources: ALTERNATIVES, plannedDays: days([FRI, 4]) }),
      load("wc-110", THU, 8),
    ];
    for (const queueDays of [0, 0.5, 1, 1.5]) {
      const w = world(ops, { queueDays });
      const out = resourceSuggestions(w);
      // 110 is only full on Thursday: a förslag exactly when Op 30's floor is Thursday.
      if (out.length > 0) expect(dayAfterSwitch(w, "TO-1", 30, "wc-120")).toBe(out[0]!.toDate);
      expect([queueDays, out.map((s) => s.toDate)]).toEqual([queueDays, queueDays === 0.5 ? [THU] : []]);
    }
    // Queue 1.5 (gaps 2, 1): Op 20 may start Thursday, Op 30 Monday 26 —
    // where 110 is full. Had the empty Op 15 been a gap, Op 30's floor would
    // be Tuesday 27 and there would be no förslag.
    const later = world(
      [...ops.slice(0, 4), op("TO-1", 30, 4, { resources: ALTERNATIVES, plannedDays: days(["2026-10-27", 4]) }), load("wc-110", "2026-10-26", 8)],
      { queueDays: 1.5 }
    );
    expect(resourceSuggestions(later).map((s) => [s.sequenceNo, s.currentToDate, s.toDate])).toEqual([[30, "2026-10-27", "2026-10-26"]]);
    expect(dayAfterSwitch(later, "TO-1", 30, "wc-120")).toBe("2026-10-26");
  });

  it("starts after a lego operation's lead time", () => {
    // Sent today, 10 working days: back Monday 2 Nov — Op 20 may start Tuesday 3 Nov.
    const op10 = op("TO-1", 10, 0, { workCenterId: "wc-900" });
    const op20 = op("TO-1", 20, 4, { resources: ALTERNATIVES, plannedDays: days(["2026-11-04", 4]) });
    const w = world([load("wc-110", "2026-11-03", 8), op10, op20]);
    const out = resourceSuggestions(w);
    expect(out.map((s) => [s.toCode, s.toDate])).toEqual([["120", "2026-11-03"]]);
    expect(dayAfterSwitch(w, "TO-1", 20, "wc-120")).toBe("2026-11-03");
  });

  it("gives nothing after an own operation with time but no plan — Planera's horizonHit", () => {
    // Op 10 did not fit (or was never planned): Planera plans nothing after
    // it, so Op 20 gets no förslag even though 110 is full and 120 free.
    const op10 = op("TO-1", 10, 4, { workCenterId: "wc-140", plannedDays: null });
    const op20 = op("TO-1", 20, 4, { resources: ALTERNATIVES, plannedDays: days([WED, 4]) });
    expect(resourceSuggestions(world([...FULL_110, op10, op20]))).toEqual([]);
    // The unplanned operation itself may still get one, and the first
    // operation starts today.
    const first = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: null });
    expect(resourceSuggestions(world([...FULL_110, first, op20])).map((s) => [s.sequenceNo, s.reason, s.toDate])).toEqual([[10, "unplanned", MON]]);
    // A lego operation or one without time left is no such stop.
    const empty10 = op("TO-1", 10, 0, { workCenterId: "wc-140", plannedDays: null });
    expect(resourceSuggestions(world([...FULL_110, empty10, op20])).map((s) => [s.sequenceNo, s.toDate])).toEqual([[20, MON]]);
  });

  it("suggests for several operations in sequence, each from the plan of the one before (not from its förslag)", () => {
    const op10 = op("TO-1", 10, 4, { resources: ALTERNATIVES, plannedDays: days([WED, 4]) });
    const op20 = op("TO-1", 20, 4, { resources: ALTERNATIVES, plannedDays: days([THU, 4]) });
    const out = resourceSuggestions(world([...FULL_110, op10, op20]));
    // Op 10: 120 today. Op 20's floor follows Op 10's Wednesday on 110,
    // and from Thursday 110 is not pushed by any load.
    expect(out.map((s) => [s.sequenceNo, s.toCode, s.toDate])).toEqual([[10, "120", MON]]);
  });

  it("books nothing: two operations may be suggested the same free day", () => {
    // 120 has room for ONE 6 h operation today, yet both get it.
    const a = op("TO-1", 10, 6, { resources: ALTERNATIVES, plannedDays: days([WED, 6]) });
    const b = op("TO-2", 10, 6, { resources: ALTERNATIVES, plannedDays: days([WED, 2], [THU, 4]) });
    const out = resourceSuggestions(world([...FULL_110, load("wc-130", MON, 8), a, b]));
    expect(out.map((s) => [s.orderNumber, s.toCode, s.toDate])).toEqual([
      ["TO-1", "120", MON],
      ["TO-2", "120", MON],
    ]);
  });

  it("is deterministic: the same input in any order gives the same förslag", () => {
    const ops = [
      ...FULL_110,
      load("wc-120", MON, 4),
      op("TO-3", 10, 8, { resources: ALTERNATIVES, plannedDays: days([WED, 8]) }),
      op("TO-1", 10, 6, { resources: ALTERNATIVES, plannedDays: null }),
      op("TO-2", 20, 3, { resources: ALTERNATIVES, plannedDays: days([THU, 3]) }),
      op("TO-2", 10, 2, { workCenterId: "wc-140", plannedDays: days([TUE, 2]) }),
      load("wc-140", MON, 8),
    ];
    const first = resourceSuggestions(world(ops));
    expect(first.map((s) => [s.orderNumber, s.sequenceNo, s.toCode, s.toDate])).toEqual([
      ["TO-1", 10, "130", MON],
      ["TO-2", 20, "120", WED],
      ["TO-3", 10, "130", MON],
    ]);
    expect(resourceSuggestions(world([...ops].reverse()))).toEqual(first);
    expect(resourceSuggestions(world(ops))).toEqual(first);
  });
});
