"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { appHref, documentHref, isEmbedded, provisionalTitle, type TabMessage } from "../../lib/documentTabs";
import { functionOf } from "../../lib/navFunctions";
import { postToFrame } from "../../lib/tabNavigation";
import { confirmLeave } from "../../lib/unsavedGuard";
import shellStyles from "../AppShell.module.css";
import { readPageTitle } from "../../lib/pageTitle";

// The page's side of a tab (Programramen, flikar per funktion) — does
// nothing on an ordinary page. It tells the frame around where the tab is
// now and what it is called; a link to a page of the same function
// navigates inside the tab as usual, a link to another function goes to the
// frame (that function's tab), and Ctrl/⌘-click on a document asks for a tab
// of its own. Window capture runs before the unsaved-changes guard: a link
// that leaves for another tab leaves nothing here. The frame can also send
// the tab somewhere (nav-tab-go: a menu choice or a link to a document of
// this function from another tab).
export function EmbeddedBridge() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (!isEmbedded()) return;
    const timer = setTimeout(() => {
      const title = readPageTitle(shellStyles.title);
      const query = searchParams.toString();
      postToFrame({ type: "nav-tab-state", href: query ? `${pathname}?${query}` : pathname, title });
    }, 300);
    return () => clearTimeout(timer);
  }, [pathname, searchParams]);

  useEffect(() => {
    if (!isEmbedded()) return;
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const page = appHref(anchor.href, window.location.origin);
      if (!page) return;
      if (e.metaKey || e.ctrlKey) {
        // A document in a tab of its own; any other page as the browser does.
        const doc = documentHref(anchor.href, window.location.origin);
        if (!doc) return;
        e.preventDefault();
        e.stopPropagation();
        postToFrame({ type: "nav-tab-open", href: doc, title: provisionalTitle(anchor.textContent), own: true });
        return;
      }
      if (functionOf(page) === functionOf(window.location.pathname)) return;
      e.preventDefault();
      e.stopPropagation();
      postToFrame({ type: "nav-tab-open", href: page, title: provisionalTitle(anchor.textContent) });
    }
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!isEmbedded()) return;
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin || e.source !== window.parent) return;
      const message = e.data as TabMessage | null;
      if (!message || typeof message !== "object" || message.type !== "nav-tab-go") return;
      const page = appHref(message.href, window.location.origin);
      if (!page) return;
      void confirmLeave().then((ok) => {
        if (ok) router.push(page);
      });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [router]);

  return null;
}
