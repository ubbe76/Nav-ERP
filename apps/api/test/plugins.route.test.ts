import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, sql } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { auditLog, db, permissionGroups, pluginDeliveries, plugins, systemSettings, users } from "@navet/db";
import { buildApp } from "../src/app.js";
import { verifyWebhookSignature } from "../src/modules/system/service/plugin-webhook.js";
import { createPluginsRepository } from "../src/modules/system/repository/plugins.repository.js";
import { pluginEvents } from "../src/modules/system/service/plugin-events.js";

// Tillägg through the real app: System → Tillägg (preview, install, change,
// keys, test event, deliveries, uninstall), the plugin's API key as its
// technical user (group, Endast läsning, forbidden routes, cookie + key),
// GET /plugin-ui, the context token, GET /plugin-kit.css and the alert.
// The plugin is a real HTTP server on 127.0.0.1 serving its manifest and
// receiving the test event.

const TRUNCATE = sql`TRUNCATE plugin_deliveries, plugin_events, plugins, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'plg-%' OR code LIKE 'TST%'`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let admin: string;
let server: Server;
let baseUrl: string;
// What the fake plugin answers and what it received.
let webhookStatus = 200;
let manifestBody: string;
const received: { path: string; headers: IncomingMessage["headers"]; body: string }[] = [];

const manifest = (extra: Record<string, unknown> = {}) => ({
  format: "nav-plugin",
  version: 1,
  key: "lagerstatistik",
  name: "Lagerstatistik",
  description: "Omsättningshastighet och inkuranta artiklar.",
  author: "Exempel AB",
  permissions: ["lager", "artiklar"],
  readOnly: true,
  webhook: { path: "/nav/webhook", events: ["article.created", "article.updated"] },
  pages: [{ key: "oversikt", title: "Lagerstatistik", description: "Omsättning per artikel.", module: "lager", path: "/nav/oversikt" }],
  tabs: [
    { key: "omsattning", title: "Omsättning", on: "article", path: "/nav/artikel" },
    { key: "kund", title: "Kundflik", on: "customer", path: "/nav/kund" },
  ],
  ...extra,
});

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

const call = (method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers, ...(payload === undefined ? {} : { payload: payload as never }) });
const asAdmin = (method: string, url: string, payload?: unknown) => call(method, url, { cookie: admin }, payload);
const asKey = (key: string, method: string, url: string, payload?: unknown) => call(method, url, { authorization: `Bearer ${key}` }, payload);

async function login(email: string) {
  return cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } }));
}

async function addUser(email: string, permissions: string[], extra: Record<string, unknown> = {}) {
  const group = await asAdmin("POST", "/permission-groups", { code: `TST${Math.random().toString(36).slice(2, 8)}`, name: email, permissions });
  expect(group.statusCode).toBe(201);
  const res = await asAdmin("POST", "/auth/users", { email, password: PASSWORD, name: email, role: "user", permissionGroupId: group.json().id, ...extra });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, cookie: await login(email) };
}

async function install(extra: Record<string, unknown> = {}, body: Record<string, unknown> = {}) {
  const res = await asAdmin("POST", "/plugins", { baseUrl, manifest: manifest(extra), permissions: ["lager", "artiklar"], readOnly: false, ...body });
  expect(res.statusCode).toBe(201);
  return res.json() as { plugin: { id: string; userId: string; permissionGroupId: string }; apiKey: string; webhookSecret: string };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.url === "/nav-plugin.json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(manifestBody);
      }
      received.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(webhookStatus);
      res.end("a body Nav never reads");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.delete(systemSettings).where(eq(systemSettings.key, "public_base_url"));
  pluginEvents.invalidate();
  received.length = 0;
  webhookStatus = 200;
  manifestBody = JSON.stringify(manifest());
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  admin = await login("admin@example.com");
});

afterAll(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

describe("System → Tillägg: preview and install", () => {
  it("is admin only (GET /plugin-ui and the context excepted)", async () => {
    const user = await addUser("user@example.com", ["artiklar", "lager"]);
    for (const [method, url] of [
      ["GET", "/plugins"],
      ["POST", "/plugins/preview"],
      ["POST", "/plugins"],
    ] as const) {
      expect({ url, status: (await call(method, url, { cookie: user.cookie }, method === "GET" ? undefined : { baseUrl })).statusCode }).toEqual({ url, status: 403 });
    }
    expect((await call("GET", "/plugin-ui", { cookie: user.cookie })).statusCode).toBe(200);
  });

  it("previews by fetching <baseUrl>/nav-plugin.json, saving nothing", async () => {
    const res = await asAdmin("POST", "/plugins/preview", { baseUrl: `${baseUrl}/` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, baseUrl, keyTaken: false, errors: [], manifest: { key: "lagerstatistik", name: "Lagerstatistik" } });
    expect(await db.select().from(plugins)).toEqual([]);
  });

  it("previews an uploaded manifest with its errors and warnings", async () => {
    const res = await asAdmin("POST", "/plugins/preview", { manifest: manifest({ version: 2 }) });
    expect(res.json()).toMatchObject({ ok: false, manifest: null, errors: ["Tillägget kräver en nyare Nav (manifestversion 2)."] });
    const warned = await asAdmin("POST", "/plugins/preview", { manifest: manifest({ color: "red" }) });
    expect(warned.json()).toMatchObject({ ok: true, warnings: ["Okänt fält color ignoreras."] });
  });

  it("answers 502 plugin-manifest-unreachable when the address does not answer with a manifest", async () => {
    manifestBody = "not json";
    expect((await asAdmin("POST", "/plugins/preview", { baseUrl })).json().code).toBe("plugin-manifest-unreachable");
    manifestBody = "x".repeat(70 * 1024);
    const tooBig = await asAdmin("POST", "/plugins/preview", { baseUrl });
    expect(tooBig.statusCode).toBe(502);
    expect(tooBig.json().error).toMatch(/64 kB/);
    // A closed port.
    const closed = await asAdmin("POST", "/plugins/preview", { baseUrl: "http://127.0.0.1:9" });
    expect(closed.statusCode).toBe(502);
    expect(closed.json().error).toBe("Manifestet kunde inte hämtas: kunde inte ansluta");
  });

  it("refuses Nav's own origin (400 plugin-same-origin) and an address that is not http(s)", async () => {
    const web = await asAdmin("POST", "/plugins/preview", { baseUrl: "http://localhost:3000/tillagg" });
    expect(web.statusCode).toBe(400);
    expect(web.json().code).toBe("plugin-same-origin");
    await asAdmin("PATCH", "/settings", { publicBaseUrl: "https://nav.example.com" });
    expect((await asAdmin("POST", "/plugins", { baseUrl: "https://nav.example.com", manifest: manifest(), permissions: [], readOnly: false })).json().code).toBe(
      "plugin-same-origin"
    );
    expect((await asAdmin("POST", "/plugins/preview", { baseUrl: "file:///etc/passwd" })).json().code).toBe("plugin-invalid-address");
  });

  it("installs in one go: group, technical user and plugin; the key and secret are answered once", async () => {
    const { plugin, apiKey, webhookSecret } = await install();
    expect(apiKey).toMatch(/^nav_plg_lagerstatistik_[A-Za-z0-9]{32}$/);
    expect(webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(plugin).toMatchObject({ key: "lagerstatistik", name: "Lagerstatistik", status: "active", baseUrl, permissions: ["artiklar", "lager"], effectivePermissions: ["artiklar", "lager", "artikeloversikt"], readOnly: false, apiKeyPrefix: apiKey.slice(0, 12) });

    const [user] = await db.select().from(users).where(eq(users.id, plugin.userId));
    expect(user).toMatchObject({ kind: "plugin", role: "user", name: "Tillägg: Lagerstatistik", email: "lagerstatistik@tillagg.invalid", active: true });
    const [group] = await db.select().from(permissionGroups).where(eq(permissionGroups.id, plugin.permissionGroupId));
    expect(group).toMatchObject({ code: "plg-lagerstatistik", name: "Tillägg: Lagerstatistik", permissions: ["lager", "artiklar"] });
    const [stored] = await db.select().from(plugins);
    expect(stored!.apiKeyHash).not.toContain(apiKey);

    const detail = await asAdmin("GET", `/plugins/${plugin.id}`);
    expect(detail.json()).not.toHaveProperty("webhookSecret");
    expect(detail.json()).not.toHaveProperty("apiKeyHash");
    expect((await asAdmin("GET", "/plugins")).json()).toMatchObject([{ id: plugin.id, name: "Lagerstatistik", status: "active", failedLast7Days: 0, lastDeliveredAt: null }]);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, "plugin_installed"));
    expect(entry).toMatchObject({ entityType: "plugin", entityId: "lagerstatistik" });
  });

  it("answers 409 plugin-key-taken for a second install of the same key and 400 for an invalid manifest", async () => {
    await install();
    const again = await asAdmin("POST", "/plugins", { baseUrl, manifest: manifest(), permissions: [], readOnly: false });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("plugin-key-taken");
    const bad = await asAdmin("POST", "/plugins", { baseUrl, manifest: manifest({ key: "Ogiltig" }), permissions: [], readOnly: false });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "plugin-manifest-invalid", errors: [expect.stringMatching(/^Nyckeln/)] });
  });

  it("answers 409 plugin-key-taken (never 500) to the loser of two simultaneous installs of the same key", async () => {
    const body = { baseUrl, manifest: manifest(), permissions: ["lager"], readOnly: false };
    const results = await Promise.all([asAdmin("POST", "/plugins", body), asAdmin("POST", "/plugins", body), asAdmin("POST", "/plugins", body)]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 409)).toHaveLength(2);
    expect(codes.filter((c) => c !== 409).every((c) => c >= 200 && c < 300)).toBe(true);
    for (const r of results.filter((r) => r.statusCode === 409)) expect(r.json().code).toBe("plugin-key-taken");
    expect(await db.select().from(plugins)).toHaveLength(1);
  });

  it("leaves nothing behind when the install transaction fails", async () => {
    // The plugin insert (last in the transaction) collides on the key: the
    // group and the user written before it must go too.
    const { plugin } = await install();
    const before = { users: (await db.select().from(users)).length, groups: (await db.select().from(permissionGroups)).length };
    const [stored] = await db.select().from(plugins).where(eq(plugins.id, plugin.id));
    await expect(
      createPluginsRepository(db).install(
        {
          key: "lagerstatistik",
          name: "Dubblett",
          baseUrl,
          manifest: stored!.manifest as never,
          permissions: [],
          readOnly: false,
          apiKeyHash: "x".repeat(64),
          apiKeyPrefix: "nav_plg_x",
          webhookSecret: "y",
          installedBy: null,
        },
        "!plugin"
      )
    ).rejects.toThrow();
    expect((await db.select().from(users)).length).toBe(before.users);
    expect((await db.select().from(permissionGroups)).length).toBe(before.groups);
  });
});

describe("the API key", () => {
  it("acts as the plugin's technical user under its group", async () => {
    const { apiKey } = await install();
    const me = await asKey(apiKey, "GET", "/articles");
    expect(me.statusCode).toBe(200);
    // Artiklar is granted: the plugin may create an article, and the audit
    // trail would show its user.
    const created = await asKey(apiKey, "POST", "/articles", { articleNumber: "PLG-1", name: "Från tillägget", type: "purchased", unit: "st", active: true });
    expect(created.statusCode).toBe(201);
    // Försäljning is not: 403 on a write outside the group.
    const customer = await asKey(apiKey, "POST", "/customers", { name: "Kund AB", active: true });
    expect(customer.statusCode).toBe(403);
    // Admin routes stay closed.
    expect((await asKey(apiKey, "GET", "/permission-groups")).statusCode).toBe(403);
  });

  it("is refused when wrong, after Ny API-nyckel, while paused and once uninstalled", async () => {
    const { plugin, apiKey } = await install();
    expect((await asKey(`${apiKey}x`, "GET", "/articles")).statusCode).toBe(401);
    expect((await asKey("nav_plg_okand_abc", "GET", "/articles")).statusCode).toBe(401);

    const rotated = await asAdmin("POST", `/plugins/${plugin.id}/rotate-key`);
    expect(rotated.statusCode).toBe(200);
    const newKey = rotated.json().apiKey as string;
    expect((await asKey(apiKey, "GET", "/articles")).statusCode).toBe(401);
    expect((await asKey(newKey, "GET", "/articles")).statusCode).toBe(200);

    expect((await asAdmin("PATCH", `/plugins/${plugin.id}`, { status: "paused" })).json().status).toBe("paused");
    expect((await asKey(newKey, "GET", "/articles")).statusCode).toBe(401);
    await asAdmin("PATCH", `/plugins/${plugin.id}`, { status: "active" });
    expect((await asKey(newKey, "GET", "/articles")).statusCode).toBe(200);

    // A deactivated technical user (by hand) stops the key too.
    await db.update(users).set({ active: false }).where(eq(users.id, plugin.userId));
    expect((await asKey(newKey, "GET", "/articles")).statusCode).toBe(401);
    await db.update(users).set({ active: true }).where(eq(users.id, plugin.userId));

    expect((await asAdmin("DELETE", `/plugins/${plugin.id}`)).statusCode).toBe(204);
    expect((await asKey(newKey, "GET", "/articles")).statusCode).toBe(401);
  });

  it("is refused with a session cookie in the same request (400) and on /auth, /me, /oauth and /plugins (403)", async () => {
    const { plugin, apiKey } = await install();
    const both = await call("GET", "/articles", { authorization: `Bearer ${apiKey}`, cookie: admin });
    expect(both.statusCode).toBe(400);
    expect(both.json().code).toBe("plugin-key-with-session");
    for (const [method, url] of [
      ["GET", "/auth/me"],
      ["GET", "/auth/users"],
      ["GET", "/me/settings"],
      ["GET", "/plugins"],
      ["GET", `/plugins/${plugin.id}`],
      ["POST", `/plugins/${plugin.id}/rotate-key`],
    ] as const) {
      const res = await asKey(apiKey, method, url);
      expect({ url, status: res.statusCode, code: res.json().code }).toEqual({ url, status: 403, code: "plugin-route-forbidden" });
    }
  });

  it("is held to Endast läsning", async () => {
    const { plugin, apiKey } = await install({}, { readOnly: true });
    expect((await asAdmin("GET", `/plugins/${plugin.id}`)).json().readOnly).toBe(true);
    expect((await asKey(apiKey, "GET", "/articles")).statusCode).toBe(200);
    const write = await asKey(apiKey, "POST", "/articles", { articleNumber: "PLG-2", name: "X", type: "purchased", unit: "st", active: true });
    expect(write.statusCode).toBe(403);
    expect(write.json().code).toBe("read-only-account");
    await asAdmin("PATCH", `/plugins/${plugin.id}`, { readOnly: false });
    expect((await asKey(apiKey, "POST", "/articles", { articleNumber: "PLG-2", name: "X", type: "purchased", unit: "st", active: true })).statusCode).toBe(201);
  });

  it("belongs to a user that never logs in, is not edited in the user register and whose group can't be removed there", async () => {
    const { plugin } = await install();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "lagerstatistik@tillagg.invalid", password: PASSWORD } });
    expect(login.statusCode).toBe(401);
    const listed = (await asAdmin("GET", "/auth/users")).json() as { id: string; kind: string }[];
    expect(listed.find((u) => u.id === plugin.userId)?.kind).toBe("plugin");
    expect(listed.find((u) => u.kind === "person")).toBeDefined();
    for (const [method, url] of [
      ["PATCH", `/auth/users/${plugin.userId}`],
      ["DELETE", `/auth/users/${plugin.userId}`],
    ] as const) {
      const res = await asAdmin(method, url, method === "PATCH" ? { name: "Ny" } : undefined);
      expect({ url, status: res.statusCode, code: res.json().code }).toEqual({ url, status: 409, code: "plugin-user-managed" });
    }
    const removeGroup = await asAdmin("DELETE", `/permission-groups/${plugin.permissionGroupId}`);
    expect(removeGroup.statusCode).toBe(409);
    expect(removeGroup.json().code).toBe("permission-group-owned-by-plugin");
    const groups = (await asAdmin("GET", "/permission-groups")).json() as { id: string; pluginId: string | null }[];
    expect(groups.find((g) => g.id === plugin.permissionGroupId)?.pluginId).toBe(plugin.id);
    const intoPluginGroup = await asAdmin("POST", "/auth/users", {
      email: "person@example.com",
      password: PASSWORD,
      name: "Person",
      role: "user",
      permissionGroupId: plugin.permissionGroupId,
    });
    expect(intoPluginGroup.json().code).toBe("permission-group-owned-by-plugin");
  });
});

describe("changing and removing a plugin", () => {
  it("never grants a newly requested permission through a new manifest; only `permissions` changes the group", async () => {
    const { plugin } = await install();
    const updated = await asAdmin("PATCH", `/plugins/${plugin.id}`, { manifest: manifest({ name: "Lagerstatistik 2", permissions: ["lager", "artiklar", "ekonomi"] }) });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Lagerstatistik 2", permissions: ["artiklar", "lager"] });
    expect(updated.json().manifest.permissions).toEqual(["lager", "artiklar", "ekonomi"]);
    const [user] = await db.select().from(users).where(eq(users.id, plugin.userId));
    expect(user!.name).toBe("Tillägg: Lagerstatistik 2");

    const granted = await asAdmin("PATCH", `/plugins/${plugin.id}`, { permissions: ["lager", "ekonomi"] });
    expect(granted.json().permissions).toEqual(["lager", "ekonomi"]);
    const [log] = await db.select().from(auditLog).where(eq(auditLog.action, "plugin_updated")).orderBy(sql`${auditLog.createdAt} desc`).limit(1);
    expect(log!.detail).toMatchObject({ changedFields: ["permissions"] });

    const otherKey = await asAdmin("PATCH", `/plugins/${plugin.id}`, { manifest: manifest({ key: "annan" }) });
    expect(otherKey.statusCode).toBe(400);
    expect(otherKey.json().errors).toEqual(["Nyckeln kan inte ändras (installerat som lagerstatistik)."]);
  });

  it("uninstalls: plugin, deliveries and group go, the technical user is soft-deleted — gone from the register, still named in the log", async () => {
    const { plugin } = await install();
    await pluginEvents.emit(db, { type: "article.created", entityId: plugin.id, entityNumber: "1" });
    // Something the plugin did, in the event log.
    await db.insert(auditLog).values({ entityType: "article", entityId: "1001", action: "created", userId: plugin.userId });
    expect(await db.select().from(pluginDeliveries)).toHaveLength(1);
    expect((await asAdmin("DELETE", `/plugins/${plugin.id}`)).statusCode).toBe(204);
    expect(await db.select().from(plugins)).toEqual([]);
    expect(await db.select().from(pluginDeliveries)).toEqual([]);
    expect(await db.execute(sql`SELECT 1 FROM plugin_events`)).toHaveLength(0);
    expect(await db.select().from(permissionGroups).where(eq(permissionGroups.id, plugin.permissionGroupId))).toEqual([]);
    const [user] = await db.select().from(users).where(eq(users.id, plugin.userId));
    expect(user).toMatchObject({ active: false, permissionGroupId: null });
    expect(user!.deletedAt).not.toBeNull();
    expect((await asAdmin("GET", `/plugins/${plugin.id}`)).statusCode).toBe(404);
    // Gone from System → Användare …
    const listed = (await asAdmin("GET", "/auth/users")).json() as { id: string }[];
    expect(listed.map((u) => u.id)).not.toContain(plugin.userId);
    // … but the log still says who did it.
    const log = (await asAdmin("GET", "/audit-log?entityType=article")).json() as { rows: { userName: string | null }[] };
    expect(log.rows.map((r) => r.userName)).toEqual(["Tillägg: Lagerstatistik"]);
    // The same key can be installed again, with the same e-mail (freed by the soft delete).
    const again = await install();
    expect(again.plugin.userId).not.toBe(plugin.userId);
    const [newUser] = await db.select().from(users).where(eq(users.id, again.plugin.userId));
    expect(newUser!.email).toBe(user!.email);
    const actions = (await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityType, "plugin"))).map((r) => r.action);
    expect(actions).toContain("plugin_uninstalled");
  });
});

describe("Skicka testhändelse and Leveranser", () => {
  it("delivers plugin.test at once with a valid signature and lists it", async () => {
    const { plugin, webhookSecret } = await install();
    const res = await asAdmin("POST", `/plugins/${plugin.id}/test-event`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: true, statusCode: 200, error: null, delivery: { status: "delivered", eventType: "plugin.test", attempts: 1 } });
    expect(received).toHaveLength(1);
    const [hit] = received;
    expect(hit!.path).toBe("/nav/webhook");
    expect(hit!.headers["nav-event-type"]).toBe("plugin.test");
    expect(verifyWebhookSignature(webhookSecret, hit!.body, String(hit!.headers["nav-signature"]), new Date())).toBe(true);
    expect(JSON.parse(hit!.body)).toMatchObject({ type: "plugin.test", plugin: "lagerstatistik", data: { id: plugin.id, number: "lagerstatistik" } });

    const list = await asAdmin("GET", `/plugins/${plugin.id}/deliveries`);
    expect(list.json()).toMatchObject([{ eventType: "plugin.test", status: "delivered", lastStatusCode: 200 }]);
  });

  it("shows a failed test, lets Skicka igen restart a failed delivery, and raises the alert for a delivery that failed for good", async () => {
    const { plugin } = await install();
    webhookStatus = 500;
    const res = await asAdmin("POST", `/plugins/${plugin.id}/test-event`);
    expect(res.json()).toMatchObject({ delivered: false, statusCode: 500, error: "Svarade 500", delivery: { status: "failed" } });
    type Alerts = { groups: { kind: string; count: number; items: { primary: string; href: string }[] }[] };
    const alertGroup = async () => ((await asAdmin("GET", "/alerts")).json() as Alerts).groups.find((g) => g.kind === "plugin_delivery_failed");
    // The administrator saw the failed test: no alert for it.
    expect((await alertGroup())?.count ?? 0).toBe(0);
    expect((await asAdmin("GET", "/plugins")).json()[0].failedLast7Days).toBe(1);

    // A real event whose delivery failed for good raises it.
    await pluginEvents.emit(db, { type: "article.created", entityId: plugin.id, entityNumber: "1" });
    await db
      .update(pluginDeliveries)
      .set({ status: "failed", attempts: 7, lastAttemptAt: new Date(), lastStatusCode: 500, lastError: "Svarade 500", nextAttemptAt: null })
      .where(eq(pluginDeliveries.status, "pending"));
    expect(await alertGroup()).toMatchObject({ count: 1, items: [{ primary: "Lagerstatistik", href: `/system/tillagg/${plugin.id}` }] });

    const deliveryId = res.json().delivery.id as string;
    const retried = await asAdmin("POST", `/plugins/${plugin.id}/deliveries/${deliveryId}/retry`);
    expect(retried.json()).toMatchObject({ status: "pending", attempts: 0 });
    const twice = await asAdmin("POST", `/plugins/${plugin.id}/deliveries/${deliveryId}/retry`);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe("plugin-delivery-not-retryable");

    // A later successful delivery clears the alert.
    webhookStatus = 200;
    await asAdmin("POST", `/plugins/${plugin.id}/test-event`);
    const after = (await asAdmin("GET", "/alerts")).json() as { groups: { kind: string; count: number }[] };
    expect(after.groups.find((g) => g.kind === "plugin_delivery_failed")?.count).toBe(0);
  });
});

describe("GET /plugin-ui and the context token", () => {
  it("shows a page to users who may open its module, and a tab only where the plugin holds the card's permission", async () => {
    const { plugin } = await install();
    const lager = await addUser("lager@example.com", ["lager", "artiklar", "forsaljning"]);
    const ui = (await call("GET", "/plugin-ui", { cookie: lager.cookie })).json();
    expect(ui.pages).toEqual([{ pluginId: plugin.id, pluginKey: "lagerstatistik", pluginName: "Lagerstatistik", key: "oversikt", title: "Lagerstatistik", description: "Omsättning per artikel.", module: "lager" }]);
    // The customer tab needs Försäljning in the PLUGIN's group too.
    expect(ui.tabs).toEqual([{ pluginId: plugin.id, pluginKey: "lagerstatistik", pluginName: "Lagerstatistik", key: "omsattning", title: "Omsättning", on: "article" }]);

    const inkop = await addUser("inkop@example.com", ["inkop"]);
    expect((await call("GET", "/plugin-ui", { cookie: inkop.cookie })).json()).toEqual({ pages: [], tabs: [] });

    await asAdmin("PATCH", `/plugins/${plugin.id}`, { status: "paused" });
    expect((await call("GET", "/plugin-ui", { cookie: lager.cookie })).json()).toEqual({ pages: [], tabs: [] });
  });

  it("signs a 5-minute token with the key derived from the webhook secret, carrying who looks, their rights and the post", async () => {
    const { plugin, webhookSecret } = await install();
    await asAdmin("PATCH", "/settings", { publicBaseUrl: "https://nav.example.com" });
    const lager = await addUser("lager@example.com", ["lager", "artiklar"], { readOnly: true });
    await db.execute(sql`INSERT INTO user_settings (user_id, key, value) VALUES (${lager.id}, 'theme', 'dracula')`);

    const page = await call("POST", `/plugins/${plugin.id}/context`, { cookie: lager.cookie }, { page: "oversikt" });
    expect(page.statusCode).toBe(200);
    const { token, url, origin } = page.json();
    expect(url).toBe(`${baseUrl}/nav/oversikt?nav_context=${encodeURIComponent(token)}`);
    expect(origin).toBe(baseUrl);
    // HMAC-SHA256(secret, "nav-context") as lowercase hex is the HS256 key —
    // the secret itself (the webhook signature's key) is not.
    const contextKey = createHmac("sha256", webhookSecret).update("nav-context").digest("hex");
    expect(() => jwt.verify(token, webhookSecret, { algorithms: ["HS256"] })).toThrow();
    const claims = jwt.verify(token, contextKey, { algorithms: ["HS256"], audience: "lagerstatistik", issuer: "https://nav.example.com" }) as Record<string, unknown>;
    expect(claims).toMatchObject({ sub: lager.id, name: "lager@example.com", readOnly: true, theme: "dracula", permissions: ["artiklar", "lager", "artikeloversikt"] });
    expect(claims).not.toHaveProperty("entity");
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
    expect(() => jwt.verify(token, "another secret")).toThrow();

    const articleId = "44444444-4444-4444-8444-444444444444";
    const tab = await call("POST", `/plugins/${plugin.id}/context`, { cookie: lager.cookie }, { tab: "omsattning", entityId: articleId });
    expect(jwt.decode(tab.json().token)).toMatchObject({ entity: { type: "article", id: articleId } });
    // The token gives the plugin no API rights.
    expect((await call("GET", "/articles", { authorization: `Bearer ${tab.json().token}` })).statusCode).toBe(401);
  });

  it("refuses a page or tab the user (or the plugin) may not see", async () => {
    const { plugin } = await install();
    const inkop = await addUser("inkop@example.com", ["inkop", "forsaljning"]);
    const page = await call("POST", `/plugins/${plugin.id}/context`, { cookie: inkop.cookie }, { page: "oversikt" });
    expect(page.statusCode).toBe(403);
    expect(page.json().code).toBe("plugin-access-denied");
    // The user has Försäljning, the plugin does not.
    const tab = await call("POST", `/plugins/${plugin.id}/context`, { cookie: inkop.cookie }, { tab: "kund", entityId: plugin.id });
    expect(tab.statusCode).toBe(403);
    const unknown = await call("POST", `/plugins/${plugin.id}/context`, { cookie: inkop.cookie }, { page: "finns-inte" });
    expect(unknown.json().code).toBe("plugin-not-found");
  });
});

describe("GET /plugin-kit.css", () => {
  it("is public CSS with every theme and the base style", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/plugin-kit.css" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toContain(':root[data-theme="dark"]');
    expect(res.body).toContain(".nav-button");
  });
});
