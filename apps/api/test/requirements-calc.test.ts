import { describe, expect, it } from "vitest";
import {
  computeLowLevelCodes,
  computeRequirements,
  explodeOneLevel,
  type ConfiguredRowNeed,
  type RequirementsArticle,
  type RequirementsInput,
  type RequirementRow,
} from "../src/modules/planning/service/requirements-calc.js";

// Pure calculation tests — no database, no TRUNCATE. The calc owns every
// business rule (status filtering, netting, reorder point, cascade), so this
// file is the authoritative spec for behovsberäkningen.

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
    ...partial,
  };
}

function rowFor(rows: RequirementRow[], articleId: string): RequirementRow {
  const row = rows.find((r) => r.articleId === articleId);
  if (!row) throw new Error(`no result row for ${articleId}`);
  return row;
}

describe("sales demand", () => {
  it("counts the undelivered rest on confirmed and in_production orders", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        salesRows: [
          { articleId: "a", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 3 },
          { articleId: "a", orderStatus: "in_production", quantityOrdered: 5, quantityDelivered: 0 },
        ],
      })
    );
    expect(rowFor(rows, "a").demandSales).toBe(12);
    expect(rowFor(rows, "a").projected).toBe(-12);
  });

  it("ignores quote, delivered, invoiced and cancelled orders", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        salesRows: [
          { articleId: "a", orderStatus: "quote", quantityOrdered: 100, quantityDelivered: 0 },
          { articleId: "a", orderStatus: "delivered", quantityOrdered: 7, quantityDelivered: 7 },
          { articleId: "a", orderStatus: "invoiced", quantityOrdered: 7, quantityDelivered: 7 },
          { articleId: "a", orderStatus: "cancelled", quantityOrdered: 9, quantityDelivered: 0 },
        ],
      })
    );
    expect(rows).toHaveLength(0); // no demand at all -> article not in the result
  });

  it("clamps an over-delivered row to zero instead of negative demand", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        salesRows: [
          { articleId: "a", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 12 },
          { articleId: "a", orderStatus: "confirmed", quantityOrdered: 4, quantityDelivered: 0 },
        ],
      })
    );
    expect(rowFor(rows, "a").demandSales).toBe(4);
  });
});

describe("purchase supply", () => {
  it("counts the unreceived rest on confirmed and partially_received orders", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        purchaseRows: [
          { articleId: "a", orderStatus: "confirmed", quantityOrdered: 10, quantityReceived: 4 },
          { articleId: "a", orderStatus: "partially_received", quantityOrdered: 8, quantityReceived: 5 },
        ],
      })
    );
    expect(rowFor(rows, "a").supplyPo).toBe(9);
    expect(rowFor(rows, "a").projected).toBe(9);
  });

  it("counts draft orders separately — created proposals must not be re-proposed", () => {
    // A draft IO is this system's counterpart of a released orderförslag: the
    // planner has acted on it but not yet sent it. Excluding it would make
    // every re-run of the calculation propose the same material again
    // (double-ordering), and planned TOs — the same commitment level —
    // already count as supply. Kept in its own bucket so the UI can show it.
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        purchaseRows: [{ articleId: "a", orderStatus: "draft", quantityOrdered: 50, quantityReceived: 0 }],
      })
    );
    expect(rowFor(rows, "a").supplyPo).toBe(0);
    expect(rowFor(rows, "a").supplyPoDraft).toBe(50);
    expect(rowFor(rows, "a").projected).toBe(50);
  });

  it("ignores received, closed and cancelled orders", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        purchaseRows: [
          { articleId: "a", orderStatus: "received", quantityOrdered: 10, quantityReceived: 10 },
          { articleId: "a", orderStatus: "closed", quantityOrdered: 10, quantityReceived: 2 },
          { articleId: "a", orderStatus: "cancelled", quantityOrdered: 10, quantityReceived: 0 },
        ],
      })
    );
    expect(rows).toHaveLength(0);
  });
});

describe("manufacturing order supply", () => {
  it("counts the full quantity for planned, released and in_progress orders", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", type: "manufactured" })],
        manufacturingOrders: [
          { articleId: "a", status: "planned", quantity: 3, configured: false },
          { articleId: "a", status: "released", quantity: 4, configured: false },
          { articleId: "a", status: "in_progress", quantity: 5, configured: false },
        ],
      })
    );
    expect(rowFor(rows, "a").supplyMo).toBe(12);
  });

  it("ignores done, closed and cancelled orders", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", type: "manufactured" })],
        manufacturingOrders: [
          { articleId: "a", status: "done", quantity: 3, configured: false },
          { articleId: "a", status: "closed", quantity: 4, configured: false },
          { articleId: "a", status: "cancelled", quantity: 5, configured: false },
        ],
      })
    );
    expect(rows).toHaveLength(0);
  });
});

describe("manufacturing material demand", () => {
  it("counts planned minus consumed on released/in_progress orders, clamped at zero", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "c" })],
        moMaterialRows: [
          { componentArticleId: "c", orderStatus: "released", quantityPlanned: 10, quantityConsumed: 4 },
          { componentArticleId: "c", orderStatus: "in_progress", quantityPlanned: 5, quantityConsumed: 7 },
        ],
      })
    );
    expect(rowFor(rows, "c").demandMo).toBe(6);
  });

  it("ignores material rows on done/closed/cancelled orders", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "c" })],
        moMaterialRows: [
          { componentArticleId: "c", orderStatus: "done", quantityPlanned: 10, quantityConsumed: 0 },
          { componentArticleId: "c", orderStatus: "cancelled", quantityPlanned: 10, quantityConsumed: 0 },
          { componentArticleId: "c", orderStatus: "closed", quantityPlanned: 10, quantityConsumed: 0 },
        ],
      })
    );
    expect(rows).toHaveLength(0);
  });

  it("explodes planned MOs one level through phantoms — parity with explodeBom semantics", () => {
    // p (manufactured) -> phantom ph x2 -> c x3  =>  5 st p needs 30 st c.
    // A planned MO has no mo_material_consumptions rows yet, so its component
    // demand must come from an in-memory explosion of the BOM.
    const rows = computeRequirements(
      calcInput({
        articles: [
          art({ articleId: "p", type: "manufactured" }),
          art({ articleId: "ph", type: "manufactured", isPhantom: true }),
          art({ articleId: "c" }),
        ],
        manufacturingOrders: [{ articleId: "p", status: "planned", quantity: 5, configured: false }],
        bomEdges: [
          { parentArticleId: "p", componentArticleId: "ph", quantity: 2 },
          { parentArticleId: "ph", componentArticleId: "c", quantity: 3 },
        ],
      })
    );
    expect(rowFor(rows, "c").demandMo).toBe(30);
    // The planned MO itself is supply for p, not demand:
    expect(rowFor(rows, "p").supplyMo).toBe(5);
    expect(rowFor(rows, "p").demandMo).toBe(0);
  });

  it("does not explode released MOs — their material rows are the snapshot", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "p", type: "manufactured" }), art({ articleId: "c" })],
        manufacturingOrders: [{ articleId: "p", status: "released", quantity: 5, configured: false }],
        moMaterialRows: [
          { componentArticleId: "c", orderStatus: "released", quantityPlanned: 10, quantityConsumed: 0 },
        ],
        bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 2 }],
      })
    );
    expect(rowFor(rows, "c").demandMo).toBe(10); // from the snapshot, not 10 + explosion
  });
});

describe("projected balance", () => {
  it("is onHand − demand + supply, with negative onHand passed through honestly", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        stock: [{ articleId: "a", quantity: -5 }],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 }],
        purchaseRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 20, quantityReceived: 0 }],
      })
    );
    const row = rowFor(rows, "a");
    expect(row.onHand).toBe(-5);
    expect(row.projected).toBe(5);
    expect(row.proposalQuantity).toBe(0);
  });
});

describe("reorder point", () => {
  it("proposes up to the reorder point when projected falls below it", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", reorderPoint: 10 })],
        stock: [{ articleId: "a", quantity: 3 }],
      })
    );
    const row = rowFor(rows, "a");
    expect(row.proposalQuantity).toBe(7);
    expect(row.proposalKind).toBe("purchase");
  });

  it("does not propose when projected is exactly at the reorder point", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", reorderPoint: 10 })],
        stock: [{ articleId: "a", quantity: 10 }],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(0);
    expect(rowFor(rows, "a").proposalKind).toBeNull();
  });

  it("without a reorder point, triggers only when projected goes negative", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" }), art({ articleId: "b" })],
        stock: [{ articleId: "a", quantity: 2 }],
        salesRows: [
          { articleId: "a", orderStatus: "confirmed", quantityOrdered: 2, quantityDelivered: 0 },
          { articleId: "b", orderStatus: "confirmed", quantityOrdered: 4, quantityDelivered: 0 },
        ],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(0); // projected 0 — covered
    expect(rowFor(rows, "b").proposalQuantity).toBe(4); // projected −4
  });
});

describe("order quantity rounding", () => {
  it("rounds the proposal up to the nearest multiple", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", orderQuantity: 5 })],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 7, quantityDelivered: 0 }],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(10);
  });

  it("does not over-round an exact multiple", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", orderQuantity: 5 })],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 }],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(10);
  });

  it("guards against float noise pushing the quotient to the next multiple", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE754; without an epsilon round the
    // quotient 1.0000000000000002 would ceil to 2 multiples.
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", orderQuantity: 0.3 })],
        salesRows: [
          { articleId: "a", orderStatus: "confirmed", quantityOrdered: 0.1, quantityDelivered: 0 },
          { articleId: "a", orderStatus: "confirmed", quantityOrdered: 0.2, quantityDelivered: 0 },
        ],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBeCloseTo(0.3, 9);
  });

  it("acts as a minimum order quantity for small shortages", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", orderQuantity: 50 })],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 1, quantityDelivered: 0 }],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(50);
  });
});

// articles.rounding (Avrundning): applied LAST, after the order-quantity
// multiple — 100 kg in 7.38 kg bars is 14 bars, not 100 kg.
describe("rounding (avrundning)", () => {
  it("rounds the proposal up to the nearest multiple of the rounding step", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", rounding: 5 })],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 12, quantityDelivered: 0 }],
      })
    );
    const row = rowFor(rows, "a");
    expect(row.proposalQuantity).toBe(15);
    expect(row.rounding).toBe(5);
  });

  it("applies the order quantity first and the rounding step last", () => {
    // raw 3 → order quantity 7 (min + multiple) → rounded up to 10.
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", orderQuantity: 7, rounding: 5 })],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 3, quantityDelivered: 0 }],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(10);
  });

  it("supports fractional steps", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", orderQuantity: 100, rounding: 7.38 })],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 1, quantityDelivered: 0 }],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(103.32);
  });

  it("cascades the ROUNDED proposal into derived component demand", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "p", type: "manufactured", rounding: 10 }), art({ articleId: "c" })],
        salesRows: [{ articleId: "p", orderStatus: "confirmed", quantityOrdered: 4, quantityDelivered: 0 }],
        bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 2 }],
      })
    );
    expect(rowFor(rows, "p").proposalQuantity).toBe(10);
    expect(rowFor(rows, "c").demandDerived).toBe(20);
  });

  it("never turns a zero proposal into a step", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a", rounding: 5 })],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 3, quantityDelivered: 0 }],
        stock: [{ articleId: "a", quantity: 10 }],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(0);
  });
});

describe("exclusions and candidate set", () => {
  it("never emits phantom or service articles as result rows", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [
          art({ articleId: "ph", type: "manufactured", isPhantom: true }),
          art({ articleId: "s", type: "service" }),
        ],
        stock: [{ articleId: "ph", quantity: 5 }],
        salesRows: [{ articleId: "s", orderStatus: "confirmed", quantityOrdered: 3, quantityDelivered: 0 }],
      })
    );
    expect(rows).toHaveLength(0);
  });

  it("shows inactive articles honestly but gives them no proposal and no cascade", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [
          art({ articleId: "fg", type: "manufactured", active: false }),
          art({ articleId: "c" }),
        ],
        salesRows: [{ articleId: "fg", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 }],
        bomEdges: [{ parentArticleId: "fg", componentArticleId: "c", quantity: 2 }],
      })
    );
    const fg = rowFor(rows, "fg");
    expect(fg.active).toBe(false);
    expect(fg.projected).toBe(-10);
    expect(fg.proposalQuantity).toBe(0);
    expect(fg.proposalKind).toBeNull();
    // No cascade from an inactive article -> c has nothing and is absent:
    expect(rows.find((r) => r.articleId === "c")).toBeUndefined();
  });

  it("includes an article with only a reorder point set, and excludes idle articles", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "bp", reorderPoint: 5 }), art({ articleId: "idle" })],
      })
    );
    expect(rowFor(rows, "bp").proposalQuantity).toBe(5);
    expect(rows.find((r) => r.articleId === "idle")).toBeUndefined();
  });

  it("keeps a fully covered article visible when it has stock or open orders", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        stock: [{ articleId: "a", quantity: 8 }],
      })
    );
    expect(rowFor(rows, "a").proposalQuantity).toBe(0);
    expect(rowFor(rows, "a").onHand).toBe(8);
  });
});

describe("proposal kind and primary supplier", () => {
  it("marks purchased shortages as purchase proposals with the primary supplier attached", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a" })],
        salesRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 3, quantityDelivered: 0 }],
        primarySuppliers: [
          {
            articleId: "a",
            supplierId: "sup-1",
            supplierName: "Stål AB",
            price: 12.5,
            currency: "SEK",
            leadTimeDays: 14,
          },
        ],
      })
    );
    const row = rowFor(rows, "a");
    expect(row.proposalKind).toBe("purchase");
    expect(row.primarySupplier).toEqual({
      supplierId: "sup-1",
      supplierName: "Stål AB",
      price: 12.5,
      currency: "SEK",
      leadTimeDays: 14,
    });
  });

  it("marks manufactured shortages as manufacture proposals; missing supplier stays null", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "m", type: "manufactured" }), art({ articleId: "p" })],
        salesRows: [
          { articleId: "m", orderStatus: "confirmed", quantityOrdered: 3, quantityDelivered: 0 },
          { articleId: "p", orderStatus: "confirmed", quantityOrdered: 3, quantityDelivered: 0 },
        ],
      })
    );
    expect(rowFor(rows, "m").proposalKind).toBe("manufacture");
    expect(rowFor(rows, "m").primarySupplier).toBeNull();
    expect(rowFor(rows, "p").proposalKind).toBe("purchase");
    expect(rowFor(rows, "p").primarySupplier).toBeNull();
  });
});

describe("multi-level cascade (härlett behov)", () => {
  it("explodes a manufactured proposal one level into component demandDerived, through phantoms", () => {
    // fg needs 10; bom: fg -> a x2 (purchased), fg -> ph x1 (phantom) -> b x3 (purchased)
    const rows = computeRequirements(
      calcInput({
        articles: [
          art({ articleId: "fg", type: "manufactured" }),
          art({ articleId: "a" }),
          art({ articleId: "ph", type: "manufactured", isPhantom: true }),
          art({ articleId: "b" }),
        ],
        salesRows: [{ articleId: "fg", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 }],
        bomEdges: [
          { parentArticleId: "fg", componentArticleId: "a", quantity: 2 },
          { parentArticleId: "fg", componentArticleId: "ph", quantity: 1 },
          { parentArticleId: "ph", componentArticleId: "b", quantity: 3 },
        ],
      })
    );
    expect(rowFor(rows, "fg").proposalQuantity).toBe(10);
    expect(rowFor(rows, "fg").proposalKind).toBe("manufacture");
    expect(rowFor(rows, "a").demandDerived).toBe(20);
    expect(rowFor(rows, "a").proposalQuantity).toBe(20);
    expect(rowFor(rows, "a").proposalKind).toBe("purchase");
    expect(rowFor(rows, "b").demandDerived).toBe(30);
    expect(rowFor(rows, "b").proposalQuantity).toBe(30);
  });

  it("cascades over two manufactured levels, netting each level's own stock", () => {
    // fg (demand 10) -> sub x2 (manufactured, stock 5) -> c x5 (purchased)
    const rows = computeRequirements(
      calcInput({
        articles: [
          art({ articleId: "fg", type: "manufactured" }),
          art({ articleId: "sub", type: "manufactured" }),
          art({ articleId: "c" }),
        ],
        salesRows: [{ articleId: "fg", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 }],
        stock: [{ articleId: "sub", quantity: 5 }],
        bomEdges: [
          { parentArticleId: "fg", componentArticleId: "sub", quantity: 2 },
          { parentArticleId: "sub", componentArticleId: "c", quantity: 5 },
        ],
      })
    );
    expect(rowFor(rows, "fg").proposalQuantity).toBe(10);
    expect(rowFor(rows, "sub").demandDerived).toBe(20);
    expect(rowFor(rows, "sub").proposalQuantity).toBe(15); // 5 in stock
    expect(rowFor(rows, "c").demandDerived).toBe(75); // 15 x 5
    expect(rowFor(rows, "c").proposalQuantity).toBe(75);
  });

  it("drives the cascade with the ROUNDED proposal quantity — that is what the TO will be created for", () => {
    // fg (demand 10) -> sub x2 (manufactured, oq 25, stock 5) -> c x5 (purchased, oq 30)
    const rows = computeRequirements(
      calcInput({
        articles: [
          art({ articleId: "fg", type: "manufactured" }),
          art({ articleId: "sub", type: "manufactured", orderQuantity: 25 }),
          art({ articleId: "c", orderQuantity: 30 }),
        ],
        salesRows: [{ articleId: "fg", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 }],
        stock: [{ articleId: "sub", quantity: 5 }],
        bomEdges: [
          { parentArticleId: "fg", componentArticleId: "sub", quantity: 2 },
          { parentArticleId: "sub", componentArticleId: "c", quantity: 5 },
        ],
      })
    );
    expect(rowFor(rows, "sub").proposalQuantity).toBe(25); // raw 15 -> one multiple of 25
    expect(rowFor(rows, "c").demandDerived).toBe(125); // 25 x 5, not 15 x 5
    expect(rowFor(rows, "c").proposalQuantity).toBe(150); // ceil(125/30) = 5 multiples
  });

  it("sums derived demand through a diamond structure", () => {
    // fg -> s1 x1 -> c x2 ; fg -> s2 x1 -> c x3 ; fg proposal 10
    const rows = computeRequirements(
      calcInput({
        articles: [
          art({ articleId: "fg", type: "manufactured" }),
          art({ articleId: "s1", type: "manufactured" }),
          art({ articleId: "s2", type: "manufactured" }),
          art({ articleId: "c" }),
        ],
        salesRows: [{ articleId: "fg", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 }],
        bomEdges: [
          { parentArticleId: "fg", componentArticleId: "s1", quantity: 1 },
          { parentArticleId: "fg", componentArticleId: "s2", quantity: 1 },
          { parentArticleId: "s1", componentArticleId: "c", quantity: 2 },
          { parentArticleId: "s2", componentArticleId: "c", quantity: 3 },
        ],
      })
    );
    expect(rowFor(rows, "c").demandDerived).toBe(50);
    expect(rowFor(rows, "c").proposalQuantity).toBe(50);
  });

  it("is independent of the input article order (low-level codes decide processing order)", () => {
    const articles = [
      art({ articleId: "c" }),
      art({ articleId: "sub", type: "manufactured" }),
      art({ articleId: "fg", type: "manufactured" }),
    ];
    const base = {
      salesRows: [
        { articleId: "fg", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 },
      ] as RequirementsInput["salesRows"],
      bomEdges: [
        { parentArticleId: "fg", componentArticleId: "sub", quantity: 2 },
        { parentArticleId: "sub", componentArticleId: "c", quantity: 5 },
      ],
    };
    const forward = computeRequirements(calcInput({ articles, ...base }));
    const reversed = computeRequirements(calcInput({ articles: [...articles].reverse(), ...base }));
    expect(rowFor(forward, "c").proposalQuantity).toBe(100);
    expect(rowFor(reversed, "c").proposalQuantity).toBe(100);
    // Rows come back sorted by article number regardless of input order:
    expect(forward.map((r) => r.articleNumber)).toEqual(reversed.map((r) => r.articleNumber));
  });

  it("existing supply on a component reduces its derived proposal", () => {
    // fg proposal 10 -> c x2 derived 20; c already has an open IO of 15 -> propose 5
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "fg", type: "manufactured" }), art({ articleId: "c" })],
        salesRows: [{ articleId: "fg", orderStatus: "confirmed", quantityOrdered: 10, quantityDelivered: 0 }],
        purchaseRows: [{ articleId: "c", orderStatus: "confirmed", quantityOrdered: 15, quantityReceived: 0 }],
        bomEdges: [{ parentArticleId: "fg", componentArticleId: "c", quantity: 2 }],
      })
    );
    expect(rowFor(rows, "c").demandDerived).toBe(20);
    expect(rowFor(rows, "c").supplyPo).toBe(15);
    expect(rowFor(rows, "c").proposalQuantity).toBe(5);
  });
});

describe("computeLowLevelCodes", () => {
  it("assigns the longest path from a root as each article's level", () => {
    // fg -> sub -> c and fg -> c directly: c must sit at level 2 (below sub)
    const codes = computeLowLevelCodes([
      { parentArticleId: "fg", componentArticleId: "sub", quantity: 1 },
      { parentArticleId: "sub", componentArticleId: "c", quantity: 1 },
      { parentArticleId: "fg", componentArticleId: "c", quantity: 1 },
    ]);
    expect(codes.get("fg") ?? 0).toBe(0);
    expect(codes.get("sub")).toBe(1);
    expect(codes.get("c")).toBe(2);
  });
});

describe("explodeOneLevel", () => {
  it("dissolves phantom chains but stops at real components", () => {
    // p -> ph x2 -> (c1 x3, ph2 x1 -> c2 x4), p -> c3 x5
    const result = explodeOneLevel(
      [
        { parentArticleId: "p", componentArticleId: "ph", quantity: 2 },
        { parentArticleId: "ph", componentArticleId: "c1", quantity: 3 },
        { parentArticleId: "ph", componentArticleId: "ph2", quantity: 1 },
        { parentArticleId: "ph2", componentArticleId: "c2", quantity: 4 },
        { parentArticleId: "p", componentArticleId: "c3", quantity: 5 },
        // c1's own BOM must NOT be entered — one level only:
        { parentArticleId: "c1", componentArticleId: "deep", quantity: 100 },
      ],
      new Set(["ph", "ph2"]),
      "p",
      10
    );
    expect(result.get("c1")).toBe(60); // 10 x 2 x 3
    expect(result.get("c2")).toBe(80); // 10 x 2 x 1 x 4
    expect(result.get("c3")).toBe(50);
    expect(result.has("deep")).toBe(false);
  });
});

// --- Etapp G: lego (subcontract) operation rows ---

function legoRow(overrides: Partial<import("../src/modules/planning/service/requirements-calc.js").LegoOperationRow> = {}) {
  return {
    moOperationId: "op-1",
    manufacturingOrderId: "mo-1",
    orderNumber: "PO-2044",
    articleId: "a1",
    articleNumber: "ART-1",
    articleName: "Legodetalj",
    articleType: "manufactured" as const,
    unitCode: "st",
    groupId: null,
    sequenceNo: 20,
    operationDescription: "Ytbehandling",
    workCenterName: "Ytbehandling AB",
    orderQuantity: 10,
    orderedQuantity: 0,
    supplierId: "sup-1",
    supplierName: "Lego AB",
    setupPrice: 500,
    unitPrice: 100,
    openInquiries: [],
    ...overrides,
  };
}

describe("lego (subcontract) operation rows", () => {
  it("proposes the remaining quantity per operation with the operation's supplier and prices", () => {
    const rows = computeRequirements(calcInput({ legoOperationRows: [legoRow()] }));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.proposalKind).toBe("subcontract");
    expect(row.proposalQuantity).toBe(10);
    expect(row.moOperationId).toBe("op-1");
    expect(row.moOrderNumber).toBe("PO-2044");
    expect(row.moOperationLabel).toBe("Op 20 · Ytbehandling");
    expect(row.primarySupplier).toEqual({
      supplierId: "sup-1",
      supplierName: "Lego AB",
      price: 100,
      currency: "SEK",
      leadTimeDays: null,
    });
  });

  it("deducts what is already ordered and drops a fully covered operation", () => {
    const rows = computeRequirements(
      calcInput({
        legoOperationRows: [
          legoRow({ orderedQuantity: 4 }),
          legoRow({ moOperationId: "op-2", orderedQuantity: 10 }),
          legoRow({ moOperationId: "op-3", orderedQuantity: 12 }),
        ],
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.moOperationId).toBe("op-1");
    expect(rows[0]?.proposalQuantity).toBe(6);
  });

  it("never nets lego rows against stock and never cascades them", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [art({ articleId: "a1", articleNumber: "ART-1", type: "manufactured" })],
        // Plenty on hand — an article-level netting would kill the proposal.
        stock: [{ articleId: "a1", quantity: 1000 }],
        legoOperationRows: [legoRow()],
      })
    );
    const lego = rows.find((r) => r.proposalKind === "subcontract");
    expect(lego).toBeDefined();
    expect(lego?.proposalQuantity).toBe(10);
    expect(lego?.onHand).toBe(0);
    // The article row itself is unaffected by the lego row.
    const articleRow = rows.find((r) => r.moOperationId === undefined && r.articleId === "a1");
    expect(articleRow?.proposalQuantity ?? 0).toBe(0);
  });

  it("keeps a lego row without supplier (proposal shown, ordering blocked in the UI/service)", () => {
    const rows = computeRequirements(
      calcInput({ legoOperationRows: [legoRow({ supplierId: null, supplierName: null })] })
    );
    expect(rows[0]?.primarySupplier).toBeNull();
    expect(rows[0]?.proposalQuantity).toBe(10);
  });

  it("falls back to the work center name when the operation has no description", () => {
    const rows = computeRequirements(
      calcInput({ legoOperationRows: [legoRow({ operationDescription: null })] })
    );
    expect(rows[0]?.moOperationLabel).toBe("Op 20 · Ytbehandling AB");
  });

  it("passes open inquiries through untouched and never lets them affect the proposal quantity", () => {
    const rows = computeRequirements(
      calcInput({
        legoOperationRows: [
          legoRow({
            openInquiries: [{ id: "inq-1", inquiryNumber: "FO-1024", status: "sent" }],
          }),
        ],
      })
    );
    expect(rows[0]?.openInquiries).toEqual([{ id: "inq-1", inquiryNumber: "FO-1024", status: "sent" }]);
    expect(rows[0]?.proposalQuantity).toBe(10);
  });

  it("defaults openInquiries to an empty array when the operation has none", () => {
    const rows = computeRequirements(calcInput({ legoOperationRows: [legoRow()] }));
    expect(rows[0]?.openInquiries).toEqual([]);
  });
});

// Konfigurator 4c — beställningsvara: a to_order template never gets a
// proposal of its own; each uncovered configured KO row is a proposal row and
// its derived material (cascaded once by the planning service) is derived
// demand before netting.
const article = (id: string, overrides: Partial<RequirementsArticle> = {}) => art({ articleId: id, ...overrides });
const configuredRow = (o: Partial<ConfiguredRowNeed>): ConfiguredRowNeed => ({
  salesOrderRowId: "r", salesOrderId: "so", orderNumber: "KO-1", customerName: "Kund AB", templateArticleId: "T", templateActive: true,
  expectedDeliveryDate: null, summary: "", uncoveredQuantity: 1, error: null, ...o,
});

describe("konfigurator 4c — beställningsvara", () => {
  it("a to_order template never gets a proposal, even with negative stock and a reorder point", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [article("T", { type: "manufactured", configuratorMode: "to_order", reorderPoint: 5 })],
        stock: [{ articleId: "T", quantity: -1 }],
      })
    );
    const t = rows.find((r) => r.articleId === "T")!;
    expect([t.proposalQuantity, t.proposalKind, t.configuredTemplate]).toEqual([0, null, true]);
  });

  it("a planned configured TO counts its material rows and is not exploded through the template's BOM", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [article("T", { type: "manufactured", configuratorMode: "to_order" }), article("C"), article("X")],
        bomEdges: [{ parentArticleId: "T", componentArticleId: "X", quantity: 1 }],
        manufacturingOrders: [{ articleId: "T", status: "planned", quantity: 2, configured: true }],
        moMaterialRows: [{ componentArticleId: "C", orderStatus: "planned", quantityPlanned: 3, quantityConsumed: 0 }],
      })
    );
    expect(rows.find((r) => r.articleId === "C")!.demandMo).toBe(3);
    expect(rows.find((r) => r.articleId === "X")?.demandMo ?? 0).toBe(0);
    expect(rows.find((r) => r.articleId === "T")!.supplyMo).toBe(2);
  });

  it("configured rows become proposal rows; the cascade lands as derived demand before netting", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [
          article("T", { type: "manufactured", configuratorMode: "to_order" }),
          article("C", { type: "purchased" }),
          article("H", { type: "manufactured" }),
          article("R", { type: "purchased" }),
        ],
        bomEdges: [{ parentArticleId: "H", componentArticleId: "R", quantity: 2 }],
        configuredRows: [
          configuredRow({ salesOrderRowId: "r1", templateArticleId: "T", uncoveredQuantity: 2, summary: "Lås: Lås B · Bredd: 1 200 mm" }),
        ],
        configuredCascade: new Map([
          ["C", 4],
          ["H", 2],
        ]),
      })
    );
    const cfg = rows.filter((r) => r.proposalKind === "configured");
    expect(cfg.map((r) => [r.salesOrderRowId, r.articleId, r.proposalQuantity, r.configurationSummary])).toEqual([
      ["r1", "T", 2, "Lås: Lås B · Bredd: 1 200 mm"],
    ]);
    expect(rows.find((r) => r.articleId === "C")).toMatchObject({ demandDerived: 4, proposalQuantity: 4, proposalKind: "purchase" });
    expect(rows.find((r) => r.articleId === "H")).toMatchObject({ demandDerived: 2, proposalQuantity: 2, proposalKind: "manufacture" });
    expect(rows.find((r) => r.articleId === "R")).toMatchObject({ demandDerived: 4 });
  });

  it("configured rows sort after the article rows and before the lego rows; covered rows are dropped", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [article("T", { type: "manufactured", configuratorMode: "to_order" })],
        configuredRows: [
          configuredRow({ salesOrderRowId: "r2", orderNumber: "KO-2", templateArticleId: "T", uncoveredQuantity: 1 }),
          configuredRow({ salesOrderRowId: "r1", orderNumber: "KO-1", templateArticleId: "T", uncoveredQuantity: 1 }),
          configuredRow({ salesOrderRowId: "r0", orderNumber: "KO-0", templateArticleId: "T", uncoveredQuantity: 0 }),
        ],
        // Stock makes the template's own row relevant (still no proposal).
        stock: [{ articleId: "T", quantity: 1 }],
        legoOperationRows: [legoRow()],
      })
    );
    expect(rows.map((r) => r.proposalKind ?? "article")).toEqual(["article", "configured", "configured", "subcontract"]);
    expect(rows.filter((r) => r.proposalKind === "configured").map((r) => r.salesOrderNumber)).toEqual(["KO-1", "KO-2"]);
  });

  it("a configured row on an inactive template is listed (Inaktiv) but proposes nothing, like an inactive ordinary article", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [article("T", { type: "manufactured", configuratorMode: "to_order", active: false })],
        configuredRows: [configuredRow({ salesOrderRowId: "r1", templateArticleId: "T", uncoveredQuantity: 2, templateActive: false })],
      })
    );
    const cfg = rows.find((r) => r.proposalKind === "configured")!;
    expect([cfg.salesOrderRowId, cfg.active, cfg.proposalQuantity, cfg.configurationError]).toEqual(["r1", false, 0, null]);
  });

  it("an invalid configured row keeps its error and has no cascade of its own", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [article("T", { type: "manufactured", configuratorMode: "to_order" })],
        configuredRows: [
          configuredRow({ salesOrderRowId: "r1", templateArticleId: "T", uncoveredQuantity: 1, error: "Konfigurationen är inte giltig" }),
        ],
      })
    );
    expect(rows.find((r) => r.proposalKind === "configured")!.configurationError).toBe("Konfigurationen är inte giltig");
  });
});

describe("säkerhetslager", () => {
  it("fills the projected balance up to the safety stock, with order quantity on top", () => {
    const rows = computeRequirements(
      calcInput({
        articles: [
          art({ articleId: "a", safetyStock: 20 }),
          art({ articleId: "b", safetyStock: 20, orderQuantity: 50 }),
          art({ articleId: "c", safetyStock: 5, reorderPoint: 12 }),
          art({ articleId: "d", safetyStock: 20 }),
        ],
        stock: [
          { articleId: "a", quantity: 8 },
          { articleId: "b", quantity: 8 },
          { articleId: "c", quantity: 8 },
          { articleId: "d", quantity: 20 },
        ],
      })
    );
    expect(rowFor(rows, "a")).toMatchObject({ proposalQuantity: 12, safetyStock: 20 });
    expect(rowFor(rows, "b").proposalQuantity).toBe(50);
    // The larger of the two floors wins.
    expect(rowFor(rows, "c").proposalQuantity).toBe(4);
    expect(rowFor(rows, "d").proposalQuantity).toBe(0);
  });
});

// --- #13: time-phased proposals (tidsfasade förslag) ---
//
// 2026-11-02 is a Monday (v.45): v.46 starts 11-09, v.47 11-16, v.48 11-23.
// Dates are ship/start dates already (the service shifts them); no holidays
// unless a test sets them.

const TODAY = "2026-11-02";
const timed = (partial: Partial<RequirementsInput>) => calcInput({ today: TODAY, ...partial });
const sale = (articleId: string, date: string | null, quantity: number) => ({
  articleId,
  orderStatus: "confirmed" as const,
  quantityOrdered: quantity,
  quantityDelivered: 0,
  expectedDeliveryDate: date,
});

describe("time-phased proposals — grouping per need week", () => {
  it("groups the uncovered demand per ISO week with the week's first uncovered day as need date", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a" })],
        stock: [{ articleId: "a", quantity: 5 }],
        salesRows: [sale("a", "2026-11-25", 7), sale("a", "2026-11-10", 10), sale("a", "2026-11-12", 4)],
      })
    );
    const row = rowFor(rows, "a");
    expect(row.proposals).toEqual([
      // Stock covers 5 of the 10 on 11-10; the 4 on 11-12 join the same week.
      {
        key: "purchase:a:2026-11-09",
        needDate: "2026-11-10",
        needWeek: "2026-11-09",
        latestDate: "2026-11-09",
        late: false,
        quantity: 9,
        reason: "demand",
      },
      {
        key: "purchase:a:2026-11-23",
        needDate: "2026-11-25",
        needWeek: "2026-11-23",
        latestDate: "2026-11-24",
        late: false,
        quantity: 7,
        reason: "demand",
      },
    ]);
    expect(row).toMatchObject({ proposalQuantity: 16, proposalKind: "purchase", earliestLatestDate: "2026-11-09", anyLate: false });
  });

  it("a fully covered week makes no proposal; later demand draws on what is left of the pool", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a" })],
        stock: [{ articleId: "a", quantity: 12 }],
        purchaseRows: [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: 3, quantityReceived: 0 }],
        salesRows: [sale("a", "2026-11-10", 10), sale("a", "2026-11-25", 7)],
      })
    );
    expect(rowFor(rows, "a").proposals.map((p) => [p.needWeek, p.quantity])).toEqual([["2026-11-23", 2]]);
  });

  it("a need before the current week is planned in the current week and is late", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a" })],
        salesRows: [sale("a", "2026-10-20", 3), sale("a", "2026-11-04", 2)],
      })
    );
    expect(rowFor(rows, "a").proposals).toEqual([
      {
        key: "purchase:a:2026-11-02",
        needDate: "2026-10-20",
        needWeek: "2026-11-02",
        latestDate: "2026-10-19",
        late: true,
        quantity: 5,
        reason: "demand",
      },
    ]);
    expect(rowFor(rows, "a").anyLate).toBe(true);
  });

  it("undated demand becomes its own undated proposal, sorted last", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a" })],
        salesRows: [sale("a", null, 4), sale("a", "2026-11-25", 7)],
      })
    );
    expect(rowFor(rows, "a").proposals).toEqual([
      expect.objectContaining({ needWeek: "2026-11-23", quantity: 7, reason: "demand" }),
      { key: "purchase:a:undated", needDate: null, needWeek: null, latestDate: null, late: false, quantity: 4, reason: "undated" },
    ]);
    expect(rowFor(rows, "a").earliestLatestDate).toBe("2026-11-24");
  });

  it("negative stock is a need today", () => {
    const rows = computeRequirements(
      timed({ articles: [art({ articleId: "a" })], stock: [{ articleId: "a", quantity: -3 }] })
    );
    expect(rowFor(rows, "a").proposals).toEqual([
      expect.objectContaining({ needDate: TODAY, needWeek: TODAY, quantity: 3, reason: "demand", latestDate: "2026-10-30", late: true }),
    ]);
  });

  it("dates TO material with the TO's start date and a planned TO's explosion with its start date", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "p", type: "manufactured" }), art({ articleId: "c" })],
        bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 2 }],
        manufacturingOrders: [
          { articleId: "p", status: "planned", quantity: 3, configured: false, startDate: "2026-11-18" },
          { articleId: "p", status: "released", quantity: 1, configured: false },
        ],
        moMaterialRows: [
          { componentArticleId: "c", orderStatus: "released", quantityPlanned: 5, quantityConsumed: 1, needDate: "2026-11-10" },
        ],
      })
    );
    expect(rowFor(rows, "c").proposals.map((p) => [p.needDate, p.quantity])).toEqual([
      ["2026-11-10", 4],
      ["2026-11-18", 6],
    ]);
    expect(rowFor(rows, "c").demandMo).toBe(10);
  });
});

describe("time-phased proposals — order quantity, rounding and the carried surplus", () => {
  it("applies the order quantity per proposal and carries the surplus to the next week", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", orderQuantity: 10 })],
        salesRows: [sale("a", "2026-11-10", 9), sale("a", "2026-11-25", 6)],
      })
    );
    // 9 → 10 (surplus 1); 6 − 1 = 5 → 10. Sum 20 = ⌈15 / 10⌉ × 10.
    expect(rowFor(rows, "a").proposals.map((p) => p.quantity)).toEqual([10, 10]);
    expect(rowFor(rows, "a").proposalQuantity).toBe(20);
  });

  it("a surplus large enough to cover a later week makes no proposal for it", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", orderQuantity: 20 })],
        salesRows: [sale("a", "2026-11-10", 9), sale("a", "2026-11-25", 6), sale("a", "2026-12-09", 8)],
      })
    );
    // 9 → 20 (surplus 11) covers the 6 (surplus 5); 8 − 5 = 3 → 20.
    expect(rowFor(rows, "a").proposals.map((p) => [p.needWeek, p.quantity])).toEqual([
      ["2026-11-09", 20],
      ["2026-12-07", 20],
    ]);
  });

  it("rounding is applied last, per proposal, and its surplus is carried too", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", rounding: 7.38 })],
        salesRows: [sale("a", "2026-11-10", 100), sale("a", "2026-11-25", 3)],
      })
    );
    // 100 → 103.32 (14 bars, surplus 3.32) covers the 3 kg two weeks later.
    expect(rowFor(rows, "a").proposals.map((p) => p.quantity)).toEqual([103.32]);
  });

  it("the lead time is resolved for the ROUNDED proposal quantity", () => {
    const asked: [string, number][] = [];
    computeRequirements(
      timed({
        articles: [art({ articleId: "m", type: "manufactured", orderQuantity: 50 })],
        salesRows: [sale("m", "2026-11-20", 7)],
        leadDaysFor: (id, quantity) => {
          asked.push([id, quantity]);
          return 1;
        },
      })
    );
    expect(asked).toContainEqual(["m", 50]);
  });
});

describe("time-phased proposals — safety stock floor and reorder point", () => {
  it("safety stock is the floor of the pool: demand below it is uncovered", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", safetyStock: 10 })],
        stock: [{ articleId: "a", quantity: 12 }],
        salesRows: [sale("a", "2026-11-10", 5)],
      })
    );
    expect(rowFor(rows, "a").proposals).toEqual([
      expect.objectContaining({ needDate: "2026-11-10", quantity: 3, reason: "demand" }),
    ]);
  });

  it("a pool already below the safety stock is a need today", () => {
    const rows = computeRequirements(
      timed({ articles: [art({ articleId: "a", safetyStock: 10 })], stock: [{ articleId: "a", quantity: 4 }] })
    );
    expect(rowFor(rows, "a").proposals).toEqual([
      expect.objectContaining({ needDate: TODAY, needWeek: TODAY, quantity: 6, reason: "demand" }),
    ]);
  });

  it("the reorder point tops up the position after all demands and proposals, dated today and never late", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", reorderPoint: 20 })],
        stock: [{ articleId: "a", quantity: 2 }],
        salesRows: [sale("a", "2026-11-25", 5)],
      })
    );
    expect(rowFor(rows, "a").proposals).toEqual([
      expect.objectContaining({ needWeek: "2026-11-23", quantity: 3, reason: "demand" }),
      {
        key: "purchase:a:rop",
        needDate: TODAY,
        needWeek: TODAY,
        latestDate: TODAY,
        late: false,
        quantity: 20,
        reason: "reorder_point",
      },
    ]);
    expect(rowFor(rows, "a").proposalQuantity).toBe(23);
  });

  it("no reorder-point proposal when the surplus already lifts the position to the reorder point", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", reorderPoint: 4, orderQuantity: 10 })],
        salesRows: [sale("a", "2026-11-25", 5)],
      })
    );
    // 5 → 10, position 5 ≥ 4.
    expect(rowFor(rows, "a").proposals.map((p) => p.reason)).toEqual(["demand"]);
  });

  it("the reorder-point proposal's material is a reorder-point proposal at the component too — today, never late", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "p", type: "manufactured", reorderPoint: 2 }), art({ articleId: "c" })],
        bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 3 }],
      })
    );
    expect(rowFor(rows, "c").proposals).toEqual([
      { key: `purchase:c:${TODAY}`, needDate: TODAY, needWeek: TODAY, latestDate: TODAY, late: false, quantity: 6, reason: "reorder_point" },
    ]);
  });

  it("reorder-point material in the same week as a real demand: the real demand dates the proposal", () => {
    // TODAY is a Monday; the KO row on Thursday the same week.
    const thursday = "2026-11-05";
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "p", type: "manufactured", reorderPoint: 2 }), art({ articleId: "c" })],
        bomEdges: [{ parentArticleId: "p", componentArticleId: "c", quantity: 3 }],
        salesRows: [sale("c", thursday, 4)],
      })
    );
    expect(rowFor(rows, "c").proposals).toEqual([
      expect.objectContaining({ needDate: thursday, needWeek: TODAY, quantity: 10, reason: "demand" }),
    ]);
  });
});

describe("time-phased proposals — the sum invariant", () => {
  // Without order quantity and rounding, the proposals of an article sum to
  // the old aggregated proposal max(reorder point, safety stock) − projected;
  // with an order quantity the sum is the same whole multiple (the carried
  // surplus keeps the total minimal). Rounding on top of an order quantity
  // may exceed it (each proposal is rounded separately) — documented, not
  // asserted.
  const cases: { stock: number; safety: number | null; rop: number | null; oq: number | null; demands: (string | null)[]; qty: number[]; supply: number }[] = [
    { stock: 5, safety: null, rop: null, oq: null, demands: ["2026-11-10", "2026-11-25", null], qty: [10, 4, 7], supply: 0 },
    { stock: -3, safety: 10, rop: null, oq: null, demands: ["2026-10-20", "2026-11-04"], qty: [3, 2], supply: 4 },
    { stock: 2, safety: 5, rop: 20, oq: null, demands: ["2026-11-25", "2026-12-09"], qty: [5, 1], supply: 0 },
    { stock: 0, safety: null, rop: 7, oq: 5, demands: ["2026-11-10", "2026-11-25"], qty: [3, 4], supply: 0 },
    { stock: 50, safety: 10, rop: 60, oq: 25, demands: ["2026-11-10"], qty: [3], supply: 0 },
    { stock: 1.5, safety: 2.25, rop: null, oq: 0.5, demands: ["2026-11-10", "2026-11-11", "2026-11-18"], qty: [0.3, 0.3, 0.4], supply: 0.1 },
    { stock: 0, safety: null, rop: null, oq: 10, demands: ["2026-11-10", "2026-11-25", "2026-12-09"], qty: [9, 6, 8], supply: 0 },
    { stock: 100, safety: 0, rop: 0, oq: null, demands: ["2026-11-10"], qty: [3], supply: 0 },
  ];

  it.each(cases)("sum of proposals = aggregated proposal (%j)", (c) => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", safetyStock: c.safety, reorderPoint: c.rop, orderQuantity: c.oq })],
        stock: [{ articleId: "a", quantity: c.stock }],
        purchaseRows: c.supply ? [{ articleId: "a", orderStatus: "confirmed", quantityOrdered: c.supply, quantityReceived: 0 }] : [],
        salesRows: c.demands.map((d, i) => sale("a", d, c.qty[i]!)),
      })
    );
    const row = rowFor(rows, "a");
    const raw = Math.max(0, Math.max(c.rop ?? 0, c.safety ?? 0) - row.projected);
    const expected = c.oq ? Math.ceil(Number((raw / c.oq).toFixed(6))) * c.oq : raw;
    expect(row.proposalQuantity).toBeCloseTo(expected, 4);
    expect(row.proposals.reduce((sum, p) => sum + p.quantity, 0)).toBeCloseTo(row.proposalQuantity, 4);
  });
});

describe("time-phased proposals — latest dates", () => {
  it("manufacture: the working day before the need minus the lead time; purchase: latestPurchaseOrderDate", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "m", type: "manufactured" }), art({ articleId: "k" })],
        salesRows: [sale("m", "2026-11-20", 1), sale("k", "2026-11-20", 1)],
        leadDaysFor: (id) => (id === "m" ? 3 : 0),
        primarySuppliers: [
          {
            articleId: "k",
            supplierId: "s1",
            supplierName: "Leverantör",
            price: 10,
            currency: "SEK",
            leadTimeDays: 5,
            // Delivers to us Tuesdays and Thursdays.
            supplierDelivery: { deliveryWeekdays: [2, 4], deliveryDayMode: "arrival", transitDays: null },
          },
        ],
      })
    );
    // Fri 11-20: the working day before is Thu 11-19, minus 3 working days = Mon 11-16.
    expect(rowFor(rows, "m").proposals[0]).toMatchObject({ latestDate: "2026-11-16", late: false });
    expect(rowFor(rows, "m").leadDays).toBe(3);
    // Arrival Thu 11-19 (listed), 5 working days before: Thu 11-12.
    expect(rowFor(rows, "k").proposals[0]).toMatchObject({ latestDate: "2026-11-12", late: false });
    expect(rowFor(rows, "k").leadDays).toBeNull();
  });

  it("purchase without a supplier: the working day before the need, holidays skipped", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "k" })],
        salesRows: [sale("k", "2026-11-16", 1)],
        offDays: new Set(["2026-11-13"]),
      })
    );
    // Mon 11-16, Fri 11-13 is a holiday: the working day before is Thu 11-12.
    expect(rowFor(rows, "k").proposals[0]!.latestDate).toBe("2026-11-12");
  });

  it("the system's supplier delivery defaults apply when the supplier has no own settings", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "t" })],
        salesRows: [sale("t", "2026-11-16", 1)],
        deliveryDefaults: { supplier: { mode: "arrival", transitDays: 2 }, customer: { mode: "dispatch", transitDays: 0 } },
        primarySuppliers: [
          { articleId: "t", supplierId: "s", supplierName: "S", price: null, currency: "SEK", leadTimeDays: 0 },
        ],
      })
    );
    // Arrival Fri 11-13 with 2 transit working days: ordered Wed 11-11.
    expect(rowFor(rows, "t").proposals[0]!.latestDate).toBe("2026-11-11");
  });

  it("late when the latest date has passed, also for a need still ahead", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "m", type: "manufactured" })],
        salesRows: [sale("m", "2026-11-04", 1)],
        leadDaysFor: () => 5,
      })
    );
    // Wed 11-04: working day before Tue 11-03, minus 5 working days = Tue 10-27 < today.
    expect(rowFor(rows, "m").proposals[0]).toMatchObject({ needDate: "2026-11-04", latestDate: "2026-10-27", late: true });
  });
});

describe("time-phased proposals — the cascade over two levels", () => {
  it("dates the component's derived demand with the parent proposal's latest start", () => {
    const leadDays: Record<string, number> = { a: 2, b: 1 };
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", type: "manufactured" }), art({ articleId: "b", type: "manufactured" }), art({ articleId: "c" })],
        bomEdges: [
          { parentArticleId: "a", componentArticleId: "b", quantity: 2 },
          { parentArticleId: "b", componentArticleId: "c", quantity: 3 },
        ],
        salesRows: [sale("a", "2026-11-20", 1)],
        leadDaysFor: (id) => leadDays[id] ?? 0,
        primarySuppliers: [{ articleId: "c", supplierId: "s", supplierName: "S", price: null, currency: "SEK", leadTimeDays: 3 }],
      })
    );
    // a: need Fri 11-20 → latest start Thu 11-19 − 2 = Tue 11-17.
    expect(rowFor(rows, "a").proposals[0]).toMatchObject({ needDate: "2026-11-20", latestDate: "2026-11-17", quantity: 1 });
    // b: need = a's start 11-17 → Mon 11-16 − 1 = Fri 11-13.
    expect(rowFor(rows, "b").proposals[0]).toMatchObject({ needDate: "2026-11-17", latestDate: "2026-11-13", quantity: 2 });
    // c: need = b's start 11-13 → arrival Thu 11-12, 3 working days lead: Mon 11-09.
    expect(rowFor(rows, "c").proposals[0]).toMatchObject({ needDate: "2026-11-13", latestDate: "2026-11-09", quantity: 6 });
    expect(rowFor(rows, "c").demandDerived).toBe(6);
  });

  it("two parent proposals in different weeks give the component two dated proposals", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", type: "manufactured" }), art({ articleId: "c" })],
        bomEdges: [{ parentArticleId: "a", componentArticleId: "c", quantity: 1 }],
        salesRows: [sale("a", "2026-11-11", 4), sale("a", "2026-12-02", 6)],
      })
    );
    // a's latest starts (lead 0): Tue 11-10 and Tue 12-01 — c's need dates.
    expect(rowFor(rows, "c").proposals.map((p) => [p.needDate, p.quantity])).toEqual([
      ["2026-11-10", 4],
      ["2026-12-01", 6],
    ]);
  });

  it("an undated parent proposal gives undated component demand", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "a", type: "manufactured" }), art({ articleId: "c" })],
        bomEdges: [{ parentArticleId: "a", componentArticleId: "c", quantity: 1 }],
        salesRows: [sale("a", null, 4)],
      })
    );
    expect(rowFor(rows, "c").proposals).toEqual([expect.objectContaining({ needDate: null, quantity: 4, reason: "undated" })]);
  });

  it("dated derived demand from outside (configured rows) is netted on its date; the undated map stays undated", () => {
    const rows = computeRequirements(
      timed({
        articles: [art({ articleId: "c" })],
        derivedDemands: [{ articleId: "c", quantity: 2, needDate: "2026-11-18" }],
        configuredCascade: new Map([["c", 3]]),
      })
    );
    expect(rowFor(rows, "c").demandDerived).toBe(5);
    expect(rowFor(rows, "c").proposals.map((p) => [p.needDate, p.quantity, p.reason])).toEqual([
      ["2026-11-18", 2, "demand"],
      [null, 3, "undated"],
    ]);
  });
});

describe("time-phased proposals — configured and lego rows get their dates", () => {
  it("a configured row: need = the row's ship date, latest start = the working day before minus its lead time", () => {
    const rows = computeRequirements(
      timed({
        articles: [article("T", { type: "manufactured", configuratorMode: "to_order" })],
        configuredRows: [
          configuredRow({ salesOrderRowId: "r1", templateArticleId: "T", uncoveredQuantity: 2, expectedDeliveryDate: "2026-11-20", leadDays: 3 }),
          configuredRow({ salesOrderRowId: "r2", templateArticleId: "T", uncoveredQuantity: 1, expectedDeliveryDate: null }),
        ],
      })
    );
    const [r1, r2] = rows.filter((r) => r.proposalKind === "configured");
    expect(r1!.proposals).toEqual([
      { key: "configured:r1", needDate: "2026-11-20", needWeek: "2026-11-16", latestDate: "2026-11-16", late: false, quantity: 2, reason: "demand" },
    ]);
    expect(r1).toMatchObject({ proposalQuantity: 2, earliestLatestDate: "2026-11-16", leadDays: null });
    expect(r2!.proposals).toEqual([
      { key: "configured:r2", needDate: null, needWeek: null, latestDate: null, late: false, quantity: 1, reason: "undated" },
    ]);
  });

  it("a configured row on an inactive template has no proposals", () => {
    const rows = computeRequirements(
      timed({
        articles: [article("T", { type: "manufactured", configuratorMode: "to_order", active: false })],
        configuredRows: [configuredRow({ templateArticleId: "T", templateActive: false, uncoveredQuantity: 2, expectedDeliveryDate: "2026-11-20" })],
      })
    );
    expect(rows.find((r) => r.proposalKind === "configured")).toMatchObject({ proposalQuantity: 0, proposals: [] });
  });

  it("a lego row: need = the operation's date, latest order = need minus Ledtid beställning", () => {
    const rows = computeRequirements(
      timed({
        legoOperationRows: [
          legoRow({ moOperationId: "op-1", needDate: "2026-11-16", orderLeadTimeDays: 2 }),
          legoRow({ moOperationId: "op-2", sequenceNo: 30, needDate: "2026-11-02", orderLeadTimeDays: 1 }),
          legoRow({ moOperationId: "op-3", sequenceNo: 40 }),
        ],
      })
    );
    const byOp = new Map(rows.map((r) => [r.moOperationId, r]));
    expect(byOp.get("op-1")!.proposals).toEqual([
      { key: "subcontract:op-1", needDate: "2026-11-16", needWeek: "2026-11-16", latestDate: "2026-11-12", late: false, quantity: 10, reason: "demand" },
    ]);
    // Needed today with a day's order lead time: should have been ordered Friday.
    expect(byOp.get("op-2")!.proposals[0]).toMatchObject({ latestDate: "2026-10-30", late: true });
    expect(byOp.get("op-2")!.anyLate).toBe(true);
    expect(byOp.get("op-3")!.proposals[0]).toMatchObject({ needDate: null, latestDate: null, late: false, reason: "undated" });
  });
});
