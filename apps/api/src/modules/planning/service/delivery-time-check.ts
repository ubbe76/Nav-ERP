// Leveranstidskontroll — the earliest ship and delivery date for a set of
// rows (a sales order, the Ny kundorder form or the stand-alone page) from
// what already exists (stock and open orders after the demands already
// promised), the lead time on what has to be bought, and free capacity per
// resource and week for what has to be made, all levels down.
//
// Pure, like capacity-calc.ts and article-overview.ts: the planning service
// loads flat rows (the overviews are already on ship dates) and this module
// owns every rule. It books nothing — two checks never see each other.
import { roundUpToMultiple } from "@navet/shared";
import { explodeOneLevel, type BomEdge } from "./requirements-calc.js";
import type { ArticleOverviewRow } from "./article-overview.js";
import {
  buildScheduleLookups,
  loadBucketMonday,
  remainingOperationMinutes,
  resourceDayMinutes,
  type CapacityOperationRow,
  type DayScheduleNetRow,
  type HolidayRow,
  type WeekScheduleDayRow,
} from "./capacity-calc.js";
import {
  addDays,
  addWorkingDays,
  deliveryFromShipDate,
  isWorkingDay,
  nextWorkingDayOnOrAfter,
  suggestPurchaseDeliveryDate,
  type DeliverySettings,
} from "../../system/service/delivery-days.js";

// Capacity is searched this many weeks ahead before a row gives up.
export const CHECK_HORIZON_WEEKS = 104;

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

export interface DtcWorkCenter {
  workCenterId: string;
  code: string;
  name: string;
  type: "machine" | "personnel" | "subcontract";
  weekScheduleId: string | null;
  capacityFactor: number;
  leadTimeDays: number | null; // legoresurs: working days the supplier takes
}

export interface DtcSupplier {
  supplierName: string;
  leadTimeDays: number | null;
  settings: DeliverySettings; // the supplier's effective delivery days
}

// A configured (beställningsvara) row brings its own derived structure; the
// template itself has no pool — a configuration is unique.
export interface DtcStructure {
  operations: DtcOperation[];
  materials: { articleId: string; quantity: number }[]; // totals for the row's quantity
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
      undated: boolean;
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

export interface DeliveryTimeCheckResult {
  shipDate: string | null;
  deliveryDate: string | null; // = shipDate without a customer
  rows: DtcRowResult[];
  notes: string[];
}

interface Lot {
  date: string;
  quantity: number;
  source: { kind: "stock" } | { kind: "supply"; documentType: ArticleOverviewRow["documentType"]; documentNumber: string; undated: boolean };
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
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

// A row's notes. The repeating kinds — resources without a week schedule,
// undated supply, articles without a primary supplier, lego resources
// without lead time — are gathered and written as ONE note each: real data
// can name dozens, and a note per resource buries the result.
interface RowNotes {
  other: Set<string>;
  unscheduled: Set<string>; // resource codes
  undated: Set<string>; // document numbers
  noSupplier: Set<string>; // article numbers
  legoNoLead: Set<string>; // lego resource codes
}

const newRowNotes = (): RowNotes => ({
  other: new Set(),
  unscheduled: new Set(),
  undated: new Set(),
  noSupplier: new Set(),
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
      `${many(n.unscheduled) ? "Resurserna" : "Resurs"} ${swedishList(n.unscheduled)} saknar veckoschema — kapaciteten räknas inte`
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
  if (n.undated.size > 0) {
    texts.push(
      `${swedishList(n.undated)} saknar datum — ${many(n.undated) ? "räknade som tillgängliga" : "räknad som tillgänglig"} direkt`
    );
  }
  return texts;
}

export function checkDeliveryTime(input: DeliveryTimeCheckInput): DeliveryTimeCheckResult {
  const { today, offDays } = input;
  const t0 = nextWorkingDayOnOrAfter(today, offDays);
  const globalNotes = new Set<string>();
  const lookups = buildScheduleLookups(
    input.schedule.weekScheduleDays,
    input.schedule.daySchedules,
    input.schedule.holidays
  );
  const firstMonday = mondayOf(today);
  const horizonMonday = addDays(firstMonday, CHECK_HORIZON_WEEKS * 7);

  // --- Existing load per resource and week (beläggningsvyns hinkar) -------
  const existingLoad = new Map<string, Map<string, number>>(); // wc -> monday -> minutes
  const undatedLoad = new Map<string, number>(); // wc -> minutes
  for (const op of input.existingOperations) {
    const minutes = remainingOperationMinutes(op);
    if (minutes <= 0) continue;
    const monday = loadBucketMonday(op.dueDate, firstMonday);
    if (monday == null) {
      undatedLoad.set(op.workCenterId, (undatedLoad.get(op.workCenterId) ?? 0) + minutes);
      continue;
    }
    const weeks = existingLoad.get(op.workCenterId) ?? new Map<string, number>();
    weeks.set(monday, (weeks.get(monday) ?? 0) + minutes);
    existingLoad.set(op.workCenterId, weeks);
  }
  const booked = new Map<string, Map<string, number>>(); // this run's own bookings
  const usedResources = new Set<string>();

  // --- Pools: what is left of stock and open supply for this check --------
  const pools = new Map<string, Lot[]>();
  function poolFor(articleId: string): Lot[] {
    let pool = pools.get(articleId);
    if (pool) return pool;
    const overview = input.overviews.get(articleId);
    const lots: Lot[] = [];
    let deficit = 0; // negative stock is a shortage today — it takes first
    if (overview) {
      if (overview.onHand > EPS) lots.push({ date: t0, quantity: overview.onHand, source: { kind: "stock" } });
      else if (overview.onHand < -EPS) deficit = -overview.onHand;
      for (const row of overview.rows) {
        if (row.direction !== "supply") continue;
        lots.push({
          // Undated supply counts as available now (the overview counts it
          // too), flagged so the chain can say so.
          date: row.date ?? t0,
          quantity: row.quantity,
          source: {
            kind: "supply",
            documentType: row.documentType,
            documentNumber: row.documentNumber,
            undated: row.date === null,
          },
        });
      }
    }
    // Stock first, then supply in date order (stable: the overview's order).
    lots.sort((a, b) => (a.source.kind === "stock" ? -1 : b.source.kind === "stock" ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const take = (quantity: number) => {
      let rest = quantity;
      for (const lot of lots) {
        if (rest <= EPS) break;
        const used = Math.min(lot.quantity, rest);
        lot.quantity = round4(lot.quantity - used);
        rest = round4(rest - used);
      }
    };
    take(deficit);
    // Demands already promised take first, in the overview's date order.
    if (overview) {
      for (const row of overview.rows) {
        if (row.direction !== "demand") continue;
        if (row.kind === "sales_order" && row.documentId === input.excludeSalesOrderId) continue;
        take(-row.quantity);
      }
    }
    pool = lots.filter((l) => l.quantity > EPS);
    pools.set(articleId, pool);
    return pool;
  }

  // --- Capacity booking ----------------------------------------------------
  // Minutes a resource can still take in week `monday`, counting only days
  // from `fromDay`: never more than what is left of the whole week (from
  // today) after the existing load and this run's bookings.
  function weekCapacityFrom(wc: DtcWorkCenter, monday: string, fromDay: string): number {
    let minutes = 0;
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      if (day < fromDay) continue;
      minutes += resourceDayMinutes(lookups, wc.weekScheduleId!, day);
    }
    return minutes * wc.capacityFactor;
  }
  function freeMinutes(wc: DtcWorkCenter, monday: string, fromDay: string): number {
    const weekFromToday = weekCapacityFrom(wc, monday, maxDate(monday, today));
    const left =
      weekFromToday -
      (existingLoad.get(wc.workCenterId)?.get(monday) ?? 0) -
      (booked.get(wc.workCenterId)?.get(monday) ?? 0);
    return Math.max(0, Math.min(weekCapacityFrom(wc, monday, maxDate(fromDay, today)), left));
  }
  function book(wc: DtcWorkCenter, monday: string, minutes: number) {
    const weeks = booked.get(wc.workCenterId) ?? new Map<string, number>();
    weeks.set(monday, (weeks.get(monday) ?? 0) + minutes);
    booked.set(wc.workCenterId, weeks);
  }
  // The last day of the week the resource works (else a working day), never
  // before `floor`.
  function weekFinishDay(wc: DtcWorkCenter | null, monday: string, floor: string): string {
    for (let i = 6; i >= 0; i--) {
      const day = addDays(monday, i);
      if (day < floor) break;
      if (wc?.weekScheduleId ? resourceDayMinutes(lookups, wc.weekScheduleId, day) > 0 : isWorkingDay(day, offDays)) return day;
    }
    return floor;
  }

  // Operations in sequence order from `materialReady`. Returns the ready day
  // and one step per operation, or null when the horizon is exceeded.
  function scheduleOperations(
    article: DtcArticle,
    operations: DtcOperation[],
    quantity: number,
    materialReady: string,
    notes: RowNotes
  ): { readyDate: string; steps: DtcStep[] } | null {
    const steps: DtcStep[] = [];
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
        ready = addWorkingDays(maxDate(ready, floor), Math.ceil(wc.leadTimeDays ?? 0), offDays);
        floor = ready;
        steps.push({ kind: "subcontract", ...base, leadTimeDays: wc.leadTimeDays, date: ready });
        continue;
      }
      const minutes = op.setupTime + op.runTimePerUnit * quantity;
      if (minutes <= EPS) {
        steps.push({ kind: "operation", ...base, fromWeek: mondayOf(floor), toWeek: mondayOf(floor), date: ready });
        continue;
      }
      if (!wc || !wc.weekScheduleId) {
        notes.unscheduled.add(code);
        const monday = mondayOf(floor);
        ready = maxDate(ready, weekFinishDay(null, monday, floor));
        steps.push({ kind: "operation", ...base, fromWeek: monday, toWeek: monday, date: ready });
        continue;
      }
      usedResources.add(wc.workCenterId);
      let monday = mondayOf(floor);
      let fromWeek: string | null = null; // the first week it actually books
      let rest = minutes;
      let dayFloor = floor;
      while (rest > EPS) {
        if (monday >= horizonMonday) return null;
        const take = Math.min(rest, freeMinutes(wc, monday, dayFloor));
        if (take > EPS) {
          book(wc, monday, take);
          rest -= take;
          fromWeek ??= monday;
        }
        if (rest > EPS) {
          monday = addDays(monday, 7);
          dayFloor = monday;
        }
      }
      ready = maxDate(ready, weekFinishDay(wc, monday, floor));
      // The next operation may use what is left of the finishing week.
      floor = maxDate(floor, monday);
      steps.push({ kind: "operation", ...base, fromWeek: fromWeek ?? monday, toWeek: monday, date: ready });
    }
    return { readyDate: ready, steps };
  }

  // A shortage of `quantity` on an article: bought, made or always there.
  function resolveShortage(
    article: DtcArticle,
    quantity: number,
    notes: RowNotes,
    path: Set<string>,
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
      const resolved = resolveNeed(component, componentQuantity, notes, nextPath);
      if (resolved.readyDate === null) return { readyDate: null, chain: resolved.chain };
      if (resolved.readyDate > materialReady) {
        materialReady = resolved.readyDate;
        critical = resolved.chain;
      }
    }
    const operations = structure ? structure.operations : (input.routings.get(article.articleId) ?? []);
    const scheduled = scheduleOperations(article, operations, quantity, materialReady, notes);
    if (!scheduled) {
      notes.other.add("Kapaciteten räcker inte inom två år");
      return { readyDate: null, chain: critical };
    }
    return { readyDate: scheduled.readyDate, chain: [...critical, ...scheduled.steps] };
  }

  // A need of `quantity`: first what is left in the pool, then a shortage.
  function resolveNeed(article: DtcArticle, quantity: number, notes: RowNotes, path: Set<string>): Resolution {
    if (article.type === "service") return { readyDate: t0, chain: [] };
    const pool = poolFor(article.articleId);
    let rest = quantity;
    let covered: Resolution = { readyDate: null, chain: [] };
    for (const lot of pool) {
      if (rest <= EPS) break;
      if (lot.quantity <= EPS) continue;
      const used = Math.min(lot.quantity, rest);
      lot.quantity = round4(lot.quantity - used);
      rest = round4(rest - used);
      // Lots are in date order, so the last one used is the covered date.
      const step: DtcStep =
        lot.source.kind === "stock"
          ? { kind: "stock", articleNumber: article.articleNumber, quantity: used, date: lot.date }
          : {
              kind: "supply",
              articleNumber: article.articleNumber,
              quantity: used,
              date: lot.date,
              documentType: lot.source.documentType,
              documentNumber: lot.source.documentNumber,
              undated: lot.source.undated,
            };
      if (lot.source.kind === "supply" && lot.source.undated) {
        notes.undated.add(lot.source.documentNumber);
      }
      if (covered.readyDate === null || lot.date >= covered.readyDate) covered = { readyDate: lot.date, chain: [step] };
    }
    if (rest <= EPS) return covered;
    const shortage = roundUpToMultiple(rest, article.rounding);
    const made = resolveShortage(article, shortage, notes, path);
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
      ? resolveShortage(article, row.quantity, notes, new Set(), row.structure)
      : resolveNeed(article, row.quantity, notes, new Set());
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
    const minutes = undatedLoad.get(wcId) ?? 0;
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
  return { shipDate, deliveryDate, rows, notes: [...globalNotes] };
}
