"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { documentHref, isEmbedded, provisionalTitle, sameDocument } from "../../lib/documentTabs";
import { postToFrame } from "../../lib/tabNavigation";
import shellStyles from "../AppShell.module.css";

// The page's side of a document tab (Nav som program, punkt 5) — does
// nothing on an ordinary page. It tells the frame around where the tab is
// now and what it is called, opens another document's link as a tab of its
// own, and sends any other page (a list, a hub) to the frame instead of
// opening it inside the tab. Window capture runs before the unsaved-changes
// guard: neither leaves this page.
export function EmbeddedBridge() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!isEmbedded()) return;
    const timer = setTimeout(() => {
      const title = document.querySelector(`.${shellStyles.title}`)?.textContent?.trim() ?? "";
      const query = searchParams.toString();
      postToFrame({ type: "nav-tab-state", href: query ? `${pathname}?${query}` : pathname, title });
    }, 300);
    return () => clearTimeout(timer);
  }, [pathname, searchParams]);

  useEffect(() => {
    if (!isEmbedded()) return;
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
      const here = `${window.location.pathname}${window.location.search}`;
      const doc = documentHref(anchor.href, window.location.origin);
      // Within this document (an anchor, another flik of the card): stays.
      if (doc ? sameDocument(doc, here) : url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      postToFrame(
        doc
          ? { type: "nav-tab-open", href: doc, title: provisionalTitle(anchor.textContent) }
          : { type: "nav-tab-navigate", href: `${url.pathname}${url.search}${url.hash}` }
      );
    }
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  return null;
}
