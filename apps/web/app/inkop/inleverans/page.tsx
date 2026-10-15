import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { GoodsReceiptPageClient } from "../../../components/purchase/GoodsReceiptPageClient";
import { apiGet } from "../../../lib/api";
import type { Paged, PurchaseOrder, PurchaseOrderRow, StockLocation } from "../../../lib/types";

// Inleverans — pick a receivable purchase order and report the whole receipt
// at once. ?order=<id> preselects (linked from the order card).
export default async function GoodsReceiptPage(props: { searchParams: Promise<{ order?: string }> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const locations = await apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader);

  // The full list of receivable orders — shown as a browsable "Mottagbara
  // ordrar" table below the picker so the routine works without knowing the
  // order number.
  const openOrders = await apiGet<Paged<PurchaseOrder>>(
    "/api/v1/purchase-orders?status=confirmed,partially_received&withOpenRows=true&limit=1000",
    cookieHeader
  );

  // The selected order may have just left the receivable list (fully
  // received) — fetched directly so the routine can still show the result.
  const selected = searchParams.order
    ? await apiGet<PurchaseOrder>(`/api/v1/purchase-orders/${searchParams.order}`, cookieHeader).catch(() => null)
    : null;
  const rows = selected
    ? await apiGet<PurchaseOrderRow[]>(`/api/v1/purchase-orders/${selected.id}/rows`, cookieHeader)
    : [];

  return (
    <AppShell active="Inköp">
      <GoodsReceiptPageClient locations={locations} selected={selected} rows={rows} openOrders={openOrders.rows} />
    </AppShell>
  );
}
