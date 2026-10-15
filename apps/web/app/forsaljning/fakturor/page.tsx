import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { InvoicesPageClient } from "../../../components/sales/InvoicesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Invoice, Paged } from "../../../lib/types";

export default async function InvoicesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const invoices = await apiGet<Paged<Invoice>>(
    `/api/v1/invoices${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );
  // Prefills the create dialog when linked from a sales order's "Fakturera"
  // action (Task 9) — not a list filter, so it's kept out of listApiQuery.
  const orderId = typeof searchParams.orderId === "string" ? searchParams.orderId : undefined;

  return (
    <AppShell active="Försäljning">
      <InvoicesPageClient invoices={invoices} initialOrderId={orderId} pageSize={pageSize} />
    </AppShell>
  );
}
