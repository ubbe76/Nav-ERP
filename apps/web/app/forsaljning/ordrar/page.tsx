import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { SalesOrdersPageClient } from "../../../components/sales/SalesOrdersPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, SalesOrder } from "../../../lib/types";

export default async function SalesOrdersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Quotes moved to Offerter — old links (digest mails, bookmarks) filtered
  // on a quote status land there instead of on an always-empty order list.
  if (searchParams.status === "quote" || searchParams.status === "lost") {
    const qs = new URLSearchParams(
      Object.entries(searchParams).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : []))
    ).toString();
    redirect(`/forsaljning/offerter?${qs}`);
  }
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const orders = await apiGet<Paged<SalesOrder>>(
    `/api/v1/sales-orders${listApiQuery(searchParams, ["status"], pageSize)}&kind=order`,
    cookieHeader
  );

  return (
    <AppShell active="Försäljning">
      <SalesOrdersPageClient orders={orders} pageSize={pageSize} kind="order" />
    </AppShell>
  );
}
