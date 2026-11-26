import { describe, expect, it } from "vitest";
import {
  resourceDayLoads,
  type CapacityOperationRow,
  type CapacityWorkCenter,
} from "../src/modules/planning/service/capacity-calc.js";
import { buildDayPlan, DAY_PLAN_MAX_AHEAD_DAYS } from "../src/modules/planning/service/day-plan.js";
import { buildRunPlan, type RunPlanMaterial } from "../src/modules/planning/service/run-plan.js";

// Dagplan (pure): every figure is the körplan's for the same resource and
// day — buildDayPlan only selects, groups and sums.

// Wednesday 2030-03-06 (ISO week 10); Friday the 8th is a röd dag here.
const TODAY = "2030-03-06";
const THU = "2030-03-07";
const FRI = "2030-03-08";
const MON = "2030-03-11";
const TUE = "2030-03-12";
const OFF_DAYS = new Set([FRI]);

const wc = (workCenterId: string, code: string, over: Partial<CapacityWorkCenter> = {}): CapacityWorkCenter => ({
  workCenterId,
  code,
  name: `Resurs ${code}`,
  type: "machine",
  productionGroupId: null,
  weekScheduleId: null,
  hoursPerDay: 8,
  capacityFactor: 1,
  active: true,
  ...over,
});

let seq = 0;
// 30 min setup + 10 × 2 min = 50 min each.
const op = (over: Partial<CapacityOperationRow>): CapacityOperationRow => {
  seq += 1;
  return {
    moOperationId: `op-${seq}`,
    manufacturingOrderId: `mo-${seq}`,
    orderNumber: `TO-${seq}`,
    articleNumber: "A",
    articleName: "Artikel",
    workCenterId: "kap",
    orderQuantity: 10,
    dueDate: null,
    sequenceNo: 10,
    setupTime: 30,
    runTimePerUnit: 2,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
    ...over,
  };
};
const planned = (date: string, over: Partial<CapacityOperationRow> = {}) =>
  op({ dueDate: "2030-04-30", plannedDays: [{ date, minutes: 50 }], ...over });

const WORK_CENTERS = [
  wc("svets", "200", { productionGroupId: "g-2" }),
  wc("kap", "100", { productionGroupId: "g-1" }),
  wc("grad", "90", { productionGroupId: "g-1" }),
  wc("lego", "900", { type: "subcontract" }),
  wc("gammal", "300", { active: false }),
];
const GROUPS = [
  { productionGroupId: "g-2", code: "B", name: "Svetsning" },
  { productionGroupId: "g-1", code: "A", name: "Kapning" },
];

const dayPlan = (
  date: string,
  operations: CapacityOperationRow[],
  over: Partial<Parameters<typeof buildDayPlan>[0]> = {}
) =>
  buildDayPlan({
    today: TODAY,
    date,
    offDays: OFF_DAYS,
    workCenters: WORK_CENTERS,
    productionGroups: GROUPS,
    productionGroupId: null,
    operations,
    dayLoads: resourceDayLoads(
      { workCenters: WORK_CENTERS, operations, weekScheduleDays: [], daySchedules: [], holidays: [{ date: FRI, dayScheduleId: null }] },
      TODAY,
      date
    ),
    materials: new Map(),
    stamps: new Map(),
    present: new Map(),
    ...over,
  });

const resource = (result: ReturnType<typeof buildDayPlan>, id: string) => result.resources.find((r) => r.workCenter.id === id)!;

const material = (over: Partial<RunPlanMaterial>): RunPlanMaterial => ({
  articleId: "m-1",
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

describe("buildDayPlan — resources", () => {
  it("lists the körplan's stations (active, never lego) in station order, also without rows", () => {
    const result = dayPlan(TODAY, []);
    expect(result.resources.map((r) => r.workCenter)).toEqual([
      { id: "grad", code: "90", name: "Resurs 90" },
      { id: "kap", code: "100", name: "Resurs 100" },
      { id: "svets", code: "200", name: "Resurs 200" },
    ]);
    expect(result.resources.map((r) => r.productionGroupId)).toEqual(["g-1", "g-1", "g-2"]);
    expect(resource(result, "kap")).toMatchObject({ carried: [], rows: [], rowHours: 0, unplannedRows: 0, present: [] });
    expect(result.productionGroups).toEqual([
      { id: "g-1", code: "A", name: "Kapning" },
      { id: "g-2", code: "B", name: "Svetsning" },
    ]);
    expect(result.totals).toEqual({ rows: 0, hours: 0, unlinkedOperations: 0, shortMaterials: 0 });
  });

  it("the group filter is a selection: an unknown group gives no resources, the groups stay", () => {
    const operations = [planned(TODAY), planned(TODAY, { workCenterId: "svets" })];
    const one = dayPlan(TODAY, operations, { productionGroupId: "g-2" });
    expect(one.resources.map((r) => r.workCenter.code)).toEqual(["200"]);
    expect(one.totals.rows).toBe(1);
    const none = dayPlan(TODAY, operations, { productionGroupId: "g-x" });
    expect(none.resources).toEqual([]);
    expect(none.productionGroups).toHaveLength(2);
  });

  it("carries the handed-in load and the present per resource", () => {
    const operations = [planned(TODAY)];
    const present = new Map([["kap", [{ employeeId: "e-1", name: "Anna" }]]]);
    const result = dayPlan(TODAY, operations, { present });
    expect(resource(result, "kap").load).toEqual({ date: TODAY, loadHours: 0.83, availableHours: 8, overloaded: false });
    expect(resource(result, "kap").present).toEqual([{ employeeId: "e-1", name: "Anna" }]);
    expect(resource(result, "svets").present).toEqual([]);
  });
});

describe("buildDayPlan — rows", () => {
  it("the day's rows are buildRunPlan's for the same resource and day: same order, same reorderable", () => {
    const multi = op({ dueDate: "2030-04-30", sequenceNo: 10 });
    const operations = [
      planned(THU, { orderNumber: "TO-C", runPosition: 2 }),
      planned(THU, { orderNumber: "TO-B", runPosition: 1 }),
      planned(THU, { orderNumber: "TO-A" }), // no place: after the ordered ones
      // Unplanned on its due date: on the day, not reorderable.
      op({ orderNumber: "TO-D", dueDate: THU }),
      // The whole order counts for the readiness: op 20 waits for op 10 at another resource.
      { ...multi, workCenterId: "svets" },
      { ...multi, moOperationId: "op-multi-20", sequenceNo: 20, plannedDays: [{ date: THU, minutes: 50 }], orderNumber: "TO-E" },
      planned(MON, { orderNumber: "TO-LATER" }),
      planned(THU, { orderNumber: "TO-OTHER", workCenterId: "grad" }),
    ];
    const result = dayPlan(THU, operations);
    const kap = WORK_CENTERS.find((w) => w.workCenterId === "kap")!;
    const runPlan = buildRunPlan({
      today: TODAY,
      toDate: THU,
      workCenter: { id: "kap", code: kap.code, name: kap.name, type: kap.type, active: kap.active },
      stations: [],
      operations,
      plannedOrderOperations: [],
    });
    const expected = runPlan.rows.filter((r) => r.date === THU);
    expect(resource(result, "kap").rows).toEqual(expected);
    expect(resource(result, "kap").rows.map((r) => [r.orderNumber, r.reorderable, r.status])).toEqual([
      ["TO-B", true, "ready"],
      ["TO-C", true, "ready"],
      ["TO-D", false, "ready"],
      ["TO-A", true, "ready"],
      ["TO-E", true, "not_ready"],
    ]);
    expect(resource(result, "kap").rows.at(-1)).toMatchObject({ waitingForSequenceNo: 10 });
    expect(resource(result, "kap").carried).toEqual([]);
    expect(resource(result, "grad").rows.map((r) => r.orderNumber)).toEqual(["TO-OTHER"]);
    // 5 × 50 min.
    expect(resource(result, "kap").rowHours).toBe(4.17);
    // Kap's five and Gradning's one; op 10 at Svets lies on its due date, another day.
    expect(result.totals).toMatchObject({ rows: 6, hours: 5 });
  });

  it("today: carried is the körplan's Försenad — a passed plan and a passed due date", () => {
    const operations = [
      planned("2030-03-04", { orderNumber: "TO-OLD" }),
      op({ orderNumber: "TO-DUE", dueDate: "2030-03-05" }),
      planned(TODAY, { orderNumber: "TO-NOW" }),
      planned(THU, { orderNumber: "TO-TOMORROW" }),
    ];
    const kap = resource(dayPlan(TODAY, operations), "kap");
    expect(kap.carried.map((r) => [r.orderNumber, r.late])).toEqual([
      ["TO-OLD", true],
      ["TO-DUE", true],
    ]);
    expect(kap.rows.map((r) => r.orderNumber)).toEqual(["TO-NOW"]);
    expect(kap.rowHours).toBe(2.5);
  });

  it("a later day: carried is a planned operation that started an earlier day and still lies on the day", () => {
    const operations = [
      // Started today, runs over Thursday to Monday.
      op({
        orderNumber: "TO-LONG",
        runTimePerUnit: 100,
        setupTime: 0,
        dueDate: "2030-04-30",
        plannedDays: [
          { date: TODAY, minutes: 400 },
          { date: THU, minutes: 400 },
          { date: MON, minutes: 200 },
        ],
      }),
      // Ended before the day: not carried.
      planned(TODAY, { orderNumber: "TO-SHORT" }),
      // Late and ended before today: lies on today (the bucket rule), never
      // carried to a later day.
      planned("2030-03-04", { orderNumber: "TO-OLD" }),
      // Late (started before today) but planned on into Thursday: its load
      // lies on Thursday too, so Thursday carries it.
      op({
        orderNumber: "TO-RUNNING",
        runTimePerUnit: 100,
        setupTime: 0,
        dueDate: "2030-04-30",
        plannedDays: [
          { date: "2030-03-05", minutes: 400 },
          { date: THU, minutes: 400 },
        ],
      }),
      // Unplanned with an earlier due date: not carried.
      op({ orderNumber: "TO-DUE", dueDate: TODAY }),
      planned(THU, { orderNumber: "TO-THU" }),
    ];
    const thu = resource(dayPlan(THU, operations), "kap");
    expect(thu.carried.map((r) => r.orderNumber).sort()).toEqual(["TO-LONG", "TO-RUNNING"]);
    // Today the running one is Försenad.
    expect(resource(dayPlan(TODAY, operations), "kap").carried.map((r) => r.orderNumber)).toContain("TO-RUNNING");
    expect(thu.rows.map((r) => r.orderNumber)).toEqual(["TO-THU"]);
    const mon = resource(dayPlan(MON, operations), "kap");
    expect(mon.carried.map((r) => r.orderNumber)).toEqual(["TO-LONG"]);
    expect(mon.rows).toEqual([]);
    // The day after the plan's last: nothing left.
    expect(resource(dayPlan(TUE, operations), "kap").carried).toEqual([]);
  });

  it("counts the resource's Ej planerad without listing them", () => {
    const operations = [op({ dueDate: null }), op({ dueDate: null }), op({ dueDate: null, workCenterId: "svets" }), planned(THU)];
    const result = dayPlan(THU, operations);
    expect(resource(result, "kap")).toMatchObject({ unplannedRows: 2 });
    expect(resource(result, "kap").rows).toHaveLength(1);
    expect(resource(result, "svets")).toMatchObject({ unplannedRows: 1, rows: [] });
    expect(resource(result, "grad").unplannedRows).toBe(0);
    expect(result.totals.rows).toBe(1);
  });

  it("puts the materials and the stamps on the rows and sums the totals", () => {
    const linkedOk = planned(TODAY, { moOperationId: "op-ok", orderNumber: "TO-1" });
    const short = planned(TODAY, { moOperationId: "op-short", orderNumber: "TO-2" });
    const unlinked = planned(TODAY, { moOperationId: "op-none", orderNumber: "TO-3" });
    const late = planned("2030-03-04", { moOperationId: "op-late", orderNumber: "TO-0" });
    const materials = new Map([
      ["op-ok", { materials: [material({})], linked: true }],
      [
        "op-short",
        {
          materials: [
            material({ status: "short", usableOnHand: 1, missingQuantity: 3 }),
            material({ articleId: "m-2", articleNumber: "RÖR-30", status: "short", usableOnHand: 0, missingQuantity: 4 }),
          ],
          linked: true,
        },
      ],
      // Linked, but everything drawn: no rows, still linked.
      ["op-late", { materials: [], linked: true }],
    ]);
    const stamps = new Map([["op-ok", [{ employeeId: "e-1", name: "Anna", paused: true }]]]);
    const result = dayPlan(TODAY, [linkedOk, short, unlinked, late], { materials, stamps });
    const kap = resource(result, "kap");
    expect(kap.rows.map((r) => [r.orderNumber, r.materialLinked, r.materials.length, r.activeStamps.length])).toEqual([
      ["TO-1", true, 1, 1],
      ["TO-2", true, 2, 0],
      ["TO-3", false, 0, 0],
    ]);
    expect(kap.rows[0]!.activeStamps).toEqual([{ employeeId: "e-1", name: "Anna", paused: true }]);
    expect(kap.carried.map((r) => [r.orderNumber, r.materialLinked])).toEqual([["TO-0", true]]);
    expect(result.totals).toEqual({ rows: 4, hours: 3.33, unlinkedOperations: 1, shortMaterials: 2 });
  });
});

describe("buildDayPlan — the day and its neighbours", () => {
  it("answers with the day's weekday and ISO week", () => {
    expect(dayPlan(TODAY, [])).toMatchObject({ today: TODAY, date: TODAY, weekday: 3, isoWeek: 10 });
    expect(dayPlan(MON, [])).toMatchObject({ date: MON, weekday: 1, isoWeek: 11 });
  });

  it("previous and next are working days: over the weekend and the röd dag", () => {
    // Thursday → Friday is off, Saturday/Sunday too: Monday.
    expect(dayPlan(THU, [])).toMatchObject({ previousDate: TODAY, nextDate: MON });
    expect(dayPlan(MON, [])).toMatchObject({ previousDate: THU, nextDate: TUE });
    // Standing on the röd dag itself.
    expect(dayPlan(FRI, [])).toMatchObject({ previousDate: THU, nextDate: MON });
  });

  it("never before today and never after the window", () => {
    expect(dayPlan(TODAY, [])).toMatchObject({ previousDate: null, nextDate: THU });
    expect(DAY_PLAN_MAX_AHEAD_DAYS).toBe(41);
    // Today + 41 = Tuesday 2030-04-16.
    const last = "2030-04-16";
    expect(dayPlan(last, [])).toMatchObject({ previousDate: "2030-04-15", nextDate: null });
    expect(dayPlan("2030-04-15", [])).toMatchObject({ nextDate: last });
    // The window ends on a Saturday: Friday has no next day inside it.
    const result = buildDayPlan({
      today: "2030-03-02", // a Saturday; + 41 = Friday 2030-04-12
      date: "2030-04-12",
      offDays: new Set(),
      workCenters: [],
      productionGroups: [],
      productionGroupId: null,
      operations: [],
      dayLoads: new Map(),
      materials: new Map(),
      stamps: new Map(),
      present: new Map(),
    });
    expect(result).toMatchObject({ previousDate: "2030-04-11", nextDate: null });
    // Today is a Saturday: Monday's previous working day (Friday) is before today.
    expect(
      buildDayPlan({
        today: "2030-03-02",
        date: "2030-03-04",
        offDays: new Set(),
        workCenters: [],
        productionGroups: [],
        productionGroupId: null,
        operations: [],
        dayLoads: new Map(),
        materials: new Map(),
        stamps: new Map(),
        present: new Map(),
      })
    ).toMatchObject({ previousDate: null, nextDate: "2030-03-05" });
  });
});
