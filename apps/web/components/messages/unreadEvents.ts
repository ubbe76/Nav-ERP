import { isEmbedded } from "../../lib/documentTabs";
import type { UnreadSummary } from "../../lib/messages";

// The envelope follows what the pages do without waiting for its next poll:
// a page that read, archived or sent announces it, with the new summary when
// it has one (null = "ask again"). A conversation open in a document tab
// lives in an iframe of the same origin — the envelope is in the frame
// around it, so the event is dispatched there.
const EVENT = "nav-messages-unread";

export function announceUnread(summary: UnreadSummary | null): void {
  const target = isEmbedded() ? window.parent : window;
  target.dispatchEvent(new CustomEvent(EVENT, { detail: summary }));
}

export function onUnreadAnnounced(listener: (summary: UnreadSummary | null) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<UnreadSummary | null>).detail ?? null);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
