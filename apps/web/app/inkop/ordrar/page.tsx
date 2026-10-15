import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PurchaseOrdersPageClient } from "../../../components/purchase/PurchaseOrdersPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, PurchaseOrder } from "../../../lib/types";

export default async function PurchaseOrdersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const orders = await apiGet<Paged<PurchaseOrder>>(
    `/api/v1/purchase-orders${listApiQuery(searchParams, ["status", "kind"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Inköp">
      <PurchaseOrdersPageClient orders={orders} pageSize={pageSize} />
    </AppShell>
  );
}
