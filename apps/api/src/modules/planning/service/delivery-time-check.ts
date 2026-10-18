// Leveranstidskontroll — the earliest ship and delivery date for a set of
// rows (a sales order, the Ny kundorder form or the stand-alone page) from
// what already exists (the projected balance of stock and open orders after
// the demands already promised — available to promise), the lead time on
// what has to be bought, and free capacity per resource and week for what
// has to be made, all levels down.
//
// Pure, like capacity-calc.ts and article-overview.ts: the planning service
// loads flat rows (the overviews are already on ship dates) and this module
// owns every rule. Capacity is placed through the shared capacity book
// (capacity-book.ts — the same rule Planera uses), but the check itself
// writes nothing: the batches it returns are what a reservation creates
// TOs from.
import { roundUpToMultiple } from "@navet/shared";
import { explodeOneLevel, type BomEdge } from "./requirements-calc.js";
import type { ArticleOverviewRow } from "./article-overview.js";
import {
  mondayOf,
  type CapacityOperationRow,
  type DayScheduleNetRow,
  type HolidayRow,
  type PlannedWeek,
  type WeekScheduleDayRow,
} from "./capacity-calc.js";
import { createCapacityBook, type PlanWorkCenter } from "./capacity-book.js";
import {
  addWorkingDays,
  deliveryFromShipDate,
  nextWorkingDayOnOrAfter,
  suggestPurchaseDeliveryDate,
  type DeliverySettings,
} from "../../system/service/delivery-days.js";

export interface DtcArticle {
  articleId: string;
  articleNumber: string;
  name: string;
  type: "manufactured" | "purchased" | "service";
  rounding: number | null;
}

// Times in minutes (stored min/st, like routing_operations). Kalkyl
// (costing-only) operations are never worked and must not be passed in.
export interface DtcOperation {
  sequenceNo: number;
  workCenterId: string;
  description: string | null;
  setupTime: number;
  runTimePerUnit: number;
}

// The resource as the book sees it (code/name/calendar/factor/lead time).
export type DtcWorkCenter = PlanWorkCenter;

export interface DtcSupplier {
  supplierName: string;
  leadTimeDays: number | null;
  settings: DeliverySettings; // the supplier's effective delivery days
}

// A TO already linked to a configured row (an earlier reservation, Skapa TO
// from the row): what it makes is this row's, ready when the TO is — its
// planned finish day (the last planned week of its pending operations in
// `existingOperations`), else its due date, or at once when it is done.
export interface DtcLinkedOrder {
  manufacturingOrderId: string;
  orderNumber: string;
  quantity: number;
  dueDate: string | null;
  done: boolean; // finished goods — in stock for the row now
}

// A configured (beställningsvara) row brings its own derived structure; the
// template itself has no pool — a configuration is unique. The service
// rounds the shortage up to the article's step BEFORE deriving (the material
// totals are for the batch quantity), and nets the row's linked TOs with
// uncoveredConfiguredQuantity — the one implementation behovsberäkningen
// uses — so a row that already has its TO is never made twice.
export interface DtcStructure {
  quantity: number; // the batch to make (the TO's quantity); 0 = nothing to make
  operations: DtcOperation[];
  materials: { articleId: string; quantity: number }[]; // totals for `quantity`
  // What the linked TOs cover of the row's quantity, and the TOs themselves
  // (the critical chain names the one that makes the date).
  covered?: { quantity: number; orders: DtcLinkedOrder[] };
}

export interface DtcRowInput {
  key: string;
  articleId: string;
  quantity: number;
  structure?: DtcStructure;
  error?: string; // e.g. an invalid configuration — the row gets no date
}

export interface DeliveryTimeCheckInput {
  today: string;
  offDays: ReadonlySet<string>;
  articles: Map<string, DtcArticle>;
  // The article overview (already on ship dates) per article in the tree.
  overviews: Map<string, { onHand: number; rows: ArticleOverviewRow[] }>;
  // Checking an existing order: its own rows are not existing demand.
  excludeSalesOrderId: string | null;
  bomEdges: BomEdge[];
  phantomIds: Set<string>;
  routings: Map<string, DtcOperation[]>;
  workCenters: Map<string, DtcWorkCenter>;
  schedule: { weekScheduleDays: WeekScheduleDayRow[]; daySchedules: DayScheduleNetRow[]; holidays: HolidayRow[] };
  // The open operations — planned ones (plannedWeeks) count in their
  // planned weeks, the rest in their due date's week.
  existingOperations: CapacityOperationRow[];
  suppliers: Map<string, DtcSupplier>;
  customer: DeliverySettings | null;
  rows: DtcRowInput[];
}

export type DtcStep =
  | { kind: "stock"; articleNumber: string; quantity: number; date: string }
  | {
      kind: "supply";
      articleNumber: string;
      quantity: number;
      date: string;
      documentType: ArticleOverviewRow["documentType"];
      documentNumber: string;
      undated: boolean; // the order has no date — counted as available t0
      late: boolean; // the order's date is before t0 — `date` is its own date, the row is ready t0
      isDraft: boolean; // a draft IO — counted, like the requirements calculation does
    }
  | {
      kind: "purchase";
      articleNumber: string;
      quantity: number;
      date: string;
      supplierName: string | null;
      leadTimeDays: number | null;
    }
  | {
      kind: "operation";
      articleNumber: string;
      quantity: number;
      sequenceNo: number;
      description: string | null;
      workCenterCode: string;
      workCenterName: string;
      fromWeek: string; // Monday of the first week the operation books
      toWeek: string; // Monday of the week it finishes
      weeks: PlannedWeek[]; // the allocation (what was booked when the horizon was hit)
      date: string;
    }
  | {
      kind: "subcontract";
      articleNumber: string;
      quantity: number;
      sequenceNo: number;
      description: string | null;
      workCenterCode: string;
      workCenterName: string;
      leadTimeDays: number | null;
      date: string;
    };

export interface DtcRowResult {
  key: string;
  articleId: string;
  articleNumber: string;
  quantity: number;
  readyDate: string | null; // null = no date (horizon, invalid configuration)
  chain: DtcStep[]; // the critical path, earliest step first
  notes: string[];
}

// A shortage the check would make: one TO per batch. Level 1 is the row's
// own article, 2+ the semi-finished parts below it; children come before
// their parents (the order a reservation creates the TOs in). Only batches
// that got a date — a row that hits the horizon has no complete tree.
export interface DtcBatch {
  key: string; // unique within the result
  rowKey: string; // the row (sales order row) it is made for
  level: number;
  articleId: string;
  articleNumber: string;
  quantity: number; // rounded up to the article's step
  readyDate: string; // the TO's due date
  // Every operation of the batch in sequence order: the allocation to
  // write (lego, 0 minutes ⇒ []).
  operations: { sequenceNo: number; workCenterId: string; weeks: PlannedWeek[] }[];
}

export interface DeliveryTimeCheckResult {
  shipDate: string | null;
  deliveryDate: string | null; // = shipDate without a customer
  rows: DtcRowResult[];
  notes: string[];
  batches: DtcBatch[];
}

// What a node (an article quantity) resolves to: when it is ready and the
// critical chain behind that date. readyDate null = it can't be planned.
interface Resolution {
  readyDate: string | null;
  chain: DtcStep[];
}

const EPS = 1e-9;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
const maxDate = (a: string, b: string) => (a > b ? a : b);

// A row's notes. The repeating kinds — resources without a week schedule,
// undated supply, articles without a primary supplier, lego resources
// without lead time — are gathered and written as ONE note each: real data
// can name dozens, and a note per resource buries the result.
interface RowNotes {
  other: Set<string>;
  unscheduled: Set<string>; // resource codes without a capacity calendar
  undated: Set<string>; // document numbers of undated supply the row counts on
  late: Set<string>; // document numbers of supply dated before t0 the row counts on
  draft: Set<string>; // document numbers of draft IOs the row counts on
  noSupplier: Set<string>; // article numbers
  noPreparation: Set<string>; // made articles without structure and routing
  legoNoLead: Set<string>; // lego resource codes
}

const newRowNotes = (): RowNotes => ({
  other: new Set(),
  unscheduled: new Set(),
  undated: new Set(),
  late: new Set(),
  draft: new Set(),
  noSupplier: new Set(),
  noPreparation: new Set(),
  legoNoLead: new Set(),
});

// "a", "a och b", "a, b och c" — sorted so two loads read the same.
function swedishList(items: Set<string>): string {
  const list = [...items].sort((a, b) => a.localeCompare(b, "sv", { numeric: true }));
  return list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} och ${list[list.length - 1]}`;
}

function rowNoteTexts(n: RowNotes): string[] {
  const texts = [...n.other];
  const many = (set: Set<string>) => set.size > 1;
  if (n.unscheduled.size > 0) {
    texts.push(
      `${many(n.unscheduled) ? "Resurserna" : "Resurs"} ${swedishList(n.unscheduled)} saknar veckoschema och timmar per dag — kapaciteten räknas inte`
    );
  }
  if (n.legoNoLead.size > 0) {
    texts.push(
      `${many(n.legoNoLead) ? "Legoresurserna" : "Legoresurs"} ${swedishList(n.legoNoLead)} saknar ledtid — ${many(n.legoNoLead) ? "räknade" : "räknad"} som 0 dagar`
    );
  }
  if (n.noSupplier.size > 0) {
    texts.push(
      `${swedishList(n.noSupplier)} saknar huvudleverantör — ${many(n.noSupplier) ? "räknade som tillgängliga" : "räknad som tillgänglig"} direkt`
    );
  }
  if (n.noPreparation.size > 0) {
    texts.push(
      `${swedishList(n.noPreparation)} saknar beredning — ${many(n.noPreparation) ? "räknade som tillgängliga" : "räknad som tillgänglig"} direkt`
    );
  }
  if (n.undated.size > 0) {
    texts.push(
      `${swedishList(n.undated)} saknar datum — ${many(n.undated) ? "räknade som tillgängliga" : "räknad som tillgänglig"} direkt`
    );
  }
  if (n.late.size > 0) {
    texts.push(
      `${swedishList(n.late)} ${many(n.late) ? "är försenade — räknade som tillgängliga" : "är försenad — räknad som tillgänglig"} direkt`
    );
  }
  if (n.draft.size > 0) {
    texts.push(
      `${swedishList(n.draft)} ${many(n.draft) ? "är utkast — räknade som tillgång" : "är ett utkast — räknat som tillgång"}`
    );
  }
  return texts;
}

// --- The pool of one article: available to promise ------------------------
// Everything the overview knows about the article as dated events on the
// projected balance: stock (t0), open supply on its date, existing demand
// on its date (undated demand last, like the overview — it still counts),
// plus what this check has already taken and the rounding surplus it has
// created. What the check may take on a day D is the least projected
// balance on any day from D on — taking it never makes a later promise
// short. So an existing demand only blocks the supply that actually covers
// it; stock that a supply arriving before that demand replaces is free now.
const FAR = "9999-12-31"; // undated demand sorts here

type PoolSource =
  | { kind: "stock" }
  | {
      kind: "supply";
      documentType: ArticleOverviewRow["documentType"];
      documentNumber: string;
      date: string | null; // the order's own date
      undated: boolean;
      late: boolean;
      isDraft: boolean;
    }
  // The rest of a rounded-up shortage (purchase or batch) this check already
  // resolved: the next row or level takes it instead of buying/making again,
  // and points at the same chain.
  | { kind: "surplus"; chain: DtcStep[] };

interface PoolEvent {
  date: string; // ≥ t0
  delta: number; // + supply, − demand (existing or this check's own takes)
  source: PoolSource | null; // null = demand
}

const flagged = (e: PoolEvent) => e.source?.kind === "supply" && (e.source.undated || e.source.late || e.source.isDraft);

interface PoolTake {
  quantity: number; // what could be covered (≤ asked)
  date: string;
  chain: DtcStep[]; // the step that makes the date (stock, the order, or a surplus' chain)
  countsOn: Extract<PoolSource, { kind: "supply" }>[]; // flagged supply the coverage rests on
}

class ArticlePool {
  private readonly events: PoolEvent[] = []; // sorted by date, insertion order within a day

  constructor(private readonly t0: string) {}

  add(event: PoolEvent) {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.date > event.date) i--;
    this.events.splice(i, 0, event);
  }

  // The least projected balance on any day from `date` on. The balance is
  // read at the end of each day (receipts and withdrawals of the same day
  // net), so a supply and the demand it covers on the same day cancel.
  availableFrom(date: string, include: (e: PoolEvent) => boolean = () => true): number {
    let balance = 0;
    let i = 0;
    for (; i < this.events.length && this.events[i]!.date <= date; i++) {
      if (include(this.events[i]!)) balance += this.events[i]!.delta;
    }
    let least = balance;
    while (i < this.events.length) {
      const day = this.events[i]!.date;
      for (; i < this.events.length && this.events[i]!.date === day; i++) {
        if (include(this.events[i]!)) balance += this.events[i]!.delta;
      }
      least = Math.min(least, balance);
    }
    return least;
  }

  // Cover as much of `quantity` as the projected balance ever allows, on the
  // earliest day it allows it, and record the take on that day.
  take(quantity: number, articleNumber: string): PoolTake | null {
    const coverable = Math.min(quantity, this.availableFrom(FAR));
    if (coverable <= EPS) return null;
    const covered = round4(coverable);
    const candidates = [this.t0, ...this.events.filter((e) => e.delta > 0 && e.date > this.t0).map((e) => e.date)];
    let date = FAR;
    for (const d of candidates) {
      if (this.availableFrom(d) >= covered - EPS) {
        date = d;
        break;
      }
    }
    // The first receipt of that day makes the date: stock (always first at
    // t0), else the order or surplus in the overview's order.
    const maker = this.events.find((e) => e.date === date && e.delta > 0 && e.source);
    const source: PoolSource = maker?.source ?? { kind: "stock" };
    const chain: DtcStep[] =
      source.kind === "stock"
        ? [{ kind: "stock", articleNumber, quantity: covered, date }]
        : source.kind === "supply"
          ? [
              {
                kind: "supply",
                articleNumber,
                quantity: covered,
                date: source.date ?? date,
                documentType: source.documentType,
                documentNumber: source.documentNumber,
                undated: source.undated,
                late: source.late,
                isDraft: source.isDraft,
              },
            ]
          : source.chain;
    // Undated, late and draft supply are noted when the coverage rests on
    // them: without all of them (up to the day) the day would not hold.
    const flaggedUpTo = this.events.filter((e) => e.date <= date && flagged(e));
    const countsOn =
      flaggedUpTo.length > 0 && this.availableFrom(date, (e) => !flagged(e)) < covered - EPS
        ? flaggedUpTo.map((e) => e.source as Extract<PoolSource, { kind: "supply" }>)
        : [];
    this.add({ date, delta: -covered, source: null });
    return { quantity: covered, date, chain, countsOn };
  }
}

export function checkDeliveryTime(input: DeliveryTimeCheckInput): DeliveryTimeCheckResult {
  const { today, offDays } = input;
  const t0 = nextWorkingDayOnOrAfter(today, offDays);
  const globalNotes = new Set<string>();
  const batches: DtcBatch[] = [];

  // --- Capacity: the shared book (existing load rolled, this run's own
  // bookings on top) --------------------------------------------------------
  const book = createCapacityBook({
    today,
    offDays,
    workCenters: input.workCenters,
    schedule: input.schedule,
    existingOperations: input.existingOperations,
  });
  const usedResources = new Set<string>();

  // --- Pools: the projected balance per article for this check -------------
  const pools = new Map<string, ArticlePool>();
  function poolFor(articleId: string): ArticlePool {
    let pool = pools.get(articleId);
    if (pool) return pool;
    const overview = input.overviews.get(articleId);
    pool = new ArticlePool(t0);
    // Stock is the first event of t0. Negative stock is a shortage today
    // that the first supply fills before anyone may take — a demand.
    if (overview && Math.abs(overview.onHand) > EPS) {
      pool.add({ date: t0, delta: overview.onHand, source: overview.onHand > 0 ? { kind: "stock" } : null });
    }
    for (const row of overview?.rows ?? []) {
      if (row.direction === "supply") {
        // Undated supply counts now (the overview counts it too), late
        // supply counts now as well — both flagged so the row can say so.
        pool.add({
          date: row.date === null ? t0 : maxDate(row.date, t0),
          delta: row.quantity,
          source: {
            kind: "supply",
            documentType: row.documentType,
            documentNumber: row.documentNumber,
            date: row.date,
            undated: row.date === null,
            late: row.date !== null && row.date < t0,
            isDraft: row.isDraft,
          },
        });
      } else {
        if (row.kind === "sales_order" && row.documentId === input.excludeSalesOrderId) continue;
        pool.add({ date: row.date === null ? FAR : maxDate(row.date, t0), delta: row.quantity, source: null });
      }
    }
    pools.set(articleId, pool);
    return pool;
  }

  // Operations in sequence order from `materialReady`, each placed through
  // the book. Returns the ready day and one step per operation — or, when
  // the horizon is exceeded, readyDate null with the steps that were planned
  // plus one for the operation that did not fit (its weeks are the ones
  // searched). The bookings the planned operations made are left in place:
  // the order will be made regardless, and a later row on the same resource
  // should see that load. `allocations` is the batch's plan (one entry per
  // operation, in sequence order).
  function scheduleOperations(
    article: DtcArticle,
    operations: DtcOperation[],
    quantity: number,
    materialReady: string,
    notes: RowNotes
  ): { readyDate: string | null; steps: DtcStep[]; allocations: DtcBatch["operations"] } {
    const steps: DtcStep[] = [];
    const allocations: DtcBatch["operations"] = [];
    let floor = maxDate(materialReady, t0); // capacity may be used from this day
    let ready = floor;
    for (const op of [...operations].sort((a, b) => a.sequenceNo - b.sequenceNo)) {
      const wc = input.workCenters.get(op.workCenterId);
      const code = wc?.code ?? "?";
      const base = {
        articleNumber: article.articleNumber,
        quantity,
        sequenceNo: op.sequenceNo,
        description: op.description,
        workCenterCode: code,
        workCenterName: wc?.name ?? "",
      };
      if (wc?.type === "subcontract") {
        if (wc.leadTimeDays == null) notes.legoNoLead.add(code);
        ready = book.subcontract(wc, maxDate(ready, floor));
        floor = ready;
        steps.push({ kind: "subcontract", ...base, leadTimeDays: wc.leadTimeDays, date: ready });
        allocations.push({ sequenceNo: op.sequenceNo, workCenterId: op.workCenterId, weeks: [] });
        continue;
      }
      const minutes = op.setupTime + op.runTimePerUnit * quantity;
      if (minutes <= EPS) {
        steps.push({ kind: "operation", ...base, fromWeek: mondayOf(floor), toWeek: mondayOf(floor), weeks: [], date: ready });
        allocations.push({ sequenceNo: op.sequenceNo, workCenterId: op.workCenterId, weeks: [] });
        continue;
      }
      const placed = book.place(wc ?? null, minutes, { floor });
      if (placed.horizonExceeded) {
        steps.push({
          kind: "operation",
          ...base,
          fromWeek: placed.searchedFrom,
          toWeek: placed.searchedTo,
          weeks: placed.partial,
          date: book.weekFinishDay(wc ?? null, placed.searchedTo, floor),
        });
        return { readyDate: null, steps, allocations };
      }
      if (placed.unscheduled) notes.unscheduled.add(code);
      else usedResources.add(wc!.workCenterId);
      ready = maxDate(ready, placed.readyDate);
      // The next operation may use what is left of the finishing week.
      floor = maxDate(floor, placed.toWeek);
      steps.push({ kind: "operation", ...base, fromWeek: placed.fromWeek, toWeek: placed.toWeek, weeks: placed.weeks, date: ready });
      allocations.push({ sequenceNo: op.sequenceNo, workCenterId: op.workCenterId, weeks: placed.weeks });
    }
    return { readyDate: ready, steps, allocations };
  }

  // A shortage of `quantity` on an article: bought, made or always there.
  // `path` is the chain of parents being made (cycle guard and the batch's
  // level: 1 = the row's article, 2+ = a semi-finished part under it).
  function resolveShortage(
    article: DtcArticle,
    quantity: number,
    notes: RowNotes,
    path: Set<string>,
    rowKey: string,
    structure?: DtcStructure
  ): Resolution {
    if (article.type === "service") return { readyDate: t0, chain: [] };
    if (article.type === "purchased" && !structure) {
      const supplier = input.suppliers.get(article.articleId);
      if (!supplier) notes.noSupplier.add(article.articleNumber);
      const date =
        suggestPurchaseDeliveryDate({
          demandDate: null,
          today,
          leadTimeDays: supplier?.leadTimeDays ?? 0,
          settings: supplier?.settings ?? { weekdays: [], mode: "arrival", transitDays: 0 },
          offDays,
        }).date ?? t0;
      return {
        readyDate: date,
        chain: [
          {
            kind: "purchase",
            articleNumber: article.articleNumber,
            quantity,
            date,
            supplierName: supplier?.supplierName ?? null,
            leadTimeDays: supplier?.leadTimeDays ?? null,
          },
        ],
      };
    }
    // Made: its material (all levels), then its operations.
    if (path.has(article.articleId)) {
      throw new Error(`Cyclic BOM detected at article ${article.articleId} — this should be impossible`);
    }
    const nextPath = new Set(path).add(article.articleId);
    const components = structure
      ? new Map(structure.materials.map((m) => [m.articleId, m.quantity] as const))
      : explodeOneLevel(input.bomEdges, input.phantomIds, article.articleId, quantity);
    let materialReady = t0;
    let critical: DtcStep[] = [];
    for (const [componentId, componentQuantity] of components) {
      const component = input.articles.get(componentId);
      if (!component) continue;
      const resolved = resolveNeed(component, componentQuantity, notes, nextPath, rowKey);
      if (resolved.readyDate === null) return { readyDate: null, chain: resolved.chain };
      if (resolved.readyDate > materialReady) {
        materialReady = resolved.readyDate;
        critical = resolved.chain;
      }
    }
    const operations = structure ? structure.operations : (input.routings.get(article.articleId) ?? []);
    // No structure and no routing: nothing to make a TO of — counted as
    // available at once (the note says so), no batch.
    if (!structure && components.size === 0 && operations.length === 0) {
      notes.noPreparation.add(article.articleNumber);
      return { readyDate: t0, chain: [] };
    }
    const scheduled = scheduleOperations(article, operations, quantity, materialReady, notes);
    if (scheduled.readyDate === null) {
      notes.other.add("Kapaciteten räcker inte inom två år");
    } else {
      // The components' batches were pushed while resolving them above —
      // children before this parent.
      const level = nextPath.size;
      batches.push({
        key: `${rowKey}:${level}:${article.articleId}:${batches.length}`,
        rowKey,
        level,
        articleId: article.articleId,
        articleNumber: article.articleNumber,
        quantity,
        readyDate: scheduled.readyDate,
        operations: scheduled.allocations,
      });
    }
    return { readyDate: scheduled.readyDate, chain: [...critical, ...scheduled.steps] };
  }

  // A need of `quantity`: first what the projected balance allows, then a
  // shortage. The shortage is rounded up to the article's step and the
  // surplus goes back into the pool on the shortage's ready date.
  function resolveNeed(article: DtcArticle, quantity: number, notes: RowNotes, path: Set<string>, rowKey: string): Resolution {
    if (article.type === "service") return { readyDate: t0, chain: [] };
    const pool = poolFor(article.articleId);
    const taken = pool.take(quantity, article.articleNumber);
    let covered: Resolution = { readyDate: null, chain: [] };
    if (taken) {
      covered = { readyDate: taken.date, chain: taken.chain };
      for (const s of taken.countsOn) {
        if (s.undated) notes.undated.add(s.documentNumber);
        if (s.late) notes.late.add(s.documentNumber);
        if (s.isDraft) notes.draft.add(s.documentNumber);
      }
    }
    const rest = round4(quantity - (taken?.quantity ?? 0));
    if (rest <= EPS) return covered;
    const shortage = roundUpToMultiple(rest, article.rounding);
    const made = resolveShortage(article, shortage, notes, path, rowKey);
    if (made.readyDate !== null && shortage - rest > EPS) {
      pool.add({ date: made.readyDate, delta: round4(shortage - rest), source: { kind: "surplus", chain: made.chain } });
    }
    if (made.readyDate === null || covered.readyDate === null || made.readyDate >= covered.readyDate) return made;
    return covered;
  }

  // The day a linked TO is ready: the finish day of the last planned week of
  // its pending operations, else its due date (null = undated).
  function linkedOrderReady(order: DtcLinkedOrder): string | null {
    let last: { monday: string; workCenterId: string } | null = null;
    for (const op of input.existingOperations) {
      if (op.manufacturingOrderId !== order.manufacturingOrderId || op.operationStatus !== "pending") continue;
      for (const w of op.plannedWeeks ?? []) {
        if (!last || w.monday > last.monday) last = { monday: w.monday, workCenterId: op.workCenterId };
      }
    }
    if (!last) return order.dueDate;
    return book.weekFinishDay(input.workCenters.get(last.workCenterId) ?? null, last.monday, t0);
  }

  // A configured row: first what its linked TOs already make (a private
  // pool — the template's stock is other configurations'), then the batch.
  function resolveConfigured(article: DtcArticle, row: DtcRowInput, structure: DtcStructure, notes: RowNotes): Resolution {
    let covered: Resolution = { readyDate: null, chain: [] };
    if (structure.covered && structure.covered.quantity > EPS && structure.covered.orders.length > 0) {
      const pool = new ArticlePool(t0);
      for (const order of structure.covered.orders) {
        const ready = order.done ? t0 : linkedOrderReady(order);
        pool.add({
          date: ready === null ? t0 : maxDate(ready, t0),
          delta: order.quantity,
          source: {
            kind: "supply",
            documentType: "manufacturing_order",
            documentNumber: order.orderNumber,
            date: ready,
            undated: ready === null,
            late: ready !== null && ready < t0,
            isDraft: false,
          },
        });
      }
      const taken = pool.take(structure.covered.quantity, article.articleNumber);
      covered = { readyDate: taken?.date ?? t0, chain: taken?.chain ?? [] };
      for (const s of taken?.countsOn ?? []) {
        if (s.undated) notes.undated.add(s.documentNumber);
        if (s.late) notes.late.add(s.documentNumber);
      }
    }
    if (structure.quantity <= EPS) return covered.readyDate === null ? { readyDate: t0, chain: [] } : covered;
    const made = resolveShortage(article, structure.quantity, notes, new Set(), row.key, structure);
    if (made.readyDate === null || covered.readyDate === null || made.readyDate >= covered.readyDate) return made;
    return covered;
  }

  // --- Rows ----------------------------------------------------------------
  const rows: DtcRowResult[] = input.rows.map((row) => {
    const article = input.articles.get(row.articleId);
    const notes = newRowNotes();
    const articleNumber = article?.articleNumber ?? "";
    if (row.error || !article) {
      if (row.error) notes.other.add(row.error);
      return { key: row.key, articleId: row.articleId, articleNumber, quantity: row.quantity, readyDate: null, chain: [], notes: rowNoteTexts(notes) };
    }
    const resolved = row.structure
      ? resolveConfigured(article, row, row.structure, notes)
      : resolveNeed(article, row.quantity, notes, new Set(), row.key);
    return {
      key: row.key,
      articleId: row.articleId,
      articleNumber,
      quantity: row.quantity,
      readyDate: resolved.readyDate,
      chain: resolved.chain,
      notes: rowNoteTexts(notes),
    };
  });

  for (const wcId of usedResources) {
    const minutes = book.undatedMinutes(wcId);
    if (minutes > EPS) {
      const wc = input.workCenters.get(wcId)!;
      const hours = (Math.round((minutes / 60) * 10) / 10).toLocaleString("sv-SE");
      globalNotes.add(`Resurs ${wc.code} har ${hours} h beläggning utan datum som inte räknas`);
    }
  }

  // Ready from stock today ⇒ ship today; anything arriving or made on a day
  // ships the working day after (the färdigdatum rule mirrored).
  let shipDate: string | null = null;
  if (rows.length > 0 && rows.every((r) => r.readyDate !== null)) {
    const latest = rows.reduce((d, r) => maxDate(d, r.readyDate!), t0);
    shipDate = latest <= t0 ? t0 : addWorkingDays(latest, 1, offDays);
  }
  const deliveryDate =
    shipDate === null ? null : input.customer ? deliveryFromShipDate(shipDate, input.customer, offDays) : shipDate;
  return { shipDate, deliveryDate, rows, notes: [...globalNotes], batches };
}
