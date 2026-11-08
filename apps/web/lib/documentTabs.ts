// Flikar och delad vy (Nav som program, punkt 5). On a wide screen a
// document — any page whose path carries an id: a kundorder, an artikel, a
// faktura … — opens as a tab: a live page in an iframe under the toolbar,
// kept (hidden) while another tab or the page itself is shown, so its scroll
// and unsaved changes stay. The page under the sidebar is always the first
// tab; Delad vy shows it on the left with the open document on the right.
// Phones and narrow windows keep ordinary pages. Pure rules here
// (web-document-tabs.test.ts); components/tabs/DocumentTabs.tsx is the rest.

export const MAX_DOCUMENT_TABS = 8;
// Below this the tabs are off: the strip and a document beside a list need room.
export const TABS_MIN_WIDTH = 1100;

export interface DocumentTab {
  id: string;
  // Path and query inside Nav, as the tab shows it now (it follows the
  // tab's own navigation).
  href: string;
  title: string;
  // For choosing which tab gives way past MAX_DOCUMENT_TABS.
  lastUsed: number;
}

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/i;

// The document a link points at (path + query), or null for anything that
// stays an ordinary navigation: another site, the API (PDFs, CSV), a page
// without an id (lists, hubs, settings) and the stamping terminal.
export function documentHref(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/tillverkning/terminal")) return null;
  if (!UUID_SEGMENT.test(url.pathname)) return null;
  return `${url.pathname}${url.search}`;
}

// The same document: the same path (a tab's own ?flik= or filter is the same card).
export function sameDocument(a: string, b: string): boolean {
  return a.split(/[?#]/)[0] === b.split(/[?#]/)[0];
}

// A first name for a tab until its page has said its own: the link's text
// when it is short, otherwise "Dokument".
export function provisionalTitle(linkText: string | null | undefined): string {
  const text = (linkText ?? "").replace(/\s+/g, " ").trim();
  return text && text.length <= 40 ? text : "Dokument";
}

export type OpenResult =
  | { kind: "opened"; tabs: DocumentTab[]; activeId: string; closed: string[] }
  | { kind: "refused" }; // every tab has unsaved changes and there is no room

// Opens (or re-activates) the document. Past MAX_DOCUMENT_TABS the tabs used
// longest ago give way — never one with unsaved changes (`hasDrafts`).
export function openTab(
  tabs: readonly DocumentTab[],
  href: string,
  title: string,
  now: number,
  newId: () => string,
  hasDrafts: (id: string) => boolean
): OpenResult {
  const existing = tabs.find((t) => sameDocument(t.href, href));
  if (existing) {
    return {
      kind: "opened",
      tabs: tabs.map((t) => (t.id === existing.id ? { ...t, lastUsed: now } : t)),
      activeId: existing.id,
      closed: [],
    };
  }
  let kept = [...tabs];
  const closed: string[] = [];
  while (kept.length >= MAX_DOCUMENT_TABS) {
    const candidates = kept.filter((t) => !hasDrafts(t.id)).sort((a, b) => a.lastUsed - b.lastUsed);
    const victim = candidates[0];
    if (!victim) return { kind: "refused" };
    kept = kept.filter((t) => t.id !== victim.id);
    closed.push(victim.id);
  }
  const tab: DocumentTab = { id: newId(), href, title, lastUsed: now };
  return { kind: "opened", tabs: [...kept, tab], activeId: tab.id, closed };
}

// Closing the shown tab shows its right-hand neighbour, else the left one,
// else the page itself (null).
export function closeTab(
  tabs: readonly DocumentTab[],
  id: string,
  activeId: string | null
): { tabs: DocumentTab[]; activeId: string | null } {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return { tabs: [...tabs], activeId };
  const next = tabs.filter((t) => t.id !== id);
  if (activeId !== id) return { tabs: next, activeId };
  const neighbour = next[index] ?? next[index - 1] ?? null;
  return { tabs: next, activeId: neighbour?.id ?? null };
}

// What sessionStorage gives back after a reload, entry by entry: anything
// that is no longer a document tab is dropped.
export function restoreTabs(raw: string | null, origin: string): { tabs: DocumentTab[]; activeId: string | null } {
  if (!raw) return { tabs: [], activeId: null };
  try {
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeId?: unknown };
    if (!Array.isArray(parsed.tabs)) return { tabs: [], activeId: null };
    const tabs: DocumentTab[] = [];
    for (const entry of parsed.tabs) {
      if (!entry || typeof entry !== "object") continue;
      const { id, href, title, lastUsed } = entry as Record<string, unknown>;
      if (typeof id !== "string" || typeof href !== "string" || typeof title !== "string") continue;
      const doc = documentHref(href, origin);
      if (!doc || tabs.some((t) => t.id === id || sameDocument(t.href, doc))) continue;
      tabs.push({ id, href: doc, title: title.slice(0, 80), lastUsed: typeof lastUsed === "number" ? lastUsed : 0 });
      if (tabs.length === MAX_DOCUMENT_TABS) break;
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

export function isEmbedded(): boolean {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-embedded");
}

// The messages a tab's page sends the frame around it (same origin only).
export type TabMessage =
  | { type: "nav-tab-state"; href: string; title: string }
  | { type: "nav-tab-open"; href: string; title: string }
  | { type: "nav-tab-navigate"; href: string };
