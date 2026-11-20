import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SplitListPage } from "../../../components/split/SplitListPage";
import { TableView } from "../../../components/split/ListViewToggle";
import { listPageView } from "../../../lib/listViewServer";
import { ManufacturingOrdersPageClient } from "../../../components/manufacturing/ManufacturingOrdersPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { ManufacturingOrder, Paged } from "../../../lib/types";

export default async function ManufacturingOrdersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/tillverkning/ordrar", searchParams)) === "list") return <SplitListPage list="/tillverkning/ordrar" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const orders = await apiGet<Paged<ManufacturingOrder>>(
    `/api/v1/manufacturing-orders${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell>
      <TableView list="/tillverkning/ordrar">
        <ManufacturingOrdersPageClient orders={orders} pageSize={pageSize} />
      </TableView>
    </AppShell>
  );
}
