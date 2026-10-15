import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SupplierInvoicesPageClient } from "../../../components/purchase/SupplierInvoicesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Paged, SupplierInvoice } from "../../../lib/types";

export default async function SupplierInvoicesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const invoices = await apiGet<Paged<SupplierInvoice>>(
    `/api/v1/supplier-invoices${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Inköp">
      <SupplierInvoicesPageClient invoices={invoices} pageSize={pageSize} />
    </AppShell>
  );
}
