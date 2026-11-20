import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { SplitListPage } from "../../components/split/SplitListPage";
import { TableView } from "../../components/split/ListViewToggle";
import { listPageView } from "../../lib/listViewServer";
import { SuppliersPageClient } from "../../components/purchase/SuppliersPageClient";
import { apiGet } from "../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../lib/listQuery";
import { getListPageSize } from "../../lib/listPageSize";
import type { Paged, Supplier } from "../../lib/types";

export default async function SuppliersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/leverantorer", searchParams)) === "list") return <SplitListPage list="/leverantorer" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const suppliers = await apiGet<Paged<Supplier>>(
    `/api/v1/suppliers${listApiQuery(searchParams, [], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell>
      <TableView list="/leverantorer">
        <SuppliersPageClient suppliers={suppliers} pageSize={pageSize} />
      </TableView>
    </AppShell>
  );
}
