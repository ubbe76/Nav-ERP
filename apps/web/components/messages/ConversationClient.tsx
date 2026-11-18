"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Link2, Trash2, X } from "lucide-react";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Field";
import { FormError } from "../ui/Form";
import { GatedLink } from "../ui/GatedLink";
import { useCanOpen } from "../PermissionsProvider";
import { ApiError, apiFetch } from "../../lib/api";
import { confirmDelete, confirmDialog } from "../../lib/confirm";
import { apiErrorMessage } from "../../lib/errorMessages";
import {
  MESSAGES_REFRESH_MS,
  DELETED_MESSAGE_TEXT,
  MESSAGE_BODY_MAX,
  eventText,
  messageTime,
  participantLabel,
  participantStatus,
  type ConversationDetail,
  type ConversationMessage,
  type ConversationParticipant,
  type UnreadSummary,
} from "../../lib/messages";
import { notify } from "../../lib/notice";
import { navigateTo } from "../../lib/tabNavigation";
import { useUnsavedGuard } from "../../lib/unsavedGuard";
import { AddParticipantsDialog } from "./AddParticipantsDialog";
import { announceUnread } from "./unreadEvents";
import styles from "./Messages.module.css";

// One conversation. Opening it marks it read (up to the newest message on
// screen — never one that arrives unseen), and it is read again once a
// minute while the tab is visible so a reply shows without a reload.
// Deltagare: anyone adds (Lägg till deltagare), the one who started the
// conversation removes (Ta bort), everyone else can leave (Lämna
// konversationen). Radera on one's own messages. Händelserader — who added,
// removed or left — stand muted in the thread.
export function ConversationClient({ initial, userId, today }: { initial: ConversationDetail; userId: string; today: string }) {
  const router = useRouter();
  const canOpen = useCanOpen();
  const [conversation, setConversation] = useState(initial);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Removed from the conversation (or it is gone) while it stood open.
  const [gone, setGone] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useUnsavedGuard(draft.trim() !== "");

  const id = conversation.id;
  const newestId = conversation.messages.at(-1)?.id ?? null;
  const creator = conversation.createdBy === userId;

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
      } catch (err) {
        // Keep what is shown — but say so when the reader is no longer in it.
        if (err instanceof ApiError && err.status === 404) setGone(true);
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

  async function removeParticipant(p: ConversationParticipant) {
    const ok = await confirmDialog(
      p.kind === "terminal"
        ? `Ta bort ${participantLabel(p)} ur konversationen? Den försvinner från stämpelterminalen direkt.`
        : `Ta bort ${participantLabel(p)} ur konversationen? Hen ser den inte längre.`,
      { confirmLabel: "Ta bort", danger: true }
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      setConversation(
        await apiFetch<ConversationDetail>(`/api/v1/conversations/${id}/participants/${p.participantId}`, { method: "DELETE" })
      );
    } catch (err) {
      setError(apiErrorMessage(err, "Deltagaren kunde inte tas bort"));
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    const ok = await confirmDialog("Lämna konversationen? Du ser den inte längre och får inga nya meddelanden i den.", {
      confirmLabel: "Lämna konversationen",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      announceUnread(await apiFetch<UnreadSummary>(`/api/v1/conversations/${id}/leave`, { method: "POST" }));
      setDraft("");
      notify({ message: "Du har lämnat konversationen.", tone: "success" });
      navigateTo("/meddelanden", "Meddelanden", (href) => router.push(href));
    } catch (err) {
      setError(apiErrorMessage(err, "Det gick inte att lämna konversationen"));
      setBusy(false);
    }
  }

  async function deleteMessage(m: ConversationMessage) {
    if (!(await confirmDelete("Radera meddelandet? Texten tas bort för alla i konversationen och går inte att få tillbaka."))) return;
    setBusy(true);
    setError(null);
    try {
      setConversation(await apiFetch<ConversationDetail>(`/api/v1/conversations/${id}/messages/${m.id}`, { method: "DELETE" }));
    } catch (err) {
      setError(apiErrorMessage(err, "Meddelandet kunde inte raderas"));
    } finally {
      setBusy(false);
    }
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
            const self = p.kind !== "employee" && p.id === userId;
            return (
              <li key={`${p.kind}:${p.id}`} className={styles.participant}>
                {participantLabel(p)}
                {self ? " (du)" : ""}
                {status && (
                  <span className={styles.participantStatus} data-tone={tone}>
                    {status}
                  </span>
                )}
                {creator && !self && !gone && (
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={`Ta bort ${participantLabel(p)}`}
                    title="Ta bort"
                    disabled={busy}
                    onClick={() => void removeParticipant(p)}
                  >
                    <X size={13} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {!gone && (
          <div className={styles.participantActions}>
            <Button variant="secondary" size="small" disabled={busy} onClick={() => setAdding(true)}>
              Lägg till deltagare
            </Button>
          </div>
        )}
      </div>
      <AddParticipantsDialog
        open={adding}
        onClose={() => setAdding(false)}
        conversation={conversation}
        onAdded={(updated) => {
          setConversation(updated);
          setAdding(false);
        }}
      />

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
        {conversation.messages.map((m) =>
          m.kind === "event" ? (
            <li key={m.id} className={styles.event}>
              {eventText(m, userId)} · <time dateTime={m.createdAt}>{messageTime(m.createdAt, today)}</time>
            </li>
          ) : (
            <li key={m.id} className={styles.message} data-own={m.senderId === userId} data-deleted={m.deleted}>
              <div className={styles.messageHead}>
                <span className={styles.messageSender}>{m.senderId === userId ? "Du" : m.senderName}</span>
                {m.viaTerminal && <span>via terminalen</span>}
                <time dateTime={m.createdAt}>{messageTime(m.createdAt, today)}</time>
                {m.senderId === userId && !m.deleted && !gone && (
                  <button
                    type="button"
                    className={styles.messageDelete}
                    aria-label="Radera meddelandet"
                    title="Radera"
                    disabled={busy}
                    onClick={() => void deleteMessage(m)}
                  >
                    <Trash2 size={14} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className={styles.messageBody}>{m.deleted ? DELETED_MESSAGE_TEXT : m.body}</div>
            </li>
          )
        )}
      </ol>
      <div ref={endRef} />

      {gone ? (
        <div className={styles.panel} role="status">
          Du är inte längre med i konversationen.
        </div>
      ) : (
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
      )}

      {!gone && (
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
          {!creator && (
            <Button variant="secondary" disabled={busy} onClick={() => void leave()}>
              Lämna konversationen
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
