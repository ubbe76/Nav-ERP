import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { SplitListPage } from "../../../components/split/SplitListPage";
import { TableView } from "../../../components/split/ListViewToggle";
import { listPageView } from "../../../lib/listViewServer";
import { InquiriesPageClient } from "../../../components/purchase/InquiriesPageClient";
import { apiGet } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Inquiry, Paged } from "../../../lib/types";

export default async function InquiriesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  // Lista och kort: without a filter or a shortcut in the address, the narrow
  // list beside an empty card (unless the user chose Visa som tabell).
  if ((await listPageView("/inkop/forfragningar", searchParams)) === "list") return <SplitListPage list="/inkop/forfragningar" />;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const inquiries = await apiGet<Paged<Inquiry>>(
    `/api/v1/inquiries${listApiQuery(searchParams, ["status"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell>
      <TableView list="/inkop/forfragningar">
        <InquiriesPageClient inquiries={inquiries} pageSize={pageSize} />
      </TableView>
    </AppShell>
  );
}
