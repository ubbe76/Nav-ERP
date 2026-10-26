import { apiFetch } from "./api";
import { round2 } from "./format";
import type { PurchaseOrderRow } from "./types";

// One previewed supplier-invoice line built from a purchase-order row
// (fakturaunderlag). articleId is null and purchaseOrderRowId absent on a lego
// row's ställpris line — a fee line, not goods, and PO-row matching compares
// unit prices.
export type PreviewRow = {
  id: string;
  description: string;
  articleId: string | null;
  quantity: number;
  unitPrice: number;
  purchaseOrderRowId?: string;
};

// Mottaget = only received rows, at the received quantity; Beställt = all rows,
// ordered quantity. Shared by Ny leverantörsfaktura (Hämta orderrader) and the
// Fakturainkorg's review (an order proposal without rows from the AI).
export type BasisQuantity = "received" | "ordered";

export async function fetchPurchaseOrderBasis(orderId: string, qtyBasis: BasisQuantity): Promise<PreviewRow[]> {
  const rows = await apiFetch<PurchaseOrderRow[]>(`/api/v1/purchase-orders/${orderId}/rows`);
  return buildBasisRows(rows, qtyBasis);
}

export function buildBasisRows(rows: PurchaseOrderRow[], qtyBasis: BasisQuantity): PreviewRow[] {
  const built: PreviewRow[] = [];
  for (const r of rows) {
    if (qtyBasis === "received" ? Number(r.quantityReceived) === 0 : Number(r.quantityOrdered) === 0) continue;
    built.push({
      id: r.id,
      description: `${r.articleNumber} — ${r.articleName}`,
      articleId: r.articleId,
      quantity: qtyBasis === "received" ? Number(r.quantityReceived) : Number(r.quantityOrdered),
      unitPrice: Number(r.unitPrice),
      purchaseOrderRowId: r.id,
    });
    // Lego row: the one-off ställpris is part of what the subcontractor
    // invoices — its own fee line (it is not per unit, so it cannot ride
    // in unitPrice), without article/PO-row match.
    if (r.setupPrice != null && Number(r.setupPrice) > 0) {
      built.push({
        id: `${r.id}-setup`,
        description: `Ställpris — ${r.articleNumber}`,
        articleId: null,
        quantity: 1,
        unitPrice: Number(r.setupPrice),
      });
    }
  }
  return built;
}

export function basisRowsSum(rows: readonly PreviewRow[]): number {
  return round2(rows.reduce((acc, r) => acc + r.quantity * r.unitPrice, 0));
}
