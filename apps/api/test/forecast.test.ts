import { describe, expect, it } from "vitest";
import {
  addMonths,
  articleForecastInput,
  averageConsumption,
  forecastDemandOf,
  forecastLabel,
  forecastMonthRows,
  forecastWeeklyDemands,
  historyMonths,
  horizonMonths,
  isForecastArticle,
  lastDayOf,
  monthForecast,
  monthsInclusive,
  spreadOverWeeks,
  type ArticleForecastInput,
  type ForecastCalendar,
} from "../src/modules/planning/service/forecast.js";
import {
  computeRequirements,
  type RequirementsArticle,
  type RequirementsInput,
  type RequirementRow,
} from "../src/modules/planning/service/requirements-calc.js";
import {
  buildArticleOverview,
  firmDemandsOf,
  isFirmOverviewRow,
  type ArticleOverviewInput,
  type ArticleOverviewRow,
} from "../src/modules/planning/service/article-overview.js";
import { pegOverview } from "../src/modules/planning/service/pegging.js";
import { findFirmDemand } from "../src/modules/planning/service/due-date-suggestion.js";
import { checkDeliveryTime, type DeliveryTimeCheckInput } from "../src/modules/planning/service/delivery-time-check.js";

// Prognos (#10), pure — no database. Today is Monday 2030-03-04 (week 10):
// March 2030 has 20 working days left from today in four whole weeks (4,
// 11, 18, 25 March), April starts on a Monday and has 22 working days in
// five weeks (the last with 29–30 April), May starts on a Wednesday.
const TODAY = "2030-03-04";
const NONE: ReadonlySet<string> = new Set();
const cal = (horizon: string[], offDays: ReadonlySet<string> = NONE): ForecastCalendar => ({ today: TODAY, offDays, horizon });
const months = (entries: [string, number][]) => new Map(entries);

function fc(partial: Partial<ArticleForecastInput> & { average: number }): ArticleForecastInput {
  return { articleId: "f", own: new Map(), consumedThisMonth: 0, ...partial };
}

describe("the calendar", () => {
  it("counts whole months before today's and the horizon from today's month", () => {
    expect(historyMonths(TODAY, 3)).toEqual(["2029-12", "2030-01", "2030-02"]);
    expect(historyMonths(TODAY, 12)[0]).toBe("2029-03");
    expect(horizonMonths(TODAY, 6)).toEqual(["2030-03", "2030-04", "2030-05", "2030-06", "2030-07", "2030-08"]);
    expect(horizonMonths("2030-11-15", 3)).toEqual(["2030-11", "2030-12", "2031-01"]);
    expect(addMonths("2030-01", -1)).toBe("2029-12");
    expect(addMonths("2030-12", 13)).toBe("2032-01");
    expect(lastDayOf("2030-02")).toBe("2030-02-28");
    expect(lastDayOf("2032-02")).toBe("2032-02-29");
    expect(monthsInclusive("2029-12", "2030-02")).toBe(3);
    expect(monthsInclusive("2030-02", "2029-12")).toBe(0);
  });
});

describe("the average", () => {
  const history = historyMonths(TODAY, 12);

  it("divides the window's consumption by its months, missing months count 0", () => {
    expect(averageConsumption(months([["2029-03", 60], ["2029-09", 60]]), history, "2028-01-15".slice(0, 7))).toBe(10);
    expect(averageConsumption(months([["2029-03", 10]]), history, null)).toBe(0.8333);
  });

  it("is 0 without any consumption", () => {
    expect(averageConsumption(new Map(), history, null)).toBe(0);
    expect(averageConsumption(new Map(), history, "2030-01")).toBe(0);
  });

  it("divides by the months since the first stock movement when that lies inside the window", () => {
    // First movement in December: Dec, Jan, Feb = 3 months.
    expect(averageConsumption(months([["2029-12", 10], ["2030-01", 10], ["2030-02", 10]]), history, "2029-12")).toBe(10);
    // The month of the first movement counts as a whole month even when the
    // movement was late in it; a first movement in the window's last month
    // divides by 1; before or in the window's first month = the full window.
    expect(averageConsumption(months([["2030-02", 7]]), history, "2030-02")).toBe(7);
    expect(averageConsumption(months([["2029-03", 12]]), history, "2029-03")).toBe(1);
    expect(averageConsumption(months([["2029-03", 12]]), history, "2025-06")).toBe(1);
    expect(averageConsumption(months([["2030-01", 10]]), history, "2029-12")).toBe(3.3333);
  });

  it("articleForecastInput derives the average and the current month's consumed part from the raw rows", () => {
    const input = articleForecastInput({
      articleId: "f",
      consumption: months([["2029-12", 10], ["2030-01", 20], ["2030-03", 4.5]]),
      own: months([["2030-04", 7]]),
      firstMovementDate: "2029-12-20",
      history,
      today: TODAY,
    });
    expect(input).toEqual({ articleId: "f", average: 10, own: months([["2030-04", 7]]), consumedThisMonth: 4.5 });
    // Never moved: the full window.
    expect(articleForecastInput({ articleId: "f", consumption: months([["2030-02", 12]]), own: new Map(), firstMovementDate: null, history, today: TODAY }).average).toBe(1);
  });
});

describe("the month forecast and its consumption by orders", () => {
  it("the own quantity wins, also 0", () => {
    expect(monthForecast(10, null)).toBe(10);
    expect(monthForecast(10, 25)).toBe(25);
    expect(monthForecast(10, 0)).toBe(0);
  });

  it("forecast demand is what the month's forecast exceeds the real demand (and the consumed part) by, never negative", () => {
    expect(forecastDemandOf({ forecast: 100, actualDemand: 30, alreadyConsumed: 0 })).toBe(70);
    expect(forecastDemandOf({ forecast: 100, actualDemand: 60, alreadyConsumed: 50 })).toBe(0);
    expect(forecastDemandOf({ forecast: 10, actualDemand: 3.3333, alreadyConsumed: 3.3333 })).toBe(3.3334);
  });

  it("one row per horizon month: orders below/above the forecast, the current month's consumed part, late and undated orders ignored", () => {
    const rows = forecastMonthRows(
      fc({ average: 100, own: months([["2030-04", 40]]), consumedThisMonth: 30 }),
      [
        { date: "2030-02-20", quantity: 500 }, // before the current month: consumes nothing
        { date: null, quantity: 500 }, // undated: consumes nothing
        { date: "2030-03-10", quantity: 20 },
        { date: "2030-03-28", quantity: 25 },
        { date: "2030-04-02", quantity: 70 }, // above the own quantity
        { date: "2030-06-01", quantity: 10 }, // beyond the horizon
      ],
      cal(["2030-03", "2030-04", "2030-05"])
    );
    expect(rows).toEqual([
      { month: "2030-03", average: 100, own: null, forecast: 100, actualDemand: 45, alreadyConsumed: 30, forecastDemand: 25 },
      { month: "2030-04", average: 100, own: 40, forecast: 40, actualDemand: 70, alreadyConsumed: null, forecastDemand: 0 },
      { month: "2030-05", average: 100, own: null, forecast: 100, actualDemand: 0, alreadyConsumed: null, forecastDemand: 100 },
    ]);
  });
});

describe("the weekly spread", () => {
  it("spreads over the working days from today in the current month, per ISO week, dated the week's first working day", () => {
    expect(spreadOverWeeks("2030-03", 100, { today: TODAY, offDays: NONE })).toEqual([
      { date: "2030-03-04", isoYear: 2030, isoWeek: 10, quantity: 25 },
      { date: "2030-03-11", isoYear: 2030, isoWeek: 11, quantity: 25 },
      { date: "2030-03-18", isoYear: 2030, isoWeek: 12, quantity: 25 },
      { date: "2030-03-25", isoYear: 2030, isoWeek: 13, quantity: 25 },
    ]);
  });

  it("keeps the month total exactly — the last week takes the rest after rounding", () => {
    const pieces = spreadOverWeeks("2030-04", 10, { today: TODAY, offDays: NONE });
    expect(pieces.map((p) => p.quantity)).toEqual([2.2727, 2.2727, 2.2727, 2.2727, 0.9092]);
    expect(pieces.map((p) => p.date)).toEqual(["2030-04-01", "2030-04-08", "2030-04-15", "2030-04-22", "2030-04-29"]);
    expect(pieces.reduce((s, p) => s + p.quantity, 0)).toBeCloseTo(10, 9);
  });

  it("a month that starts mid-week gets a short first piece on the 1st, and a holiday moves the first day and the share", () => {
    const may = spreadOverWeeks("2030-05", 9, { today: TODAY, offDays: NONE });
    expect(may[0]).toEqual({ date: "2030-05-01", isoYear: 2030, isoWeek: 18, quantity: 1.1739 }); // 3 of 23 days
    expect(may).toHaveLength(5);
    expect(may.reduce((s, p) => s + p.quantity, 0)).toBeCloseTo(9, 9);

    const holiday = spreadOverWeeks("2030-03", 19, { today: TODAY, offDays: new Set(["2030-03-04"]) });
    expect(holiday.map((p) => [p.date, p.quantity])).toEqual([
      ["2030-03-05", 4],
      ["2030-03-11", 5],
      ["2030-03-18", 5],
      ["2030-03-25", 5],
    ]);
  });

  it("today mid-month starts today; no working days left, a past month or quantity 0 give nothing", () => {
    expect(spreadOverWeeks("2030-03", 8, { today: "2030-03-20", offDays: NONE }).map((p) => [p.date, p.quantity])).toEqual([
      ["2030-03-20", 3],
      ["2030-03-25", 5],
    ]);
    expect(spreadOverWeeks("2030-03", 8, { today: "2030-03-30", offDays: NONE })).toEqual([]);
    expect(spreadOverWeeks("2030-02", 8, { today: TODAY, offDays: NONE })).toEqual([]);
    expect(spreadOverWeeks("2030-04", 0, { today: TODAY, offDays: NONE })).toEqual([]);
  });

  it("forecastWeeklyDemands names each piece after its month and week", () => {
    const pieces = forecastWeeklyDemands(fc({ average: 100 }), [{ date: "2030-03-10", quantity: 60 }], cal(["2030-03"]));
    expect(pieces).toEqual([
      { articleId: "f", month: "2030-03", date: "2030-03-04", label: "Prognos 2030-03 · v.10", quantity: 10 },
      { articleId: "f", month: "2030-03", date: "2030-03-11", label: "Prognos 2030-03 · v.11", quantity: 10 },
      { articleId: "f", month: "2030-03", date: "2030-03-18", label: "Prognos 2030-03 · v.12", quantity: 10 },
      { articleId: "f", month: "2030-03", date: "2030-03-25", label: "Prognos 2030-03 · v.13", quantity: 10 },
    ]);
    expect(forecastLabel("2030-11", 47)).toBe("Prognos 2030-11 · v.47");
  });

  it("isForecastArticle: Prognosstyrd, active, no phantom/service/beställningsvara", () => {
    const base = { forecastControlled: true, active: true, isPhantom: false, type: "purchased" as const, configuratorMode: null };
    expect(isForecastArticle(base)).toBe(true);
    expect(isForecastArticle({ ...base, forecastControlled: false })).toBe(false);
    expect(isForecastArticle({ ...base, forecastControlled: undefined })).toBe(false);
    expect(isForecastArticle({ ...base, active: false })).toBe(false);
    expect(isForecastArticle({ ...base, isPhantom: true })).toBe(false);
    expect(isForecastArticle({ ...base, type: "service" })).toBe(false);
    expect(isForecastArticle({ ...base, configuratorMode: "to_order" })).toBe(false);
    expect(isForecastArticle({ ...base, configuratorMode: "variants" })).toBe(true);
  });
});

// --- The behovsberäkning -----------------------------------------------------

function art(overrides: Partial<RequirementsArticle> & { articleId: string }): RequirementsArticle {
  return {
    articleNumber: overrides.articleId.toUpperCase(),
    name: `Artikel ${overrides.articleId}`,
    type: "purchased",
    isPhantom: false,
    active: true,
    unitCode: "st",
    groupId: null,
    reorderPoint: null,
    orderQuantity: null,
    rounding: null,
    configuratorMode: null,
    ...overrides,
  };
}

function calcInput(partial: Partial<RequirementsInput>): RequirementsInput {
  return {
    articles: [],
    salesRows: [],
    purchaseRows: [],
    manufacturingOrders: [],
    moMaterialRows: [],
    stock: [],
    bomEdges: [],
    primarySuppliers: [],
    legoOperationRows: [],
    configuredRows: [],
    configuredCascade: new Map(),
    today: TODAY,
    offDays: NONE,
    ...partial,
  };
}

const rowFor = (rows: RequirementRow[], id: string) => rows.find((r) => r.articleId === id)!;
const sum = (list: { quantity: number }[]) => Math.round(list.reduce((s, p) => s + p.quantity, 0) * 1e4) / 1e4;

describe("behovsberäkningen with forecast demand", () => {
  const horizon = ["2030-03", "2030-04"];

  it("gives a prognosstyrd article one proposal per week of forecast demand, nets stock, and leaves other articles alone", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "f", forecastControlled: true }), art({ articleId: "o" })],
        stock: [{ articleId: "f", quantity: 30 }],
        forecast: { calendar: cal(horizon), articles: [fc({ average: 100 })] },
      })
    );
    const f = rowFor(rows, "f");
    expect(f.demandForecast).toBe(200);
    expect(f.projected).toBe(-170);
    // March: 25 a week from today; April: 22 working days in five weeks.
    expect(f.proposals.map((p) => [p.needDate, p.quantity, p.reason])).toEqual([
      ["2030-03-11", 20, "demand"], // 30 in stock covers week 10 and 5 of week 11
      ["2030-03-18", 25, "demand"],
      ["2030-03-25", 25, "demand"],
      ["2030-04-01", 22.7273, "demand"],
      ["2030-04-08", 22.7273, "demand"],
      ["2030-04-15", 22.7273, "demand"],
      ["2030-04-22", 22.7273, "demand"],
      ["2030-04-29", 9.0908, "demand"],
    ]);
    expect(sum(f.proposals)).toBe(170);
    // A relevant row even without orders or stock: the forecast is the demand.
    expect(rows.find((r) => r.articleId === "o")).toBeUndefined();
  });

  it("orders in the month consume the forecast — the month's demand is the larger of the two, never both", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "f", forecastControlled: true })],
        salesRows: [{ articleId: "f", orderStatus: "confirmed", quantityOrdered: 60, quantityDelivered: 0, expectedDeliveryDate: "2030-03-12" }],
        forecast: { calendar: cal(["2030-03"]), articles: [fc({ average: 100 })] },
      })
    );
    const f = rowFor(rows, "f");
    expect(f.demandSales).toBe(60);
    expect(f.demandForecast).toBe(40);
    expect(f.projected).toBe(-100);
    expect(f.proposals.map((p) => [p.needDate, p.quantity])).toEqual([
      ["2030-03-04", 10],
      ["2030-03-11", 70], // the order's 60 and the week's 10 of forecast
      ["2030-03-18", 10],
      ["2030-03-25", 10],
    ]);
    // Above the forecast: nothing is added.
    const above = rowFor(
      computeRequirements(
        calcInput({
          articles: [art({ articleId: "f", forecastControlled: true })],
          salesRows: [{ articleId: "f", orderStatus: "confirmed", quantityOrdered: 150, quantityDelivered: 0, expectedDeliveryDate: "2030-03-12" }],
          forecast: { calendar: cal(["2030-03"]), articles: [fc({ average: 100 })] },
        })
      ),
      "f"
    );
    expect(above.demandForecast).toBe(0);
    expect(above.proposalQuantity).toBe(150);
  });

  it("an article without the forecast input (not prognosstyrd) is computed exactly as before", () => {
    const base = calcInput({
      articles: [art({ articleId: "o" })],
      salesRows: [{ articleId: "o", orderStatus: "confirmed", quantityOrdered: 5, quantityDelivered: 0, expectedDeliveryDate: "2030-03-12" }],
    });
    const without = computeRequirements(base);
    const withForecast = computeRequirements({ ...base, forecast: { calendar: cal(horizon), articles: [] } });
    expect(withForecast).toEqual(without);
    expect(rowFor(without, "o").demandForecast).toBe(0);
  });

  it("a manufactured prognosstyrd article cascades its forecast proposals to the components as derived demand", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "p", type: "manufactured", forecastControlled: true }), art({ articleId: "c" })],
        bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 2 }],
        forecast: { calendar: cal(["2030-03"]), articles: [fc({ articleId: "p", average: 100 })] },
      })
    );
    const p = rowFor(rows, "p");
    const c = rowFor(rows, "c");
    expect(p.demandForecast).toBe(100);
    expect(p.proposalKind).toBe("manufacture");
    expect(c.demandDerived).toBe(200);
    expect(c.demandForecast).toBe(0);
    expect(sum(c.proposals)).toBe(200);
  });

  it("the parent's proposal cascade does not consume a prognosstyrd component's forecast (the overview cannot see it either)", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "p", type: "manufactured" }), art({ articleId: "c", forecastControlled: true })],
        bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 1 }],
        salesRows: [{ articleId: "p", orderStatus: "confirmed", quantityOrdered: 50, quantityDelivered: 0, expectedDeliveryDate: "2030-03-20" }],
        forecast: { calendar: cal(["2030-03"]), articles: [fc({ articleId: "c", average: 100 })] },
      })
    );
    const c = rowFor(rows, "c");
    expect(c.demandDerived).toBe(50);
    expect(c.demandForecast).toBe(100);
    expect(sum(c.proposals)).toBe(150);
  });

  it("the invariant with the artikelöversikt: closingBalance === projected − demandDerived, forecast on both sides", () => {
    const forecastArticle = fc({ articleId: "f", average: 100, own: months([["2030-04", 50]]), consumedThisMonth: 12 });
    const horizonCal = cal(["2030-03", "2030-04"]);
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "f", forecastControlled: true }), art({ articleId: "p", type: "manufactured" })],
        bomEdges: [{ parentArticleId: "p", componentArticleId: "f", quantity: 3 }],
        stock: [{ articleId: "f", quantity: 40 }],
        salesRows: [{ articleId: "f", orderStatus: "confirmed", quantityOrdered: 20, quantityDelivered: 5, expectedDeliveryDate: "2030-03-14" }],
        purchaseRows: [{ articleId: "f", orderStatus: "confirmed", quantityOrdered: 30, quantityReceived: 0 }],
        manufacturingOrders: [{ articleId: "p", status: "planned", quantity: 4, configured: false, startDate: "2030-04-10" }],
        moMaterialRows: [{ componentArticleId: "f", orderStatus: "released", quantityPlanned: 10, quantityConsumed: 2, needDate: "2030-03-25" }],
        forecast: { calendar: horizonCal, articles: [forecastArticle] },
      })
    );
    const mrp = rowFor(rows, "f");

    const overviewInput: ArticleOverviewInput = {
      article: { articleId: "f", articleNumber: "F", name: "F", type: "purchased", isPhantom: false, active: true, unitCode: "st", reorderPoint: null, orderQuantity: null, rounding: null, forecastControlled: true },
      onHand: 40,
      salesRows: [{ rowId: "r1", salesOrderId: "so1", orderNumber: "KO-1", orderStatus: "confirmed", customerName: "Kund", expectedDeliveryDate: "2030-03-14", quantityOrdered: 20, quantityDelivered: 5 }],
      purchaseRows: [{ rowId: "p1", purchaseOrderId: "po1", orderNumber: "IO-1", orderStatus: "confirmed", supplierName: "Lev", expectedDeliveryDate: "2030-03-20", quantityOrdered: 30, quantityReceived: 0 }],
      manufacturingOrders: [],
      materialRows: [{ rowId: "m1", moId: "mo1", orderNumber: "TO-1", orderStatus: "released", dueDate: "2030-03-28", needDate: "2030-03-25", parentArticleId: "p", parentArticleNumber: "P", parentArticleName: "P", quantityPlanned: 10, quantityConsumed: 2 }],
      plannedMos: [{ moId: "mo2", orderNumber: "TO-2", dueDate: "2030-04-15", needDate: "2030-04-10", parentArticleId: "p", parentArticleNumber: "P", parentArticleName: "P", quantity: 4 }],
      bomEdges: [{ parentArticleId: "p", componentArticleId: "f", quantity: 3 }],
      phantomIds: [],
      primarySupplier: null,
      forecast: { input: forecastArticle, calendar: horizonCal },
    };
    const overview = buildArticleOverview(overviewInput);

    // March: forecast 100 − orders (15 + 8) − consumed 12 = 65; April: own 50 − planned 12 = 38.
    const forecastRows = overview.rows.filter((r) => r.kind === "forecast");
    expect(sum(forecastRows.map((r) => ({ quantity: -r.quantity })))).toBe(103);
    expect(mrp.demandForecast).toBe(103);
    expect(overview.closingBalance).toBe(mrp.projected - mrp.demandDerived);
    expect(forecastRows[0]).toMatchObject({
      id: "fc:2030-03:2030-03-04",
      kind: "forecast",
      direction: "demand",
      date: "2030-03-04",
      documentType: null,
      documentId: null,
      documentNumber: "Prognos 2030-03 · v.10",
      status: "forecast",
      partner: null,
      quantity: -16.25,
    });
    // Same day as a real demand: the forecast row sorts after it.
    const march25 = overview.rows.filter((r) => r.date === "2030-03-25").map((r) => r.kind);
    expect(march25).toEqual(["mo_material", "forecast"]);
    // Without the forecast input the rows are exactly the old ones.
    expect(buildArticleOverview({ ...overviewInput, forecast: undefined }).rows.every((r) => r.kind !== "forecast")).toBe(true);
    expect(firmDemandsOf(overview.rows)).toEqual([
      { date: "2030-03-14", quantity: 15 },
      { date: "2030-03-25", quantity: 8 },
      { date: "2030-04-10", quantity: 12 },
    ]);
  });
});

// --- Not a firm demand --------------------------------------------------------

function forecastRow(date: string, quantity: number): ArticleOverviewRow {
  return {
    id: `fc:${date.slice(0, 7)}:${date}`,
    kind: "forecast",
    direction: "demand",
    date,
    documentType: null,
    documentId: null,
    documentNumber: `Prognos ${date.slice(0, 7)} · v.10`,
    status: "forecast",
    partner: null,
    quantity: -quantity,
    balance: 0,
    isDraft: false,
  };
}

function salesRow(date: string, quantity: number): ArticleOverviewRow {
  return {
    id: `so:${date}`,
    kind: "sales_order",
    direction: "demand",
    date,
    documentType: "sales_order",
    documentId: "so-1",
    documentNumber: "KO-1",
    status: "confirmed",
    partner: "Kund",
    quantity: -quantity,
    balance: 0,
    isDraft: false,
  };
}

const overviewOf = (onHand: number, rows: ArticleOverviewRow[]) => ({
  article: { articleId: "f", articleNumber: "F", name: "F", type: "purchased" as const, isPhantom: false, active: true, unitCode: "st", reorderPoint: null, orderQuantity: null, rounding: null },
  primarySupplier: null,
  onHand,
  blockedOnHand: 0,
  rows,
  closingBalance: 0,
});

describe("forecast rows are not firm demand", () => {
  it("isFirmOverviewRow says no only to forecast rows", () => {
    expect(isFirmOverviewRow(forecastRow("2030-03-04", 1))).toBe(false);
    expect(isFirmOverviewRow(salesRow("2030-03-04", 1))).toBe(true);
    expect(isFirmOverviewRow({ kind: "purchase_order" })).toBe(true);
  });

  it("pegOverview allocates nothing to a forecast row — the stock stays for the firm demand after it", () => {
    const pegging = pegOverview(overviewOf(10, [forecastRow("2030-03-04", 10), salesRow("2030-03-20", 10)]), { today: TODAY, readyDates: new Map() });
    expect(pegging.demands.map((d) => d.id)).toEqual(["so:2030-03-20"]);
    expect(pegging.demands[0]).toMatchObject({ uncovered: 0, allocations: [{ supplyId: "stock", quantity: 10 }] });
    expect(pegging.supplies[0]!.surplus).toBe(0);
  });

  it("findFirmDemand never dates a TO from a forecast row", () => {
    expect(findFirmDemand(overviewOf(0, [forecastRow("2030-03-04", 10)]), { today: TODAY })).toBeNull();
    const demand = findFirmDemand(overviewOf(0, [forecastRow("2030-03-04", 10), salesRow("2030-03-20", 5)]), { today: TODAY });
    expect(demand).toMatchObject({ date: "2030-03-20", source: "shortage", documentNumber: "KO-1" });
  });

  it("Leveranstidskontrollen's pool ignores forecast rows — the checked row ships from stock today", () => {
    const input: DeliveryTimeCheckInput = {
      today: TODAY,
      offDays: new Set(),
      articles: new Map([["f", { articleId: "f", articleNumber: "F", name: "F", type: "purchased", rounding: null }]]),
      overviews: new Map([["f", { onHand: 10, rows: [forecastRow("2030-03-04", 10)] }]]),
      excludeSalesOrderId: null,
      bomEdges: [],
      phantomIds: new Set(),
      routings: new Map(),
      workCenters: new Map(),
      schedule: { weekScheduleDays: [], daySchedules: [], holidays: [] },
      existingOperations: [],
      suppliers: new Map(),
      customer: null,
      rows: [{ key: "r", articleId: "f", quantity: 10 }],
    };
    const result = checkDeliveryTime(input);
    expect(result).toMatchObject({ shipDate: TODAY, deliveryDate: TODAY });
    expect(result.rows[0]!.chain).toEqual([{ kind: "stock", articleNumber: "F", quantity: 10, date: TODAY }]);
    // The same stock with a firm demand instead is taken first.
    const firm = checkDeliveryTime({ ...input, overviews: new Map([["f", { onHand: 10, rows: [salesRow("2030-03-04", 10)] }]]) });
    expect(firm.rows[0]!.chain.some((s) => s.kind === "stock")).toBe(false);
  });
});
