// Förslag på alternativ resurs (#15, etapp 2) — which untouched operations
// would be ready on an earlier day on another of their possible resources
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
  operationChain,
  type CapacityBookInput,
  type ChoiceBase,
  type PlanWorkCenter,
  type ResourceCandidate,
} from "./capacity-book.js";
import {
  operationLoadDays,
  operationStarted,
  remainingOperationMinutes,
  type CapacityOperationRow,
  type PlannedDay,
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
  // Standardkötid as loaded for this read — the walk's floors must be
  // Planera's (the same operationChain), or a förslag promises a day Byt
  // does not give.
  queueDays: number;
  horizonWeeks?: number;
}

// Why the current resource counts as full: the load pushes its klar-dag
// ("overloaded"), or the operation has no plan to compare with — it did not
// fit within the horizon, was never planned, or its stored days have passed
// and it no longer fits ("unplanned").
export type SuggestionReason = "overloaded" | "unplanned";

// One operation's förslag as the TO card and the matrix cell carry it.
export interface OperationResourceSuggestion {
  workCenterId: string; // the suggested resource
  code: string;
  name: string;
  toDate: string; // the day it would be ready on the suggested resource
  // The current resource's klar-dag as compared (measureBase): the stored
  // plan's last day, or the trial's when the load now finishes it earlier
  // (a stale plan); null = unplanned.
  currentToDate: string | null;
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
  currentToDate: string | null;
  toDate: string;
  reason: SuggestionReason;
}

export const operationSuggestionOf = (s: ResourceSuggestion): OperationResourceSuggestion => ({
  workCenterId: s.toWorkCenterId,
  code: s.toCode,
  name: s.toName,
  toDate: s.toDate,
  currentToDate: s.currentToDate,
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
// TOs), is not plan-locked (a locked day is the planner's decision or the
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

const hasPlan = (op: CapacityOperationRow) => !!op.plannedDays && op.plannedDays.length > 0;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Every förslag in the world (or only `onlyOrderIds`' operations), by order
// number and sequence. ONE book with all open load as existing load; nothing
// is booked, so the förslag never see each other — two operations can be
// suggested the same free day on 120, and after a switch the next read may
// drop the other one (spec, "Inget bokas"). The current resource is not
// booked on the alternatives, so no load counts twice.
//
// Per order the walk is Planera's (production-plan.ts) through the SAME
// operationChain: the floor is today for the first operation, then the
// working day after the previous one is ready plus the Standardkötid, with
// the gaps counted exactly as Planera counts them (operations without time
// take no place; a lego operation does). A locked operation stays where it
// is (its stored days); every other one is measured like the base
// (measureBase): its ready day is its trial's day with the load minus its
// own stored days — where Planera puts it when a Byt replans the order —
// and the stored day only when the trial does not fit within the horizon.
// Never the earlier of the two: a previous operation whose stored day is
// overbooked would hold the floor too early and promise a day the switch
// never gives (granskningen av etapp 3); a stored day that has passed is no
// plan any more (granskningen av etapp 2: the plan's age must not move the
// floor). The earliest-of rule is only the comparison's (Valregeln,
// currentToDate).
//
// The load every trial of an order is made against is Byt's (#18): the
// replanning takes ALL the order's unlocked pending operations out of the
// load and places them again in sequence, so the order's own stored days on
// a resource are never in its way — not only the measured operation's own
// (`ownLoad` below; an operation of the same order stored on the day after
// an overbooked previous one would otherwise push the floor, and the förslag
// would name a later day than Byt gives). The operations placed before the
// measured one need not be booked back: each ends before the next one's
// floor, so they never share a day with what is measured. An own operation with time but no plan stops the walk, as
// Planera's horizonHit does: nothing after it gets a förslag. The base is
// the operation's CURRENT resource (chooseResource with the stored base).
export function resourceSuggestions(world: SuggestionWorld, onlyOrderIds?: ReadonlySet<string>): ResourceSuggestion[] {
  const inScope = (orderId: string) => !onlyOrderIds || onlyOrderIds.has(orderId);
  if (!world.operations.some((op) => inScope(op.manufacturingOrderId) && mayGetResourceSuggestion(op))) return [];

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
    const chain = operationChain(world.today, world.queueDays, world.offDays);
    const pending = ops
      .filter((op) => op.operationStatus === "pending")
      .sort((a, b) => a.sequenceNo - b.sequenceNo || compareText(a.moOperationId, b.moOperationId));
    // The order's own load Planera would place again (unlocked, pending),
    // per resource, as the book holds it.
    const ownLoad = new Map<string, PlannedDay[]>();
    for (const op of pending) {
      if (op.planLocked && hasPlan(op)) continue;
      const days = operationLoadDays(op, world.today).filter((c): c is PlannedDay => c.date !== null);
      if (days.length > 0) ownLoad.set(op.workCenterId, [...(ownLoad.get(op.workCenterId) ?? []), ...days]);
    }
    for (const op of pending) {
      const wc = world.workCenters.get(op.workCenterId) ?? null;
      if (wc?.type === "subcontract") {
        chain.advance(book.subcontract(wc, chain.floor()));
        continue;
      }
      const minutes = remainingOperationMinutes(op);
      if (minutes < MIN_PLAN_MINUTES) continue; // nothing left to place (Planera clears it, no gap)
      const chunks = operationLoadDays(op, world.today);

      if (op.planLocked && hasPlan(op)) {
        // Locked (Flytta, the reservation): Planera never moves it — the
        // next floor counts from its stored last day.
        chain.advance(chunks[chunks.length - 1]!.date!);
        continue;
      }
      const lastStored = hasPlan(op) ? op.plannedDays!.reduce((last, d) => maxDate(last, d.date), "") : null;
      const base: ChoiceBase = {
        // A last day that has passed is no plan — the trial decides.
        stored: lastStored !== null && lastStored >= world.today ? lastStored : null,
        without: ownLoad.get(op.workCenterId) ?? [],
      };
      const floor = chain.floor();
      if (mayGetResourceSuggestion(op)) {
        const suggestion = suggestFor(op, wc, minutes, floor, base, ownLoad);
        if (suggestion) out.push(suggestion);
      }
      // Planera's horizonHit: an operation that did not fit (or was never
      // planned) — nothing after it is planned, so nothing gets a förslag.
      if (!hasPlan(op)) break;
      // Planera's påbörjad (operationStarted) — also an operation that is
      // only stamped in: Byt's replanning forces it to today, so must the
      // walk, or the next floor is another day than the switch gives.
      const started = operationStarted(op, op.stamped === true);
      const measured = measureBase(book, { workCenter: wc, minutes }, floor, base, {
        forceStartDate: started ? world.today : undefined,
      });
      // The trial's day, where Planera puts it when a Byt replans the
      // order — never the earlier stored day of an overbooked plan
      // (granskningen av etapp 3). The stored day only when the trial
      // does not fit within the horizon.
      const endDate = measured.trialToDate ?? measured.toDate;
      if (endDate === null) break; // a passed plan that no longer fits within the horizon
      chain.advance(endDate);
    }
  }
  return out;

  function suggestFor(
    op: CapacityOperationRow,
    wc: PlanWorkCenter | null,
    minutes: number,
    floor: string,
    base: ChoiceBase,
    ownLoad: ReadonlyMap<string, readonly PlannedDay[]>
  ): ResourceSuggestion | null {
    const others = [...(op.resources ?? [])]
      .filter((r) => r.workCenterId !== op.workCenterId)
      .sort((a, b) => a.rank - b.rank);
    const candidates: ResourceCandidate[] = [
      { workCenter: wc, minutes },
      ...others.map((r) => ({
        workCenter: world.workCenters.get(r.workCenterId) ?? null,
        minutes: remainingOperationMinutes({ ...op, setupTime: r.setupTime, runTimePerUnit: r.runTimePerUnit }),
        without: ownLoad.get(r.workCenterId),
      })),
    ];
    const choice = chooseResource(book, candidates, floor, base);
    if (choice.index === 0 || choice.toDate === null) return null;
    const to = candidates[choice.index]!.workCenter!;
    const currentToDate = hasPlan(op) ? choice.baseToDate : null;
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
      currentToDate,
      toDate: choice.toDate,
      reason: currentToDate === null ? "unplanned" : "overloaded",
    };
  }
}
