"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  closeTab as closeTabRule,
  moveTab,
  tabForDigit,
  documentHref,
  isEmbedded,
  openTab as openTabRule,
  provisionalTitle,
  restoreTabs,
  sameDocument,
  TABS_MIN_WIDTH,
  type DocumentTab,
  type TabMessage,
} from "../../lib/documentTabs";
import { registerTabOpener } from "../../lib/tabNavigation";
import { confirmDialog } from "../../lib/confirm";
import { notify } from "../../lib/notice";
import { UNSAVED_MESSAGE } from "../../lib/unsavedGuard";
import shellStyles from "../AppShell.module.css";
import styles from "./DocumentTabs.module.css";

// Flikar och delad vy (Nav som program, punkt 5) — the rules are in
// lib/documentTabs.ts. Lives in the root layout so the tabs (live iframes)
// survive every navigation of the page around them; the strip itself is
// drawn by the toolbar (TabStrip), which also tells this provider that an
// app frame is on screen (no tabs on the login page or the terminal).
interface TabsValue {
  // On: the user's setting, a wide window, an app frame, and not itself
  // inside a tab.
  available: boolean;
  tabs: DocumentTab[];
  // The document shown; null = the page.
  activeId: string | null;
  split: boolean;
  pageTitle: string;
  activate: (id: string | null) => void;
  // 1–9: 1 = the page, 2.. the documents; nothing when there is no such tab.
  activateDigit: (digit: number) => void;
  // Dra en flik: the document tab moved to toIndex among the documents.
  move: (id: string, toIndex: number) => void;
  close: (id: string) => void;
  setSplit: (on: boolean) => void;
  setEnabled: (on: boolean) => void;
  registerShell: () => () => void;
}

const TabsContext = createContext<TabsValue>({
  available: false,
  tabs: [],
  activeId: null,
  split: false,
  pageTitle: "",
  activate: () => {},
  activateDigit: () => {},
  move: () => {},
  close: () => {},
  setSplit: () => {},
  setEnabled: () => {},
  registerShell: () => () => {},
});

const STORAGE_KEY = "nav-erp-tabs";
const SPLIT_KEY = "nav-erp-split";

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

export function DocumentTabsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [embedded, setEmbedded] = useState(false);
  const [wide, setWide] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [shells, setShells] = useState(0);
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [split, setSplitState] = useState(false);
  const [pageTitle, setPageTitle] = useState("");
  const restored = useRef(false);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  // An iframe's src is the address it was opened on — never changed after,
  // or the live page would reload when it reports its own navigation.
  const sources = useRef(new Map<string, string>());
  const nextId = useRef(0);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const available = enabled && wide && shells > 0 && !embedded;

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
    nextId.current = restoredTabs.tabs.length;
    setTabs(restoredTabs.tabs);
    setActiveId(restoredTabs.activeId);
    try {
      setSplitState(window.localStorage.getItem(SPLIT_KEY) === "1");
    } catch {
      // Blocked storage: no Delad vy remembered.
    }
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

  const activate = useCallback((id: string | null) => {
    setActiveId(id);
    if (id) setTabs((list) => list.map((t) => (t.id === id ? { ...t, lastUsed: Date.now() } : t)));
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

  const open = useCallback(
    (href: string, title: string): boolean => {
      const doc = documentHref(href, window.location.origin);
      if (!doc) return false;
      const result = openTabRule(tabsRef.current, doc, title, Date.now(), () => `tab-${++nextId.current}`, hasDrafts);
      if (result.kind === "refused") {
        notify({ tone: "error", message: "Alla flikar har osparade ändringar — spara eller stäng en flik först." });
        return true;
      }
      for (const id of result.closed) {
        frames.current.delete(id);
        sources.current.delete(id);
      }
      setTabs(result.tabs);
      setActiveId(result.activeId);
      return true;
    },
    [hasDrafts]
  );

  const close = useCallback(
    async (id: string) => {
      if (hasDrafts(id) && !(await confirmDialog(UNSAVED_MESSAGE, { confirmLabel: "Stäng fliken" }))) return;
      frames.current.delete(id);
      sources.current.delete(id);
      setTabs((list) => {
        const next = closeTabRule(list, id, null);
        return next.tabs;
      });
      setActiveId((current) => (current === id ? closeTabRule(tabsRef.current, id, id).activeId : current));
    },
    [hasDrafts]
  );

  const setSplit = useCallback((on: boolean) => {
    setSplitState(on);
    try {
      window.localStorage.setItem(SPLIT_KEY, on ? "1" : "0");
    } catch {
      // Blocked storage: the choice holds for this page view.
    }
  }, []);

  const registerShell = useCallback(() => {
    setShells((n) => n + 1);
    return () => setShells((n) => n - 1);
  }, []);

  // A navigation of the page itself shows the page (beside the document in
  // Delad vy), and its title becomes the first tab's name.
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    if (lastPath.current !== null && lastPath.current !== pathname && !split) setActiveId(null);
    lastPath.current = pathname;
    const timer = setTimeout(() => {
      const title = pathname === "/" ? "Översikt" : document.querySelector(`.${shellStyles.title}`)?.textContent?.trim();
      setPageTitle(title || "Sidan");
    }, 800);
    return () => clearTimeout(timer);
  }, [pathname, split]);

  // Documents opened from the page: a click on a document link opens a tab.
  // Window capture runs before the unsaved-changes guard and Next's Link —
  // opening a tab leaves nothing, so the page's drafts are not asked about.
  useEffect(() => {
    if (!available) return;
    registerTabOpener(open);
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const doc = documentHref(anchor.href, window.location.origin);
      if (!doc || sameDocument(doc, `${window.location.pathname}${window.location.search}`)) return;
      e.preventDefault();
      e.stopPropagation();
      open(doc, provisionalTitle(anchor.textContent));
    }
    window.addEventListener("click", onClick, true);
    return () => {
      registerTabOpener(null);
      window.removeEventListener("click", onClick, true);
    };
  }, [available, open]);

  // What the pages inside the tabs say: where they are now, a document to
  // open in a tab of its own, a page to show around them.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      const message = e.data as TabMessage | null;
      if (!message || typeof message !== "object" || typeof message.type !== "string") return;
      const from = [...frames.current.entries()].find(([, frame]) => frame.contentWindow === e.source)?.[0];
      if (!from) return;
      if (message.type === "nav-tab-state") {
        setTabs((list) =>
          list.map((t) => (t.id === from ? { ...t, href: message.href, title: message.title.slice(0, 80) || t.title } : t))
        );
      } else if (message.type === "nav-tab-open") {
        open(message.href, provisionalTitle(message.title));
      } else if (message.type === "nav-tab-navigate") {
        setActiveId(null);
        router.push(message.href);
      } else if (message.type === "nav-tab-activate") {
        activateDigit(message.digit);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open, router, activateDigit]);

  // The frame's state for the CSS (globals.css): the strip's row, the
  // shown document, Delad vy and the sidebar's width for the tab layer.
  const showLayer = available && activeId !== null && tabs.some((t) => t.id === activeId);
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-tabs", available && tabs.length > 0);
    root.toggleAttribute("data-tab-active", showLayer);
    root.toggleAttribute("data-split", showLayer && split);
    return () => {
      root.removeAttribute("data-tabs");
      root.removeAttribute("data-tab-active");
      root.removeAttribute("data-split");
    };
  }, [available, tabs.length, showLayer, split]);

  useEffect(() => {
    if (!available) return;
    const sidebar = document.querySelector<HTMLElement>("[data-app-sidebar]");
    if (!sidebar) return;
    const observer = new ResizeObserver(() => {
      const visible = getComputedStyle(sidebar).display !== "none";
      document.documentElement.style.setProperty("--app-sidebar-width", `${visible ? sidebar.getBoundingClientRect().width : 0}px`);
    });
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [available, pathname]);

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
    () => ({ available, tabs, activeId, split, pageTitle, activate, activateDigit, move, close, setSplit, setEnabled, registerShell }),
    [available, tabs, activeId, split, pageTitle, activate, activateDigit, move, close, setSplit, registerShell]
  );

  return (
    <TabsContext.Provider value={value}>
      {children}
      {/* Kept while the tabs are off or narrow, hidden: the pages stay alive. */}
      {tabs.length > 0 && !embedded && (
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
