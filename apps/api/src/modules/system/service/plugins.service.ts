import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import {
  effectivePermissions,
  normalizePluginBaseUrl,
  PLUGIN_API_KEY_DISPLAY_LENGTH,
  PLUGIN_MANIFEST_MAX_BYTES,
  PLUGIN_MANIFEST_PATH,
  PLUGIN_TAB_PERMISSION,
  pluginOrigin,
  satisfiesRule,
  validatePluginManifest,
  type CreatePluginInput,
  type Permission,
  type PluginContextClaims,
  type PluginContextInput,
  type PluginContextResponse,
  type PluginDeliveryRow,
  type PluginDetail,
  type PluginInstallResult,
  type PluginListRow,
  type PluginManifest,
  type PluginPreview,
  type PluginPreviewInput,
  type PluginTestEventResult,
  type PluginUi,
  type UpdatePluginInput,
  type UserRole,
} from "@navet/shared";
import type { AuditWriter } from "../repository/audit.repository.js";
import type { DeliveryRow, PluginsRepository, PluginWithAccess } from "../repository/plugins.repository.js";
import { sha256Hex } from "../../auth/service/auth.service.js";
import { isUniqueViolation } from "./db-errors.js";
import type { PluginDispatcher, WebhookFetch } from "./plugin-dispatcher.js";
import { pluginEvents } from "./plugin-events.js";
import { CLAIM_MS, newPluginApiKey, newWebhookSecret, WEBHOOK_TIMEOUT_MS } from "./plugin-webhook.js";
import {
  PluginAccessDeniedError,
  PluginDeliveryNotFoundError,
  PluginDeliveryNotRetryableError,
  PluginInvalidAddressError,
  PluginKeyTakenError,
  PluginManifestInvalidError,
  PluginManifestUnreachableError,
  PluginNotFoundError,
  PluginSameOriginError,
} from "./plugins.errors.js";

// Tillägg — System → Tillägg (admin) and the two reads every user's web
// needs (GET /plugin-ui, POST /plugins/:id/context). See the spec
// private/superpowers/specs/2026-10-23-tillagg-design.md.
//
// Outbound requests (the manifest fetch here, the webhooks in the
// dispatcher) go only to the address an ADMINISTRATOR entered: http/https
// without credentials, never following a redirect, with a timeout and a
// size cap, and the answer's body is never passed on — only the parsed
// manifest or a status code. Private addresses are allowed on purpose: a
// plugin normally runs next to Nav (its own container, the LAN).

export const CONTEXT_TOKEN_SECONDS = 300;
const FAILED_WINDOW_DAYS = 7;

export interface PluginSettingsReader {
  // System → Inställningar's Navs adress ("" when not set).
  publicBaseUrl(): Promise<string>;
  // The theme the user sees (their own choice, else the company default).
  themeFor(userId: string): Promise<string>;
}

export interface PluginViewer {
  id: string;
  name: string;
  role: UserRole;
  permissions: Permission[];
  readOnly: boolean;
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

function deliveryRow(row: DeliveryRow): PluginDeliveryRow {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    entityId: row.entityId,
    entityNumber: row.entityNumber,
    occurredAt: row.occurredAt.toISOString(),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: iso(row.nextAttemptAt),
    lastAttemptAt: iso(row.lastAttemptAt),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    deliveredAt: iso(row.deliveredAt),
  };
}

// The URL a page/tab opens: the plugin's address, the manifest's path and
// the context token.
function contextUrl(baseUrl: string, path: string, token: string): string {
  return `${baseUrl}${path}${path.includes("?") ? "&" : "?"}nav_context=${encodeURIComponent(token)}`;
}

// The manifest body, size-capped while it streams in.
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createPluginsService(deps: {
  repo: PluginsRepository;
  audit: AuditWriter;
  settings: PluginSettingsReader;
  dispatcher: PluginDispatcher;
  // Nav's own web origin(s) — a plugin may never share one.
  webOrigins: string[];
  fetch?: WebhookFetch;
  now?: () => Date;
}) {
  const { repo, audit, settings, dispatcher } = deps;
  const fetchFn: WebhookFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? (() => new Date());

  const failedSince = () => new Date(now().getTime() - FAILED_WINDOW_DAYS * 86_400_000);

  async function navOrigins(): Promise<Set<string>> {
    const origins = new Set<string>();
    for (const url of [await settings.publicBaseUrl(), ...deps.webOrigins]) {
      const origin = url ? pluginOrigin(url) : null;
      if (origin) origins.add(origin);
    }
    return origins;
  }

  // The address an administrator entered: normalised, and never Nav's own
  // origin (the iframe sandbox would be void).
  async function checkedBaseUrl(raw: string): Promise<string> {
    const baseUrl = normalizePluginBaseUrl(raw);
    if (!baseUrl) throw new PluginInvalidAddressError();
    if ((await navOrigins()).has(pluginOrigin(baseUrl)!)) throw new PluginSameOriginError();
    return baseUrl;
  }

  function validated(raw: unknown): { manifest: PluginManifest; warnings: string[] } {
    const result = validatePluginManifest(raw);
    if (!result.ok) throw new PluginManifestInvalidError(result.errors, result.warnings);
    return { manifest: result.manifest, warnings: result.warnings };
  }

  async function fetchManifest(baseUrl: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${PLUGIN_MANIFEST_PATH}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      throw new PluginManifestUnreachableError(
        name === "TimeoutError" || name === "AbortError" ? "tidsgränsen (10 s) överskreds" : "kunde inte ansluta"
      );
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new PluginManifestUnreachableError(`adressen svarade ${res.status}`);
    }
    const text = await readCapped(res, PLUGIN_MANIFEST_MAX_BYTES);
    if (text === null) throw new PluginManifestUnreachableError("manifestet är större än 64 kB");
    try {
      return JSON.parse(text);
    } catch {
      throw new PluginManifestUnreachableError("svaret är inte giltig JSON");
    }
  }

  async function existing(id: string): Promise<PluginWithAccess> {
    const found = await repo.get(id);
    if (!found) throw new PluginNotFoundError(id);
    return found;
  }

  async function detail(found: PluginWithAccess): Promise<PluginDetail> {
    const { plugin } = found;
    const stats = await repo.deliveryStats(plugin.id, failedSince());
    return {
      id: plugin.id,
      key: plugin.key,
      name: plugin.name,
      baseUrl: plugin.baseUrl,
      status: plugin.status,
      lastDeliveredAt: iso(stats.lastDeliveredAt),
      failedLast7Days: stats.failed,
      installedAt: plugin.installedAt.toISOString(),
      manifest: plugin.manifest as PluginManifest,
      userId: plugin.userId,
      permissionGroupId: plugin.permissionGroupId,
      permissions: effectivePermissions("user", found.groupPermissions),
      readOnly: found.readOnly,
      apiKeyPrefix: plugin.apiKeyPrefix,
      installedBy: plugin.installedBy,
      updatedAt: plugin.updatedAt.toISOString(),
      pendingDeliveries: stats.pending,
    };
  }

  const getDetail = async (id: string) => detail(await existing(id));

  // Only the permissions the administrator granted (the catalogue's own
  // codes, deduplicated) — the group stores what it is given.
  const grant = (permissions: readonly Permission[]): Permission[] => [...new Set(permissions)];

  return {
    // POST /plugins/preview — fetch or check, save nothing.
    async preview(input: PluginPreviewInput): Promise<PluginPreview> {
      let baseUrl: string | null = null;
      let raw: unknown = input.manifest;
      if (input.baseUrl !== undefined) {
        baseUrl = await checkedBaseUrl(input.baseUrl);
        if (raw === undefined) raw = await fetchManifest(baseUrl);
      }
      const result = validatePluginManifest(raw);
      return {
        ok: result.ok,
        baseUrl,
        manifest: result.manifest,
        errors: result.errors,
        warnings: result.warnings,
        keyTaken: result.ok ? await repo.keyExists(result.manifest.key) : false,
      };
    },

    async list(): Promise<PluginListRow[]> {
      const rows = await repo.list(failedSince());
      return rows.map(({ plugin, lastDeliveredAt, failedLast7Days }) => ({
        id: plugin.id,
        key: plugin.key,
        name: plugin.name,
        baseUrl: plugin.baseUrl,
        status: plugin.status,
        lastDeliveredAt: iso(lastDeliveredAt),
        failedLast7Days,
        installedAt: plugin.installedAt.toISOString(),
      }));
    },

    get: getDetail,

    // Installera: group, technical user and plugin in one transaction; the
    // API key and webhook secret are answered once and never again.
    async install(input: CreatePluginInput, userId: string | null): Promise<PluginInstallResult> {
      const baseUrl = await checkedBaseUrl(input.baseUrl);
      const { manifest } = validated(input.manifest);
      if (await repo.keyExists(manifest.key)) throw new PluginKeyTakenError(manifest.key);
      const apiKey = newPluginApiKey(manifest.key);
      const webhookSecret = newWebhookSecret();
      const permissions = grant(input.permissions);
      let id: string;
      try {
        id = await repo.install(
          {
            key: manifest.key,
            name: manifest.name,
            baseUrl,
            manifest,
            permissions,
            readOnly: input.readOnly,
            apiKeyHash: sha256Hex(apiKey),
            apiKeyPrefix: apiKey.slice(0, PLUGIN_API_KEY_DISPLAY_LENGTH),
            webhookSecret,
            installedBy: userId,
          },
          // Not a bcrypt hash: no password can ever match it.
          `!plugin:${randomBytes(16).toString("hex")}`
        );
      } catch (err) {
        if (isUniqueViolation(err, "plugins_key_unique")) throw new PluginKeyTakenError(manifest.key);
        throw err;
      }
      pluginEvents.invalidate();
      await audit.log({
        entityType: "plugin",
        entityId: manifest.key,
        action: "plugin_installed",
        detail: {
          name: manifest.name,
          baseUrl,
          permissions,
          readOnly: input.readOnly,
          events: manifest.webhook?.events ?? [],
        },
        userId,
      });
      return { plugin: await getDetail(id), apiKey, webhookSecret };
    },

    // PATCH /plugins/:id. A new manifest never grants anything by itself:
    // only `permissions` changes the group.
    async update(id: string, input: UpdatePluginInput, userId: string | null): Promise<PluginDetail> {
      const before = await existing(id);
      const baseUrl = input.baseUrl !== undefined ? await checkedBaseUrl(input.baseUrl) : undefined;
      let manifest: PluginManifest | undefined;
      if (input.manifest !== undefined) {
        manifest = validated(input.manifest).manifest;
        if (manifest.key !== before.plugin.key) {
          throw new PluginManifestInvalidError([`Nyckeln kan inte ändras (installerat som ${before.plugin.key}).`]);
        }
      }
      const permissions = input.permissions !== undefined ? grant(input.permissions) : undefined;
      const row = await repo.update(id, {
        name: manifest?.name,
        baseUrl,
        manifest,
        permissions,
        readOnly: input.readOnly,
        status: input.status,
      });
      if (!row) throw new PluginNotFoundError(id);
      pluginEvents.invalidate();

      const beforePermissions = effectivePermissions("user", before.groupPermissions);
      const changedFields: string[] = [];
      const detailLog: Record<string, unknown> = {};
      if (baseUrl !== undefined && baseUrl !== before.plugin.baseUrl) {
        changedFields.push("baseUrl");
        detailLog.baseUrl = { before: before.plugin.baseUrl, after: baseUrl };
      }
      if (manifest !== undefined) changedFields.push("manifest");
      if (permissions !== undefined && [...permissions].sort().join() !== [...before.groupPermissions].sort().join()) {
        changedFields.push("permissions");
        detailLog.permissions = { before: beforePermissions, after: effectivePermissions("user", permissions) };
      }
      if (input.readOnly !== undefined && input.readOnly !== before.readOnly) {
        changedFields.push("readOnly");
        detailLog.readOnly = { before: before.readOnly, after: input.readOnly };
      }
      if (changedFields.length > 0) {
        await audit.log({ entityType: "plugin", entityId: row.key, action: "plugin_updated", detail: { changedFields, ...detailLog }, userId });
      }
      if (input.status !== undefined && input.status !== before.plugin.status) {
        await audit.log({
          entityType: "plugin",
          entityId: row.key,
          action: input.status === "paused" ? "plugin_paused" : "plugin_activated",
          userId,
        });
        // Aktivera: the deliveries that waited go out on the next run.
        if (input.status === "active") pluginEvents.kick();
      }
      return getDetail(id);
    },

    // Ny API-nyckel: the old one stops working at once.
    async rotateKey(id: string, userId: string | null): Promise<{ plugin: PluginDetail; apiKey: string }> {
      const { plugin } = await existing(id);
      const apiKey = newPluginApiKey(plugin.key);
      if (!(await repo.setApiKey(id, sha256Hex(apiKey), apiKey.slice(0, PLUGIN_API_KEY_DISPLAY_LENGTH)))) {
        throw new PluginNotFoundError(id);
      }
      await audit.log({ entityType: "plugin", entityId: plugin.key, action: "plugin_key_rotated", userId });
      return { plugin: await getDetail(id), apiKey };
    },

    async rotateSecret(id: string, userId: string | null): Promise<{ plugin: PluginDetail; webhookSecret: string }> {
      const { plugin } = await existing(id);
      const webhookSecret = newWebhookSecret();
      if (!(await repo.setWebhookSecret(id, webhookSecret))) throw new PluginNotFoundError(id);
      await audit.log({ entityType: "plugin", entityId: plugin.key, action: "plugin_secret_rotated", userId });
      return { plugin: await getDetail(id), webhookSecret };
    },

    // Skicka testhändelse: plugin.test, sent at once (also to a paused
    // plugin — the administrator asked for it) and answered with the result.
    async testEvent(id: string): Promise<PluginTestEventResult> {
      const { plugin } = await existing(id);
      const deliveryId = await repo.createTestDelivery(plugin, new Date(now().getTime() + CLAIM_MS));
      const result = await dispatcher.deliverNow(deliveryId);
      const row = await repo.findDelivery(id, deliveryId);
      return { delivered: result.delivered, statusCode: result.statusCode, error: result.error, delivery: deliveryRow(row!) };
    },

    async deliveries(id: string): Promise<PluginDeliveryRow[]> {
      await existing(id);
      return (await repo.deliveries(id, 100)).map(deliveryRow);
    },

    // Skicka igen: a failed delivery starts over.
    async retryDelivery(id: string, deliveryId: string): Promise<PluginDeliveryRow> {
      await existing(id);
      if (!(await repo.findDelivery(id, deliveryId))) throw new PluginDeliveryNotFoundError(deliveryId);
      if (!(await repo.retryDelivery(id, deliveryId, now()))) throw new PluginDeliveryNotRetryableError();
      pluginEvents.kick();
      return deliveryRow((await repo.findDelivery(id, deliveryId))!);
    },

    // Avinstallera: the plugin and its outbox rows go, the technical user is
    // deactivated (never deleted) and the key stops working at once.
    async uninstall(id: string, userId: string | null): Promise<void> {
      const removed = await repo.uninstall(id);
      if (!removed) throw new PluginNotFoundError(id);
      pluginEvents.invalidate();
      await audit.log({
        entityType: "plugin",
        entityId: removed.key,
        action: "plugin_uninstalled",
        detail: { name: removed.name, baseUrl: removed.baseUrl },
        userId,
      });
    },

    // GET /plugin-ui — the active plugins' pages and tabs this user may see.
    // A page needs the user to open its module; a tab needs the user to open
    // the card's module AND the plugin to hold that permission.
    async ui(viewer: PluginViewer): Promise<PluginUi> {
      const out: PluginUi = { pages: [], tabs: [] };
      for (const found of await repo.listActive()) {
        const { plugin } = found;
        const manifest = plugin.manifest as PluginManifest;
        const pluginPermissions = effectivePermissions("user", found.groupPermissions);
        const owner = { pluginId: plugin.id, pluginKey: plugin.key, pluginName: plugin.name };
        for (const page of manifest.pages) {
          if (satisfiesRule(viewer, [page.module])) {
            out.pages.push({ ...owner, key: page.key, title: page.title, description: page.description, module: page.module });
          }
        }
        for (const tab of manifest.tabs) {
          const permission = PLUGIN_TAB_PERMISSION[tab.on];
          if (satisfiesRule(viewer, [permission]) && pluginPermissions.includes(permission)) {
            out.tabs.push({ ...owner, key: tab.key, title: tab.title, on: tab.on });
          }
        }
      }
      return out;
    },

    // POST /plugins/:id/context — the short-lived token an embedded page
    // gets: who is looking, with what rights, at which post. Signed with the
    // webhook secret; it gives the plugin no API rights.
    async context(id: string, input: PluginContextInput, viewer: PluginViewer): Promise<PluginContextResponse> {
      const found = await repo.get(id);
      if (!found || found.plugin.status !== "active") throw new PluginNotFoundError(id);
      const { plugin } = found;
      const manifest = plugin.manifest as PluginManifest;
      let path: string;
      let entity: PluginContextClaims["entity"];
      if ("page" in input) {
        const page = manifest.pages.find((p) => p.key === input.page);
        if (!page) throw new PluginNotFoundError(id);
        if (!satisfiesRule(viewer, [page.module])) throw new PluginAccessDeniedError();
        path = page.path;
      } else {
        const tab = manifest.tabs.find((t) => t.key === input.tab);
        if (!tab) throw new PluginNotFoundError(id);
        const permission = PLUGIN_TAB_PERMISSION[tab.on];
        if (!satisfiesRule(viewer, [permission]) || !effectivePermissions("user", found.groupPermissions).includes(permission)) {
          throw new PluginAccessDeniedError();
        }
        path = tab.path;
        entity = { type: tab.on, id: input.entityId };
      }
      const issuedAt = Math.floor(now().getTime() / 1000);
      const claims: PluginContextClaims = {
        iss: (await settings.publicBaseUrl()) || "nav",
        aud: plugin.key,
        sub: viewer.id,
        name: viewer.name,
        permissions: viewer.permissions,
        readOnly: viewer.readOnly,
        ...(entity ? { entity } : {}),
        theme: await settings.themeFor(viewer.id),
        iat: issuedAt,
        exp: issuedAt + CONTEXT_TOKEN_SECONDS,
      };
      const token = jwt.sign(claims, plugin.webhookSecret, { algorithm: "HS256", noTimestamp: true });
      return {
        token,
        url: contextUrl(plugin.baseUrl, path, token),
        origin: pluginOrigin(plugin.baseUrl)!,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      };
    },
  };
}

export type PluginsService = ReturnType<typeof createPluginsService>;
