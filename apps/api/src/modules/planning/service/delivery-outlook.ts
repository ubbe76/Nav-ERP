// Leveransläge (spec 2026-11-26, etapp 3): will a kundorder row with rest
// leave on the day it was promised? Pure, no database imports, and no
// lateness rule of its own:
//   - Sen          the pegging's flags (pegLateness, pegging.ts) on the
//                  row's allocations — the same answer as the TO card's
//                  Går till for the same allocation. A supply is on time
//                  when it is ready NO LATER THAN the row's ship date; stock
//                  is never late (S16). This file never compares a ready
//                  date with a demand date.
//   - Otäckt       the pegging's `uncovered`; for a configured row
//                  (beställningsvara, S19) uncoveredConfiguredQuantity —
//                  the template's stock and TOs are other configurations'.
//   - Leverans     deliveryFromShipDate, handed in bound to the customer's
//                  delivery settings (`deliver`).
// Nothing is stored: the outlook is derived at every read.
import { round4 } from "@navet/shared";
import { configuredCoverageSums, isOpenLinkedOrder, uncoveredConfiguredQuantity } from "./configured-coverage.js";
import { pegLateness, pegReadyDate, type PegSupplyKind } from "./pegging.js";

export type OutlookStatus = "on_time" | "late" | "undated" | "uncovered";

export interface OutlookAllocation {
  kind: PegSupplyKind;
  documentId: string | null; // null for stock
  documentNumber: string | null;
  quantity: number;
  // The supply's ready date floored at today; null = undated.
  readyDate: string | null;
  late: boolean;
  undated: boolean;
  daysLate: number; // working days after the row's ship date; 0 unless late
  isDraft: boolean; // an inköpsorder in Utkast
  componentLate: boolean; // a TO with Halvfabrikat sent; false for the others
}

// What the row itself says, before any coverage.
export interface OutlookRowFacts {
  salesOrderRowId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  restQuantity: number; // ordered − delivered, > 0
  configured: boolean;
  // Lovat: the row's effective delivery date (the day the customer gets the
  // goods). Avsändning: the day they must leave us — the overview row's
  // date, i.e. the pegging's demand date.
  promisedDate: string | null;
  promisedShipDate: string | null;
}

export interface OutlookRow extends OutlookRowFacts {
  allocations: OutlookAllocation[];
  uncovered: number;
  // Klart: the day the whole rest is there — the latest ready date among the
  // allocations; null when something is uncovered or undated.
  readyDate: string | null;
  estimatedShipDate: string | null;
  estimatedDeliveryDate: string | null;
  status: OutlookStatus;
  daysLate: number; // the largest among the allocations
  componentLate: boolean;
  overdue: boolean; // promised before today — the lists' Sen (salesRowLate)
  atRisk: boolean;
}

export interface OrderOutlook {
  status: OutlookStatus | "none";
  daysLate: number;
  atRisk: boolean;
  promisedDate: string | null;
  estimatedDeliveryDate: string | null;
  counts: { late: number; uncovered: number; undated: number; componentLate: number };
}

// The order a set of rows belongs to — what the list, the alert and the
// card name it by. No prices.
export interface OutlookOrderHead {
  salesOrderId: string;
  orderNumber: string;
  orderStatus: string;
  customerId: string;
  customerName: string;
  promisedDate: string | null; // the head's Förväntat leveransdatum
}

// GET /sales-orders/:id/delivery-outlook.
export interface SalesOrderDeliveryOutlook extends OrderOutlook {
  salesOrderId: string;
  orderNumber: string;
  orderStatus: string;
  today: string;
  rows: OutlookRow[];
}

// Leverans i fara (S18): Sen, Saknar täckning or covered by a TO with
// Halvfabrikat sent. Tillgång utan datum is a question for inköp, not a
// delay.
export function isAtRisk(row: Pick<OutlookRow, "status" | "componentLate">): boolean {
  return row.status === "late" || row.status === "uncovered" || row.componentLate;
}

// One row from its allocations. The status is tried in the order uncovered,
// late, undated, on_time — a covered row without a promised date is on time
// (an undated demand is never late). `deliver` = deliveryFromShipDate bound
// to the customer's settings (without delivery settings: the identity).
// Beräknad leverans (S17): the promised date while the row is on time —
// never an earlier date nobody promised — and deliver(readyDate) when late.
export function outlookRow(input: {
  today: string;
  row: OutlookRowFacts;
  allocations: OutlookAllocation[];
  uncovered: number;
  deliver: (shipDate: string) => string;
}): OutlookRow {
  const { today, row, allocations, uncovered } = input;
  const status: OutlookStatus =
    uncovered > 0 ? "uncovered" : allocations.some((a) => a.late) ? "late" : allocations.some((a) => a.undated) ? "undated" : "on_time";

  let readyDate: string | null = null;
  if (uncovered <= 0 && allocations.length > 0 && allocations.every((a) => a.readyDate !== null)) {
    readyDate = allocations.reduce((latest, a) => (a.readyDate! > latest ? a.readyDate! : latest), allocations[0]!.readyDate!);
  }
  let estimatedShipDate: string | null = null;
  let estimatedDeliveryDate: string | null = null;
  if (status === "on_time") {
    estimatedShipDate = row.promisedShipDate;
    estimatedDeliveryDate = row.promisedDate;
  } else if (status === "late" && readyDate !== null) {
    estimatedShipDate = readyDate;
    estimatedDeliveryDate = input.deliver(readyDate);
  }

  const componentLate = allocations.some((a) => a.componentLate);
  return {
    ...row,
    allocations,
    uncovered,
    readyDate,
    estimatedShipDate,
    estimatedDeliveryDate,
    status,
    daysLate: allocations.reduce((max, a) => Math.max(max, a.daysLate), 0),
    componentLate,
    overdue: row.promisedDate !== null && row.promisedDate < today,
    atRisk: isAtRisk({ status, componentLate }),
  };
}

const SEVERITY: Record<OutlookStatus, number> = { on_time: 0, undated: 1, late: 2, uncovered: 3 };

// The order from its rows: the worst row's status ("none" without rows —
// a quote, a delivered order), the largest daysLate, the latest estimated
// delivery — null as soon as one row has no ready date, since the order is
// not complete before its last row.
export function orderOutlook(rows: OutlookRow[], headPromisedDate: string | null): OrderOutlook {
  let status: OrderOutlook["status"] = "none";
  let estimatedDeliveryDate: string | null = null;
  const counts = { late: 0, uncovered: 0, undated: 0, componentLate: 0 };
  for (const row of rows) {
    if (status === "none" || SEVERITY[row.status] > SEVERITY[status]) status = row.status;
    if (row.status !== "on_time") counts[row.status] += 1;
    if (row.componentLate) counts.componentLate += 1;
    if (row.estimatedDeliveryDate !== null && (estimatedDeliveryDate === null || row.estimatedDeliveryDate > estimatedDeliveryDate)) {
      estimatedDeliveryDate = row.estimatedDeliveryDate;
    }
  }
  return {
    status,
    daysLate: rows.reduce((max, r) => Math.max(max, r.daysLate), 0),
    atRisk: rows.some((r) => r.atRisk),
    promisedDate: headPromisedDate,
    estimatedDeliveryDate: rows.some((r) => r.readyDate === null) ? null : estimatedDeliveryDate,
    counts,
  };
}

// A linked TO of a configured row. `readyDate` is the TO's plannedFinish ??
// dueDate as loaded — floored here.
export interface OutlookLinkedOrder {
  id: string;
  orderNumber: string;
  status: string;
  quantity: number;
  received: number; // manufacturing_orders.quantity_received
  readyDate: string | null;
  componentLate: boolean;
}

// The configured row's coverage (S19), from its OWN linked TOs: what they
// have finished and that has not left yet is there now (a stock allocation,
// never late), then each open TO takes what it has yet to receive, in ready
// date order (undated last) and never more than the row still needs — the
// pegging's FIFO. `uncovered` is uncoveredConfiguredQuantity, the lateness
// pegLateness against the row's ship date.
export function configuredRowCoverage(input: {
  today: string;
  promisedShipDate: string | null;
  quantityOrdered: number;
  quantityDelivered: number;
  linkedOrders: OutlookLinkedOrder[];
  offDays: ReadonlySet<string>;
}): { allocations: OutlookAllocation[]; uncovered: number } {
  const allocations: OutlookAllocation[] = [];
  const allocate = (kind: PegSupplyKind, order: OutlookLinkedOrder | null, quantity: number, readyDate: string | null) => {
    allocations.push({
      kind,
      documentId: order?.id ?? null,
      documentNumber: order?.orderNumber ?? null,
      quantity,
      readyDate,
      ...pegLateness({ kind, readyDate }, input.promisedShipDate, input.offDays),
      isDraft: false,
      componentLate: order?.componentLate ?? false,
    });
  };

  let need = round4(Math.max(0, input.quantityOrdered - input.quantityDelivered));
  const { finished } = configuredCoverageSums(input.linkedOrders);
  const inStock = round4(Math.min(need, Math.max(0, finished - input.quantityDelivered)));
  if (inStock > 0) {
    allocate("stock", null, inStock, input.today);
    need = round4(need - inStock);
  }
  const open = input.linkedOrders
    .filter((o) => isOpenLinkedOrder(o.status))
    .map((order) => ({ order, readyDate: pegReadyDate(order.readyDate, input.today) }))
    .sort(
      (a, b) =>
        (a.readyDate === null ? 1 : 0) - (b.readyDate === null ? 1 : 0) ||
        (a.readyDate === b.readyDate ? 0 : a.readyDate! < b.readyDate! ? -1 : 1) ||
        (a.order.id < b.order.id ? -1 : a.order.id > b.order.id ? 1 : 0),
    );
  for (const { order, readyDate } of open) {
    const quantity = round4(Math.min(need, Math.max(0, order.quantity - order.received)));
    if (quantity <= 0) continue;
    allocate("manufacturing_order", order, quantity, readyDate);
    need = round4(need - quantity);
  }
  return {
    allocations,
    uncovered: uncoveredConfiguredQuantity({
      quantityOrdered: input.quantityOrdered,
      quantityDelivered: input.quantityDelivered,
      linkedOrders: input.linkedOrders,
    }),
  };
}
