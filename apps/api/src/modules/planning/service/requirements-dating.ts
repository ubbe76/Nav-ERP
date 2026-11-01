// Tidsfasade förslag (#13): the dating glue between the repository's flat
// rows and the pure rules in manufacturing-lead-time.ts — which resource an
// operation runs on, how long an article's routing takes for a quantity, and
// when every open TO starts. Pure like requirements-calc.ts (no DB imports):
// the planning service loads the rows once per run and hands them here, so
// the behovsberäkning, the artikelöversikt and the färdigdatumsförslag all
// date a TO's material through ONE implementation.
import {
  manufacturingLeadDays,
  moStartDate,
  routingLeadWork,
  type LeadTimeResource,
  type LeadTimeWork,
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
  // TO): the field when set, else the routing's work.
  leadDaysFor: (articleId: string, quantity: number) => number;
  orderLeadTimeDaysOf: (workCenterId: string) => number | null;
}

export function buildLeadTimeContext(input: {
  articleLeadTimes: ArticleLeadTimeFields;
  routings: readonly DatingRoutingOperation[];
  workCenters: readonly DatingWorkCenter[];
}): LeadTimeContext {
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
        routingLeadWork(routingOf.get(articleId) ?? [], quantity, resourceOf)
      ),
    orderLeadTimeDaysOf: (workCenterId) => resources.get(workCenterId)?.orderLeadTimeDays ?? null,
  };
}

// Every open TO's start date (moStartDate): the due date minus the lead
// time, or the plan's earliest week when it is binding (locked or reported
// on) or later. A TO WITH operations
// (released/in progress — or planned with a snapshot) is measured on its own
// operations' remaining minutes, a partly reported TO needs less time; a TO
// without any (an ordinary planned TO has none before release) on the
// article's routing for its quantity. The field Ledtid (dagar) wins in both
// cases, as everywhere.
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
      }));
      leadDays = manufacturingLeadDays(input.articleLeadTimes.get(order.articleId), work);
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

// The lead time of a configured (beställningsvara) row's TO: the template's
// field, else the derived structure's operations for the row quantity (the
// same minute formula as a routing — the derived operations ARE the TO's
// routing).
export function configuredLeadDays(
  templateLeadTimeDays: number | null | undefined,
  operations: readonly { workCenterId: string; setupTime: number; runTimePerUnit: number }[],
  quantity: number,
  context: LeadTimeContext
): number {
  return manufacturingLeadDays(templateLeadTimeDays, routingLeadWork(operations, quantity, context.resourceOf));
}
