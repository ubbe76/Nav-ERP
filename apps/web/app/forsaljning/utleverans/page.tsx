import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { DeliveryPageClient } from "../../../components/sales/DeliveryPageClient";
import { apiGet } from "../../../lib/api";
import type { Paged, SalesOrder, SalesOrderRow, StockLocation } from "../../../lib/types";

// Utleverans — pick an in-production sales order and report the whole
// delivery at once. ?order=<id> preselects (linked from the order card).
export default async function DeliveryPage(props: { searchParams: Promise<{ order?: string }> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const locations = await apiGet<StockLocation[]>("/api/v1/stock/locations", cookieHeader);

  // The full list of deliverable orders — shown as a browsable "Levererbara
  // ordrar" table below the picker so the routine works without knowing the
  // order number (mirrors inleverans' "Mottagbara ordrar").
  const openOrders = await apiGet<Paged<SalesOrder>>(
    "/api/v1/sales-orders?status=in_production&withOpenRows=true&limit=1000",
    cookieHeader
  );

  // The selected order may have just left the deliverable list (fully
  // delivered) — fetched directly so the routine can still show the result.
  const selected = searchParams.order
    ? await apiGet<SalesOrder>(`/api/v1/sales-orders/${searchParams.order}`, cookieHeader).catch(() => null)
    : null;
  const rows = selected ? await apiGet<SalesOrderRow[]>(`/api/v1/sales-orders/${selected.id}/rows`, cookieHeader) : [];

  return (
    <AppShell active="Försäljning">
      <DeliveryPageClient locations={locations} selected={selected} rows={rows} openOrders={openOrders.rows} />
    </AppShell>
  );
}
