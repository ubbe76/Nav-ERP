import { describe, expect, it } from "vitest";
import {
  buildArticleOverview,
  compareOverviewRows,
  type ArticleOverviewInput,
  type ArticleOverviewRow,
} from "../src/modules/planning/service/article-overview.js";
import { computeRequirements, type RequirementsInput } from "../src/modules/planning/service/requirements-calc.js";

// Pure tests — no database. The builder owns every rule for the
// artikelöversikt (which rows appear, their sign, the date order and the
// running balance), so this file is its spec. The last case ties it to the
// behovsberäkning: both read the same rows, so they must agree.

function overviewInput(partial: Partial<ArticleOverviewInput>): ArticleOverviewInput {
  return {
    article: {
      articleId: "c",
      articleNumber: "C",
      name: "Artikel c",
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

function salesRow(
  overrides: Partial<ArticleOverviewInput["salesRows"][number]> & { rowId: string }
): ArticleOverviewInput["salesRows"][number] {
  return {
    salesOrderId: `so-${overrides.rowId}`,
    orderNumber: `KO-${overrides.rowId}`,
    orderStatus: "confirmed",
    customerName: "Kund AB",
    expectedDeliveryDate: null,
    quantityOrdered: 1,
    quantityDelivered: 0,
    ...overrides,
  };
}

function purchaseRow(
  overrides: Partial<ArticleOverviewInput["purchaseRows"][number]> & { rowId: string }
): ArticleOverviewInput["purchaseRows"][number] {
  return {
    purchaseOrderId: `po-${overrides.rowId}`,
    orderNumber: `IO-${overrides.rowId}`,
    orderStatus: "confirmed",
    supplierName: "Leverantör AB",
    expectedDeliveryDate: null,
    quantityOrdered: 1,
    quantityReceived: 0,
    ...overrides,
  };
}

function summary(rows: ArticleOverviewRow[]) {
  return rows.map((r) => [r.kind, r.date, r.quantity, r.balance] as const);
}

describe("row order", () => {
  it("sorts by date ascending with undated rows last and a deterministic tie-break", () => {
    const { rows } = buildArticleOverview(
      overviewInput({
        salesRows: [
          salesRow({ rowId: "s2", expectedDeliveryDate: "2026-09-20", orderNumber: "KO-2" }),
          salesRow({ rowId: "s1", expectedDeliveryDate: "2026-09-20", orderNumber: "KO-1" }),
          salesRow({ rowId: "s0", expectedDeliveryDate: null }),
        ],
        purchaseRows: [
          purchaseRow({ rowId: "p1", expectedDeliveryDate: "2026-09-20" }),
          purchaseRow({ rowId: "p0", expectedDeliveryDate: "2026-09-10" }),
        ],
      })
    );
    expect(rows.map((r) => [r.kind, r.date, r.documentNumber])).toEqual([
      ["purchase_order", "2026-09-10", "IO-p0"],
      // Same date: supply before demand, then document number.
      ["purchase_order", "2026-09-20", "IO-p1"],
      ["sales_order", "2026-09-20", "KO-1"],
      ["sales_order", "2026-09-20", "KO-2"],
      ["sales_order", null, "KO-s0"],
    ]);
  });

  it("compareOverviewRows falls back to the row id when everything else ties", () => {
    const base: ArticleOverviewRow = {
      id: "b",
      kind: "sales_order",
      direction: "demand",
      date: null,
      documentType: "sales_order",
      documentId: "x",
      documentNumber: "KO-1",
      status: "confirmed",
      partner: null,
      quantity: -1,
      balance: 0,
      isDraft: false,
    };
    expect(compareOverviewRows({ ...base, id: "a" }, base)).toBeLessThan(0);
    expect(compareOverviewRows(base, base)).toBe(0);
  });
});

describe("running balance", () => {
  it("starts from on-hand and accumulates signed quantities in date order", () => {
    const result = buildArticleOverview(
      overviewInput({
        onHand: 10,
        purchaseRows: [purchaseRow({ rowId: "p", expectedDeliveryDate: "2026-09-01", quantityOrdered: 5 })],
        salesRows: [
          salesRow({ rowId: "s1", expectedDeliveryDate: "2026-09-05", quantityOrdered: 4 }),
          salesRow({ rowId: "s2", expectedDeliveryDate: "2026-09-10", quantityOrdered: 8 }),
        ],
      })
    );
    expect(result.onHand).toBe(10);
    expect(summary(result.rows)).toEqual([
      ["purchase_order", "2026-09-01", 5, 15],
      ["sales_order", "2026-09-05", -4, 11],
      ["sales_order", "2026-09-10", -8, 3],
    ]);
    expect(result.closingBalance).toBe(3);
  });

  it("rounds away float noise in the running balance", () => {
    const result = buildArticleOverview(
      overviewInput({
        onHand: 0.1,
        purchaseRows: [purchaseRow({ rowId: "p", quantityOrdered: 0.2 })],
      })
    );
    expect(result.rows[0]!.balance).toBe(0.3);
    expect(result.closingBalance).toBe(0.3);
  });
});

describe("which rows count", () => {
  it("flags draft IOs but still counts them; excludes finished/cancelled IOs and quotes", () => {
    const { rows, closingBalance } = buildArticleOverview(
      overviewInput({
        purchaseRows: [
          purchaseRow({ rowId: "draft", orderStatus: "draft", quantityOrdered: 3 }),
          purchaseRow({ rowId: "part", orderStatus: "partially_received", quantityOrdered: 10, quantityReceived: 4 }),
          purchaseRow({ rowId: "recv", orderStatus: "received", quantityOrdered: 10, quantityReceived: 10 }),
          purchaseRow({ rowId: "canc", orderStatus: "cancelled", quantityOrdered: 10 }),
          purchaseRow({ rowId: "closed", orderStatus: "closed", quantityOrdered: 10 }),
        ],
        salesRows: [
          salesRow({ rowId: "quote", orderStatus: "quote", quantityOrdered: 100 }),
          salesRow({ rowId: "prod", orderStatus: "in_production", quantityOrdered: 2 }),
          salesRow({ rowId: "over", orderStatus: "confirmed", quantityOrdered: 5, quantityDelivered: 6 }),
          salesRow({ rowId: "done", orderStatus: "delivered", quantityOrdered: 5, quantityDelivered: 5 }),
        ],
      })
    );
    expect(rows.map((r) => [r.documentNumber, r.quantity, r.isDraft])).toEqual([
      ["IO-draft", 3, true],
      ["IO-part", 6, false],
      ["KO-prod", -2, false],
    ]);
    expect(closingBalance).toBe(7);
  });

  it("carries the document link, partner and status on each row", () => {
    const { rows } = buildArticleOverview(
      overviewInput({
        salesRows: [salesRow({ rowId: "s", salesOrderId: "so-uuid", customerName: "Bygg AB", expectedDeliveryDate: "2026-10-01", quantityOrdered: 4 })],
      })
    );
    expect(rows[0]).toMatchObject({
      kind: "sales_order",
      direction: "demand",
      documentType: "sales_order",
      documentId: "so-uuid",
      documentNumber: "KO-s",
      status: "confirmed",
      partner: "Bygg AB",
      date: "2026-10-01",
      quantity: -4,
    });
  });
});

describe("manufacturing orders", () => {
  it("lists the article's own open MOs as supply with the full quantity", () => {
    const { rows } = buildArticleOverview(
      overviewInput({
        article: {
          articleId: "p",
          articleNumber: "P",
          name: "Produkt",
          type: "manufactured",
          isPhantom: false,
          active: true,
          unitCode: "st",
          reorderPoint: null,
          orderQuantity: null,
      rounding: null,
        },
        manufacturingOrders: [
          { moId: "m1", orderNumber: "TO-1", status: "planned", dueDate: "2026-09-30", quantity: 5 },
          { moId: "m2", orderNumber: "TO-2", status: "released", dueDate: "2026-09-10", quantity: 2 },
          { moId: "m3", orderNumber: "TO-3", status: "in_progress", dueDate: null, quantity: 1 },
          { moId: "m4", orderNumber: "TO-4", status: "done", dueDate: "2026-09-01", quantity: 9 },
          { moId: "m5", orderNumber: "TO-5", status: "closed", dueDate: "2026-09-01", quantity: 9 },
          { moId: "m6", orderNumber: "TO-6", status: "cancelled", dueDate: "2026-09-01", quantity: 9 },
        ],
      })
    );
    expect(rows.map((r) => [r.kind, r.documentNumber, r.quantity, r.documentType, r.documentId])).toEqual([
      ["manufacturing_order", "TO-2", 2, "manufacturing_order", "m2"],
      ["manufacturing_order", "TO-1", 5, "manufacturing_order", "m1"],
      ["manufacturing_order", "TO-3", 1, "manufacturing_order", "m3"],
    ]);
    expect(rows.every((r) => r.direction === "supply")).toBe(true);
  });

  it("shows the unconsumed rest of released/in_progress material rows as demand, named after the parent", () => {
    const { rows } = buildArticleOverview(
      overviewInput({
        materialRows: [
          {
            rowId: "mat1",
            moId: "m1",
            orderNumber: "TO-1",
            orderStatus: "released",
            dueDate: "2026-09-15",
            parentArticleNumber: "P",
            parentArticleName: "Produkt",
            quantityPlanned: 4,
            quantityConsumed: 1,
          },
          {
            rowId: "mat2",
            moId: "m2",
            orderNumber: "TO-2",
            orderStatus: "in_progress",
            dueDate: null,
            parentArticleNumber: "P",
            parentArticleName: "Produkt",
            quantityPlanned: 2,
            quantityConsumed: 2,
          },
          {
            rowId: "mat3",
            moId: "m3",
            orderNumber: "TO-3",
            orderStatus: "done",
            dueDate: null,
            parentArticleNumber: "P",
            parentArticleName: "Produkt",
            quantityPlanned: 7,
            quantityConsumed: 0,
          },
        ],
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "mo_material",
      direction: "demand",
      date: "2026-09-15",
      documentType: "manufacturing_order",
      documentId: "m1",
      documentNumber: "TO-1",
      partner: "P — Produkt",
      quantity: -3,
    });
  });

  it("explodes planned MOs one level through phantoms, and only for parents that use the article", () => {
    const { rows } = buildArticleOverview(
      overviewInput({
        bomEdges: [
          { parentArticleId: "p", componentArticleId: "ph", quantity: 2 },
          { parentArticleId: "ph", componentArticleId: "c", quantity: 3 },
          { parentArticleId: "other", componentArticleId: "x", quantity: 1 },
        ],
        phantomIds: ["ph"],
        plannedMos: [
          {
            moId: "m1",
            orderNumber: "TO-1",
            dueDate: "2026-09-25",
            parentArticleId: "p",
            parentArticleNumber: "P",
            parentArticleName: "Produkt",
            quantity: 5,
          },
          {
            moId: "m2",
            orderNumber: "TO-2",
            dueDate: "2026-09-26",
            parentArticleId: "other",
            parentArticleNumber: "O",
            parentArticleName: "Annan",
            quantity: 5,
          },
        ],
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "mo_planned_material",
      direction: "demand",
      date: "2026-09-25",
      documentType: "manufacturing_order",
      documentId: "m1",
      documentNumber: "TO-1",
      partner: "P — Produkt",
      quantity: -30,
      status: "planned",
    });
  });

  it("never explodes a released MO — its demand comes from the material snapshot only", () => {
    const { rows } = buildArticleOverview(
      overviewInput({
        bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 2 }],
        // A released MO is not in plannedMos (the repository only loads
        // status = planned there); its snapshot row is the sole source.
        materialRows: [
          {
            rowId: "mat",
            moId: "m1",
            orderNumber: "TO-1",
            orderStatus: "released",
            dueDate: null,
            parentArticleNumber: "P",
            parentArticleName: "Produkt",
            quantityPlanned: 4,
            quantityConsumed: 0,
          },
        ],
      })
    );
    expect(summary(rows)).toEqual([["mo_material", null, -4, -4]]);
  });
});

describe("header", () => {
  it("passes the article and primary supplier through", () => {
    const result = buildArticleOverview(
      overviewInput({
        primarySupplier: { supplierId: "sup", supplierName: "Stål AB", leadTimeDays: 14 },
      })
    );
    expect(result.article).toMatchObject({ articleId: "c", articleNumber: "C", type: "purchased" });
    expect(result.primarySupplier).toEqual({ supplierId: "sup", supplierName: "Stål AB", leadTimeDays: 14 });
    expect(result.rows).toEqual([]);
    expect(result.closingBalance).toBe(0);
  });
});

describe("agreement with behovsberäkningen", () => {
  it("closes on the same balance as the MRP's projected (minus derived demand from proposals)", () => {
    // One fixture, two readers. c is a purchased component of p (×2); p has
    // a planned MO (exploded) and a released MO (snapshot row).
    const bomEdges = [{ parentArticleId: "p", componentArticleId: "c", quantity: 2 }];
    const mrpInput: RequirementsInput = {
      articles: [
        { articleId: "c", articleNumber: "C", name: "c", type: "purchased", isPhantom: false, active: true, unitCode: "st", groupId: null, reorderPoint: null, orderQuantity: null, rounding: null, configuratorMode: null },
        { articleId: "p", articleNumber: "P", name: "p", type: "manufactured", isPhantom: false, active: true, unitCode: "st", groupId: null, reorderPoint: null, orderQuantity: null, rounding: null, configuratorMode: null },
      ],
      salesRows: [{ articleId: "c", orderStatus: "confirmed", quantityOrdered: 4, quantityDelivered: 0 }],
      purchaseRows: [
        { articleId: "c", orderStatus: "confirmed", quantityOrdered: 5, quantityReceived: 0 },
        { articleId: "c", orderStatus: "draft", quantityOrdered: 3, quantityReceived: 0 },
      ],
      manufacturingOrders: [
        { articleId: "p", status: "planned", quantity: 3, configured: false },
        { articleId: "p", status: "released", quantity: 2, configured: false },
      ],
      moMaterialRows: [{ componentArticleId: "c", orderStatus: "released", quantityPlanned: 4, quantityConsumed: 0 }],
      stock: [{ articleId: "c", quantity: 10 }],
      bomEdges,
      primarySuppliers: [],
      legoOperationRows: [],
      configuredRows: [],
      configuredCascade: new Map(),
    };
    const mrpRow = computeRequirements(mrpInput).find((r) => r.articleId === "c")!;

    const overview = buildArticleOverview(
      overviewInput({
        onHand: 10,
        salesRows: [salesRow({ rowId: "s", quantityOrdered: 4, expectedDeliveryDate: "2026-10-01" })],
        purchaseRows: [
          purchaseRow({ rowId: "p1", quantityOrdered: 5, expectedDeliveryDate: "2026-09-20" }),
          purchaseRow({ rowId: "p2", orderStatus: "draft", quantityOrdered: 3 }),
        ],
        materialRows: [
          {
            rowId: "mat",
            moId: "m2",
            orderNumber: "TO-2",
            orderStatus: "released",
            dueDate: "2026-09-15",
            parentArticleNumber: "P",
            parentArticleName: "p",
            quantityPlanned: 4,
            quantityConsumed: 0,
          },
        ],
        plannedMos: [
          { moId: "m1", orderNumber: "TO-1", dueDate: "2026-09-25", parentArticleId: "p", parentArticleNumber: "P", parentArticleName: "p", quantity: 3 },
        ],
        bomEdges,
      })
    );

    expect(mrpRow.projected).toBe(4);
    expect(overview.closingBalance).toBe(mrpRow.projected - mrpRow.demandDerived);
    expect(summary(overview.rows)).toEqual([
      ["mo_material", "2026-09-15", -4, 6],
      ["purchase_order", "2026-09-20", 5, 11],
      ["mo_planned_material", "2026-09-25", -6, 5],
      ["sales_order", "2026-10-01", -4, 1],
      ["purchase_order", null, 3, 4],
    ]);
  });
});
