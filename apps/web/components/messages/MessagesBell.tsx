"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { isEmbedded } from "../../lib/documentTabs";
import { MESSAGES_REFRESH_MS, pageLinkOffer, unreadIncreased, type ConversationDetail, type ConversationLink, type UnreadSummary } from "../../lib/messages";
import { notify } from "../../lib/notice";
import { navigateTo } from "../../lib/tabNavigation";
import { useCanOpen } from "../PermissionsProvider";
import { NewMessageDialog } from "./NewMessageDialog";
import { announceUnread, onUnreadAnnounced } from "./unreadEvents";
import shellStyles from "../AppShell.module.css";
import styles from "./Messages.module.css";

// Meddelanden in the toolbar, beside the bell: the number of unread messages,
// read after the page has rendered and once a minute while the tab is
// visible (a failed read keeps the last number). When the number has grown
// since the last reading a notice says who wrote, with Öppna. The envelope
// opens a small menu — Inkorgen and + Nytt meddelande, which can attach a
// link to the page the user stands on. Hidden for a user who may not open
// Meddelanden.
export function MessagesBell() {
  const canOpen = useCanOpen();
  const allowed = canOpen("/meddelanden");
  const router = useRouter();
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState<{ link: ConversationLink; document: boolean } | null | false>(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // What the last reading said, and the newest message a notice was shown for.
  const previous = useRef<number | null>(null);
  const notified = useRef<string | null>(null);
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    // Inside a document tab (punkt 5) the envelope is hidden: no polling there.
    if (!allowed || isEmbedded()) return;
    let cancelled = false;

    function apply(summary: UnreadSummary, announce: boolean) {
      const grew = unreadIncreased(previous.current, summary.count);
      previous.current = summary.count;
      setCount(summary.count);
      const latest = summary.latest;
      if (!announce || !grew || !latest || notified.current === latest.messageId) return;
      notified.current = latest.messageId;
      // Not while that very conversation is on screen — it shows the message itself.
      if (window.location.pathname === `/meddelanden/${latest.conversationId}`) return;
      notify({
        message: `Nytt meddelande från ${latest.senderName}: ${latest.subject}`,
        tone: "info",
        action: {
          label: "Öppna",
          run: async () => {
            navigateTo(`/meddelanden/${latest.conversationId}`, latest.subject, (href) => routerRef.current.push(href));
            return null;
          },
        },
      });
    }

    async function load() {
      if (document.visibilityState === "hidden") return;
      try {
        const summary = await apiFetch<UnreadSummary>("/api/v1/messages/unread");
        if (!cancelled) apply(summary, true);
      } catch {
        // Keep the last number; the status bar says when the server is gone.
      }
    }

    void load();
    const timer = window.setInterval(load, MESSAGES_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    // A page read, archived or sent: follow at once, without a notice.
    const stop = onUnreadAnnounced((summary) => {
      if (summary) apply(summary, false);
      else void load();
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      stop();
    };
  }, [allowed]);

  // Navigating closes the menu.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!allowed) return null;

  function compose() {
    setOpen(false);
    // The page as it is now: its address with filters, under its own title.
    const title = document.querySelector(`.${shellStyles.title}`)?.textContent ?? "";
    setComposing(pageLinkOffer(window.location.pathname, window.location.search, title));
  }

  function created(conversation: ConversationDetail) {
    setComposing(false);
    announceUnread(null);
    // The inbox shows the new conversation at once.
    if (window.location.pathname === "/meddelanden") router.refresh();
    notify({
      message: "Meddelandet är skickat.",
      tone: "success",
      action: {
        label: "Öppna",
        run: async () => {
          navigateTo(`/meddelanden/${conversation.id}`, conversation.subject, (href) => routerRef.current.push(href));
          return null;
        },
      },
    });
  }

  const label = count > 0 ? `Meddelanden, ${count} ${count === 1 ? "oläst" : "olästa"}` : "Meddelanden";
  return (
    <div className={styles.bellWrap} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.bell}
        aria-label={label}
        title={label}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Mail size={19} strokeWidth={1.8} aria-hidden="true" />
        {count > 0 && <span className={styles.badge}>{count > 99 ? "99+" : count}</span>}
      </button>
      {open && (
        <div className={styles.bellPanel}>
          <Link href="/meddelanden" className={styles.bellItem} onClick={() => setOpen(false)}>
            Inkorgen
            {count > 0 && <span className={styles.bellCount}>{count === 1 ? "1 oläst" : `${count} olästa`}</span>}
          </Link>
          <button type="button" className={styles.bellItem} onClick={compose}>
            + Nytt meddelande
          </button>
        </div>
      )}
      <NewMessageDialog open={composing !== false} onClose={() => setComposing(false)} onCreated={created} pageLink={composing || null} />
    </div>
  );
}
