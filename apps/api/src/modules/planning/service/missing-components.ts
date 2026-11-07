// Skapa saknade halvfabrikat (pegging #9, etapp 3): the tree of TOs that
// would cover what a parent TO's material needs are left without. Pure like
// pegging.ts and component-moves.ts: the planning service loads the
// parent's pegged needs, the reachable articles' overviews, the BOM edges,
// the lead-time rules and the holiday register — this module owns the rules.
//
// Level 1: each manufactured article among the parent's needs with
// `uncovered > 0` (the parent's rows of one article are summed — they share
// the need date, the parent's start). The quantity is orderQuantityFor
// (requirements-calc.ts: the order-quantity multiple, then Avrundning — ONE
// rule with the behovsberäkning's proposal). The due date is suggestDueDate
// from the need date with the new order's lead time for that quantity (the
// article's Ledtid field, else its routing — the färdigdatumsförslag's
// rule); the floor today + lead time ⇒ `late` (hinner inte). An undated
// need gives an undated TO, and its children are undated too.
//
// Deeper levels, breadth first: a new TO starts due date − lead time
// working days (moStartDate's base rule — it has no plan yet) and its one-
// level explosion (phantoms dissolved, DEMAND_BOM_ROWS edges) is needed on
// that start. Netting is quantity-based like the behovsberäkning, all
// existing supply pooled: a running balance per article starts at the
// overview's closingBalance. A level-1 shortage is already inside that
// balance, so creating q just adds q; a NEW demand d takes
// clamp(balance, 0, d), the rest is the shortage, and the balance moves by
// −d (+q when a TO is made). An existing shortage of OTHER demands is thus
// never created for here, and a rounding surplus covers a later new demand
// of the same article. Purchased components get a note (the behovsberäkning
// owns them), service articles nothing.
//
// Never a TO the create would refuse: a variants template (prepareCreate's
// assertOrderableArticle), a beställningsvara (needs a configuration), or an
// article without structure and routing (the Leveranstidskontroll's "saknar
// beredning" — no TO without operations) gets a note instead. Cycle guard on
// the article path; MISSING_MAX_DEPTH bounds the tree.
import type { BomEdge } from "./requirements-calc.js";
import { explodeFromIndex, orderQuantityFor } from "./requirements-calc.js";
import { suggestDueDate } from "./due-date-suggestion.js";
import { subtractWorkingDays } from "../../system/service/delivery-days.js";

export const MISSING_MAX_DEPTH = 10;

export interface MissingArticle {
  articleId: string;
  articleNumber: string;
  name: string;
  type: "manufactured" | "purchased" | "service";
  unitCode: string | null; // the base unit, for the notes
  orderQuantity: number | null;
  rounding: number | null;
  // The overview's closing balance: stock plus every open supply minus
  // every open demand — the pool the new demands are netted against.
  closingBalance: number;
  configuratorMode: "variants" | "to_order" | null;
  // Worked (non-Kalkyl) routing operations exist.
  hasRouting: boolean;
}

// One of the parent's needs in a component article's pegging.
export interface MissingNeed {
  articleId: string;
  needDate: string | null;
  uncovered: number;
}

export interface MissingOrderRow {
  key: string;
  parentKey: string | null; // null = level 1 (a component of the parent TO)
  level: number;
  articleId: string;
  articleNumber: string;
  articleName: string;
  quantity: number;
  dueDate: string | null; // null = the need is undated
  late: boolean; // the due date is the floor — the TO cannot make the need
  needDate: string | null;
}

export interface MissingComponentsPreview {
  orders: MissingOrderRow[];
  notes: string[];
}

export interface MissingComponentsInput {
  parent: { articleId: string; articleNumber: string };
  today: string;
  offDays: ReadonlySet<string>;
  needs: MissingNeed[];
  // Every article the tree can reach (the parent's needs and their
  // explosions). An article not in the map is skipped with a note.
  articles: ReadonlyMap<string, MissingArticle>;
  bomIndex: Map<string, BomEdge[]>;
  phantomIds: Set<string>;
  // The lead time a new TO of `quantity` is dated with.
  leadDaysFor: (articleId: string, quantity: number) => number;
  maxDepth?: number;
}

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;

const formatQuantity = (n: number) => String(round4(n));

// The warning text for a late row — the same as Skapa ordrar's for a TO.
export function lateWarning(row: MissingOrderRow): string {
  return `${row.articleNumber}: Färdigdatumet (${row.dueDate}) hinner inte före behovet (${row.needDate})`;
}

// Why an article gets a note instead of a TO (null = it can be made).
function refusal(article: MissingArticle, bomIndex: Map<string, BomEdge[]>): string | null {
  if (article.configuratorMode === "variants") return `${article.articleNumber} är en variantmall — välj en variant`;
  if (article.configuratorMode === "to_order") return `${article.articleNumber} är en beställningsvara — skapas från kundorderraden`;
  if ((bomIndex.get(article.articleId)?.length ?? 0) === 0 && !article.hasRouting) {
    return `${article.articleNumber} saknar beredning — ingen tillverkningsorder utan struktur och rutt`;
  }
  return null;
}

export function planMissingComponents(input: MissingComponentsInput): MissingComponentsPreview {
  const maxDepth = input.maxDepth ?? MISSING_MAX_DEPTH;
  const notes: string[] = [];
  const noted = new Set<string>();
  const note = (text: string) => {
    if (noted.has(text)) return;
    noted.add(text);
    notes.push(text);
  };
  const balances = new Map<string, number>();
  const balanceOf = (a: MissingArticle) => balances.get(a.articleId) ?? a.closingBalance;
  const orders: MissingOrderRow[] = [];
  let counter = 0;
  const byNumber = (a: MissingArticle, b: MissingArticle) => a.articleNumber.localeCompare(b.articleNumber, "sv", { numeric: true });

  // A TO row for a shortage of `article`, dated from `needDate` (null =
  // undated). Returns the row and what it starts on.
  type Pending = { row: MissingOrderRow; article: MissingArticle; start: string | null; path: string[] };
  function make(article: MissingArticle, shortage: number, needDate: string | null, parent: Pending | null, level: number, path: string[]): Pending {
    const quantity = orderQuantityFor(shortage, article);
    balances.set(article.articleId, round4(balanceOf(article) + quantity));
    const leadDays = Math.max(0, input.leadDaysFor(article.articleId, quantity));
    let dueDate: string | null = null;
    let late = false;
    if (needDate !== null) {
      const s = suggestDueDate(
        { date: needDate, source: "shortage", documentType: null, documentId: null, documentNumber: null },
        { today: input.today, offDays: input.offDays, leadDays }
      );
      dueDate = s.dueDate;
      late = s.late;
    } else {
      note("Behovet saknar datum — de nya tillverkningsordrarna får inget färdigdatum");
    }
    counter += 1;
    const row: MissingOrderRow = {
      key: `mc:${counter}`,
      parentKey: parent?.row.key ?? null,
      level,
      articleId: article.articleId,
      articleNumber: article.articleNumber,
      articleName: article.name,
      quantity,
      dueDate,
      late,
      needDate,
    };
    orders.push(row);
    return { row, article, start: dueDate === null ? null : subtractWorkingDays(dueDate, leadDays, input.offDays), path };
  }

  // Level 1: the parent's uncovered needs, summed per article (one need
  // date — the parent's start).
  const level1 = new Map<string, { uncovered: number; needDate: string | null }>();
  for (const n of input.needs) {
    if (n.uncovered <= 0) continue;
    const prev = level1.get(n.articleId);
    if (prev) {
      prev.uncovered = round4(prev.uncovered + n.uncovered);
      if (prev.needDate === null || (n.needDate !== null && n.needDate < prev.needDate)) prev.needDate = n.needDate;
    } else level1.set(n.articleId, { uncovered: n.uncovered, needDate: n.needDate });
  }
  let pending: Pending[] = [];
  const level1Articles = [...level1.keys()].flatMap((id) => (input.articles.has(id) ? [input.articles.get(id)!] : [])).sort(byNumber);
  for (const article of level1Articles) {
    const need = level1.get(article.articleId)!;
    if (article.type === "service") continue;
    if (article.type === "purchased") {
      note(`${article.articleNumber} köps (${formatQuantity(need.uncovered)} ${article.unitCode ?? "st"} saknas) — syns i Behovsberäkningen`);
      continue;
    }
    const refused = refusal(article, input.bomIndex);
    if (refused) {
      note(refused);
      continue;
    }
    // The uncovered quantity is already inside the closing balance: the new
    // TO only adds.
    pending.push(make(article, need.uncovered, need.needDate, null, 1, [input.parent.articleId, article.articleId]));
  }

  // Deeper levels, breadth first: every new TO's explosion on its start.
  for (let level = 2; pending.length > 0; level++) {
    const next: Pending[] = [];
    if (level > maxDepth) {
      note(`Strukturen är djupare än ${maxDepth} nivåer — nivåerna under ${pending.map((p) => p.article.articleNumber).join(", ")} visas inte`);
      break;
    }
    for (const p of pending) {
      const needs = explodeFromIndex(input.bomIndex, input.phantomIds, p.article.articleId, p.row.quantity);
      const children = [...needs]
        .flatMap(([id, d]) => (d > 0 && input.articles.has(id) ? [{ article: input.articles.get(id)!, demand: round4(d) }] : []))
        .sort((a, b) => byNumber(a.article, b.article));
      for (const { article, demand } of children) {
        if (article.type === "service") continue;
        if (p.path.includes(article.articleId)) {
          const numberOf = (id: string) => (id === input.parent.articleId ? input.parent.articleNumber : (input.articles.get(id)?.articleNumber ?? id));
          note(`${article.articleNumber} ingår i sin egen struktur (${p.path.map(numberOf).join(" → ")}) — hoppas över`);
          continue;
        }
        const balance = balanceOf(article);
        const take = Math.min(Math.max(balance, 0), demand);
        const shortage = round4(demand - take);
        balances.set(article.articleId, round4(balance - demand));
        if (shortage <= 0) continue;
        if (article.type === "purchased") {
          note(`${article.articleNumber} köps (${formatQuantity(shortage)} ${article.unitCode ?? "st"} saknas) — syns i Behovsberäkningen`);
          continue;
        }
        const refused = refusal(article, input.bomIndex);
        if (refused) {
          note(refused);
          continue;
        }
        next.push(make(article, shortage, p.start, p, level, [...p.path, article.articleId]));
      }
    }
    pending = next;
  }
  return { orders, notes };
}

// The multiset the client saw vs the one computed under the lock: the same
// (articleId, quantity at 4 decimals, level) triples in any order.
export function sameMissingOrders(
  computed: readonly Pick<MissingOrderRow, "articleId" | "quantity" | "level">[],
  expected: readonly { articleId: string; quantity: number; level: number }[]
): boolean {
  const key = (o: { articleId: string; quantity: number; level: number }) => `${o.level}:${o.articleId}:${round4(o.quantity).toFixed(4)}`;
  const a = computed.map(key).sort();
  const b = expected.map(key).sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

// Children before parents: deepest level first, stable within a level.
export function creationOrder(orders: readonly MissingOrderRow[]): MissingOrderRow[] {
  return [...orders].sort((a, b) => b.level - a.level);
}
