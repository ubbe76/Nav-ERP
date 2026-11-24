import { describe, expect, it } from "vitest";
import {
  buildArticleOverview,
  firmClosingBalance,
  isFirmOverviewRow,
  proposalLabel,
  type ArticleOverviewInput,
} from "../src/modules/planning/service/article-overview.js";
import {
  computeRequirements,
  computeRequirementsDetailed,
  type RequirementsArticle,
  type RequirementsInput,
} from "../src/modules/planning/service/requirements-calc.js";
import type { ArticleForecastInput, ForecastCalendar } from "../src/modules/planning/service/forecast.js";

// Pure tests — no database. The artikelöversikt's PLANNED view (user's goal
// 2026-11-24: "en bättre överblick på behovet man beställer eller skapar
// tillverkning mot"): the behovsberäkning records where every derived demand
// comes from (computeRequirementsDetailed), and the overview shows it per
// proposal plus the article's own proposals — ending on the calc's projected
// plus its proposals.

// Monday 2030-03-04, week 10.
const TODAY = "2030-03-04";
const NONE: ReadonlySet<string> = new Set();

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

function overviewOf(articleId: string, partial: Partial<ArticleOverviewInput>): ArticleOverviewInput {
  return {
    article: {
      articleId,
      articleNumber: articleId.toUpperCase(),
      name: `Artikel ${articleId}`,
      type: "purchased",
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
  };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

describe("computeRequirementsDetailed records where the derived demand comes from", () => {
  it("one entry per parent proposal, dated with its latest start and naming the proposal; Σ = demandDerived", () => {
    // p (manufactured, lead time 2) needs 3 c each. Two KO weeks ⇒ two
    // proposals ⇒ two derived demands on c, one per proposal.
    const input = calcInput({
      articles: [art({ articleId: "p", type: "manufactured" }), art({ articleId: "c" })],
      bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 3 }],
      salesRows: [
        { articleId: "p", orderStatus: "confirmed", quantityOrdered: 2, quantityDelivered: 0, expectedDeliveryDate: "2030-03-13" },
        { articleId: "p", orderStatus: "confirmed", quantityOrdered: 4, quantityDelivered: 0, expectedDeliveryDate: "2030-03-27" },
      ],
      leadDaysFor: () => 2,
    });
    const { rows, derivedByArticle } = computeRequirementsDetailed(input);
    // The rows are computeRequirements' rows — nothing else changed.
    expect(rows).toEqual(computeRequirements(input));
    const parent = rows.find((r) => r.articleId === "p")!;
    expect(parent.proposals.map((p) => [p.key, p.quantity, p.latestDate])).toEqual([
      ["manufacture:p:2030-03-11", 2, "2030-03-08"],
      ["manufacture:p:2030-03-25", 4, "2030-03-22"],
    ]);
    expect(derivedByArticle.get("c")).toEqual([
      {
        date: "2030-03-08",
        quantity: 6,
        source: { proposalKey: "manufacture:p:2030-03-11", proposalQuantity: 2, needWeek: "2030-03-11", articleId: "p", articleNumber: "P", articleName: "Artikel p" },
      },
      {
        date: "2030-03-22",
        quantity: 12,
        source: { proposalKey: "manufacture:p:2030-03-25", proposalQuantity: 4, needWeek: "2030-03-25", articleId: "p", articleNumber: "P", articleName: "Artikel p" },
      },
    ]);
    expect(rows.find((r) => r.articleId === "c")!.demandDerived).toBe(18);
    // Nothing is derived TO the finished product.
    expect(derivedByArticle.has("p")).toBe(false);
  });

  it("a configured row's material names the KO row and its template; the undated cascade has no source", () => {
    const { derivedByArticle } = computeRequirementsDetailed(
      calcInput({
        articles: [art({ articleId: "t", type: "manufactured", configuratorMode: "to_order" }), art({ articleId: "c" })],
        configuredRows: [
          {
            salesOrderRowId: "row1",
            salesOrderId: "so1",
            orderNumber: "KO-5003",
            customerName: "Kund AB",
            templateArticleId: "t",
            templateActive: true,
            expectedDeliveryDate: "2030-03-20",
            summary: "Lås B",
            uncoveredQuantity: 2,
            error: null,
          },
        ],
        derivedDemands: [{ articleId: "c", quantity: 5, needDate: "2030-03-15", salesOrderRowId: "row1" }],
        configuredCascade: new Map([["c", 1]]),
      })
    );
    expect(derivedByArticle.get("c")).toEqual([
      { date: null, quantity: 1, source: null },
      {
        date: "2030-03-15",
        quantity: 5,
        source: {
          proposalKey: "configured:row1",
          proposalQuantity: 2,
          needWeek: "2030-03-18",
          articleId: "t",
          articleNumber: "T",
          articleName: "Artikel t",
          salesOrderId: "so1",
          salesOrderNumber: "KO-5003",
          customerName: "Kund AB",
        },
      },
    ]);
  });
});

describe("the planned view of the artikelöversikt", () => {
  it("adds the proposals as supply and one derived row per proposal, labelled with the need week; neither is firm", () => {
    const overview = buildArticleOverview(
      overviewOf("c", {
        onHand: 4,
        planned: {
          computedAt: "2030-03-04T08:00:00.000Z",
          supplierName: "Leverantör AB",
          proposals: [
            { key: "purchase:c:2030-03-04", needDate: "2030-03-08", needWeek: "2030-03-04", latestDate: "2030-03-01", late: true, quantity: 10, reason: "demand" },
            { key: "purchase:c:undated", needDate: null, needWeek: null, latestDate: null, late: false, quantity: 2, reason: "undated" },
          ],
          derived: [
            { date: "2030-03-08", quantity: 6, source: { proposalKey: "manufacture:p:2030-03-11", proposalQuantity: 2, needWeek: "2030-03-11", articleId: "p", articleNumber: "P", articleName: "Produkt" } },
            // A configured row's material listing c twice: one row, summed.
            { date: "2030-03-15", quantity: 1.5, source: { proposalKey: "configured:row1", proposalQuantity: 1, needWeek: "2030-03-18", articleId: "t", articleNumber: "T", articleName: "Diskbänk", salesOrderId: "so1", salesOrderNumber: "KO-5003", customerName: "Kund AB" } },
            { date: "2030-03-15", quantity: 0.5, source: { proposalKey: "configured:row1", proposalQuantity: 1, needWeek: "2030-03-18", articleId: "t", articleNumber: "T", articleName: "Diskbänk", salesOrderId: "so1", salesOrderNumber: "KO-5003", customerName: "Kund AB" } },
            { date: null, quantity: 2, source: null },
          ],
        },
      })
    );
    expect(overview.planned).toEqual({ computedAt: "2030-03-04T08:00:00.000Z" });
    expect(overview.rows.map((r) => [r.kind, r.date, r.documentNumber, r.partner, r.quantity, r.balance])).toEqual([
      // Same day: the proposal (supply) before the demand it is there for.
      ["proposal", "2030-03-08", "Förslag v.10", "Leverantör AB", 10, 14],
      ["derived_demand", "2030-03-08", "Förslag v.11", "P — Produkt", -6, 8],
      ["derived_demand", "2030-03-15", "KO-5003", "T — Diskbänk", -2, 6],
      ["proposal", null, "Förslag", "Leverantör AB", 2, 8],
      ["derived_demand", null, "Förslag", null, -2, 6],
    ]);
    const [proposal, fromParent, fromKo, , cascade] = overview.rows;
    expect(proposal).toMatchObject({
      id: "prop:purchase:c:2030-03-04",
      direction: "supply",
      documentType: null,
      status: "proposal",
      proposal: { key: "purchase:c:2030-03-04", reason: "demand", latestDate: "2030-03-01", late: true },
    });
    expect(fromParent).toMatchObject({
      id: "drv:manufacture:p:2030-03-11",
      documentType: null,
      documentId: null,
      parentArticleId: "p",
      sourceProposal: { key: "manufacture:p:2030-03-11", quantity: 2 },
    });
    expect(fromKo).toMatchObject({ documentType: "sales_order", documentId: "so1", parentArticleId: "t", sourceProposal: { key: "configured:row1", quantity: 1 } });
    expect(cascade).not.toHaveProperty("sourceProposal");
    expect(overview.rows.some(isFirmOverviewRow)).toBe(false);
    // The firm balance ignores the planned rows.
    expect(firmClosingBalance(overview)).toBe(4);
    expect(overview.closingBalance).toBe(6);
  });

  it("without `planned` the overview is the firm one (no planned field, no planned rows)", () => {
    const overview = buildArticleOverview(overviewOf("c", { onHand: 1 }));
    expect(overview).not.toHaveProperty("planned");
    expect(overview.rows).toEqual([]);
  });

  it("labels the need week by its ISO week number", () => {
    expect(proposalLabel("2030-12-30")).toBe("Förslag v.1");
    expect(proposalLabel("2030-03-04")).toBe("Förslag v.10");
    expect(proposalLabel(null)).toBe("Förslag");
  });

  it("ends on the behovsberäkning's projected + proposals — the derived demand consumes the forecast as in the calc", () => {
    // f is prognosstyrd with Säkerhetslager, beställningspunkt and an order
    // quantity; p is its parent (×3) with a KO in April and a planned TO.
    const forecastArticle: ArticleForecastInput = { articleId: "f", average: 100, own: new Map([["2030-04", 50]]), consumedThisMonth: 12 };
    const calendar: ForecastCalendar = { today: TODAY, offDays: NONE, horizon: ["2030-03", "2030-04"] };
    const bomEdges = [{ parentArticleId: "p", componentArticleId: "f", quantity: 3 }];
    const { rows, derivedByArticle } = computeRequirementsDetailed(
      calcInput({
        articles: [
          art({ articleId: "f", forecastControlled: true, safetyStock: 5, reorderPoint: 20, orderQuantity: 25 }),
          art({ articleId: "p", type: "manufactured" }),
        ],
        bomEdges,
        stock: [{ articleId: "f", quantity: 40 }],
        salesRows: [
          { articleId: "f", orderStatus: "confirmed", quantityOrdered: 20, quantityDelivered: 5, expectedDeliveryDate: "2030-03-14" },
          { articleId: "p", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0, expectedDeliveryDate: "2030-04-20" },
        ],
        purchaseRows: [{ articleId: "f", orderStatus: "confirmed", quantityOrdered: 30, quantityReceived: 0 }],
        manufacturingOrders: [{ articleId: "p", status: "planned", quantity: 4, configured: false, startDate: "2030-04-10" }],
        moMaterialRows: [{ componentArticleId: "f", orderStatus: "released", quantityPlanned: 10, quantityConsumed: 2, needDate: "2030-03-25" }],
        forecast: { calendar, articles: [forecastArticle] },
        leadDaysFor: () => 1,
      })
    );
    const mrp = rows.find((r) => r.articleId === "f")!;
    expect(mrp.demandDerived).toBe(18);
    expect(mrp.proposals.length).toBeGreaterThan(1);

    const overview = buildArticleOverview(
      overviewOf("f", {
        article: {
          articleId: "f",
          articleNumber: "F",
          name: "F",
          type: "purchased",
          isPhantom: false,
          active: true,
          unitCode: "st",
          reorderPoint: 20,
          safetyStock: 5,
          orderQuantity: 25,
          rounding: null,
          forecastControlled: true,
        },
        onHand: 40,
        salesRows: [{ rowId: "r1", salesOrderId: "so1", orderNumber: "KO-1", orderStatus: "confirmed", customerName: "Kund", expectedDeliveryDate: "2030-03-14", quantityOrdered: 20, quantityDelivered: 5 }],
        purchaseRows: [{ rowId: "p1", purchaseOrderId: "po1", orderNumber: "IO-1", orderStatus: "confirmed", supplierName: "Lev", expectedDeliveryDate: "2030-03-20", quantityOrdered: 30, quantityReceived: 0 }],
        materialRows: [{ rowId: "m1", moId: "mo1", orderNumber: "TO-1", orderStatus: "released", dueDate: "2030-03-28", needDate: "2030-03-25", parentArticleId: "p", parentArticleNumber: "P", parentArticleName: "P", quantityPlanned: 10, quantityConsumed: 2 }],
        plannedMos: [{ moId: "mo2", orderNumber: "TO-2", dueDate: "2030-04-15", needDate: "2030-04-10", parentArticleId: "p", parentArticleNumber: "P", parentArticleName: "P", quantity: 4 }],
        bomEdges,
        forecast: { input: forecastArticle, calendar },
        planned: { computedAt: "2030-03-04T08:00:00.000Z", derived: derivedByArticle.get("f") ?? [], proposals: mrp.proposals, supplierName: null },
      })
    );
    const forecast = round4(overview.rows.filter((r) => r.kind === "forecast").reduce((s, r) => s - r.quantity, 0));
    expect(forecast).toBe(mrp.demandForecast);
    expect(overview.closingBalance).toBe(round4(mrp.projected + mrp.proposalQuantity));
    // The derived demand as ONE row for the parent's proposal, dated with its latest start.
    const derived = overview.rows.filter((r) => r.kind === "derived_demand");
    expect(derived.map((r) => [r.quantity, r.parentArticleId])).toEqual([[-18, "p"]]);
    expect(overview.rows.filter((r) => r.kind === "proposal")).toHaveLength(mrp.proposals.length);
  });
});
