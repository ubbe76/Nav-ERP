import { describe, expect, it } from "vitest";
import {
  leadDaysFromWork,
  legoOperationDates,
  legoReturnDate,
  manufacturingLeadDays,
  moStartDate,
  queueGapDays,
  routingLeadWork,
  type LeadTimeResource,
} from "../src/modules/planning/service/manufacturing-lead-time.js";
import { remainingOperationMinutes, type CapacityOperationRow } from "../src/modules/planning/service/capacity-calc.js";

// Pure tests — no database. Tillverkningsledtid (#13): the article's field
// wins, otherwise the routing's operations counted like the capacity book
// places them on an empty resource (#18, S5–S7: at least a whole day per
// operation with time, the queue time rounded up on its sum); and a TO's
// start date.

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

  it("a lego operation is the day it is sent plus the supplier's lead + queue time rounded up, null = 0", () => {
    // As the book places it: sent on its floor, back ceil(L + Q) working
    // days later, the next operation the day after.
    expect(manufacturingLeadDays(null, [{ minutes: 0, resource: lego(5, 2) }])).toBe(8);
    expect(manufacturingLeadDays(null, [{ minutes: 0, resource: lego(null, null) }])).toBe(1);
    expect(manufacturingLeadDays(null, [{ minutes: 0, resource: lego(3.5, null) }])).toBe(5);
    expect(manufacturingLeadDays(null, [{ minutes: 0, resource: lego(0.5, 0.2) }, { minutes: 0, resource: lego(0.5, 0.2) }])).toBe(4);
  });

  it("every own operation with time takes at least one whole day — rounded up per operation, like the plan", () => {
    // 0.5 + 0.5 + 0.25 days of work are three days in the plan (the next
    // operation starts the working day after), so the lead time says 3.
    const work = [
      { minutes: 240, resource: own(8) },
      { minutes: 240, resource: own(8) },
      { minutes: 120, resource: own(8) },
    ];
    expect(leadDaysFromWork(work)).toBe(3);
    // 1.25 + 2.5 days ⇒ 2 + 3.
    expect(leadDaysFromWork([{ minutes: 600, resource: own(8) }, { minutes: 1200, resource: own(8) }])).toBe(5);
    // Float noise never rounds into an extra day.
    expect(leadDaysFromWork([{ minutes: 480.0000001, resource: own(8) }])).toBe(1);
    expect(leadDaysFromWork([{ minutes: 0.3 * 480, resource: own(8) }, { minutes: (0.1 + 0.2) * 4800, resource: own(8) }])).toBe(4);
  });

  it("an operation without time takes no day and no queue (S7)", () => {
    const day = { minutes: 480, resource: own(8) };
    const none = { minutes: 0, resource: own(8) };
    expect(leadDaysFromWork([day, none, day])).toBe(2);
    expect(leadDaysFromWork([day, none, day], 1)).toBe(3); // ONE gap, not two
    expect(leadDaysFromWork([none, { minutes: 0.005, resource: own(8) }], 2)).toBe(0);
    // A lego operation has no minutes but always takes its place.
    expect(leadDaysFromWork([day, { minutes: 0, resource: lego(null, null) }, day], 1)).toBe(5);
  });

  it("no operations ⇒ 0", () => {
    expect(manufacturingLeadDays(null, [])).toBe(0);
  });

  describe("Standardledtid and Standardkötid (system settings)", () => {
    const defaults = { defaultLeadDays: 3, queueDays: 1.5 };

    it("the field still wins over both", () => {
      expect(manufacturingLeadDays(2, [], defaults)).toBe(2);
      expect(manufacturingLeadDays(0, [{ minutes: 480, resource: own(8) }], defaults)).toBe(0);
    });

    it("the queue time is waited BETWEEN operations, rounded up on ITS sum (the sum of the gaps)", () => {
      // Two operations of 1 day each + ONE queue of 1.5 ⇒ 2 + 2 = 4.
      const two = [{ minutes: 480, resource: own(8) }, { minutes: 480, resource: own(8) }];
      expect(manufacturingLeadDays(null, two, defaults)).toBe(4);
      // Three half-day operations (a day each) + two queues of 1.5 (3) ⇒ 6.
      const three = [{ minutes: 240, resource: own(8) }, { minutes: 240, resource: own(8) }, { minutes: 240, resource: own(8) }];
      expect(leadDaysFromWork(three, 1.5)).toBe(6);
      // Four operations with a queue of 0.5: three gaps are 2 days (S4), not 3.
      expect(leadDaysFromWork([...three, three[0]!], 0.5)).toBe(6);
      // The queue part is exactly the sum of the book's gaps.
      for (const q of [0, 0.1, 0.5, 1, 1.5]) {
        for (let n = 1; n <= 8; n++) {
          const work = Array.from({ length: n }, () => ({ minutes: 480, resource: own(8) }));
          const gaps = Array.from({ length: n - 1 }, (_, i) => queueGapDays(i + 1, q)).reduce((a, b) => a + b, 0);
          expect(leadDaysFromWork(work, q)).toBe(n + gaps);
        }
      }
      // A lego operation in the chain queues like any other.
      expect(manufacturingLeadDays(null, [{ minutes: 480, resource: own(8) }, { minutes: 0, resource: lego(2, 0) }], defaults)).toBe(6);
    });

    it("a single operation gets no queue time", () => {
      expect(manufacturingLeadDays(null, [{ minutes: 480, resource: own(8) }], defaults)).toBe(1);
      expect(leadDaysFromWork([{ minutes: 481, resource: own(8) }], 10)).toBe(2);
    });

    it("no operations at all ⇒ the Standardledtid, rounded up to whole days like the field", () => {
      expect(manufacturingLeadDays(null, [], defaults)).toBe(3);
      expect(manufacturingLeadDays(undefined, [], { defaultLeadDays: 2.5, queueDays: 0 })).toBe(3);
      expect(manufacturingLeadDays(null, [], { defaultLeadDays: 0, queueDays: 5 })).toBe(0);
    });

    it("an existing TO whose operations are all done needs 0 — not the Standardledtid", () => {
      const allDone = [
        { minutes: 0, resource: own(8), done: true },
        { minutes: 0, resource: own(8), done: true },
      ];
      expect(manufacturingLeadDays(null, allDone, defaults)).toBe(0);
      // A done lego operation no longer counts the supplier's lead time either.
      expect(manufacturingLeadDays(null, [{ minutes: 0, resource: lego(5, 2), done: true }], defaults)).toBe(0);
    });

    it("a partly done TO queues only between the REMAINING operations", () => {
      // Done, remaining, remaining: one queue (not two) ⇒ 1 + 1 + 1.5 = 3.5 ⇒ 4.
      const work = [
        { minutes: 0, resource: own(8), done: true },
        { minutes: 480, resource: own(8) },
        { minutes: 480, resource: own(8) },
      ];
      expect(manufacturingLeadDays(null, work, defaults)).toBe(4);
      // One remaining ⇒ no queue at all.
      expect(manufacturingLeadDays(null, [work[0]!, work[1]!], defaults)).toBe(1);
    });

    it("the defaults are optional and 0 by default — today's behaviour", () => {
      const two = [{ minutes: 480, resource: own(8) }, { minutes: 480, resource: own(8) }];
      expect(manufacturingLeadDays(null, two)).toBe(2);
      expect(manufacturingLeadDays(null, two, { defaultLeadDays: 9, queueDays: 0 })).toBe(2);
    });
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
    // 660/480 = 1.375 ⇒ 2 days, lego 1 + 5, 130/480 = 0.27 ⇒ 1 day.
    expect(leadDaysFromWork(work)).toBe(9);
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
  it("the due date minus the lead time wins over an EARLIER planned day (Planera fills capacity from today)", () => {
    // Base: Fri 2026-12-18 minus 3 working days = Tue 12-15; the plan says
    // 11-10 — earlier, not binding ⇒ the base.
    expect(
      moStartDate({
        plannedStartDates: ["2026-11-17", null, "2026-11-10", undefined],
        planFixed: false,
        dueDate: "2026-12-18",
        leadDays: 3,
        offDays: NO_HOLIDAYS,
      })
    ).toBe("2026-12-15");
  });

  it("a binding plan (locked or reported on) wins with its earliest day", () => {
    expect(
      moStartDate({
        plannedStartDates: ["2026-11-17", null, "2026-11-10"],
        planFixed: true,
        dueDate: "2026-12-18",
        leadDays: 3,
        offDays: NO_HOLIDAYS,
      })
    ).toBe("2026-11-10");
  });

  it("a planned day LATER than the base wins — compared per day (overload pushed the work back)", () => {
    // Base Wed 2026-11-11. Planned the day after ⇒ that day; planned two
    // days after ⇒ two days (it was 0 or 7 while the plan counted weeks);
    // planned on the base or before it ⇒ the base.
    const start = (planned: string) =>
      moStartDate({ plannedStartDates: [planned], planFixed: false, dueDate: "2026-11-16", leadDays: 3, offDays: NO_HOLIDAYS });
    expect(start("2026-11-12")).toBe("2026-11-12");
    expect(start("2026-11-13")).toBe("2026-11-13");
    expect(start("2026-11-11")).toBe("2026-11-11");
    expect(start("2026-11-09")).toBe("2026-11-11");
  });

  it("without a plan: the due date minus the lead time in working days", () => {
    // Mon 2026-11-16 minus 3 working days = Wed 11-11.
    expect(moStartDate({ plannedStartDates: [], planFixed: false, dueDate: "2026-11-16", leadDays: 3, offDays: NO_HOLIDAYS })).toBe(
      "2026-11-11"
    );
    // Lead time 0: the due date itself.
    expect(
      moStartDate({ plannedStartDates: [null], planFixed: false, dueDate: "2026-11-16", leadDays: 0, offDays: NO_HOLIDAYS })
    ).toBe("2026-11-16");
    // A full-day holiday is skipped.
    expect(
      moStartDate({ plannedStartDates: [], planFixed: false, dueDate: "2026-11-16", leadDays: 1, offDays: new Set(["2026-11-13"]) })
    ).toBe("2026-11-12");
  });

  it("without a due date the planned day is all there is; without either it stays undated", () => {
    expect(
      moStartDate({ plannedStartDates: ["2026-11-25"], planFixed: false, dueDate: null, leadDays: 5, offDays: NO_HOLIDAYS })
    ).toBe("2026-11-25");
    expect(moStartDate({ plannedStartDates: [null], planFixed: false, dueDate: null, leadDays: 5, offDays: NO_HOLIDAYS })).toBeNull();
  });
});

// Lego dating (user decision 2026-11-04): Planera never plans a lego
// operation, so it is dated backward from the TO's färdigdatum.
describe("legoOperationDates", () => {
  const due = "2030-03-15"; // Friday
  const supplier = lego(3, 1); // 4 working days at the supplier
  const oneDay = { minutes: 480, resource: own(8) };

  it("the last operation must be back on the due date and at the supplier its lead + queue time before", () => {
    expect(
      legoOperationDates({ dueDate: due, fallbackStart: null, lego: supplier, after: [], queueDays: 0, offDays: NO_HOLIDAYS })
    ).toEqual({ finishDate: "2030-03-15", startDate: "2030-03-11" });
  });

  it("the operations after it, with one Standardkötid before each, move both dates back", () => {
    // After: 1 day + 1 queue ⇒ back Wed 03-13; + 4 ⇒ at the supplier Thu 03-07.
    expect(
      legoOperationDates({ dueDate: due, fallbackStart: null, lego: supplier, after: [oneDay], queueDays: 1, offDays: NO_HOLIDAYS })
    ).toEqual({ finishDate: "2030-03-13", startDate: "2030-03-07" });
    // A holiday on the Wednesday is skipped.
    expect(
      legoOperationDates({ dueDate: due, fallbackStart: null, lego: supplier, after: [oneDay], queueDays: 1, offDays: new Set(["2030-03-13"]) })
        .finishDate
    ).toBe("2030-03-12");
  });

  it("a done operation after it takes no time and no queue; the operations after it count like the lead time", () => {
    expect(
      legoOperationDates({
        dueDate: due,
        fallbackStart: null,
        lego: supplier,
        after: [{ ...oneDay, done: true }],
        queueDays: 1,
        offDays: NO_HOLIDAYS,
      })
    ).toEqual({ finishDate: "2030-03-15", startDate: "2030-03-11" });
    // Half a day after it is a whole day in the plan ⇒ back one day earlier;
    // the lego days are whole too (3.5 + 0.5 = 4).
    const half = { minutes: 240, resource: own(8) };
    expect(
      legoOperationDates({ dueDate: due, fallbackStart: null, lego: lego(3.5, 0.5), after: [half], queueDays: 0, offDays: NO_HOLIDAYS })
    ).toEqual({ finishDate: "2030-03-14", startDate: "2030-03-08" });
    expect(
      legoOperationDates({ dueDate: due, fallbackStart: null, lego: lego(2.2, null), after: [half], queueDays: 0, offDays: NO_HOLIDAYS })
    ).toEqual({ finishDate: "2030-03-14", startDate: "2030-03-11" });
    // An operation without time after it takes no day and no queue; two
    // half-day operations with a queue of 0.5 before each: 2 + ceil(1) = 3.
    const none = { minutes: 0, resource: own(8) };
    expect(
      legoOperationDates({ dueDate: due, fallbackStart: null, lego: supplier, after: [none], queueDays: 2, offDays: NO_HOLIDAYS }).finishDate
    ).toBe("2030-03-15");
    expect(
      legoOperationDates({ dueDate: due, fallbackStart: null, lego: supplier, after: [half, none, half], queueDays: 0.5, offDays: NO_HOLIDAYS })
    ).toEqual({ finishDate: "2030-03-12", startDate: "2030-03-06" });
  });

  it("a later lego operation after it takes its sent day too — the book's walk read backward", () => {
    // After: an own day, then a lego operation of 2 days (1 + 2), no queue:
    // back 4 working days before the due date, sent 4 more before that.
    const laterLego = { minutes: 0, resource: lego(2, null) };
    expect(
      legoOperationDates({ dueDate: due, fallbackStart: null, lego: supplier, after: [oneDay, laterLego], queueDays: 0, offDays: NO_HOLIDAYS })
    ).toEqual({ finishDate: "2030-03-11", startDate: "2030-03-05" });
  });

  it("without a due date the TO's start is the start; without either the operation is undated", () => {
    expect(
      legoOperationDates({ dueDate: null, fallbackStart: "2030-03-04", lego: supplier, after: [], queueDays: 0, offDays: NO_HOLIDAYS })
    ).toEqual({ startDate: "2030-03-04", finishDate: "2030-03-08" });
    expect(
      legoOperationDates({ dueDate: null, fallbackStart: null, lego: supplier, after: [], queueDays: 0, offDays: NO_HOLIDAYS })
    ).toEqual({ startDate: null, finishDate: null });
  });
});

describe("legoReturnDate", () => {
  const supplier = lego(3, 1);
  // Ordered Mon 03-04: Ledtid beställning 2 + lead 3 + queue 1 ⇒ back Tue 03-12 at the earliest.
  const today = "2030-03-04";

  it("the finish date when it can be met, else the earliest return and late", () => {
    expect(legoReturnDate({ finishDate: "2030-03-15", today, lego: supplier, orderLeadTimeDays: 2, offDays: NO_HOLIDAYS })).toEqual({
      date: "2030-03-15",
      late: false,
    });
    expect(legoReturnDate({ finishDate: "2030-03-12", today, lego: supplier, orderLeadTimeDays: 2, offDays: NO_HOLIDAYS })).toEqual({
      date: "2030-03-12",
      late: false,
    });
    expect(legoReturnDate({ finishDate: "2030-03-08", today, lego: supplier, orderLeadTimeDays: 2, offDays: NO_HOLIDAYS })).toEqual({
      date: "2030-03-12",
      late: true,
    });
  });

  it("an undated operation gets the earliest return without a warning; a weekend today starts on Monday", () => {
    expect(legoReturnDate({ finishDate: null, today, lego: supplier, orderLeadTimeDays: 2, offDays: NO_HOLIDAYS })).toEqual({
      date: "2030-03-12",
      late: false,
    });
    expect(legoReturnDate({ finishDate: null, today: "2030-03-02", lego: supplier, orderLeadTimeDays: null, offDays: NO_HOLIDAYS })).toEqual({
      date: "2030-03-08",
      late: false,
    });
  });
});
