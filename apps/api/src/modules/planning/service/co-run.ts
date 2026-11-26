// Samkörning — operations with the same ingoing material run together (spec
// 2026-11-26, etapp 2). Pure, no database imports, and NO placement rule of
// its own:
//   - Flytten      planOperationMove (production-plan.ts) — Flytta's rule,
//                  once per moved operation, against ONE world in memory.
//   - Världen      operationsWithPlan (production-plan.ts) after each move —
//                  the plan as writeOperationPlans would leave it, so the
//                  second move sees the first.
//   - På dagen     plannedDateRange (capacity-calc.ts) — the körplan's day.
//   - Materialet   the rows' own RunPlanMaterial (B3: purchased, linked,
//                  something left), grouped per article.
// Nothing is stored: a co-run is the moved days, the locks and the places.
import { round4 } from "@navet/shared";
import { compareArticleNumbers } from "../../manufacturing/service/operation-materials.js";
import { plannedDateRange, type CapacityDayLoad, type CapacityOperationRow } from "./capacity-calc.js";
import {
  operationsWithPlan,
  planOperationMove,
  type MoveWorld,
  type OperationPlan,
  type PlanWarning,
} from "./production-plan.js";
import type { RunPlanRow } from "./run-plan.js";

// --- Material-läget ---------------------------------------------------------

// One ingoing material with the listed operations that draw it.
export interface RunPlanMaterialGroup {
  articleId: string;
  articleNumber: string;
  articleName: string;
  unit: string | null;
  // The sum of the rows' remaining quantities of the article.
  totalRemainingQuantity: number;
  // The article's whole usable balance (the rows carry the same figure).
  usableOnHand: number;
  // The balance does not cover the group TOGETHER — the competition a row's
  // own status (per row against the whole balance, S2) never shows.
  short: boolean;
  // RunPlanRow.key, in the order of the list — each operation once.
  rowKeys: string[];
}

// The rows grouped per co-run material, in article number order. A row with
// two materials stands in both groups. An operation can carry the same
// article on two material rows (linkedOperationMaterials keeps one entry per
// row): it stands ONCE in the group, and both quantities count in the total.
// `unlinkedRowKeys` = the open orders' operations without linked purchased
// material ("saknar kopplat material") — a Planerad TO's operation has no
// material rows to link yet and is never listed there.
export function groupRunPlanByMaterial(rows: RunPlanRow[]): {
  groups: RunPlanMaterialGroup[];
  unlinkedRowKeys: string[];
} {
  const byArticle = new Map<string, RunPlanMaterialGroup & { sum: number; keys: Set<string> }>();
  const unlinkedRowKeys: string[] = [];
  for (const row of rows) {
    if (!row.materialLinked && row.status !== "planned_order") unlinkedRowKeys.push(row.key);
    for (const material of row.materials) {
      let group = byArticle.get(material.articleId);
      if (!group) {
        group = {
          articleId: material.articleId,
          articleNumber: material.articleNumber,
          articleName: material.articleName,
          unit: material.unit,
          totalRemainingQuantity: 0,
          usableOnHand: material.usableOnHand,
          short: false,
          rowKeys: [],
          sum: 0,
          keys: new Set(),
        };
        byArticle.set(material.articleId, group);
      }
      group.sum += material.remainingQuantity;
      if (!group.keys.has(row.key)) {
        group.keys.add(row.key);
        group.rowKeys.push(row.key);
      }
    }
  }
  const groups = [...byArticle.values()]
    .map(({ sum, keys: _keys, ...group }) => {
      const totalRemainingQuantity = round4(sum);
      return { ...group, totalRemainingQuantity, short: group.usableOnHand < totalRemainingQuantity };
    })
    .sort(compareArticleNumbers);
  return { groups, unlinkedRowKeys };
}

// --- Samkör — reglerna ------------------------------------------------------

export type CoRunOutcome = "moved" | "already_on_day" | "not_placed";

export interface CoRunPlan {
  // The union of every move — the LAST plan of an operation is the one that
  // counts. What writeOperationPlans takes, in one call.
  plans: OperationPlan[];
  clear: string[];
  // The selected operations that have a plan afterwards (moved or already on
  // the day) — never one beyond the horizon (the CHECK forbids a lock
  // without days).
  lockIds: string[];
  outcomes: Map<string, CoRunOutcome>;
  // The day has no capacity on the resource: nothing is planned at all.
  noCapacity: boolean;
  // Per order: the LAST run's warnings.
  warnings: PlanWarning[];
  // The world's operations after the co-run (the selected ones locked).
  operationsAfter: CapacityOperationRow[];
}

const lockedInWorld = (operations: CapacityOperationRow[], operationId: string): CapacityOperationRow[] =>
  operations.map((op) => (op.moOperationId === operationId ? { ...op, planLocked: true } : op));

// The selected operations moved to `date`, one at a time in the given order,
// against ONE world that is updated after each move. Never throws and never
// tests what the caller already has (status, lego, time, the resource).
export function planCoRun(
  world: MoveWorld,
  stamped: ReadonlySet<string>,
  input: { date: string; operationIds: string[] }
): CoRunPlan {
  const { date } = input;
  let operations = world.operations;
  const outcomes = new Map<string, CoRunOutcome>();

  // Förpass: an operation already on the day is not planned again (its days
  // and its place stay) — it is locked in the world BEFORE any move, so the
  // moves that follow treat it as fixed load, also a move of an earlier
  // operation in its own order.
  for (const operationId of input.operationIds) {
    const op = operations.find((o) => o.moOperationId === operationId);
    if (!op || plannedDateRange(op)?.start !== date) continue;
    outcomes.set(operationId, "already_on_day");
    operations = lockedInWorld(operations, operationId);
  }

  const plans = new Map<string, OperationPlan>();
  const clear = new Set<string>();
  let warnings: PlanWarning[] = [];
  for (const operationId of input.operationIds) {
    if (outcomes.has(operationId)) continue;
    const result = planOperationMove({ ...world, operations }, stamped, { operationId, date, moveFollowing: true });
    // The forced day took nothing (a weekend, a röd dag, a free day in the
    // schedule): the book went on to the first day with capacity. The
    // selected operations share the resource and the day, so it holds for
    // all of them — nothing is planned.
    const ownPlan = result.plans.find((p) => p.operationId === operationId);
    if (ownPlan && ownPlan.startDate !== date) {
      return {
        plans: [],
        clear: [],
        lockIds: [],
        outcomes: new Map(),
        noCapacity: true,
        warnings: [],
        operationsAfter: world.operations,
      };
    }
    for (const plan of result.plans) {
      plans.set(plan.operationId, plan);
      clear.delete(plan.operationId);
    }
    for (const id of result.clear) {
      plans.delete(id);
      clear.add(id);
    }
    operations = operationsWithPlan(operations, result);
    // Placed = it has days in the world (a plan that rounds away is cleared
    // there, as the writer does); otherwise the horizon — the warning says so.
    const after = operations.find((o) => o.moOperationId === operationId);
    const placed = !!after && plannedDateRange(after) !== null;
    if (placed) operations = lockedInWorld(operations, operationId);
    outcomes.set(operationId, placed ? "moved" : "not_placed");
    // A run plans ONE order: its warnings replace that order's earlier ones.
    const orderIds = new Set(result.orders.map((o) => o.manufacturingOrderId));
    warnings = [...warnings.filter((w) => !orderIds.has(w.manufacturingOrderId)), ...result.warnings];
  }

  return {
    plans: [...plans.values()],
    clear: [...clear],
    lockIds: input.operationIds.filter((id) => outcomes.get(id) === "already_on_day" || outcomes.get(id) === "moved"),
    outcomes,
    noCapacity: false,
    warnings,
    operationsAfter: operations,
  };
}

// --- Körordningen efter flytten ---------------------------------------------

// The day's places after a co-run. `current` = the resource's pending,
// planned operations on the day AFTER the write. The ones already ordered
// that are not selected keep their order, then the selected ones that lie on
// the day as a block, in the order they were selected. An operation on the
// day without a place that is not selected is left without one (the körplan
// lists it after the ordered ones, as before).
export function coRunOrder(current: { id: string; runPosition: number | null }[], selectedIds: string[]): string[] {
  const selected = new Set(selectedIds);
  const onDay = new Set(current.map((op) => op.id));
  const ordered = current
    .filter((op) => op.runPosition !== null && !selected.has(op.id))
    .sort((a, b) => a.runPosition! - b.runPosition!)
    .map((op) => op.id);
  return [...ordered, ...selectedIds.filter((id) => onDay.has(id))];
}

// --- Svaret -----------------------------------------------------------------

// What POST /planning/co-run and its preview answer with — the same shape,
// the preview computed and the write as written.
export interface CoRunResult {
  workCenter: { id: string; code: string; name: string };
  date: string;
  // The selected operations, in the order they were sent.
  operations: {
    moOperationId: string;
    manufacturingOrderId: string;
    orderNumber: string;
    sequenceNo: number;
    fromDate: string | null;
    plannedStartDate: string | null;
    plannedEndDate: string | null;
    outcome: CoRunOutcome;
  }[];
  // Operations that were NOT selected and whose days changed or were
  // removed, by order number (natural order), then sequence.
  following: {
    moOperationId: string;
    manufacturingOrderId: string;
    orderNumber: string;
    sequenceNo: number;
    workCenterCode: string;
    fromStartDate: string | null;
    plannedStartDate: string | null;
    plannedEndDate: string | null;
  }[];
  // The resource's load on the day before and after (resourceDayLoads).
  dayLoad: { before: CapacityDayLoad; after: CapacityDayLoad };
  // The warnings of kind `late`.
  lateOrders: { manufacturingOrderId: string; orderNumber: string; dueDate: string | null; plannedFinish: string | null }[];
  warnings: PlanWarning[];
  // The selected operations' co-run materials, summed per article.
  materials: RunPlanMaterialGroup[];
  // The day's places afterwards (coRunOrder): the ones already ordered, then
  // the block.
  runOrder: { moOperationId: string; orderNumber: string; sequenceNo: number; selected: boolean }[];
}
