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
    expect(res.json()).toEqual({ listPageSize: 50, hideOnboarding: false, alertDigest: false, alertDigestKinds: null });
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
    expect(patchRes.json()).toEqual({ listPageSize: 100, hideOnboarding: false, alertDigest: false, alertDigestKinds: null });

    const getRes = await app.inject({ url: "/me/settings", headers: { cookie } });
    expect(getRes.json()).toEqual({ listPageSize: 100, hideOnboarding: false, alertDigest: false, alertDigestKinds: null });

    // Upsert, not insert-only: a second PATCH overwrites the first value
    // rather than erroring on the composite PK.
    const secondPatch = await app.inject({
      method: "PATCH",
      url: "/me/settings",
      headers: { cookie },
      payload: { listPageSize: 25 },
    });
    expect(secondPatch.statusCode).toBe(200);
    expect(secondPatch.json()).toEqual({ listPageSize: 25, hideOnboarding: false, alertDigest: false, alertDigestKinds: null });
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
    expect(patch.json()).toEqual({ listPageSize: 50, hideOnboarding: true, alertDigest: false, alertDigestKinds: null });
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
    expect(resB.json()).toEqual({ listPageSize: 50, hideOnboarding: false, alertDigest: false, alertDigestKinds: null });
    await app.close();
  });
});
