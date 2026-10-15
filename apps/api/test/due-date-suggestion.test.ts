import { describe, expect, it } from "vitest";
import { buildArticleOverview, type ArticleOverviewInput } from "../src/modules/planning/service/article-overview.js";
import {
  findFirmDemand,
  previousWorkingDay,
  suggestDueDate,
} from "../src/modules/planning/service/due-date-suggestion.js";

// Pure tests — no database. The färdigdatum suggestion for a new TO: one
// working day before the article's first firm shortage (or before the
// linked KO row's delivery date), never in the past.

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

function salesRow(rowId: string, orderNumber: string, date: string | null, quantity: number) {
  return {
    rowId,
    salesOrderId: `so-${rowId}`,
    orderNumber,
    orderStatus: "confirmed" as const,
    customerName: "Kund",
    expectedDeliveryDate: date,
    quantityOrdered: quantity,
    quantityDelivered: 0,
  };
}

const NO_HOLIDAYS = new Set<string>();

describe("previousWorkingDay", () => {
  it("steps back one day within the week", () => {
    expect(previousWorkingDay("2026-11-12", NO_HOLIDAYS)).toBe("2026-11-11"); // Thu → Wed
  });

  it("skips the weekend: a Monday demand gives the Friday before", () => {
    expect(previousWorkingDay("2026-11-16", NO_HOLIDAYS)).toBe("2026-11-13");
  });

  it("skips a full-day holiday as well as the weekend", () => {
    // Mon 2026-12-28 → Fri 25 (juldagen) and Thu 24 (julafton) both off → Wed 23.
    expect(previousWorkingDay("2026-12-28", new Set(["2026-12-24", "2026-12-25"]))).toBe("2026-12-23");
  });

  it("crosses month and year boundaries", () => {
    expect(previousWorkingDay("2027-01-01", NO_HOLIDAYS)).toBe("2026-12-31");
    expect(previousWorkingDay("2026-03-01", NO_HOLIDAYS)).toBe("2026-02-27"); // Sun → Fri
  });
});

describe("findFirmDemand", () => {
  it("takes the first demand that stock and supply can't cover — not the first demand", () => {
    const o = overview({
      onHand: 20,
      salesRows: [salesRow("r1", "KO-1", "2026-11-10", 15), salesRow("r2", "KO-2", "2026-11-20", 10)],
    });
    expect(findFirmDemand(o, { today: "2026-10-06" })).toMatchObject({
      date: "2026-11-20",
      source: "shortage",
      documentNumber: "KO-2",
    });
  });

  it("counts incoming supply: a covered demand is no firm demand", () => {
    const o = overview({
      salesRows: [salesRow("r1", "KO-1", "2026-11-10", 10)],
      manufacturingOrders: [{ moId: "m1", orderNumber: "TO-1", status: "released", dueDate: "2026-11-05", quantity: 10 }],
    });
    expect(findFirmDemand(o, { today: "2026-10-06" })).toBeNull();
  });

  it("includes material demand from other TOs", () => {
    const o = overview({
      materialRows: [
        {
          rowId: "mat1",
          moId: "m9",
          orderNumber: "TO-9",
          orderStatus: "released",
          dueDate: "2026-11-03",
          parentArticleNumber: "P",
          parentArticleName: "Förälder",
          quantityPlanned: 4,
          quantityConsumed: 0,
        },
      ],
    });
    expect(findFirmDemand(o, { today: "2026-10-06" })).toMatchObject({ date: "2026-11-03", documentNumber: "TO-9" });
  });

  it("counts an undated TO as covering a dated demand", () => {
    const o = overview({
      salesRows: [salesRow("r1", "KO-1", "2026-11-10", 10)],
      manufacturingOrders: [{ moId: "m1", orderNumber: "TO-1", status: "planned", dueDate: null, quantity: 10 }],
    });
    expect(findFirmDemand(o, { today: "2026-10-06" })).toBeNull();
  });

  it("counts supply dated AFTER the demand as covering it — the date is that order's problem", () => {
    const o = overview({
      salesRows: [salesRow("r1", "KO-1", "2026-11-10", 10)],
      purchaseRows: [
        {
          rowId: "p1",
          purchaseOrderId: "io1",
          orderNumber: "IO-1",
          orderStatus: "confirmed",
          supplierName: "Lev",
          expectedDeliveryDate: "2026-12-01",
          quantityOrdered: 10,
          quantityReceived: 0,
        },
      ],
    });
    expect(findFirmDemand(o, { today: "2026-10-06" })).toBeNull();
  });

  it("allocates supply to demands in date order — the uncovered one is the later demand", () => {
    const o = overview({
      salesRows: [salesRow("r1", "KO-1", "2026-11-10", 6), salesRow("r2", "KO-2", "2026-11-20", 6)],
      manufacturingOrders: [{ moId: "m1", orderNumber: "TO-1", status: "planned", dueDate: "2026-12-15", quantity: 8 }],
    });
    expect(findFirmDemand(o, { today: "2026-10-06" })).toMatchObject({ date: "2026-11-20", documentNumber: "KO-2" });
  });

  it("gives no demand when the first shortage has no date", () => {
    const o = overview({ salesRows: [salesRow("r1", "KO-1", null, 5)] });
    expect(findFirmDemand(o, { today: "2026-10-06" })).toBeNull();
  });

  it("treats negative stock that supply doesn't make up as a shortage today", () => {
    const o = overview({ onHand: -5 });
    expect(findFirmDemand(o, { today: "2026-10-06" })).toMatchObject({
      date: "2026-10-06",
      source: "shortage",
      documentNumber: null,
    });
  });

  it("uses the linked KO row's own delivery date when it is uncovered, even if an earlier one is too", () => {
    const o = overview({
      salesRows: [salesRow("r1", "KO-1", "2026-11-10", 15), salesRow("r2", "KO-2", "2026-11-20", 10)],
    });
    expect(findFirmDemand(o, { today: "2026-10-06", salesOrderRowId: "r2" })).toMatchObject({
      date: "2026-11-20",
      source: "sales_order_row",
      documentNumber: "KO-2",
    });
  });

  it("ignores a linked KO row that is already covered, falling back to the first uncovered demand", () => {
    const o = overview({
      salesRows: [salesRow("r1", "KO-1", "2026-11-10", 10), salesRow("r2", "KO-2", "2026-11-20", 10)],
      manufacturingOrders: [{ moId: "m1", orderNumber: "TO-1", status: "planned", dueDate: null, quantity: 10 }],
    });
    // TO-1 covers KO-1 (date order) — so KO-1 is no firm demand; KO-2 is.
    expect(findFirmDemand(o, { today: "2026-10-06", salesOrderRowId: "r1" })).toMatchObject({
      date: "2026-11-20",
      source: "shortage",
      documentNumber: "KO-2",
    });
  });

  it("gives nothing for a linked KO row when every demand is covered", () => {
    const o = overview({
      onHand: 50,
      salesRows: [salesRow("r1", "KO-1", "2026-11-10", 10)],
    });
    expect(findFirmDemand(o, { today: "2026-10-06", salesOrderRowId: "r1" })).toBeNull();
  });

  it("falls back to the shortage when the linked KO row has no date", () => {
    const o = overview({
      salesRows: [salesRow("r1", "KO-1", null, 5), salesRow("r2", "KO-2", "2026-11-20", 10)],
    });
    expect(findFirmDemand(o, { today: "2026-10-06", salesOrderRowId: "r1" })).toMatchObject({
      date: "2026-11-20",
      source: "shortage",
    });
  });
});

describe("suggestDueDate", () => {
  const demand = { date: "2026-11-16", source: "shortage" as const, documentType: "sales_order" as const, documentId: "x", documentNumber: "KO-1" };

  it("suggests the working day before the demand", () => {
    expect(suggestDueDate(demand, { today: "2026-10-06", offDays: NO_HOLIDAYS })).toMatchObject({
      dueDate: "2026-11-13",
      demandDate: "2026-11-16",
      clampedToToday: false,
    });
  });

  it("suggests today when the day before the demand has already passed", () => {
    expect(suggestDueDate({ ...demand, date: "2026-10-06" }, { today: "2026-10-06", offDays: NO_HOLIDAYS })).toMatchObject({
      dueDate: "2026-10-06",
      demandDate: "2026-10-06",
      clampedToToday: true,
    });
  });

  it("keeps a working day before the demand that is exactly today", () => {
    expect(suggestDueDate({ ...demand, date: "2026-10-07" }, { today: "2026-10-06", offDays: NO_HOLIDAYS })).toMatchObject({
      dueDate: "2026-10-06",
      clampedToToday: false,
    });
  });
});
