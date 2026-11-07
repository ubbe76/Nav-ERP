import { describe, expect, it } from "vitest";
import {
  creationOrder,
  lateWarning,
  planMissingComponents,
  sameMissingOrders,
  type MissingArticle,
  type MissingComponentsInput,
} from "../src/modules/planning/service/missing-components.js";
import { buildBomIndex } from "../src/modules/planning/service/requirements-calc.js";

// Skapa saknade halvfabrikat (pegging #9, etapp 3) — the pure rules: the
// levels, the quantity rule, the dates and the floor, the quantity-based
// netting against the closing balances, the notes, and the guards. "Today"
// is Monday 2030-03-04; no full-day holidays (weekends only).
const TODAY = "2030-03-04";

const P = "art-p";
const H = "art-h";
const H2 = "art-h2";
const S = "art-s";
const R = "art-r";
const SVC = "art-svc";

function article(id: string, over: Partial<MissingArticle> = {}): MissingArticle {
  return {
    articleId: id,
    articleNumber: id.replace("art-", "").toUpperCase(),
    name: `Artikel ${id}`,
    type: "manufactured",
    unitCode: null,
    orderQuantity: null,
    rounding: null,
    closingBalance: 0,
    configuratorMode: null,
    hasRouting: true,
    ...over,
  };
}

type Edge = { parentArticleId: string; componentArticleId: string; quantity: number };
const edge = (parent: string, component: string, quantity = 1): Edge => ({ parentArticleId: parent, componentArticleId: component, quantity });

function input(over: Partial<MissingComponentsInput> & { articleList?: MissingArticle[]; edges?: Edge[]; lead?: number }): MissingComponentsInput {
  const { articleList, edges, lead, ...rest } = over;
  return {
    parent: { articleId: P, articleNumber: "P" },
    today: TODAY,
    offDays: new Set(),
    needs: [{ articleId: H, needDate: "2030-03-22", uncovered: 2 }],
    articles: new Map((articleList ?? [article(H), article(S), article(R, { type: "purchased" })]).map((a) => [a.articleId, a])),
    bomIndex: buildBomIndex(edges ?? [edge(H, S), edge(S, R)]),
    phantomIds: new Set(),
    leadDaysFor: () => lead ?? 1,
    ...rest,
  };
}

const slim = (o: { articleId: string; level: number; quantity: number; dueDate: string | null; late: boolean; needDate: string | null; parentKey: string | null }) => ({
  articleId: o.articleId,
  level: o.level,
  quantity: o.quantity,
  dueDate: o.dueDate,
  late: o.late,
  needDate: o.needDate,
  parentKey: o.parentKey,
});

describe("planMissingComponents", () => {
  it("one level: the working day before the need, the structure explodes no further", () => {
    const r = planMissingComponents(input({ edges: [], articleList: [article(H)] }));
    expect(r.orders.map(slim)).toEqual([{ articleId: H, level: 1, quantity: 2, dueDate: "2030-03-21", late: false, needDate: "2030-03-22", parentKey: null }]);
    expect(r.orders[0]!.key).toMatch(/\S/);
    expect(r.notes).toEqual([]);
  });

  it("several levels: the child is needed on the new TO's start (due − lead), a purchased leaf is a note", () => {
    const r = planMissingComponents(input({}));
    // H due Thu 03-21, lead 1 ⇒ starts Wed 03-20 ⇒ S due Tue 03-19.
    expect(r.orders.map(slim)).toEqual([
      { articleId: H, level: 1, quantity: 2, dueDate: "2030-03-21", late: false, needDate: "2030-03-22", parentKey: null },
      { articleId: S, level: 2, quantity: 2, dueDate: "2030-03-19", late: false, needDate: "2030-03-20", parentKey: r.orders[0]!.key },
    ]);
    expect(r.notes).toEqual(["R köps (2 st saknas) — syns i Behovsberäkningen"]);
    // The note speaks the article's own base unit.
    const kg = planMissingComponents(input({ articleList: [article(H), article(S), article(R, { type: "purchased", unitCode: "kg" })] }));
    expect(kg.notes).toEqual(["R köps (2 kg saknas) — syns i Behovsberäkningen"]);
  });

  it("the quantity is the order-quantity multiple, then Avrundning — and the child's demand follows the rounded quantity", () => {
    const r = planMissingComponents(input({ articleList: [article(H, { orderQuantity: 5, rounding: 2 }), article(S), article(R, { type: "purchased" })] }));
    expect(r.orders.map((o) => [o.articleId, o.quantity])).toEqual([
      [H, 6],
      [S, 6],
    ]);
    expect(r.notes).toEqual(["R köps (6 st saknas) — syns i Behovsberäkningen"]);
  });

  describe("netting against the closing balances", () => {
    it("a free balance covers a deeper demand fully or partly", () => {
      const partly = planMissingComponents(input({ articleList: [article(H), article(S, { closingBalance: 1.5 }), article(R, { type: "purchased" })] }));
      expect(partly.orders.map((o) => [o.articleId, o.quantity])).toEqual([
        [H, 2],
        [S, 0.5],
      ]);
      const fully = planMissingComponents(input({ articleList: [article(H), article(S, { closingBalance: 10 }), article(R, { type: "purchased" })] }));
      expect(fully.orders.map((o) => o.articleId)).toEqual([H]);
      expect(fully.notes).toEqual([]);
    });

    it("a rounding surplus covers a later new demand of the same article", () => {
      // Two halvfabrikat each need one S; S comes in fives ⇒ one TO of 5.
      const r = planMissingComponents(
        input({
          needs: [
            { articleId: H, needDate: "2030-03-22", uncovered: 2 },
            { articleId: H2, needDate: "2030-03-22", uncovered: 2 },
          ],
          articleList: [article(H), article(H2), article(S, { orderQuantity: 5 }), article(R, { type: "purchased" })],
          edges: [edge(H, S), edge(H2, S), edge(S, R)],
        })
      );
      expect(r.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([
        [H, 1, 2],
        [H2, 1, 2],
        [S, 2, 5],
      ]);
      expect(r.notes).toEqual(["R köps (5 st saknas) — syns i Behovsberäkningen"]);
    });

    it("an existing shortage of other demands is never created for — only the new demand", () => {
      // S is already 3 short for someone else: the new H needs 2 more, so 2.
      const r = planMissingComponents(input({ articleList: [article(H), article(S, { closingBalance: -3 }), article(R, { type: "purchased" })] }));
      expect(r.orders.map((o) => [o.articleId, o.quantity])).toEqual([
        [H, 2],
        [S, 2],
      ]);
    });

    it("level 1 only adds: the uncovered quantity is already inside the closing balance", () => {
      // H short 2 (balance −2) and also a component of H2: H2's demand 1 is
      // covered by the level-1 TO's quantity when it rounds up to 5.
      const r = planMissingComponents(
        input({
          needs: [
            { articleId: H, needDate: "2030-03-22", uncovered: 2 },
            { articleId: H2, needDate: "2030-03-22", uncovered: 1 },
          ],
          articleList: [article(H, { closingBalance: -2, orderQuantity: 5 }), article(H2), article(S), article(R, { type: "purchased" })],
          edges: [edge(H2, H), edge(H, S), edge(S, R)],
        })
      );
      expect(r.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([
        [H, 1, 5],
        [H2, 1, 1],
        [S, 2, 5],
      ]);
    });
  });

  it("the parent's rows of one article are summed into one TO", () => {
    const r = planMissingComponents(
      input({
        needs: [
          { articleId: H, needDate: "2030-03-22", uncovered: 1 },
          { articleId: H, needDate: "2030-03-22", uncovered: 1.5 },
          { articleId: H, needDate: "2030-03-22", uncovered: 0 },
        ],
      })
    );
    expect(r.orders.map((o) => [o.articleId, o.quantity])).toEqual([
      [H, 2.5],
      [S, 2.5],
    ]);
  });

  it("notes instead of a TO: purchased, a variants template, a beställningsvara, no structure and routing; a service article is ignored", () => {
    const r = planMissingComponents(
      input({
        needs: [
          { articleId: R, needDate: "2030-03-22", uncovered: 3 },
          { articleId: "art-v", needDate: "2030-03-22", uncovered: 1 },
          { articleId: "art-b", needDate: "2030-03-22", uncovered: 1 },
          { articleId: "art-n", needDate: "2030-03-22", uncovered: 1 },
          { articleId: SVC, needDate: "2030-03-22", uncovered: 1 },
          { articleId: H, needDate: "2030-03-22", uncovered: 1 },
        ],
        articleList: [
          article(R, { type: "purchased" }),
          article("art-v", { configuratorMode: "variants" }),
          article("art-b", { configuratorMode: "to_order" }),
          article("art-n", { hasRouting: false }),
          article(SVC, { type: "service" }),
          article(H),
          article(S, { hasRouting: false }),
        ],
        edges: [edge(H, S), edge(S, R)],
      })
    );
    expect(r.orders.map((o) => [o.articleId, o.level])).toEqual([
      [H, 1],
      // S has a structure (R), so it is made even without a routing.
      [S, 2],
    ]);
    expect(r.notes).toEqual([
      "B är en beställningsvara — skapas från kundorderraden",
      "N saknar beredning — ingen tillverkningsorder utan struktur och rutt",
      "R köps (3 st saknas) — syns i Behovsberäkningen",
      "V är en variantmall — välj en variant",
      "R köps (1 st saknas) — syns i Behovsberäkningen",
    ]);
  });

  it("an undated need gives undated TOs all the way down, said once", () => {
    const r = planMissingComponents(input({ needs: [{ articleId: H, needDate: null, uncovered: 2 }] }));
    expect(r.orders.map(slim)).toEqual([
      { articleId: H, level: 1, quantity: 2, dueDate: null, late: false, needDate: null, parentKey: null },
      { articleId: S, level: 2, quantity: 2, dueDate: null, late: false, needDate: null, parentKey: r.orders[0]!.key },
    ]);
    expect(r.notes).toEqual(["Behovet saknar datum — de nya tillverkningsordrarna får inget färdigdatum", "R köps (2 st saknas) — syns i Behovsberäkningen"]);
  });

  it("the floor today + lead time wins when the need is too close: late, with Skapa ordrar's warning text", () => {
    // Need Tue 03-05: the working day before is today, the floor with lead
    // 3 is Thu 03-07.
    const r = planMissingComponents(input({ needs: [{ articleId: H, needDate: "2030-03-05", uncovered: 1 }], lead: 3 }));
    expect(r.orders.map(slim)).toEqual([
      { articleId: H, level: 1, quantity: 1, dueDate: "2030-03-07", late: true, needDate: "2030-03-05", parentKey: null },
      // H starts 03-04 (07 − 3 working days); S is late too.
      { articleId: S, level: 2, quantity: 1, dueDate: "2030-03-07", late: true, needDate: "2030-03-04", parentKey: r.orders[0]!.key },
    ]);
    expect(lateWarning(r.orders[0]!)).toBe("H: Färdigdatumet (2030-03-07) hinner inte före behovet (2030-03-05)");
  });

  it("the lead time is asked for the rounded quantity of each new TO", () => {
    const asked: [string, number][] = [];
    planMissingComponents(
      input({
        articleList: [article(H, { orderQuantity: 10 }), article(S), article(R, { type: "purchased" })],
        leadDaysFor: (id, q) => {
          asked.push([id, q]);
          return 1;
        },
      })
    );
    expect(asked).toEqual([
      [H, 10],
      [S, 10],
    ]);
  });

  it("cycle guard on the article path, and a depth cap with a note", () => {
    const cyclic = planMissingComponents(input({ edges: [edge(H, S), edge(S, H)], articleList: [article(H), article(S)] }));
    expect(cyclic.orders.map((o) => [o.articleId, o.level])).toEqual([
      [H, 1],
      [S, 2],
    ]);
    expect(cyclic.notes).toEqual(["H ingår i sin egen struktur (P → H → S) — hoppas över"]);

    const deep = planMissingComponents(input({ maxDepth: 1 }));
    expect(deep.orders.map((o) => o.articleId)).toEqual([H]);
    expect(deep.notes).toEqual(["Strukturen är djupare än 1 nivåer — nivåerna under H visas inte"]);
  });

  it("phantoms are dissolved into the new TO's demand", () => {
    const r = planMissingComponents(
      input({
        edges: [edge(H, "art-ph", 2), edge("art-ph", S, 3)],
        phantomIds: new Set(["art-ph"]),
        articleList: [article(H), article(S)],
      })
    );
    expect(r.orders.map((o) => [o.articleId, o.level, o.quantity])).toEqual([
      [H, 1, 2],
      [S, 2, 12],
    ]);
  });
});

describe("sameMissingOrders / creationOrder", () => {
  it("compares the tree as a multiset of (articleId, quantity, level) at four decimals", () => {
    const computed = [
      { articleId: H, quantity: 2, level: 1 },
      { articleId: S, quantity: 0.1 + 0.2, level: 2 },
    ];
    expect(sameMissingOrders(computed, [{ articleId: S, quantity: 0.3, level: 2 }, { articleId: H, quantity: 2, level: 1 }])).toBe(true);
    expect(sameMissingOrders(computed, [{ articleId: H, quantity: 2, level: 1 }])).toBe(false);
    expect(sameMissingOrders(computed, [{ articleId: H, quantity: 3, level: 1 }, { articleId: S, quantity: 0.3, level: 2 }])).toBe(false);
    expect(sameMissingOrders(computed, [{ articleId: H, quantity: 2, level: 2 }, { articleId: S, quantity: 0.3, level: 1 }])).toBe(false);
    expect(sameMissingOrders([], [])).toBe(true);
  });

  it("creates the deepest level first, stable within a level", () => {
    const r = planMissingComponents(
      input({
        needs: [
          { articleId: H, needDate: "2030-03-22", uncovered: 1 },
          { articleId: H2, needDate: "2030-03-22", uncovered: 1 },
        ],
        articleList: [article(H), article(H2), article(S)],
        edges: [edge(H, S), edge(H2, "art-s2")].concat([]),
      })
    );
    expect(creationOrder(r.orders).map((o) => [o.articleId, o.level])).toEqual([
      [S, 2],
      [H, 1],
      [H2, 1],
    ]);
  });
});
