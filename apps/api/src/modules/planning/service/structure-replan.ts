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
import { operationStarted, plannedDateRange, type CapacityOperationRow } from "./capacity-calc.js";
import {
  operationsWithPlan,
  planProduction,
  type MoveWorld,
  type OperationPlan,
  type PlanOperation,
  type PlanWarning,
} from "./production-plan.js";

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
