// Flikar per funktion (Programramen, 2026-11-20; levande iframe-flikar sedan
// Nav som program punkt 5). On a wide screen every page opens in a tab of
// its function — Kundorder, Artikelregister, Beläggning … (functionOf in
// lib/navFunctions.ts): a live page in an iframe under the tab strip, kept
// (hidden) while another tab is shown, so its scroll and unsaved changes
// stay. A link to another page of the same function navigates inside its
// tab; a link to another function opens or shows that function's tab.
// Ctrl/⌘-click on a document gives the document a tab of its own. Phones and
// narrow windows keep ordinary pages. Pure rules here
// (web-document-tabs.test.ts); components/tabs/DocumentTabs.tsx is the rest.
import { functionOf } from "./navFunctions";

export const MAX_TABS = 8;
// Below this the tabs are off: the strip and the panel need room.
export const TABS_MIN_WIDTH = 1100;

export interface AppTab {
  id: string;
  // Path and query inside Nav, as the tab shows it now (it follows the
  // tab's own navigation).
  href: string;
  title: string;
  // The function the tab holds (functionOf of its href).
  fn: string;
  // A document opened in a tab of its own (Ctrl/⌘-click): never taken as
  // its function's tab.
  own: boolean;
  // For choosing which tab gives way past MAX_TABS.
  lastUsed: number;
}

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/i;

// Pages that never go in a tab: the login and the full-screen pages without
// the app frame.
const OUTSIDE_TABS = ["/login", "/register", "/tillverkning/terminal", "/lager/inventera"];

function outsideTabs(path: string): boolean {
  return path.startsWith("/api/") || OUTSIDE_TABS.some((p) => path === p || path.startsWith(`${p}/`));
}

function parse(href: string, origin: string): URL | null {
  try {
    const url = new URL(href, origin);
    return url.origin === origin ? url : null;
  } catch {
    return null;
  }
}

// A page inside Nav a tab can show (path + query), or null: another site,
// the API (PDFs, CSV), the login and the full-screen terminal pages.
export function appHref(href: string, origin: string): string | null {
  const url = parse(href, origin);
  if (!url) return null;
  if (outsideTabs(url.pathname)) return null;
  return `${url.pathname}${url.search}`;
}

// A document: a page whose path carries an id (a kundorder, an artikel, a
// faktura …) — what Ctrl/⌘-click gives a tab of its own.
export function documentHref(href: string, origin: string): string | null {
  const page = appHref(href, origin);
  if (!page || !UUID_SEGMENT.test(page.split("?")[0]!)) return null;
  return page;
}

// The same page: the same path (a tab's own ?flik= or filter is the same card).
export function sameDocument(a: string, b: string): boolean {
  return a.split(/[?#]/)[0] === b.split(/[?#]/)[0];
}

// A first name for a tab until its page has said its own: the link's text
// when it is short, otherwise "Dokument".
export function provisionalTitle(linkText: string | null | undefined): string {
  const text = (linkText ?? "").replace(/\s+/g, " ").trim();
  return text && text.length <= 40 ? text : "Dokument";
}

export interface OpenOptions {
  title: string;
  // A document in a tab of its own (Ctrl/⌘-click, openDocument within the
  // same function).
  own?: boolean;
  // "menu": a menu choice — shows the function's tab as it is, and only
  // takes the shown tab back to the address (the function's start page).
  // "link": everything else — the function's tab goes to the address.
  mode: "menu" | "link";
  activeId: string | null;
  now: number;
  newId: () => string;
  hasDrafts: (id: string) => boolean;
}

export type OpenResult =
  | {
      kind: "opened";
      tabs: AppTab[];
      activeId: string;
      closed: string[];
      // The address an existing tab has to go to (its frame navigates), or null.
      navigate: string | null;
    }
  | { kind: "refused" }; // every tab has unsaved changes and there is no room

// Opens (or shows) the page in its function's tab. Past MAX_TABS the tabs
// used longest ago give way — never one with unsaved changes (`hasDrafts`).
export function openTab(tabs: readonly AppTab[], href: string, options: OpenOptions): OpenResult {
  const fn = functionOf(href);
  const own = options.own === true;
  const existing = own
    ? tabs.find((t) => t.own && sameDocument(t.href, href))
    : [...tabs].filter((t) => !t.own && t.fn === fn).sort((a, b) => b.lastUsed - a.lastUsed)[0];
  if (existing) {
    let navigate: string | null = null;
    if (!own && existing.href !== href && (options.mode === "link" || existing.id === options.activeId)) navigate = href;
    return {
      kind: "opened",
      tabs: tabs.map((t) =>
        t.id === existing.id ? { ...t, lastUsed: options.now, ...(navigate ? { href: navigate } : {}) } : t
      ),
      activeId: existing.id,
      closed: [],
      navigate,
    };
  }
  let kept = [...tabs];
  const closed: string[] = [];
  while (kept.length >= MAX_TABS) {
    const candidates = kept.filter((t) => !options.hasDrafts(t.id)).sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = candidates[0];
    if (!victim) return { kind: "refused" };
    kept = kept.filter((t) => t.id !== victim.id);
    closed.push(victim.id);
  }
  const tab: AppTab = { id: options.newId(), href, title: options.title, fn, own, lastUsed: options.now };
  return { kind: "opened", tabs: [...kept, tab], activeId: tab.id, closed, navigate: null };
}

// Where a tab's own page says it is now: its address, its name and so its
// function (a document tab of its own stays its own).
export function tabMoved(tabs: readonly AppTab[], id: string, href: string, title: string): AppTab[] {
  return tabs.map((t) => (t.id === id ? { ...t, href, title: title.slice(0, 80) || t.title, fn: functionOf(href) } : t));
}

// Closing the shown tab shows its right-hand neighbour, else the left one,
// else nothing (null).
export function closeTab(
  tabs: readonly AppTab[],
  id: string,
  activeId: string | null
): { tabs: AppTab[]; activeId: string | null } {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return { tabs: [...tabs], activeId };
  const next = tabs.filter((t) => t.id !== id);
  if (activeId !== id) return { tabs: next, activeId };
  const neighbour = next[index] ?? next[index - 1] ?? null;
  return { tabs: next, activeId: neighbour?.id ?? null };
}

// Dra en flik: the tab moved to `toIndex` (clamped); the others keep their
// order.
export function moveTab(tabs: readonly AppTab[], id: string, toIndex: number): AppTab[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1) return [...tabs];
  const next = tabs.filter((t) => t.id !== id);
  const at = Math.max(0, Math.min(toIndex, next.length));
  next.splice(at, 0, tabs[from]!);
  return next;
}

// Byt flik med 1–9: tab n in the strip's order; undefined when there is no
// such tab.
export function tabForDigit(tabs: readonly AppTab[], digit: number): string | undefined {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9) return undefined;
  return tabs[digit - 1]?.id;
}

// What sessionStorage gives back after a reload, entry by entry: anything
// that is no longer a page a tab can show is dropped.
export function restoreTabs(raw: string | null, origin: string): { tabs: AppTab[]; activeId: string | null } {
  if (!raw) return { tabs: [], activeId: null };
  try {
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(parsed.tabs)) return { tabs: [], activeId: null };
    const tabs: AppTab[] = [];
    for (const entry of parsed.tabs) {
      if (!entry || typeof entry !== "object") continue;
      const { id, href, title, lastUsed, own } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof href !== "string" || typeof title !== "string") continue;
      const page = appHref(href, origin);
      if (!page || tabs.some((t) => t.id === id)) continue;
      tabs.push({
        id,
        href: page,
        title: title.slice(0, 80),
        fn: functionOf(page),
        own: own === true,
        lastUsed: typeof lastUsed === "number" ? lastUsed : 0,
      });
      if (tabs.length === MAX_TABS) break;
    }
    const activeId = typeof parsed.activeId === "string" && tabs.some((t) => t.id === parsed.activeId) ? parsed.activeId : null;
    return { tabs, activeId };
  } catch {
    return { tabs: [], activeId: null };
  }
}

// Inside a tab's iframe the page drops the app frame (sidebar, toolbar,
// status bar): <html data-embedded>, set before the first paint. Only for a
// frame of Nav's own origin — reading the parent's origin throws otherwise.
export const embeddedBootScript = `(function(){try{if(window.self!==window.top&&window.parent.location.origin===window.location.origin){document.documentElement.setAttribute("data-embedded","")}}catch(e){}})();`;

// The frame check itself, never the attribute: when React client-renders the
// root after a hydration error (a timestamp formatted in the server's zone, a
// browser extension touching the DOM) it re-acquires <html> and strips every
// attribute the boot scripts set, data-embedded included. A page that then
// trusted the attribute showed the whole app frame inside the tab and
// restored the tabs from the shared sessionStorage — Nav nested in itself,
// frame by frame. reassertEmbedded puts the attribute back.
export function isEmbedded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top && window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

// Called on mount by DocumentTabsProvider (a layout effect, so before the
// first paint of a client-rendered root): the CSS that hides the app frame
// keys on the attribute.
export function reassertEmbedded(): void {
  if (isEmbedded() && !document.documentElement.hasAttribute("data-embedded")) {
    document.documentElement.setAttribute("data-embedded", "");
  }
}

// The messages between the frame and a tab's page (same origin only).
export type TabMessage =
  // From the page: where it is now and what it is called.
  | { type: "nav-tab-state"; href: string; title: string }
  // From the page: open this page in its function's tab (own: a tab of its own).
  | { type: "nav-tab-open"; href: string; title: string; own?: boolean }
  // 1–9 pressed inside a tab: show tab n of the frame around it.
  | { type: "nav-tab-activate"; digit: number }
  // From the frame: go to this page (inside the tab, after the page's own
  // unsaved-changes question).
  | { type: "nav-tab-go"; href: string }
  // From the page: Namn under ikonerna changed in it (Mina inställningar in
  // a tab) — the menu is the frame's, so the frame shows the new choice.
  | { type: "nav-labels"; navLabels: string };
