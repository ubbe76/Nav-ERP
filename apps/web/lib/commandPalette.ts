// Sök och kommandon, Ctrl+K (Nav som program, punkt 2): the palette's pure
// parts — the pages it can go to (the sidebar's modules and every function in
// lib/moduleNav.ts), the text matching, the record searches and the recent
// list. The component is components/CommandPalette.tsx.
import {
  ARTIKLAR_SECTIONS,
  EKONOMI_SECTIONS,
  FORSALJNING_SECTIONS,
  INKOP_SECTIONS,
  KVALITET_SECTIONS,
  LAGER_SECTIONS,
  PERSONAL_SECTIONS,
  RAPPORTER_SECTIONS,
  SYSTEM_SECTIONS,
  TILLVERKNING_SECTIONS,
  sectionsForUser,
  type ModuleNavSection,
} from "./moduleNav";
import { canOpen } from "./pageAccess";
import type { Permission } from "./permissions";

export type PaletteUser = { role: "admin" | "supervisor" | "user"; permissions: readonly Permission[] };

export interface PalettePage {
  href: string;
  title: string;
  // The module it lies under ("Försäljning"), shown beside the title and
  // matched too, so "försäljning fakturor" finds Fakturor.
  module: string;
}

const MODULES: { title: string; href: string; sections: ModuleNavSection[] }[] = [
  { title: "Artiklar", href: "/artiklar", sections: ARTIKLAR_SECTIONS },
  { title: "Inköp", href: "/inkop", sections: INKOP_SECTIONS },
  { title: "Försäljning", href: "/forsaljning", sections: FORSALJNING_SECTIONS },
  { title: "Tillverkning", href: "/tillverkning", sections: TILLVERKNING_SECTIONS },
  { title: "Lager", href: "/lager", sections: LAGER_SECTIONS },
  { title: "Personal & lön", href: "/personal", sections: PERSONAL_SECTIONS },
  { title: "Kvalitet", href: "/kvalitet", sections: KVALITET_SECTIONS },
  { title: "Ekonomi", href: "/ekonomi", sections: EKONOMI_SECTIONS },
  { title: "Rapporter", href: "/rapporter", sections: RAPPORTER_SECTIONS },
  { title: "System", href: "/system", sections: SYSTEM_SECTIONS },
];

const TOP_PAGES: PalettePage[] = [
  { href: "/", title: "Översikt", module: "" },
  { href: "/aviseringar", title: "Aviseringar", module: "" },
  { href: "/hjalp", title: "Hjälp", module: "" },
];

// Every page the user may open, by the same rules as the sidebar and the
// module pages (sectionsForUser + canOpen) — the palette never offers a page
// that would be refused.
export function palettePages(user: PaletteUser): PalettePage[] {
  const pages: PalettePage[] = TOP_PAGES.filter((p) => canOpen(user, p.href));
  for (const mod of MODULES) {
    if (!canOpen(user, mod.href)) continue;
    pages.push({ href: mod.href, title: mod.title, module: "" });
    for (const section of sectionsForUser(mod.sections, user)) {
      for (const item of section.items) {
        if (!pages.some((p) => p.href === item.href)) pages.push({ href: item.href, title: item.title, module: mod.title });
      }
    }
  }
  return pages;
}

// Lower case and å/ä/ö/é folded, so "lagervardering" finds Lagervärdering.
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function queryWords(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean);
}

// Pages whose title (or title and module together) contain every word; a
// title that starts with the first word ranks first, then the shorter title.
export function matchPages(query: string, pages: PalettePage[], limit = 6): PalettePage[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits = pages
    .map((page) => {
      const title = foldText(page.title);
      const hay = `${title} ${foldText(page.module)}`;
      if (!words.every((w) => hay.includes(w))) return null;
      const rank = title.startsWith(words[0]!) ? 0 : title.split(/\s+/).some((t) => t.startsWith(words[0]!)) ? 1 : 2;
      return { page, rank };
    })
    .filter((hit): hit is { page: PalettePage; rank: number } => hit !== null);
  hits.sort((a, b) => a.rank - b.rank || a.page.title.length - b.page.title.length || a.page.title.localeCompare(b.page.title, "sv"));
  return hits.slice(0, limit).map((hit) => hit.page);
}

// A record search: the list endpoint's own `search`, a few rows, only when
// the user may open the list it belongs to.
export interface PaletteRecord {
  key: string;
  href: string;
  title: string;
  kind: string;
}

export interface PaletteSearch {
  key: string;
  // The list page — the gate (canOpen).
  page: string;
  url: (query: string) => string;
  map: (row: Record<string, unknown>) => PaletteRecord;
}

const ROWS = 3;
const enc = encodeURIComponent;
const text = (v: unknown) => (typeof v === "string" ? v : "");

export const PALETTE_SEARCHES: PaletteSearch[] = [
  {
    key: "sales",
    page: "/forsaljning/ordrar",
    url: (q) => `/api/v1/sales-orders?search=${enc(q)}&limit=${ROWS}`,
    map: (r) => {
      const quote = r.documentKind === "quote";
      return {
        key: `sales:${text(r.id)}`,
        href: `${quote ? "/forsaljning/offerter" : "/forsaljning/ordrar"}/${text(r.id)}`,
        title: [text(r.orderNumber), text(r.customerName)].filter(Boolean).join(" · "),
        kind: quote ? "Offert" : "Kundorder",
      };
    },
  },
  {
    key: "purchase",
    page: "/inkop/ordrar",
    url: (q) => `/api/v1/purchase-orders?search=${enc(q)}&limit=${ROWS}`,
    map: (r) => ({
      key: `purchase:${text(r.id)}`,
      href: `/inkop/ordrar/${text(r.id)}`,
      title: [text(r.orderNumber), text(r.supplierName)].filter(Boolean).join(" · "),
      kind: "Inköpsorder",
    }),
  },
  {
    key: "manufacturing",
    page: "/tillverkning/ordrar",
    url: (q) => `/api/v1/manufacturing-orders?search=${enc(q)}&limit=${ROWS}`,
    map: (r) => ({
      key: `manufacturing:${text(r.id)}`,
      href: `/tillverkning/ordrar/${text(r.id)}`,
      title: [text(r.orderNumber), text(r.articleName)].filter(Boolean).join(" · "),
      kind: "Tillverkningsorder",
    }),
  },
  {
    key: "invoices",
    page: "/forsaljning/fakturor",
    url: (q) => `/api/v1/invoices?search=${enc(q)}&limit=${ROWS}`,
    map: (r) => ({
      key: `invoice:${text(r.id)}`,
      href: `/forsaljning/fakturor/${text(r.id)}`,
      title: [text(r.invoiceNumber) || "Utkast", text(r.customerName)].filter(Boolean).join(" · "),
      kind: "Kundfaktura",
    }),
  },
  {
    key: "articles",
    page: "/artiklar/register",
    url: (q) => `/api/v1/articles?search=${enc(q)}&limit=${ROWS}`,
    map: (r) => ({
      key: `article:${text(r.id)}`,
      href: `/artiklar/${text(r.id)}`,
      title: [text(r.articleNumber), text(r.name)].filter(Boolean).join(" · "),
      kind: "Artikel",
    }),
  },
  {
    key: "customers",
    page: "/kunder",
    url: (q) => `/api/v1/customers?search=${enc(q)}&limit=${ROWS}`,
    map: (r) => ({
      key: `customer:${text(r.id)}`,
      href: `/kunder/${text(r.id)}`,
      title: [text(r.customerNumber), text(r.name)].filter(Boolean).join(" · "),
      kind: "Kund",
    }),
  },
  {
    key: "suppliers",
    page: "/leverantorer",
    url: (q) => `/api/v1/suppliers?search=${enc(q)}&limit=${ROWS}`,
    map: (r) => ({
      key: `supplier:${text(r.id)}`,
      href: `/leverantorer/${text(r.id)}`,
      title: [text(r.supplierNumber), text(r.name)].filter(Boolean).join(" · "),
      kind: "Leverantör",
    }),
  },
];

// The record searches start at two characters (one is a whole register).
export const MIN_SEARCH_LENGTH = 2;

export function searchesFor(user: PaletteUser): PaletteSearch[] {
  return PALETTE_SEARCHES.filter((s) => canOpen(user, s.page));
}

// Senast öppnade: the last pages visited in this browser, newest first, one
// per address, at most RECENT_MAX. Kept in localStorage (per browser, like
// the sidebar's collapsed state) — a convenience, never business data.
export const RECENT_KEY = "nav-erp-recent";
export const RECENT_MAX = 8;

export interface RecentPage {
  href: string;
  title: string;
}

export function addRecent(list: RecentPage[], entry: RecentPage): RecentPage[] {
  return [entry, ...list.filter((r) => r.href !== entry.href)].slice(0, RECENT_MAX);
}

export function parseRecent(raw: string | null): RecentPage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (r): r is RecentPage =>
          !!r && typeof r === "object" && typeof (r as RecentPage).href === "string" && typeof (r as RecentPage).title === "string"
      )
      .filter((r) => r.href.startsWith("/") && !r.href.startsWith("//"))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}
