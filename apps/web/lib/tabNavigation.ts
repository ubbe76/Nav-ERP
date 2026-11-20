// Where an in-app navigation from code goes (Programramen, flikar per
// funktion): the palette (Ctrl+K) and other "open this" calls go through
// navigateTo, so a page of another function opens in that function's tab
// when the tabs are on — a page inside a tab asks the frame around it. A
// page of the tab's own function navigates inside the tab. Without a
// registered opener (narrow screen, tabs off) it is router.push.
import { appHref, isEmbedded, type TabMessage } from "./documentTabs";
import { functionOf } from "./navFunctions";

type Opener = (href: string, title: string, own: boolean) => boolean;

let opener: Opener | null = null;

export function registerTabOpener(next: Opener | null): void {
  opener = next;
}

export function postToFrame(message: TabMessage): void {
  window.parent.postMessage(message, window.location.origin);
}

function sameFunctionAsHere(href: string): boolean {
  return functionOf(href) === functionOf(window.location.pathname);
}

// true when the page went to another tab (here or in the frame around a
// tab) and this page stays — the caller then resets its own pending state.
export function navigateTo(href: string, title: string, push: (href: string) => void): boolean {
  const page = appHref(href, window.location.origin);
  if (page && isEmbedded()) {
    if (sameFunctionAsHere(page)) {
      push(href);
      return false;
    }
    postToFrame({ type: "nav-tab-open", href: page, title });
    return true;
  }
  if (page && opener && opener(page, title, false)) return true;
  push(href);
  return false;
}

// A document that an action on another document created — a credit
// invoice, the TO a row made, the IO an inquiry became — opens like a link
// to it, except that one of the same function gets a tab of its own, so the
// document the action was on stays open. Without tabs this page navigates
// there (router.push). Creating from a list or a Ny … form navigates in
// place as before.
export function openDocument(href: string, push: (href: string) => void, title = "Dokument"): boolean {
  const page = appHref(href, window.location.origin);
  if (!page) {
    push(href);
    return false;
  }
  const own = sameFunctionAsHere(page);
  if (isEmbedded()) {
    postToFrame({ type: "nav-tab-open", href: page, title, own });
    return true;
  }
  if (opener && opener(page, title, own)) return true;
  push(href);
  return false;
}
