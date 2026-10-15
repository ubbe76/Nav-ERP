import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SalesOrdersPageClient } from "../../../components/sales/SalesOrdersPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, SalesOrder } from "../../../lib/types";

export default async function SalesOrdersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const orders = await apiGet<Paged<SalesOrder>>(
    `/api/v1/sales-orders${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Försäljning">
      <SalesOrdersPageClient orders={orders} pageSize={pageSize} />
    </AppShell>
  );
}
