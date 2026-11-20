import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { SplitListPage } from "../../components/split/SplitListPage";
import { TableView } from "../../components/split/ListViewToggle";
import { listPageView } from "../../lib/listViewServer";
import { CustomersPageClient } from "../../components/sales/CustomersPageClient";
import { apiGet } from "../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../lib/listQuery";
import { getListPageSize } from "../../lib/listPageSize";
import type { Customer, Paged } from "../../lib/types";

export default async function CustomersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/kunder", searchParams)) === "list") return <SplitListPage list="/kunder" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const customers = await apiGet<Paged<Customer>>(
    `/api/v1/customers${listApiQuery(searchParams, [], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell>
      <TableView list="/kunder">
        <CustomersPageClient customers={customers} pageSize={pageSize} />
      </TableView>
    </AppShell>
  );
}
