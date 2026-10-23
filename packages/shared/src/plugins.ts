import { z } from "zod";
import { PERMISSIONS, type Permission } from "./permissions.js";

// Tillägg (plugin system, migration 0141). An installed plugin is an external
// program: it talks to Nav through the ordinary API with its own API key
// (a technical user with a permission group) and receives thin webhook events.
// This file is the shared contract: the manifest format and its validation
// (validatePluginManifest — pure, Swedish messages), the fixed event
// catalogue, and the API bodies/answers. Mirrored for the web later
// (apps/web/lib/plugins.ts).

export const PLUGIN_MANIFEST_FORMAT = "nav-plugin";
export const PLUGIN_MANIFEST_VERSION = 1;
// The manifest as fetched or uploaded: at most this many bytes.
export const PLUGIN_MANIFEST_MAX_BYTES = 64 * 1024;
// The manifest's well-known path under the plugin's base URL.
export const PLUGIN_MANIFEST_PATH = "/nav-plugin.json";
export const PLUGIN_MAX_PAGES = 10;
export const PLUGIN_MAX_TABS = 10;
export const PLUGIN_TITLE_MAX = 40;
export const PLUGIN_NAME_MAX = 60;

export const PLUGIN_KEY_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
// Keys of pages and tabs (unique within the plugin).
export const PLUGIN_ITEM_KEY_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

// The API key's fixed prefix — what tells requireAuth a bearer token is a
// plugin key and not an OAuth client token.
export const PLUGIN_API_KEY_PREFIX = "nav_plg_";
// The first characters kept for display (api_key_prefix).
export const PLUGIN_API_KEY_DISPLAY_LENGTH = 12;

// --- The event catalogue -----------------------------------------------------

// Fixed, extended one event at a time. `permission` is what the plugin's
// group must give for the event to be delivered — checked at DELIVERY, so a
// changed group applies at once.
export const PLUGIN_EVENT_TYPES = [
  "article.created",
  "article.updated",
  "customer.created",
  "customer.updated",
  "supplier.created",
  "supplier.updated",
  "quote.created",
  "sales_order.confirmed",
  "sales_order.delivered",
  "sales_order.cancelled",
  "invoice.issued",
  "invoice.paid",
  "purchase_order.created",
  "purchase_order.received",
  "manufacturing_order.created",
  "manufacturing_order.completed",
] as const;
export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

// Skicka testhändelse: delivered directly, never part of the catalogue (a
// manifest can't subscribe to it, and it needs no permission).
export const PLUGIN_TEST_EVENT_TYPE = "plugin.test";

export interface PluginEventDef {
  type: PluginEventType;
  label: string;
  permission: Permission;
}

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

const EVENT_BY_TYPE: ReadonlyMap<string, PluginEventDef> = new Map(PLUGIN_EVENT_CATALOG.map((d) => [d.type, d]));

export function pluginEventDef(type: string): PluginEventDef | undefined {
  return EVENT_BY_TYPE.get(type);
}

export function isPluginEventType(value: unknown): value is PluginEventType {
  return typeof value === "string" && EVENT_BY_TYPE.has(value);
}

// --- Where plugins show up ----------------------------------------------------

// The modules with a hub page — a plugin page lives in one of them and is
// shown only to users who may open the module.
export const PLUGIN_PAGE_MODULES = [
  "artiklar",
  "inkop",
  "forsaljning",
  "tillverkning",
  "lager",
  "personal",
  "ekonomi",
  "rapporter",
] as const satisfies readonly Permission[];
export type PluginPageModule = (typeof PLUGIN_PAGE_MODULES)[number];

// The cards with tabs, and the permission that opens each card (the same as
// the web's page rule for /artiklar, /kunder and /leverantorer).
export const PLUGIN_TAB_TARGETS = ["article", "customer", "supplier"] as const;
export type PluginTabTarget = (typeof PLUGIN_TAB_TARGETS)[number];
export const PLUGIN_TAB_PERMISSION: Readonly<Record<PluginTabTarget, Permission>> = {
  article: "artiklar",
  customer: "forsaljning",
  supplier: "inkop",
};

// --- The manifest ---------------------------------------------------------------

export interface PluginPage {
  key: string;
  title: string;
  description: string | null;
  module: PluginPageModule;
  path: string;
}

export interface PluginTab {
  key: string;
  title: string;
  on: PluginTabTarget;
  path: string;
}

export interface PluginManifest {
  format: typeof PLUGIN_MANIFEST_FORMAT;
  version: number;
  key: string;
  name: string;
  description: string | null;
  author: string | null;
  homepage: string | null;
  // A REQUEST — the administrator approves (and may change) it at install.
  permissions: Permission[];
  readOnly: boolean;
  webhook: { path: string; events: PluginEventType[] } | null;
  pages: PluginPage[];
  tabs: PluginTab[];
}

export type PluginManifestValidation =
  | { ok: true; manifest: PluginManifest; errors: []; warnings: string[] }
  | { ok: false; manifest: null; errors: string[]; warnings: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A path relative to the plugin's base URL: starts with "/", never "//"
// (protocol-relative), no backslash, whitespace or control characters, and
// no scheme — an absolute URL is refused.
export function isRelativePluginPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\s\u0000-\u001f\u007f]/.test(value)
  );
}

// An http(s) URL without credentials, query or fragment; the trailing "/"
// is dropped so "<baseUrl><path>" never doubles it. null = not acceptable.
export function normalizePluginBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 255) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!url.hostname) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

// The origin of a base URL ("https://example.com:8443"), null when it is
// not one.
export function pluginOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

const TOP_LEVEL_FIELDS = new Set([
  "format",
  "version",
  "key",
  "name",
  "description",
  "author",
  "homepage",
  "permissions",
  "readOnly",
  "webhook",
  "pages",
  "tabs",
  // A conventional JSON Schema pointer — not a field of ours, never warned.
  "$schema",
]);
const WEBHOOK_FIELDS = new Set(["path", "events"]);
const PAGE_FIELDS = new Set(["key", "title", "description", "module", "path"]);
const TAB_FIELDS = new Set(["key", "title", "on", "path"]);

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

// Optional text: absent/null ⇒ null, otherwise a trimmed string within max.
function optionalText(
  raw: Record<string, unknown>,
  field: string,
  label: string,
  max: number,
  errors: string[]
): string | null {
  const value = raw[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    errors.push(`${label} måste vara text.`);
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) errors.push(`${label} får vara högst ${max} tecken.`);
  return trimmed.length > 0 ? trimmed : null;
}

function requiredText(raw: Record<string, unknown>, field: string, label: string, max: number, errors: string[]): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} saknas.`);
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length > max) errors.push(`${label} får vara högst ${max} tecken.`);
  return trimmed;
}

function warnUnknown(raw: Record<string, unknown>, known: ReadonlySet<string>, where: string, warnings: string[]) {
  for (const field of Object.keys(raw)) {
    if (!known.has(field)) warnings.push(`Okänt fält ${where}${field} ignoreras.`);
  }
}

// The manifest's rules (see the spec, "Manifestet"). Pure: no I/O. Unknown
// fields are dropped with a warning; a version above ours is refused.
export function validatePluginManifest(input: unknown): PluginManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): PluginManifestValidation => ({ ok: false, manifest: null, errors, warnings });

  if (!isRecord(input)) {
    errors.push("Manifestet måste vara ett JSON-objekt.");
    return fail();
  }
  if (input.format !== PLUGIN_MANIFEST_FORMAT) {
    errors.push(`Fältet format måste vara "${PLUGIN_MANIFEST_FORMAT}".`);
  }
  const version = input.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    errors.push("Fältet version måste vara ett heltal (1).");
  } else if (version > PLUGIN_MANIFEST_VERSION) {
    errors.push(`Tillägget kräver en nyare Nav (manifestversion ${version}).`);
  }
  if (errors.length > 0) return fail();

  warnUnknown(input, TOP_LEVEL_FIELDS, "", warnings);

  const key = input.key;
  if (typeof key !== "string" || !PLUGIN_KEY_PATTERN.test(key)) {
    errors.push("Nyckeln (key) måste vara 2–40 tecken: små bokstäver a–z, siffror och bindestreck, och börja med en bokstav.");
  }
  const name = requiredText(input, "name", "Namnet", PLUGIN_NAME_MAX, errors);
  const description = optionalText(input, "description", "Beskrivningen", 500, errors);
  const author = optionalText(input, "author", "Utgivaren (author)", 100, errors);
  let homepage = optionalText(input, "homepage", "Hemsidan", 255, errors);
  if (homepage !== null) {
    const normalized = normalizePluginBaseUrl(homepage);
    if (normalized === null) errors.push("Hemsidan måste vara en http- eller https-adress.");
    else homepage = homepage.trim();
  }

  // Permissions: a subset of the catalogue (never admin), duplicates dropped.
  const permissions: Permission[] = [];
  if (input.permissions !== undefined) {
    if (!Array.isArray(input.permissions)) {
      errors.push("Rättigheterna (permissions) måste vara en lista.");
    } else {
      for (const p of input.permissions) {
        if (typeof p !== "string" || !KNOWN_PERMISSIONS.has(p)) {
          errors.push(`Okänd rättighet: ${String(p).slice(0, 40)}.`);
        } else if (!permissions.includes(p as Permission)) {
          permissions.push(p as Permission);
        }
      }
    }
  }

  let readOnly = false;
  if (input.readOnly !== undefined) {
    if (typeof input.readOnly !== "boolean") errors.push("Fältet readOnly måste vara true eller false.");
    else readOnly = input.readOnly;
  }

  let webhook: PluginManifest["webhook"] = null;
  if (input.webhook !== undefined && input.webhook !== null) {
    if (!isRecord(input.webhook)) {
      errors.push("Fältet webhook måste vara ett objekt.");
    } else {
      warnUnknown(input.webhook, WEBHOOK_FIELDS, "webhook.", warnings);
      const path = input.webhook.path;
      if (!isRelativePluginPath(path)) {
        errors.push("webhook.path måste vara en relativ sökväg som börjar med /.");
      }
      const events: PluginEventType[] = [];
      const rawEvents = input.webhook.events ?? [];
      if (!Array.isArray(rawEvents)) {
        errors.push("webhook.events måste vara en lista.");
      } else {
        for (const e of rawEvents) {
          if (!isPluginEventType(e)) errors.push(`Okänd händelse: ${String(e).slice(0, 60)}.`);
          else if (!events.includes(e)) events.push(e);
        }
      }
      if (isRelativePluginPath(path)) webhook = { path, events };
    }
  }

  const pages: PluginPage[] = [];
  if (input.pages !== undefined) {
    if (!Array.isArray(input.pages)) {
      errors.push("Sidorna (pages) måste vara en lista.");
    } else {
      if (input.pages.length > PLUGIN_MAX_PAGES) errors.push(`Ett tillägg får ha högst ${PLUGIN_MAX_PAGES} sidor.`);
      input.pages.forEach((raw, index) => {
        const where = `Sida ${index + 1}`;
        if (!isRecord(raw)) {
          errors.push(`${where} måste vara ett objekt.`);
          return;
        }
        warnUnknown(raw, PAGE_FIELDS, `pages[${index}].`, warnings);
        const pageKey = raw.key;
        if (typeof pageKey !== "string" || !PLUGIN_ITEM_KEY_PATTERN.test(pageKey)) {
          errors.push(`${where}: nyckeln måste vara 1–40 tecken: små bokstäver a–z, siffror och bindestreck.`);
        } else if (pages.some((p) => p.key === pageKey)) {
          errors.push(`${where}: nyckeln ${pageKey} finns redan.`);
        }
        const title = requiredText(raw, "title", `${where}: titeln`, PLUGIN_TITLE_MAX, errors);
        const pageDescription = optionalText(raw, "description", `${where}: beskrivningen`, 200, errors);
        const module = raw.module;
        if (typeof module !== "string" || !(PLUGIN_PAGE_MODULES as readonly string[]).includes(module)) {
          errors.push(`${where}: modulen måste vara en av ${PLUGIN_PAGE_MODULES.join(", ")}.`);
        }
        if (!isRelativePluginPath(raw.path)) errors.push(`${where}: sökvägen måste vara relativ och börja med /.`);
        if (typeof pageKey === "string" && typeof raw.path === "string") {
          pages.push({ key: pageKey, title, description: pageDescription, module: module as PluginPageModule, path: raw.path });
        }
      });
    }
  }

  const tabs: PluginTab[] = [];
  if (input.tabs !== undefined) {
    if (!Array.isArray(input.tabs)) {
      errors.push("Flikarna (tabs) måste vara en lista.");
    } else {
      if (input.tabs.length > PLUGIN_MAX_TABS) errors.push(`Ett tillägg får ha högst ${PLUGIN_MAX_TABS} flikar.`);
      input.tabs.forEach((raw, index) => {
        const where = `Flik ${index + 1}`;
        if (!isRecord(raw)) {
          errors.push(`${where} måste vara ett objekt.`);
          return;
        }
        warnUnknown(raw, TAB_FIELDS, `tabs[${index}].`, warnings);
        const tabKey = raw.key;
        if (typeof tabKey !== "string" || !PLUGIN_ITEM_KEY_PATTERN.test(tabKey)) {
          errors.push(`${where}: nyckeln måste vara 1–40 tecken: små bokstäver a–z, siffror och bindestreck.`);
        } else if (tabs.some((t) => t.key === tabKey)) {
          errors.push(`${where}: nyckeln ${tabKey} finns redan.`);
        }
        const title = requiredText(raw, "title", `${where}: titeln`, PLUGIN_TITLE_MAX, errors);
        const on = raw.on;
        if (typeof on !== "string" || !(PLUGIN_TAB_TARGETS as readonly string[]).includes(on)) {
          errors.push(`${where}: on måste vara en av ${PLUGIN_TAB_TARGETS.join(", ")}.`);
        }
        if (!isRelativePluginPath(raw.path)) errors.push(`${where}: sökvägen måste vara relativ och börja med /.`);
        if (typeof tabKey === "string" && typeof raw.path === "string") {
          tabs.push({ key: tabKey, title, on: on as PluginTabTarget, path: raw.path });
        }
      });
    }
  }

  if (errors.length > 0) return fail();
  return {
    ok: true,
    manifest: {
      format: PLUGIN_MANIFEST_FORMAT,
      version: version as number,
      key: key as string,
      name,
      description,
      author,
      homepage,
      permissions,
      readOnly,
      webhook,
      pages,
      tabs,
    },
    errors: [],
    warnings,
  };
}

// --- API bodies -----------------------------------------------------------------

const permissionListSchema = z
  .array(z.enum(PERMISSIONS))
  .max(PERMISSIONS.length)
  .refine((list) => new Set(list).size === list.length, { message: "Duplicate permission" });

// The manifest travels as parsed JSON; validatePluginManifest is the real check.
const manifestBodySchema = z.record(z.string(), z.unknown());
const baseUrlBodySchema = z.string().trim().min(1).max(255);

// POST /plugins/preview — fetch (baseUrl) or check (manifest); saves nothing.
// With both, the uploaded manifest is checked and baseUrl is only checked as
// an address (no fetch).
export const pluginPreviewSchema = z
  .object({ baseUrl: baseUrlBodySchema.optional(), manifest: manifestBodySchema.optional() })
  .refine((body) => body.baseUrl !== undefined || body.manifest !== undefined, "Ange adress eller manifest");
export type PluginPreviewInput = z.infer<typeof pluginPreviewSchema>;

// POST /plugins — the administrator's decision: the address, the manifest
// (as previewed), the permissions to grant and Endast läsning.
export const createPluginSchema = z.object({
  baseUrl: baseUrlBodySchema,
  manifest: manifestBodySchema,
  permissions: permissionListSchema,
  readOnly: z.boolean(),
});
export type CreatePluginInput = z.infer<typeof createPluginSchema>;

export const PLUGIN_STATUSES = ["active", "paused"] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

// PATCH /plugins/:id — any subset. A new manifest never grants permissions
// on its own: only `permissions` changes the group.
export const updatePluginSchema = z
  .object({
    baseUrl: baseUrlBodySchema.optional(),
    manifest: manifestBodySchema.optional(),
    permissions: permissionListSchema.optional(),
    readOnly: z.boolean().optional(),
    status: z.enum(PLUGIN_STATUSES).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdatePluginInput = z.infer<typeof updatePluginSchema>;

// POST /plugins/:id/context — a page (by key) or a tab (by key, with the
// post the card shows).
export const pluginContextSchema = z.union([
  z.object({ page: z.string().min(1).max(40) }).strict(),
  z.object({ tab: z.string().min(1).max(40), entityId: z.string().uuid() }).strict(),
]);
export type PluginContextInput = z.infer<typeof pluginContextSchema>;

export const PLUGIN_DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type PluginDeliveryStatus = (typeof PLUGIN_DELIVERY_STATUSES)[number];

// --- API answers ------------------------------------------------------------------

// POST /plugins/preview.
export interface PluginPreview {
  ok: boolean;
  baseUrl: string | null;
  manifest: PluginManifest | null;
  errors: string[];
  warnings: string[];
  // A plugin with the same key is already installed (POST would 409).
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
  // The group's permissions as granted (the checkboxes, like Behörighetsgrupper)
  // and expanded (what the plugin may do now), and Endast läsning.
  permissions: Permission[];
  effectivePermissions: Permission[];
  readOnly: boolean;
  apiKeyPrefix: string;
  installedBy: string | null;
  updatedAt: string;
  pendingDeliveries: number;
}

// POST /plugins and the rotate routes: the secrets are shown ONCE.
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

// POST /plugins/:id/test-event — delivered at once.
export interface PluginTestEventResult {
  delivered: boolean;
  statusCode: number | null;
  error: string | null;
  delivery: PluginDeliveryRow;
}

// GET /plugin-ui — the pages/tabs the signed-in user may see, active plugins only.
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

// POST /plugins/:id/context. `origin` is where postMessage may come from.
export interface PluginContextResponse {
  token: string;
  url: string;
  origin: string;
  expiresAt: string;
}

// The context token's claims (HS256, signed with the webhook secret).
export interface PluginContextClaims {
  iss: string;
  aud: string;
  sub: string;
  name: string;
  permissions: Permission[];
  readOnly: boolean;
  entity?: { type: PluginTabTarget; id: string };
  theme: string;
  iat: number;
  exp: number;
}

// The webhook body.
export interface PluginWebhookBody {
  id: string;
  type: string;
  occurredAt: string;
  plugin: string;
  data: { id: string; number: string | null } & Record<string, string | null>;
}
