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

// true when the document went to a tab (here or in the frame around a tab)
// and this page stays — the caller then resets its own pending state.
export function navigateTo(href: string, title: string, push: (href: string) => void): boolean {
  if (isEmbedded()) {
    const doc = documentHref(href, window.location.origin);
    postToFrame(doc ? { type: "nav-tab-open", href: doc, title } : { type: "nav-tab-navigate", href });
    return doc !== null;
  }
  if (opener && documentHref(href, window.location.origin) && opener(href, title)) return true;
  push(href);
  return false;
}

// A document that an action on another document created — a credit
// invoice, the TO a row made, the IO an inquiry became — opens like a link
// to it: a tab of its own where the tabs are on, so the document the action
// was on stays open; otherwise this page navigates there (router.push).
// Creating from a list or a Ny … form navigates in place as before.
export function openDocument(href: string, push: (href: string) => void, title = "Dokument"): boolean {
  return navigateTo(href, title, push);
}
