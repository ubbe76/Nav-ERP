// Tidsfasade förslag (#13): the dating glue between the repository's flat
// rows and the pure rules in manufacturing-lead-time.ts — which resource an
// operation runs on, how long an article's routing takes for a quantity, and
// when every open TO starts. Pure like requirements-calc.ts (no DB imports):
// the planning service loads the rows once per run and hands them here, so
// the behovsberäkning, the artikelöversikt and the färdigdatumsförslag all
// date a TO's material through ONE implementation.
import {
  legoOperationDates,
  manufacturingLeadDays,
  moStartDate,
  NO_LEAD_TIME_DEFAULTS,
  routingLeadWork,
  type LeadTimeDefaults,
  type LeadTimeResource,
  type LeadTimeWork,
  type LegoOperationDates,
} from "./manufacturing-lead-time.js";
import { remainingOperationMinutes } from "./capacity-calc.js";

// work_centers as the lead time reads them. Ledtid beställning
// (orderLeadTimeDays) is the lego proposals' latest-order margin.
export interface DatingWorkCenter extends LeadTimeResource {
  workCenterId: string;
  orderLeadTimeDays: number | null;
}

// routing_operations without the Kalkyl-only ones (they never reach a TO).
export interface DatingRoutingOperation {
  articleId: string;
  workCenterId: string;
  setupTime: number;
  runTimePerUnit: number;
}

// mo_operations of the open TOs: what remainingOperationMinutes needs plus
// the planned start week (Produktionsplanering) and its lock — moStartDate
// decides when the plan wins over the lead time.
export interface DatingMoOperation {
  // Id and sequence number: the lego dating (computeLegoOperationDates)
  // needs the operations AFTER a lego operation.
  moOperationId: string;
  sequenceNo: number;
  manufacturingOrderId: string;
  workCenterId: string;
  setupTime: number;
  runTimePerUnit: number;
  operationStatus: "pending" | "done";
  orderQuantity: number;
  quantityCompleted: number | null;
  quantityScrapped: number;
  plannedStartWeek: string | null;
  planLocked: boolean;
}

export interface DatingManufacturingOrder {
  manufacturingOrderId: string;
  articleId: string;
  quantity: number;
  dueDate: string | null;
}

// The article's Ledtid (dagar) field; absent from the map = null.
export type ArticleLeadTimeFields = ReadonlyMap<string, number | null>;

export interface LeadTimeContext {
  resourceOf: (workCenterId: string) => LeadTimeResource | null;
  // The lead time of an unstarted routing for a quantity (a proposal, a new
  // TO): the field when set, else the routing's work plus the queue time
  // between the operations, else (no routing) the Standardledtid.
  leadDaysFor: (articleId: string, quantity: number) => number;
  orderLeadTimeDaysOf: (workCenterId: string) => number | null;
  // Standardledtid/Standardkötid as loaded for this run — every reader that
  // measures work through this context applies the same pair.
  defaults: LeadTimeDefaults;
}

export function buildLeadTimeContext(input: {
  articleLeadTimes: ArticleLeadTimeFields;
  routings: readonly DatingRoutingOperation[];
  workCenters: readonly DatingWorkCenter[];
  // Optional for the unit tests' fakes ⇒ no default lead time, no queue time.
  defaults?: LeadTimeDefaults;
}): LeadTimeContext {
  const defaults = input.defaults ?? NO_LEAD_TIME_DEFAULTS;
  const resources = new Map(input.workCenters.map((w) => [w.workCenterId, w]));
  const routingOf = new Map<string, DatingRoutingOperation[]>();
  for (const op of input.routings) {
    const list = routingOf.get(op.articleId);
    if (list) list.push(op);
    else routingOf.set(op.articleId, [op]);
  }
  const resourceOf = (workCenterId: string) => resources.get(workCenterId) ?? null;
  return {
    resourceOf,
    leadDaysFor: (articleId, quantity) =>
      manufacturingLeadDays(
        input.articleLeadTimes.get(articleId),
        routingLeadWork(routingOf.get(articleId) ?? [], quantity, resourceOf),
        defaults
      ),
    orderLeadTimeDaysOf: (workCenterId) => resources.get(workCenterId)?.orderLeadTimeDays ?? null,
    defaults,
  };
}

// Every open TO's start date (moStartDate): the due date minus the lead
// time, or the plan's earliest week when it is binding (locked or reported
// on) or later. A TO WITH operations
// (released/in progress — or planned with a snapshot) is measured on its own
// operations' remaining minutes plus the Standardkötid between the ones not
// yet done — a partly reported TO needs less time, one with every operation
// done needs 0 (its done operations are passed as `done` work so the
// Standardledtid never applies to it); a TO without any (an ordinary planned
// TO has none before release) on the article's routing for its quantity,
// and without a routing on the Standardledtid. The field Ledtid (dagar)
// wins in both cases, as everywhere.
export function computeMoStartDates(input: {
  orders: readonly DatingManufacturingOrder[];
  operations: readonly DatingMoOperation[];
  articleLeadTimes: ArticleLeadTimeFields;
  context: LeadTimeContext;
  offDays: ReadonlySet<string>;
}): Map<string, string | null> {
  const opsOf = new Map<string, DatingMoOperation[]>();
  for (const op of input.operations) {
    const list = opsOf.get(op.manufacturingOrderId);
    if (list) list.push(op);
    else opsOf.set(op.manufacturingOrderId, [op]);
  }
  const result = new Map<string, string | null>();
  for (const order of input.orders) {
    const ops = opsOf.get(order.manufacturingOrderId);
    let leadDays: number;
    if (ops && ops.length > 0) {
      const work: LeadTimeWork[] = ops.map((op) => ({
        minutes: remainingOperationMinutes(op),
        resource: input.context.resourceOf(op.workCenterId),
        done: op.operationStatus === "done",
      }));
      leadDays = manufacturingLeadDays(input.articleLeadTimes.get(order.articleId), work, input.context.defaults);
    } else {
      leadDays = input.context.leadDaysFor(order.articleId, order.quantity);
    }
    result.set(
      order.manufacturingOrderId,
      moStartDate({
        plannedStartWeeks: (ops ?? []).map((op) => op.plannedStartWeek),
        // Reported on (OK or scrap) = the work is under way, like Planera's
        // "påbörjad" (an open stamp session alone is not loaded here).
        planFixed: (ops ?? []).some(
          (op) => op.planLocked || (op.quantityCompleted ?? 0) > 0 || op.quantityScrapped > 0
        ),
        dueDate: order.dueDate,
        leadDays,
        offDays: input.offDays,
      })
    );
  }
  return result;
}

// Every lego operation's dates (legoOperationDates): backward from its TO's
// färdigdatum through the TO's own operations after it, or — a TO without a
// due date — from the TO's start (computeMoStartDates' result). ONE
// implementation for the behovsberäkning's lego rows and the lego IO row's
// Önskat leveransdatum (Skapa ordrar, also from the TO card). An id not
// among `operations` (or on a TO not among `orders`) is left out.
export function computeLegoOperationDates(input: {
  legoOperationIds: Iterable<string>;
  orders: readonly Pick<DatingManufacturingOrder, "manufacturingOrderId" | "dueDate">[];
  operations: readonly DatingMoOperation[];
  starts: ReadonlyMap<string, string | null>;
  context: LeadTimeContext;
  offDays: ReadonlySet<string>;
}): Map<string, LegoOperationDates> {
  const dueOf = new Map(input.orders.map((o) => [o.manufacturingOrderId, o.dueDate]));
  const byId = new Map(input.operations.map((op) => [op.moOperationId, op]));
  const opsOf = new Map<string, DatingMoOperation[]>();
  for (const op of input.operations) {
    const list = opsOf.get(op.manufacturingOrderId);
    if (list) list.push(op);
    else opsOf.set(op.manufacturingOrderId, [op]);
  }
  const result = new Map<string, LegoOperationDates>();
  for (const id of input.legoOperationIds) {
    const op = byId.get(id);
    if (!op || !dueOf.has(op.manufacturingOrderId)) continue;
    const after: LeadTimeWork[] = (opsOf.get(op.manufacturingOrderId) ?? [])
      .filter((o) => o.sequenceNo > op.sequenceNo)
      .map((o) => ({
        minutes: remainingOperationMinutes(o),
        resource: input.context.resourceOf(o.workCenterId),
        done: o.operationStatus === "done",
      }));
    result.set(
      id,
      legoOperationDates({
        dueDate: dueOf.get(op.manufacturingOrderId) ?? null,
        fallbackStart: input.starts.get(op.manufacturingOrderId) ?? null,
        lego: input.context.resourceOf(op.workCenterId),
        after,
        queueDays: input.context.defaults.queueDays,
        offDays: input.offDays,
      })
    );
  }
  return result;
}

// The lead time of a configured (beställningsvara) row's TO: the template's
// field, else the derived structure's operations for the row quantity (the
// same minute formula as a routing — the derived operations ARE the TO's
// routing) with the queue time between them, else the Standardledtid.
export function configuredLeadDays(
  templateLeadTimeDays: number | null | undefined,
  operations: readonly { workCenterId: string; setupTime: number; runTimePerUnit: number }[],
  quantity: number,
  context: LeadTimeContext
): number {
  return manufacturingLeadDays(templateLeadTimeDays, routingLeadWork(operations, quantity, context.resourceOf), context.defaults);
}
