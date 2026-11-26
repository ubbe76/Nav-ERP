// Planera om strukturen — a TO and the chosen halvfabrikat-TOs under it are
// planned again, children before parents, each from the day its material is
// ready (spec 2026-11-26, etapp 5). Pure, no database imports, and NO
// placement rule of its own:
//   - Placeringen  planProduction (production-plan.ts) — Planera's engine,
//                  once per TO, with the TO's golv as `earliestStart` (the
//                  reservation's material floor: the same day counts).
//   - Världen      operationsWithPlan (production-plan.ts) after each TO —
//                  the plan as writeOperationPlans would leave it, so a
//                  parent sees its children's bookings (planCoRun's pattern,
//                  co-run.ts).
//   - Påbörjad     operationStarted (capacity-calc.ts) — forced to today by
//                  the engine, whatever the golv says.
// Nothing is stored: the result is the days, the locks and the texts.
import { compareArticleNumbers } from "../../manufacturing/service/operation-materials.js";
import {
  operationStarted,
  orderPlannedRange,
  orderPlanStatus,
  plannedDateRange,
  resourceDayLoads,
  type CapacityInput,
  type CapacityOperationRow,
} from "./capacity-calc.js";
import {
  operationsWithPlan,
  planProduction,
  type MoveWorld,
  type OperationPlan,
  type PlanOperation,
  type PlanWarning,
} from "./production-plan.js";
// Types only — the tree's material rows as Strukturvyn maps them.
import type { StructureDemand, StructureOrderFacts } from "./structure-tree.js";

// What covers a TO's material without being a chosen TO of the tree.
export interface ReplanSupply {
  kind: "purchase_order" | "manufacturing_order";
  documentNumber: string;
}

// One chosen TO of the tree.
export interface ReplanOrder {
  manufacturingOrderId: string;
  orderNumber: string;
  parentOrderId: string | null;
  level: number; // 0 = the top
  // The due date AFTER a move of the dates, if any — it decides Sen, never
  // the placement.
  dueDate: string | null;
  // Ready days of what covers the TO's material and is NOT a chosen TO of
  // the tree (an IO, another TO, a halvfabrikat that was not chosen — the
  // pegging's readyDate). Stock is ready today and is simply left out.
  externalReady: (ReplanSupply & { date: string })[];
  // The chosen halvfabrikat-TOs that cover this TO's material: their NEW
  // finish day (this run's) is part of the golv.
  childOrderIds: string[];
  // Supply without a date and material without cover give no golv, only a
  // note (S32). Left out = none.
  undatedSupply?: ReplanSupply[];
  missingMaterial?: { articleNumber: string }[];
}

export interface StructureFloor {
  date: string; // always after today — a material ready today is no golv
  source: { kind: string; documentNumber: string } | null;
}

export interface StructurePlan {
  // What writeOperationPlans takes, in one call. `clear` holds every
  // operation of the chosen TOs that had days before and has none now.
  plans: OperationPlan[];
  clear: string[];
  // Every operation with a plan afterwards — never one without days (the
  // CHECK forbids a lock without a plan), so never lego.
  lockIds: string[];
  // The pending operations that were locked before the run and are planned
  // again all the same (S28).
  relockedIds: string[];
  finishOf: Map<string, string | null>; // the new klar-dag per TO, null = beyond the horizon
  floorOf: Map<string, StructureFloor>; // only the TOs that have a golv (after today)
  warnings: PlanWarning[]; // per TO: its own run's warnings
  // Started before the golv, missing or undated material, earlier locks.
  notes: string[];
  blocked: { manufacturingOrderId: string; orderNumber: string }[]; // the horizon
  // The world's operations after the run (the planned ones locked).
  operationsAfter: CapacityOperationRow[];
}

const byOrderNumber = (a: { orderNumber: string }, b: { orderNumber: string }) =>
  a.orderNumber.localeCompare(b.orderNumber, "sv", { numeric: true });
const hasPlan = (op: CapacityOperationRow) => plannedDateRange(op) !== null;

// Barn före föräldrar: the deepest first, order number (natural order) within
// a depth. The depth is the tree's `level`, pushed down by `childOrderIds` —
// a TO that covers two places of the tree (drawn once, on the shallower one)
// still comes before EVERY parent it is a chosen child of. A cycle in the
// input (never from the pegging) ends after as many passes as there are TOs.
export function structurePlanOrder(orders: readonly ReplanOrder[]): ReplanOrder[] {
  const depth = new Map(orders.map((o) => [o.manufacturingOrderId, o.level] as const));
  for (let pass = 0; pass < orders.length; pass++) {
    let changed = false;
    for (const parent of orders) {
      const below = depth.get(parent.manufacturingOrderId)! + 1;
      for (const childId of parent.childOrderIds) {
        const current = depth.get(childId);
        if (current !== undefined && current < below) {
          depth.set(childId, below);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return [...orders].sort(
    (a, b) => depth.get(b.manufacturingOrderId)! - depth.get(a.manufacturingOrderId)! || byOrderNumber(a, b)
  );
}

const supplyText = (source: { kind: string; documentNumber: string }) =>
  source.kind === "purchase_order" ? `${source.documentNumber} har kommit` : `${source.documentNumber} är klar`;

// The chosen TOs planned one at a time against ONE world that is updated
// after each. Never throws and never tests what the caller already has (the
// tree, the statuses): a TO without operations in the world simply gets no
// plan and the golv as its finish day.
export function planStructure(
  world: MoveWorld,
  stamped: ReadonlySet<string>,
  orders: readonly ReplanOrder[]
): StructurePlan {
  const { today } = world;
  const chosen = new Map(orders.map((o) => [o.manufacturingOrderId, o] as const));

  // 1. The tree's own load is released — or the tree would compete with its
  //    own old plan. Locked operations too (S28); they are listed. The rows
  //    carry the due date the run counts Sen on.
  const hadPlan = new Set<string>();
  const relockedIds: string[] = [];
  const relockedPerOrder = new Map<string, number>();
  let operations = world.operations.map((op) => {
    const order = chosen.get(op.manufacturingOrderId);
    if (!order) return op;
    if (hasPlan(op)) hadPlan.add(op.moOperationId);
    if (op.operationStatus !== "pending") return { ...op, dueDate: order.dueDate };
    if (op.planLocked && hasPlan(op)) {
      relockedIds.push(op.moOperationId);
      relockedPerOrder.set(order.manufacturingOrderId, (relockedPerOrder.get(order.manufacturingOrderId) ?? 0) + 1);
    }
    return { ...op, dueDate: order.dueDate, plannedDays: null, planLocked: false };
  });

  const plans: OperationPlan[] = [];
  const clear = new Set<string>();
  const lockIds: string[] = [];
  const finishOf = new Map<string, string | null>();
  const floorOf = new Map<string, StructureFloor>();
  const warnings: PlanWarning[] = [];
  const notes: string[] = [];
  const blocked: StructurePlan["blocked"] = [];

  // 2. Children before parents.
  for (const order of structurePlanOrder(orders)) {
    // The golv: the latest ready day among what covers the material — a
    // chosen child's NEW finish day, anything else its stored ready day.
    // The same day counts (S29). A child beyond the horizon gives none.
    // A day that is not after today is no golv at all (stock, a child with
    // nothing left to do).
    const ready: StructureFloor[] = [];
    for (const childId of order.childOrderIds) {
      const child = chosen.get(childId);
      const finish = finishOf.get(childId);
      if (child && finish != null) ready.push({ date: finish, source: { kind: "manufacturing_order", documentNumber: child.orderNumber } });
    }
    for (const r of order.externalReady) ready.push({ date: r.date, source: { kind: r.kind, documentNumber: r.documentNumber } });
    let golv: StructureFloor | null = null;
    for (const r of ready) if (r.date > today && (golv === null || r.date > golv.date)) golv = r;
    if (golv) floorOf.set(order.manufacturingOrderId, golv);

    const own: PlanOperation[] = [];
    const others: CapacityOperationRow[] = [];
    for (const op of operations) {
      if (op.manufacturingOrderId === order.manufacturingOrderId) {
        own.push({ ...op, started: operationStarted(op, stamped.has(op.moOperationId)) });
      } else others.push(op);
    }
    const result = planProduction({
      today,
      offDays: world.offDays,
      workCenters: world.workCenters,
      schedule: world.schedule,
      queueDays: world.queueDays,
      longOperationWeeks: world.longOperationWeeks,
      orders: [
        {
          id: order.manufacturingOrderId,
          orderNumber: order.orderNumber,
          dueDate: order.dueDate,
          operations: own,
          earliestStart: golv?.date ?? null,
        },
      ],
      existingOperations: others,
    });

    // 3. The world as the writer would leave it; the planned operations are
    //    locked there — fixed load for the TOs that follow.
    operations = operationsWithPlan(operations, result);
    const planned = new Set(result.plans.map((p) => p.operationId));
    operations = operations.map((op) =>
      planned.has(op.moOperationId) && hasPlan(op) ? { ...op, planLocked: true } : op
    );
    plans.push(...result.plans);
    for (const id of result.clear) clear.add(id);
    warnings.push(...result.warnings);
    finishOf.set(order.manufacturingOrderId, result.orders[0]?.plannedFinish ?? null);
    if (result.warnings.some((w) => w.kind === "horizon")) {
      blocked.push({ manufacturingOrderId: order.manufacturingOrderId, orderNumber: order.orderNumber });
    }

    // 4. The texts.
    const relocked = relockedPerOrder.get(order.manufacturingOrderId) ?? 0;
    if (relocked > 0) {
      notes.push(
        relocked === 1
          ? `${order.orderNumber}: 1 operation var låst och planeras om`
          : `${order.orderNumber}: ${relocked} operationer var låsta och planeras om`
      );
    }
    if (golv) {
      for (const plan of result.plans) {
        const op = own.find((o) => o.moOperationId === plan.operationId);
        if (op?.started && plan.startDate < golv.date) {
          notes.push(
            `${order.orderNumber} op ${op.sequenceNo} är påbörjad och ligger före att ${
              golv.source ? supplyText(golv.source) : "materialet är klart"
            } (${golv.date})`
          );
        }
      }
    }
    for (const supply of order.undatedSupply ?? []) {
      notes.push(`${order.orderNumber}: ${supply.documentNumber} saknar datum — räknas inte i när materialet är klart`);
    }
    const missing = [...new Set((order.missingMaterial ?? []).map((m) => m.articleNumber))];
    if (missing.length > 0) {
      notes.push(
        `${order.orderNumber}: material saknar täckning (${missing.join(", ")}) — räknas inte i när materialet är klart`
      );
    }
  }

  // Locked = has days in the world afterwards (a plan that rounds away is
  // cleared there, as the writer does). Cleared = had days, has none now.
  for (const op of operations) {
    if (!chosen.has(op.manufacturingOrderId)) continue;
    if (hasPlan(op)) {
      if (op.operationStatus === "pending") lockIds.push(op.moOperationId);
      clear.delete(op.moOperationId);
    } else if (hadPlan.has(op.moOperationId)) clear.add(op.moOperationId);
  }

  return {
    plans,
    clear: [...clear],
    lockIds,
    relockedIds,
    finishOf,
    floorOf,
    warnings,
    notes,
    blocked,
    operationsAfter: operations,
  };
}

// --- The tree, the choice and the answer (step 5b) -------------------------
// Still pure: the service loads Strukturvyn's levels (the same pegging, the
// same structureDemands) and the plan world; everything below is derived
// from them.

const REPLAN_OPEN_STATUSES: ReadonlySet<string> = new Set(["released", "in_progress"]);
// includeOrderIds takes at most this many halvfabrikat (the zod schema).
export const REPLAN_MAX_INCLUDED = 200;

// One TO of the tree under the top, listed ONCE (the first place, depth
// first — Strukturvyn's S25).
export interface ReplanTreeNode {
  manufacturingOrderId: string;
  orderNumber: string;
  articleNumber: string;
  articleName: string;
  orderStatus: string;
  // Frisläppt/Pågående — only those have operations to plan. A planned
  // (legacy) TO is listed as information.
  open: boolean;
  level: number; // 0 = the top
  parentOrderId: string | null;
  // Its whole allocated quantity goes to the parent (moveCandidates' rule,
  // as the tree's link says it); true for the top.
  exclusive: boolean;
  dueDate: string | null;
}

// The TOs of the tree, depth first: the top, then under each open TO the TOs
// that cover its material rows (article number order, then the allocations'
// own order). A TO that is already listed is not listed again — which also
// ends a cycle.
export function replanTree(
  topId: string,
  orders: ReadonlyMap<string, StructureOrderFacts>,
  demandsByOrder: ReadonlyMap<string, readonly StructureDemand[]>
): ReplanTreeNode[] {
  const out: ReplanTreeNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string, parentOrderId: string | null, level: number, exclusive: boolean) => {
    const facts = orders.get(id);
    if (!facts || seen.has(id)) return;
    seen.add(id);
    const open = REPLAN_OPEN_STATUSES.has(facts.orderStatus);
    out.push({
      manufacturingOrderId: id,
      orderNumber: facts.orderNumber,
      articleNumber: facts.articleNumber,
      articleName: facts.articleName,
      orderStatus: facts.orderStatus,
      open,
      level,
      parentOrderId,
      exclusive,
      dueDate: facts.dueDate,
    });
    if (!open) return;
    const demands = [...(demandsByOrder.get(id) ?? [])].sort(
      (a, b) => compareArticleNumbers(a, b) || a.rowId.localeCompare(b.rowId)
    );
    for (const demand of demands) {
      for (const a of demand.allocations) {
        if (a.kind === "manufacturing_order" && a.documentId !== null) visit(a.documentId, id, level + 1, a.exclusive);
      }
    }
  };
  visit(topId, null, 0, true);
  return out;
}

// Which TOs are planned. The top always. Left out (the preview's first
// call) = the default: a halvfabrikat that is open and exclusive all the way
// up (S31). Given = exactly those, and each must be an open TO of the tree
// whose parent is chosen — `valid` is false when one is not (it is then left
// out: the caller answers replan-structure-changed with this choice).
export function replanSelection(
  tree: readonly ReplanTreeNode[],
  includeOrderIds: readonly string[] | undefined
): { included: Set<string>; valid: boolean; capped: boolean } {
  const included = new Set<string>();
  const [top] = tree;
  if (!top) return { included, valid: includeOrderIds === undefined || includeOrderIds.length === 0, capped: false };
  included.add(top.manufacturingOrderId);
  const asked = includeOrderIds === undefined ? null : new Set(includeOrderIds);
  let capped = false;
  for (const node of tree.slice(1)) {
    if (!node.open || node.parentOrderId === null || !included.has(node.parentOrderId)) continue;
    if (asked ? !asked.has(node.manufacturingOrderId) : !node.exclusive) continue;
    // The top + REPLAN_MAX_INCLUDED halvfabrikat: more could not be sent back.
    if (!asked && included.size > REPLAN_MAX_INCLUDED) {
      capped = true;
      continue;
    }
    included.add(node.manufacturingOrderId);
  }
  // The top may be listed; anything else asked for must have been taken.
  const valid = asked === null || [...asked].every((id) => included.has(id));
  return { included, valid, capped };
}

// planStructure's input for the chosen TOs, from the material rows the tree
// was drawn from: a chosen TO that covers a row is a child (its NEW finish
// day is the golv), any other dated supply is `externalReady` with the
// pegging's ready day, an undated one and a row without cover give notes.
// Stock is ready today and left out.
export function replanOrders(
  tree: readonly ReplanTreeNode[],
  included: ReadonlySet<string>,
  demandsByOrder: ReadonlyMap<string, readonly StructureDemand[]>,
  dueDateOf: (manufacturingOrderId: string) => string | null
): ReplanOrder[] {
  const out: ReplanOrder[] = [];
  for (const node of tree) {
    const id = node.manufacturingOrderId;
    if (!included.has(id)) continue;
    const childOrderIds = new Set<string>();
    const externalReady = new Map<string, ReplanOrder["externalReady"][number]>();
    const undatedSupply = new Map<string, ReplanSupply>();
    const missingMaterial: { articleNumber: string }[] = [];
    for (const demand of demandsByOrder.get(id) ?? []) {
      if (demand.uncovered > 0) missingMaterial.push({ articleNumber: demand.articleNumber });
      for (const a of demand.allocations) {
        if (a.kind !== "manufacturing_order" && a.kind !== "purchase_order") continue; // stock
        if (a.kind === "manufacturing_order" && a.documentId !== null && a.documentId !== id && included.has(a.documentId)) {
          childOrderIds.add(a.documentId);
          continue;
        }
        const documentNumber = a.documentNumber ?? "?";
        if (a.readyDate === null) undatedSupply.set(`${a.kind}:${documentNumber}`, { kind: a.kind, documentNumber });
        else externalReady.set(`${a.kind}:${documentNumber}:${a.readyDate}`, { kind: a.kind, documentNumber, date: a.readyDate });
      }
    }
    out.push({
      manufacturingOrderId: id,
      orderNumber: node.orderNumber,
      parentOrderId: node.parentOrderId,
      level: node.level,
      dueDate: dueDateOf(id),
      externalReady: [...externalReady.values()],
      childOrderIds: [...childOrderIds],
      undatedSupply: [...undatedSupply.values()],
      missingMaterial,
    });
  }
  return out;
}

type DateRange = { start: string | null; end: string | null };

// What the client confirms: every TO of the tree with the due date and the
// planned days the preview was computed from.
export interface ReplanExpectedOrder {
  manufacturingOrderId: string;
  dueDate: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
}

// The answer of the preview and of the write.
export interface ReplanStructureResult {
  today: string;
  top: { manufacturingOrderId: string; orderNumber: string };
  // The whole tree's TOs, depth first.
  orders: {
    manufacturingOrderId: string;
    orderNumber: string;
    articleNumber: string;
    articleName: string;
    level: number;
    parentOrderId: string | null;
    exclusive: boolean;
    // May be chosen right now: open, and its parent is chosen (S31).
    selectable: boolean;
    included: boolean;
    sharedWith: string[]; // the other orders it covers (order numbers)
    // `after` of a chosen halvfabrikat with moveComponentDueDates = its new
    // klar-dag (`plannedFinish`). `late` is always false since that rule
    // (the date is the day it is ready); kept for the answer's shape.
    dueDate: { before: string | null; after: string | null; late: boolean };
    planned: { before: DateRange; after: DateRange };
    // The day it is ready after the run (lego counted from the day its
    // material is ready — see the note on a TO that starts with lego).
    plannedFinish: string | null;
    lateAfter: boolean; // Sen against the due date AFTER the run
    floor: StructureFloor | null;
    operations: {
      moOperationId: string;
      sequenceNo: number;
      workCenterCode: string;
      subcontract: boolean;
      started: boolean;
      wasLocked: boolean;
      before: DateRange;
      after: DateRange;
    }[];
  }[];
  // The matrix's day loads AFTER the run, only the (resource, day) the tree's
  // new plans touch, only the overloaded ones.
  overloadedDays: { workCenterCode: string; date: string; loadHours: number; availableHours: number | null }[];
  warnings: PlanWarning[];
  notes: string[];
  blocked: { manufacturingOrderId: string; orderNumber: string }[];
  expected: ReplanExpectedOrder[];
}

// The same tree and the same dates as the preview showed? Order does not
// matter; a TO more or less, another due date or other planned days do.
export function sameReplanExpected(current: readonly ReplanExpectedOrder[], sent: readonly ReplanExpectedOrder[]): boolean {
  if (current.length !== sent.length) return false;
  const byId = new Map(current.map((o) => [o.manufacturingOrderId, o]));
  if (byId.size !== current.length) return false;
  return sent.every((s) => {
    const c = byId.get(s.manufacturingOrderId);
    return !!c && c.dueDate === s.dueDate && c.plannedStartDate === s.plannedStartDate && c.plannedEndDate === s.plannedEndDate;
  });
}

const rangeOf = (op: CapacityOperationRow | undefined): DateRange => {
  const range = op ? plannedDateRange(op) : null;
  return { start: range?.start ?? null, end: range?.end ?? null };
};

// The answer, from what the run was computed on. Pure: no load — the write
// computes it BEFORE commit.
//
// Lego first. The engine starts a chosen TO's chain on its golv, so a lego
// operation that is not followed by an own planned operation is ready
// golv + its days — but nothing stores the golv: orderPlanStatus (Sen, the
// pegging's ready day, Strukturvyn) starts the same chain today. For such a
// TO `plannedFinish` here is the engine's day (the truthful one — the lego
// cannot be sent before its material is there, and the parent's golv is
// built on it), and a note states the day the other views will show. No
// second chain rule: the other day is orderPlanStatus itself, run on the
// operations as the write leaves them.
export function replanStructureOutcome(input: {
  tree: readonly ReplanTreeNode[];
  included: ReadonlySet<string>;
  sharedWith: ReadonlyMap<string, string[]>;
  // The chosen TOs whose due date is written.
  dueDates: ReadonlyMap<string, { after: string; late: boolean }>;
  world: MoveWorld; // BEFORE the run
  capacity: Pick<CapacityInput, "workCenters" | "weekScheduleDays" | "daySchedules" | "holidays">;
  stamped: ReadonlySet<string>;
  plan: StructurePlan;
  notes?: readonly string[];
}): ReplanStructureResult {
  const { tree, included, world, plan } = input;
  const { today } = world;
  const top = tree[0]!;
  const group = (operations: readonly CapacityOperationRow[]) => {
    const byOrder = new Map<string, CapacityOperationRow[]>();
    for (const op of operations) {
      const list = byOrder.get(op.manufacturingOrderId);
      if (list) list.push(op);
      else byOrder.set(op.manufacturingOrderId, [op]);
    }
    return byOrder;
  };
  const inTree = new Set(tree.map((n) => n.manufacturingOrderId));
  const before = group(world.operations.filter((op) => inTree.has(op.manufacturingOrderId)));
  const after = group(plan.operationsAfter.filter((op) => inTree.has(op.manufacturingOrderId)));
  const relocked = new Set(plan.relockedIds);
  const lateOrders = new Set(plan.warnings.filter((w) => w.kind === "late").map((w) => w.manufacturingOrderId));
  const statusCtx = { today, offDays: world.offDays, workCenters: world.workCenters, queueDays: world.queueDays };
  const notes: string[] = [...plan.notes, ...(input.notes ?? [])];

  const orders: ReplanStructureResult["orders"] = tree.map((node) => {
    const id = node.manufacturingOrderId;
    const isIncluded = included.has(id);
    const opsBefore = [...(before.get(id) ?? [])].sort((a, b) => a.sequenceNo - b.sequenceNo);
    const opsAfter = after.get(id) ?? [];
    const afterById = new Map(opsAfter.map((op) => [op.moOperationId, op]));
    const due = input.dueDates.get(id);
    const dueAfter = isIncluded && due ? due.after : node.dueDate;
    let plannedFinish: string | null = null;
    let lateAfter = false;
    if (isIncluded) {
      plannedFinish = plan.finishOf.get(id) ?? null;
      lateAfter = lateOrders.has(id);
      // The day the stored plan will say (see above) — only a TO with a lego
      // operation left can differ.
      const hasLego = opsAfter.some((op) => op.operationStatus === "pending" && world.workCenters.get(op.workCenterId)?.type === "subcontract");
      const floor = plan.floorOf.get(id);
      if (hasLego && floor && plannedFinish !== null) {
        const stored = orderPlanStatus(opsAfter, statusCtx);
        if (stored.planned && stored.plannedFinish !== null && stored.plannedFinish !== plannedFinish) {
          notes.push(
            `${node.orderNumber}: klar ${plannedFinish} — legot räknas här från att materialet är klart (${floor.date}). ` +
              `Listorna och strukturvyn räknar legot från i dag och visar ${stored.plannedFinish}`
          );
        }
      }
    } else if (opsBefore.length > 0) {
      const status = orderPlanStatus(opsBefore, statusCtx);
      plannedFinish = status.planned ? status.plannedFinish : null;
      lateAfter = status.late;
    }
    if (!node.open && node.level > 0) {
      notes.push(`${node.orderNumber} är inte frisläppt och saknar operationer — den planeras inte om`);
    }
    return {
      manufacturingOrderId: id,
      orderNumber: node.orderNumber,
      articleNumber: node.articleNumber,
      articleName: node.articleName,
      level: node.level,
      parentOrderId: node.parentOrderId,
      exclusive: node.exclusive,
      selectable: node.level > 0 && node.open && node.parentOrderId !== null && included.has(node.parentOrderId),
      included: isIncluded,
      sharedWith: input.sharedWith.get(id) ?? [],
      dueDate: { before: node.dueDate, after: dueAfter, late: isIncluded && !!due?.late },
      planned: { before: orderPlannedRange(opsBefore), after: orderPlannedRange(isIncluded ? opsAfter : opsBefore) },
      plannedFinish,
      lateAfter,
      floor: plan.floorOf.get(id) ?? null,
      operations: opsBefore.map((op) => ({
        moOperationId: op.moOperationId,
        sequenceNo: op.sequenceNo,
        workCenterCode: world.workCenters.get(op.workCenterId)?.code ?? "?",
        subcontract: world.workCenters.get(op.workCenterId)?.type === "subcontract",
        started: operationStarted(op, input.stamped.has(op.moOperationId)),
        wasLocked: relocked.has(op.moOperationId),
        before: rangeOf(op),
        after: rangeOf(isIncluded ? afterById.get(op.moOperationId) : op),
      })),
    };
  });

  // Överbelagda dagar: resourceDayLoads (the matrix's bucket) on the world
  // after the run, once per day the tree's new plans touch.
  const touched = new Map<string, Set<string>>(); // date → resources
  for (const op of plan.operationsAfter) {
    if (!included.has(op.manufacturingOrderId) || op.operationStatus !== "pending") continue;
    for (const day of op.plannedDays ?? []) {
      const set = touched.get(day.date);
      if (set) set.add(op.workCenterId);
      else touched.set(day.date, new Set([op.workCenterId]));
    }
  }
  const overloadedDays: ReplanStructureResult["overloadedDays"] = [];
  for (const [date, resources] of touched) {
    const loads = resourceDayLoads({ ...input.capacity, operations: plan.operationsAfter }, today, date);
    for (const workCenterId of resources) {
      const load = loads.get(workCenterId);
      if (!load?.overloaded) continue;
      overloadedDays.push({
        workCenterCode: world.workCenters.get(workCenterId)?.code ?? "?",
        date,
        loadHours: load.loadHours,
        availableHours: load.availableHours,
      });
    }
  }
  overloadedDays.sort((a, b) => a.workCenterCode.localeCompare(b.workCenterCode, "sv", { numeric: true }) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    today,
    top: { manufacturingOrderId: top.manufacturingOrderId, orderNumber: top.orderNumber },
    orders,
    overloadedDays,
    warnings: plan.warnings,
    notes,
    blocked: plan.blocked,
    expected: orders.map((o) => ({
      manufacturingOrderId: o.manufacturingOrderId,
      dueDate: o.dueDate.before,
      plannedStartDate: o.planned.before.start,
      plannedEndDate: o.planned.before.end,
    })),
  };
}
