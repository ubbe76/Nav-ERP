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

function supply(date: string | null, quantity: number, documentNumber = "IO-1"): ArticleOverviewRow {
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
    expect(result.rows[0]!.chain[0]).toMatchObject({ kind: "supply", documentNumber: "IO-2", date: "2026-10-28" });
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

  it("undated existing load is left out, with a note", () => {
    const result = checkDeliveryTime(made([op(10, 2)], { existingOperations: [existing("wc-1", null, 40)] }));
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
    expect(result.notes).toEqual(["Resurs 110 har 40 h beläggning utan datum som inte räknas"]);
  });

  it("a resource without a week schedule is not capacity-planned", () => {
    const result = checkDeliveryTime(
      made([op(10, 100)], { workCenters: new Map([["wc-1", { ...wc1, weekScheduleId: null }]]) })
    );
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
    expect(result.rows[0]!.notes).toEqual(["Resurs 110 saknar veckoschema — kapaciteten räknas inte"]);
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
        rows: [row("t", 2, { structure: { operations: [op(10, 8)], materials: [{ articleId: "p", quantity: 6 }] } })],
      })
    );
    expect(result.rows[0]!.chain.map((s) => s.kind)).toEqual(["operation"]);
    expect(result.rows[0]!.readyDate).toBe("2026-10-23");
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
