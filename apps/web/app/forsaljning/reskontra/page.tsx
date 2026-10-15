import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { OpenInvoicesPageClient } from "../../../components/sales/OpenInvoicesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Customer, OpenInvoiceRow, Paged } from "../../../lib/types";

export default async function OpenInvoicesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const [openInvoices, customers] = await Promise.all([
    apiGet<Paged<OpenInvoiceRow>>(
      `/api/v1/open-invoices${listApiQuery(searchParams, ["customerId", "overdueOnly"], pageSize)}`,
      cookieHeader
    ),
    // Form dropdown data — fetched in full until a searchable picker exists.
    apiGet<Paged<Customer>>("/api/v1/customers?limit=1000", cookieHeader),
  ]);

  return (
    <AppShell active="Försäljning">
      <OpenInvoicesPageClient openInvoices={openInvoices} customers={customers.rows} pageSize={pageSize} />
    </AppShell>
  );
}
