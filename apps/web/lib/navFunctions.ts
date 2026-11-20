// Programramen (2026-11-20): which *function* a page belongs to — Kundorder,
// Artikelregister, Beläggning … — so that a function keeps one tab and the
// module panel can mark where the user is. A function is a page in the
// module structure (lib/moduleNav.ts via NAV_MODULES); a document belongs to
// the function whose path its own path starts with (/forsaljning/ordrar/<id>
// is Kundorder). Pure: web-nav-functions.test.ts.
import { NAV_MODULES } from "./navModules";

// The pages outside the module structure that the menu opens on their own.
const TOP_PAGES = ["/", "/aviseringar", "/hjalp", "/meddelanden", "/mina-installningar"] as const;

// A document whose list lives elsewhere: an article card belongs to
// Artikelregister, not to the Artiklar hub.
const DOCUMENT_ALIASES: readonly { pattern: RegExp; fn: string }[] = [
  { pattern: /^\/artiklar\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$)/i, fn: "/artiklar/register" },
];

function pathOf(href: string): string {
  const path = href.split(/[?#]/)[0] || "/";
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// Every function path, longest first (the first prefix match is the most
// specific). Module hubs are functions too: the module's own Översikt.
const FUNCTION_PATHS: readonly string[] = [
  ...new Set([
    ...TOP_PAGES,
    ...NAV_MODULES.map((m) => m.href),
    ...NAV_MODULES.flatMap((m) => m.sections.flatMap((s) => s.items.map((i) => pathOf(i.href)))),
  ]),
].sort((a, b) => b.length - a.length);

function startsWithSegment(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

// The function a page (path, query ignored) belongs to. A plugin page
// (/tillagg/<plugin>/<page>) is its own function; anything else unknown is
// its first path segment.
export function functionOf(href: string): string {
  const path = pathOf(href);
  if (path === "/") return "/";
  for (const alias of DOCUMENT_ALIASES) if (alias.pattern.test(path)) return alias.fn;
  if (path.startsWith("/tillagg/")) return path.split("/").slice(0, 4).join("/");
  for (const fn of FUNCTION_PATHS) {
    if (fn !== "/" && startsWithSegment(path, fn)) return fn;
  }
  return `/${path.split("/")[1] ?? ""}`;
}

const TOP_PAGE_TITLES: Record<string, string> = {
  "/": "Översikt",
  "/aviseringar": "Aviseringar",
  "/hjalp": "Hjälp",
  "/meddelanden": "Meddelanden",
  "/mina-installningar": "Mina inställningar",
};

// A function's name as the menu shows it — a tab's name until its page has
// said its own.
export function functionTitle(fn: string): string | null {
  if (TOP_PAGE_TITLES[fn]) return TOP_PAGE_TITLES[fn];
  for (const m of NAV_MODULES) {
    if (m.href === fn) return m.title;
    for (const s of m.sections) for (const i of s.items) if (pathOf(i.href) === fn) return i.title;
  }
  return null;
}
