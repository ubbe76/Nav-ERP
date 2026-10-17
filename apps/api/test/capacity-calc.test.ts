import { describe, expect, it } from "vitest";
import {
  buildScheduleLookups,
  computeCapacity,
  loadBucketMonday,
  operationLoadWeeks,
  remainingByPlannedWeeks,
  remainingOperationMinutes,
  resourceDayMinutes,
  resolveResourceWeekHours,
  type CapacityInput,
  type CapacityOperationRow,
  type CapacityResult,
  type CapacityWorkCenter,
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

describe("resourceDayMinutes and loadBucketMonday (shared with Leveranstidskontrollen)", () => {
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

  it("buckets by the due date's week, past due into the first week, undated as null", () => {
    expect(loadBucketMonday("2026-08-27", "2026-08-17")).toBe("2026-08-24");
    expect(loadBucketMonday("2026-08-10", "2026-08-17")).toBe("2026-08-17");
    expect(loadBucketMonday(null, "2026-08-17")).toBeNull();
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

// --- Produktionsplanering: planned weeks ----------------------------------
// Rows without a plan give EXACTLY the results above — every test before this
// line runs unchanged. The ones below add plans.

describe("remainingByPlannedWeeks and operationLoadWeeks (shared with the book and Planera)", () => {
  const W45 = "2026-11-02";
  const W46 = "2026-11-09";

  it("fills the allocation from the back: the work done is assumed in the earliest weeks", () => {
    expect(remainingByPlannedWeeks(300, [{ monday: W45, minutes: 400 }, { monday: W46, minutes: 200 }], W45)).toEqual([
      { monday: W45, minutes: 100 },
      { monday: W46, minutes: 200 },
    ]);
    expect(remainingByPlannedWeeks(150, [{ monday: W45, minutes: 400 }, { monday: W46, minutes: 200 }], W45)).toEqual([
      { monday: W46, minutes: 150 },
    ]);
  });

  it("puts an excess (Ångra rapportering) in the last week", () => {
    expect(remainingByPlannedWeeks(700, [{ monday: W45, minutes: 400 }, { monday: W46, minutes: 200 }], W45)).toEqual([
      { monday: W45, minutes: 400 },
      { monday: W46, minutes: 300 },
    ]);
  });

  it("clamps weeks before the current week to it — the work can't happen in the past", () => {
    expect(
      remainingByPlannedWeeks(
        600,
        [{ monday: "2026-10-05", minutes: 100 }, { monday: "2026-10-12", minutes: 200 }, { monday: W45, minutes: 300 }],
        "2026-10-19"
      )
    ).toEqual([
      { monday: "2026-10-19", minutes: 300 },
      { monday: W45, minutes: 300 },
    ]);
  });

  it("gives nothing when nothing remains and sorts an unordered allocation", () => {
    expect(remainingByPlannedWeeks(0, [{ monday: W45, minutes: 400 }], W45)).toEqual([]);
    expect(remainingByPlannedWeeks(500, [{ monday: W46, minutes: 200 }, { monday: W45, minutes: 400 }], W45)).toEqual([
      { monday: W45, minutes: 300 },
      { monday: W46, minutes: 200 },
    ]);
  });

  it("operationLoadWeeks: unplanned ⇒ the due date's bucket, planned ⇒ the distribution, done ⇒ nothing", () => {
    const firstMonday = "2026-08-17";
    expect(operationLoadWeeks(op({ dueDate: "2026-08-27" }), firstMonday)).toEqual([{ monday: "2026-08-24", minutes: 60 }]);
    expect(operationLoadWeeks(op({ dueDate: null }), firstMonday)).toEqual([{ monday: null, minutes: 60 }]);
    expect(
      operationLoadWeeks(op({ dueDate: "2026-08-27", plannedWeeks: [{ monday: "2026-08-24", minutes: 20 }, { monday: "2026-08-31", minutes: 40 }] }), firstMonday)
    ).toEqual([
      { monday: "2026-08-24", minutes: 20 },
      { monday: "2026-08-31", minutes: 40 },
    ]);
    expect(operationLoadWeeks(op({ operationStatus: "done", plannedWeeks: [{ monday: "2026-08-24", minutes: 60 }] }), firstMonday)).toEqual([]);
    // An empty plan is no plan.
    expect(operationLoadWeeks(op({ dueDate: "2026-08-27", plannedWeeks: [] }), firstMonday)).toEqual([{ monday: "2026-08-24", minutes: 60 }]);
  });
});

describe("computeCapacity — planned operations", () => {
  const W34 = "2026-08-17";
  const W35 = "2026-08-24";
  const W36 = "2026-08-31";

  it("a planned operation appears in every week of its plan with its share; unplanned rows are untouched", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" })],
        ...STD_WEEK,
        operations: [
          // 10 h planned 5 h + 5 h, finishing Friday 28 Aug — the due date.
          op({ moOperationId: "op-p", orderNumber: "PO-P", dueDate: "2026-08-28", runTimePerUnit: 60, plannedWeeks: [{ monday: W34, minutes: 300 }, { monday: W35, minutes: 300 }], planLocked: true, plannedAt: "2026-08-18T10:00:00.000Z" }),
          op({ moOperationId: "op-u", manufacturingOrderId: "mo-u", orderNumber: "PO-U", dueDate: "2026-08-28", runTimePerUnit: 6 }),
        ],
      }),
      { today: TODAY, weeks: 3 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks.map((c) => c.loadHours)).toEqual([5, 6, 0]);
    expect(row.weeks[0]!.orders).toEqual([
      expect.objectContaining({ moOperationId: "op-p", orderNumber: "PO-P", hoursInWeek: 5, remainingHours: 10, planned: true, plannedStartWeek: W34, plannedEndWeek: W35, planLocked: true, late: false }),
    ]);
    expect(row.weeks[1]!.orders.map((o) => [o.orderNumber, o.hoursInWeek, o.planned, o.plannedStartWeek, o.planLocked])).toEqual([
      ["PO-P", 5, true, W34, true],
      ["PO-U", 1, false, null, false],
    ]);
    expect(result.summary).toEqual({
      plannedAt: "2026-08-18T10:00:00.000Z",
      overloadedCells: 0,
      lateOrders: [],
      unplannedOrders: [{ manufacturingOrderId: "mo-u", orderNumber: "PO-U" }],
    });
  });

  it("the remaining time is filled from the back of the plan after a partial report", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [op({ runTimePerUnit: 60, quantityCompleted: 5, plannedWeeks: [{ monday: W34, minutes: 300 }, { monday: W35, minutes: 300 }] })],
      }),
      { today: TODAY, weeks: 2 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks.map((c) => c.loadHours)).toEqual([0, 5]);
    expect(row.weeks[0]!.orders).toEqual([]);
    expect(row.weeks[1]!.orders[0]).toMatchObject({ hoursInWeek: 5, remainingHours: 5 });
  });

  it("a plan beyond the horizon is `later`, past weeks are clamped into the current one", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1" })],
        operations: [
          op({ moOperationId: "a", runTimePerUnit: 60, plannedWeeks: [{ monday: "2026-08-03", minutes: 300 }, { monday: "2026-10-05", minutes: 300 }] }),
        ],
      }),
      { today: TODAY, weeks: 2 }
    );
    const row = resourceRow(result, "wc-1");
    expect(row.weeks[0]!.loadHours).toBe(5);
    expect(row.later.loadHours).toBe(5);
    expect(row.undated.loadHours).toBe(0);
  });

  it("Sen: the last pending operation's finish after the due date, a lego operation through its lead time", () => {
    const lego = wc({ workCenterId: "wc-lego", code: "900", type: "subcontract", leadTimeDays: 5 });
    const planned = (extra: Partial<CapacityOperationRow>) =>
      op({ workCenterId: "wc-1", runTimePerUnit: 60, plannedWeeks: [{ monday: W34, minutes: 600 }], ...extra });
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" }), lego],
        ...STD_WEEK,
        operations: [
          // In time: finishes Friday 21 Aug, due 26 Aug.
          planned({ moOperationId: "a", manufacturingOrderId: "mo-a", orderNumber: "PO-A", dueDate: "2026-08-26" }),
          // Late: the lego operation after it adds 5 working days ⇒ 28 Aug.
          planned({ moOperationId: "b1", manufacturingOrderId: "mo-b", orderNumber: "PO-B", dueDate: "2026-08-26" }),
          op({ moOperationId: "b2", manufacturingOrderId: "mo-b", orderNumber: "PO-B", dueDate: "2026-08-26", sequenceNo: 20, workCenterId: "wc-lego" }),
          // Late: planned in week 35 (finishes 28 Aug), due 26 Aug.
          planned({ moOperationId: "c", manufacturingOrderId: "mo-c", orderNumber: "PO-C", dueDate: "2026-08-26", plannedWeeks: [{ monday: W35, minutes: 600 }] }),
          // Unplanned with a passed due date: Försenad, no planned finish.
          op({ moOperationId: "d", manufacturingOrderId: "mo-d", orderNumber: "PO-D", dueDate: "2026-08-10" }),
          // Done operations never make an order late.
          planned({ moOperationId: "e", manufacturingOrderId: "mo-e", orderNumber: "PO-E", dueDate: "2026-08-10", operationStatus: "done" }),
        ],
      }),
      { today: TODAY, weeks: 3 }
    );
    const row = resourceRow(result, "wc-1");
    const lateByOrder = new Map(row.weeks.flatMap((c) => c.orders).map((o) => [o.orderNumber, o.late]));
    expect(lateByOrder.get("PO-A")).toBe(false);
    expect(lateByOrder.get("PO-B")).toBe(true);
    expect(lateByOrder.get("PO-C")).toBe(true);
    expect(lateByOrder.get("PO-D")).toBe(true);
    expect(result.summary.lateOrders).toEqual([
      { manufacturingOrderId: "mo-d", orderNumber: "PO-D", dueDate: "2026-08-10", plannedFinish: null },
      { manufacturingOrderId: "mo-b", orderNumber: "PO-B", dueDate: "2026-08-26", plannedFinish: "2026-08-28" },
      { manufacturingOrderId: "mo-c", orderNumber: "PO-C", dueDate: "2026-08-26", plannedFinish: "2026-08-28" },
    ]);
    expect(result.summary.unplannedOrders).toEqual([{ manufacturingOrderId: "mo-d", orderNumber: "PO-D" }]);
  });

  it("counts overloaded resource cells", () => {
    const result = computeCapacity(
      calcInput({
        workCenters: [wc({ workCenterId: "wc-1", weekScheduleId: "ws-40" })],
        ...STD_WEEK,
        operations: [
          op({ moOperationId: "a", runTimePerUnit: 270, plannedWeeks: [{ monday: W34, minutes: 2700 }] }), // 45 h in a 40 h week
          op({ moOperationId: "b", manufacturingOrderId: "mo-2", orderNumber: "PO-2", runTimePerUnit: 240, plannedWeeks: [{ monday: W36, minutes: 2400 }] }), // exactly 40 h
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
      lateOrders: [],
      unplannedOrders: [{ manufacturingOrderId: "mo-1", orderNumber: "PO-1" }],
    });
  });
});
