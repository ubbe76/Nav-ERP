// Leverans i fara (spec 2026-11-26, etapp 3c): the three readers of the
// kundorder outlook outside the card — the kundorder list's filter and row
// mark (sales' DeliveryRiskReader), the alert Kundordrar med leverans i fara
// and through it Översiktens card. All three are the planning service's
// deliveryOutlooks; nothing is decided here and nothing is stored. A leaf so
// app.ts and the tests bind the same adapter.
import type { SalesOrderListOutlook } from "@navet/shared";
import type { OrderOutlook, OutlookOrderHead } from "./delivery-outlook.js";

export interface DeliveryRiskSource {
  deliveryOutlooks(orderIds: string[] | "open"): Promise<Map<string, { order: OutlookOrderHead; outlook: OrderOutlook }>>;
}

export interface DeliveryRiskOrder {
  orderId: string;
  orderNumber: string;
  partnerName: string;
  outlook: OrderOutlook;
}

const listOutlook = ({ status, daysLate, atRisk }: OrderOutlook): SalesOrderListOutlook | null =>
  status === "none" ? null : { status, daysLate, atRisk };

export function createDeliveryRiskReader(planning: DeliveryRiskSource) {
  // Leverans i fara: the open orders whose outlook is atRisk — the planning
  // service's deliveryRiskOrderIds (sales-delivery-risk.test.ts holds the
  // two equal), with the outlooks the same load already produced.
  async function atRisk() {
    return [...(await planning.deliveryOutlooks("open")).values()].filter((e) => e.outlook.atRisk);
  }
  return {
    // The alert's rows, with what the row text needs.
    async deliveryRiskOrders(): Promise<DeliveryRiskOrder[]> {
      return (await atRisk()).map((e) => ({
        orderId: e.order.salesOrderId,
        orderNumber: e.order.orderNumber,
        partnerName: e.order.customerName,
        outlook: e.outlook,
      }));
    },

    // The list's filter: the ids, and each order's mark from the same load —
    // the filtered page never pays for a second one.
    async deliveryRiskOutlooks(): Promise<Map<string, SalesOrderListOutlook>> {
      const result = new Map<string, SalesOrderListOutlook>();
      for (const e of await atRisk()) {
        const outlook = listOutlook(e.outlook);
        if (outlook) result.set(e.order.salesOrderId, outlook);
      }
      return result;
    },

    // The list's row mark. An order that is no demand ("none": a quote, a
    // delivered order, only rows without an outlook) is left out.
    async outlookByOrder(orderIds: string[]): Promise<Map<string, SalesOrderListOutlook>> {
      const result = new Map<string, SalesOrderListOutlook>();
      if (orderIds.length === 0) return result;
      for (const [id, e] of await planning.deliveryOutlooks(orderIds)) {
        const outlook = listOutlook(e.outlook);
        if (outlook) result.set(id, outlook);
      }
      return result;
    },
  };
}
