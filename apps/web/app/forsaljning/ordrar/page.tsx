import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { SplitListPage } from "../../../components/split/SplitListPage";
import { TableView } from "../../../components/split/ListViewToggle";
import { listPageView } from "../../../lib/listViewServer";
import { SalesOrdersPageClient } from "../../../components/sales/SalesOrdersPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { withFinishedRule } from "../../../lib/listFilter";
import { SALES_ORDER_FILTER } from "../../../lib/statusFilters";
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
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/forsaljning/ordrar", searchParams)) === "list") return <SplitListPage list="/forsaljning/ordrar" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const orders = await apiGet<Paged<SalesOrder>>(
    `/api/v1/sales-orders${listApiQuery(withFinishedRule(SALES_ORDER_FILTER, searchParams), ["status"], pageSize)}&kind=order`,
    cookieHeader
  );

  return (
    <AppShell>
      <TableView list="/forsaljning/ordrar">
        <SalesOrdersPageClient orders={orders} pageSize={pageSize} kind="order" />
      </TableView>
    </AppShell>
  );
}
