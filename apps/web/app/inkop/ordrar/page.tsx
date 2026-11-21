import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SplitListPage } from "../../../components/split/SplitListPage";
import { TableView } from "../../../components/split/ListViewToggle";
import { listPageView } from "../../../lib/listViewServer";
import { PurchaseOrdersPageClient } from "../../../components/purchase/PurchaseOrdersPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { withFinishedRule } from "../../../lib/listFilter";
import { PURCHASE_ORDER_FILTER } from "../../../lib/statusFilters";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, PurchaseOrder } from "../../../lib/types";

export default async function PurchaseOrdersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/inkop/ordrar", searchParams)) === "list") return <SplitListPage list="/inkop/ordrar" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const orders = await apiGet<Paged<PurchaseOrder>>(
    `/api/v1/purchase-orders${listApiQuery(withFinishedRule(PURCHASE_ORDER_FILTER, searchParams), ["status", "kind"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell>
      <TableView list="/inkop/ordrar">
        <PurchaseOrdersPageClient orders={orders} pageSize={pageSize} />
      </TableView>
    </AppShell>
  );
}
