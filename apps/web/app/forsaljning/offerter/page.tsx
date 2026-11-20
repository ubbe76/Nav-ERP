import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SplitListPage } from "../../../components/split/SplitListPage";
import { TableView } from "../../../components/split/ListViewToggle";
import { listPageView } from "../../../lib/listViewServer";
import { SalesOrdersPageClient } from "../../../components/sales/SalesOrdersPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, SalesOrder } from "../../../lib/types";

export default async function QuotesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/forsaljning/offerter", searchParams)) === "list") return <SplitListPage list="/forsaljning/offerter" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const orders = await apiGet<Paged<SalesOrder>>(
    `/api/v1/sales-orders${listApiQuery(searchParams, ["status"], pageSize)}&kind=quote`,
    cookieHeader
  );

  return (
    <AppShell>
      <TableView list="/forsaljning/offerter">
        <SalesOrdersPageClient orders={orders} pageSize={pageSize} kind="quote" />
      </TableView>
    </AppShell>
  );
}
