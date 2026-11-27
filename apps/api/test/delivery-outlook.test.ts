import { describe, expect, it } from "vitest";
import { buildArticleOverview, type ArticleOverview, type ArticleOverviewInput } from "../src/modules/planning/service/article-overview.js";
import { uncoveredConfiguredQuantity } from "../src/modules/planning/service/configured-coverage.js";
import {
  configuredRowCoverage,
  isAtRisk,
  orderOutlook,
  outlookRow,
  type OutlookAllocation,
  type OutlookLinkedOrder,
  type OutlookRow,
  type OutlookRowFacts,
} from "../src/modules/planning/service/delivery-outlook.js";
import { pegLateness, pegOverview, pegReadyDate, type PegAllocation, type Pegging, type PegSupplyKind } from "../src/modules/planning/service/pegging.js";
import { deliveryFromShipDate, type DeliverySettings } from "../src/modules/system/service/delivery-days.js";

// Pure tests — no database. Leveransläge (spec 2026-11-26, etapp 3): the
// row and order rules of delivery-outlook.ts, and the lateness rule lifted
// out of pegOverview (pegLateness) — ONE rule for the TO card's Går till and
// the kundorder row's outlook.

const TODAY = "2030-03-04"; // Monday
const NO_HOLIDAYS = new Set<string>();

// Leveransläget's allocations are the pegging's: every flag comes from
// pegLateness, as the service's mapping and configuredRowCoverage do.
function alloc(
  kind: PegSupplyKind,
  quantity: number,
  rawReadyDate: string | null,
  shipDate: string | null,
  extra: Partial<Pick<OutlookAllocation, "isDraft" | "componentLate">> = {},
  offDays: ReadonlySet<string> = NO_HOLIDAYS,
): OutlookAllocation {
  const readyDate = kind === "stock" ? TODAY : pegReadyDate(rawReadyDate, TODAY);
  return {
    kind,
    documentId: kind === "stock" ? null : `${kind}-${rawReadyDate}`,
    documentNumber: kind === "stock" ? null : kind === "purchase_order" ? "IO-1" : "TO-1",
    quantity,
    readyDate,
    ...pegLateness({ kind, readyDate }, shipDate, offDays),
    isDraft: false,
    componentLate: false,
    ...extra,
  };
}

const SHIP = "2030-03-13"; // Wednesday
const PROMISED = "2030-03-14"; // Thursday

function facts(partial: Partial<OutlookRowFacts> = {}): OutlookRowFacts {
  return {
    salesOrderRowId: "r1",
    articleId: "a",
    articleNumber: "A",
    articleName: "Artikel a",
    restQuantity: 10,
    configured: false,
    promisedDate: PROMISED,
    promisedShipDate: SHIP,
    ...partial,
  };
}

// Transit one working day, no fixed days — delivery the working day after
// the goods are ready.
const SETTINGS: DeliverySettings = { weekdays: [], mode: "dispatch", transitDays: 1 };
const deliver = (ship: string) => deliveryFromShipDate(ship, SETTINGS, NO_HOLIDAYS);

const row = (allocations: OutlookAllocation[], uncovered = 0, partial: Partial<OutlookRowFacts> = {}) =>
  outlookRow({ today: TODAY, row: facts(partial), allocations, uncovered, deliver });

describe("outlookRow — status", () => {
  it("tries uncovered, late, undated, on_time in that order", () => {
    const late = alloc("manufacturing_order", 4, "2030-03-15", SHIP);
    const undated = alloc("purchase_order", 3, null, SHIP);
    const onTime = alloc("purchase_order", 3, "2030-03-08", SHIP);
    expect(late.late).toBe(true);
    expect(undated.undated).toBe(true);

    expect(row([late, undated, onTime], 2).status).toBe("uncovered");
    expect(row([late, undated, onTime]).status).toBe("late");
    expect(row([undated, onTime]).status).toBe("undated");
    expect(row([onTime]).status).toBe("on_time");
    // Nothing covers the row at all.
    expect(row([], 10).status).toBe("uncovered");
  });

  it("stock is never late — not even against a ship date that has passed", () => {
    const stock = alloc("stock", 10, null, "2030-02-20");
    expect(stock).toMatchObject({ readyDate: TODAY, late: false, undated: false, daysLate: 0 });
    const r = row([stock], 0, { promisedShipDate: "2030-02-20", promisedDate: "2030-02-21" });
    expect(r.status).toBe("on_time");
    // The row itself is overdue — the lists' Sen, not the supply's delay.
    expect(r.overdue).toBe(true);
    expect(r.atRisk).toBe(false);
  });

  it("ready ON the ship date is on time, the day after is late (S16)", () => {
    const same = row([alloc("manufacturing_order", 10, SHIP, SHIP)]);
    expect(same).toMatchObject({ status: "on_time", daysLate: 0, readyDate: SHIP });
    const after = row([alloc("manufacturing_order", 10, "2030-03-14", SHIP)]);
    expect(after).toMatchObject({ status: "late", daysLate: 1, readyDate: "2030-03-14" });
  });

  it("daysLate is the largest among the allocations, in working days", () => {
    const r = row([
      alloc("stock", 2, null, SHIP),
      alloc("purchase_order", 3, "2030-03-14", SHIP), // Thursday: 1
      alloc("manufacturing_order", 5, "2030-03-18", SHIP), // Monday: Thu, Fri, Mon = 3
    ]);
    expect(r.allocations.map((a) => a.daysLate)).toEqual([0, 1, 3]);
    expect(r.daysLate).toBe(3);
    expect(r.readyDate).toBe("2030-03-18");
  });

  it("a row without a promised date is never late, whatever covers it", () => {
    const supplies = [alloc("manufacturing_order", 6, "2031-01-10", null), alloc("purchase_order", 4, null, null)];
    expect(supplies.map((a) => [a.late, a.undated, a.daysLate])).toEqual([
      [false, false, 0],
      [false, false, 0],
    ]);
    const r = row(supplies, 0, { promisedDate: null, promisedShipDate: null });
    expect(r).toMatchObject({ status: "on_time", daysLate: 0, overdue: false, atRisk: false, estimatedDeliveryDate: null });
    // …but it is uncovered like any other row when nothing covers it.
    expect(row([], 10, { promisedDate: null, promisedShipDate: null }).status).toBe("uncovered");
  });

  it("a passed ready date is today at the earliest", () => {
    const r = row([alloc("manufacturing_order", 10, "2030-02-25", SHIP)]);
    expect(r.readyDate).toBe(TODAY);
    expect(r.status).toBe("on_time");
  });
});

describe("outlookRow — dates", () => {
  it("on time: the estimated delivery is the promised date, never an earlier one (S17)", () => {
    const r = row([alloc("stock", 10, null, SHIP)]);
    expect(r.readyDate).toBe(TODAY);
    expect(r.estimatedShipDate).toBe(SHIP);
    expect(r.estimatedDeliveryDate).toBe(PROMISED);
  });

  it("late: deliver(readyDate) — the latest ready date among the allocations (S17)", () => {
    const r = row([alloc("stock", 4, null, SHIP), alloc("manufacturing_order", 6, "2030-03-15", SHIP)]);
    expect(r.status).toBe("late");
    expect(r.readyDate).toBe("2030-03-15"); // Friday
    expect(r.estimatedShipDate).toBe("2030-03-15");
    expect(r.estimatedDeliveryDate).toBe("2030-03-18"); // Monday
    expect(r.estimatedDeliveryDate).toBe(deliver("2030-03-15"));
  });

  it("late with the customer's fixed delivery days: the next dispatch day plus transit", () => {
    const tuesdays: DeliverySettings = { weekdays: [2], mode: "dispatch", transitDays: 2 };
    const r = outlookRow({
      today: TODAY,
      row: facts(),
      allocations: [alloc("manufacturing_order", 10, "2030-03-14", SHIP)],
      uncovered: 0,
      deliver: (ship) => deliveryFromShipDate(ship, tuesdays, NO_HOLIDAYS),
    });
    // Ready Thursday 14 → dispatched Tuesday 19 → delivered Thursday 21.
    expect(r.estimatedDeliveryDate).toBe("2030-03-21");
  });

  it("without delivery settings `deliver` is the identity", () => {
    const r = outlookRow({
      today: TODAY,
      row: facts({ promisedDate: SHIP }),
      allocations: [alloc("manufacturing_order", 10, "2030-03-15", SHIP)],
      uncovered: 0,
      deliver: (ship) => ship,
    });
    expect(r.estimatedDeliveryDate).toBe("2030-03-15");
  });

  it("no ready date and no estimate while something is uncovered or undated", () => {
    const uncovered = row([alloc("stock", 6, null, SHIP)], 4);
    expect(uncovered).toMatchObject({ status: "uncovered", readyDate: null, estimatedShipDate: null, estimatedDeliveryDate: null });
    const undated = row([alloc("stock", 6, null, SHIP), alloc("purchase_order", 4, null, SHIP)]);
    expect(undated).toMatchObject({ status: "undated", readyDate: null, estimatedShipDate: null, estimatedDeliveryDate: null });
    // Late AND undated: Sen wins, but the day everything is there is unknown.
    const both = row([alloc("manufacturing_order", 6, "2030-03-15", SHIP), alloc("purchase_order", 4, null, SHIP)]);
    expect(both).toMatchObject({ status: "late", daysLate: 2, readyDate: null, estimatedDeliveryDate: null });
  });

  it("overdue is the promised date before today — independent of the status", () => {
    expect(row([alloc("stock", 10, null, SHIP)], 0, { promisedDate: "2030-03-03" }).overdue).toBe(true);
    expect(row([alloc("stock", 10, null, SHIP)], 0, { promisedDate: TODAY }).overdue).toBe(false);
    expect(row([], 10, { promisedDate: null }).overdue).toBe(false);
  });

  it("carries the row's facts, the allocations and the uncovered quantity through", () => {
    const allocations = [alloc("purchase_order", 6, "2030-03-08", SHIP, { isDraft: true })];
    const r = row(allocations, 4);
    expect(r).toMatchObject({ ...facts(), uncovered: 4 });
    expect(r.allocations).toEqual(allocations);
  });
});

describe("isAtRisk (S18)", () => {
  it("late, uncovered or Halvfabrikat sent — never Tillgång utan datum alone", () => {
    expect(isAtRisk({ status: "late", componentLate: false })).toBe(true);
    expect(isAtRisk({ status: "uncovered", componentLate: false })).toBe(true);
    expect(isAtRisk({ status: "undated", componentLate: false })).toBe(false);
    expect(isAtRisk({ status: "on_time", componentLate: false })).toBe(false);
    expect(isAtRisk({ status: "on_time", componentLate: true })).toBe(true);
    expect(isAtRisk({ status: "undated", componentLate: true })).toBe(true);
  });

  it("the row is at risk when a TO covering it has Halvfabrikat sent, although its own plan is on time", () => {
    const r = row([alloc("stock", 4, null, SHIP), alloc("manufacturing_order", 6, "2030-03-08", SHIP, { componentLate: true })]);
    expect(r).toMatchObject({ status: "on_time", componentLate: true, atRisk: true });
    expect(row([alloc("manufacturing_order", 10, "2030-03-08", SHIP)])).toMatchObject({ componentLate: false, atRisk: false });
    expect(row([alloc("purchase_order", 10, null, SHIP)])).toMatchObject({ status: "undated", atRisk: false });
  });
});

describe("orderOutlook", () => {
  const onTime = (partial: Partial<OutlookRowFacts> = {}) => row([alloc("stock", 10, null, SHIP)], 0, partial);
  const late = (ready: string) => row([alloc("manufacturing_order", 10, ready, SHIP)]);
  const undated = () => row([alloc("purchase_order", 10, null, SHIP)]);
  const uncovered = () => row([], 10);

  it("no rows: none — a quote, a delivered order", () => {
    expect(orderOutlook([], "2030-03-14")).toEqual({
      status: "none",
      daysLate: 0,
      atRisk: false,
      promisedDate: "2030-03-14",
      estimatedDeliveryDate: null,
      counts: { late: 0, uncovered: 0, undated: 0, componentLate: 0 },
    });
  });

  it("the worst row's status: uncovered > late > undated > on_time", () => {
    const status = (rows: OutlookRow[]) => orderOutlook(rows, PROMISED).status;
    expect(status([onTime()])).toBe("on_time");
    expect(status([onTime(), undated()])).toBe("undated");
    expect(status([undated(), late("2030-03-15"), onTime()])).toBe("late");
    expect(status([late("2030-03-15"), uncovered(), undated(), onTime()])).toBe("uncovered");
    // The order of the rows never matters.
    expect(status([onTime(), undated(), uncovered(), late("2030-03-15")])).toBe("uncovered");
  });

  it("the largest daysLate, the latest estimated delivery, the head's promised date and the counts", () => {
    const withComponentLate = row([alloc("manufacturing_order", 10, "2030-03-08", SHIP, { componentLate: true })]);
    const o = orderOutlook([onTime(), late("2030-03-15"), late("2030-03-19"), withComponentLate], "2030-03-12");
    expect(o).toEqual({
      status: "late",
      daysLate: 4, // Wed 13 → Tue 19
      atRisk: true,
      promisedDate: "2030-03-12",
      estimatedDeliveryDate: "2030-03-20", // deliver(Tue 19)
      counts: { late: 2, uncovered: 0, undated: 0, componentLate: 1 },
    });
  });

  it("all rows on time: the latest promised date among them", () => {
    const o = orderOutlook([onTime(), onTime({ promisedDate: "2030-03-21", promisedShipDate: "2030-03-20" })], PROMISED);
    expect(o).toMatchObject({ status: "on_time", daysLate: 0, atRisk: false, estimatedDeliveryDate: "2030-03-21" });
  });

  it("no estimated delivery as soon as one row has no ready date", () => {
    expect(orderOutlook([late("2030-03-19"), undated()], PROMISED)).toMatchObject({ status: "late", estimatedDeliveryDate: null });
    expect(orderOutlook([late("2030-03-19"), uncovered()], PROMISED)).toMatchObject({
      status: "uncovered",
      estimatedDeliveryDate: null,
      atRisk: true,
      counts: { late: 1, uncovered: 1, undated: 0, componentLate: 0 },
    });
    expect(orderOutlook([onTime(), undated()], PROMISED)).toMatchObject({ status: "undated", atRisk: false, estimatedDeliveryDate: null });
  });

  it("at risk on Halvfabrikat sent alone", () => {
    const o = orderOutlook([row([alloc("manufacturing_order", 10, "2030-03-08", SHIP, { componentLate: true })])], PROMISED);
    expect(o).toMatchObject({ status: "on_time", atRisk: true, counts: { late: 0, uncovered: 0, undated: 0, componentLate: 1 } });
  });
});

describe("configuredRowCoverage (S19)", () => {
  const linked = (id: string, status: string, quantity: number, received: number, readyDate: string | null, componentLate = false): OutlookLinkedOrder => ({
    id,
    orderNumber: `TO-${id}`,
    status,
    quantity,
    received,
    readyDate,
    componentLate,
  });
  const coverage = (quantityOrdered: number, quantityDelivered: number, linkedOrders: OutlookLinkedOrder[], shipDate: string | null = SHIP) =>
    configuredRowCoverage({ today: TODAY, promisedShipDate: shipDate, quantityOrdered, quantityDelivered, linkedOrders, offDays: NO_HOLIDAYS });

  it("one allocation per open linked TO for what it has yet to receive, flagged by pegLateness", () => {
    const c = coverage(10, 0, [linked("m1", "released", 6, 0, "2030-03-15"), linked("m2", "in_progress", 4, 0, "2030-03-08", true)]);
    expect(c.uncovered).toBe(0);
    expect(c.allocations).toEqual([
      alloc("manufacturing_order", 4, "2030-03-08", SHIP, { componentLate: true }),
      alloc("manufacturing_order", 6, "2030-03-15", SHIP),
    ].map((a, i) => ({ ...a, documentId: ["m2", "m1"][i], documentNumber: ["TO-m2", "TO-m1"][i] })));
    expect(c.allocations.map((a) => [a.late, a.daysLate])).toEqual([
      [false, 0],
      [true, 2],
    ]);
  });

  it("partly received and partly delivered: the finished units are there now, the rest comes from the TO", () => {
    // 10 ordered, 2 delivered; the TO has received 5 of 10 → 3 in stock for
    // the row, 5 still to come.
    const c = coverage(10, 2, [linked("m1", "in_progress", 10, 5, "2030-03-15")]);
    expect(c.uncovered).toBe(0);
    expect(c.allocations.map((a) => [a.kind, a.quantity, a.readyDate, a.late])).toEqual([
      ["stock", 3, TODAY, false],
      ["manufacturing_order", 5, "2030-03-15", true],
    ]);
    const r = outlookRow({ today: TODAY, row: facts({ restQuantity: 8, configured: true }), ...c, deliver });
    expect(r).toMatchObject({ status: "late", daysLate: 2, readyDate: "2030-03-15" });
  });

  it("a finished TO that has not left yet: all in stock, on time", () => {
    const c = coverage(4, 0, [linked("m1", "done", 4, 4, "2030-02-20")]);
    expect(c).toEqual({ allocations: [alloc("stock", 4, null, SHIP)], uncovered: 0 });
    expect(outlookRow({ today: TODAY, row: facts({ restQuantity: 4, configured: true }), ...c, deliver }).status).toBe("on_time");
  });

  it("the uncovered rest is uncoveredConfiguredQuantity — the template's stock is never counted", () => {
    const orders = [linked("m1", "released", 4, 0, "2030-03-08"), linked("m2", "cancelled", 6, 0, "2030-03-08")];
    const c = coverage(10, 0, orders);
    expect(c.uncovered).toBe(6);
    expect(c.uncovered).toBe(uncoveredConfiguredQuantity({ quantityOrdered: 10, quantityDelivered: 0, linkedOrders: orders }));
    expect(c.allocations.map((a) => [a.documentId, a.quantity])).toEqual([["m1", 4]]);
    expect(coverage(3, 0, [])).toEqual({ allocations: [], uncovered: 3 });
  });

  it("a passed ready date is today, an undated TO is undated, and a row without a ship date is never late", () => {
    const c = coverage(10, 0, [linked("m1", "released", 5, 0, null), linked("m2", "released", 5, 0, "2030-02-20")]);
    expect(c.allocations.map((a) => [a.documentId, a.readyDate, a.late, a.undated])).toEqual([
      ["m2", TODAY, false, false],
      ["m1", null, false, true],
    ]);
    const open = coverage(10, 0, [linked("m1", "released", 10, 0, "2031-01-10")], null);
    expect(open.allocations.map((a) => [a.late, a.undated, a.daysLate])).toEqual([[false, false, 0]]);
  });

  it("never allocates more than the row still needs", () => {
    // The row was lowered to 4 after both TOs were created.
    const c = coverage(4, 0, [linked("m1", "released", 4, 0, "2030-03-08"), linked("m2", "released", 4, 0, "2030-03-20")]);
    expect(c.allocations.map((a) => [a.documentId, a.quantity])).toEqual([["m1", 4]]);
    expect(c.uncovered).toBe(0);
  });

  it("allocations plus uncovered is the rest, over random rows", () => {
    const rnd = lcg(7);
    const statuses = ["planned", "released", "in_progress", "done", "closed", "cancelled"];
    for (let i = 0; i < 300; i++) {
      const ordered = 1 + Math.floor(rnd() * 20);
      const delivered = Math.floor(rnd() * ordered);
      const orders = Array.from({ length: Math.floor(rnd() * 4) }, (_, n) => {
        const quantity = 1 + Math.floor(rnd() * 10);
        const status = statuses[Math.floor(rnd() * statuses.length)]!;
        const received = status === "done" || status === "closed" ? quantity : status === "cancelled" ? 0 : Math.floor(rnd() * (quantity + 1));
        return linked(`m${n}`, status, quantity, received, rnd() < 0.2 ? null : `2030-03-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`);
      });
      const c = coverage(ordered, delivered, orders);
      const allocated = c.allocations.reduce((sum, a) => sum + a.quantity, 0);
      expect(allocated + c.uncovered, `case ${i}`).toBe(ordered - delivered);
    }
  });
});

// --- pegLateness = pegOverview's allocation flags -----------------------

function overview(partial: Partial<ArticleOverviewInput>) {
  return buildArticleOverview({
    article: {
      articleId: "a",
      articleNumber: "A",
      name: "Artikel a",
      type: "manufactured",
      isPhantom: false,
      active: true,
      unitCode: "st",
      reorderPoint: null,
      orderQuantity: null,
      rounding: null,
    },
    onHand: 0,
    salesRows: [],
    purchaseRows: [],
    manufacturingOrders: [],
    materialRows: [],
    plannedMos: [],
    bomEdges: [],
    phantomIds: [],
    primarySupplier: null,
    ...partial,
  });
}

function salesRow(rowId: string, date: string | null, quantity: number) {
  return {
    rowId,
    salesOrderId: `so-${rowId}`,
    orderNumber: `KO-${rowId}`,
    orderStatus: "confirmed" as const,
    customerName: "Kund",
    expectedDeliveryDate: date,
    quantityOrdered: quantity,
    quantityDelivered: 0,
  };
}

function mo(moId: string, dueDate: string | null, quantity: number) {
  return { moId, orderNumber: `TO-${moId}`, status: "released" as const, dueDate, quantity };
}

function po(rowId: string, date: string | null, quantity: number, status: "confirmed" | "draft" = "confirmed") {
  return {
    rowId,
    purchaseOrderId: `po-${rowId}`,
    orderNumber: `IO-${rowId}`,
    orderStatus: status,
    supplierName: "Lev",
    expectedDeliveryDate: date,
    quantityOrdered: quantity,
    quantityReceived: 0,
  };
}

// Deterministic pseudo-random numbers (LCG) — the same every run.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Every allocation of a pegging, with what pegLateness says for the same
// supply and demand.
function flagsAgree(p: Pegging, offDays: ReadonlySet<string>): number {
  let n = 0;
  for (const demand of p.demands) {
    for (const a of demand.allocations) {
      const supply = p.supplies.find((s) => s.id === a.supplyId)!;
      const flags: Pick<PegAllocation, "late" | "undated" | "daysLate"> = { late: a.late, undated: a.undated, daysLate: a.daysLate };
      expect(pegLateness({ kind: supply.kind, readyDate: supply.readyDate }, demand.date, offDays), `${a.supplyId} → ${a.demandId}`).toEqual(flags);
      expect(a.readyDate).toBe(supply.readyDate);
      n++;
    }
  }
  return n;
}

describe("pegLateness — the rule pegOverview's allocations are flagged with", () => {
  it("the rule itself", () => {
    const at = (kind: PegSupplyKind, readyDate: string | null, demandDate: string | null) => pegLateness({ kind, readyDate }, demandDate, NO_HOLIDAYS);
    expect(at("manufacturing_order", "2030-03-13", "2030-03-13")).toEqual({ late: false, undated: false, daysLate: 0 });
    expect(at("manufacturing_order", "2030-03-14", "2030-03-13")).toEqual({ late: true, undated: false, daysLate: 1 });
    // Friday → Monday is one working day.
    expect(at("purchase_order", "2030-03-18", "2030-03-15")).toEqual({ late: true, undated: false, daysLate: 1 });
    expect(at("purchase_order", null, "2030-03-13")).toEqual({ late: false, undated: true, daysLate: 0 });
    expect(at("purchase_order", null, null)).toEqual({ late: false, undated: false, daysLate: 0 });
    expect(at("manufacturing_order", "2030-03-14", null)).toEqual({ late: false, undated: false, daysLate: 0 });
    expect(at("stock", TODAY, "2030-02-20")).toEqual({ late: false, undated: false, daysLate: 0 });
    // A full-day holiday is not a working day late.
    expect(pegLateness({ kind: "manufacturing_order", readyDate: "2030-03-15" }, "2030-03-13", new Set(["2030-03-14"])).daysLate).toBe(1);
  });

  it("the cases of the outlook: stock, on the day, late, undated, undated demand, passed dates", () => {
    const o = overview({
      onHand: 3,
      purchaseRows: [po("p1", "2030-02-20", 4), po("p2", null, 5, "draft")],
      manufacturingOrders: [mo("m1", "2030-03-13", 6), mo("m2", "2030-03-20", 6)],
      salesRows: [
        salesRow("r0", "2030-02-25", 2), // passed: stock, never late
        salesRow("r1", "2030-03-01", 4), // passed: stock + the IO floored at today → late
        salesRow("r2", "2030-03-13", 5), // TO m1 on the day
        salesRow("r3", "2030-03-14", 6), // m1 + m2 (late)
        salesRow("r4", "2030-03-22", 5), // m2 + the undated IO
        salesRow("r5", null, 3), // undated demand
      ],
    });
    const offDays = new Set(["2030-03-15"]);
    const p = pegOverview(o, { today: TODAY, readyDates: new Map([["mo:m2", "2030-03-19"]]), offDays });
    expect(flagsAgree(p, offDays)).toBeGreaterThanOrEqual(8);
    const flags = (demandId: string) => p.demands.find((d) => d.id === demandId)!.allocations.map((a) => [a.supplyId, a.late, a.undated, a.daysLate]);
    expect(flags("so:r0")).toEqual([["stock", false, false, 0]]);
    expect(flags("so:r1")).toEqual([
      ["stock", false, false, 0],
      ["po:p1", true, false, 1],
    ]);
    expect(flags("so:r2")).toEqual([
      ["po:p1", false, false, 0],
      ["mo:m1", false, false, 0],
    ]);
    // Thursday 14 → Tuesday 19 with Friday 15 off: Mon, Tue.
    expect(flags("so:r3")).toEqual([
      ["mo:m1", false, false, 0],
      ["mo:m2", true, false, 2],
    ]);
    expect(flags("so:r4")).toEqual([
      ["mo:m2", false, false, 0],
      ["po:p2", false, true, 0],
    ]);
    expect(flags("so:r5")).toEqual([["po:p2", false, false, 0]]);
  });

  it("agrees with every allocation over 300 random overviews", () => {
    const rnd = lcg(11);
    const date = () => (rnd() < 0.2 ? null : `2030-03-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`);
    const qty = () => Math.round(rnd() * 200) / 10 + 0.1;
    const n = () => Math.floor(rnd() * 4);
    const offDays = new Set(["2030-03-12", "2030-03-21"]);
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const o: ArticleOverview = overview({
        onHand: Math.round((rnd() - 0.3) * 300) / 10,
        salesRows: Array.from({ length: n() }, (_, k) => salesRow(`r${k}`, date(), qty())),
        purchaseRows: Array.from({ length: n() }, (_, k) => po(`p${k}`, date(), qty(), rnd() < 0.2 ? "draft" : "confirmed")),
        manufacturingOrders: Array.from({ length: n() }, (_, k) => mo(`c${k}`, date(), qty())),
      });
      // The TO supplies' planned finish, as the service hands them in.
      const readyDates = new Map(o.rows.filter((r) => r.kind === "manufacturing_order" && rnd() < 0.5).map((r) => [r.id, date()] as const));
      checked += flagsAgree(pegOverview(o, { today: TODAY, readyDates, offDays }), offDays);
    }
    expect(checked).toBeGreaterThan(300);
  });
});
