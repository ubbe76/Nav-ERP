"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  appHref,
  closeTab as closeTabRule,
  documentHref,
  isEmbedded,
  moveTab,
  openTab as openTabRule,
  provisionalTitle,
  reassertEmbedded,
  restoreTabs,
  tabForDigit,
  tabMoved,
  TABS_MIN_WIDTH,
  type AppTab,
  type TabMessage,
} from "../../lib/documentTabs";
import { functionOf, functionTitle } from "../../lib/navFunctions";
import { registerTabOpener } from "../../lib/tabNavigation";
import { confirmDialog } from "../../lib/confirm";
import { notify } from "../../lib/notice";
import { UNSAVED_MESSAGE } from "../../lib/unsavedGuard";
import styles from "./DocumentTabs.module.css";

// Flikar per funktion (Programramen, 2026-11-20) — the rules are in
// lib/documentTabs.ts. Lives in the root layout so the tabs (live iframes)
// survive everything around them; the strip is drawn by AppShell
// (TabStrip), which also tells this provider that an app frame is on
// screen (no tabs on the login page or the terminal). While the tabs are on,
// every page is shown in a tab: the frame's own page content is not drawn
// (TabbedContent), and the address bar follows the shown tab.
interface OpenOptions {
  own?: boolean;
  mode?: "menu" | "link";
}

interface TabsValue {
  // On: the user's setting, a wide window, an app frame, and not itself
  // inside a tab.
  available: boolean;
  tabs: AppTab[];
  activeId: string | null;
  activate: (id: string) => void;
  // 1–9: tab n in the strip; nothing when there is no such tab.
  activateDigit: (digit: number) => void;
  // Dra en flik: the tab moved to toIndex.
  move: (id: string, toIndex: number) => void;
  close: (id: string) => void;
  // A page in its function's tab; false when the tabs are off (the caller
  // navigates as usual).
  open: (href: string, title: string, options?: OpenOptions) => boolean;
  setEnabled: (on: boolean) => void;
  registerShell: () => () => void;
}

const TabsContext = createContext<TabsValue>({
  available: false,
  tabs: [],
  activeId: null,
  activate: () => {},
  activateDigit: () => {},
  move: () => {},
  close: () => {},
  open: () => false,
  setEnabled: () => {},
  registerShell: () => () => {},
});

const STORAGE_KEY = "nav-erp-tabs";

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeSession(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Blocked storage: the tabs just don't survive a reload.
  }
}

declare global {
  interface Window {
    __navHasDrafts?: () => boolean;
  }
}

function hereHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function titleFor(href: string, fallback?: string | null): string {
  return fallback || functionTitle(functionOf(href)) || "Sidan";
}

export function DocumentTabsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [embedded, setEmbedded] = useState(false);
  const [wide, setWide] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [shells, setShells] = useState(0);
  const [tabs, setTabs] = useState<AppTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // The iframes are drawn once the tabs have been on: a narrow window never
  // loads the restored tabs.
  const [framesOn, setFramesOn] = useState(false);
  const restored = useRef(false);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  // An iframe's src is the address it was opened on — never changed after,
  // or the live page would reload when it reports its own navigation.
  // Moving a tab elsewhere is a message to its page (nav-tab-go).
  const sources = useRef(new Map<string, string>());
  // Tabs whose page has answered (its bridge listens); a go for one that has
  // not waits here until it does.
  const ready = useRef(new Set<string>());
  const pendingGo = useRef(new Map<string, string>());
  const nextId = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;

  const available = enabled && wide && shells > 0 && !embedded;

  // A root that React client-rendered (after a hydration error) lost the
  // boot script's data-embedded — put it back before the first paint.
  useLayoutEffect(() => {
    reassertEmbedded();
  }, []);

  useEffect(() => {
    // A page inside a tab is a whole Nav of its own, sharing the top page's
    // sessionStorage: it must never restore (and so nest) the tabs.
    if (isEmbedded()) {
      setEmbedded(true);
      return;
    }
    const query = window.matchMedia(`(min-width: ${TABS_MIN_WIDTH}px)`);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    const restoredTabs = restoreTabs(readSession(STORAGE_KEY), window.location.origin);
    // Above every restored id ("tab-N"): length alone could reuse one after
    // a tab in the middle was closed.
    nextId.current = restoredTabs.tabs.reduce((max, t) => {
      const n = Number(/(\d+)$/.exec(t.id)?.[1]);
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, restoredTabs.tabs.length);
    setTabs(restoredTabs.tabs);
    setActiveId(restoredTabs.activeId);
    restored.current = true;
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (restored.current) writeSession(STORAGE_KEY, JSON.stringify({ tabs, activeId }));
  }, [tabs, activeId]);

  const hasDrafts = useCallback((id: string) => {
    try {
      return frames.current.get(id)?.contentWindow?.__navHasDrafts?.() === true;
    } catch {
      return false;
    }
  }, []);

  // Sends a tab that already has a page somewhere else.
  const goTo = useCallback((id: string, href: string) => {
    if (!sources.current.has(id)) return; // not drawn yet: it opens on its href
    const frame = frames.current.get(id);
    if (frame?.contentWindow && ready.current.has(id)) {
      frame.contentWindow.postMessage({ type: "nav-tab-go", href } satisfies TabMessage, window.location.origin);
    } else {
      pendingGo.current.set(id, href);
    }
  }, []);

  const activate = useCallback((id: string) => {
    setActiveId(id);
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, lastUsed: Date.now() } : t)));
  }, []);

  const activateDigit = useCallback(
    (digit: number) => {
      if (!available) return;
      const id = tabForDigit(tabsRef.current, digit);
      if (id !== undefined) activate(id);
    },
    [available, activate]
  );

  const move = useCallback((id: string, toIndex: number) => {
    setTabs((list) => moveTab(list, id, toIndex));
  }, []);

  const openPage = useCallback(
    (href: string, title: string, options: OpenOptions = {}): boolean => {
      const page = appHref(href, window.location.origin);
      if (!page) return false;
      const result = openTabRule(tabsRef.current, page, {
        title: titleFor(page, title),
        own: options.own,
        mode: options.mode ?? "link",
        activeId: activeRef.current,
        now: Date.now(),
        newId: () => `tab-${++nextId.current}`,
        hasDrafts,
      });
      if (result.kind === "refused") {
        notify({ tone: "error", message: "Alla flikar har osparade ändringar — spara eller stäng en flik först." });
        return true;
      }
      for (const id of result.closed) {
        frames.current.delete(id);
        sources.current.delete(id);
        ready.current.delete(id);
        pendingGo.current.delete(id);
      }
      tabsRef.current = result.tabs;
      activeRef.current = result.activeId;
      setTabs(result.tabs);
      setActiveId(result.activeId);
      if (result.navigate) goTo(result.activeId, result.navigate);
      return true;
    },
    [hasDrafts, goTo]
  );

  const open = useCallback(
    (href: string, title: string, options?: OpenOptions) => (available ? openPage(href, title, options) : false),
    [available, openPage]
  );

  const close = useCallback(
    async (id: string) => {
      if (hasDrafts(id) && !(await confirmDialog(UNSAVED_MESSAGE, { confirmLabel: "Stäng fliken" }))) return;
      frames.current.delete(id);
      sources.current.delete(id);
      ready.current.delete(id);
      pendingGo.current.delete(id);
      const next = closeTabRule(tabsRef.current, id, activeRef.current);
      tabsRef.current = next.tabs;
      activeRef.current = next.activeId;
      setTabs(next.tabs);
      setActiveId(next.activeId);
      // The last tab closed: Översikt, so the frame is never empty.
      if (next.tabs.length === 0) openPage("/", "Översikt");
    },
    [hasDrafts, openPage]
  );

  const registerShell = useCallback(() => {
    setShells((n) => n + 1);
    return () => setShells((n) => n - 1);
  }, []);

  // The tabs come on: the page the frame was loaded on is shown in its
  // function's tab (a restored tab of that function goes there).
  const wasAvailable = useRef(false);
  useEffect(() => {
    if (available && !wasAvailable.current) {
      setFramesOn(true);
      openPage(hereHref(), "");
    } else if (!available && wasAvailable.current && !embedded) {
      // The tabs go off (a narrow window, the setting): the frame's own page
      // is drawn again, for the address the shown tab left in the bar.
      router.replace(hereHref());
    }
    wasAvailable.current = available;
  }, [available, embedded, openPage, router]);

  // The address bar and the window's name follow the shown tab, so a reload
  // or a bookmark gives the same page (history.replaceState is synced with
  // Next's router: usePathname follows, nothing is fetched).
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  useEffect(() => {
    if (!available || !activeTab) return;
    if (hereHref() !== activeTab.href) window.history.replaceState(null, "", activeTab.href);
    // Next writes the page's own <title> after hydration and on navigation;
    // the tab's name is put back whenever that happens.
    const wanted = activeTab.title ? `${activeTab.title} – nav | ERP` : "nav | ERP";
    const apply = () => {
      if (document.title !== wanted) document.title = wanted;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => observer.disconnect();
  }, [available, activeTab?.href, activeTab?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  // Links in the frame (the menu, the favourites, the toolbar's menus): a
  // page opens in its function's tab — a menu choice (data-nav-menu) shows
  // the tab as it is; Ctrl/⌘-click gives a document a tab of its own.
  // Window capture runs before Next's Link, which skips a prevented click.
  useEffect(() => {
    if (!available) return;
    registerTabOpener((href, title, own) => openPage(href, title, { own }));
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const page = appHref(anchor.href, window.location.origin);
      if (!page) return;
      const title = anchor.dataset.navTitle ?? provisionalTitle(anchor.textContent);
      if (e.metaKey || e.ctrlKey) {
        const doc = documentHref(anchor.href, window.location.origin);
        if (!doc) return;
        e.preventDefault();
        e.stopPropagation();
        openPage(doc, title, { own: true });
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      openPage(page, title, { mode: anchor.closest("[data-nav-menu]") ? "menu" : "link" });
    }
    window.addEventListener("click", onClick, true);
    return () => {
      registerTabOpener(null);
      window.removeEventListener("click", onClick, true);
    };
  }, [available, openPage]);

  // What the pages inside the tabs say: where they are now, a page to open
  // in another tab, a tab to show.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const message = e.data as TabMessage | null;
      if (!message || typeof message !== "object" || typeof message.type !== "string") return;
      const from = [...frames.current.entries()].find(([, frame]) => frame.contentWindow === e.source)?.[0];
      if (!from) return;
      if (message.type === "nav-tab-state") {
        ready.current.add(from);
        setTabs((list) => tabMoved(list, from, message.href, message.title));
        const pending = pendingGo.current.get(from);
        if (pending !== undefined) {
          pendingGo.current.delete(from);
          if (pending !== message.href) goTo(from, pending);
        }
      } else if (message.type === "nav-tab-open") {
        openPage(message.href, message.title, { own: message.own === true });
      } else if (message.type === "nav-tab-activate") {
        activateDigit(message.digit);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [openPage, activateDigit, goTo]);

  // The frame's state for the CSS (globals.css): the strip's row and the
  // shown tab (which hides the frame's own page).
  const showLayer = available && activeTab !== null;
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-tabs", available && tabs.length > 0);
    root.toggleAttribute("data-tab-active", showLayer);
    return () => {
      root.removeAttribute("data-tabs");
      root.removeAttribute("data-tab-active");
    };
  }, [available, tabs.length, showLayer]);

  useEffect(() => {
    if (!available) return;
    const sidebar = document.querySelector<HTMLElement>("[data-app-sidebar]");
    if (!sidebar) return;
    const observer = new ResizeObserver(() => {
      const visible = getComputedStyle(sidebar).display !== "none" && getComputedStyle(sidebar).position !== "fixed";
      document.documentElement.style.setProperty("--app-sidebar-width", `${visible ? sidebar.getBoundingClientRect().width : 0}px`);
    });
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [available, shells]);

  // The shown tab takes the keyboard — and a hidden one gives it back: focus
  // left in a hidden iframe would send every key (Ctrl+K, N, ↑/↓) to a page
  // nobody sees.
  useEffect(() => {
    if (showLayer && activeId) {
      frames.current.get(activeId)?.contentWindow?.focus();
      return;
    }
    if (document.activeElement instanceof HTMLIFrameElement) {
      document.activeElement.blur();
      window.focus();
    }
  }, [showLayer, activeId]);

  const value = useMemo(
    () => ({ available, tabs, activeId, activate, activateDigit, move, close, open, setEnabled, registerShell }),
    [available, tabs, activeId, activate, activateDigit, move, close, open, registerShell]
  );

  return (
    <TabsContext.Provider value={value}>
      {children}
      {/* Kept while the tabs are off or narrow, hidden: the pages stay alive. */}
      {framesOn && tabs.length > 0 && !embedded && (
        <div className={styles.layer} data-shown={showLayer || undefined} aria-hidden={!showLayer}>
          {tabs.map((tab) => {
            if (!sources.current.has(tab.id)) sources.current.set(tab.id, tab.href);
            return (
              <iframe
                key={tab.id}
                ref={(node) => {
                  if (node) frames.current.set(tab.id, node);
                }}
                className={styles.frame}
                src={sources.current.get(tab.id)}
                title={tab.title}
                data-active={tab.id === activeId || undefined}
              />
            );
          })}
        </div>
      )}
    </TabsContext.Provider>
  );
}

export function useDocumentTabs(): TabsValue {
  return useContext(TabsContext);
}

// The frame's own page while the tabs are on: not drawn — every page is
// shown in its tab (the same page, loaded in the tab's frame). The first
// render matches the server's; the CSS hides it until then (globals.css,
// data-tabs-pref).
export function TabbedContent({ children }: { children: ReactNode }) {
  const { available } = useDocumentTabs();
  return available ? null : <div data-tabbed-content="">{children}</div>;
}
