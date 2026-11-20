import { headers } from "next/headers";
import Link from "next/link";
import { AppShell } from "../../../components/AppShell";
import { ConversationClient } from "../../../components/messages/ConversationClient";
import buttonStyles from "../../../components/ui/Button.module.css";
import { HelpLink } from "../../../components/ui/HelpLink";
import { apiGet, getCurrentUser } from "../../../lib/api";
import { stockholmToday } from "../../../lib/date";
import { canOpen } from "../../../lib/pageAccess";
import type { ConversationDetail } from "../../../lib/messages";
import shellStyles from "../../../components/AppShell.module.css";

// One conversation: the thread oldest first, the reply box, Arkivera. The API
// answers 404 both for a conversation that does not exist and for one the
// user is not part of — the page says the same for both.
export default async function ConversationPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const cookieHeader = (await headers()).get("cookie") ?? undefined;
  const user = await getCurrentUser(cookieHeader);

  if (!user || !canOpen(user, "/meddelanden")) {
    return (
      <AppShell>
        <p>Du saknar behörighet till den här sidan.</p>
      </AppShell>
    );
  }

  const conversation = await apiGet<ConversationDetail>(`/api/v1/conversations/${id}`, cookieHeader).catch(() => null);

  return (
    <AppShell>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>{conversation ? conversation.subject : "Meddelanden"}</div>
          <div className={shellStyles.meta}>Meddelanden</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <HelpLink chapter="komma-igang" anchor="meddelanden" label="Hjälp om meddelanden" />
          <Link href="/meddelanden" className={`${buttonStyles.button} ${buttonStyles.secondary}`}>
            Till inkorgen
          </Link>
        </div>
      </div>
      {conversation ? (
        <ConversationClient initial={conversation} userId={user.id} today={stockholmToday()} />
      ) : (
        <p>Konversationen finns inte, eller så är du inte med i den.</p>
      )}
    </AppShell>
  );
}
