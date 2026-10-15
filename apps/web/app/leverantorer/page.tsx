import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { SuppliersPageClient } from "../../components/purchase/SuppliersPageClient";
import { apiGet } from "../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../lib/listQuery";
import { getListPageSize } from "../../lib/listPageSize";
import type { Paged, Supplier } from "../../lib/types";

export default async function SuppliersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const suppliers = await apiGet<Paged<Supplier>>(
    `/api/v1/suppliers${listApiQuery(searchParams, [], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Inköp">
      <SuppliersPageClient suppliers={suppliers} pageSize={pageSize} />
    </AppShell>
  );
}
