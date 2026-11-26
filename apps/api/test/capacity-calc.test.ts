import { describe, expect, it } from "vitest";
import {
  buildScheduleLookups,
  computeCapacity,
  loadBucketDay,
  operationLoadDays,
  operationStartDate,
  orderPlanStatus,
  subcontractReadyDate,
  plannedDateRange,
  remainingByPlannedDays,
  remainingOperationMinutes,
  resourceDayLoads,
  resourceDayMinutes,
  setupDoneOnCurrentResource,
  resolveResourceWeekHours,
  routingOperationMinutes,
  type CapacityInput,
  type CapacityOperationRow,
  type CapacityResult,
  type CapacityWorkCenter,
  type PlanStatusWorkCenter,
} from "../src/modules/planning/service/capacity-calc.js";

// Pure calculation tests — no database, no TRUNCATE. This file is the
// authoritative spec for beläggningen (E2).

// Wednesday 2026-08-19 → ISO week 34 (Mon 2026-08-17 … Sun 2026-08-23).
const TODAY = "2026-08-19";

function wc(overrides: Partial<CapacityWorkCenter> & { workCenterId: string }): CapacityWorkCenter {
  return {
    code: "100",
    name: `Resurs ${overrides.workCenterId}`,
    type: "machine",
    productionGroupId: null,
    weekScheduleId: null,
    hoursPerDay: null,
    capacityFactor: 1,
    active: true,
    ...overrides,
  };
}

function op(overrides: Partial<CapacityOperationRow>): CapacityOperationRow {
  return {
    moOperationId: `op-${Math.abs(JSON.stringify(overrides).length)}-${overrides.sequenceNo ?? 10}`,
    manufacturingOrderId: "mo-1",
    orderNumber: "PO-1",
    articleNumber: "ART-1",
    articleName: "Artikel",
    workCenterId: "wc-1",
    orderQuantity: 10,
    dueDate: null,
    sequenceNo: 10,
    setupTime: 0,
    runTimePerUnit: 6,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
    ...overrides,
  };
}

// A plain 40 h week: Mon–Fri on a 480-minute day schedule.
const STD_WEEK = {
  weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({
    weekScheduleId: "ws-40",
    weekday,
    dayScheduleId: "ds-480",
  })),
  daySchedules: [{ id: "ds-480", netMinutes: 480 }],
};

function calcInput(partial: Partial<CapacityInput>): CapacityInput {
  return {
    workCenters: [],
    productionGroups: [],
    operations: [],
    weekScheduleDays: [],
    daySchedules: [],
    holidays: [],
    ...partial,
  };
}

function resourceRow(result: CapacityResult, workCenterId: string) {
  for (const group of result.groups) {
    const row = group.resources.find((r) => r.workCenterId === workCenterId);
    if (row) return row;
  }
  throw new Error(`no resource row for ${workCenterId}`);
}

describe("remainingOperationMinutes", () => {
  it("counts setup + run × quantity for an untouched pending operation", () => {
    expect(remainingOperationMinutes(op({ setupTime: 30, runTimePerUnit: 6, orderQuantity: 10 }))).toBe(90);
  });

  it("drops setup and counts only the remaining quantity once work has started", () => {
    expect(
      remainingOperationMinutes(op({ setupTime: 30, runTimePerUnit: 6, orderQuantity: 10, quantityCompleted: 4 }))
    ).toBe(36);
  });

  it("keeps setup when nothing at all has been reported (explicit zero, no scrap)", () => {
    expect(
      remainingOperationMinutes(op({ setupTime: 30, runTimePerUnit: 6, orderQuantity: 10, quantityCompleted: 0 }))
    ).toBe(90);
  });

  it("drops setup after a scrap-only report — the machine is already set up", () => {
    // reportOperationQuantities writes quantityCompleted "0" on a scrap-only
    // report; 3 scrapped units mean work HAS started even though OK is zero.
    expect(
      remainingOperationMinutes(
        op({ setupTime: 60, runTimePerUnit: 5, orderQuantity: 10, quantityCompleted: 0, quantityScrapped: 3 })
      )
    ).toBe(50); // 5 × 10 remaining, no setup
  });

  // Alternativa resurser (#15): the setup belongs to the resource the
  // operation is on now — the avvikelseanalys's ställregel (time, OK or
  // scrapped = worked) on the current resource.
  it("drops setup once the current resource has reported time, even without a quantity (Ställ klart)", () => {
    expect(
      remainingOperationMinutes(op({ setupTime: 30, runTimePerUnit: 6, orderQuantity: 10, quantityCompleted: 0, timeOnCurrentResource: true }))
    ).toBe(60);
  });

  it("plans the new resource's setup after a Byt resurs: the quantity was worked on another resource", () => {
    const switched = op({ setupTime: 30, runTimePerUnit: 6, orderQuantity: 10, quantityCompleted: 4, timeOnOtherResource: true });
    expect(setupDoneOnCurrentResource(switched)).toBe(false);
    expect(remainingOperationMinutes(switched)).toBe(6 * 6 + 30);
    // Once the new resource has reported time its setup is done.
    expect(remainingOperationMinutes({ ...switched, timeOnCurrentResource: true })).toBe(36);
    // Without any time the quantity decides, as before (left out = no time).
    expect(setupDoneOnCurrentResource(op({ quantityCompleted: 4 }))).toBe(true);
    expect(setupDoneOnCurrentResource(op({ quantityCompleted: 0, timeOnCurrentResource: false, timeOnOtherResource: false }))).toBe(false);
  });

  it("clamps an over-reported operation to zero", () => {
    expect(
      remainingOperationMinutes(op({ setupTime: 30, runTimePerUnit: 6, orderQuantity: 10, quantityCompleted: 12 }))
    ).toBe(0);
  });

  it("returns zero for a done operation even with quantity remaining", () => {
    expect(
      remainingOperationMinutes(
        op({ setupTime: 30, runTimePerUnit: 6, orderQuantity: 10, quantityCompleted: 2, operationStatus: "done" })
      )
    ).toBe(0);
  });
});

describe("resolveResourceWeekHours", () => {
  const base = {
    weekScheduleId: "ws-40",
    capacityFactor: 1,
    isoYear: 2026,
    isoWeek: 34,
    ...STD_WEEK,
    holidays: [] as { date: string; dayScheduleId: string | null }[],
  };

  it("sums a five-day 480-minute week to 40 hours", () => {
    expect(resolveResourceWeekHours(base)).toBe(40);
  });

  it("multiplies by the capacity factor", () => {
    expect(resolveResourceWeekHours({ ...base, capacityFactor: 2 })).toBe(80);
  });

  it("hours per day without a schedule: five days × hours × factor", () => {
    expect(resolveResourceWeekHours({ ...base, weekScheduleId: null, hoursPerDay: 6, capacityFactor: 2 })).toBe(60);
  });

  it("a full-off holiday (röd dag) removes that day", () => {
    // Wednesday 2026-08-19 inside week 34.
    expect(resolveResourceWeekHours({ ...base, holidays: [{ date: "2026-08-19", dayScheduleId: null }] })).toBe(32);
  });

  it("a half-day holiday uses the holiday's own day schedule", () => {
    expect(
      resolveResourceWeekHours({
        ...base,
        daySchedules: [...STD_WEEK.daySchedules, { id: "ds-240", netMinutes: 240 }],
        holidays: [{ date: "2026-08-19", dayScheduleId: "ds-240" }],
      })
    ).toBe(36);
  });

  it("a half-day holiday on a day the schedule has off adds NOTHING — holidays only reduce", () => {
    // Saturday 2026-08-22 is not in the Mon–Fri schedule; a registered
    // half-day holiday there must not conjure capacity out of nothing.
    expect(
      resolveResourceWeekHours({
        ...base,
        daySchedules: [...STD_WEEK.daySchedules, { id: "ds-240", netMinutes: 240 }],
        holidays: [{ date: "2026-08-22", dayScheduleId: "ds-240" }],
      })
    ).toBe(40);
  });

  it("a weekday missing from the week schedule contributes zero", () => {
    const monToThu = STD_WEEK.weekScheduleDays.filter((d) => d.weekday <= 4);
    expect(resolveResourceWeekHours({ ...base, weekScheduleDays: monToThu })).toBe(32);
  });

  it("an empty week schedule yields zero", () => {
    expect(resolveResourceWeekHours({ ...base, weekScheduleDays: [] })).toBe(0);
  });
});

describe("resourceDayMinutes and loadBucketDay (shared with Leveranstidskontrollen)", () => {
  const lookups = buildScheduleLookups(STD_WEEK.weekScheduleDays, STD_WEEK.daySchedules, [
    { date: "2026-08-19", dayScheduleId: null },
  ]);

  it("gives a scheduled day's net minutes, zero on a day off and on a full holiday", () => {
    const ws = { weekScheduleId: "ws-40", hoursPerDay: null };
    expect(resourceDayMinutes(lookups, ws, "2026-08-18")).toBe(480); // Tuesday
    expect(resourceDayMinutes(lookups, ws, "2026-08-22")).toBe(0); // Saturday
    expect(resourceDayMinutes(lookups, ws, "2026-08-19")).toBe(0); // röd dag
  });

  it("hours per day: Monday–Friday, a röd dag off, a kortdag on the holiday's own schedule", () => {
    const withKortdag = buildScheduleLookups([], [{ id: "ds-240", netMinutes: 240 }], [
      { date: "2026-08-19", dayScheduleId: null },
      { date: "2026-08-20", dayScheduleId: "ds-240" },
    ]);
    const h = { weekScheduleId: null, hoursPerDay: 7.5 };
    expect(resourceDayMinutes(withKortdag, h, "2026-08-18")).toBe(450);
    expect(resourceDayMinutes(withKortdag, h, "2026-08-19")).toBe(0);
    expect(resourceDayMinutes(withKortdag, h, "2026-08-20")).toBe(240);
    expect(resourceDayMinutes(withKortdag, h, "2026-08-22")).toBe(0); // Saturday
    expect(resourceDayMinutes(withKortdag, { weekScheduleId: null, hoursPerDay: null }, "2026-08-18")).toBe(0);
  });

  it("the week schedule wins over hours per day", () => {
    expect(resourceDayMinutes(lookups, { weekScheduleId: "ws-40", hoursPerDay: 2 }, "2026-08-18")).toBe(480);
  });

  it("buckets on the due date, a passed one today, undated as null", () => {
    expect(loadBucketDay("2026-08-27", TODAY)).toBe("2026-08-27");
    expect(loadBucketDay(TODAY, TODAY)).toBe(TODAY);
    expect(loadBucketDay("2026-08-18", TODAY)).toBe(TODAY);
    expect(loadBucketDay(null, TODAY)).toBeNull();
  });
});

describe("computeCapacity — week columns", () => {
  it("generates the current ISO week plus the following ones with Monday/Sunday bounds", () => {
    const result = computeCapacity(calcInput({}), { today: TODAY, weeks: 3 });
    expect(result.weeks).toEqual([
      { isoYear: 2026, isoWeek: 34, monday: "2026-08-17", sunday: "2026-08-23" },
      { isoYear: 2026, isoWeek: 35, monday: "2026-08-24", sunday: "2026-08-30" },
      { isoYear: 2026, isoWeek: 36, monday: "2026-08-31", sunday: "2026-09-06" },
    ]);
  });

  it("crosses the year boundary with correct iso years (v.53 2026 → v.1 2027)", () => {
    const result = computeCapacity(calcInput({}), { today: "2026-12-28", weeks: 2 });
    expect(result.weeks).toEqual([
      { isoYear: 2026, isoWeek: 53, monday: "2026-12-28", sunday: "2027-01-03" },
      { isoYear: 2027, isoWeek: 1, monday: "2027-01-04", sunday: "2027-01-10" },
    ]);
  });
});

describe("computeCapacity — load bucketing", () => {
  it("puts load in the due date's week, rolls past-due into the current week and flags overdue", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [
          op({ manufacturingOrderId: "mo-a", orderNumber: "PO-A", dueDate: "2026-08-27", runTimePerUnit: 6 }), // v.35
          op({ manufacturingOrderId: "mo-b", orderNumber: "PO-B", dueDate: "2026-08-10", runTimePerUnit: 12 }), // v.33 — past
        ],
      }),
      { today: TODAY, weeks: 3 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks[1]!.loadHours).toBe(1); // 6 min × 10 / 60
    expect(row.weeks[0]!.loadHours).toBe(2); // 12 min × 10 / 60, rolled forward
    expect(row.weeks[0]!.orders).toEqual([
      expect.objectContaining({ orderNumber: "PO-B", overdue: true, remainingHours: 2, dueDate: "2026-08-10" }),
    ]);
    expect(row.weeks[1]!.orders[0]).toMatchObject({ orderNumber: "PO-A", overdue: false });
  });

  it("marks a due date earlier THIS week as overdue at day granularity", () => {
    // Today is Wednesday 2026-08-19; due Monday 2026-08-17 is in the current
    // week's bucket but already passed — Försenad, per the manual's promise.
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [
          op({ orderNumber: "PO-MON", dueDate: "2026-08-17" }),
          op({ manufacturingOrderId: "mo-2", orderNumber: "PO-FRI", dueDate: "2026-08-21" }),
        ],
      }),
      { today: TODAY, weeks: 1 }
    );
    const orders = resourceRow(result, "wc-1").weeks[0]!.orders;
    expect(orders.find((o) => o.orderNumber === "PO-MON")!.overdue).toBe(true);
    expect(orders.find((o) => o.orderNumber === "PO-FRI")!.overdue).toBe(false);
  });

  it("puts undated load in the undated bucket and beyond-horizon load in later", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [
          op({ manufacturingOrderId: "mo-u", orderNumber: "PO-U", dueDate: null }),
          op({ manufacturingOrderId: "mo-l", orderNumber: "PO-L", dueDate: "2026-10-15" }),
        ],
      }),
      { today: TODAY, weeks: 2 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.undated.loadHours).toBe(1);
    expect(row.undated.availableHours).toBeNull();
    expect(row.later.loadHours).toBe(1);
    expect(row.later.orders[0]!.orderNumber).toBe("PO-L");
  });

  it("excludes done operations and drops zero-remaining order lines", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [
          op({ orderNumber: "PO-DONE", dueDate: "2026-08-19", operationStatus: "done" }),
          op({ orderNumber: "PO-OVER", dueDate: "2026-08-19", quantityCompleted: 15 }),
        ],
      }),
      { today: TODAY, weeks: 1 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks[0]!.loadHours).toBe(0);
    expect(row.weeks[0]!.orders).toEqual([]);
  });
});

describe("computeCapacity — capacity and percent", () => {
  it("computes available hours from the schedule and rounds the percent", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" })],
        ...STD_WEEK,
        operations: [op({ dueDate: "2026-08-19", runTimePerUnit: 27, orderQuantity: 10 })], // 270 min = 4.5 h... use 45h
      }),
      { today: TODAY, weeks: 1 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.hasSchedule).toBe(true);
    expect(row.weeks[0]!.availableHours).toBe(40);
    expect(row.weeks[0]!.loadHours).toBe(4.5);
    expect(row.weeks[0]!.loadPercent).toBe(11); // 4.5/40 = 11.25 → 11
  });

  it("gives 113 % for 45 h load on 40 h capacity", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" })],
        ...STD_WEEK,
        operations: [op({ dueDate: "2026-08-19", runTimePerUnit: 270, orderQuantity: 10 })], // 2700 min = 45 h
      }),
      { today: TODAY, weeks: 1 }
    );
    expect(resourceRow(result, "wc-1").weeks[0]!.loadPercent).toBe(113);
  });

  it("a resource without a schedule shows load but null capacity/percent", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [op({ dueDate: "2026-08-19" })],
      }),
      { today: TODAY, weeks: 1 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.hasSchedule).toBe(false);
    expect(row.weeks[0]!.loadHours).toBe(1);
    expect(row.weeks[0]!.availableHours).toBeNull();
    expect(row.weeks[0]!.loadPercent).toBeNull();
  });

  it("a zero-capacity week (empty schedule) yields percent null, not division by zero", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-empty" })],
        daySchedules: STD_WEEK.daySchedules,
        weekScheduleDays: [], // schedule exists but has no days
        operations: [op({ dueDate: "2026-08-19" })],
      }),
      { today: TODAY, weeks: 1 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks[0]!.availableHours).toBe(0);
    expect(row.weeks[0]!.loadPercent).toBeNull();
  });

  it("applies the capacity factor per week", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40", capacityFactor: 2 })],
        ...STD_WEEK,
      }),
      { today: TODAY, weeks: 1 }
    );
    expect(resourceRow(result, "wc-1").weeks[0]!.availableHours).toBe(80);
  });

  it("holidays reduce the specific week's capacity", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" })],
        ...STD_WEEK,
        holidays: [{ date: "2026-08-19", dayScheduleId: null }], // Wednesday of week 34
      }),
      { today: TODAY, weeks: 2 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks[0]!.availableHours).toBe(32);
    expect(row.weeks[1]!.availableHours).toBe(40);
  });
});

describe("computeCapacity — groups, inclusion and sorting", () => {
  it("groups resources under production groups with subtotals; capacity only from scheduled members", () => {
    const result = computeCapacity(
      calcInput({
        productionGroups: [{ productionGroupId: "pg-1", code: "10", name: "Svets" }],
        workCenters: [
          wc({ workCenterId: "wc-1", code: "101", productionGroupId: "pg-1", weekScheduleId: "ws-40" }),
          wc({ workCenterId: "wc-2", code: "102", productionGroupId: "pg-1" }),
        ],
        ...STD_WEEK,
        operations: [
          op({ workCenterId: "wc-1", dueDate: "2026-08-19", runTimePerUnit: 60 }), // 10 h
          op({ workCenterId: "wc-2", dueDate: "2026-08-19", runTimePerUnit: 30 }), // 5 h
        ],
      }),
      { today: TODAY, weeks: 1 }
    );
    const group = result.groups.find((g) => g.productionGroupId === "pg-1")!;
    expect(group.code).toBe("10");
    expect(group.weekTotals[0]!.loadHours).toBe(15);
    expect(group.weekTotals[0]!.availableHours).toBe(40); // only wc-1 has a schedule
    expect(group.weekTotals[0]!.orders).toEqual([]);
  });

  it("a group where no member has a schedule gets null subtotal capacity", () => {
    const result = computeCapacity(
      calcInput({
        productionGroups: [{ productionGroupId: "pg-1", code: "10", name: "Svets" }],
        workCenters: [wc({ workCenterId: "wc-1", productionGroupId: "pg-1" })],
        operations: [op({ dueDate: "2026-08-19" })],
      }),
      { today: TODAY, weeks: 1 }
    );
    expect(result.groups[0]!.weekTotals[0]!.availableHours).toBeNull();
  });

  it("includes inactive resources only when they carry load; ungrouped resources come last", () => {
    const result = computeCapacity(
      calcInput({
        productionGroups: [{ productionGroupId: "pg-1", code: "10", name: "Svets" }],
        workCenters: [
          wc({ workCenterId: "wc-grouped", code: "101", productionGroupId: "pg-1" }),
          wc({ workCenterId: "wc-inactive-loaded", code: "200", active: false }),
          wc({ workCenterId: "wc-inactive-idle", code: "201", active: false }),
          wc({ workCenterId: "wc-ungrouped", code: "300" }),
        ],
        operations: [op({ workCenterId: "wc-inactive-loaded", dueDate: "2026-08-19" })],
      }),
      { today: TODAY, weeks: 1 }
    );
    expect(result.groups.map((g) => g.name)).toEqual(["Svets", "Ogrupperade resurser"]);
    const ungrouped = result.groups[1]!;
    expect(ungrouped.productionGroupId).toBeNull();
    expect(ungrouped.resources.map((r) => r.workCenterId)).toEqual([
      "wc-inactive-loaded",
      "wc-ungrouped",
    ]);
    expect(ungrouped.resources.find((r) => r.workCenterId === "wc-inactive-idle")).toBeUndefined();
  });

  it("sorts groups and resources by code and cell orders by order number + sequence", () => {
    const result = computeCapacity(
      calcInput({
        productionGroups: [
          { productionGroupId: "pg-b", code: "20", name: "B" },
          { productionGroupId: "pg-a", code: "10", name: "A" },
        ],
        workCenters: [
          wc({ workCenterId: "wc-2", code: "102", productionGroupId: "pg-a" }),
          wc({ workCenterId: "wc-1", code: "101", productionGroupId: "pg-a" }),
          wc({ workCenterId: "wc-3", code: "201", productionGroupId: "pg-b" }),
        ],
        operations: [
          op({ workCenterId: "wc-1", manufacturingOrderId: "mo-2", orderNumber: "PO-2", sequenceNo: 10, dueDate: "2026-08-19" }),
          op({ workCenterId: "wc-1", manufacturingOrderId: "mo-1", orderNumber: "PO-1", sequenceNo: 20, dueDate: "2026-08-19" }),
          op({ workCenterId: "wc-1", manufacturingOrderId: "mo-1", orderNumber: "PO-1", sequenceNo: 10, dueDate: "2026-08-19" }),
        ],
      }),
      { today: TODAY, weeks: 1 }
    );
    expect(result.groups.map((g) => g.code)).toEqual(["10", "20"]); // no ungrouped block when none exist
    expect(result.groups[0]!.resources.map((r) => r.code)).toEqual(["101", "102"]);
    const orders = result.groups[0]!.resources[0]!.weeks[0]!.orders;
    expect(orders.map((o) => `${o.orderNumber}:${o.sequenceNo}`)).toEqual(["PO-1:10", "PO-1:20", "PO-2:10"]);
  });
});

// --- Etapp G: legoresurser (subcontract) are excluded from beläggningen ---

describe("subcontract exclusion", () => {
  it("shows no row for a subcontract resource and loads none of its operations", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [
          wc({ workCenterId: "wc-1", code: "100" }),
          wc({ workCenterId: "wc-lego", code: "900", type: "subcontract" }),
        ],
        operations: [
          op({ workCenterId: "wc-1", dueDate: TODAY, runTimePerUnit: 6 }),
          // A lego operation on the same MO must not inflate any cell.
          op({ workCenterId: "wc-lego", dueDate: TODAY, runTimePerUnit: 60, sequenceNo: 20 }),
        ],
      }),
      { today: TODAY, weeks: 2 }
    );

    const ids = result.groups.flatMap((g) => g.resources.map((r) => r.workCenterId));
    expect(ids).toContain("wc-1");
    expect(ids).not.toContain("wc-lego");
    // Only the machine operation's 10 × 6 min = 1 h loads the week.
    expect(resourceRow(result, "wc-1").weeks[0]?.loadHours).toBe(1);
    const totals = result.groups.map((g) => g.weekTotals[0]?.loadHours ?? 0);
    expect(Math.max(...totals)).toBe(1);
  });

  it("excludes a subcontract resource even when it carries load and is active", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-lego", code: "900", type: "subcontract", active: true })],
        operations: [op({ workCenterId: "wc-lego", dueDate: TODAY })],
      }),
      { today: TODAY, weeks: 2 }
    );
    expect(result.groups).toHaveLength(0);
  });
});

// --- Produktionsplanering: planned days (#18) -----------------------------
// Rows without a plan count on their due date (a week cell is the sum of its
// days, so the tests above read as before). The ones below add plans.

const WED = TODAY; // 2026-08-19
const THU = "2026-08-20";
const FRI = "2026-08-21";
const MON2 = "2026-08-24";
const TUE2 = "2026-08-25";

describe("remainingByPlannedDays and operationLoadDays (shared with the book and Planera)", () => {
  it("fills the allocation from the back: the work done is assumed on the earliest days", () => {
    expect(remainingByPlannedDays(300, [{ date: THU, minutes: 400 }, { date: FRI, minutes: 200 }], WED)).toEqual([
      { date: THU, minutes: 100 },
      { date: FRI, minutes: 200 },
    ]);
    expect(remainingByPlannedDays(150, [{ date: THU, minutes: 400 }, { date: FRI, minutes: 200 }], WED)).toEqual([
      { date: FRI, minutes: 150 },
    ]);
  });

  it("puts an excess (Ångra rapportering) on the last day", () => {
    expect(remainingByPlannedDays(700, [{ date: THU, minutes: 400 }, { date: FRI, minutes: 200 }], WED)).toEqual([
      { date: THU, minutes: 400 },
      { date: FRI, minutes: 300 },
    ]);
  });

  it("clamps days before today to today — the work can't happen in the past", () => {
    // Monday and Tuesday have passed: their 300 min lie on today.
    expect(
      remainingByPlannedDays(
        600,
        [{ date: "2026-08-17", minutes: 100 }, { date: "2026-08-18", minutes: 200 }, { date: FRI, minutes: 300 }],
        WED
      )
    ).toEqual([
      { date: WED, minutes: 300 },
      { date: FRI, minutes: 300 },
    ]);
    // A plan wholly in the past is all today.
    expect(remainingByPlannedDays(250, [{ date: "2026-08-14", minutes: 250 }], WED)).toEqual([{ date: WED, minutes: 250 }]);
  });

  it("gives nothing when nothing remains and sorts an unordered allocation", () => {
    expect(remainingByPlannedDays(0, [{ date: THU, minutes: 400 }], WED)).toEqual([]);
    expect(remainingByPlannedDays(500, [{ date: FRI, minutes: 200 }, { date: THU, minutes: 400 }], WED)).toEqual([
      { date: THU, minutes: 300 },
      { date: FRI, minutes: 200 },
    ]);
  });

  it("operationLoadDays: unplanned ⇒ the due date (passed ⇒ today), planned ⇒ the distribution, done ⇒ nothing", () => {
    expect(operationLoadDays(op({ dueDate: "2026-08-27" }), TODAY)).toEqual([{ date: "2026-08-27", minutes: 60 }]);
    expect(operationLoadDays(op({ dueDate: "2026-08-17" }), TODAY)).toEqual([{ date: TODAY, minutes: 60 }]);
    expect(operationLoadDays(op({ dueDate: null }), TODAY)).toEqual([{ date: null, minutes: 60 }]);
    expect(operationLoadDays(op({ dueDate: "2026-08-27", plannedDays: [{ date: THU, minutes: 20 }, { date: MON2, minutes: 40 }] }), TODAY)).toEqual([
      { date: THU, minutes: 20 },
      { date: MON2, minutes: 40 },
    ]);
    expect(operationLoadDays(op({ operationStatus: "done", plannedDays: [{ date: THU, minutes: 60 }] }), TODAY)).toEqual([]);
    // An empty plan is no plan.
    expect(operationLoadDays(op({ dueDate: "2026-08-27", plannedDays: [] }), TODAY)).toEqual([{ date: "2026-08-27", minutes: 60 }]);
  });

  it("plannedDateRange and operationStartDate: the plan's first and last day, else the due date — never clamped", () => {
    const planned = op({ dueDate: "2026-08-27", plannedDays: [{ date: MON2, minutes: 40 }, { date: "2026-08-14", minutes: 20 }] });
    expect(plannedDateRange(planned)).toEqual({ start: "2026-08-14", end: MON2 });
    expect(operationStartDate(planned)).toBe("2026-08-14"); // before today: the körplan's Försenad
    expect(plannedDateRange(op({ dueDate: "2026-08-27" }))).toBeNull();
    expect(plannedDateRange(op({ plannedDays: [] }))).toBeNull();
    expect(operationStartDate(op({ dueDate: "2026-08-10" }))).toBe("2026-08-10");
    expect(operationStartDate(op({ dueDate: null }))).toBeNull();
  });
});

describe("computeCapacity — planned operations", () => {
  const W36 = "2026-08-31";

  it("a week cell is the sum of the operation's days there — one entry per operation and week", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" })],
        ...STD_WEEK,
        operations: [
          // 10 h planned Thu 2 h + Fri 3 h + Mon 5 h, due Friday 28 Aug.
          op({
            moOperationId: "op-p",
            orderNumber: "PO-P",
            dueDate: "2026-08-28",
            runTimePerUnit: 60,
            plannedDays: [{ date: THU, minutes: 120 }, { date: FRI, minutes: 180 }, { date: MON2, minutes: 300 }],
            planLocked: true,
            plannedAt: "2026-08-18T10:00:00.000Z",
          }),
          op({ moOperationId: "op-u", manufacturingOrderId: "mo-u", orderNumber: "PO-U", dueDate: "2026-08-28", runTimePerUnit: 6 }),
        ],
      }),
      { today: TODAY, weeks: 3 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks.map((c) => c.loadHours)).toEqual([5, 6, 0]);
    expect(row.weeks[0]!.orders).toEqual([
      expect.objectContaining({ moOperationId: "op-p", orderNumber: "PO-P", hoursInWeek: 5, remainingHours: 10, planned: true, plannedStartDate: THU, plannedEndDate: MON2, planLocked: true, late: false }),
    ]);
    expect(row.weeks[1]!.orders.map((o) => [o.orderNumber, o.hoursInWeek, o.planned, o.plannedStartDate, o.planLocked])).toEqual([
      ["PO-P", 5, true, THU, true],
      ["PO-U", 1, false, null, false],
    ]);
    expect(result.summary).toEqual({
      plannedAt: "2026-08-18T10:00:00.000Z",
      overloadedCells: 0,
      overloadedDays: 0,
      lateOrders: [],
      unplannedOrders: [{ manufacturingOrderId: "mo-u", orderNumber: "PO-U" }],
      resourceSuggestions: [],
      lockedOperations: 1,
    });
  });

  it("the remaining time is filled from the back of the plan after a partial report", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [op({ runTimePerUnit: 60, quantityCompleted: 5, plannedDays: [{ date: THU, minutes: 300 }, { date: MON2, minutes: 300 }] })],
      }),
      { today: TODAY, weeks: 2 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks.map((c) => c.loadHours)).toEqual([0, 5]);
    expect(row.weeks[0]!.orders).toEqual([]);
    expect(row.weeks[1]!.orders[0]).toMatchObject({ hoursInWeek: 5, remainingHours: 5 });
  });

  it("a plan beyond the horizon is `later`, passed days are clamped to today", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [
          op({ moOperationId: "a", runTimePerUnit: 60, plannedDays: [{ date: "2026-08-03", minutes: 300 }, { date: "2026-10-05", minutes: 150 }, { date: "2026-10-06", minutes: 150 }] }),
        ],
      }),
      { today: TODAY, weeks: 2 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks[0]!.loadHours).toBe(5);
    expect(row.later.loadHours).toBe(5);
    expect(row.later.orders).toHaveLength(1);
    expect(row.undated.loadHours).toBe(0);
  });

  it("Sen: ready after the due date — the plan's last day, a lego operation through the chain", () => {
    const lego = wc({ workCenterId: "wc-lego", code: "900", type: "subcontract", leadTimeDays: 5 });
    const planned = (extra: Partial<CapacityOperationRow>) =>
      op({ workCenterId: "wc-1", runTimePerUnit: 60, plannedDays: [{ date: THU, minutes: 600 }], ...extra });
    const input = calcInput({
      workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" }), lego],
      ...STD_WEEK,
      operations: [
        // In time: ready Thursday 20 Aug, due 26 Aug.
        planned({ moOperationId: "a", manufacturingOrderId: "mo-a", orderNumber: "PO-A", dueDate: "2026-08-26" }),
        // Late: the lego operation is sent the working day after (Fri 21)
        // and takes 5 working days ⇒ 28 Aug.
        planned({ moOperationId: "b1", manufacturingOrderId: "mo-b", orderNumber: "PO-B", dueDate: "2026-08-26" }),
        op({ moOperationId: "b2", manufacturingOrderId: "mo-b", orderNumber: "PO-B", dueDate: "2026-08-26", sequenceNo: 20, workCenterId: "wc-lego" }),
        // Late: the plan's last day is the day after the due date.
        planned({ moOperationId: "c", manufacturingOrderId: "mo-c", orderNumber: "PO-C", dueDate: "2026-08-26", plannedDays: [{ date: TUE2, minutes: 300 }, { date: "2026-08-27", minutes: 300 }] }),
        // Unplanned with a passed due date: Försenad, no planned finish.
        op({ moOperationId: "d", manufacturingOrderId: "mo-d", orderNumber: "PO-D", dueDate: "2026-08-10" }),
        // Done operations never make an order late.
        planned({ moOperationId: "e", manufacturingOrderId: "mo-e", orderNumber: "PO-E", dueDate: "2026-08-10", operationStatus: "done" }),
        // Ready ON the due date is in time (it was the week's last day before #18).
        planned({ moOperationId: "f", manufacturingOrderId: "mo-f", orderNumber: "PO-F", dueDate: "2026-08-26", plannedDays: [{ date: "2026-08-26", minutes: 600 }] }),
      ],
    });
    const result = computeCapacity(input, { today: TODAY, weeks: 3 });
    const row = resourceRow(result, "wc-1");
    const lateByOrder = new Map(row.weeks.flatMap((c) => c.orders).map((o) => [o.orderNumber, o.late]));
    expect(["PO-A", "PO-B", "PO-C", "PO-D", "PO-F"].map((n) => lateByOrder.get(n))).toEqual([false, true, true, true, false]);
    expect(result.summary.lateOrders).toEqual([
      { manufacturingOrderId: "mo-d", orderNumber: "PO-D", dueDate: "2026-08-10", plannedFinish: null },
      { manufacturingOrderId: "mo-b", orderNumber: "PO-B", dueDate: "2026-08-26", plannedFinish: "2026-08-28" },
      { manufacturingOrderId: "mo-c", orderNumber: "PO-C", dueDate: "2026-08-26", plannedFinish: "2026-08-27" },
    ]);
    expect(result.summary.unplannedOrders).toEqual([{ manufacturingOrderId: "mo-d", orderNumber: "PO-D" }]);
    // The Standardkötid moves the lego operation's floor a day: sent Mon 24, back Mon 31.
    const queued = computeCapacity(input, { today: TODAY, weeks: 3, queueDays: 1 });
    expect(queued.summary.lateOrders.find((o) => o.orderNumber === "PO-B")).toMatchObject({ plannedFinish: "2026-08-31" });
  });

  it("counts overloaded resource cells", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" })],
        ...STD_WEEK,
        operations: [
          // 45 h in a 40 h week, spread over its days.
          op({ moOperationId: "a", runTimePerUnit: 270, plannedDays: [{ date: WED, minutes: 900 }, { date: THU, minutes: 900 }, { date: FRI, minutes: 900 }] }),
          op({ moOperationId: "b", manufacturingOrderId: "mo-2", orderNumber: "PO-2", runTimePerUnit: 240, plannedDays: [{ date: W36, minutes: 2400 }] }), // exactly 40 h
        ],
      }),
      { today: TODAY, weeks: 3 }
    );
    expect(resourceRow(result, "wc-1").weeks.map((c) => c.loadPercent)).toEqual([113, 0, 100]);
    expect(result.summary.overloadedCells).toBe(1);
  });

  it("without plans the summary is empty apart from unplanned orders", () => {
    const result = computeCapacity(
      calcInput({ workCenters: [wc({ workCenterId: "wc-1" })], operations: [op({ dueDate: "2026-08-27" })] }),
      { today: TODAY, weeks: 2 }
    );
    expect(result.summary).toEqual({
      plannedAt: null,
      overloadedCells: 0,
      overloadedDays: 0,
      lateOrders: [],
      unplannedOrders: [{ manufacturingOrderId: "mo-1", orderNumber: "PO-1" }],
      resourceSuggestions: [],
      lockedOperations: 0,
    });
  });
});

describe("orderPlanStatus — planned, plannedFinish and Sen through the book's chain", () => {
  const own: PlanStatusWorkCenter = { type: "machine", weekScheduleId: "ws-40", hoursPerDay: null };
  const lego = (leadTimeDays: number | null, queueTimeDays: number | null = null): PlanStatusWorkCenter => ({
    type: "subcontract",
    weekScheduleId: null,
    hoursPerDay: null,
    leadTimeDays,
    queueTimeDays,
  });
  const status = (
    operations: CapacityOperationRow[],
    extra: { workCenters?: [string, PlanStatusWorkCenter][]; queueDays?: number; offDays?: string[]; today?: string } = {}
  ) =>
    orderPlanStatus(operations, {
      today: extra.today ?? TODAY,
      offDays: new Set(extra.offDays ?? []),
      workCenters: new Map<string, PlanStatusWorkCenter>([["wc-1", own], ...(extra.workCenters ?? [])]),
      queueDays: extra.queueDays,
    });
  const on = (date: string, extra: Partial<CapacityOperationRow> = {}) =>
    op({ runTimePerUnit: 6, dueDate: "2026-08-28", plannedDays: [{ date, minutes: 60 }], ...extra });

  it("the latest of the operations' last days; a passed plan is today", () => {
    expect(status([on(THU), on(MON2, { sequenceNo: 20 })])).toEqual({ planned: true, plannedFinish: MON2, late: false });
    // A later operation planned EARLIER (a sequence break) never pulls the finish back.
    expect(status([on(MON2), on(THU, { sequenceNo: 20 })])).toMatchObject({ plannedFinish: MON2 });
    // Planned last week and not worked: it lies on today — late when the due date has passed.
    expect(status([on("2026-08-13", { dueDate: "2026-08-18" })])).toEqual({ planned: true, plannedFinish: TODAY, late: true });
    expect(status([on("2026-08-13", { dueDate: TODAY })])).toMatchObject({ plannedFinish: TODAY, late: false });
  });

  it("unplanned: a pending operation with time and no plan — Sen is then the passed due date", () => {
    expect(status([on(THU), op({ sequenceNo: 20, dueDate: "2026-08-28" })])).toEqual({ planned: false, plannedFinish: null, late: false });
    expect(status([op({ dueDate: "2026-08-18" })])).toEqual({ planned: false, plannedFinish: null, late: true });
    // An operation without time (Planera clears it) or done is not "unplanned".
    expect(status([on(THU), op({ sequenceNo: 20, runTimePerUnit: 0, dueDate: "2026-08-28" })])).toMatchObject({ planned: true, plannedFinish: THU });
    expect(status([on(THU), op({ sequenceNo: 20, runTimePerUnit: 0.0005, dueDate: "2026-08-28" })])).toMatchObject({ planned: true });
    expect(status([on(THU), op({ sequenceNo: 5, operationStatus: "done", dueDate: "2026-08-28" })])).toMatchObject({ planned: true, plannedFinish: THU });
    // Nothing pending at all: ready today.
    expect(status([op({ operationStatus: "done", dueDate: "2026-08-18" })])).toEqual({ planned: true, plannedFinish: TODAY, late: true });
  });

  it("a lego operation: from the chain's floor, Ledtid + Kötid rounded up, in working days", () => {
    const legoOp = (sequenceNo: number, workCenterId = "wc-l") => op({ sequenceNo, workCenterId, dueDate: "2026-08-28" });
    // First in the route: sent today, no gap before it.
    expect(status([legoOp(10)], { workCenters: [["wc-l", lego(2)]] })).toMatchObject({ plannedFinish: FRI });
    // … and on a day off it is sent the next working day (Leveranstids-
    // kontrollen's t0): Saturday 22 and Sunday 23 ⇒ sent Monday 24, back
    // Wednesday 26 — Monday is not day 1 of the lead time.
    for (const today of ["2026-08-22", "2026-08-23", "2026-08-24"]) {
      expect(status([legoOp(10)], { workCenters: [["wc-l", lego(2)]], today }), today).toMatchObject({ plannedFinish: "2026-08-26" });
    }
    expect(subcontractReadyDate(lego(2), "2026-08-22", new Set())).toBe("2026-08-26");
    expect(subcontractReadyDate(lego(0), "2026-08-22", new Set())).toBe("2026-08-24");
    expect(subcontractReadyDate(lego(2), "2026-08-24", new Set(["2026-08-24"]))).toBe("2026-08-27");
    // After an own operation ready Thursday: sent Friday, back Tuesday (2 days).
    expect(status([on(THU), legoOp(20)], { workCenters: [["wc-l", lego(2)]] })).toMatchObject({ plannedFinish: TUE2 });
    // Ledtid 1 + Kötid 0.5 ⇒ 2 days; a holiday on Monday pushes it a day.
    expect(status([on(THU), legoOp(20)], { workCenters: [["wc-l", lego(1, 0.5)]], offDays: [MON2] })).toMatchObject({ plannedFinish: "2026-08-26" });
    // The gaps are counted over the operations that take a place: with a
    // Standardkötid of 0.5 the first gap waits a day, the second none.
    expect(
      status([on(THU), legoOp(20), legoOp(30, "wc-m")], { workCenters: [["wc-l", lego(1)], ["wc-m", lego(1)]], queueDays: 0.5 })
    ).toMatchObject({ plannedFinish: "2026-08-27" }); // Thu → (Fri + 1) Mon, back Tue → Wed, back Thu
    // An own operation planned after the lego one decides when it lies later.
    expect(status([legoOp(10), on("2026-08-31", { sequenceNo: 20 })], { workCenters: [["wc-l", lego(2)]] })).toEqual({
      planned: true,
      plannedFinish: "2026-08-31",
      late: true,
    });
  });
});

describe("routingOperationMinutes", () => {
  it("is setup once plus run time per unit — the formula Leveranstidskontrollen and the lead time share", () => {
    expect(routingOperationMinutes({ setupTime: 30, runTimePerUnit: 2.5 }, 10)).toBe(55);
    expect(routingOperationMinutes({ setupTime: 30, runTimePerUnit: 2.5 }, 0)).toBe(30);
    // An untouched TO's remaining minutes equal the routing formula.
    expect(remainingOperationMinutes(op({ setupTime: 30, runTimePerUnit: 2.5, orderQuantity: 10 }))).toBe(
      routingOperationMinutes({ setupTime: 30, runTimePerUnit: 2.5 }, 10)
    );
  });
});

// Alternativa resurser (#15): the cells carry Vald för hand, the ordinarie
// when the operation is on an alternative, and the förslag computed on the
// same input (resource-suggestions.ts); the summary lists the förslag.
describe("computeCapacity — förslag på resurs", () => {
  it("puts the förslag on the operation's cells and in the summary, by order number and sequence", () => {
    const suggestion = (moOperationId: string, orderNumber: string, sequenceNo: number) => ({
      moOperationId,
      manufacturingOrderId: `mo-${orderNumber}`,
      orderNumber,
      sequenceNo,
      fromWorkCenterId: "wc-1",
      fromCode: "110",
      toWorkCenterId: "wc-2",
      toCode: "120",
      toName: "Kantpress 2",
      currentToDate: "2026-08-31",
      toDate: "2026-08-19",
      reason: "overloaded" as const,
    });
    const resources = [
      { workCenterId: "wc-1", rank: 0, setupTime: 0, runTimePerUnit: 6 },
      { workCenterId: "wc-2", rank: 1, setupTime: 0, runTimePerUnit: 3 },
    ];
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", code: "110" }), wc({ workCenterId: "wc-2", code: "120" })],
        operations: [
          op({ moOperationId: "op-b", manufacturingOrderId: "mo-PO-B", orderNumber: "PO-B", dueDate: "2026-08-20", resources }),
          op({ moOperationId: "op-a", manufacturingOrderId: "mo-PO-A", orderNumber: "PO-A", dueDate: "2026-08-20", resources }),
          // On the alternative, chosen by hand: the ordinarie's code rides along.
          op({ moOperationId: "op-c", manufacturingOrderId: "mo-PO-C", orderNumber: "PO-C", dueDate: "2026-08-20", workCenterId: "wc-2", resources, resourceLocked: true }),
        ],
      }),
      { today: TODAY, weeks: 2, resourceSuggestions: [suggestion("op-b", "PO-B", 10), suggestion("op-a", "PO-A", 10)] }
    );
    const cell = (workCenterId: string, moOperationId: string) =>
      resourceRow(result, workCenterId).weeks[0]!.orders.find((o) => o.moOperationId === moOperationId)!;
    expect(cell("wc-1", "op-a")).toMatchObject({
      resourceLocked: false,
      ordinaryWorkCenterCode: null,
      suggestion: { workCenterId: "wc-2", code: "120", name: "Kantpress 2", toDate: "2026-08-19", currentToDate: "2026-08-31", reason: "overloaded" },
    });
    expect(cell("wc-2", "op-c")).toMatchObject({ resourceLocked: true, ordinaryWorkCenterCode: "110", suggestion: null });
    expect(result.summary.resourceSuggestions.map((s) => s.orderNumber)).toEqual(["PO-A", "PO-B"]);
  });

  it("without förslag and alternatives every cell says so", () => {
    const result = computeCapacity(calcInput({ workCenters: [wc({ workCenterId: "wc-1" })], operations: [op({ dueDate: "2026-08-20" })] }), {
      today: TODAY,
      weeks: 1,
    });
    expect(resourceRow(result, "wc-1").weeks[0]!.orders[0]).toMatchObject({ resourceLocked: false, ordinaryWorkCenterCode: null, suggestion: null });
    expect(result.summary.resourceSuggestions).toEqual([]);
  });
});

// Dagläget (#18, etapp 4): the load is bucketed per day in both views — the
// day view shows the day cells, the week view their sums (S14).
describe("computeCapacity — day view and overloadedDays", () => {
  // TODAY is Wednesday 2026-08-19. 900 min planned Wed 300 / Thu 600 on an
  // 8 h day: Thursday is over, the week (15 h of 40) is not.
  const planned = () =>
    op({
      moOperationId: "op-a",
      runTimePerUnit: 90,
      orderQuantity: 10,
      dueDate: "2026-09-30",
      plannedDays: [
        { date: "2026-08-19", minutes: 300 },
        { date: "2026-08-20", minutes: 600 },
      ],
    });
  const input = (operations: CapacityOperationRow[], extra: Partial<CapacityInput> = {}) =>
    calcInput({ workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" })], ...STD_WEEK, operations, ...extra });

  it("answers with day columns from today; the week lists are empty", () => {
    const result = computeCapacity(input([]), { today: TODAY, weeks: 8, granularity: "day", days: 7 });
    expect(result.today).toBe(TODAY);
    expect(result.granularity).toBe("day");
    expect(result.weeks).toEqual([]);
    expect(result.days).toEqual([
      { date: "2026-08-19", isoWeek: 34, weekday: 3 },
      { date: "2026-08-20", isoWeek: 34, weekday: 4 },
      { date: "2026-08-21", isoWeek: 34, weekday: 5 },
      { date: "2026-08-22", isoWeek: 34, weekday: 6 },
      { date: "2026-08-23", isoWeek: 34, weekday: 7 },
      { date: "2026-08-24", isoWeek: 35, weekday: 1 },
      { date: "2026-08-25", isoWeek: 35, weekday: 2 },
    ]);
    const row = resourceRow(result, "wc-1");
    expect(row.weeks).toEqual([]);
    expect(row.days).toHaveLength(7);
    expect(row.days.map((c) => c.availableHours)).toEqual([8, 8, 8, 0, 0, 8, 8]);
    expect(result.groups[0]!.weekTotals).toEqual([]);
    expect(result.groups[0]!.dayTotals).toHaveLength(7);
    // 14 days when none is given.
    expect(computeCapacity(input([]), { today: TODAY, weeks: 8, granularity: "day" }).days).toHaveLength(14);
  });

  it("the week view is unchanged in form: no day columns, today and the granularity on the answer", () => {
    const result = computeCapacity(input([planned()]), { today: TODAY, weeks: 2 });
    expect(result.today).toBe(TODAY);
    expect(result.granularity).toBe("week");
    expect(result.days).toEqual([]);
    expect(result.weeks).toHaveLength(2);
    const row = resourceRow(result, "wc-1");
    expect(row.days).toEqual([]);
    expect(result.groups[0]!.dayTotals).toEqual([]);
    expect(row.weeks[0]!.orders[0]).toMatchObject({ hoursInWeek: 15, hoursInDay: null });
  });

  it("puts a planned operation on its days: the same overload rule per day cell", () => {
    const result = computeCapacity(input([planned()]), { today: TODAY, weeks: 8, granularity: "day", days: 7 });
    const [wed, thu, fri] = resourceRow(result, "wc-1").days;
    expect(wed).toMatchObject({ loadHours: 5, availableHours: 8, loadPercent: 63, overloaded: false, overloadedDays: 0 });
    expect(thu).toMatchObject({ loadHours: 10, availableHours: 8, loadPercent: 125, overloaded: true, overloadedDays: 1 });
    expect(fri).toMatchObject({ loadHours: 0, availableHours: 8, loadPercent: 0, overloaded: false, orders: [] });
    // One chip per day cell: the share of the day, of the day's week, and the whole.
    expect(wed!.orders).toHaveLength(1);
    expect(wed!.orders[0]).toMatchObject({ moOperationId: "op-a", hoursInDay: 5, hoursInWeek: 15, remainingHours: 15, plannedStartDate: "2026-08-19", plannedEndDate: "2026-08-20" });
    expect(thu!.orders[0]).toMatchObject({ moOperationId: "op-a", hoursInDay: 10, hoursInWeek: 15 });
    expect(result.summary.overloadedCells).toBe(1);
    expect(result.summary.overloadedDays).toBe(1);
    expect(result.groups[0]!.dayTotals[1]).toMatchObject({ loadHours: 10, availableHours: 8, overloaded: true, overloadedDays: 1 });
  });

  it("a week cell is the sum of its days and carries the overloaded days the sum hides", () => {
    const result = computeCapacity(input([planned()]), { today: TODAY, weeks: 2 });
    const row = resourceRow(result, "wc-1");
    expect(row.weeks[0]).toMatchObject({ loadHours: 15, availableHours: 40, loadPercent: 38, overloaded: false, overloadedDays: 1 });
    expect(row.weeks[1]).toMatchObject({ loadHours: 0, overloaded: false, overloadedDays: 0 });
    // The red cells are the weeks'; the days are counted beside them.
    expect(result.summary.overloadedCells).toBe(0);
    expect(result.summary.overloadedDays).toBe(1);
    expect(result.groups[0]!.weekTotals[0]).toMatchObject({ loadHours: 15, overloaded: false, overloadedDays: 1 });
    // dayLoads: every visible day, Monday of the first week to Sunday of the last.
    expect(row.dayLoads).toHaveLength(14);
    expect(row.dayLoads[0]!.date).toBe("2026-08-17");
    expect(row.dayLoads[13]!.date).toBe("2026-08-30");
    expect(row.dayLoads.find((d) => d.date === "2026-08-19")).toEqual({ date: "2026-08-19", loadHours: 5, availableHours: 8, overloaded: false });
    expect(row.dayLoads.find((d) => d.date === "2026-08-20")).toEqual({ date: "2026-08-20", loadHours: 10, availableHours: 8, overloaded: true });
    expect(row.dayLoads.find((d) => d.date === "2026-08-22")).toEqual({ date: "2026-08-22", loadHours: 0, availableHours: 0, overloaded: false });
  });

  it("week cell = sum of the day cells, for load and capacity, with a holiday and a short day", () => {
    const operations = [
      planned(),
      op({ moOperationId: "op-b", orderNumber: "PO-2", manufacturingOrderId: "mo-2", runTimePerUnit: 33, orderQuantity: 7, dueDate: "2026-08-25" }),
      op({ moOperationId: "op-c", orderNumber: "PO-3", manufacturingOrderId: "mo-3", runTimePerUnit: 10, orderQuantity: 5, dueDate: "2026-08-01" }), // passed ⇒ today
    ];
    const extra = {
      daySchedules: [...STD_WEEK.daySchedules, { id: "ds-half", netMinutes: 250 }],
      holidays: [
        { date: "2026-08-21", dayScheduleId: null },
        { date: "2026-08-26", dayScheduleId: "ds-half" },
      ],
    };
    const weekView = computeCapacity(input(operations, extra), { today: TODAY, weeks: 2 });
    const dayView = computeCapacity(input(operations, extra), { today: TODAY, weeks: 2, granularity: "day", days: 12 }); // Wed … Sun next week
    const weekRow = resourceRow(weekView, "wc-1");
    const dayRow = resourceRow(dayView, "wc-1");
    const sum = (cells: { loadHours: number; availableHours: number | null }[], pick: "loadHours" | "availableHours") =>
      cells.reduce((n, c) => n + (c[pick] ?? 0), 0);
    for (const [i, cell] of weekRow.weeks.entries()) {
      const days = weekRow.dayLoads.slice(i * 7, i * 7 + 7);
      expect(sum(days, "loadHours")).toBeCloseTo(cell.loadHours, 2);
      expect(sum(days, "availableHours")).toBeCloseTo(cell.availableHours!, 2);
      expect(cell.overloadedDays).toBe(days.filter((d) => d.overloaded).length);
    }
    // 4 × 8 h (Friday off) and 4 × 8 h + 250 min.
    expect(weekRow.weeks.map((c) => c.availableHours)).toEqual([32, 36.17]);
    // The day view's cells are the week view's days from today on.
    expect(dayRow.dayLoads).toEqual(weekRow.dayLoads.slice(2));
    expect(dayRow.days.map((c) => c.loadHours)).toEqual(weekRow.dayLoads.slice(2).map((d) => d.loadHours));
    // Week 34 from today is the whole week's load (nothing lies before today).
    expect(sum(dayRow.days.slice(0, 5), "loadHours")).toBeCloseTo(weekRow.weeks[0]!.loadHours, 2);
  });

  it("load on a day without capacity is an overloaded day, with no percentage", () => {
    // Unplanned, due on the Saturday: 1 h on a 0 h day.
    const result = computeCapacity(input([op({ dueDate: "2026-08-22" })]), { today: TODAY, weeks: 1, granularity: "day", days: 7 });
    const saturday = resourceRow(result, "wc-1").days[3]!;
    expect(saturday).toMatchObject({ loadHours: 1, availableHours: 0, loadPercent: null, overloaded: true, overloadedDays: 1 });
    expect(saturday.orders[0]).toMatchObject({ planned: false, hoursInDay: 1, hoursInWeek: 1 });
    const week = computeCapacity(input([op({ dueDate: "2026-08-22" })]), { today: TODAY, weeks: 1 });
    expect(resourceRow(week, "wc-1").weeks[0]).toMatchObject({ loadHours: 1, availableHours: 40, overloaded: false, overloadedDays: 1 });
  });

  it("a resource without a calendar has no overloaded day", () => {
    const result = computeCapacity(
      calcInput({ workCenters: [wc({ workCenterId: "wc-1" })], operations: [op({ dueDate: "2026-08-20", runTimePerUnit: 600 })] }),
      { today: TODAY, weeks: 1, granularity: "day", days: 7 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.days[1]).toMatchObject({ loadHours: 100, availableHours: null, loadPercent: null, overloaded: false, overloadedDays: 0 });
    expect(row.dayLoads[1]).toEqual({ date: "2026-08-20", loadHours: 100, availableHours: null, overloaded: false });
    expect(result.summary.overloadedDays).toBe(0);
  });

  it("Senare and Utan datum follow the day columns", () => {
    const result = computeCapacity(
      input([
        op({ moOperationId: "op-later", orderNumber: "PO-2", manufacturingOrderId: "mo-2", dueDate: "2026-08-26" }), // the day after the last column
        op({ moOperationId: "op-last", orderNumber: "PO-3", manufacturingOrderId: "mo-3", dueDate: "2026-08-25" }),
        op({ moOperationId: "op-undated", orderNumber: "PO-4", manufacturingOrderId: "mo-4", dueDate: null }),
      ]),
      { today: TODAY, weeks: 8, granularity: "day", days: 7 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.days[6]!.orders.map((o) => o.moOperationId)).toEqual(["op-last"]);
    expect(row.later.orders.map((o) => o.moOperationId)).toEqual(["op-later"]);
    expect(row.later.orders[0]).toMatchObject({ hoursInDay: 1, hoursInWeek: 1 });
    expect(row.later.overloadedDays).toBe(0);
    expect(row.undated.orders.map((o) => o.moOperationId)).toEqual(["op-undated"]);
  });

  it("the capacity factor and the group's day totals: a day can be over for one member only", () => {
    const result = computeCapacity(
      calcInput({
        productionGroups: [{ productionGroupId: "g-1", code: "G1", name: "Grupp" }],
        workCenters: [
          wc({ workCenterId: "wc-1", code: "100", weekScheduleId: "ws-40", productionGroupId: "g-1" }),
          wc({ workCenterId: "wc-2", code: "200", weekScheduleId: "ws-40", capacityFactor: 2, productionGroupId: "g-1" }),
        ],
        ...STD_WEEK,
        operations: [planned()],
      }),
      { today: TODAY, weeks: 1, granularity: "day", days: 7 }
    );
    expect(resourceRow(result, "wc-2").days[0]!.availableHours).toBe(16);
    // Thursday: 10 h on wc-1's 8 h, but the group has 24 h.
    expect(resourceRow(result, "wc-1").days[1]!.overloaded).toBe(true);
    expect(result.groups[0]!.dayTotals[1]).toMatchObject({ loadHours: 10, availableHours: 24, overloaded: false, overloadedDays: 0 });
    expect(result.summary.overloadedDays).toBe(1);
  });
});

describe("resourceDayLoads — equals the matrix's dayLoads", () => {
  // TODAY is Wednesday 2026-08-19. Friday the 21st is a röd dag, Monday the
  // 24th a kortdag (4 h).
  const fixture = calcInput({
    workCenters: [
      wc({ workCenterId: "wc-1", code: "100", weekScheduleId: "ws-40" }),
      wc({ workCenterId: "wc-2", code: "200", hoursPerDay: 6, capacityFactor: 0.5 }),
      wc({ workCenterId: "wc-3", code: "300" }), // no capacity calendar
      wc({ workCenterId: "wc-lego", code: "900", type: "subcontract" }),
    ],
    weekScheduleDays: STD_WEEK.weekScheduleDays,
    daySchedules: [...STD_WEEK.daySchedules, { id: "ds-240", netMinutes: 240 }],
    holidays: [
      { date: "2026-08-21", dayScheduleId: null },
      { date: "2026-08-24", dayScheduleId: "ds-240" },
    ],
    operations: [
      // Planned over three days, the middle one a röd dag: 900 min.
      op({
        moOperationId: "op-a",
        runTimePerUnit: 90,
        plannedDays: [
          { date: "2026-08-20", minutes: 300 },
          { date: "2026-08-21", minutes: 200 },
          { date: "2026-08-24", minutes: 400 },
        ],
      }),
      // A passed plan: clamped to today.
      op({
        moOperationId: "op-b",
        manufacturingOrderId: "mo-2",
        runTimePerUnit: 33.33,
        plannedDays: [
          { date: "2026-08-17", minutes: 200 },
          { date: "2026-08-19", minutes: 133.3 },
        ],
      }),
      // Unplanned: on the due date; a passed due date on today; undated nowhere.
      op({ moOperationId: "op-c", manufacturingOrderId: "mo-3", dueDate: "2026-08-25", runTimePerUnit: 7 }),
      op({ moOperationId: "op-d", manufacturingOrderId: "mo-4", dueDate: "2026-08-10", runTimePerUnit: 11 }),
      op({ moOperationId: "op-e", manufacturingOrderId: "mo-5", dueDate: null }),
      op({ moOperationId: "op-f", manufacturingOrderId: "mo-6", dueDate: "2026-08-19", operationStatus: "done" }),
      // Hours per day × the factor: 3 h a day, overloaded by 4 h on Thursday.
      op({ moOperationId: "op-g", manufacturingOrderId: "mo-7", workCenterId: "wc-2", dueDate: "2026-08-20", runTimePerUnit: 24 }),
      op({ moOperationId: "op-h", manufacturingOrderId: "mo-8", workCenterId: "wc-2", dueDate: "2026-08-22", runTimePerUnit: 1 }),
      // No calendar: load without capacity, never overloaded.
      op({ moOperationId: "op-i", manufacturingOrderId: "mo-9", workCenterId: "wc-3", dueDate: "2026-08-19", runTimePerUnit: 100 }),
      // Lego: never load.
      op({ moOperationId: "op-j", manufacturingOrderId: "mo-9", workCenterId: "wc-lego", dueDate: "2026-08-19", sequenceNo: 20 }),
    ],
  });
  const DAYS = 14;
  const matrix = computeCapacity(fixture, { today: TODAY, weeks: 8, granularity: "day", days: DAYS });

  it("gives the same loadHours, availableHours and overloaded for every resource and day", () => {
    for (const { date } of matrix.days) {
      const loads = resourceDayLoads(fixture, TODAY, date);
      expect([...loads.keys()].sort()).toEqual(["wc-1", "wc-2", "wc-3"]);
      for (const workCenterId of ["wc-1", "wc-2", "wc-3"]) {
        const expected = resourceRow(matrix, workCenterId).dayLoads.find((d) => d.date === date)!;
        expect(loads.get(workCenterId), `${workCenterId} ${date}`).toEqual(expected);
      }
    }
    expect(matrix.days).toHaveLength(DAYS);
  });

  it("is not vacuous: the fixture's röd dag, kortdag, clamped plan and resource without calendar", () => {
    const on = (date: string, id: string) => resourceDayLoads(fixture, TODAY, date).get(id)!;
    // Today: the passed plan (333.3 min) + the passed due date (110 min).
    expect(on("2026-08-19", "wc-1")).toEqual({ date: "2026-08-19", loadHours: 7.39, availableHours: 8, overloaded: false });
    // Röd dag with planned load: 0 h available ⇒ overloaded.
    expect(on("2026-08-21", "wc-1")).toEqual({ date: "2026-08-21", loadHours: 3.33, availableHours: 0, overloaded: true });
    // Kortdag: 400 min of 4 h.
    expect(on("2026-08-24", "wc-1")).toEqual({ date: "2026-08-24", loadHours: 6.67, availableHours: 4, overloaded: true });
    expect(on("2026-08-20", "wc-2")).toEqual({ date: "2026-08-20", loadHours: 4, availableHours: 3, overloaded: true });
    // Saturday without capacity but with load.
    expect(on("2026-08-22", "wc-2")).toEqual({ date: "2026-08-22", loadHours: 0.17, availableHours: 0, overloaded: true });
    expect(on("2026-08-19", "wc-3")).toEqual({ date: "2026-08-19", loadHours: 16.67, availableHours: null, overloaded: false });
    // A resource without load is still there.
    expect(on("2026-08-26", "wc-3")).toEqual({ date: "2026-08-26", loadHours: 0, availableHours: null, overloaded: false });
  });
});
