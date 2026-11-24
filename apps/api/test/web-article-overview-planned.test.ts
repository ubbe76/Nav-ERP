import { describe, expect, it } from "vitest";
import { typedQuantities, withTypedQuantities } from "../../web/lib/articleOverviewPlanned.js";
import type { ArticleOverviewRow } from "../../web/lib/types.js";

// The planned view with the quantities typed on the Behovsberäkning page
// (apps/web/lib/articleOverviewPlanned.ts): a proposal row takes the typed
// quantity, its material elsewhere is rescaled (the explosion is linear) and
// the running balance follows; an untouched or empty field changes nothing.

function row(partial: Partial<ArticleOverviewRow> & Pick<ArticleOverviewRow, "id" | "kind" | "quantity" | "balance">): ArticleOverviewRow {
  return {
    direction: partial.quantity < 0 ? "demand" : "supply",
    date: "2030-03-08",
    documentType: null,
    documentId: null,
    documentNumber: "Förslag v.10",
    status: "proposal",
    partner: null,
    isDraft: false,
    ...partial,
  };
}

const rows: ArticleOverviewRow[] = [
  row({ id: "so:1", kind: "sales_order", quantity: -3, balance: 1, documentType: "sales_order", documentId: "so1", documentNumber: "KO-1", status: "confirmed" }),
  row({ id: "prop:purchase:c:w10", kind: "proposal", quantity: 10, balance: 11, proposal: { key: "purchase:c:w10", reason: "demand", latestDate: "2030-03-01", late: false } }),
  row({ id: "drv:manufacture:p:w11", kind: "derived_demand", quantity: -6, balance: 5, parentArticleId: "p", sourceProposal: { key: "manufacture:p:w11", quantity: 2 } }),
  row({ id: "drv:cascade", kind: "derived_demand", quantity: -1, balance: 4 }),
];

describe("typedQuantities", () => {
  it("keeps only touched fields with a number ≥ 0 and a proposal key", () => {
    const typed = typedQuantities([
      { proposalKey: "a", quantity: "12", touched: true },
      { proposalKey: "b", quantity: "0", touched: true },
      { proposalKey: "c", quantity: "", touched: true },
      { proposalKey: "d", quantity: "-1", touched: true },
      { proposalKey: "e", quantity: "abc", touched: true },
      { proposalKey: "f", quantity: "5", touched: false },
      { proposalKey: null, quantity: "5", touched: true },
      { proposalKey: "g", quantity: "2.5", touched: true },
    ]);
    expect([...typed]).toEqual([
      ["a", 12],
      ["b", 0],
      ["g", 2.5],
    ]);
  });
});

describe("withTypedQuantities", () => {
  it("returns the server's rows unchanged without typed quantities", () => {
    const result = withTypedQuantities(4, rows, new Map());
    expect(result.rows).toEqual(rows);
    expect(result.rows[0]).toBe(rows[0]);
    expect(result.closingBalance).toBe(4);
  });

  it("replaces a proposal's quantity, rescales its material elsewhere and recomputes the balance", () => {
    const result = withTypedQuantities(
      4,
      rows,
      new Map([
        ["purchase:c:w10", 15],
        ["manufacture:p:w11", 3],
      ])
    );
    expect(result.rows.map((r) => [r.id, r.quantity, r.balance, r.proposedQuantity])).toEqual([
      ["so:1", -3, 1, undefined],
      ["prop:purchase:c:w10", 15, 16, 10],
      // 6 for 2 parents ⇒ 9 for 3.
      ["drv:manufacture:p:w11", -9, 7, -6],
      ["drv:cascade", -1, 6, undefined],
    ]);
    expect(result.closingBalance).toBe(6);
  });

  it("a zero typed for the parent removes its material; a zero for the proposal removes the supply", () => {
    const result = withTypedQuantities(
      4,
      rows,
      new Map([
        ["purchase:c:w10", 0],
        ["manufacture:p:w11", 0],
      ])
    );
    expect(result.rows.map((r) => r.quantity)).toEqual([-3, 0, 0, -1]);
    expect(Object.is(result.rows[2]!.quantity, -0)).toBe(false);
    expect(result.closingBalance).toBe(0);
  });
});
