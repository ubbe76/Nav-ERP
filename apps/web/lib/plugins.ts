import type { Permission } from "./permissions";

// Tillägg (plugins) — the web's mirror of the types and the event catalogue in
// packages/shared/src/plugins.ts (the web can't import @navet/shared, see
// lib/units.ts). Only types and pure helpers: no API calls.

export type PluginStatus = "active" | "paused";
export type PluginPageModule = "artiklar" | "inkop" | "forsaljning" | "tillverkning" | "lager" | "personal" | "ekonomi" | "rapporter";
export type PluginTabTarget = "article" | "customer" | "supplier";
export type PluginDeliveryStatus = "pending" | "delivered" | "failed";

export interface PluginManifest {
  format: "nav-plugin";
  version: number;
  key: string;
  name: string;
  description: string | null;
  author: string | null;
  homepage: string | null;
  permissions: Permission[];
  readOnly: boolean;
  webhook: { path: string; events: string[] } | null;
  pages: { key: string; title: string; description: string | null; module: PluginPageModule; path: string }[];
  tabs: { key: string; title: string; on: PluginTabTarget; path: string }[];
}

export interface PluginPreview {
  ok: boolean;
  baseUrl: string | null;
  manifest: PluginManifest | null;
  errors: string[];
  warnings: string[];
  keyTaken: boolean;
}

export interface PluginListRow {
  id: string;
  key: string;
  name: string;
  baseUrl: string;
  status: PluginStatus;
  lastDeliveredAt: string | null;
  failedLast7Days: number;
  installedAt: string;
}

export interface PluginDetail extends PluginListRow {
  manifest: PluginManifest;
  userId: string;
  permissionGroupId: string;
  permissions: Permission[];
  effectivePermissions: Permission[];
  readOnly: boolean;
  apiKeyPrefix: string;
  installedBy: string | null;
  updatedAt: string;
  pendingDeliveries: number;
}

export interface PluginInstallResult {
  plugin: PluginDetail;
  apiKey: string;
  webhookSecret: string;
}

export interface PluginDeliveryRow {
  id: string;
  eventId: string;
  eventType: string;
  entityId: string;
  entityNumber: string | null;
  occurredAt: string;
  status: PluginDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: string | null;
}

export interface PluginTestEventResult {
  delivered: boolean;
  statusCode: number | null;
  error: string | null;
  delivery: PluginDeliveryRow;
}

export interface PluginUiPage {
  pluginId: string;
  pluginKey: string;
  pluginName: string;
  key: string;
  title: string;
  description: string | null;
  module: PluginPageModule;
}
export interface PluginUiTab {
  pluginId: string;
  pluginKey: string;
  pluginName: string;
  key: string;
  title: string;
  on: PluginTabTarget;
}
export interface PluginUi {
  pages: PluginUiPage[];
  tabs: PluginUiTab[];
}

export interface PluginContextResponse {
  token: string;
  url: string;
  origin: string;
  expiresAt: string;
}

export interface PluginEventDef {
  type: string;
  label: string;
  permission: Permission;
}

// Mirror of PLUGIN_EVENT_CATALOG (label + the permission the plugin needs).
export const PLUGIN_EVENT_CATALOG: readonly PluginEventDef[] = [
  { type: "article.created", label: "Artikel skapad", permission: "artiklar" },
  { type: "article.updated", label: "Artikel ändrad", permission: "artiklar" },
  { type: "customer.created", label: "Kund skapad", permission: "forsaljning" },
  { type: "customer.updated", label: "Kund ändrad", permission: "forsaljning" },
  { type: "supplier.created", label: "Leverantör skapad", permission: "inkop" },
  { type: "supplier.updated", label: "Leverantör ändrad", permission: "inkop" },
  { type: "quote.created", label: "Offert skapad", permission: "forsaljning" },
  { type: "sales_order.confirmed", label: "Kundorder bekräftad", permission: "forsaljning" },
  { type: "sales_order.delivered", label: "Utleverans", permission: "forsaljning" },
  { type: "sales_order.cancelled", label: "Kundorder makulerad", permission: "forsaljning" },
  { type: "invoice.issued", label: "Faktura utfärdad", permission: "forsaljning" },
  { type: "invoice.paid", label: "Faktura betald", permission: "forsaljning" },
  { type: "purchase_order.created", label: "Inköpsorder skapad", permission: "inkop" },
  { type: "purchase_order.received", label: "Inköpsorder inlevererad", permission: "inkop" },
  { type: "manufacturing_order.created", label: "Tillverkningsorder skapad", permission: "tillverkning" },
  { type: "manufacturing_order.completed", label: "Tillverkningsorder klar", permission: "tillverkning" },
];

export function pluginEventLabel(type: string): string {
  if (type === "plugin.test") return "Testhändelse";
  return PLUGIN_EVENT_CATALOG.find((e) => e.type === type)?.label ?? type;
}

export const PLUGIN_STATUS_LABELS: Record<PluginStatus, string> = { active: "Aktiv", paused: "Pausad" };
export const PLUGIN_DELIVERY_STATUS_LABELS: Record<PluginDeliveryStatus, string> = {
  pending: "Väntar",
  delivered: "Levererad",
  failed: "Misslyckad",
};
export const PLUGIN_MODULE_LABELS: Record<PluginPageModule, string> = {
  artiklar: "Artiklar",
  inkop: "Inköp",
  forsaljning: "Försäljning",
  tillverkning: "Tillverkning",
  lager: "Lager",
  personal: "Personal & lön",
  ekonomi: "Ekonomi",
  rapporter: "Rapporter",
};
export const PLUGIN_TAB_TARGET_LABELS: Record<PluginTabTarget, string> = {
  article: "Artikelkortet",
  customer: "Kundkortet",
  supplier: "Leverantörskortet",
};

// The page a module's hub lives on (a plugin page is listed there).
export const PLUGIN_MODULE_HUBS: Record<PluginPageModule, string> = {
  artiklar: "/artiklar",
  inkop: "/inkop",
  forsaljning: "/forsaljning",
  tillverkning: "/tillverkning",
  lager: "/lager",
  personal: "/personal",
  ekonomi: "/ekonomi",
  rapporter: "/rapporter",
};

// The sidebar entry (AppShell `active`) of a module.
export const PLUGIN_MODULE_NAV: Record<PluginPageModule, string> = {
  artiklar: "Artiklar",
  inkop: "Inköp",
  forsaljning: "Försäljning",
  tillverkning: "Tillverkning",
  lager: "Lager",
  personal: "Personal & lön",
  ekonomi: "Ekonomi",
  rapporter: "Rapporter",
};

export function pluginPageHref(pluginKey: string, pageKey: string): string {
  return `/tillagg/${encodeURIComponent(pluginKey)}/${encodeURIComponent(pageKey)}`;
}

// postMessage "nav:navigate": only an internal path of this app — it starts
// with a single "/" and has no backslash, scheme or control characters — so
// a plugin can never send the browser to another site.
export function isInternalNavigationPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 500) return false;
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return false;
  try {
    const url = new URL(path, "http://nav.invalid");
    return url.origin === "http://nav.invalid";
  } catch {
    return false;
  }
}

// How long before the token expires a new one is fetched (never earlier than
// 10 s from now).
export const PLUGIN_TOKEN_REFRESH_MARGIN_MS = 60_000;
export function tokenRefreshDelay(expiresAt: string, now: number = Date.now()): number {
  return Math.max(10_000, new Date(expiresAt).getTime() - now - PLUGIN_TOKEN_REFRESH_MARGIN_MS);
}
