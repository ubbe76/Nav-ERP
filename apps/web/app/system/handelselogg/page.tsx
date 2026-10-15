import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { AuditLogPageClient } from "../../../components/system/AuditLogPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { AuditLogEntry, Paged } from "../../../lib/types";

export default async function AuditLogPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  // Admin-only, same gate as the rest of System (e.g. /system/anvandare,
  // /system/e-postlogg) — mirrored here since the page itself renders before
  // the API's own requireRole("admin") ever runs.
  if (!user || user.role !== "admin") {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  const log = await apiGet<Paged<AuditLogEntry>>(
    `/api/v1/audit-log${listApiQuery(searchParams, ["entityType", "userId", "from", "to"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="System">
      <AuditLogPageClient log={log} pageSize={pageSize} />
    </AppShell>
  );
}
