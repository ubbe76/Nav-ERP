import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { KontoplanPageClient } from "../../../components/economy/KontoplanPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { Account, Paged } from "../../../lib/types";
import { canOpen } from "../../../lib/pageAccess";

// Every /accounts route is admin-gated in the API too (economy.routes.ts) —
// this page-level check just keeps a non-admin from seeing an empty/erroring
// list, same idiom as /system/anvandare.
export default async function KontoplanPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/ekonomi/kontoplan")) {
    return (
      <AppShell active="Ekonomi">
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  const accounts = await apiGet<Paged<Account>>(
    `/api/v1/accounts${listApiQuery(searchParams, ["includeInactive"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="Ekonomi">
      <KontoplanPageClient accounts={accounts} pageSize={pageSize} />
    </AppShell>
  );
}
