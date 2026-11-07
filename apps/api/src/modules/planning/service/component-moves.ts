// Flytta halvfabrikaten (pegging #9, etapp 2): the rules behind the TO
// card's move rows — which TO supplies cover a parent's material needs,
// what färdigdatum each of them should have, and how a moved TO's own
// material needs are re-dated for the next level of the chain. Pure like
// pegging.ts: the planning service loads the peggings, the lead times and
// the holiday register, this module owns the rules.
//
// A candidate is a TO C with an allocation to one of the parent's demands.
// Its suggested due date is suggestDueDate (due-date-suggestion.ts — the
// working day before the need, floored at today + C's lead time, `late` when
// the floor wins) from the EARLIEST dated demand among ALL demands C covers,
// not only the parent's: a move must never make C late for another of its
// demands. A candidate whose demands are all undated gets no suggestion.
//
// `exclusive` = every unit C is allocated to goes to the parent's demands;
// such a row is preselected in the dialog (user decision 2026-11-07: a TO
// that also feeds other demands is shown but not preselected).
//
// `reason` says why the row is there: "late" — C is late for one of the
// parent's demands (pegging's rule) and the suggestion is earlier (a late C
// whose due date already lies before the need is late through the plan —
// no row, a later date would only lower its priority in Planera);
// "needed_earlier" — C is not late (its plan finishes early) but its due
// date lies after the need; "later_possible" — the need moved out, C may be
// due later; "undated" — C has no due date yet.
import { compareOverviewRows, type ArticleOverview, type ArticleOverviewRow } from "./article-overview.js";
import { suggestDueDate } from "./due-date-suggestion.js";
import type { PegDemand, Pegging } from "./pegging.js";

export type MoveReason = "late" | "needed_earlier" | "later_possible" | "undated";

export interface CoverageMove {
  id: string; // "mv:<manufacturingOrderId>" — a TO is listed once in the tree
  parentMoveId: string | null; // null = level 1 (a child of the card's TO)
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  level: number; // 1 = the card's TO's halvfabrikat, 2 = theirs, …
  currentDueDate: string | null;
  suggestedDueDate: string;
  late: boolean; // the suggestion is the floor — C cannot make the need ("hinner inte")
  exclusive: boolean;
  preselected: boolean;
  reason: MoveReason;
}

// A TO supply covering one of the parent's demands, before the suggestion.
export interface MoveCandidate {
  manufacturingOrderId: string;
  orderNumber: string;
  articleId: string;
  articleNumber: string;
  currentDueDate: string | null; // the supply row's date = due_date
  // The earliest dated demand among every demand the TO covers; null = all
  // of them undated.
  earliestNeed: string | null;
  exclusive: boolean;
  lateForParent: boolean;
}

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

// The TO supplies in one article's pegging that cover a demand `isParentDemand`
// accepts, in supply order.
export function moveCandidates(
  pegging: Pegging,
  article: { articleId: string; articleNumber: string },
  isParentDemand: (demand: PegDemand) => boolean
): MoveCandidate[] {
  const demandById = new Map(pegging.demands.map((d) => [d.id, d]));
  const out: MoveCandidate[] = [];
  for (const supply of pegging.supplies) {
    if (supply.kind !== "manufacturing_order" || !supply.row) continue;
    let toParent = 0;
    let total = 0;
    let earliest: string | null = null;
    let lateForParent = false;
    for (const a of supply.allocations) {
      const demand = demandById.get(a.demandId);
      if (!demand) continue;
      total += a.quantity;
      if (demand.date !== null && (earliest === null || demand.date < earliest)) earliest = demand.date;
      if (isParentDemand(demand)) {
        toParent += a.quantity;
        if (a.late) lateForParent = true;
      }
    }
    if (round4(toParent) <= 0) continue;
    out.push({
      manufacturingOrderId: supply.row.documentId,
      orderNumber: supply.row.documentNumber,
      articleId: article.articleId,
      articleNumber: article.articleNumber,
      currentDueDate: supply.row.date,
      earliestNeed: earliest,
      exclusive: round4(toParent) >= round4(total),
      lateForParent,
    });
  }
  return out;
}

// The suggestion for one candidate; null = nothing to move (no dated need,
// or the suggested date is the one it already has).
export function suggestMove(
  c: MoveCandidate,
  opts: { today: string; offDays: ReadonlySet<string>; leadDays: number }
): Pick<CoverageMove, "suggestedDueDate" | "late" | "reason"> | null {
  if (c.earliestNeed === null) return null;
  const s = suggestDueDate(
    { date: c.earliestNeed, source: "shortage", documentType: null, documentId: null, documentNumber: null },
    opts
  );
  if (s.dueDate === c.currentDueDate) return null;
  // Late for the parent although the due date already lies before the need:
  // the plan (capacity) makes C late, not its date — a later due date would
  // only lower C's priority in Planera. Nothing to suggest; Beläggning is
  // where that is fixed.
  if (c.lateForParent && c.currentDueDate !== null && s.dueDate > c.currentDueDate) return null;
  const reason: MoveReason =
    c.currentDueDate === null ? "undated" : c.lateForParent ? "late" : s.dueDate < c.currentDueDate ? "needed_earlier" : "later_possible";
  return { suggestedDueDate: s.dueDate, late: s.late, reason };
}

// The chain: a moved TO starts on another day, so its material needs (its
// mo_material / mo_planned_material rows in the component articles'
// overviews) sit on that day instead — `starts` is computeMoStartDates'
// result for the moved TOs with their suggested due dates. The rows are
// re-sorted (compareOverviewRows) and the running balance recomputed; the
// same object comes back when nothing changed.
export function redateParentDemands(overview: ArticleOverview, starts: ReadonlyMap<string, string | null>): ArticleOverview {
  let changed = false;
  const rows: ArticleOverviewRow[] = overview.rows.map((row) => {
    if ((row.kind === "mo_material" || row.kind === "mo_planned_material") && starts.has(row.documentId)) {
      const date = starts.get(row.documentId) ?? null;
      if (date !== row.date) {
        changed = true;
        return { ...row, date };
      }
    }
    return row;
  });
  if (!changed) return overview;
  rows.sort(compareOverviewRows);
  let balance = overview.onHand;
  const rebalanced = rows.map((row) => {
    balance = round4(balance + row.quantity);
    return { ...row, balance };
  });
  return { ...overview, rows: rebalanced, closingBalance: balance };
}

// Level 1 by article number then order number; the same within a parent.
export function compareMoves(a: Pick<CoverageMove, "articleNumber" | "orderNumber">, b: Pick<CoverageMove, "articleNumber" | "orderNumber">): number {
  return (
    a.articleNumber.localeCompare(b.articleNumber, "sv", { numeric: true }) ||
    a.orderNumber.localeCompare(b.orderNumber, "sv", { numeric: true })
  );
}

// The flat list the API answers: depth-first, each parent's children right
// after it, siblings in compareMoves order — the web indents by level or
// trees up by parentMoveId.
export function flattenMoves(moves: readonly CoverageMove[]): CoverageMove[] {
  const children = new Map<string | null, CoverageMove[]>();
  for (const m of moves) {
    const list = children.get(m.parentMoveId);
    if (list) list.push(m);
    else children.set(m.parentMoveId, [m]);
  }
  const out: CoverageMove[] = [];
  const emit = (parentId: string | null) => {
    for (const m of [...(children.get(parentId) ?? [])].sort(compareMoves)) {
      out.push(m);
      emit(m.id);
    }
  };
  emit(null);
  return out;
}
