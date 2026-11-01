import { describe, expect, it } from "vitest";
import {
  leadDaysFromWork,
  manufacturingLeadDays,
  moStartDate,
  routingLeadWork,
  type LeadTimeResource,
} from "../src/modules/planning/service/manufacturing-lead-time.js";
import { remainingOperationMinutes, type CapacityOperationRow } from "../src/modules/planning/service/capacity-calc.js";

// Pure tests — no database. Tillverkningsledtid (#13): the article's field
// wins, otherwise the routing's operations without capacity, rounded up to
// whole working days; and a TO's start date.

const own = (hoursPerDay: number | null): LeadTimeResource => ({
  type: "machine",
  hoursPerDay,
  leadTimeDays: null,
  queueTimeDays: null,
});
const lego = (leadTimeDays: number | null, queueTimeDays: number | null): LeadTimeResource => ({
  type: "subcontract",
  hoursPerDay: null,
  leadTimeDays,
  queueTimeDays,
});
const NO_HOLIDAYS = new Set<string>();

describe("manufacturingLeadDays", () => {
  it("the field wins when set, even 0, regardless of the operations", () => {
    const work = [{ minutes: 3000, resource: own(8) }];
    expect(manufacturingLeadDays(5, work)).toBe(5);
    expect(manufacturingLeadDays(0, work)).toBe(0);
  });

  it("without the field: minutes / (hours_per_day × 60), null hours = 8 h, rounded up", () => {
    // 480 min at 8 h/day = exactly 1 day; 481 min = 2 days.
    expect(manufacturingLeadDays(null, [{ minutes: 480, resource: own(null) }])).toBe(1);
    expect(manufacturingLeadDays(undefined, [{ minutes: 481, resource: own(null) }])).toBe(2);
    // 480 min at 4 h/day = 2 days.
    expect(manufacturingLeadDays(null, [{ minutes: 480, resource: own(4) }])).toBe(2);
    // A missing resource counts as 8 h/day.
    expect(manufacturingLeadDays(null, [{ minutes: 960, resource: null }])).toBe(2);
  });

  it("a lego operation is the supplier's lead time plus the queue time, null = 0", () => {
    expect(manufacturingLeadDays(null, [{ minutes: 0, resource: lego(5, 2) }])).toBe(7);
    expect(manufacturingLeadDays(null, [{ minutes: 0, resource: lego(null, null) }])).toBe(0);
    expect(manufacturingLeadDays(null, [{ minutes: 0, resource: lego(3.5, null) }])).toBe(4);
  });

  it("sums the operations before rounding up", () => {
    // 0.5 + 0.5 + 0.25 days = 1.25 → 2, not 1 + 1 + 1 = 3.
    const work = [
      { minutes: 240, resource: own(8) },
      { minutes: 240, resource: own(8) },
      { minutes: 120, resource: own(8) },
    ];
    expect(leadDaysFromWork(work)).toBe(2);
    // Float noise (0.1 + 0.2 days) never rounds into an extra day.
    expect(leadDaysFromWork([{ minutes: 48, resource: own(8) }, { minutes: 96, resource: own(8) }, { minutes: 336, resource: own(8) }])).toBe(1);
  });

  it("no operations ⇒ 0", () => {
    expect(manufacturingLeadDays(null, [])).toBe(0);
  });

  it("routingLeadWork uses setup + run × quantity for a proposal or new TO", () => {
    const resources = new Map([["wc-1", own(8)], ["wc-lego", lego(4, 1)]]);
    const work = routingLeadWork(
      [
        { workCenterId: "wc-1", setupTime: 60, runTimePerUnit: 6 },
        { workCenterId: "wc-lego", setupTime: 0, runTimePerUnit: 0 },
        { workCenterId: "wc-gone", setupTime: 30, runTimePerUnit: 1 },
      ],
      100,
      (id) => resources.get(id)
    );
    expect(work.map((w) => w.minutes)).toEqual([660, 0, 130]);
    expect(work[2]!.resource).toBeNull();
    // 660/480 = 1.375 + 5 + 130/480 = 0.27 → 6.65 → 7 days.
    expect(leadDaysFromWork(work)).toBe(7);
  });

  it("an existing TO uses its remaining minutes — a partly reported TO needs less time", () => {
    const op: CapacityOperationRow = {
      moOperationId: "op-1",
      manufacturingOrderId: "mo-1",
      orderNumber: "TO-1",
      articleNumber: "A",
      articleName: "A",
      workCenterId: "wc-1",
      orderQuantity: 100,
      dueDate: null,
      sequenceNo: 10,
      setupTime: 120,
      runTimePerUnit: 6,
      operationStatus: "pending",
      quantityCompleted: 60,
      quantityScrapped: 0,
    };
    // 40 left × 6 min, the setup is consumed: 240 min = 0.5 day → 1 day;
    // untouched it would be 720 min → 2 days.
    expect(manufacturingLeadDays(null, [{ minutes: remainingOperationMinutes(op), resource: own(8) }])).toBe(1);
    expect(
      manufacturingLeadDays(null, [{ minutes: remainingOperationMinutes({ ...op, quantityCompleted: null }), resource: own(8) }])
    ).toBe(2);
  });
});

describe("moStartDate", () => {
  it("the due date minus the lead time wins over an EARLIER planned week (Planera fills capacity from today)", () => {
    // Base: Fri 2026-12-18 minus 3 working days = Tue 12-15; the plan says
    // week 11-09 — earlier, not binding ⇒ the base.
    expect(
      moStartDate({
        plannedStartWeeks: ["2026-11-16", null, "2026-11-09", undefined],
        planFixed: false,
        dueDate: "2026-12-18",
        leadDays: 3,
        offDays: NO_HOLIDAYS,
      })
    ).toBe("2026-12-15");
  });

  it("a binding plan (locked or reported on) wins with the Monday of its earliest week", () => {
    expect(
      moStartDate({
        plannedStartWeeks: ["2026-11-16", null, "2026-11-09"],
        planFixed: true,
        dueDate: "2026-12-18",
        leadDays: 3,
        offDays: NO_HOLIDAYS,
      })
    ).toBe("2026-11-09");
  });

  it("a planned week LATER than the base wins (overload pushed the work back)", () => {
    // Base Wed 2026-11-11; planned week 11-16 is later ⇒ 11-16. A planned
    // Monday in the base's own week (11-09) is earlier ⇒ the base.
    expect(
      moStartDate({ plannedStartWeeks: ["2026-11-16"], planFixed: false, dueDate: "2026-11-16", leadDays: 3, offDays: NO_HOLIDAYS })
    ).toBe("2026-11-16");
    expect(
      moStartDate({ plannedStartWeeks: ["2026-11-09"], planFixed: false, dueDate: "2026-11-16", leadDays: 3, offDays: NO_HOLIDAYS })
    ).toBe("2026-11-11");
  });

  it("without a plan: the due date minus the lead time in working days", () => {
    // Mon 2026-11-16 minus 3 working days = Wed 11-11.
    expect(moStartDate({ plannedStartWeeks: [], planFixed: false, dueDate: "2026-11-16", leadDays: 3, offDays: NO_HOLIDAYS })).toBe(
      "2026-11-11"
    );
    // Lead time 0: the due date itself.
    expect(
      moStartDate({ plannedStartWeeks: [null], planFixed: false, dueDate: "2026-11-16", leadDays: 0, offDays: NO_HOLIDAYS })
    ).toBe("2026-11-16");
    // A full-day holiday is skipped.
    expect(
      moStartDate({ plannedStartWeeks: [], planFixed: false, dueDate: "2026-11-16", leadDays: 1, offDays: new Set(["2026-11-13"]) })
    ).toBe("2026-11-12");
  });

  it("without a due date the planned week is all there is; without either it stays undated", () => {
    expect(
      moStartDate({ plannedStartWeeks: ["2026-11-23"], planFixed: false, dueDate: null, leadDays: 5, offDays: NO_HOLIDAYS })
    ).toBe("2026-11-23");
    expect(moStartDate({ plannedStartWeeks: [null], planFixed: false, dueDate: null, leadDays: 5, offDays: NO_HOLIDAYS })).toBeNull();
  });
});
