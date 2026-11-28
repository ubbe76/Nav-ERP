// Dagplan — Utleveranser och Inleveranser (the user's wish 2026-11-28): the
// kundorder rows that are to leave us and the inköpsorder rows that are to
// come ONE day, for the morning meeting. Pure, no database imports, and no
// rule of its own:
//   - Utleveranser  the Leveransläge's rows (delivery-outlook.ts): the day is
//                   the row's ship date (the pegging's demand date, i.e.
//                   shipDateFor of the Leveransdatum), the readiness is the
//                   outlook's status and allocations.
//   - Inleveranser  the row's effective arrival date (purchaseRowArrivalDate:
//                   Bekräftat before Önskat, the row's before the order's).
//   - Dagarna       dayPlanDays (day-plan.ts).
// Nothing is stored: the lists are derived at every read.
import { round4 } from "@navet/shared";
import { addDays, addWorkingDays } from "../../system/service/delivery-days.js";
import type { DayPlanDays } from "./day-plan.js";
import type { OutlookAllocation, OutlookOrderHead, OutlookRow, OutlookStatus } from "./delivery-outlook.js";

// The day's span: the day itself through the day before the next working
// day — a Friday also lists the weekend, the day before a holiday the
// holiday — so a row dated on a day the company does not work is never
// skipped by Föregående/Nästa. Today also lists what has passed (Försenade).
export interface DayPlanOrderSpan {
  today: string;
  date: string;
  through: string;
}

export function dayPlanOrderSpan(today: string, date: string, offDays: ReadonlySet<string>): DayPlanOrderSpan {
  return { today, date, through: addDays(addWorkingDays(date, 1, offDays), -1) };
}

// On the shown day's list: within the span, or before today when the day
// shown is today. An undated row is on no day.
export function onOrderSpan(day: string | null, span: DayPlanOrderSpan): boolean {
  if (day === null || day > span.through) return false;
  return day >= span.date || span.date === span.today;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface DayPlanShipment {
  key: string; // so:<rowId>
  salesOrderId: string;
  orderNumber: string;
  customerName: string;
  salesOrderRowId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unit: string | null; // the article's base unit
  restQuantity: number; // ordered − delivered, base unit
  configured: boolean;
  promisedDate: string | null; // Leveransdatum — the day the customer gets it
  shipDate: string; // Avsändning — the day on the list
  // The ship date has passed — only on today's list (Försenade).
  overdue: boolean;
  // The Leveransläge: will the rest be there by the ship date.
  status: OutlookStatus;
  daysLate: number;
  componentLate: boolean;
  atRisk: boolean;
  readyDate: string | null;
  uncovered: number;
  allocations: OutlookAllocation[];
}

// The Leveransläge's rows on the span, earliest ship date first, then the
// order number — an order's rows in the card's order.
export function dayPlanShipments(
  entries: Iterable<{ order: OutlookOrderHead; rows: OutlookRow[] }>,
  span: DayPlanOrderSpan,
  units: ReadonlyMap<string, string | null>
): DayPlanShipment[] {
  const list: DayPlanShipment[] = [];
  for (const { order, rows } of entries) {
    for (const row of rows) {
      const shipDate = row.promisedShipDate;
      if (shipDate === null || !onOrderSpan(shipDate, span)) continue;
      list.push({
        key: `so:${row.salesOrderRowId}`,
        salesOrderId: order.salesOrderId,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        salesOrderRowId: row.salesOrderRowId,
        articleId: row.articleId,
        articleNumber: row.articleNumber,
        articleName: row.articleName,
        unit: units.get(row.articleId) ?? null,
        restQuantity: row.restQuantity,
        configured: row.configured,
        promisedDate: row.promisedDate,
        shipDate,
        overdue: shipDate < span.today,
        status: row.status,
        daysLate: row.daysLate,
        componentLate: row.componentLate,
        atRisk: row.atRisk,
        readyDate: row.readyDate,
        uncovered: row.uncovered,
        allocations: row.allocations,
      });
    }
  }
  // A stable sort: the rows of one order keep the card's order.
  return list.sort((a, b) => compareText(a.shipDate, b.shipDate) || compareText(a.orderNumber, b.orderNumber));
}

// An inköpsorder row as the repository reads it (dayPlanArrivalRows): an
// open order, rest left, not a tjänst, dated, in the card's row order.
export interface DayPlanArrivalLoad {
  purchaseOrderId: string;
  orderNumber: string;
  orderStatus: string;
  supplierName: string;
  purchaseOrderRowId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unit: string | null;
  quantityOrdered: number;
  quantityReceived: number;
  arrivalDate: string;
  // Bekräftat leveransdatum on the row or the order — the supplier's word.
  confirmed: boolean;
  // A legorad: the TO operation the goods come back from.
  lego: { manufacturingOrderId: string; orderNumber: string; sequenceNo: number } | null;
}

export interface DayPlanArrival {
  key: string; // po:<rowId>
  purchaseOrderId: string;
  orderNumber: string;
  orderStatus: string;
  supplierName: string;
  purchaseOrderRowId: string;
  articleId: string;
  articleNumber: string;
  articleName: string;
  unit: string | null;
  restQuantity: number; // ordered − received, base unit
  arrivalDate: string;
  // The arrival date has passed — only on today's list (Försenade).
  overdue: boolean;
  confirmed: boolean;
  lego: DayPlanArrivalLoad["lego"];
}

// The rows on the span, earliest arrival first, then the order number — an
// order's rows in the card's order.
export function dayPlanArrivals(rows: DayPlanArrivalLoad[], span: DayPlanOrderSpan): DayPlanArrival[] {
  return rows
    .filter((r) => onOrderSpan(r.arrivalDate, span) && r.quantityReceived < r.quantityOrdered)
    .map((r) => ({
      key: `po:${r.purchaseOrderRowId}`,
      purchaseOrderId: r.purchaseOrderId,
      orderNumber: r.orderNumber,
      orderStatus: r.orderStatus,
      supplierName: r.supplierName,
      purchaseOrderRowId: r.purchaseOrderRowId,
      articleId: r.articleId,
      articleNumber: r.articleNumber,
      articleName: r.articleName,
      unit: r.unit,
      restQuantity: round4(r.quantityOrdered - r.quantityReceived),
      arrivalDate: r.arrivalDate,
      overdue: r.arrivalDate < span.today,
      confirmed: r.confirmed,
      lego: r.lego,
    }))
    .sort((a, b) => compareText(a.arrivalDate, b.arrivalDate) || compareText(a.orderNumber, b.orderNumber));
}

// GET /planning/day-plan/orders. No prices.
export interface DayPlanOrdersResult extends DayPlanDays {
  through: string; // the span's last day (the day itself on most days)
  shipments: DayPlanShipment[];
  arrivals: DayPlanArrival[];
}
