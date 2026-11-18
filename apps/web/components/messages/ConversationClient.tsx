"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Link2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Field";
import { FormError } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { useCanOpen } from "../PermissionsProvider";
import { apiFetch } from "../../lib/api";
import { confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  MESSAGES_REFRESH_MS,
  MESSAGE_BODY_MAX,
  messageTime,
  participantLabel,
  participantStatus,
  type ConversationDetail,
  type UnreadSummary,
} from "../../lib/messages";
import { notify } from "../../lib/notice";
import { navigateTo } from "../../lib/tabNavigation";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import { announceUnread } from "./unreadEvents";
import styles from "./Messages.module.css";

// One conversation. Opening it marks it read (up to the newest message on
// screen — never one that arrives unseen), and it is read again once a
// minute while the tab is visible so a reply shows without a reload.
export function ConversationClient({ initial, userId, today }: { initial: ConversationDetail; userId: string; today: string }) {
  const router = useRouter();
  const canOpen = useCanOpen();
  const [conversation, setConversation] = useState(initial);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useUnsavedGuard(draft.trim() !== "");

  const id = conversation.id;
  const newestId = conversation.messages.at(-1)?.id ?? null;

  // Read up to the newest message shown; the envelope follows at once.
  useEffect(() => {
    if (!newestId) return;
    let cancelled = false;
    apiFetch<UnreadSummary>(`/api/v1/conversations/${id}/read`, { method: "POST", body: JSON.stringify({ messageId: newestId }) })
      .then((summary) => {
        if (!cancelled) announceUnread(summary);
      })
      .catch(() => {
        // The badge stays; the next opening tries again.
      });
    return () => {
      cancelled = true;
    };
  }, [id, newestId]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const fresh = await apiFetch<ConversationDetail>(`/api/v1/conversations/${id}`);
        // Never replace the thread with an older reading than the one shown.
        setConversation((current) => (fresh.messages.length >= current.messages.length ? fresh : current));
      } catch {
        // Keep what is shown.
      }
    }, MESSAGES_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [id]);

  // A new message scrolls into view (not on the first render of a long thread's top).
  const shownCount = useRef(conversation.messages.length);
  useEffect(() => {
    if (conversation.messages.length > shownCount.current) endRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    shownCount.current = conversation.messages.length;
  }, [conversation.messages.length]);

  async function send() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setError(null);
    try {
      const updated = await apiFetch<ConversationDetail>(`/api/v1/conversations/${id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      setConversation(updated);
      setDraft("");
    } catch (err) {
      setError(apiErrorMessage(err, "Meddelandet kunde inte skickas"));
    } finally {
      setSending(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  }

  async function act(path: "archive" | "unarchive" | "remove-from-board", fallback: string): Promise<ConversationDetail | null> {
    setBusy(true);
    setError(null);
    try {
      const updated = await apiFetch<ConversationDetail>(`/api/v1/conversations/${id}/${path}`, { method: "POST" });
      setConversation(updated);
      return updated;
    } catch (err) {
      setError(apiErrorMessage(err, fallback));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!(await act("archive", "Konversationen kunde inte arkiveras"))) return;
    announceUnread(null);
    notify({
      message: "Konversationen är arkiverad.",
      tone: "success",
      action: {
        label: "Ångra",
        run: async () => {
          const restored = await apiFetch<ConversationDetail>(`/api/v1/conversations/${id}/unarchive`, { method: "POST" });
          setConversation(restored);
          router.refresh();
          return "Konversationen ligger i inkorgen igen.";
        },
      },
    });
    navigateTo("/meddelanden", "Meddelanden", (href) => router.push(href));
  }

  async function removeFromBoard() {
    const ok = await confirmDialog("Ta bort meddelandet från terminalen? Det slutar visas på stämpelterminalen direkt.", {
      confirmLabel: "Ta bort från terminalen",
      danger: true,
    });
    if (ok) await act("remove-from-board", "Meddelandet kunde inte tas bort från terminalen");
  }

  const onBoard = conversation.participants.some((p) => p.kind === "terminal" && p.onBoard);

  return (
    <div className={styles.conversation}>
      <div className={styles.panel}>
        <div className={styles.panelLabel}>Deltagare</div>
        <ul className={styles.participants}>
          {conversation.participants.map((p) => {
            const status = participantStatus(p, today);
            const tone = p.kind === "employee" ? (p.read ? "done" : "waiting") : undefined;
            return (
              <li key={`${p.kind}:${p.id}`} className={styles.participant}>
                {participantLabel(p)}
                {p.kind !== "employee" && p.id === userId ? " (du)" : ""}
                {status && (
                  <span className={styles.participantStatus} data-tone={tone}>
                    {status}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {conversation.link && (
        <div className={styles.panel}>
          <div className={styles.panelLabel}>Bifogad länk</div>
          <div className={styles.linkBox}>
            <Link2 size={15} strokeWidth={1.9} aria-hidden="true" />
            <GatedLink href={conversation.link.href}>{conversation.link.title}</GatedLink>
          </div>
          {!canOpen(conversation.link.href) && <div className={styles.hint}>Du saknar behörighet till den sidan.</div>}
        </div>
      )}

      <ol className={styles.thread} aria-label="Meddelanden">
        {conversation.messages.map((m) => (
          <li key={m.id} className={styles.message} data-own={m.senderId === userId}>
            <div className={styles.messageHead}>
              <span className={styles.messageSender}>{m.senderId === userId ? "Du" : m.senderName}</span>
              <time dateTime={m.createdAt}>{messageTime(m.createdAt, today)}</time>
            </div>
            <div className={styles.messageBody}>{m.body}</div>
          </li>
        ))}
      </ol>
      <div ref={endRef} />

        <form className={`${styles.panel} ${styles.reply}`} onSubmit={onSubmit}>
          <Textarea
            aria-label="Svara"
            placeholder="Skriv ett svar…"
            rows={4}
            value={draft}
            maxLength={MESSAGE_BODY_MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <FormError>{error}</FormError>
          <div className={styles.replyActions}>
            <Button type="submit" variant="primary" disabled={sending || draft.trim() === ""}>
              {sending ? "Skickar…" : "Skicka"}
            </Button>
            <span className={styles.hint}>Ctrl/⌘+Enter skickar</span>
          </div>
        </form>

      <div className={styles.replyActions}>
        {conversation.archived ? (
          <Button variant="secondary" disabled={busy} onClick={() => void act("unarchive", "Konversationen kunde inte återställas")}>
            Återställ
          </Button>
        ) : (
          <Button variant="secondary" disabled={busy} onClick={() => void archive()}>
            Arkivera
          </Button>
        )}
        {conversation.canRemoveFromBoard && onBoard && (
          <Button variant="secondary" disabled={busy} onClick={() => void removeFromBoard()}>
            Ta bort från terminalen
          </Button>
        )}
      </div>
    </div>
  );
}
