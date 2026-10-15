import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { CustomersPageClient } from "../../components/sales/CustomersPageClient";
import { apiGet } from "../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../lib/listQuery";
import { getListPageSize } from "../../lib/listPageSize";
import type { Customer, Paged } from "../../lib/types";

export default async function CustomersPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const customers = await apiGet<Paged<Customer>>(
    `/api/v1/customers${listApiQuery(searchParams, [], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Försäljning">
      <CustomersPageClient customers={customers} pageSize={pageSize} />
    </AppShell>
  );
}
