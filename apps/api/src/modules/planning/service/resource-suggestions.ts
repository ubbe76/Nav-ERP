// Förslag på alternativ resurs (#15, etapp 2) — which untouched operations
// would be ready in an earlier week on another of their possible resources
// (mo_operation_resources). Derived at every read and never stored: Planera
// never switches a resource (beslut 1), the planner does it by hand with
// Byt till X (PATCH …/operations/:opId { workCenterId }), which makes the
// operation Vald för hand and so ends its förslag.
//
// Pure, like production-plan.ts: the service loads the rows (the matrix's
// own input) and calls this. Readers: GET /planning/capacity (cells and the
// summary's räknare), the TO card's operations and Planera's answer.
import {
  chooseResource,
  createCapacityBook,
  measureBase,
  MIN_PLAN_MINUTES,
  type CapacityBookInput,
  type ChoiceBase,
  type PlanWorkCenter,
  type ResourceCandidate,
} from "./capacity-book.js";
import {
  mondayOf,
  operationLoadWeeks,
  remainingOperationMinutes,
  type CapacityOperationRow,
  type PlannedWeek,
} from "./capacity-calc.js";

const maxDate = (a: string, b: string) => (a > b ? a : b);

// The world one read suggests in: every open operation (the load as the
// matrix sees it, and each order's walk), the resources (`active` decides
// whether an alternative is tried), the calendars out to the horizon.
export interface SuggestionWorld {
  today: string;
  offDays: ReadonlySet<string>;
  workCenters: Map<string, PlanWorkCenter>;
  schedule: CapacityBookInput["schedule"];
  operations: CapacityOperationRow[];
  horizonWeeks?: number;
}

// Why the current resource counts as full: the load pushes its klar-vecka
// ("overloaded"), or the operation has no plan to compare with — it did not
// fit within the horizon, was never planned, or its stored weeks have passed
// and it no longer fits ("unplanned").
export type SuggestionReason = "overloaded" | "unplanned";

// One operation's förslag as the TO card and the matrix cell carry it.
export interface OperationResourceSuggestion {
  workCenterId: string; // the suggested resource
  code: string;
  name: string;
  toWeek: string; // Monday of the week it would be ready on the suggested resource
  // The current resource's klar-vecka as compared (measureBase): the stored
  // plan's last week, or the trial's when the load now finishes it earlier
  // (a stale plan); null = unplanned.
  currentToWeek: string | null;
  reason: SuggestionReason;
}

// The list form: the summary's räknare and Planera's notice.
export interface ResourceSuggestion {
  moOperationId: string;
  manufacturingOrderId: string;
  orderNumber: string;
  sequenceNo: number;
  fromWorkCenterId: string;
  fromCode: string;
  toWorkCenterId: string;
  toCode: string;
  toName: string;
  currentToWeek: string | null;
  toWeek: string;
  reason: SuggestionReason;
}

export const operationSuggestionOf = (s: ResourceSuggestion): OperationResourceSuggestion => ({
  workCenterId: s.toWorkCenterId,
  code: s.toCode,
  name: s.toName,
  toWeek: s.toWeek,
  currentToWeek: s.currentToWeek,
  reason: s.reason,
});

// Rörd: anything reported, a time report, a stamp or a scrap — the load's
// `touched` (operationTouchedSql), with the row's own quantities and time
// flags as the fallback. Stricter than Planera's påbörjad on purpose: a 0/0
// stamp-out after Ställ klart means the setup was done on THIS machine.
const touched = (op: CapacityOperationRow) =>
  op.touched === true ||
  (op.quantityCompleted ?? 0) > 0 ||
  op.quantityScrapped > 0 ||
  op.timeOnCurrentResource === true ||
  op.timeOnOtherResource === true;

// Which operations may get a förslag (spec, "Vilka operationer"): it has
// possible resources, is pending (the load only holds frisläppta/pågående
// TOs), is not plan-locked (a locked week is the planner's decision or the
// reservation's promise — Lås upp makes it current again), not Vald för
// hand, and untouched. Valregeln then decides whether there is one.
export function mayGetResourceSuggestion(op: CapacityOperationRow): boolean {
  return (
    (op.resources?.length ?? 0) > 0 &&
    op.operationStatus === "pending" &&
    !op.planLocked &&
    !op.resourceLocked &&
    !touched(op)
  );
}

const hasPlan = (op: CapacityOperationRow) => !!op.plannedWeeks && op.plannedWeeks.length > 0;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Every förslag in the world (or only `onlyOrderIds`' operations), by order
// number and sequence. ONE book with all open load as existing load; nothing
// is booked, so the förslag never see each other — two operations can be
// suggested the same free week on 120, and after a switch the next read may
// drop the other one (spec, "Inget bokas"). The current resource is not
// booked on the alternatives, so no load counts twice.
//
// Per order the walk is Planera's (production-plan.ts): the floor is today,
// moved by each earlier pending operation's klar-vecka (the next operation
// may use the rest of that week — the floor is a Monday) or a lego
// operation's lead time. A locked operation stays where it is (its stored
// weeks); every other one is measured like the base (measureBase): the
// floor is its trial's week with the load minus its own stored weeks —
// where Planera puts it when a Byt replans the order — and the stored week
// only when the trial does not fit within the horizon. Never the earlier of
// the two: a previous operation whose stored week is overbooked would hold
// the floor a week early and promise a week the switch never gives
// (granskningen av etapp 3); a stored week that has passed is no plan any
// more (granskningen av etapp 2: the plan's age must not move the floor).
// The earliest-of rule is only the comparison's (Valregeln, currentToWeek).
// An own operation with time but no plan stops the walk, as Planera's
// horizonHit does: nothing after it gets a förslag. The base is the
// operation's CURRENT resource (chooseResource with the stored base).
export function resourceSuggestions(world: SuggestionWorld, onlyOrderIds?: ReadonlySet<string>): ResourceSuggestion[] {
  const inScope = (orderId: string) => !onlyOrderIds || onlyOrderIds.has(orderId);
  if (!world.operations.some((op) => inScope(op.manufacturingOrderId) && mayGetResourceSuggestion(op))) return [];

  const firstMonday = mondayOf(world.today);
  const book = createCapacityBook({
    today: world.today,
    offDays: world.offDays,
    horizonWeeks: world.horizonWeeks,
    workCenters: world.workCenters,
    schedule: world.schedule,
    existingOperations: world.operations,
  });

  const byOrder = new Map<string, CapacityOperationRow[]>();
  for (const op of world.operations) {
    if (!inScope(op.manufacturingOrderId)) continue;
    byOrder.set(op.manufacturingOrderId, [...(byOrder.get(op.manufacturingOrderId) ?? []), op]);
  }
  const orders = [...byOrder.values()].sort(
    (a, b) => compareText(a[0]!.orderNumber, b[0]!.orderNumber) || compareText(a[0]!.manufacturingOrderId, b[0]!.manufacturingOrderId)
  );

  const out: ResourceSuggestion[] = [];
  for (const ops of orders) {
    if (!ops.some(mayGetResourceSuggestion)) continue;
    let floor = world.today; // capacity may be used from this day
    let ready = floor; // the day the previous operation is done
    const pending = ops
      .filter((op) => op.operationStatus === "pending")
      .sort((a, b) => a.sequenceNo - b.sequenceNo || compareText(a.moOperationId, b.moOperationId));
    for (const op of pending) {
      const wc = world.workCenters.get(op.workCenterId) ?? null;
      if (wc?.type === "subcontract") {
        ready = book.subcontract(wc, maxDate(ready, floor));
        floor = ready;
        continue;
      }
      const minutes = remainingOperationMinutes(op);
      if (minutes < MIN_PLAN_MINUTES) continue; // nothing left to place (Planera clears it)
      const chunks = operationLoadWeeks(op, firstMonday);

      let endWeek: string | null;
      if (op.planLocked && hasPlan(op)) {
        // Locked (Flytta, the reservation): Planera never moves it.
        endWeek = chunks.length > 0 ? chunks[chunks.length - 1]!.monday : null;
      } else {
        const lastStored = hasPlan(op) ? op.plannedWeeks!.reduce((last, w) => maxDate(last, w.monday), "") : null;
        const base: ChoiceBase = {
          stored: lastStored !== null && lastStored >= firstMonday ? lastStored : null,
          without: chunks.filter((c): c is PlannedWeek => c.monday !== null),
        };
        if (mayGetResourceSuggestion(op)) {
          const suggestion = suggestFor(op, wc, minutes, floor, base);
          if (suggestion) out.push(suggestion);
        }
        // Planera's horizonHit: an operation that did not fit (or was never
        // planned) — nothing after it is planned, so nothing gets a förslag.
        if (!hasPlan(op)) break;
        const started = (op.quantityCompleted ?? 0) > 0 || op.quantityScrapped > 0;
        const measured = measureBase(book, { workCenter: wc, minutes }, floor, base, {
          forceStartWeek: started ? firstMonday : undefined,
        });
        // The trial's week, where Planera puts it when a Byt replans the
        // order — never the earlier stored week of an overbooked plan
        // (granskningen av etapp 3). The stored week only when the trial
        // does not fit within the horizon.
        endWeek = measured.trialToWeek ?? measured.toWeek;
        if (endWeek === null) break; // a passed plan that no longer fits within the horizon
      }
      if (endWeek !== null) {
        ready = maxDate(ready, book.weekFinishDay(wc, endWeek, floor));
        floor = maxDate(floor, endWeek);
      }
    }
  }
  return out;

  function suggestFor(
    op: CapacityOperationRow,
    wc: PlanWorkCenter | null,
    minutes: number,
    floor: string,
    base: ChoiceBase
  ): ResourceSuggestion | null {
    const others = [...(op.resources ?? [])]
      .filter((r) => r.workCenterId !== op.workCenterId)
      .sort((a, b) => a.rank - b.rank);
    const candidates: ResourceCandidate[] = [
      { workCenter: wc, minutes },
      ...others.map((r) => ({
        workCenter: world.workCenters.get(r.workCenterId) ?? null,
        minutes: remainingOperationMinutes({ ...op, setupTime: r.setupTime, runTimePerUnit: r.runTimePerUnit }),
      })),
    ];
    const choice = chooseResource(book, candidates, floor, base);
    if (choice.index === 0 || choice.toWeek === null) return null;
    const to = candidates[choice.index]!.workCenter!;
    const currentToWeek = hasPlan(op) ? choice.baseToWeek : null;
    return {
      moOperationId: op.moOperationId,
      manufacturingOrderId: op.manufacturingOrderId,
      orderNumber: op.orderNumber,
      sequenceNo: op.sequenceNo,
      fromWorkCenterId: op.workCenterId,
      fromCode: wc?.code ?? "?",
      toWorkCenterId: to.workCenterId,
      toCode: to.code,
      toName: to.name,
      currentToWeek,
      toWeek: choice.toWeek,
      reason: currentToWeek === null ? "unplanned" : "overloaded",
    };
  }
}
