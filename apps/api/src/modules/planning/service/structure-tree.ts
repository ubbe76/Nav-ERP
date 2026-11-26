// Strukturvyn (spec 2026-11-26, etapp 4): ONE order's whole tree — a
// kundorder's rows or a TO at the top, under each TO its material rows and
// under each material row what covers it: a TO (a new level), stock or an
// inköpsorder (a leaf), or nothing (a missing leaf). Pure, no database
// imports, and no rule of its own — everything is borrowed:
//   - coverage     the pegging the service loaded level by level (pegParents
//                  → parentDemands), mapped with structureDemands below; the
//                  kundorder rows' allocations are Leveransläget's
//                  (delivery-outlook.ts).
//   - late marks   the pegging's own flags on the allocations and the plan
//                  summary's Sen on the TO. This file never compares a ready
//                  date with a need date.
//   - exclusive    moveCandidates (component-moves.ts) on the same pegging.
//   - bars         operationLoadDays per operation — the matrix's bucket, a
//                  passed day clamped to today. A lego operation has no bars
//                  (S26): the book never gives it days, the TO's finish
//                  counts it through orderPlanStatus.
// A TO covering two places is drawn once, depth first; the next place is a
// node with `repeatOf` and neither operations nor children (S25). The tree
// is a read view (B8): nothing here is written anywhere.
import { round2 } from "@navet/shared";
import { compareArticleNumbers } from "../../manufacturing/service/operation-materials.js";
import { addDays } from "../../system/service/delivery-days.js";
import { isoWeekOf } from "../../timereport/service/schedule.service.js";
import type { PlanWorkCenter } from "./capacity-book.js";
import { operationLoadDays, operationStarted, plannedDateRange, remainingOperationMinutes, type CapacityOperationRow } from "./capacity-calc.js";
import { moveCandidates } from "./component-moves.js";
import type { OrderOutlook, OutlookRow } from "./delivery-outlook.js";
import { ceilDays } from "./manufacturing-lead-time.js";
import type { PegAllocation, PegDemand, Pegging, PegSupplyKind } from "./pegging.js";

export const STRUCTURE_MAX_DEPTH = 10; // TO levels below the root
export const STRUCTURE_MAX_NODES = 600;
export const STRUCTURE_AXIS_MIN_DAYS = 14;
export const STRUCTURE_AXIS_MAX_DAYS = 84;

// --- Input -----------------------------------------------------------------

// What covers a need — the TO card's CoverageAllocation plus `exclusive`.
export interface StructureAllocation {
  kind: PegSupplyKind;
  documentId: string | null; // null = stock
  documentNumber: string | null;
  quantity: number;
  readyDate: string | null; // floored at today; null = undated
  late: boolean;
  undated: boolean;
  daysLate: number;
  isDraft: boolean;
  // A TO supply whose whole allocated quantity goes to this parent
  // (moveCandidates' rule); false for stock and inköpsorder.
  exclusive: boolean;
}

// One of a TO's material needs — the same row as the TO card's Täcks av.
export interface StructureDemand {
  rowId: string; // the overview row id (mat:<rowId> / pmat:<moId>)
  articleId: string;
  articleNumber: string;
  articleName: string;
  articleType: "manufactured" | "purchased" | "service";
  needDate: string | null;
  quantity: number; // rest, base unit
  uncovered: number;
  allocations: StructureAllocation[];
}

// The TO's plan summary — the service's OrderPlanSummary (same fields).
export interface StructureOrderPlan {
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  late: boolean;
  plannedFinish: string | null;
}

// A TO's head, its plan summary and Halvfabrikat sent, as loaded.
export interface StructureOrderFacts {
  manufacturingOrderId: string;
  orderNumber: string;
  orderStatus: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  remainingQuantity: number;
  dueDate: string | null;
  // null = no summary (a TO without operations): no planned days, not late.
  plan: StructureOrderPlan | null;
  componentLate: boolean;
}

// Where the root TO's own output goes — the service's CoverageGoesTo (same
// fields), one level up (S24).
export interface StructureGoesTo {
  kind: "sales_order" | "mo_material" | "mo_planned_material" | "stock";
  documentId: string | null;
  documentNumber: string | null;
  partner: string | null;
  needDate: string | null;
  quantity: number;
  late: boolean;
  daysLate: number;
}

export interface StructureRootRow {
  row: OutlookRow; // Leveransläget's row with its allocations
  // The row's article is manufactured — an uncovered rest can become a TO.
  manufacturable: boolean;
  // The TOs among the row's allocations whose whole allocated quantity goes
  // to this row (exclusiveOrderIds below; a configured row's linked TOs are
  // all its own). Left out = none.
  exclusiveOrderIds?: ReadonlySet<string>;
}

export type StructureRootInput =
  | { kind: "sales_order"; salesOrderId: string; orderNumber: string; customerName: string; outlook: OrderOutlook; rows: StructureRootRow[] }
  | { kind: "manufacturing_order"; manufacturingOrderId: string; goesTo: StructureGoesTo[] };

export interface StructureInput {
  today: string;
  // Full-day holidays, for the axis' `off` days only.
  offDays: ReadonlySet<string>;
  root: StructureRootInput;
  // Per TO: its material rows with allocations. An entry (even an empty one)
  // says the TO's level was loaded; a TO without an entry is drawn without
  // children.
  demandsByOrder: ReadonlyMap<string, StructureDemand[]>;
  orders: ReadonlyMap<string, StructureOrderFacts>;
  operations: CapacityOperationRow[];
  workCenters: ReadonlyMap<string, PlanWorkCenter>;
  // Operations with an open or paused stamp session (stampedOperationIds).
  stamped: ReadonlySet<string>;
}

// --- Output ----------------------------------------------------------------

export interface StructureOperation {
  moOperationId: string;
  sequenceNo: number;
  description: string | null;
  workCenterId: string;
  workCenterCode: string;
  workCenterName: string;
  status: "pending" | "done";
  subcontract: boolean;
  // Lego: the resource's Ledtid + Kötid in whole working days (the text
  // "Lego · N dagar"); null for an own operation.
  subcontractDays: number | null;
  started: boolean;
  remainingHours: number;
  planLocked: boolean;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  // operationLoadDays in hours — the matrix's bucket, a passed day clamped
  // to today. Empty for lego, a done operation and an undated unplanned one.
  days: { date: string; hours: number }[];
}

// The coupling to the parent (the material row or the kundorder row).
export interface StructureLink {
  quantity: number;
  needDate: string | null;
  late: boolean;
  undated: boolean;
  daysLate: number;
  exclusive: boolean;
}

export type StructureNode =
  | { kind: "sales_row"; id: string; parentId: null; level: 0; row: OutlookRow; orderNumber: string; customerName: string }
  | {
      kind: "order";
      id: string;
      parentId: string | null;
      level: number;
      manufacturingOrderId: string;
      orderNumber: string;
      orderStatus: string;
      articleId: string;
      articleNumber: string;
      articleName: string;
      remainingQuantity: number;
      dueDate: string | null;
      plannedStartDate: string | null;
      plannedEndDate: string | null;
      plannedFinish: string | null;
      late: boolean;
      componentLate: boolean;
      link: StructureLink | null; // null on the root
      repeatOf: string | null; // S25: the id of the node where the TO is drawn
      lockedOperations: number;
      operations: StructureOperation[];
    }
  | {
      kind: "material";
      id: string;
      parentId: string;
      level: number;
      materialRowId: string;
      articleId: string;
      articleNumber: string;
      articleName: string;
      articleType: "manufactured" | "purchased" | "service";
      needDate: string | null;
      quantity: number;
      uncovered: number;
      fromStockOnly: boolean;
    }
  | {
      kind: "supply";
      id: string;
      parentId: string;
      level: number;
      supply: "stock" | "purchase_order";
      documentId: string | null;
      documentNumber: string | null;
      quantity: number;
      readyDate: string | null;
      late: boolean;
      undated: boolean;
      daysLate: number;
      isDraft: boolean;
    }
  | { kind: "missing"; id: string; parentId: string; level: number; quantity: number; manufacturable: boolean };

export type StructureOrderNode = Extract<StructureNode, { kind: "order" }>;

export interface StructureAxisDay {
  date: string;
  isoWeek: number;
  weekday: number; // ISO: 1 = Monday … 7 = Sunday
  off: boolean; // Saturday, Sunday or a full-day holiday
}

export interface StructureResult {
  today: string;
  root:
    | { kind: "sales_order"; salesOrderId: string; orderNumber: string; customerName: string; outlook: OrderOutlook }
    | { kind: "manufacturing_order"; manufacturingOrderId: string; orderNumber: string };
  // Flat, depth first, with parentId/level (like flattenMoves).
  nodes: StructureNode[];
  // Only with a TO at the top: one level up (S24).
  goesTo: StructureGoesTo[];
  axis: { from: string; to: string; days: StructureAxisDay[] };
  // cycle = the article numbers where the guard stopped the tree.
  truncated: { depth: boolean; nodes: boolean; cycle: string[] };
  totals: { orders: number; lateOrders: number; componentLate: number; lockedOperations: number; missing: number };
}

// --- The mapping from the pegging ------------------------------------------

// The predicate the service's parentDemands uses: the demand row is a
// material need of the parent TO.
function isMaterialDemandOf(parentId: string) {
  return (demand: PegDemand) =>
    demand.row !== null && demand.row.documentId === parentId && (demand.row.kind === "mo_material" || demand.row.kind === "mo_planned_material");
}

// The TO supplies in one article's pegging whose whole allocated quantity
// goes to the demands `isParentDemand` accepts — moveCandidates' `exclusive`,
// called, not rewritten.
export function exclusiveOrderIds(
  pegging: Pegging,
  article: { articleId: string; articleNumber: string },
  isParentDemand: (demand: PegDemand) => boolean
): Set<string> {
  return new Set(
    moveCandidates(pegging, article, isParentDemand)
      .filter((c) => c.exclusive)
      .map((c) => c.manufacturingOrderId)
  );
}

// One entry of the service's parentDemands, with the component's article
// (world.overviews.get(articleId).article).
export interface StructureDemandSource {
  article: { articleId: string; articleNumber: string; name: string; type: "manufactured" | "purchased" | "service" };
  pegging: Pegging;
  demand: PegDemand;
}

// A parent TO's material rows for the tree, from its entries in the
// component articles' peggings — the same fields as the TO card's
// `materials`, each TO allocation with moveCandidates' `exclusive`.
export function structureDemands(parentId: string, sources: readonly StructureDemandSource[]): StructureDemand[] {
  const isParentDemand = isMaterialDemandOf(parentId);
  const exclusiveByPegging = new Map<Pegging, Set<string>>();
  return sources.map(({ article, pegging, demand }) => {
    let exclusive = exclusiveByPegging.get(pegging);
    if (!exclusive) {
      exclusive = exclusiveOrderIds(pegging, article, isParentDemand);
      exclusiveByPegging.set(pegging, exclusive);
    }
    const supplyById = new Map(pegging.supplies.map((s) => [s.id, s]));
    return {
      rowId: demand.row?.id ?? demand.id,
      articleId: article.articleId,
      articleNumber: article.articleNumber,
      articleName: article.name,
      articleType: article.type,
      needDate: demand.date,
      quantity: demand.quantity,
      uncovered: demand.uncovered,
      allocations: demand.allocations.map((a: PegAllocation) => {
        const supply = supplyById.get(a.supplyId)!;
        const documentId = supply.row?.documentId ?? null;
        return {
          kind: supply.kind,
          documentId,
          documentNumber: supply.row?.documentNumber ?? null,
          quantity: a.quantity,
          readyDate: a.readyDate,
          late: a.late,
          undated: a.undated,
          daysLate: a.daysLate,
          isDraft: supply.row?.isDraft ?? false,
          exclusive: supply.kind === "manufacturing_order" && documentId !== null && exclusive.has(documentId),
        };
      }),
    };
  });
}

// The next level to load: the TO supplies covering the given material rows
// that are not expanded yet, in first-seen order. The service pegs them in
// ONE batch (pegParents) and adds them to `expanded`.
export function nextStructureLevel(demands: Iterable<StructureDemand>, expanded: ReadonlySet<string>): string[] {
  const next = new Set<string>();
  for (const demand of demands) {
    for (const a of demand.allocations) {
      if (a.kind === "manufacturing_order" && a.documentId !== null && !expanded.has(a.documentId)) next.add(a.documentId);
    }
  }
  return [...next];
}

// --- The tree --------------------------------------------------------------

function structureOperation(
  op: CapacityOperationRow,
  input: Pick<StructureInput, "today" | "workCenters" | "stamped">
): StructureOperation {
  const wc = input.workCenters.get(op.workCenterId) ?? null;
  const subcontract = wc?.type === "subcontract";
  const range = plannedDateRange(op);
  const days: StructureOperation["days"] = [];
  if (!subcontract) {
    for (const d of operationLoadDays(op, input.today)) {
      if (d.date !== null) days.push({ date: d.date, hours: round2(d.minutes / 60) });
    }
  }
  return {
    moOperationId: op.moOperationId,
    sequenceNo: op.sequenceNo,
    description: op.description ?? null,
    workCenterId: op.workCenterId,
    workCenterCode: wc?.code ?? "",
    workCenterName: wc?.name ?? "",
    status: op.operationStatus,
    subcontract,
    // The days subcontractReadyDate (capacity-calc.ts) adds after the floor.
    subcontractDays: subcontract ? ceilDays(Math.max(0, (wc?.leadTimeDays ?? 0) + (wc?.queueTimeDays ?? 0))) : null,
    started: operationStarted(op, input.stamped.has(op.moOperationId)),
    remainingHours: round2(remainingOperationMinutes(op) / 60),
    planLocked: op.planLocked ?? false,
    plannedStartDate: range?.start ?? null,
    plannedEndDate: range?.end ?? null,
    days,
  };
}

const lockedCount = (operations: StructureOperation[]) => operations.filter((op) => op.status === "pending" && op.planLocked).length;

function structureAxis(today: string, offDays: ReadonlySet<string>, dates: (string | null)[]): StructureResult["axis"] {
  // A passed date is shown on today — the axis never starts before it.
  const floored = dates.filter((d): d is string => d !== null).map((d) => (d < today ? today : d));
  const from = floored.length > 0 ? floored.reduce((a, b) => (a < b ? a : b)) : today;
  const latest = floored.length > 0 ? floored.reduce((a, b) => (a > b ? a : b)) : today;
  const min = addDays(from, STRUCTURE_AXIS_MIN_DAYS - 1);
  const max = addDays(from, STRUCTURE_AXIS_MAX_DAYS - 1);
  const to = latest < min ? min : latest > max ? max : latest;
  const days: StructureAxisDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
    days.push({ date, isoWeek: isoWeekOf(date).isoWeek, weekday, off: weekday >= 6 || offDays.has(date) });
  }
  return { from, to, days };
}

export function buildStructureTree(input: StructureInput): StructureResult {
  const { today, root } = input;
  const operationsByOrder = new Map<string, StructureOperation[]>();
  for (const op of input.operations) {
    const list = operationsByOrder.get(op.manufacturingOrderId);
    const mapped = structureOperation(op, input);
    if (list) list.push(mapped);
    else operationsByOrder.set(op.manufacturingOrderId, [mapped]);
  }
  for (const list of operationsByOrder.values()) list.sort((a, b) => a.sequenceNo - b.sequenceNo || a.moOperationId.localeCompare(b.moOperationId));

  const nodes: StructureNode[] = [];
  const truncated: StructureResult["truncated"] = { depth: false, nodes: false, cycle: [] };
  // manufacturingOrderId → the node where the TO is drawn (S25).
  const drawn = new Map<string, string>();
  // Every date in the tree except stock's "today", for the axis.
  const dates: (string | null)[] = [];

  // Something to draw below the TO: its loaded material rows — or unknown
  // (the level was never loaded), which counts as possibly something.
  const mayHaveChildren = (orderId: string) => {
    const demands = input.demandsByOrder.get(orderId);
    return demands === undefined || demands.length > 0;
  };

  // What the allocation itself knows about a TO without loaded facts.
  type OrderFallback = { orderNumber: string; articleId: string; articleNumber: string; articleName: string; quantity: number };

  // `depth` = TO levels below the root (a TO at the top is 0, the TOs
  // covering a kundorder row 1). `path` = the articles of the TOs above.
  const emitOrder = (
    orderId: string,
    parentId: string | null,
    level: number,
    depth: number,
    link: StructureLink | null,
    path: readonly string[],
    fallback: OrderFallback | null
  ): void => {
    const facts = input.orders.get(orderId);
    if (!facts && !fallback) throw new Error(`structure tree: no facts for the root order ${orderId}`);
    const articleId = facts?.articleId ?? fallback!.articleId;
    const articleNumber = facts?.articleNumber ?? fallback!.articleNumber;
    const firstId = drawn.get(orderId) ?? null;
    const operations = firstId === null ? (operationsByOrder.get(orderId) ?? []) : [];
    const id = firstId === null ? `mo:${orderId}` : `${parentId}/mo:${orderId}`;
    nodes.push({
      kind: "order",
      id,
      parentId,
      level,
      manufacturingOrderId: orderId,
      orderNumber: facts?.orderNumber ?? fallback!.orderNumber,
      orderStatus: facts?.orderStatus ?? "",
      articleId,
      articleNumber,
      articleName: facts?.articleName ?? fallback!.articleName,
      remainingQuantity: facts?.remainingQuantity ?? fallback!.quantity,
      dueDate: facts?.dueDate ?? null,
      plannedStartDate: facts?.plan?.plannedStartDate ?? null,
      plannedEndDate: facts?.plan?.plannedEndDate ?? null,
      plannedFinish: facts?.plan?.plannedFinish ?? null,
      late: facts?.plan?.late ?? false,
      componentLate: facts?.componentLate ?? false,
      link,
      repeatOf: firstId,
      lockedOperations: lockedCount(operationsByOrder.get(orderId) ?? []),
      operations,
    });
    dates.push(link?.needDate ?? null);

    const onPath = path.includes(articleId);
    if (onPath && !truncated.cycle.includes(articleNumber)) truncated.cycle.push(articleNumber);
    if (firstId !== null) return;
    drawn.set(orderId, id);
    dates.push(facts?.dueDate ?? null, facts?.plan?.plannedStartDate ?? null, facts?.plan?.plannedEndDate ?? null, facts?.plan?.plannedFinish ?? null);
    for (const op of operations) for (const day of op.days) dates.push(day.date);

    if (onPath) return;
    if (depth >= STRUCTURE_MAX_DEPTH) {
      if (mayHaveChildren(orderId)) truncated.depth = true;
      return;
    }
    if (nodes.length >= STRUCTURE_MAX_NODES) {
      if (mayHaveChildren(orderId)) truncated.nodes = true;
      return;
    }

    const demands = [...(input.demandsByOrder.get(orderId) ?? [])].sort((a, b) => compareArticleNumbers(a, b) || a.rowId.localeCompare(b.rowId));
    const below = [...path, articleId];
    for (const demand of demands) {
      const fromStockOnly = demand.uncovered <= 0 && demand.allocations.length > 0 && demand.allocations.every((a) => a.kind === "stock");
      nodes.push({
        kind: "material",
        id: demand.rowId,
        parentId: id,
        level: level + 1,
        materialRowId: demand.rowId,
        articleId: demand.articleId,
        articleNumber: demand.articleNumber,
        articleName: demand.articleName,
        articleType: demand.articleType,
        needDate: demand.needDate,
        quantity: demand.quantity,
        uncovered: demand.uncovered,
        fromStockOnly,
      });
      dates.push(demand.needDate);
      emitCoverage(
        demand.rowId,
        level + 2,
        depth + 1,
        below,
        demand.allocations,
        demand.uncovered,
        demand.needDate,
        demand.articleType === "manufactured",
        { articleId: demand.articleId, articleNumber: demand.articleNumber, articleName: demand.articleName }
      );
    }
  };

  // What covers one need (a material row or a kundorder row), in the
  // pegging's allocation order, the missing rest last.
  const emitCoverage = (
    parentId: string,
    level: number,
    depth: number,
    path: readonly string[],
    allocations: readonly (Omit<StructureAllocation, "exclusive"> & { exclusive?: boolean })[],
    uncovered: number,
    needDate: string | null,
    manufacturable: boolean,
    article: { articleId: string; articleNumber: string; articleName: string },
    exclusive?: ReadonlySet<string>
  ): void => {
    allocations.forEach((a, index) => {
      if (a.kind === "manufacturing_order" && a.documentId !== null) {
        emitOrder(
          a.documentId,
          parentId,
          level,
          depth,
          {
            quantity: a.quantity,
            needDate,
            late: a.late,
            undated: a.undated,
            daysLate: a.daysLate,
            exclusive: a.exclusive ?? exclusive?.has(a.documentId) ?? false,
          },
          path,
          { orderNumber: a.documentNumber ?? "", ...article, quantity: a.quantity }
        );
        return;
      }
      const stock = a.kind === "stock";
      nodes.push({
        kind: "supply",
        // The index: one inköpsorder can cover a need from two of its rows.
        id: stock ? `${parentId}/stock` : `${parentId}/po:${index}`,
        parentId,
        level,
        supply: stock ? "stock" : "purchase_order",
        documentId: a.documentId,
        documentNumber: a.documentNumber,
        quantity: a.quantity,
        readyDate: a.readyDate,
        late: a.late,
        undated: a.undated,
        daysLate: a.daysLate,
        isDraft: a.isDraft,
      });
      if (!stock) dates.push(a.readyDate);
    });
    if (uncovered > 0) nodes.push({ kind: "missing", id: `${parentId}/missing`, parentId, level, quantity: uncovered, manufacturable });
  };

  let resultRoot: StructureResult["root"];
  if (root.kind === "sales_order") {
    resultRoot = {
      kind: "sales_order",
      salesOrderId: root.salesOrderId,
      orderNumber: root.orderNumber,
      customerName: root.customerName,
      outlook: root.outlook,
    };
    for (const { row, manufacturable, exclusiveOrderIds: exclusive } of root.rows) {
      const id = `row:${row.salesOrderRowId}`;
      nodes.push({ kind: "sales_row", id, parentId: null, level: 0, row, orderNumber: root.orderNumber, customerName: root.customerName });
      dates.push(row.promisedDate, row.promisedShipDate, row.estimatedShipDate, row.estimatedDeliveryDate);
      emitCoverage(
        id,
        1,
        1,
        [],
        row.allocations,
        row.uncovered,
        row.promisedShipDate,
        manufacturable,
        { articleId: row.articleId, articleNumber: row.articleNumber, articleName: row.articleName },
        exclusive
      );
    }
  } else {
    emitOrder(root.manufacturingOrderId, null, 0, 0, null, [], null);
    resultRoot = {
      kind: "manufacturing_order",
      manufacturingOrderId: root.manufacturingOrderId,
      orderNumber: input.orders.get(root.manufacturingOrderId)!.orderNumber,
    };
    for (const g of root.goesTo) dates.push(g.needDate);
  }

  const first = nodes.filter((n): n is StructureOrderNode => n.kind === "order" && n.repeatOf === null);
  return {
    today,
    root: resultRoot,
    nodes,
    goesTo: root.kind === "manufacturing_order" ? root.goesTo : [],
    axis: structureAxis(today, input.offDays, dates),
    truncated,
    totals: {
      orders: first.length,
      lateOrders: first.filter((n) => n.late).length,
      componentLate: first.filter((n) => n.componentLate).length,
      lockedOperations: first.reduce((sum, n) => sum + n.lockedOperations, 0),
      missing: nodes.filter((n) => n.kind === "missing").length,
    },
  };
}
