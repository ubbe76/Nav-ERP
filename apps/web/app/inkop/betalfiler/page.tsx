import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { PaymentBatchesPageClient } from "../../../components/banking/PaymentBatchesPageClient";
import { apiGet } from "../../../lib/api";
import { getListPageSize } from "../../../lib/listPageSize";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import type { Paged, PaymentBatchListRow } from "../../../lib/types";

export default async function PaymentBatchesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const batches = await apiGet<Paged<PaymentBatchListRow>>(`/api/v1/payment-batches${listApiQuery(searchParams, ["status"], pageSize)}`, cookieHeader);
  return (
    <AppShell active="Inköp">
      <PaymentBatchesPageClient batches={batches} pageSize={pageSize} />
    </AppShell>
  );
}
