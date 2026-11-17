import { describe, expect, it } from "vitest";
import {
  checkDeliveryTime,
  deliveryTimeAnswer,
  runDeliveryTimeChecks,
  type DeliveryTimeCheckInput,
  type DtcArticle,
  type DtcOperation,
  type DtcRowInput,
  type DtcWorkCenter,
} from "../src/modules/planning/service/delivery-time-check.js";
import type { ArticleOverviewRow } from "../src/modules/planning/service/article-overview.js";
import type { CapacityOperationRow } from "../src/modules/planning/service/capacity-calc.js";
import { planProduction } from "../src/modules/planning/service/production-plan.js";

// Pure tests — no database. Monday 2026-10-19 is today unless a test says
// otherwise; capacity is placed per DAY (#18): Mon 19 – Fri 23, then Mon 26.
// 110 works Mon–Fri, 8 h a day. The next operation starts the working day
// after the previous one is ready plus the Standardkötid (queueDays, 0 unless
// a test sets it) — the chain Planera walks.
const TODAY = "2026-10-19";

function article(articleId: string, type: DtcArticle["type"] = "purchased", rounding: number | null = null): DtcArticle {
  return { articleId, articleNumber: `NR-${articleId}`, name: articleId, type, rounding };
}

function supply(
  date: string | null,
  quantity: number,
  documentNumber = "IO-1",
  extra: Partial<Pick<ArticleOverviewRow, "isDraft" | "kind" | "documentType" | "status">> = {}
): ArticleOverviewRow {
  return {
    id: `po:${documentNumber}:${date}`,
    kind: "purchase_order",
    direction: "supply",
    date,
    documentType: "purchase_order",
    documentId: documentNumber,
    documentNumber,
    status: "confirmed",
    partner: null,
    quantity,
    balance: 0,
    isDraft: false,
    ...extra,
  };
}

function salesDemand(date: string | null, quantity: number, salesOrderId = "so-other"): ArticleOverviewRow {
  return {
    id: `so:${salesOrderId}:${date}`,
    kind: "sales_order",
    direction: "demand",
    date,
    documentType: "sales_order",
    documentId: salesOrderId,
    documentNumber: `KO-${salesOrderId}`,
    status: "confirmed",
    partner: "Kund AB",
    quantity: -quantity,
    balance: 0,
    isDraft: false,
  };
}

const wc1: DtcWorkCenter = {
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

function op(sequenceNo: number, hours: number, workCenterId = "wc-1"): DtcOperation {
  return { sequenceNo, workCenterId, description: `Op ${sequenceNo}`, setupTime: hours * 60, runTimePerUnit: 0 };
}

function existing(workCenterId: string, dueDate: string | null, hours: number): CapacityOperationRow {
  return {
    moOperationId: `mo-op-${workCenterId}-${dueDate}-${hours}`,
    manufacturingOrderId: "mo-x",
    orderNumber: "TO-X",
    articleNumber: "X",
    articleName: "X",
    workCenterId,
    orderQuantity: 1,
    dueDate,
    sequenceNo: 10,
    setupTime: hours * 60,
    runTimePerUnit: 0,
    operationStatus: "pending",
    quantityCompleted: null,
    quantityScrapped: 0,
  };
}

function input(partial: Partial<DeliveryTimeCheckInput> & { rows: DtcRowInput[] }): DeliveryTimeCheckInput {
  return {
    today: TODAY,
    offDays: new Set(),
    articles: new Map(),
    overviews: new Map(),
    excludeSalesOrderId: null,
    bomEdges: [],
    phantomIds: new Set(),
    routings: new Map(),
    workCenters: new Map([["wc-1", wc1]]),
    schedule: {
      weekScheduleDays: [1, 2, 3, 4, 5].map((weekday) => ({ weekScheduleId: "ws-40", weekday, dayScheduleId: "ds-480" })),
      daySchedules: [{ id: "ds-480", netMinutes: 480 }],
      holidays: [],
    },
    existingOperations: [],
    suppliers: new Map(),
    customer: null,
    ...partial,
  };
}

const articles = (...list: DtcArticle[]) => new Map(list.map((a) => [a.articleId, a] as const));
const row = (articleId: string, quantity: number, extra: Partial<DtcRowInput> = {}): DtcRowInput => ({
  key: `r-${articleId}`,
  articleId,
  quantity,
  ...extra,
});
const supplier = (leadTimeDays: number | null) => ({
  supplierName: "Stål AB",
  leadTimeDays,
  settings: { weekdays: [], mode: "arrival" as const, transitDays: 0 },
});

describe("Leveranstidskontroll — what already exists", () => {
  it("stock covers the row: ships today", () => {
    const result = checkDeliveryTime(
      input({ articles: articles(article("p")), overviews: new Map([["p", { onHand: 10, rows: [] }]]), rows: [row("p", 5)] })
    );
    expect(result).toMatchObject({ shipDate: TODAY, deliveryDate: TODAY });
    expect(result.rows[0]!.chain).toEqual([{ kind: "stock", articleNumber: "NR-p", quantity: 5, date: TODAY }]);
  });

  it("demands already promised take the stock first; the rest is bought", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 10, rows: [salesDemand("2026-10-22", 8)] }]]),
        suppliers: new Map([["p", supplier(5)]]),
        rows: [row("p", 5)],
      })
    );
    // 2 from stock, 3 bought: Monday 19 + 5 working days = Monday 26.
    expect(result.rows[0]).toMatchObject({ readyDate: "2026-10-26" });
    expect(result.rows[0]!.chain).toEqual([
      { kind: "purchase", articleNumber: "NR-p", quantity: 3, date: "2026-10-26", supplierName: "Stål AB", leadTimeDays: 5 },
    ]);
    expect(result.shipDate).toBe("2026-10-27");
  });

  it("the checked order's own rows are not existing demand", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 10, rows: [salesDemand("2026-10-22", 8, "so-1")] }]]),
        excludeSalesOrderId: "so-1",
        rows: [row("p", 8)],
      })
    );
    expect(result.shipDate).toBe(TODAY);
  });

  it("open supply covers on its own date, in date order", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 0, rows: [supply("2026-10-28", 5, "IO-2"), supply("2026-10-22", 5, "IO-1")] }]]),
        rows: [row("p", 7)],
      })
    );
    expect(result.rows[0]!.readyDate).toBe("2026-10-28");
    expect(result.rows[0]!.chain[0]).toMatchObject({
      kind: "supply",
      documentNumber: "IO-2",
      date: "2026-10-28",
      undated: false,
      late: false,
      isDraft: false,
    });
    expect(result.shipDate).toBe("2026-10-29");
  });

  it("undated supply counts now, with a note", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 0, rows: [supply(null, 5, "IO-9")] }]]),
        rows: [row("p", 5)],
      })
    );
    expect(result.shipDate).toBe(TODAY);
    expect(result.rows[0]!.notes).toEqual(["IO-9 saknar datum — räknad som tillgänglig direkt"]);
  });

  it("two rows of the same article share the pool", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 5, rows: [] }]]),
        suppliers: new Map([["p", supplier(2)]]),
        rows: [row("p", 3, { key: "a" }), row("p", 3, { key: "b" })],
      })
    );
    expect(result.rows.map((r) => r.readyDate)).toEqual([TODAY, "2026-10-21"]);
    expect(result.rows[1]!.chain[0]).toMatchObject({ kind: "purchase", quantity: 1 });
  });

  it("negative stock is a shortage today and takes first", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: -2, rows: [supply("2026-10-22", 5)] }]]),
        suppliers: new Map([["p", supplier(10)]]),
        rows: [row("p", 3)],
      })
    );
    expect(result.rows[0]!.readyDate).toBe("2026-10-22");
  });

  it("a later demand does not take stock that an earlier supply replaces (projected balance)", () => {
    // Stock 10, IO +10 on 2 Nov, KO −10 on 1 Dec: the projected balance never
    // goes below 10, so 10 can ship today — the December order gets the IO.
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 10, rows: [supply("2026-11-02", 10, "IO-5"), salesDemand("2026-12-01", 10)] }]]),
        suppliers: new Map([["p", supplier(30)]]),
        rows: [row("p", 10)],
      })
    );
    expect(result.shipDate).toBe(TODAY);
    expect(result.rows[0]!.chain).toEqual([{ kind: "stock", articleNumber: "NR-p", quantity: 10, date: TODAY }]);
  });

  it("a demand before the supply does take the stock: the row waits for the supply", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 10, rows: [salesDemand("2026-10-22", 10), supply("2026-11-02", 10, "IO-5")] }]]),
        rows: [row("p", 10)],
      })
    );
    expect(result.rows[0]!.readyDate).toBe("2026-11-02");
    expect(result.rows[0]!.chain[0]).toMatchObject({ kind: "supply", documentNumber: "IO-5", date: "2026-11-02" });
  });

  it("what an earlier row took is demand for the next, on the date it was taken", () => {
    // Row a takes 10 at t0 (stock). Row b: the IO on 2 Nov is all that is left.
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 10, rows: [supply("2026-11-02", 10, "IO-5")] }]]),
        rows: [row("p", 10, { key: "a" }), row("p", 5, { key: "b" })],
      })
    );
    expect(result.rows.map((r) => r.readyDate)).toEqual([TODAY, "2026-11-02"]);
  });

  it("late supply counts now, keeps its own date in the step and gets a note", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 0, rows: [supply("2026-10-01", 5, "IO-7")] }]]),
        rows: [row("p", 5)],
      })
    );
    expect(result.rows[0]!.readyDate).toBe(TODAY);
    expect(result.shipDate).toBe(TODAY);
    expect(result.rows[0]!.chain).toEqual([
      {
        kind: "supply",
        articleNumber: "NR-p",
        quantity: 5,
        date: "2026-10-01",
        documentType: "purchase_order",
        documentNumber: "IO-7",
        undated: false,
        late: true,
        isDraft: false,
      },
    ]);
    expect(result.rows[0]!.notes).toEqual(["IO-7 är försenad — räknad som tillgänglig direkt"]);
  });

  it("several late orders are one note", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([
          [
            "p",
            {
              onHand: 0,
              rows: [
                supply("2026-10-01", 5, "IO-7"),
                supply("2026-10-05", 5, "TO-3", { kind: "manufacturing_order", documentType: "manufacturing_order" }),
              ],
            },
          ],
        ]),
        rows: [row("p", 10)],
      })
    );
    expect(result.rows[0]!.notes).toEqual(["IO-7 och TO-3 är försenade — räknade som tillgängliga direkt"]);
  });

  it("a draft IO counts as supply, marked in the step and noted", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 0, rows: [supply("2026-10-22", 5, "IO-9", { isDraft: true, status: "draft" })] }]]),
        rows: [row("p", 5)],
      })
    );
    expect(result.rows[0]!.readyDate).toBe("2026-10-22");
    expect(result.rows[0]!.chain[0]).toMatchObject({ kind: "supply", documentNumber: "IO-9", isDraft: true, late: false });
    expect(result.rows[0]!.notes).toEqual(["IO-9 är ett utkast — räknat som tillgång"]);
  });

  it("several draft IOs are one note", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([
          [
            "p",
            {
              onHand: 0,
              rows: [
                supply("2026-10-22", 5, "IO-9", { isDraft: true, status: "draft" }),
                supply("2026-10-22", 5, "IO-10", { isDraft: true, status: "draft" }),
              ],
            },
          ],
        ]),
        rows: [row("p", 10)],
      })
    );
    expect(result.rows[0]!.notes).toEqual(["IO-9 och IO-10 är utkast — räknade som tillgång"]);
  });

  it("supply the row does not depend on is not noted", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 10, rows: [supply(null, 5, "IO-9"), supply("2026-10-01", 5, "IO-7")] }]]),
        rows: [row("p", 5)],
      })
    );
    expect(result.rows[0]!.chain).toEqual([{ kind: "stock", articleNumber: "NR-p", quantity: 5, date: TODAY }]);
    expect(result.rows[0]!.notes).toEqual([]);
  });
});

describe("Leveranstidskontroll — bought", () => {
  it("no primary supplier: available now, with a note", () => {
    const result = checkDeliveryTime(input({ articles: articles(article("p")), rows: [row("p", 1)] }));
    expect(result.shipDate).toBe(TODAY);
    expect(result.rows[0]!.notes).toEqual(["NR-p saknar huvudleverantör — räknad som tillgänglig direkt"]);
  });

  it("the shortage is rounded up to the article's step", () => {
    const result = checkDeliveryTime(
      input({ articles: articles(article("p", "purchased", 5)), suppliers: new Map([["p", supplier(1)]]), rows: [row("p", 3)] })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ kind: "purchase", quantity: 5 });
  });

  it("the rounding surplus covers the next row on the same date", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p", "purchased", 10)),
        suppliers: new Map([["p", supplier(2)]]),
        rows: [row("p", 1, { key: "a" }), row("p", 1, { key: "b" })],
      })
    );
    expect(result.rows.map((r) => r.readyDate)).toEqual(["2026-10-21", "2026-10-21"]);
    // One purchase of 10: row a's chain. Row b is covered by the surplus and
    // points at the same purchase.
    expect(result.rows[0]!.chain).toEqual([
      { kind: "purchase", articleNumber: "NR-p", quantity: 10, date: "2026-10-21", supplierName: "Stål AB", leadTimeDays: 2 },
    ]);
    expect(result.rows[1]!.chain).toEqual(result.rows[0]!.chain);
  });

  it("the rounding surplus of a made article covers the next row instead of a second batch", () => {
    // Rounding 10 and 20 h + 1 h/st: one batch of 10 is 30 h (Mon–Thu).
    // A second batch would run into next week — the surplus makes row b
    // ready the same day as row a.
    const result = checkDeliveryTime(
      input({
        articles: articles(article("m", "manufactured", 10)),
        routings: new Map([["m", [{ ...op(10, 20), runTimePerUnit: 60 }]]]),
        rows: [row("m", 1, { key: "a" }), row("m", 1, { key: "b" })],
      })
    );
    expect(result.rows.map((r) => r.readyDate)).toEqual(["2026-10-22", "2026-10-22"]);
    expect(result.rows[1]!.chain).toEqual(result.rows[0]!.chain);
    expect(result.rows[1]!.chain[0]).toMatchObject({ kind: "operation", quantity: 10 });
  });

  it("the rounding surplus of a component covers the next level too", () => {
    // m1 and m2 each need 1 of the made part h (rounding 10, 30 h a batch):
    // m2 takes m1's surplus instead of a second batch the week after.
    const result = checkDeliveryTime(
      input({
        articles: articles(article("m1", "manufactured"), article("m2", "manufactured"), article("h", "manufactured", 10)),
        bomEdges: [
          { parentArticleId: "m1", componentArticleId: "h", quantity: 1 },
          { parentArticleId: "m2", componentArticleId: "h", quantity: 1 },
        ],
        routings: new Map([["h", [{ ...op(10, 20), runTimePerUnit: 60 }]]]),
        rows: [row("m1", 1), row("m2", 1)],
      })
    );
    expect(result.rows.map((r) => r.readyDate)).toEqual(["2026-10-22", "2026-10-22"]);
    expect(result.rows[1]!.chain[0]).toMatchObject({ kind: "operation", articleNumber: "NR-h", quantity: 10 });
  });

  it("the supplier's delivery days decide the arrival", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        suppliers: new Map([["p", { supplierName: "Stål AB", leadTimeDays: 1, settings: { weekdays: [4], mode: "arrival", transitDays: 0 } }]]),
        rows: [row("p", 1)],
      })
    );
    // Monday + 1 working day = Tuesday, next Thursday = 22.
    expect(result.rows[0]!.readyDate).toBe("2026-10-22");
  });

  it("service articles are always there", () => {
    const result = checkDeliveryTime(input({ articles: articles(article("s", "service")), rows: [row("s", 1)] }));
    expect(result.shipDate).toBe(TODAY);
  });
});

describe("Leveranstidskontroll — made, capacity per day", () => {
  const made = (ops: DtcOperation[], extra: Partial<DeliveryTimeCheckInput> = {}) =>
    input({
      articles: articles(article("m", "manufactured"), article("p")),
      overviews: new Map([["p", { onHand: 100, rows: [] }]]),
      bomEdges: [{ parentArticleId: "m", componentArticleId: "p", quantity: 2 }],
      routings: new Map([["m", ops]]),
      rows: [row("m", 10)],
      ...extra,
    });

  it("ready the day the last minute is placed, ships the working day after", () => {
    const result = checkDeliveryTime(made([{ ...op(10, 1), runTimePerUnit: 60 }]));
    expect(result.rows[0]!.readyDate).toBe("2026-10-20");
    expect(result.rows[0]!.chain).toEqual([
      {
        kind: "operation",
        articleNumber: "NR-m",
        quantity: 10,
        sequenceNo: 10,
        description: "Op 10",
        workCenterCode: "110",
        workCenterName: "Kantpress",
        fromDate: "2026-10-19",
        toDate: "2026-10-20",
        // 1 h setup + 10 × 60 min = 11 h: Monday's 8 h and 3 h on Tuesday.
        days: [{ date: "2026-10-19", minutes: 480 }, { date: "2026-10-20", minutes: 180 }],
        date: "2026-10-20",
      },
    ]);
    expect(result.shipDate).toBe("2026-10-21");
  });

  it("a full day pushes the operation to the next", () => {
    const result = checkDeliveryTime(made([op(10, 4)], { existingOperations: [existing("wc-1", "2026-10-19", 8)] }));
    expect(result.rows[0]).toMatchObject({ readyDate: "2026-10-20" });
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-20", toDate: "2026-10-20" });
  });

  it("unplanned load lies on its due date: the days before it are free", () => {
    // 40 h due Wednesday fill Wed–Tue; Monday and Tuesday are free, so 11 h is ready Tuesday.
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-21", 40)] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-19", toDate: "2026-10-20", date: "2026-10-20" });
    // 20 h would need Wednesday too: it continues after the load, on Wednesday the 28th.
    const longer = checkDeliveryTime(made([op(10, 20)], { existingOperations: [existing("wc-1", "2026-10-21", 40)] }));
    expect(longer.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-19", toDate: "2026-10-28" });
  });

  it("an operation is split over days", () => {
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-19", 5)] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-19", toDate: "2026-10-20", date: "2026-10-20" });
  });

  it("past-due load lands on today and rolls forward", () => {
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-01", 40)] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-26", toDate: "2026-10-27" });
    expect(result.rows[0]!.readyDate).toBe("2026-10-27");
  });

  it("load beyond a day's capacity rolls into the following days", () => {
    // 20 h due today on an 8 h day: Monday and Tuesday full, 4 h on
    // Wednesday — so 11 h is 4 h on Wednesday + 7 h on Thursday.
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-19", 20)] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-21", toDate: "2026-10-22", date: "2026-10-22" });
  });

  it("the backlog of several days rolls as one queue", () => {
    // Monday: 8 h (full). Tuesday: 12 h — 4 h roll into Wednesday, leaving
    // 4 h there; 9 h is 4 h on Wednesday + 5 h on Thursday.
    const result = checkDeliveryTime(
      made([op(10, 9)], { existingOperations: [existing("wc-1", "2026-10-19", 8), existing("wc-1", "2026-10-20", 12)] })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-21", toDate: "2026-10-22", date: "2026-10-22" });
  });

  it("today counts as a whole day, and a weekend is jumped", () => {
    // Wednesday: 3 days × 8 h this week, the last 6 h on Monday.
    const result = checkDeliveryTime(made([op(10, 30)], { today: "2026-10-21" }));
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-21", toDate: "2026-10-26", date: "2026-10-26" });
    // On a Friday: 4 h is ready today and ships Monday.
    const friday = checkDeliveryTime(made([op(10, 4)], { today: "2026-10-23" }));
    expect(friday).toMatchObject({ shipDate: "2026-10-26" });
    expect(friday.rows[0]!.readyDate).toBe("2026-10-23");
  });

  it("the next operation starts the working day after the previous one is ready", () => {
    const result = checkDeliveryTime(made([op(10, 4), op(20, 4)]));
    expect(result.rows[0]!.readyDate).toBe("2026-10-20");
    expect(result.rows[0]!.chain.map((s) => (s.kind === "operation" ? [s.fromDate, s.toDate, s.date] : null))).toEqual([
      ["2026-10-19", "2026-10-19", "2026-10-19"],
      ["2026-10-20", "2026-10-20", "2026-10-20"],
    ]);
    // Over a weekend, and past a holiday.
    const friday = checkDeliveryTime(made([op(10, 4), op(20, 4)], { today: "2026-10-23", offDays: new Set(["2026-10-26"]) }));
    expect(friday.rows[0]!.readyDate).toBe("2026-10-27");
  });

  it("the Standardkötid is waited between the operations, rounded up on the accumulated sum (S4)", () => {
    const three = [op(10, 4), op(20, 4), op(30, 4)];
    const days = (queueDays: number, extra: Partial<DeliveryTimeCheckInput> = {}) =>
      checkDeliveryTime(made(three, { queueDays, ...extra })).batches[0]!.operations.map((o) => o.days.map((d) => d.date));
    expect(days(0)).toEqual([["2026-10-19"], ["2026-10-20"], ["2026-10-21"]]);
    // One day: the working day after + 1, twice.
    expect(days(1)).toEqual([["2026-10-19"], ["2026-10-21"], ["2026-10-23"]]);
    // Half a day: ceil(0.5) = 1 before the second, ceil(1.0) − 1 = 0 before the third.
    expect(days(0.5)).toEqual([["2026-10-19"], ["2026-10-21"], ["2026-10-22"]]);
    // 1.5: 2 before the second, ceil(3.0) − 2 = 1 before the third.
    expect(days(1.5)).toEqual([["2026-10-19"], ["2026-10-22"], ["2026-10-26"]]);
    // The row's date, the steps and the ship date follow the last operation.
    const queued = checkDeliveryTime(made(three, { queueDays: 1 }));
    expect(queued.rows[0]!.readyDate).toBe("2026-10-23");
    expect(queued.rows[0]!.chain.map((s) => (s.kind === "operation" ? [s.fromDate, s.toDate] : null))).toEqual([
      ["2026-10-19", "2026-10-19"],
      ["2026-10-21", "2026-10-21"],
      ["2026-10-23", "2026-10-23"],
    ]);
    expect(queued).toMatchObject({ shipDate: "2026-10-26", deliveryDate: "2026-10-26" });
  });

  it("the queue counts the company's working days: over a weekend and past a holiday, and from a full day's next free day", () => {
    const two = [op(10, 4), op(20, 4)];
    // Friday: the working day after is Monday, + 1 = Tuesday; a holiday on Tuesday ⇒ Wednesday.
    expect(checkDeliveryTime(made(two, { today: "2026-10-23", queueDays: 1 })).rows[0]!.readyDate).toBe("2026-10-27");
    expect(checkDeliveryTime(made(two, { today: "2026-10-23", queueDays: 1, offDays: new Set(["2026-10-27"]) })).rows[0]!.readyDate).toBe("2026-10-28");
    // The floor is Wednesday; 110 is full that day, so the operation is on Thursday.
    const pushed = checkDeliveryTime(made(two, { queueDays: 1, existingOperations: [existing("wc-1", "2026-10-21", 8)] }));
    expect(pushed.batches[0]!.operations.map((o) => o.days)).toEqual([
      [{ date: "2026-10-19", minutes: 240 }],
      [{ date: "2026-10-22", minutes: 240 }],
    ]);
  });

  it("an operation without time takes no day and no queue; a lego operation takes its place in the chain (S6, S7)", () => {
    // Op 20 has no time: Op 30 waits ONE gap after Op 10.
    const skipped = checkDeliveryTime(made([op(10, 4), op(20, 0), op(30, 4)], { queueDays: 1 }));
    expect(skipped.batches[0]!.operations.map((o) => o.days.map((d) => d.date))).toEqual([["2026-10-19"], [], ["2026-10-21"]]);
    expect(skipped.rows[0]!.readyDate).toBe("2026-10-21");
    // Lego between: sent Wednesday (the day after + 1), back 3 working days
    // later (Monday), and Op 30 starts the working day after + 1 (Wednesday).
    const lego: DtcWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Ytbehandling", type: "subcontract", weekScheduleId: null, leadTimeDays: 3 };
    const between = checkDeliveryTime(
      made([op(10, 4), op(20, 0, "wc-l"), op(30, 4)], { queueDays: 1, workCenters: new Map([["wc-1", wc1], ["wc-l", lego]]) })
    );
    expect(between.rows[0]!.chain.map((s) => s.date)).toEqual(["2026-10-19", "2026-10-26", "2026-10-28"]);
  });

  it.each([0, 0.5, 1, 1.5])("the check's days are the days Planera gives the same order (queue %s)", (queueDays) => {
    // 110 has load on Tuesday and Thursday; Op 30 has no time. The same
    // book, the same chain: the batch's allocation is the engine's plan.
    const lego: DtcWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Ytbehandling", type: "subcontract", weekScheduleId: null, leadTimeDays: 2, queueTimeDays: 0.5 };
    const workCenters = new Map([["wc-1", wc1], ["wc-l", lego]]);
    const load = [existing("wc-1", "2026-10-20", 6), existing("wc-1", "2026-10-22", 8)];
    const route = [op(10, 4), op(20, 12), op(30, 0), op(40, 0, "wc-l"), op(50, 6)];
    const check = checkDeliveryTime(made(route, { queueDays, workCenters, existingOperations: load, rows: [row("m", 1)] }));
    const base = input({ rows: [] });
    const plan = planProduction({
      today: TODAY,
      offDays: base.offDays,
      workCenters,
      schedule: base.schedule,
      queueDays,
      existingOperations: load,
      orders: [
        {
          id: "mo-new",
          orderNumber: "TO-NY",
          dueDate: null,
          operations: route.map((o) => ({
            ...existing(o.workCenterId, null, o.setupTime / 60),
            moOperationId: `new-${o.sequenceNo}`,
            manufacturingOrderId: "mo-new",
            orderNumber: "TO-NY",
            sequenceNo: o.sequenceNo,
            started: false,
          })),
        },
      ],
    });
    const planned = new Map(plan.plans.map((p) => [p.operationId, p.days]));
    expect(check.batches[0]!.operations.map((o) => o.days)).toEqual(route.map((o) => planned.get(`new-${o.sequenceNo}`) ?? []));
    expect(check.batches[0]!.readyDate).toBe(plan.orders[0]!.plannedFinish);
    expect(check.rows[0]!.readyDate).toBe(plan.orders[0]!.plannedFinish);
  });

  it("material arriving mid-week: capacity from that day", () => {
    const result = checkDeliveryTime(
      made([op(10, 30)], {
        overviews: new Map([["p", { onHand: 0, rows: [] }]]),
        suppliers: new Map([["p", supplier(7)]]),
      })
    );
    // Material Wednesday 28: the first operation may start that day —
    // 24 h that week, 6 h on Monday.
    expect(result.rows[0]!.chain.map((s) => s.kind)).toEqual(["purchase", "operation"]);
    expect(result.rows[0]!.chain[1]).toMatchObject({ fromDate: "2026-10-28", toDate: "2026-11-02", date: "2026-11-02" });
  });

  it("repeating notes are merged into one per kind", () => {
    const wc2: DtcWorkCenter = { ...wc1, workCenterId: "wc-2", code: "200", weekScheduleId: null };
    const wc3: DtcWorkCenter = { ...wc1, workCenterId: "wc-3", code: "100", weekScheduleId: null };
    const result = checkDeliveryTime(
      made([op(10, 1, "wc-2"), op(20, 1, "wc-3")], {
        workCenters: new Map([["wc-1", wc1], ["wc-2", wc2], ["wc-3", wc3]]),
        overviews: new Map([["p", { onHand: 0, rows: [supply(null, 10, "IO-7"), supply(null, 10, "IO-12")] }]]),
      })
    );
    expect(result.rows[0]!.notes).toEqual([
      "Resurserna 100 och 200 saknar veckoschema och timmar per dag — kapaciteten räknas inte",
      "IO-7 och IO-12 saknar datum — räknade som tillgängliga direkt",
    ]);
  });

  it("undated existing load is left out, with a note", () => {
    const result = checkDeliveryTime(made([op(10, 2)], { existingOperations: [existing("wc-1", null, 40)] }));
    expect(result.rows[0]!.readyDate).toBe("2026-10-19");
    expect(result.notes).toEqual(["Resurs 110 har 40 h beläggning utan datum som inte räknas"]);
  });

  it("hours per day give capacity without a week schedule", () => {
    // 4 h a day: 30 h is this week's five days, two of the next and 2 h on Wednesday the 28th.
    const result = checkDeliveryTime(
      made([op(10, 30)], { workCenters: new Map([["wc-1", { ...wc1, weekScheduleId: null, hoursPerDay: 4 }]]) })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-19", toDate: "2026-10-28", date: "2026-10-28" });
    expect(result.rows[0]!.notes).toEqual([]);
  });

  it("a resource without a week schedule is not capacity-planned", () => {
    const result = checkDeliveryTime(
      made([op(10, 100)], { workCenters: new Map([["wc-1", { ...wc1, weekScheduleId: null }]]) })
    );
    // Unlimited: everything on the floor's working day.
    expect(result.rows[0]!.readyDate).toBe("2026-10-19");
    expect(result.rows[0]!.notes).toEqual(["Resurs 110 saknar veckoschema och timmar per dag — kapaciteten räknas inte"]);
  });

  it("a lego operation takes the resource's lead time in working days", () => {
    const lego: DtcWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Ytbehandling", type: "subcontract", weekScheduleId: null, leadTimeDays: 3 };
    const result = checkDeliveryTime(
      made([op(10, 0, "wc-l")], { workCenters: new Map([["wc-1", wc1], ["wc-l", lego]]) })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ kind: "subcontract", leadTimeDays: 3, date: "2026-10-22" });
    expect(result.shipDate).toBe("2026-10-23");
    // Ledtid + Kötid, rounded up (3 + 1.5 ⇒ 5 working days) — as the lead time counts it.
    const queued = checkDeliveryTime(
      made([op(10, 0, "wc-l")], { workCenters: new Map([["wc-1", wc1], ["wc-l", { ...lego, queueTimeDays: 1.5 }]]) })
    );
    expect(queued.rows[0]!.readyDate).toBe("2026-10-26");
    // After an own operation it is sent the working day after, and the next
    // operation starts the working day after it is back.
    const between = checkDeliveryTime(
      made([op(10, 4), op(20, 0, "wc-l"), op(30, 4)], { workCenters: new Map([["wc-1", wc1], ["wc-l", lego]]) })
    );
    expect(between.rows[0]!.chain.map((s) => s.date)).toEqual(["2026-10-19", "2026-10-23", "2026-10-26"]);
    // Lego first on a Saturday: sent Monday 26, back Thursday 29, the next
    // operation Friday 30 — the very days Planera and orderPlanStatus give
    // (production-plan.test.ts, "lego first on a day off").
    for (const today of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
      const weekend = checkDeliveryTime(made([op(10, 0, "wc-l"), op(20, 4)], { today, workCenters: new Map([["wc-1", wc1], ["wc-l", lego]]) }));
      expect(weekend.rows[0]!.chain.map((s) => s.date), today).toEqual(["2026-10-29", "2026-10-30"]);
    }
  });

  it("a lego resource without lead time counts as 0 days, with a note", () => {
    const lego: DtcWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", type: "subcontract", weekScheduleId: null, leadTimeDays: null };
    const result = checkDeliveryTime(made([op(10, 0, "wc-l")], { workCenters: new Map([["wc-l", lego]]) }));
    expect(result.rows[0]!.notes).toEqual(["Legoresurs 900 saknar ledtid — räknad som 0 dagar"]);
  });

  it("no free capacity within the horizon: no date", () => {
    const result = checkDeliveryTime(
      made([op(10, 1)], { schedule: { weekScheduleDays: [], daySchedules: [], holidays: [] } })
    );
    expect(result.rows[0]).toMatchObject({ readyDate: null, notes: ["Kapaciteten räcker inte inom två år"] });
    expect(result).toMatchObject({ shipDate: null, deliveryDate: null });
  });

  it("a row that reaches the horizon still shows the steps that were planned", () => {
    // Material bought, Op 10 fits on 110, Op 20 is on a resource with 0 h a day.
    const wc0: DtcWorkCenter = { ...wc1, workCenterId: "wc-0", code: "120", name: "Svets", weekScheduleId: null, hoursPerDay: 0 };
    const result = checkDeliveryTime(
      made([op(10, 4), op(20, 1, "wc-0")], {
        workCenters: new Map([["wc-1", wc1], ["wc-0", wc0]]),
        overviews: new Map([["p", { onHand: 0, rows: [] }]]),
        suppliers: new Map([["p", supplier(1)]]),
      })
    );
    expect(result.rows[0]).toMatchObject({ readyDate: null, notes: ["Kapaciteten räcker inte inom två år"] });
    expect(result.rows[0]!.chain.map((s) => s.kind)).toEqual(["purchase", "operation", "operation"]);
    expect(result.rows[0]!.chain[1]).toMatchObject({ sequenceNo: 10, workCenterCode: "110", fromDate: "2026-10-20" });
    expect(result.rows[0]!.chain[2]).toMatchObject({ sequenceNo: 20, workCenterCode: "120" });
  });

  it("a made article without structure and routing counts as available now, with a note — and no batch", () => {
    const result = checkDeliveryTime(input({ articles: articles(article("m", "manufactured")), rows: [row("m", 2)] }));
    expect(result.shipDate).toBe(TODAY);
    expect(result.rows[0]!.notes).toEqual(["NR-m saknar beredning — räknad som tillgänglig direkt"]);
    expect(result.rows[0]!.chain).toEqual([]);
    // Nothing to make a TO of: a reservation would otherwise create an
    // empty order for it.
    expect(result.batches).toEqual([]);
  });

  it("several components without preparation are one note", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("m", "manufactured"), article("h1", "manufactured"), article("h2", "manufactured")),
        bomEdges: [
          { parentArticleId: "m", componentArticleId: "h1", quantity: 1 },
          { parentArticleId: "m", componentArticleId: "h2", quantity: 1 },
        ],
        routings: new Map([["m", [op(10, 1)]]]),
        rows: [row("m", 1)],
      })
    );
    expect(result.rows[0]!.notes).toEqual(["NR-h1 och NR-h2 saknar beredning — räknade som tillgängliga direkt"]);
  });
});

describe("Leveranstidskontroll — all levels", () => {
  it("a missing semi-finished part is made first; a phantom is passed through", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(
          article("m", "manufactured"),
          article("h", "manufactured"),
          article("f", "manufactured"),
          article("p"),
          article("q")
        ),
        overviews: new Map([
          ["p", { onHand: 100, rows: [] }],
          ["q", { onHand: 0, rows: [] }],
        ]),
        phantomIds: new Set(["f"]),
        bomEdges: [
          { parentArticleId: "m", componentArticleId: "h", quantity: 1 },
          { parentArticleId: "m", componentArticleId: "f", quantity: 1 },
          { parentArticleId: "h", componentArticleId: "p", quantity: 1 },
          { parentArticleId: "f", componentArticleId: "q", quantity: 2 },
        ],
        routings: new Map([
          ["h", [op(10, 20)]],
          ["m", [op(10, 4)]],
        ]),
        suppliers: new Map([["q", supplier(1)]]),
        rows: [row("m", 1)],
      })
    );
    // h: 20 h, ready Wednesday 21 (4 h there); q via the phantom: Tuesday 20.
    // m: its material is ready Wednesday, where 4 h are left — its 4 h fit.
    expect(result.rows[0]!.readyDate).toBe("2026-10-21");
    expect(result.rows[0]!.chain.map((s) => [s.kind, s.articleNumber])).toEqual([
      ["operation", "NR-h"],
      ["operation", "NR-m"],
    ]);
  });
});

describe("Leveranstidskontroll — configured rows, customer and errors", () => {
  it("a configured row is made from its derived structure", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("t", "manufactured"), article("p")),
        overviews: new Map([
          ["t", { onHand: 50, rows: [] }], // the template's stock is another configuration's
          ["p", { onHand: 10, rows: [] }],
        ]),
        rows: [row("t", 2, { structure: { quantity: 2, operations: [op(10, 8)], materials: [{ articleId: "p", quantity: 6 }] } })],
      })
    );
    expect(result.rows[0]!.chain.map((s) => s.kind)).toEqual(["operation"]);
    expect(result.rows[0]!.readyDate).toBe("2026-10-19");
  });

  // The row's linked TOs (an earlier reservation, Skapa TO): the service
  // nets them with uncoveredConfiguredQuantity and derives the batch for the
  // rest; the check shows the TO in the chain and makes only the rest.
  const linked = (quantity: number, dueDate: string | null, done = false) => ({
    manufacturingOrderId: "mo-1",
    orderNumber: "TO-1",
    quantity,
    dueDate,
    done,
  });
  const plannedExisting = {
    ...existing("wc-1", "2026-11-30", 1),
    manufacturingOrderId: "mo-1",
    orderNumber: "TO-1",
    plannedDays: [{ date: "2026-10-26", minutes: 60 }],
  };

  it("a configured row's linked TO covers its part on the TO's planned finish day; only the rest is a batch", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("t", "manufactured")),
        existingOperations: [plannedExisting],
        rows: [
          row("t", 2, {
            key: "cfg",
            structure: { quantity: 1, operations: [op(10, 8)], materials: [], covered: { quantity: 1, orders: [linked(1, "2026-11-30")] } },
          }),
        ],
      })
    );
    // The batch (8 h today) is ready today; the TO's last planned day is
    // Monday the 26th — the later one is the row's date.
    expect(result.batches.map((b) => [b.rowKey, b.quantity])).toEqual([["cfg", 1]]);
    expect(result.rows[0]).toMatchObject({ quantity: 2, readyDate: "2026-10-26", notes: [] });
    expect(result.rows[0]!.chain).toEqual([
      expect.objectContaining({ kind: "supply", documentType: "manufacturing_order", documentNumber: "TO-1", quantity: 1, date: "2026-10-26", undated: false, late: false }),
    ]);
    expect(result.shipDate).toBe("2026-10-27");
  });

  it("a linked TO's planned days that have passed count as now — never late", () => {
    const passed = { ...plannedExisting, plannedDays: [{ date: "2026-10-14", minutes: 30 }, { date: "2026-10-15", minutes: 30 }] };
    const result = checkDeliveryTime(
      input({
        articles: articles(article("t", "manufactured")),
        existingOperations: [passed],
        rows: [row("t", 1, { structure: { quantity: 0, operations: [], materials: [], covered: { quantity: 1, orders: [linked(1, "2026-11-30")] } } })],
      })
    );
    expect(result.rows[0]).toMatchObject({ readyDate: TODAY, notes: [] });
    expect(result.rows[0]!.chain).toEqual([expect.objectContaining({ kind: "supply", documentNumber: "TO-1", date: TODAY, late: false })]);
  });

  it("a linked TO with a lego operation after its planned ones is ready when the lego is back — the chain's floor with the queue", () => {
    const lego: DtcWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Ytbehandling", type: "subcontract", weekScheduleId: null, leadTimeDays: 3 };
    const legoOp = { ...existing("wc-l", "2026-11-30", 0), manufacturingOrderId: "mo-1", orderNumber: "TO-1", sequenceNo: 20 };
    const check = (queueDays: number) =>
      checkDeliveryTime(
        input({
          articles: articles(article("t", "manufactured")),
          workCenters: new Map([["wc-1", wc1], ["wc-l", lego]]),
          existingOperations: [plannedExisting, legoOp],
          queueDays,
          rows: [row("t", 1, { structure: { quantity: 0, operations: [], materials: [], covered: { quantity: 1, orders: [linked(1, "2026-11-30")] } } })],
        })
      ).rows[0]!.readyDate;
    // Planned Monday the 26th; sent Tuesday, back three working days later.
    expect(check(0)).toBe("2026-10-30");
    // With a day's queue it is sent Wednesday: back Monday the 2nd.
    expect(check(1)).toBe("2026-11-02");
  });

  it("a configured row fully covered by its linked TO gives no batch; a done TO is ready now", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("t", "manufactured")),
        rows: [row("t", 2, { key: "cfg", structure: { quantity: 0, operations: [], materials: [], covered: { quantity: 2, orders: [linked(2, null, true)] } } })],
      })
    );
    expect(result.batches).toEqual([]);
    expect(result.rows[0]).toMatchObject({ readyDate: TODAY, notes: [] });
    expect(result.rows[0]!.chain).toEqual([expect.objectContaining({ kind: "supply", documentNumber: "TO-1", quantity: 2, date: TODAY })]);
    expect(result.shipDate).toBe(TODAY);
  });

  it("a linked TO without plan takes its due date; without a date it counts now, with a note", () => {
    const dated = checkDeliveryTime(
      input({
        articles: articles(article("t", "manufactured")),
        rows: [row("t", 1, { structure: { quantity: 0, operations: [], materials: [], covered: { quantity: 1, orders: [linked(1, "2026-11-04")] } } })],
      })
    );
    expect(dated.rows[0]).toMatchObject({ readyDate: "2026-11-04", notes: [] });
    const undated = checkDeliveryTime(
      input({
        articles: articles(article("t", "manufactured")),
        rows: [row("t", 1, { structure: { quantity: 0, operations: [], materials: [], covered: { quantity: 1, orders: [linked(1, null)] } } })],
      })
    );
    expect(undated.rows[0]).toMatchObject({ readyDate: TODAY, notes: ["TO-1 saknar datum — räknad som tillgänglig direkt"] });
    expect(undated.batches).toEqual([]);
  });

  it("a row with an error gets no date and blocks the order's date", () => {
    const result = checkDeliveryTime(
      input({ articles: articles(article("t", "manufactured")), rows: [row("t", 1, { error: "Välj Lås" })] })
    );
    expect(result.rows[0]).toMatchObject({ readyDate: null, notes: ["Välj Lås"] });
    expect(result.shipDate).toBeNull();
  });

  it("the customer's delivery days follow the ship date", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("p")),
        overviews: new Map([["p", { onHand: 0, rows: [supply("2026-10-23", 5)] }]]),
        customer: { weekdays: [1, 4], mode: "dispatch", transitDays: 2 },
        rows: [row("p", 5)],
      })
    );
    // Ready Friday 23, ships Monday 26 (a dispatch day), + 2 = Wednesday 28.
    expect(result).toMatchObject({ shipDate: "2026-10-26", deliveryDate: "2026-10-28" });
  });
});

// --- Produktionsplanering: the check on the shared capacity book ------------
// Rows without plans count on their due date; these add planned existing
// load, the allocation on the steps (days) and the batches a reservation
// creates TOs from.

describe("Leveranstidskontroll — planned load, days and batches", () => {
  const made = (ops: DtcOperation[], extra: Partial<DeliveryTimeCheckInput> = {}) =>
    input({
      articles: articles(article("m", "manufactured"), article("p")),
      overviews: new Map([["p", { onHand: 100, rows: [] }]]),
      bomEdges: [{ parentArticleId: "m", componentArticleId: "p", quantity: 2 }],
      routings: new Map([["m", ops]]),
      rows: [row("m", 10)],
      ...extra,
    });

  it("existing load that is planned counts on its planned days, not its due date", () => {
    const planned = { ...existing("wc-1", "2026-10-19", 8), plannedDays: [{ date: "2026-10-20", minutes: 480 }] };
    const result = checkDeliveryTime(made([op(10, 4)], { existingOperations: [planned] }));
    // Today is free: the 8 h sit on Tuesday. Unplanned, the same load would
    // fill today and push the operation to Tuesday (test above).
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromDate: "2026-10-19", toDate: "2026-10-19", date: "2026-10-19" });
  });

  it("planned existing load is its remaining time filled from the back", () => {
    // 20 h planned Mon 8 / Tue 8 / Wed 4 with 10 h reported ⇒ Tue 6, Wed 4 left.
    const planned: CapacityOperationRow = {
      ...existing("wc-1", "2026-10-30", 0),
      setupTime: 0,
      runTimePerUnit: 60,
      orderQuantity: 20,
      quantityCompleted: 10,
      plannedDays: [{ date: "2026-10-19", minutes: 480 }, { date: "2026-10-20", minutes: 480 }, { date: "2026-10-21", minutes: 240 }],
    };
    const result = checkDeliveryTime(made([op(10, 12)], { existingOperations: [planned] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({
      days: [{ date: "2026-10-19", minutes: 480 }, { date: "2026-10-20", minutes: 120 }, { date: "2026-10-21", minutes: 120 }],
      date: "2026-10-21",
    });
  });

  it("an operation step carries its allocation, split over days", () => {
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-19", 5)] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({
      fromDate: "2026-10-19",
      toDate: "2026-10-20",
      days: [{ date: "2026-10-19", minutes: 180 }, { date: "2026-10-20", minutes: 480 }],
    });
  });

  it("a row that reaches the horizon shows what was booked on the step and gets no batch", () => {
    const result = checkDeliveryTime(
      made([op(10, 1)], { schedule: { weekScheduleDays: [], daySchedules: [], holidays: [] } })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ kind: "operation", days: [] });
    expect(result.batches).toEqual([]);
  });

  it("batches: one per made shortage on every level, children before parents, with the operations' allocations", () => {
    // m needs h (made, short) and p (bought, in stock); h needs p.
    const result = checkDeliveryTime(
      input({
        articles: articles(article("m", "manufactured"), article("h", "manufactured", 10), article("p")),
        overviews: new Map([
          ["h", { onHand: 2, rows: [] }],
          ["p", { onHand: 100, rows: [] }],
        ]),
        bomEdges: [
          { parentArticleId: "m", componentArticleId: "h", quantity: 1 },
          { parentArticleId: "m", componentArticleId: "p", quantity: 1 },
          { parentArticleId: "h", componentArticleId: "p", quantity: 1 },
        ],
        routings: new Map([
          ["h", [op(10, 8)]],
          ["m", [op(10, 4), op(20, 2)]],
        ]),
        rows: [row("m", 5, { key: "row-1" })],
      })
    );
    // h: 3 short, rounded up to 10, Op 10 today (8 h, ready today).
    // m: 5, its material is ready today but the day is full: Op 10 on
    // Tuesday, Op 20 the working day after.
    expect(result.rows[0]!.readyDate).toBe("2026-10-21");
    expect(result.batches).toEqual([
      {
        key: "row-1:2:h:0",
        rowKey: "row-1",
        level: 2,
        articleId: "h",
        articleNumber: "NR-h",
        quantity: 10,
        readyDate: "2026-10-19",
        operations: [{ sequenceNo: 10, workCenterId: "wc-1", days: [{ date: "2026-10-19", minutes: 480 }] }],
      },
      {
        key: "row-1:1:m:1",
        rowKey: "row-1",
        level: 1,
        articleId: "m",
        articleNumber: "NR-m",
        quantity: 5,
        readyDate: "2026-10-21",
        operations: [
          { sequenceNo: 10, workCenterId: "wc-1", days: [{ date: "2026-10-20", minutes: 240 }] },
          { sequenceNo: 20, workCenterId: "wc-1", days: [{ date: "2026-10-21", minutes: 120 }] },
        ],
      },
    ]);
  });

  it("batches: lego and 0-minute operations are listed without an allocation; bought and covered rows give none", () => {
    const legoWc: DtcWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", type: "subcontract", weekScheduleId: null, leadTimeDays: 2 };
    const result = checkDeliveryTime(
      input({
        articles: articles(article("m", "manufactured"), article("s", "manufactured"), article("p")),
        overviews: new Map([
          ["s", { onHand: 10, rows: [] }],
          ["p", { onHand: 0, rows: [] }],
        ]),
        routings: new Map([["m", [op(10, 2), op(20, 0, "wc-l"), { ...op(30, 0), setupTime: 0 }]]]),
        workCenters: new Map([["wc-1", wc1], ["wc-l", legoWc]]),
        suppliers: new Map([["p", supplier(3)]]),
        rows: [row("m", 1, { key: "a" }), row("s", 1, { key: "b" }), row("p", 1, { key: "c" })],
      })
    );
    // Op 10 today, sent Tuesday, back Thursday (2 working days); Op 30 has no time.
    expect(result.batches.map((b) => [b.rowKey, b.articleNumber, b.readyDate])).toEqual([["a", "NR-m", "2026-10-22"]]);
    expect(result.batches[0]!.operations).toEqual([
      { sequenceNo: 10, workCenterId: "wc-1", days: [{ date: "2026-10-19", minutes: 120 }] },
      { sequenceNo: 20, workCenterId: "wc-l", days: [] },
      { sequenceNo: 30, workCenterId: "wc-1", days: [] },
    ]);
  });

  it("batches: a configured row is one batch of its derived structure on level 1", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("t", "manufactured"), article("p")),
        overviews: new Map([["p", { onHand: 10, rows: [] }]]),
        rows: [row("t", 2, { key: "cfg", structure: { quantity: 2, operations: [op(10, 8)], materials: [{ articleId: "p", quantity: 6 }] } })],
      })
    );
    expect(result.batches).toEqual([
      expect.objectContaining({
        rowKey: "cfg",
        level: 1,
        articleId: "t",
        quantity: 2,
        readyDate: "2026-10-19",
        operations: [{ sequenceNo: 10, workCenterId: "wc-1", days: [{ date: "2026-10-19", minutes: 480 }] }],
      }),
    ]);
  });

  it("batches: a rounding surplus that covers the next row gives one batch, not two", () => {
    const result = checkDeliveryTime(
      input({
        articles: articles(article("m", "manufactured", 10)),
        routings: new Map([["m", [{ ...op(10, 20), runTimePerUnit: 60 }]]]),
        rows: [row("m", 1, { key: "a" }), row("m", 1, { key: "b" })],
      })
    );
    expect(result.batches.map((b) => [b.rowKey, b.quantity])).toEqual([["a", 10]]);
  });
});

// --- Alternativa resurser (#15, etapp 3): the two runs and the answer ------
describe("Leveranstidskontroll — alternativa resurser", () => {
  const wc2: DtcWorkCenter = { ...wc1, workCenterId: "wc-2", code: "120", name: "Kantpress 2" };
  const inactive: DtcWorkCenter = { ...wc1, workCenterId: "wc-i", code: "160", name: "Inaktiv", active: false };
  const noCapacity: DtcWorkCenter = { ...wc1, workCenterId: "wc-n", code: "150", name: "Utan kapacitet", weekScheduleId: null };
  const workCenters = new Map([wc1, wc2, inactive, noCapacity].map((w) => [w.workCenterId, w] as const));
  // An operation of `hours` on 110 with 120 (and others) as alternatives "som ordinarie".
  const withAlternatives = (hours: number, ...alternatives: string[]): DtcOperation => ({
    ...op(10, hours),
    alternatives: (alternatives.length > 0 ? alternatives : ["wc-2"]).map((workCenterId) => ({ workCenterId, setupTime: hours * 60, runTimePerUnit: 0 })),
  });
  const made = (ops: DtcOperation[], extra: Partial<DeliveryTimeCheckInput> = {}) =>
    input({ articles: articles(article("m", "manufactured")), routings: new Map([["m", ops]]), workCenters, rows: [row("m", 1)], ...extra });
  // 110 is full Monday–Friday this week: free from Monday the 26th.
  const FULL_110 = [existing("wc-1", "2026-10-19", 40)];

  it("a full ordinarie: the run with alternatives gives an earlier date, and the answer carries both dates and the alternative", () => {
    const runs = runDeliveryTimeChecks(made([withAlternatives(8)], { existingOperations: FULL_110 }));
    // Only the ordinarie: 110 is full this week — ready Monday the 26th.
    expect(runs.ordinary).toMatchObject({ shipDate: "2026-10-27", deliveryDate: "2026-10-27" });
    expect(runs.ordinary.batches[0]!.operations).toEqual([{ sequenceNo: 10, workCenterId: "wc-1", days: [{ date: "2026-10-26", minutes: 480 }] }]);
    const answer = deliveryTimeAnswer(runs);
    expect(answer).toMatchObject({
      usesAlternatives: true,
      shipDate: "2026-10-20",
      deliveryDate: "2026-10-20",
      ordinaryShipDate: "2026-10-27",
      ordinaryDeliveryDate: "2026-10-27",
    });
    expect(answer.rows[0]).toMatchObject({ readyDate: "2026-10-19", ordinaryReadyDate: "2026-10-26" });
    expect(answer.rows[0]!.chain).toEqual([
      {
        kind: "operation",
        articleNumber: "NR-m",
        quantity: 1,
        sequenceNo: 10,
        description: "Op 10",
        workCenterCode: "120",
        workCenterName: "Kantpress 2",
        fromDate: "2026-10-19",
        toDate: "2026-10-19",
        days: [{ date: "2026-10-19", minutes: 480 }],
        date: "2026-10-19",
        // 110 would have finished Monday the 26th.
        alternativeOf: { workCenterId: "wc-1", workCenterCode: "110", workCenterName: "Kantpress", toDate: "2026-10-26" },
      },
    ]);
    // The batch is on the resource the run chose — what the reservation
    // writes — and every operation names its resource and the ordinarie.
    expect(answer.batches[0]!.operations).toEqual([
      {
        sequenceNo: 10,
        workCenterId: "wc-2",
        workCenterCode: "120",
        workCenterName: "Kantpress 2",
        days: [{ date: "2026-10-19", minutes: 480 }],
        alternativeOf: { workCenterId: "wc-1", workCenterCode: "110", workCenterName: "Kantpress", toDate: "2026-10-26" },
      },
    ]);

    // Med ordinarie resurser: the ordinarie run, no alternative anywhere.
    const ordinary = deliveryTimeAnswer(runs, false);
    expect(ordinary).toMatchObject({ usesAlternatives: false, deliveryDate: "2026-10-27", ordinaryShipDate: null, ordinaryDeliveryDate: null });
    expect(ordinary.rows[0]!.chain[0]).toMatchObject({ workCenterCode: "110", alternativeOf: null });
    expect(ordinary.batches[0]!.operations[0]).toMatchObject({ workCenterId: "wc-1", workCenterCode: "110", alternativeOf: null });
  });

  it("equal days keep the ordinarie: a base that is not full, or an alternative that is no earlier", () => {
    // 110 is free: not full, even though 120 would be faster.
    const free = deliveryTimeAnswer(runDeliveryTimeChecks(made([{ ...withAlternatives(8), alternatives: [{ workCenterId: "wc-2", setupTime: 60, runTimePerUnit: 0 }] }])));
    expect(free).toMatchObject({ usesAlternatives: false, deliveryDate: "2026-10-20", ordinaryDeliveryDate: null, ordinaryShipDate: null });
    expect(free.rows[0]!.chain[0]).toMatchObject({ workCenterCode: "110", alternativeOf: null });
    expect(free.rows[0]!.ordinaryReadyDate).toBe(free.rows[0]!.readyDate);
    // 110 and 120 both full this week: Monday the 26th either way — the ordinarie stays.
    const tie = runDeliveryTimeChecks(made([withAlternatives(8)], { existingOperations: [...FULL_110, existing("wc-2", "2026-10-19", 40)] }));
    expect(tie.withAlternatives!.batches[0]!.operations[0]!.workCenterId).toBe("wc-1");
    expect(deliveryTimeAnswer(tie)).toMatchObject({ usesAlternatives: false, deliveryDate: "2026-10-27" });
  });

  it("days, not weeks: an alternative a day earlier in the same week counts when it moves the delivery date (S9)", () => {
    // 110 is full today only: Tuesday on 110, today on 120.
    const runs = runDeliveryTimeChecks(made([withAlternatives(8)], { existingOperations: [existing("wc-1", "2026-10-19", 8)] }));
    expect(deliveryTimeAnswer(runs)).toMatchObject({
      usesAlternatives: true,
      deliveryDate: "2026-10-20",
      ordinaryDeliveryDate: "2026-10-21",
    });
    expect(deliveryTimeAnswer(runs).rows[0]!.chain[0]).toMatchObject({ workCenterCode: "120", alternativeOf: { workCenterCode: "110", toDate: "2026-10-20" } });
  });

  it("an alternative that wins one day is not taken when the delivery date stays: the customer's delivery day decides", () => {
    // 110 is full today only: Tuesday on 110, today on 120 — shipped
    // Wednesday or Tuesday, but the customer only takes deliveries on
    // Thursdays, so both are delivered the 22nd.
    const runs = runDeliveryTimeChecks(
      made([withAlternatives(8)], {
        existingOperations: [existing("wc-1", "2026-10-19", 8)],
        customer: { weekdays: [4], mode: "arrival", transitDays: 0 },
      })
    );
    expect(runs.withAlternatives).toMatchObject({ shipDate: "2026-10-20", deliveryDate: "2026-10-22" });
    expect(runs.ordinary).toMatchObject({ shipDate: "2026-10-21", deliveryDate: "2026-10-22" });
    const answer = deliveryTimeAnswer(runs);
    expect(answer).toMatchObject({ usesAlternatives: false, shipDate: "2026-10-21", deliveryDate: "2026-10-22", ordinaryDeliveryDate: null });
    expect(answer.batches[0]!.operations).toEqual([
      { sequenceNo: 10, workCenterId: "wc-1", workCenterCode: "110", workCenterName: "Kantpress", alternativeOf: null, days: [{ date: "2026-10-20", minutes: 480 }] },
    ]);
  });

  it("with a queue time: the day an alternative wins on the first operation is a day won down the chain", () => {
    // Two operations, a day's queue; 110 is full today. On 110: Tuesday and
    // Thursday. Op 10 on 120 today ⇒ Op 20 on 110 Wednesday — a day earlier.
    const runs = runDeliveryTimeChecks(
      made([withAlternatives(8), op(20, 8)], { queueDays: 1, existingOperations: [existing("wc-1", "2026-10-19", 8)] })
    );
    const answer = deliveryTimeAnswer(runs);
    expect(answer).toMatchObject({ usesAlternatives: true, shipDate: "2026-10-22", ordinaryShipDate: "2026-10-23" });
    expect(answer.batches[0]!.operations.map((o) => [o.workCenterCode, o.alternativeOf?.toDate ?? null, o.days])).toEqual([
      ["120", "2026-10-20", [{ date: "2026-10-19", minutes: 480 }]],
      ["110", null, [{ date: "2026-10-21", minutes: 480 }]],
    ]);
    expect(runs.ordinary.batches[0]!.operations.map((o) => o.days.map((d) => d.date))).toEqual([["2026-10-20"], ["2026-10-22"]]);
  });

  it("the beskärningspass on days: a one-day win the date does not need goes back to the ordinarie", () => {
    // Row A: 110 is full today, 120 free — a day earlier on 120 (today
    // instead of Tuesday). Row C: 130 is full Monday–Wednesday, 140 only
    // today — Tuesday on 140, Thursday on 130. C decides the date and needs
    // 140; with it the date is Tuesday's, which A makes on 110 too.
    const wc3: DtcWorkCenter = { ...wc1, workCenterId: "wc-3", code: "130", name: "Svets" };
    const wc4: DtcWorkCenter = { ...wc1, workCenterId: "wc-4", code: "140", name: "Svets 2" };
    const opC: DtcOperation = { ...op(10, 8, "wc-3"), alternatives: [{ workCenterId: "wc-4", setupTime: 480, runTimePerUnit: 0 }] };
    const runs = runDeliveryTimeChecks(
      input({
        articles: articles(article("a", "manufactured"), article("c", "manufactured")),
        routings: new Map([
          ["a", [withAlternatives(8)]],
          ["c", [opC]],
        ]),
        workCenters: new Map([...workCenters, ["wc-3", wc3], ["wc-4", wc4]]),
        existingOperations: [existing("wc-1", "2026-10-19", 8), existing("wc-3", "2026-10-19", 24), existing("wc-4", "2026-10-19", 8)],
        rows: [row("a", 1), row("c", 1)],
      })
    );
    const answer = deliveryTimeAnswer(runs);
    expect(answer).toMatchObject({ usesAlternatives: true, shipDate: "2026-10-21", ordinaryShipDate: "2026-10-23" });
    expect(answer.batches.map((b) => [b.rowKey, b.operations[0]!.workCenterCode, b.operations[0]!.alternativeOf?.workCenterCode ?? null, b.readyDate])).toEqual([
      ["r-a", "110", null, "2026-10-20"],
      ["r-c", "140", "130", "2026-10-20"],
    ]);
  });

  it("counts the alternatives only when they move the delivery date — otherwise the whole answer is the ordinarie run", () => {
    // Row 1 would be ready a week earlier on 120, but row 2 (bought, 15
    // working days) decides the date either way.
    const runs = runDeliveryTimeChecks(
      made([withAlternatives(8)], {
        articles: articles(article("m", "manufactured"), article("p")),
        suppliers: new Map([["p", supplier(15)]]),
        existingOperations: FULL_110,
        rows: [row("m", 1), row("p", 1)],
      })
    );
    expect(runs.withAlternatives!.rows[0]!.readyDate).toBe("2026-10-19");
    expect(runs.withAlternatives!.deliveryDate).toBe(runs.ordinary.deliveryDate);
    const answer = deliveryTimeAnswer(runs);
    expect(answer).toMatchObject({ usesAlternatives: false, deliveryDate: runs.ordinary.deliveryDate, ordinaryDeliveryDate: null });
    expect(answer.rows[0]).toMatchObject({ readyDate: "2026-10-26", ordinaryReadyDate: "2026-10-26" });
    expect(answer.batches[0]!.operations[0]!.workCenterId).toBe("wc-1");
  });

  it("books the chosen resource: the next row sees the alternative's load", () => {
    // Two rows of 30 h; 110 is full this week, 120 free. Row a takes 120
    // Monday–Thursday (2 h left on Thursday). Row b sees that load: on 120
    // it starts with Thursday's 2 h and is ready Wednesday the 28th — still
    // a day before 110 (Thursday the 29th), so it takes 120 too.
    const runs = runDeliveryTimeChecks(
      made([withAlternatives(30)], { existingOperations: FULL_110, rows: [row("m", 1, { key: "a" }), row("m", 1, { key: "b" })] })
    );
    const answer = deliveryTimeAnswer(runs);
    expect(answer.batches.map((b) => [b.rowKey, b.operations[0]!.workCenterId, b.readyDate])).toEqual([
      ["a", "wc-2", "2026-10-22"],
      ["b", "wc-2", "2026-10-28"],
    ]);
    expect(answer.batches[1]!.operations[0]!.days[0]).toEqual({ date: "2026-10-22", minutes: 120 });
    // Only the ordinarie: 30 h from Monday the 26th, then 30 h more — ready 4 November.
    expect(answer).toMatchObject({ usesAlternatives: true, shipDate: "2026-10-29", ordinaryShipDate: "2026-11-05" });
  });

  it("an ordinarie without a date within the horizon: the alternative's date, and Med ordinarie resurser has none", () => {
    // 5000 h on 110 is more than two years of 8 h days; on 120 (its own
    // 10 h) it is done tomorrow.
    const big: DtcOperation = { ...op(10, 5000), alternatives: [{ workCenterId: "wc-2", setupTime: 600, runTimePerUnit: 0 }] };
    const runs = runDeliveryTimeChecks(made([big]));
    expect(runs.ordinary).toMatchObject({ shipDate: null, deliveryDate: null, batches: [] });
    const answer = deliveryTimeAnswer(runs);
    expect(answer).toMatchObject({ usesAlternatives: true, deliveryDate: "2026-10-21", ordinaryShipDate: null, ordinaryDeliveryDate: null });
    expect(answer.rows[0]).toMatchObject({ readyDate: "2026-10-20", ordinaryReadyDate: null });
    expect(answer.batches[0]!.operations[0]).toMatchObject({ workCenterId: "wc-2", alternativeOf: { workCenterCode: "110", toDate: null } });
    // useAlternatives false: the ordinarie run — no date and nothing to reserve.
    expect(deliveryTimeAnswer(runs, false)).toMatchObject({
      usesAlternatives: false,
      shipDate: null,
      deliveryDate: null,
      ordinaryShipDate: null,
      ordinaryDeliveryDate: null,
      batches: [],
    });
  });

  it("keeps only the alternatives the delivery date needs: a row that is not critical goes back to its ordinarie", () => {
    // Row A (8 h on 110, alternative 120): 110 is full this week, so A
    // would be a week earlier on 120 too. Row C (8 h on 130, alternative
    // 140): 130 is full for three weeks, 140 only this week — C decides the
    // date and needs 140.
    const wc3: DtcWorkCenter = { ...wc1, workCenterId: "wc-3", code: "130", name: "Svets" };
    const wc4: DtcWorkCenter = { ...wc1, workCenterId: "wc-4", code: "140", name: "Svets 2" };
    const opC: DtcOperation = { ...op(10, 8, "wc-3"), alternatives: [{ workCenterId: "wc-4", setupTime: 480, runTimePerUnit: 0 }] };
    const build = (rows: DtcRowInput[]) =>
      input({
        articles: articles(article("a", "manufactured"), article("c", "manufactured")),
        routings: new Map([
          ["a", [withAlternatives(8)]],
          ["c", [opC]],
        ]),
        workCenters: new Map([...workCenters, ["wc-3", wc3], ["wc-4", wc4]]),
        existingOperations: [
          ...FULL_110,
          existing("wc-3", "2026-10-19", 120),
          existing("wc-4", "2026-10-19", 40),
        ],
        rows,
      });
    // Alone, A takes 120 (a week earlier).
    expect(deliveryTimeAnswer(runDeliveryTimeChecks(build([row("a", 1)])))).toMatchObject({ usesAlternatives: true, deliveryDate: "2026-10-20" });

    const runs = runDeliveryTimeChecks(build([row("a", 1), row("c", 1)]));
    const answer = deliveryTimeAnswer(runs);
    // C on 140 is ready Monday the 26th, on 130 the 9th of November. A on
    // 110 is ready the 26th too, so 120 would not move the date: only C's
    // operation is on an alternative.
    expect(answer).toMatchObject({ usesAlternatives: true, shipDate: "2026-10-27", ordinaryShipDate: "2026-11-10" });
    expect(answer.batches.map((b) => [b.rowKey, b.operations[0]!.workCenterCode, b.operations[0]!.alternativeOf?.workCenterCode ?? null, b.readyDate])).toEqual([
      ["r-a", "110", null, "2026-10-26"],
      ["r-c", "140", "130", "2026-10-26"],
    ]);
    expect(answer.rows.map((r) => [r.key, r.readyDate, r.ordinaryReadyDate])).toEqual([
      ["r-a", "2026-10-26", "2026-10-26"],
      ["r-c", "2026-10-26", "2026-11-09"],
    ]);
    expect(answer.rows[0]!.chain[0]).toMatchObject({ workCenterCode: "110", alternativeOf: null });
    // The reservation's run under the lock is the same pure pass.
    expect(deliveryTimeAnswer(runDeliveryTimeChecks(build([row("a", 1), row("c", 1)])))).toEqual(answer);
  });

  it("a configured row's operations take their alternatives the same way", () => {
    const runs = runDeliveryTimeChecks(
      input({
        articles: articles(article("t", "manufactured")),
        workCenters,
        existingOperations: FULL_110,
        rows: [row("t", 1, { key: "cfg", structure: { quantity: 1, operations: [withAlternatives(8)], materials: [] } })],
      })
    );
    const answer = deliveryTimeAnswer(runs);
    expect(answer).toMatchObject({ usesAlternatives: true, deliveryDate: "2026-10-20", ordinaryDeliveryDate: "2026-10-27" });
    expect(answer.batches).toEqual([
      expect.objectContaining({
        rowKey: "cfg",
        operations: [expect.objectContaining({ sequenceNo: 10, workCenterId: "wc-2", workCenterCode: "120", days: [{ date: "2026-10-19", minutes: 480 }] })],
      }),
    ]);
  });

  it("never tries an inactive alternative or one without capacity; without alternatives the check runs once", () => {
    const untried = runDeliveryTimeChecks(made([withAlternatives(8, "wc-i", "wc-n")], { existingOperations: FULL_110 }));
    expect(untried.withAlternatives!.batches[0]!.operations[0]!.workCenterId).toBe("wc-1");
    expect(deliveryTimeAnswer(untried)).toMatchObject({ usesAlternatives: false, deliveryDate: "2026-10-27" });
    const plain = runDeliveryTimeChecks(made([op(10, 8)], { existingOperations: FULL_110 }));
    expect(plain.withAlternatives).toBeNull();
    // The answer is the run itself, every operation step marked as on the ordinarie.
    const answer = deliveryTimeAnswer(plain);
    expect(answer).toEqual({
      ...plain.ordinary,
      rows: plain.ordinary.rows.map((r) => ({ ...r, chain: r.chain.map((c) => ({ ...c, alternativeOf: null })), ordinaryReadyDate: r.readyDate })),
      batches: plain.ordinary.batches.map((b) => ({
        ...b,
        operations: b.operations.map((o) => ({ ...o, workCenterCode: "110", workCenterName: "Kantpress", alternativeOf: null })),
      })),
      usesAlternatives: false,
      ordinaryShipDate: null,
      ordinaryDeliveryDate: null,
    });
  });

  it("is deterministic: the same input gives the same answer (the check and the reservation's run under the lock)", () => {
    const build = () => made([withAlternatives(30)], { existingOperations: FULL_110, rows: [row("m", 1, { key: "a" }), row("m", 1, { key: "b" })] });
    expect(deliveryTimeAnswer(runDeliveryTimeChecks(build()))).toEqual(deliveryTimeAnswer(runDeliveryTimeChecks(build())));
    // The input is not mutated by a run.
    const once = build();
    const snapshot = JSON.stringify([...once.routings]);
    runDeliveryTimeChecks(once);
    expect(JSON.stringify([...once.routings])).toBe(snapshot);
  });
});
