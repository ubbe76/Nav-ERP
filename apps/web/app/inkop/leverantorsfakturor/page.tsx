import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SplitListPage } from "../../../components/split/SplitListPage";
import { TableView } from "../../../components/split/ListViewToggle";
import { listPageView } from "../../../lib/listViewServer";
import { SupplierInvoicesPageClient } from "../../../components/purchase/SupplierInvoicesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, SupplierInvoice } from "../../../lib/types";

export default async function SupplierInvoicesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/inkop/leverantorsfakturor", searchParams)) === "list") return <SplitListPage list="/inkop/leverantorsfakturor" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const invoices = await apiGet<Paged<SupplierInvoice>>(
    `/api/v1/supplier-invoices${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell>
      <TableView list="/inkop/leverantorsfakturor">
        <SupplierInvoicesPageClient invoices={invoices} pageSize={pageSize} />
      </TableView>
    </AppShell>
  );
}
