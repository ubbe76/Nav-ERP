import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { DispatchPageClient } from "../../../components/purchase/DispatchPageClient";
import { apiGet } from "../../../lib/api";
import type {
  Paged,
  PurchaseDispatch,
  PurchaseOrder,
  PurchaseOrderRow,
} from "../../../lib/types";

// Avsändning lego — report goods sent to a lego supplier against an open
// inköpsorder. ?order=<id> preselects (linked from the IO card and the TO
// card's operation menu).
export default async function DispatchPage(props: {
  searchParams: Promise<{ order?: string }>;
}) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;

  const openOrders = await apiGet<Paged<PurchaseOrder>>(
    "/api/v1/purchase-orders?kind=lego&status=draft,confirmed,partially_received&limit=1000",
    cookieHeader,
  );

  const selected = searchParams.order
    ? await apiGet<PurchaseOrder>(
        `/api/v1/purchase-orders/${searchParams.order}`,
        cookieHeader,
      ).catch(() => null)
    : null;
  const [rows, dispatches] = selected
    ? await Promise.all([
        apiGet<PurchaseOrderRow[]>(
          `/api/v1/purchase-orders/${selected.id}/rows`,
          cookieHeader,
        ),
        apiGet<PurchaseDispatch[]>(
          `/api/v1/purchase-orders/${selected.id}/dispatches`,
          cookieHeader,
        ),
      ])
    : [[], []];

  return (
    <AppShell active="Inköp">
      <DispatchPageClient
        selected={selected}
        rows={rows}
        dispatches={dispatches}
        openOrders={openOrders.rows}
      />
    </AppShell>
  );
}
