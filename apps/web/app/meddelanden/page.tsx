import { headers } from "next/headers";
import { AppShell } from "../../components/AppShell";
import { MessagesPageClient } from "../../components/messages/MessagesPageClient";
import { apiGet, getCurrentUser } from "../../lib/api";
import { stockholmToday } from "../../lib/date";
import { listApiQuery, type PageSearchParams } from "../../lib/listQuery";
import { getListPageSize } from "../../lib/listPageSize";
import { canOpen } from "../../lib/pageAccess";
import type { ConversationListRow } from "../../lib/messages";
import type { Paged } from "../../lib/types";

// Meddelanden: the inbox. Reached from the envelope in the toolbar and from
// Ctrl+K — there is no sidebar entry, so the frame marks nothing special.
export default async function MessagesPage(props: { searchParams: Promise<PageSearchParams> }) {
  const searchParams = await props.searchParams;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/meddelanden")) {
    return (
      <AppShell>
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const pageSize = await getListPageSize();
  const conversations = await apiGet<Paged<ConversationListRow>>(
    `/api/v1/conversations${listApiQuery(searchParams, ["archived"], pageSize)}`,
    cookieHeader
  );

  return (
    <AppShell>
      <MessagesPageClient conversations={conversations} pageSize={pageSize} userId={user.id} today={stockholmToday()} />
    </AppShell>
  );
}
