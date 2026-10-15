import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { ManufacturingOrdersPageClient } from "../../../components/manufacturing/ManufacturingOrdersPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { ManufacturingOrder, Paged } from "../../../lib/types";

export default async function ManufacturingOrdersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const orders = await apiGet<Paged<ManufacturingOrder>>(
    `/api/v1/manufacturing-orders${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Tillverkning">
      <ManufacturingOrdersPageClient orders={orders} pageSize={pageSize} />
    </AppShell>
  );
}
