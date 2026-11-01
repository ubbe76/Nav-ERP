import { describe, expect, it } from "vitest";
import {
  buildLeadTimeContext,
  computeMoStartDates,
  configuredLeadDays,
  type DatingMoOperation,
  type DatingWorkCenter,
} from "../src/modules/planning/service/requirements-dating.js";

// Pure tests — no database. The dating leaf turns the repository's flat rows
// (resources, routings, TO operations, the Ledtid (dagar) field) into the
// lead-time rules of manufacturing-lead-time.ts; the rules themselves are
// covered in manufacturing-lead-time.test.ts.

const own: DatingWorkCenter = { workCenterId: "w1", type: "machine", hoursPerDay: 8, leadTimeDays: null, queueTimeDays: null, orderLeadTimeDays: null };
const lego: DatingWorkCenter = { workCenterId: "w2", type: "subcontract", hoursPerDay: null, leadTimeDays: 3, queueTimeDays: 1, orderLeadTimeDays: 2 };
const noHolidays = new Set<string>();

const op = (partial: Partial<DatingMoOperation> & { manufacturingOrderId: string }): DatingMoOperation => ({
  workCenterId: "w1",
  setupTime: 0,
  runTimePerUnit: 480,
  operationStatus: "pending",
  orderQuantity: 2,
  quantityCompleted: null,
  quantityScrapped: 0,
  plannedStartWeek: null,
  planLocked: false,
  ...partial,
});

describe("buildLeadTimeContext", () => {
  const ctx = buildLeadTimeContext({
    articleLeadTimes: new Map([["field", 5]]),
    routings: [
      { articleId: "routed", workCenterId: "w1", setupTime: 60, runTimePerUnit: 120 },
      { articleId: "routed", workCenterId: "w2", setupTime: 0, runTimePerUnit: 0 },
    ],
    workCenters: [own, lego],
  });

  it("the field wins over the routing, independent of quantity", () => {
    expect(ctx.leadDaysFor("field", 1)).toBe(5);
    expect(ctx.leadDaysFor("field", 1000)).toBe(5);
  });

  it("without a field the routing's minutes for the quantity plus the lego lead and queue time, rounded up", () => {
    // 60 + 120 × 3 = 420 min / 480 = 0.875 days + lego 3 + 1 ⇒ 4.875 ⇒ 5.
    expect(ctx.leadDaysFor("routed", 3)).toBe(5);
    // 60 + 120 × 20 = 2460 / 480 = 5.125 + 4 ⇒ 9.125 ⇒ 10.
    expect(ctx.leadDaysFor("routed", 20)).toBe(10);
  });

  it("no field and no routing ⇒ 0; Ledtid beställning comes from the resource", () => {
    expect(ctx.leadDaysFor("unknown", 7)).toBe(0);
    expect(ctx.orderLeadTimeDaysOf("w2")).toBe(2);
    expect(ctx.orderLeadTimeDaysOf("w1")).toBeNull();
    expect(ctx.orderLeadTimeDaysOf("gone")).toBeNull();
  });
});

describe("buildLeadTimeContext with Standardledtid and Standardkötid", () => {
  const ctx = buildLeadTimeContext({
    articleLeadTimes: new Map([["field", 2]]),
    routings: [
      { articleId: "two", workCenterId: "w1", setupTime: 0, runTimePerUnit: 480 },
      { articleId: "two", workCenterId: "w1", setupTime: 0, runTimePerUnit: 480 },
      { articleId: "one", workCenterId: "w1", setupTime: 0, runTimePerUnit: 480 },
    ],
    workCenters: [own],
    defaults: { defaultLeadDays: 4, queueDays: 1 },
  });

  it("the field wins; a routing gets the queue time between its operations; one operation none; no routing ⇒ Standardledtid", () => {
    expect(ctx.leadDaysFor("field", 50)).toBe(2);
    // 1 + 1 days + one queue ⇒ 3.
    expect(ctx.leadDaysFor("two", 1)).toBe(3);
    expect(ctx.leadDaysFor("one", 1)).toBe(1);
    expect(ctx.leadDaysFor("unrouted", 1)).toBe(4);
    expect(ctx.defaults).toEqual({ defaultLeadDays: 4, queueDays: 1 });
  });

  it("without the pair the context behaves as before (0/0)", () => {
    const plain = buildLeadTimeContext({ articleLeadTimes: new Map(), routings: [], workCenters: [own] });
    expect(plain.defaults).toEqual({ defaultLeadDays: 0, queueDays: 0 });
    expect(plain.leadDaysFor("unrouted", 1)).toBe(0);
  });
});

describe("computeMoStartDates", () => {
  const ctx = buildLeadTimeContext({
    articleLeadTimes: new Map([["f", 3]]),
    routings: [{ articleId: "r", workCenterId: "w1", setupTime: 0, runTimePerUnit: 480 }],
    workCenters: [own],
  });

  it("a TO with operations is measured on their REMAINING minutes — a partly reported TO starts later", () => {
    const starts = computeMoStartDates({
      // Fri 2030-03-08; 2 units × 480 min on an 8 h resource = 2 days.
      orders: [
        { manufacturingOrderId: "m1", articleId: "r", quantity: 2, dueDate: "2030-03-08" },
        { manufacturingOrderId: "m2", articleId: "r", quantity: 2, dueDate: "2030-03-08" },
      ],
      operations: [op({ manufacturingOrderId: "m1" }), op({ manufacturingOrderId: "m2", quantityCompleted: 1 })],
      articleLeadTimes: new Map(),
      context: ctx,
      offDays: noHolidays,
    });
    expect(starts.get("m1")).toBe("2030-03-06"); // two working days before Friday
    expect(starts.get("m2")).toBe("2030-03-07"); // one unit left ⇒ one day
  });

  it("a TO without operations (planned, no snapshot) uses the article's routing for its quantity", () => {
    const starts = computeMoStartDates({
      orders: [{ manufacturingOrderId: "m1", articleId: "r", quantity: 3, dueDate: "2030-03-15" }],
      operations: [],
      articleLeadTimes: new Map(),
      context: ctx,
      offDays: noHolidays,
    });
    expect(starts.get("m1")).toBe("2030-03-12"); // 3 days before Fri 03-15
  });

  it("the field wins for both kinds, and a full-day holiday is skipped", () => {
    const starts = computeMoStartDates({
      orders: [
        { manufacturingOrderId: "ops", articleId: "f", quantity: 2, dueDate: "2030-03-08" },
        { manufacturingOrderId: "none", articleId: "f", quantity: 2, dueDate: "2030-03-08" },
      ],
      operations: [op({ manufacturingOrderId: "ops" })],
      articleLeadTimes: new Map([["f", 3]]),
      context: ctx,
      offDays: new Set(["2030-03-06"]),
    });
    // 3 working days before Fri 03-08 skipping Wed 03-06: 07, 05, 04.
    expect(starts.get("ops")).toBe("2030-03-04");
    expect(starts.get("none")).toBe("2030-03-04");
  });

  it("an earlier unbinding plan loses to the lead time; a locked or reported-on plan and a later week win", () => {
    // Due Fri 2030-03-29; one operation of 2 × 480 min at 8 h/day ⇒ 2
    // working days ⇒ base Wed 03-27 ("early" has two operations ⇒ 4 days ⇒
    // Mon 03-25).
    const due = "2030-03-29";
    const starts = computeMoStartDates({
      orders: [
        { manufacturingOrderId: "early", articleId: "r", quantity: 2, dueDate: due },
        { manufacturingOrderId: "locked", articleId: "r", quantity: 2, dueDate: due },
        { manufacturingOrderId: "reported", articleId: "r", quantity: 2, dueDate: due },
        { manufacturingOrderId: "later", articleId: "r", quantity: 2, dueDate: due },
        { manufacturingOrderId: "undated", articleId: "r", quantity: 2, dueDate: null },
      ],
      operations: [
        op({ manufacturingOrderId: "early", plannedStartWeek: "2030-03-18" }),
        op({ manufacturingOrderId: "early", plannedStartWeek: "2030-03-11" }),
        op({ manufacturingOrderId: "locked", plannedStartWeek: "2030-03-11", planLocked: true }),
        op({ manufacturingOrderId: "reported", plannedStartWeek: "2030-03-11", quantityScrapped: 1 }),
        op({ manufacturingOrderId: "later", plannedStartWeek: "2030-04-01" }),
        op({ manufacturingOrderId: "undated" }),
      ],
      articleLeadTimes: new Map(),
      context: ctx,
      offDays: noHolidays,
    });
    expect(starts.get("early")).toBe("2030-03-25");
    expect(starts.get("locked")).toBe("2030-03-11");
    expect(starts.get("reported")).toBe("2030-03-11");
    expect(starts.get("later")).toBe("2030-04-01");
    expect(starts.get("undated")).toBeNull();
  });
});

describe("computeMoStartDates with Standardledtid and Standardkötid", () => {
  const ctx = buildLeadTimeContext({
    articleLeadTimes: new Map([["f", 1]]),
    routings: [{ articleId: "r", workCenterId: "w1", setupTime: 0, runTimePerUnit: 480 }],
    workCenters: [own],
    defaults: { defaultLeadDays: 3, queueDays: 1 },
  });
  const due = "2030-03-15"; // Friday

  it("a TO with operations: remaining time + queue between the REMAINING operations; all done ⇒ 0; no operations ⇒ routing or Standardledtid", () => {
    const starts = computeMoStartDates({
      orders: [
        { manufacturingOrderId: "two", articleId: "r", quantity: 1, dueDate: due },
        { manufacturingOrderId: "partly", articleId: "r", quantity: 1, dueDate: due },
        { manufacturingOrderId: "alldone", articleId: "r", quantity: 1, dueDate: due },
        { manufacturingOrderId: "routed", articleId: "r", quantity: 2, dueDate: due },
        { manufacturingOrderId: "unrouted", articleId: "x", quantity: 2, dueDate: due },
        { manufacturingOrderId: "field", articleId: "f", quantity: 2, dueDate: due },
      ],
      operations: [
        // Two pending operations of 1 day each + one queue ⇒ 3 days ⇒ Tue 03-12.
        op({ manufacturingOrderId: "two", orderQuantity: 1 }),
        op({ manufacturingOrderId: "two", orderQuantity: 1 }),
        // One done, two pending ⇒ 2 days + ONE queue ⇒ 3 ⇒ Tue 03-12 (two
        // queues would give Mon 03-11).
        op({ manufacturingOrderId: "partly", orderQuantity: 1, operationStatus: "done" }),
        op({ manufacturingOrderId: "partly", orderQuantity: 1 }),
        op({ manufacturingOrderId: "partly", orderQuantity: 1 }),
        // Every operation done ⇒ 0 days: the due date itself, never the Standardledtid.
        op({ manufacturingOrderId: "alldone", orderQuantity: 1, operationStatus: "done" }),
        op({ manufacturingOrderId: "alldone", orderQuantity: 1, operationStatus: "done" }),
      ],
      articleLeadTimes: new Map([["f", 1]]),
      context: ctx,
      offDays: noHolidays,
    });
    expect(starts.get("two")).toBe("2030-03-12");
    expect(starts.get("partly")).toBe("2030-03-12");
    expect(starts.get("alldone")).toBe(due);
    // No operations, article routed: 2 units × 1 day, one operation ⇒ no queue ⇒ Wed 03-13.
    expect(starts.get("routed")).toBe("2030-03-13");
    // No operations, no routing ⇒ Standardledtid 3 ⇒ Tue 03-12.
    expect(starts.get("unrouted")).toBe("2030-03-12");
    // The field wins over the Standardledtid ⇒ Thu 03-14.
    expect(starts.get("field")).toBe("2030-03-14");
  });
});

describe("configuredLeadDays", () => {
  const ctx = buildLeadTimeContext({ articleLeadTimes: new Map(), routings: [], workCenters: [own, lego] });

  it("the template's field, else the derived operations for the row quantity", () => {
    const ops = [
      { workCenterId: "w1", setupTime: 30, runTimePerUnit: 90 },
      { workCenterId: "w2", setupTime: 0, runTimePerUnit: 0 },
    ];
    expect(configuredLeadDays(2, ops, 10, ctx)).toBe(2);
    // 30 + 90 × 10 = 930 / 480 = 1.9375 + 4 ⇒ 5.9375 ⇒ 6.
    expect(configuredLeadDays(null, ops, 10, ctx)).toBe(6);
    expect(configuredLeadDays(undefined, [], 10, ctx)).toBe(0);
  });

  it("applies the Standardkötid between the derived operations and the Standardledtid without any", () => {
    const withDefaults = buildLeadTimeContext({
      articleLeadTimes: new Map(),
      routings: [],
      workCenters: [own, lego],
      defaults: { defaultLeadDays: 2, queueDays: 1 },
    });
    const ops = [
      { workCenterId: "w1", setupTime: 0, runTimePerUnit: 48 },
      { workCenterId: "w1", setupTime: 0, runTimePerUnit: 48 },
    ];
    // 1 + 1 days + one queue ⇒ 3; the template's field still wins; no
    // operations ⇒ the Standardledtid.
    expect(configuredLeadDays(null, ops, 10, withDefaults)).toBe(3);
    expect(configuredLeadDays(1, ops, 10, withDefaults)).toBe(1);
    expect(configuredLeadDays(null, [], 10, withDefaults)).toBe(2);
  });
});
