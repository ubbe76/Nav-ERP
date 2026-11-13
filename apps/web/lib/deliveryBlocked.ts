import { SALES_ORDER_STATUS_PILL, type SalesOrderStatus } from "./types";

// Utleverans: only an order in status Under tillverkning can be delivered
// (POST /sales-orders/:id/deliver answers 409 invalid-status-transition
// otherwise). The routine opens any order through ?order=<id>, so it says
// at once why the selected order cannot be delivered and what to do,
// instead of letting Rapportera fail. null = the order can be delivered.
export function deliveryBlockedText(order: { orderNumber: string; status: SalesOrderStatus }): string | null {
  const n = order.orderNumber;
  switch (order.status) {
    case "in_production":
      return null;
    case "confirmed":
      return `${n} kan inte levereras ännu — ordern är Bekräftad. Starta tillverkningen på orderkortet först (Starta tillverkning eller Skapa TO), så blir den Under tillverkning.`;
    case "quote":
      return `${n} är en offert och kan inte levereras. Skapa en kundorder ur offerten först.`;
    case "ordered":
      return `${n} är en offert som redan har blivit order — leverera kundordern som skapades ur den.`;
    case "lost":
      return `${n} är en förlorad offert och kan inte levereras.`;
    case "cancelled":
      return `${n} är avbruten och kan inte levereras.`;
    default:
      return `${n} kan inte levereras — ordern är ${SALES_ORDER_STATUS_PILL[order.status]?.label ?? order.status}. Bara ordrar i status Under tillverkning kan levereras.`;
  }
}
