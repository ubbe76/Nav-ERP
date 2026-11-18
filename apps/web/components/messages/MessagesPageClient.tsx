"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Paperclip } from "lucide-react";
import { Button } from "../ui/Button";
import { HelpLink } from "../ui/HelpLink";
import { ListToolbar, Pagination, useListNavigation } from "../ui/ListControls";
import { stockholmToday } from "../../lib/date";
import { MESSAGES_REFRESH_MS, messageTime, otherParticipants, type ConversationDetail, type ConversationListRow } from "../../lib/messages";
import { notify } from "../../lib/notice";
import { useNewFromQuery } from "../../lib/useNewFromQuery";
import type { Paged } from "../../lib/types";
import { NewMessageDialog } from "./NewMessageDialog";
import { announceUnread } from "./unreadEvents";
import shellStyles from "../AppShell.module.css";
import styles from "./Messages.module.css";

// Inkorgen: the user's conversations, newest message first — URL-driven
// (?search=&page=&archived=true). Unread rows in bold with their count.
export function MessagesPageClient({
  conversations,
  pageSize,
  userId,
  today: initialToday,
}: {
  conversations: Paged<ConversationListRow>;
  pageSize: number;
  userId: string;
  // The Stockholm day the server rendered with (the same text on both sides).
  today: string;
}) {
  const router = useRouter();
  const { params, setFilter } = useListNavigation();
  const archived = params.get("archived") === "true";
  const [creating, setCreating] = useState(false);
  useNewFromQuery(() => setCreating(true));

  // New messages show without a reload: the list is read again once a
  // minute while the tab is visible, like the envelope.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, MESSAGES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [router]);

  function created(conversation: ConversationDetail) {
    setCreating(false);
    announceUnread(null);
    router.refresh();
    notify({ message: `Meddelandet är skickat: ${conversation.subject}`, tone: "success" });
  }

  const today = initialToday || stockholmToday();
  return (
    <>
      <div className={shellStyles.topbar}>
        <div>
          <div className={shellStyles.title}>Meddelanden</div>
          <div className={shellStyles.meta}>Konversationer med andra användare, terminaler och anställda</div>
        </div>
        <div className={shellStyles.topbarActions}>
          <HelpLink chapter="komma-igang" anchor="meddelanden" label="Hjälp om meddelanden" />
          <Button variant="primary" onClick={() => setCreating(true)}>
            + Nytt meddelande
          </Button>
        </div>
      </div>

      <div className={styles.tabs} role="group" aria-label="Visa">
        <button type="button" className={styles.tab} aria-pressed={!archived} onClick={() => void setFilter("archived", null)}>
          Inkorgen
        </button>
        <button type="button" className={styles.tab} aria-pressed={archived} onClick={() => void setFilter("archived", "true")}>
          Arkiverade
        </button>
      </div>

      <ListToolbar placeholder="Sök ämne eller text…" />

      <div className={styles.inbox}>
        {conversations.rows.length === 0 ? (
          <div className={styles.empty}>
            {params.get("search")
              ? "Ingen konversation matchar sökningen."
              : archived
                ? "Inga arkiverade konversationer."
                : "Inga meddelanden än. Skriv till en kollega med + Nytt meddelande."}
          </div>
        ) : (
          conversations.rows.map((row) => {
            const unread = row.unreadCount > 0;
            const last = row.lastMessage;
            return (
              <Link key={row.id} href={`/meddelanden/${row.id}`} className={styles.inboxRow} data-unread={unread}>
                <span className={styles.inboxSubject}>
                  <span className={styles.inboxSubjectText}>{row.subject}</span>
                  {row.hasLink && <Paperclip size={13} strokeWidth={1.9} aria-label="Har en bifogad länk" />}
                  {unread && (
                    <span className={styles.unreadPill} aria-label={row.unreadCount === 1 ? "1 oläst" : `${row.unreadCount} olästa`}>
                      {row.unreadCount}
                    </span>
                  )}
                </span>
                <span className={styles.inboxTime}>{messageTime(row.lastMessageAt, today)}</span>
                <span className={styles.inboxWith}>{otherParticipants(row.participants, userId) || "Bara du"}</span>
                {last && (
                  <span className={styles.inboxPreview}>
                    {last.senderId === userId ? "Du" : last.senderName}: {last.preview}
                  </span>
                )}
              </Link>
            );
          })
        )}
      </div>

      <Pagination total={conversations.total} pageSize={pageSize} />

      <NewMessageDialog open={creating} onClose={() => setCreating(false)} onCreated={created} />
    </>
  );
}
