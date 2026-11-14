import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createUserSettingsRepository } from "../src/modules/auth/repository/user-settings.repository.js";
import { createUserSettingsService } from "../src/modules/auth/service/user-settings.service.js";
import { authRoutes } from "../src/modules/auth/routes/auth.routes.js";
import { createLoginThrottle } from "../src/modules/auth/service/login-throttle.js";
import { SESSION_COOKIE } from "../src/modules/auth/middleware/auth.middleware.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Etapp A ("Rader per sida"): route-level coverage for GET/PATCH /me/settings
// — auth requirement, defaults, upsert and validation, exercised through a
// real register()/login() so the 401 case is a genuine unauthenticated
// request rather than a stubbed req.user (unlike most route-test siblings,
// which inject req.user directly — see vat-report.route.test.ts).

const authRepo = createAuthRepository(db);
const auditRepository = createAuditRepository(db);
const authService = createAuthService(authRepo, "test-secret", auditRepository);
const settingsRepo = createUserSettingsRepository(db);
const settingsService = createUserSettingsService(settingsRepo);

const TRUNCATE = sql`TRUNCATE user_settings, users, audit_log CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

function buildApp() {
  const app = Fastify();
  // Bare-app equivalent of app.ts's global ZodError branch — updateUserSettingsSchema.parse()
  // throws inside the route handler, same as elsewhere, so it needs this mapping to see 400s
  // instead of Fastify's default 500 (see vat-report.route.test.ts for the same pattern).
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.register(fastifyCookie);
  app.register(authRoutes, {
    service: authService,
    settings: settingsService,
    throttles: { account: createLoginThrottle(), ip: null },
  });
  return app;
}

async function loginAs(app: ReturnType<typeof buildApp>, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${cookie!.value}`;
}

// POST /auth/register only works for the very first user (it self-closes as
// soon as one exists) — the first call in a test bootstraps via the real
// route, every subsequent call creates the user through authService
// directly (mirrors what an admin creating additional users would do).
async function registerAndLogin(app: ReturnType<typeof buildApp>) {
  const email = `settings-${crypto.randomUUID()}@example.com`;
  const password = "correcthorsebattery";
  if ((await authRepo.count()) === 0) {
    await app.inject({ method: "POST", url: "/auth/register", payload: { email, password, name: "Testanvändare" } });
  } else {
    await authService.createUser({ email, password, name: "Testanvändare", role: "user" });
  }
  return loginAs(app, email, password);
}

describe("GET /me/settings", () => {
  it("401s without a session cookie", async () => {
    const app = buildApp();
    const res = await app.inject({ url: "/me/settings" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns the default list page size when nothing is set", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);

    const res = await app.inject({ url: "/me/settings", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ listPageSize: 50, hideOnboarding: false, alertDigest: false, alertDigestKinds: null, theme: null, favorites: [], favoritesFromGroup: true, favoritesInSidebar: true, overviewCards: null, density: "normal", listColumns: {}, documentTabs: true });
    await app.close();
  });
});

describe("PATCH /me/settings", () => {
  it("401s without a session cookie", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "PATCH", url: "/me/settings", payload: { listPageSize: 100 } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("upserts a value and GET reflects it afterwards", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: { cookie },
      payload: { listPageSize: 100 },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toEqual({ listPageSize: 100, hideOnboarding: false, alertDigest: false, alertDigestKinds: null, theme: null, favorites: [], favoritesFromGroup: true, favoritesInSidebar: true, overviewCards: null, density: "normal", listColumns: {}, documentTabs: true });

    const getRes = await app.inject({ url: "/me/settings", headers: { cookie } });
    expect(getRes.json()).toEqual({ listPageSize: 100, hideOnboarding: false, alertDigest: false, alertDigestKinds: null, theme: null, favorites: [], favoritesFromGroup: true, favoritesInSidebar: true, overviewCards: null, density: "normal", listColumns: {}, documentTabs: true });

    // Upsert, not insert-only: a second PATCH overwrites the first value
    // rather than erroring on the composite PK.
    const secondPatch = await app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: { cookie },
      payload: { listPageSize: 25 },
    });
    expect(secondPatch.statusCode).toBe(200);
    expect(secondPatch.json()).toEqual({ listPageSize: 25, hideOnboarding: false, alertDigest: false, alertDigestKinds: null, theme: null, favorites: [], favoritesFromGroup: true, favoritesInSidebar: true, overviewCards: null, density: "normal", listColumns: {}, documentTabs: true });
    await app.close();
  });

  it("400s on a disallowed page size", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);

    const res = await app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: { cookie },
      payload: { listPageSize: 999 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s on an unknown key", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);

    const res = await app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: { cookie },
      payload: { someUnknownSetting: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("stores hideOnboarding per user", async () => {
    const app = buildApp();
    const cookieA = await registerAndLogin(app);
    const cookieB = await registerAndLogin(app);

    const patch = await app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie: cookieA }, payload: { hideOnboarding: true } });
    expect(patch.json()).toEqual({ listPageSize: 50, hideOnboarding: true, alertDigest: false, alertDigestKinds: null, theme: null, favorites: [], favoritesFromGroup: true, favoritesInSidebar: true, overviewCards: null, density: "normal", listColumns: {}, documentTabs: true });
    const other = await app.inject({ url: "/me/settings", headers: { cookie: cookieB } });
    expect(other.json().hideOnboarding).toBe(false);
    await app.close();
  });

  it("stores the alert digest opt-in and its kinds, drops unknown kinds and 400s a bad kind", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);

    const on = await app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: { cookie },
      payload: { alertDigest: true, alertDigestKinds: ["purchase_needed", "stock_negative", "purchase_needed"] },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ alertDigest: true, alertDigestKinds: ["purchase_needed", "stock_negative"] });
    // null = every kind the user may see.
    const all = await app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { alertDigestKinds: null } });
    expect(all.json()).toMatchObject({ alertDigest: true, alertDigestKinds: null });
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json()).toMatchObject({ alertDigest: true, alertDigestKinds: null });

    const bad = await app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { alertDigestKinds: ["nope"] } });
    expect(bad.statusCode).toBe(400);

    // A kind that has since left the catalog is dropped on read, never surfaced.
    await settingsRepo.upsert((await authRepo.findByEmail((await app.inject({ url: "/auth/me", headers: { cookie } })).json().email))!.id, "alert_digest_kinds", JSON.stringify(["gone", "email_failed"]));
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json().alertDigestKinds).toEqual(["email_failed"]);
    await app.close();
  });

  it("replaces the favourites list in order, trims titles and 400s anything that isn't a path inside Nav", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    const patch = (favorites: unknown) =>
      app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { favorites } });

    const set = await patch([
      { href: "/forsaljning/ordrar", title: "Kundorder" },
      { href: "/forsaljning/ordrar?status=confirmed", title: "  Bekräftade kundordrar  " },
      { href: "/kunder/0b8f9c1e-1111-4a6e-9f00-000000000001", title: "Storköket AB" },
    ]);
    expect(set.statusCode).toBe(200);
    expect(set.json().favorites).toEqual([
      { href: "/forsaljning/ordrar", title: "Kundorder" },
      { href: "/forsaljning/ordrar?status=confirmed", title: "Bekräftade kundordrar" },
      { href: "/kunder/0b8f9c1e-1111-4a6e-9f00-000000000001", title: "Storköket AB" },
    ]);
    // The whole list is replaced — a reorder or a removal is just a new list.
    const reordered = await patch([{ href: "/kunder/0b8f9c1e-1111-4a6e-9f00-000000000001", title: "Storköket AB" }, { href: "/forsaljning/ordrar", title: "Kundorder" }]);
    expect(reordered.json().favorites.map((f: { href: string }) => f.href)).toEqual(["/kunder/0b8f9c1e-1111-4a6e-9f00-000000000001", "/forsaljning/ordrar"]);
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json().favorites).toHaveLength(2);
    expect((await patch([])).json().favorites).toEqual([]);

    for (const bad of [
      [{ href: "https://example.com", title: "Extern" }],
      [{ href: "//example.com/x", title: "Protokollrelativ" }],
      [{ href: "/\\example.com", title: "Snedstreck" }],
      [{ href: "javascript:alert(1)", title: "Skript" }],
      [{ href: "/lager saldon", title: "Mellanslag" }],
      [{ href: "/lager", title: "   " }],
      [{ href: "/lager", title: "x".repeat(61) }],
      [{ href: "/lager", title: "Lager", extra: true }],
      [{ href: "/lager", title: "Lager" }, { href: "/lager", title: "Lager igen" }],
      Array.from({ length: 21 }, (_, i) => ({ href: `/lager/${i}`, title: `Lager ${i}` })),
    ]) {
      const res = await patch(bad);
      expect([JSON.stringify(bad).slice(0, 60), res.statusCode]).toEqual([JSON.stringify(bad).slice(0, 60), 400]);
    }
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json().favorites).toEqual([]);
    await app.close();
  });

  it("reads a stored favourites list entry by entry, dropping what no longer passes", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    const me = (await app.inject({ url: "/auth/me", headers: { cookie } })).json();
    await settingsRepo.upsert(
      me.id,
      "favorites",
      JSON.stringify([
        { href: "/lager/saldon", title: "Lagersaldon" },
        { href: "//example.com", title: "Extern" },
        "skräp",
        { href: "/lager/saldon", title: "Dubblett" },
        { href: "/inkop/ordrar", title: "Inköpsorder" },
      ])
    );
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json().favorites).toEqual([
      { href: "/lager/saldon", title: "Lagersaldon" },
      { href: "/inkop/ordrar", title: "Inköpsorder" },
    ]);
    await settingsRepo.upsert(me.id, "favorites", "{inte json");
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json().favorites).toEqual([]);
    await app.close();
  });

  it("shows the favourites in the sidebar by default; favoritesInSidebar false hides them and is kept", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    const get = async () => (await app.inject({ url: "/me/settings", headers: { cookie } })).json().favoritesInSidebar;
    const patch = (favoritesInSidebar: unknown) =>
      app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { favoritesInSidebar } });
    expect(await get()).toBe(true);
    expect((await patch(false)).json().favoritesInSidebar).toBe(false);
    expect(await get()).toBe(false);
    expect((await patch(true)).json().favoritesInSidebar).toBe(true);
    expect((await patch("false")).statusCode).toBe(400);
    expect((await patch(null)).statusCode).toBe(400);
    await app.close();
  });

  it("stores the Översikt cards in order, null resets, 400s repeats and unknown keys, and reads a stored list without removed keys", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    const get = async () => (await app.inject({ url: "/me/settings", headers: { cookie } })).json().overviewCards;
    const patch = (overviewCards: unknown) =>
      app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { overviewCards } });

    expect(await get()).toBeNull();
    expect((await patch(["stock", "flow"])).json().overviewCards).toEqual(["stock", "flow"]);
    expect(await get()).toEqual(["stock", "flow"]);
    expect((await patch([])).json().overviewCards).toEqual([]);
    expect((await patch(["orders"])).statusCode).toBe(200);
    expect((await patch(null)).json().overviewCards).toBeNull();
    expect(await get()).toBeNull();

    await patch(["attention"]);
    for (const bad of [["flow", "flow"], ["flow", "weather"], "flow", ["flow", "attention", "orders", "stock", "flow"]]) {
      expect([JSON.stringify(bad), (await patch(bad)).statusCode]).toEqual([JSON.stringify(bad), 400]);
    }
    expect(await get()).toEqual(["attention"]);

    // A card removed in a later version: dropped on read, never fails it.
    const me = (await app.inject({ url: "/auth/me", headers: { cookie } })).json();
    await settingsRepo.upsert(me.id, "overview_cards", JSON.stringify(["gone", "orders", "orders", 3, "flow"]));
    expect(await get()).toEqual(["orders", "flow"]);
    await settingsRepo.upsert(me.id, "overview_cards", "{inte json");
    expect(await get()).toBeNull();
    await app.close();
  });

  // Nav som program, punkt 6.
  it("stores Täthet and refuses an unknown density", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    const patch = (density: unknown) =>
      app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { density } });
    expect((await patch("compact")).json().density).toBe("compact");
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json().density).toBe("compact");
    expect((await patch("tight")).statusCode).toBe(400);
    expect((await patch("normal")).json().density).toBe("normal");
    await app.close();
  });

  it("merges Kolumner per list, resets a list with null and drops what no longer passes on read", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    const patch = (listColumns: unknown) =>
      app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { listColumns } });
    const get = async () => (await app.inject({ url: "/me/settings", headers: { cookie } })).json().listColumns;

    expect((await patch({ "/forsaljning/ordrar": { hidden: ["customer"], widths: { number: 120 } } })).statusCode).toBe(200);
    // Another list from another tab: the first one stays.
    await patch({ "/inkop/ordrar": { hidden: ["supplier", "supplier"], widths: {} } });
    expect(await get()).toEqual({
      "/forsaljning/ordrar": { hidden: ["customer"], widths: { number: 120 } },
      "/inkop/ordrar": { hidden: ["supplier"], widths: {} },
    });
    // Kolumnordning: an order alone is a setting; duplicates dropped, an
    // empty order left out.
    await patch({ "/inkop/ordrar": { hidden: [], widths: {}, order: ["date", "supplier", "date"] } });
    await patch({ "/lager/saldon": { hidden: ["x"], widths: {}, order: [] } });
    expect(await get()).toEqual({
      "/forsaljning/ordrar": { hidden: ["customer"], widths: { number: 120 } },
      "/inkop/ordrar": { hidden: [], widths: {}, order: ["date", "supplier"] },
      "/lager/saldon": { hidden: ["x"], widths: {} },
    });
    // Återställ: null, and an empty entry is the same as none.
    await patch({ "/forsaljning/ordrar": null, "/inkop/ordrar": { hidden: [], widths: {} }, "/lager/saldon": null });
    expect(await get()).toEqual({});

    for (const bad of [
      { "forsaljning/ordrar": { hidden: [], widths: {} } }, // not a path
      { "/Forsaljning": { hidden: [], widths: {} } }, // upper case
      { "/a": { hidden: [], widths: { number: 10 } } }, // below the minimum width
      { "/a": { hidden: [], widths: { number: 120.5 } } },
      { "/a": { hidden: [] } },
      { "/a": { hidden: [], widths: {}, extra: 1 } },
      { "/a": { hidden: Array.from({ length: 41 }, (_, i) => `c${i}`), widths: {} } },
      { "/a": { hidden: [], widths: {}, order: "date" } },
    ]) {
      expect([JSON.stringify(bad), (await patch(bad)).statusCode]).toEqual([JSON.stringify(bad), 400]);
    }

    // Stored garbage: the bad lists and entries are dropped, the read never fails.
    const me = (await app.inject({ url: "/auth/me", headers: { cookie } })).json();
    await settingsRepo.upsert(
      me.id,
      "list_columns",
      JSON.stringify({ "/ok": { hidden: ["a", "a"], widths: {} }, "not-a-path": { hidden: ["b"], widths: {} }, "/bad": { hidden: "x" } })
    );
    expect(await get()).toEqual({ "/ok": { hidden: ["a"], widths: {} } });
    await settingsRepo.upsert(me.id, "list_columns", "{inte json");
    expect(await get()).toEqual({});
    await app.close();
  });

  it("keeps the 100 lists changed most recently", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    for (let batch = 0; batch < 3; batch++) {
      const lists = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`/lista-${batch * 40 + i}`, { hidden: ["x"], widths: {} }])
      );
      expect((await app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { listColumns: lists } })).statusCode).toBe(200);
    }
    const stored = (await app.inject({ url: "/me/settings", headers: { cookie } })).json().listColumns;
    expect(Object.keys(stored)).toHaveLength(100);
    expect(stored["/lista-19"]).toBeUndefined();
    expect(stored["/lista-20"]).toBeDefined();
    expect(stored["/lista-119"]).toBeDefined();
    await app.close();
  });

  it("stores Dokument i flikar (default on)", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    const patch = (documentTabs: unknown) =>
      app.inject({ method: "PATCH", url: "/me/settings", headers: { cookie }, payload: { documentTabs } });
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json().documentTabs).toBe(true);
    expect((await patch(false)).json().documentTabs).toBe(false);
    expect((await app.inject({ url: "/me/settings", headers: { cookie } })).json().documentTabs).toBe(false);
    expect((await patch("nej")).statusCode).toBe(400);
    expect((await patch(true)).json().documentTabs).toBe(true);
    await app.close();
  });

  it("lands two concurrent Kolumner changes to different lists", async () => {
    const app = buildApp();
    const cookie = await registerAndLogin(app);
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        app.inject({
          method: "PATCH",
          url: "/me/settings",
          headers: { cookie },
          payload: { listColumns: { [`/lista-${i}`]: { hidden: ["x"], widths: {} } } },
        })
      )
    );
    const stored = (await app.inject({ url: "/me/settings", headers: { cookie } })).json().listColumns;
    expect(Object.keys(stored).sort()).toEqual(["/lista-0", "/lista-1", "/lista-2", "/lista-3", "/lista-4", "/lista-5"]);
    await app.close();
  });

  it("keeps each user's setting isolated from another user's", async () => {
    const app = buildApp();
    const cookieA = await registerAndLogin(app);
    const cookieB = await registerAndLogin(app);

    await app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: { cookie: cookieA },
      payload: { listPageSize: 250 },
    });

    const resB = await app.inject({ url: "/me/settings", headers: { cookie: cookieB } });
    expect(resB.json()).toEqual({ listPageSize: 50, hideOnboarding: false, alertDigest: false, alertDigestKinds: null, theme: null, favorites: [], favoritesFromGroup: true, favoritesInSidebar: true, overviewCards: null, density: "normal", listColumns: {}, documentTabs: true });
    await app.close();
  });
});
