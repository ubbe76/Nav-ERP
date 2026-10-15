import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { InquiriesPageClient } from "../../../components/purchase/InquiriesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Inquiry, Paged } from "../../../lib/types";

export default async function InquiriesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const inquiries = await apiGet<Paged<Inquiry>>(
    `/api/v1/inquiries${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Inköp">
      <InquiriesPageClient inquiries={inquiries} pageSize={pageSize} />
    </AppShell>
  );
}
