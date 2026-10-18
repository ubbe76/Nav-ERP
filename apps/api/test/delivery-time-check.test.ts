import { describe, expect, it } from "vitest";
import {
  checkDeliveryTime,
  type DeliveryTimeCheckInput,
  type DtcArticle,
  type DtcOperation,
  type DtcRowInput,
  type DtcWorkCenter,
} from "../src/modules/planning/service/delivery-time-check.js";
import type { ArticleOverviewRow } from "../src/modules/planning/service/article-overview.js";
import type { CapacityOperationRow } from "../src/modules/planning/service/capacity-calc.js";

// Pure tests — no database. Monday 2026-10-19 is today unless a test says
// otherwise; week 43 is Mon 19 – Sun 25, week 44 Mon 26 – Sun 1 Nov.
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
    // Rounding 10 and 20 h + 1 h/st: one batch of 10 is 30 h (fits week 43).
    // A second batch would spill into week 44 — the surplus makes row b
    // ready the same day as row a.
    const result = checkDeliveryTime(
      input({
        articles: articles(article("m", "manufactured", 10)),
        routings: new Map([["m", [{ ...op(10, 20), runTimePerUnit: 60 }]]]),
        rows: [row("m", 1, { key: "a" }), row("m", 1, { key: "b" })],
      })
    );
    expect(result.rows.map((r) => r.readyDate)).toEqual(["2026-10-23", "2026-10-23"]);
    expect(result.rows[1]!.chain).toEqual(result.rows[0]!.chain);
    expect(result.rows[1]!.chain[0]).toMatchObject({ kind: "operation", quantity: 10 });
  });

  it("the rounding surplus of a component covers the next level too", () => {
    // m1 and m2 each need 1 of the made part h (rounding 10, 30 h a batch):
    // m2 takes m1's surplus instead of a second batch in week 44.
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
    expect(result.rows.map((r) => r.readyDate)).toEqual(["2026-10-23", "2026-10-23"]);
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

describe("Leveranstidskontroll — made, capacity per week", () => {
  const made = (ops: DtcOperation[], extra: Partial<DeliveryTimeCheckInput> = {}) =>
    input({
      articles: articles(article("m", "manufactured"), article("p")),
      overviews: new Map([["p", { onHand: 100, rows: [] }]]),
      bomEdges: [{ parentArticleId: "m", componentArticleId: "p", quantity: 2 }],
      routings: new Map([["m", ops]]),
      rows: [row("m", 10)],
      ...extra,
    });

  it("fits in the current week: ready the last working day, ships the next", () => {
    const result = checkDeliveryTime(made([{ ...op(10, 1), runTimePerUnit: 60 }]));
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
    expect(result.rows[0]!.chain).toEqual([
      {
        kind: "operation",
        articleNumber: "NR-m",
        quantity: 10,
        sequenceNo: 10,
        description: "Op 10",
        workCenterCode: "110",
        workCenterName: "Kantpress",
        fromWeek: "2026-10-19",
        toWeek: "2026-10-19",
        weeks: [{ monday: "2026-10-19", minutes: 660 }], // 1 h setup + 10 × 60 min
        date: "2026-10-23",
      },
    ]);
    expect(result.shipDate).toBe("2026-10-26");
  });

  it("a full week pushes the operation to the next", () => {
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-21", 40)] }));
    expect(result.rows[0]).toMatchObject({ readyDate: "2026-10-30" });
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromWeek: "2026-10-26", toWeek: "2026-10-26" });
  });

  it("an operation is split over weeks", () => {
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-21", 35)] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromWeek: "2026-10-19", toWeek: "2026-10-26", date: "2026-10-30" });
  });

  it("past-due load lands in the current week", () => {
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-01", 40)] }));
    expect(result.rows[0]!.readyDate).toBe("2026-10-30");
  });

  it("load beyond a week's capacity rolls into the following weeks", () => {
    // 75 h due this week on a 40 h resource: week 43 full, 35 h spill into
    // week 44 (5 h free), so 11 h is 5 h in week 44 + 6 h in week 45.
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-21", 75)] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromWeek: "2026-10-26", toWeek: "2026-11-02", date: "2026-11-06" });
  });

  it("the backlog of several weeks rolls as one queue", () => {
    // Week 43: 40 h (full). Week 44: 60 h — 20 h roll into week 45, leaving
    // 20 h there; 25 h is 20 h in week 45 + 5 h in week 46.
    const result = checkDeliveryTime(
      made([op(10, 25)], { existingOperations: [existing("wc-1", "2026-10-21", 40), existing("wc-1", "2026-10-28", 60)] })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromWeek: "2026-11-02", toWeek: "2026-11-09", date: "2026-11-13" });
  });

  it("the current week only counts from today", () => {
    // Wednesday: 3 days × 8 h = 24 h left this week.
    const result = checkDeliveryTime(made([op(10, 30)], { today: "2026-10-21" }));
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromWeek: "2026-10-19", toWeek: "2026-10-26", date: "2026-10-30" });
  });

  it("two operations can finish in the same week", () => {
    const result = checkDeliveryTime(made([op(10, 4), op(20, 4)]));
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
    expect(result.rows[0]!.chain.map((s) => s.kind)).toEqual(["operation", "operation"]);
  });

  it("material arriving mid-week only leaves the rest of that week", () => {
    const result = checkDeliveryTime(
      made([op(10, 30)], {
        overviews: new Map([["p", { onHand: 0, rows: [] }]]),
        suppliers: new Map([["p", supplier(7)]]),
      })
    );
    // Material Wednesday 28: 24 h that week, 6 h the next.
    expect(result.rows[0]!.chain.map((s) => s.kind)).toEqual(["purchase", "operation"]);
    expect(result.rows[0]!.chain[1]).toMatchObject({ fromWeek: "2026-10-26", toWeek: "2026-11-02", date: "2026-11-06" });
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
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
    expect(result.notes).toEqual(["Resurs 110 har 40 h beläggning utan datum som inte räknas"]);
  });

  it("hours per day give capacity without a week schedule", () => {
    // 4 h a day: 20 h a week, so 30 h is week 43 + 10 h of week 44.
    const result = checkDeliveryTime(
      made([op(10, 30)], { workCenters: new Map([["wc-1", { ...wc1, weekScheduleId: null, hoursPerDay: 4 }]]) })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromWeek: "2026-10-19", toWeek: "2026-10-26", date: "2026-10-30" });
    expect(result.rows[0]!.notes).toEqual([]);
  });

  it("a resource without a week schedule is not capacity-planned", () => {
    const result = checkDeliveryTime(
      made([op(10, 100)], { workCenters: new Map([["wc-1", { ...wc1, weekScheduleId: null }]]) })
    );
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
    expect(result.rows[0]!.notes).toEqual(["Resurs 110 saknar veckoschema och timmar per dag — kapaciteten räknas inte"]);
  });

  it("a lego operation takes the resource's lead time in working days", () => {
    const lego: DtcWorkCenter = { ...wc1, workCenterId: "wc-l", code: "900", name: "Ytbehandling", type: "subcontract", weekScheduleId: null, leadTimeDays: 3 };
    const result = checkDeliveryTime(
      made([op(10, 0, "wc-l")], { workCenters: new Map([["wc-1", wc1], ["wc-l", lego]]) })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ kind: "subcontract", leadTimeDays: 3, date: "2026-10-22" });
    expect(result.shipDate).toBe("2026-10-23");
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
    expect(result.rows[0]!.chain[1]).toMatchObject({ sequenceNo: 10, workCenterCode: "110", fromWeek: "2026-10-19" });
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
          ["h", [op(10, 8)]],
          ["m", [op(10, 4)]],
        ]),
        suppliers: new Map([["q", supplier(1)]]),
        rows: [row("m", 1)],
      })
    );
    // h: Op 10 this week (ready Friday 23); q via the phantom: Tuesday 20.
    // m: from Friday 23 there are 8 h left — its 4 h fit.
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
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
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
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
    plannedWeeks: [{ monday: "2026-10-26", minutes: 60 }],
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
    // The batch (8 h this week) is ready Friday the 23rd; the TO's planned
    // week 44 finishes Friday the 30th — the later one is the row's date.
    expect(result.batches.map((b) => [b.rowKey, b.quantity])).toEqual([["cfg", 1]]);
    expect(result.rows[0]).toMatchObject({ quantity: 2, readyDate: "2026-10-30", notes: [] });
    expect(result.rows[0]!.chain).toEqual([
      expect.objectContaining({ kind: "supply", documentType: "manufacturing_order", documentNumber: "TO-1", quantity: 1, date: "2026-10-30", undated: false, late: false }),
    ]);
    expect(result.shipDate).toBe("2026-11-02");
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
// Every test above runs unchanged (rows without plans go through the due
// date's buckets exactly as before). These add planned existing load, the
// allocation on the steps and the batches a reservation creates TOs from.

describe("Leveranstidskontroll — planned load, weeks and batches", () => {
  const made = (ops: DtcOperation[], extra: Partial<DeliveryTimeCheckInput> = {}) =>
    input({
      articles: articles(article("m", "manufactured"), article("p")),
      overviews: new Map([["p", { onHand: 100, rows: [] }]]),
      bomEdges: [{ parentArticleId: "m", componentArticleId: "p", quantity: 2 }],
      routings: new Map([["m", ops]]),
      rows: [row("m", 10)],
      ...extra,
    });

  it("existing load that is planned counts in its planned weeks, not its due week", () => {
    const planned = { ...existing("wc-1", "2026-10-21", 40), plannedWeeks: [{ monday: "2026-10-26", minutes: 2400 }] };
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [planned] }));
    // Week 43 is free: the 40 h sit in week 44. Unplanned, the same load
    // would fill week 43 and push the operation to week 44 (test above).
    expect(result.rows[0]!.chain[0]).toMatchObject({ fromWeek: "2026-10-19", toWeek: "2026-10-19", date: "2026-10-23" });
  });

  it("planned existing load is its remaining time filled from the back", () => {
    // 60 h planned v.43: 40 / v.44: 20 with 30 h reported ⇒ v.43: 10, v.44: 20.
    const planned: CapacityOperationRow = {
      ...existing("wc-1", "2026-10-30", 0),
      setupTime: 0,
      runTimePerUnit: 60,
      orderQuantity: 60,
      quantityCompleted: 30,
      plannedWeeks: [{ monday: "2026-10-19", minutes: 2400 }, { monday: "2026-10-26", minutes: 1200 }],
    };
    const result = checkDeliveryTime(made([op(10, 40)], { existingOperations: [planned] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({
      weeks: [{ monday: "2026-10-19", minutes: 1800 }, { monday: "2026-10-26", minutes: 600 }],
      date: "2026-10-30",
    });
  });

  it("an operation step carries its allocation, split over weeks", () => {
    const result = checkDeliveryTime(made([op(10, 11)], { existingOperations: [existing("wc-1", "2026-10-21", 35)] }));
    expect(result.rows[0]!.chain[0]).toMatchObject({
      fromWeek: "2026-10-19",
      toWeek: "2026-10-26",
      weeks: [{ monday: "2026-10-19", minutes: 300 }, { monday: "2026-10-26", minutes: 360 }],
    });
  });

  it("a row that reaches the horizon shows what was booked on the step and gets no batch", () => {
    const result = checkDeliveryTime(
      made([op(10, 1)], { schedule: { weekScheduleDays: [], daySchedules: [], holidays: [] } })
    );
    expect(result.rows[0]!.chain[0]).toMatchObject({ kind: "operation", weeks: [] });
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
    // h: 3 short, rounded up to 10, Op 10 this week (ready Friday 23).
    // m: 5, from Friday 23 there are 8 h left of 40 − 8: both operations fit.
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
    expect(result.batches).toEqual([
      {
        key: "row-1:2:h:0",
        rowKey: "row-1",
        level: 2,
        articleId: "h",
        articleNumber: "NR-h",
        quantity: 10,
        readyDate: "2026-10-23",
        operations: [{ sequenceNo: 10, workCenterId: "wc-1", weeks: [{ monday: "2026-10-19", minutes: 480 }] }],
      },
      {
        key: "row-1:1:m:1",
        rowKey: "row-1",
        level: 1,
        articleId: "m",
        articleNumber: "NR-m",
        quantity: 5,
        readyDate: "2026-10-23",
        operations: [
          { sequenceNo: 10, workCenterId: "wc-1", weeks: [{ monday: "2026-10-19", minutes: 240 }] },
          { sequenceNo: 20, workCenterId: "wc-1", weeks: [{ monday: "2026-10-19", minutes: 120 }] },
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
    expect(result.batches.map((b) => [b.rowKey, b.articleNumber, b.readyDate])).toEqual([["a", "NR-m", "2026-10-27"]]);
    expect(result.batches[0]!.operations).toEqual([
      { sequenceNo: 10, workCenterId: "wc-1", weeks: [{ monday: "2026-10-19", minutes: 120 }] },
      { sequenceNo: 20, workCenterId: "wc-l", weeks: [] },
      { sequenceNo: 30, workCenterId: "wc-1", weeks: [] },
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
        readyDate: "2026-10-23",
        operations: [{ sequenceNo: 10, workCenterId: "wc-1", weeks: [{ monday: "2026-10-19", minutes: 480 }] }],
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
