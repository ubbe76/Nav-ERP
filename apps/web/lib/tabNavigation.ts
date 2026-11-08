// Where an in-app navigation from code goes (Nav som program, punkt 5): the
// palette (Ctrl+K) and other "open this" calls go through navigateTo, so a
// document opens as a tab when the tabs are on, and a page inside a tab asks
// the frame around it instead of navigating its own iframe. Without a
// registered opener (narrow screen, tabs off) it is router.push.
import { documentHref, isEmbedded, type TabMessage } from "./documentTabs";

type Opener = (href: string, title: string) => boolean;

let opener: Opener | null = null;

export function registerTabOpener(next: Opener | null): void {
  opener = next;
}

export function postToFrame(message: TabMessage): void {
  window.parent.postMessage(message, window.location.origin);
}

export function navigateTo(href: string, title: string, push: (href: string) => void): void {
  if (isEmbedded()) {
    const doc = documentHref(href, window.location.origin);
    postToFrame(doc ? { type: "nav-tab-open", href: doc, title } : { type: "nav-tab-navigate", href });
    return;
  }
  if (opener && documentHref(href, window.location.origin) && opener(href, title)) return;
  push(href);
}
