import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PriceListsPageClient } from "../../../components/sales/PriceListsPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, PriceList } from "../../../lib/types";

export default async function PriceListsPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const priceLists = await apiGet<Paged<PriceList>>(
    `/api/v1/price-lists${listApiQuery(searchParams, [], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Försäljning">
      <PriceListsPageClient priceLists={priceLists} pageSize={pageSize} />
    </AppShell>
  );
}
