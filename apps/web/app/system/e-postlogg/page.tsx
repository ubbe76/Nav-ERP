import { headers } from "next/headers";
import { AppShell } from "../../../components/AppShell";
import { EmailLogPageClient } from "../../../components/system/EmailLogPageClient";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { listApiQuery, type PageSearchParams } from "../../../lib/listQuery";
import { getListPageSize } from "../../../lib/listPageSize";
import type { EmailLogEntry, Paged } from "../../../lib/types";

export default async function EmailLogPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  // GET /email-log is readable by every logged-in user (the document cards
  // show their own history), but the admin page gate matches the rest of System.
  if (!user || user.role !== "admin") {
    return (
      <AppShell active="System">
        <p>Endast administratörer har åtkomst till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  const log = await apiGet<Paged<EmailLogEntry>>(
    `/api/v1/email-log${listApiQuery(searchParams, ["status", "documentType"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell active="System">
      <EmailLogPageClient log={log} pageSize={pageSize} />
    </AppShell>
  );
}
