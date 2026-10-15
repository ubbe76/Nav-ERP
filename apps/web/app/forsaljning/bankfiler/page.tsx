import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { BankFilesPageClient } from "../../../components/banking/BankFilesPageClient";
import { apiGet } from "../../../lib/api";
import { getListPageSize } from "../../../lib/listPageSize";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import type { BankFileListRow, Paged } from "../../../lib/types";

export default async function SalesBankFilesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const pageSize = await getListPageSize();
  const query = listApiQuery(searchParams, [], pageSize);
  const files = await apiGet<Paged<BankFileListRow>>(`/api/v1/bank-files${query}${query ? "&" : "?"}direction=credit`, cookieHeader);
  return (
    <AppShell active="Försäljning">
      <BankFilesPageClient direction="credit" files={files} pageSize={pageSize} />
    </AppShell>
  );
}
