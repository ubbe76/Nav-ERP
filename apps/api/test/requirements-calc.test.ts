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
