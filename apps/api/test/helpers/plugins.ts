import { db, permissionGroups, plugins, users } from "@navet/db";
import { validatePluginManifest, type Permission, type PluginEventType, type PluginManifest } from "@navet/shared";
import { sha256Hex } from "../../src/modules/auth/service/auth.service.js";
import { pluginEvents } from "../../src/modules/system/service/plugin-events.js";
import { newPluginApiKey, newWebhookSecret } from "../../src/modules/system/service/plugin-webhook.js";

// Tillägg: a plugin written straight into the database (group, technical
// user, plugin) — for the suites that test the outbox, the dispatcher and
// the key auth without going through the install route. The subscription
// cache is invalidated, as the service does after every plugin write.

export interface TestPlugin {
  id: string;
  key: string;
  userId: string;
  groupId: string;
  apiKey: string;
  secret: string;
  baseUrl: string;
}

export function testManifest(key: string, extra: Partial<Record<keyof PluginManifest, unknown>> = {}): PluginManifest {
  const result = validatePluginManifest({ format: "nav-plugin", version: 1, key, name: `Test ${key}`, ...extra });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.manifest;
}

export async function insertTestPlugin(opts: {
  key: string;
  events?: PluginEventType[];
  permissions?: Permission[];
  readOnly?: boolean;
  status?: "active" | "paused";
  baseUrl?: string;
  manifest?: Partial<Record<keyof PluginManifest, unknown>>;
}): Promise<TestPlugin> {
  const baseUrl = opts.baseUrl ?? `http://plugin-${opts.key}.example`;
  const manifest = testManifest(opts.key, {
    webhook: { path: "/nav/webhook", events: opts.events ?? [] },
    ...opts.manifest,
  });
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `plg-${opts.key}`.slice(0, 20), name: `Tillägg: ${manifest.name}`, permissions: opts.permissions ?? [] })
    .returning();
  const [user] = await db
    .insert(users)
    .values({
      email: `${opts.key}@tillagg.invalid`,
      passwordHash: "!plugin",
      name: `Tillägg: ${manifest.name}`,
      role: "user",
      kind: "plugin",
      permissionGroupId: group!.id,
      readOnly: opts.readOnly ?? false,
    })
    .returning();
  const apiKey = newPluginApiKey(opts.key);
  const secret = newWebhookSecret();
  const [plugin] = await db
    .insert(plugins)
    .values({
      key: opts.key,
      name: manifest.name,
      baseUrl,
      manifest,
      userId: user!.id,
      permissionGroupId: group!.id,
      apiKeyHash: sha256Hex(apiKey),
      apiKeyPrefix: apiKey.slice(0, 12),
      webhookSecret: secret,
      status: opts.status ?? "active",
    })
    .returning();
  pluginEvents.invalidate();
  return { id: plugin!.id, key: opts.key, userId: user!.id, groupId: group!.id, apiKey, secret, baseUrl };
}
