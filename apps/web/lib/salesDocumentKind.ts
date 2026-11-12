// Mirror of salesDocumentKind in packages/shared/src/sales.ts (the web app
// cannot import @navet/shared — see lib/units.ts). Keep the two in sync.
//
// A sales_orders row is an offert (quote) while its status is quote/lost/
// ordered (Order — a quote that gave a kundorder is still the quote), or
// when it was cancelled as a quote (its KO-less OF number is still the order
// number); everything else is a kundorder.

export type SalesDocumentKind = "quote" | "order";

export function salesDocumentKind(order: {
  status: string;
  orderNumber: string;
  quoteNumber?: string | null;
}): SalesDocumentKind {
  if (order.status === "quote" || order.status === "lost" || order.status === "ordered") return "quote";
  if (order.status === "cancelled" && order.quoteNumber != null && order.orderNumber === order.quoteNumber) {
    return "quote";
  }
  return "order";
}

export function salesDocumentPath(kind: SalesDocumentKind, id: string): string {
  return kind === "quote" ? `/forsaljning/offerter/${id}` : `/forsaljning/ordrar/${id}`;
}
