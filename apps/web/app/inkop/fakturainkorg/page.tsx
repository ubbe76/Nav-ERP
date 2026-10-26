import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { InvoiceInboxPageClient } from "../../../components/purchase/InvoiceInboxPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { InvoiceScanListRow } from "../../../lib/invoiceScan";
import type { Paged } from "../../../lib/types";

export default async function InvoiceInboxPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const scans = await apiGet<Paged<InvoiceScanListRow>>(
    `/api/v1/invoice-scans${listApiQuery(searchParams, ["status", "source"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Inköp">
      <InvoiceInboxPageClient scans={scans} pageSize={pageSize} />
    </AppShell>
  );
}
