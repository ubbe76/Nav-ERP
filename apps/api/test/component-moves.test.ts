import { describe, expect, it } from "vitest";
import { buildArticleOverview, type ArticleOverviewInput } from "../src/modules/planning/service/article-overview.js";
import { pegOverview, type PegDemand } from "../src/modules/planning/service/pegging.js";
import {
  compareMoves,
  flattenMoves,
  moveCandidates,
  recordEarlierNeed,
  redateParentDemands,
  suggestMove,
  withEarliestNeed,
  type CoverageMove,
  type MoveCandidate,
} from "../src/modules/planning/service/component-moves.js";

// Pure tests — no database. Flytta halvfabrikaten (pegging #9, etapp 2):
// which TO supplies are candidates for a parent, the exclusive/preselected
// rule, the earliest-of-ALL-demands rule, the suggestion's reasons and
// floor, the chain's re-dating and the flat depth-first order.

const TODAY = "2030-03-04"; // Monday
const NO_HOLIDAYS = new Set<string>();
const ARTICLE = { articleId: "h", articleNumber: "H-1" };

function overview(partial: Partial<ArticleOverviewInput>) {
  return buildArticleOverview({
    article: {
      articleId: "h",
      articleNumber: "H-1",
      name: "Halvfabrikat",
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

function materialRow(rowId: string, moId: string, orderNumber: string, needDate: string | null, quantity: number) {
  return {
    rowId,
    moId,
    orderNumber,
    orderStatus: "released" as const,
    dueDate: needDate,
    needDate,
    parentArticleId: `parent-${moId}`,
    parentArticleNumber: "P",
    parentArticleName: "Produkt",
    quantityPlanned: quantity,
    quantityConsumed: 0,
  };
}

function mo(moId: string, orderNumber: string, dueDate: string | null, quantity: number) {
  return { moId, orderNumber, status: "released" as const, dueDate, quantity };
}

const demandOf = (parentMoId: string) => (d: PegDemand) => d.row?.documentId === parentMoId;

describe("moveCandidates", () => {
  it("lists the TO supplies covering the parent's demands, exclusive when all of the TO goes to the parent", () => {
    // A needs 6 on 03-15, B needs 6 on 03-22; C1 (10, due 03-18) covers A
    // and 4 of B; C2 (2, due 03-25) covers the rest of B.
    const o = overview({
      materialRows: [materialRow("a", "A", "TO-A", "2030-03-15", 6), materialRow("b", "B", "TO-B", "2030-03-22", 6)],
      manufacturingOrders: [mo("C1", "TO-C1", "2030-03-18", 10), mo("C2", "TO-C2", "2030-03-25", 2)],
    });
    const pegging = pegOverview(o, { today: TODAY, readyDates: new Map() });
    expect(moveCandidates(pegging, ARTICLE, demandOf("A"))).toEqual([
      {
        manufacturingOrderId: "C1",
        orderNumber: "TO-C1",
        articleId: "h",
        articleNumber: "H-1",
        currentDueDate: "2030-03-18",
        earliestNeed: "2030-03-15",
        exclusive: false,
        lateForParent: true,
      },
    ]);
    // For B: C1 is shared (earliest need is A's), C2 exclusive and late.
    expect(moveCandidates(pegging, ARTICLE, demandOf("B"))).toEqual([
      expect.objectContaining({ manufacturingOrderId: "C1", earliestNeed: "2030-03-15", exclusive: false, lateForParent: false }),
      expect.objectContaining({ manufacturingOrderId: "C2", currentDueDate: "2030-03-25", earliestNeed: "2030-03-22", exclusive: true, lateForParent: true }),
    ]);
    // A TO that covers nothing of the parent's is no candidate.
    expect(moveCandidates(pegging, ARTICLE, demandOf("X"))).toEqual([]);
  });

  it("an undated demand does not set the earliest need; stock is never a candidate", () => {
    const o = overview({
      onHand: 1,
      materialRows: [materialRow("a", "A", "TO-A", null, 2)],
      manufacturingOrders: [mo("C", "TO-C", null, 5)],
    });
    const pegging = pegOverview(o, { today: TODAY, readyDates: new Map() });
    expect(moveCandidates(pegging, ARTICLE, demandOf("A"))).toEqual([
      expect.objectContaining({ manufacturingOrderId: "C", currentDueDate: null, earliestNeed: null, exclusive: true, lateForParent: false }),
    ]);
  });
});

describe("suggestMove", () => {
  const candidate = (over: Partial<MoveCandidate>): MoveCandidate => ({
    manufacturingOrderId: "C",
    orderNumber: "TO-C",
    articleId: "h",
    articleNumber: "H-1",
    currentDueDate: "2030-03-27",
    earliestNeed: "2030-03-22",
    exclusive: true,
    lateForParent: true,
    ...over,
  });
  const opts = { today: TODAY, offDays: NO_HOLIDAYS, leadDays: 1 };

  it("suggests the working day before the earliest need; late for the parent ⇒ reason late", () => {
    expect(suggestMove(candidate({}), opts)).toEqual({ suggestedDueDate: "2030-03-21", late: false, reason: "late" });
    // Need on a Monday ⇒ the Friday before.
    expect(suggestMove(candidate({ earliestNeed: "2030-03-25" }), opts)).toMatchObject({ suggestedDueDate: "2030-03-22" });
  });

  it("not late but due after the need ⇒ needed_earlier; due before the need ⇒ later_possible; no due date ⇒ undated", () => {
    expect(suggestMove(candidate({ lateForParent: false }), opts)).toMatchObject({ reason: "needed_earlier" });
    expect(suggestMove(candidate({ currentDueDate: "2030-03-10", lateForParent: false }), opts)).toMatchObject({ suggestedDueDate: "2030-03-21", reason: "later_possible" });
    expect(suggestMove(candidate({ currentDueDate: null, lateForParent: false }), opts)).toMatchObject({ reason: "undated" });
  });

  it("late through the plan (the due date already before the need) ⇒ no later date — it would lower the TO's priority in Planera", () => {
    // Due 03-10, need 03-22, but the plan finishes after the need (late):
    // the suggestion 03-21 would move the due date LATER — nothing.
    expect(suggestMove(candidate({ currentDueDate: "2030-03-10", lateForParent: true }), opts)).toBeNull();
    // Late and due after the need ⇒ earlier, as before.
    expect(suggestMove(candidate({ currentDueDate: "2030-03-27", lateForParent: true }), opts)).toMatchObject({ reason: "late" });
  });

  it("nothing to move when the TO already has the suggested date or no demand is dated", () => {
    expect(suggestMove(candidate({ currentDueDate: "2030-03-21", lateForParent: false }), opts)).toBeNull();
    expect(suggestMove(candidate({ earliestNeed: null }), opts)).toBeNull();
  });

  it("floors at today + the lead time and says late (hinner inte) — when the floor is still earlier than the due date", () => {
    // 20 working days from Monday 03-04 = Monday 04-01, after the need 03-22
    // but before the due date 04-10: earlier, though not in time.
    const late = suggestMove(candidate({ currentDueDate: "2030-04-10" }), { ...opts, leadDays: 20 });
    expect(late).toEqual({ suggestedDueDate: "2030-04-01", late: true, reason: "late" });
    // A full-day holiday pushes the floor one day.
    expect(suggestMove(candidate({ currentDueDate: "2030-04-10" }), { ...opts, leadDays: 20, offDays: new Set(["2030-03-29"]) })).toMatchObject({ suggestedDueDate: "2030-04-02", late: true });
    // The floor after the late TO's due date (03-27) would be a later date —
    // nothing (it would only lower the TO's priority in Planera).
    expect(suggestMove(candidate({}), { ...opts, leadDays: 20 })).toBeNull();
  });
});

describe("the shared-TO fixpoint: withEarliestNeed and recordEarlierNeed", () => {
  const c = (earliestNeed: string | null): MoveCandidate => ({
    manufacturingOrderId: "mo-s",
    orderNumber: "TO-3",
    articleId: "s",
    articleNumber: "S-1",
    currentDueDate: "2030-03-26",
    earliestNeed,
    exclusive: false,
    lateForParent: true,
  });

  it("withEarliestNeed pulls the need forward to an earlier override only — the same object otherwise", () => {
    const dated = c("2030-03-22");
    expect(withEarliestNeed(dated, undefined)).toBe(dated);
    expect(withEarliestNeed(dated, "2030-03-22")).toBe(dated);
    expect(withEarliestNeed(dated, "2030-03-25")).toBe(dated);
    expect(withEarliestNeed(dated, "2030-03-20")).toEqual({ ...dated, earliestNeed: "2030-03-20" });
    expect(withEarliestNeed(c(null), "2030-03-20")).toEqual({ ...c(null), earliestNeed: "2030-03-20" });
  });

  it("recordEarlierNeed lowers the override for an earlier find and reports the change; nothing for undated, equal, later or already-lower", () => {
    const overrides = new Map<string, string>();
    expect(recordEarlierNeed(overrides, "mo-s", "2030-03-22", null)).toBe(false);
    expect(recordEarlierNeed(overrides, "mo-s", "2030-03-22", "2030-03-22")).toBe(false);
    expect(recordEarlierNeed(overrides, "mo-s", "2030-03-22", "2030-03-25")).toBe(false);
    expect(overrides.size).toBe(0);
    expect(recordEarlierNeed(overrides, "mo-s", "2030-03-22", "2030-03-20")).toBe(true);
    expect(overrides.get("mo-s")).toBe("2030-03-20");
    // The next pass suggests from 03-20; a find of 03-21 is not earlier.
    expect(recordEarlierNeed(overrides, "mo-s", "2030-03-20", "2030-03-21")).toBe(false);
    expect(recordEarlierNeed(overrides, "mo-s", "2030-03-20", "2030-03-18")).toBe(true);
    expect(overrides.get("mo-s")).toBe("2030-03-18");
    // A TO suggested from no dated need at all takes any dated find.
    expect(recordEarlierNeed(overrides, "mo-u", null, "2030-04-01")).toBe(true);
    expect(overrides.get("mo-u")).toBe("2030-04-01");
  });
});

describe("redateParentDemands", () => {
  it("moves the parent's material rows to the new start, re-sorts and recomputes the balance; untouched overviews come back as is", () => {
    const o = overview({
      onHand: 3,
      materialRows: [materialRow("a", "A", "TO-A", "2030-03-15", 6), materialRow("b", "B", "TO-B", "2030-03-22", 6)],
      manufacturingOrders: [mo("C", "TO-C", "2030-03-18", 10)],
    });
    expect(o.rows.map((r) => r.id)).toEqual(["mat:a", "mo:C", "mat:b"]);
    expect(redateParentDemands(o, new Map([["X", "2030-03-01"]]))).toBe(o);
    expect(redateParentDemands(o, new Map([["A", "2030-03-15"]]))).toBe(o);

    const redated = redateParentDemands(o, new Map([["A", "2030-03-25"]]));
    expect(redated).not.toBe(o);
    expect(redated.rows.map((r) => [r.id, r.date, r.balance])).toEqual([
      ["mo:C", "2030-03-18", 13],
      ["mat:b", "2030-03-22", 7],
      ["mat:a", "2030-03-25", 1],
    ]);
    expect(redated.closingBalance).toBe(1);
    // The input is untouched.
    expect(o.rows.map((r) => r.id)).toEqual(["mat:a", "mo:C", "mat:b"]);
    // Undated start = undated row, last.
    expect(redateParentDemands(o, new Map([["A", null]])).rows.map((r) => r.id)).toEqual(["mo:C", "mat:b", "mat:a"]);
  });
});

describe("flattenMoves", () => {
  const move = (id: string, parentMoveId: string | null, level: number, articleNumber: string, orderNumber: string): CoverageMove => ({
    id: `mv:${id}`,
    parentMoveId,
    manufacturingOrderId: id,
    orderNumber,
    articleId: `art-${articleNumber}`,
    articleNumber,
    level,
    currentDueDate: null,
    suggestedDueDate: "2030-03-21",
    late: false,
    exclusive: true,
    preselected: true,
    reason: "undated",
  });

  it("level 1 by article number then order number, each parent's children right after it", () => {
    const flat = flattenMoves([
      move("g2", "mv:c2", 2, "S-1", "TO-2"),
      move("c2", null, 1, "H-10", "TO-9"),
      move("c1", null, 1, "H-2", "TO-5"),
      move("g1", "mv:c1", 2, "S-1", "TO-1"),
      move("c3", null, 1, "H-2", "TO-3"),
      move("x", "mv:g1", 3, "R-1", "TO-7"),
    ]);
    expect(flat.map((m) => m.id)).toEqual(["mv:c3", "mv:c1", "mv:g1", "mv:x", "mv:c2", "mv:g2"]);
  });

  it("compareMoves is numeric on both numbers", () => {
    expect([move("a", null, 1, "H-10", "TO-1"), move("b", null, 1, "H-2", "TO-1"), move("c", null, 1, "H-2", "TO-10"), move("d", null, 1, "H-2", "TO-9")].sort(compareMoves).map((m) => m.manufacturingOrderId)).toEqual(["b", "d", "c", "a"]);
  });
});
