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

// Route-level coverage the service tests can't see: the requireAuth/requireRole
// guard wiring on DELETE /auth/users/:id, and the includeDeleted query param on
// GET /auth/users. Structure mirrors user-settings.route.test.ts (same buildApp/
// loginAs helpers, same real register()/login() flow for a genuine 401/403).

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

// First user bootstraps as admin via the real /auth/register route (only
// works once); every subsequent user is created through authService
// directly, same convention as user-settings.route.test.ts.
async function registerAdminAndLogin(app: ReturnType<typeof buildApp>) {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const password = "correcthorsebattery";
  await app.inject({ method: "POST", url: "/auth/register", payload: { email, password, name: "Admin" } });
  return { cookie: await loginAs(app, email, password), email };
}

async function createUserAndLogin(app: ReturnType<typeof buildApp>, role: "user" | "supervisor" | "admin") {
  const email = `u-${crypto.randomUUID()}@example.com`;
  const password = "correcthorsebattery";
  const user = await authService.createUser({ email, password, name: "Op", role });
  return { user, cookie: await loginAs(app, email, password) };
}

describe("DELETE /auth/users/:id", () => {
  it("401s without a session cookie", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "DELETE", url: "/auth/users/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s for a logged-in non-admin", async () => {
    const app = buildApp();
    await registerAdminAndLogin(app);
    const { user: target } = await createUserAndLogin(app, "user");
    const { cookie: nonAdminCookie } = await createUserAndLogin(app, "user");

    const res = await app.inject({
      method: "DELETE",
      url: `/auth/users/${target.id}`,
      headers: { cookie: nonAdminCookie },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("204s for an admin deleting another user", async () => {
    const app = buildApp();
    const { cookie: adminCookie } = await registerAdminAndLogin(app);
    const { user: target } = await createUserAndLogin(app, "user");

    const res = await app.inject({
      method: "DELETE",
      url: `/auth/users/${target.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    const list = await authService.listUsers();
    expect(list.find((u) => u.id === target.id)).toBeUndefined();
    await app.close();
  });
});

describe("GET /auth/users?includeDeleted", () => {
  it("excludes soft-deleted users by default and includes them with includeDeleted=true", async () => {
    const app = buildApp();
    const { cookie: adminCookie, email: adminEmail } = await registerAdminAndLogin(app);
    const { user: target } = await createUserAndLogin(app, "user");

    const admin = await authRepo.findByEmail(adminEmail);
    await authService.deleteUser(target.id, admin!.id);

    const filteredRes = await app.inject({ url: "/auth/users", headers: { cookie: adminCookie } });
    expect(filteredRes.statusCode).toBe(200);
    const filtered = filteredRes.json() as Array<{ id: string }>;
    expect(filtered.find((u) => u.id === target.id)).toBeUndefined();

    const withDeletedRes = await app.inject({
      url: "/auth/users?includeDeleted=true",
      headers: { cookie: adminCookie },
    });
    expect(withDeletedRes.statusCode).toBe(200);
    const withDeleted = withDeletedRes.json() as Array<{ id: string; deletedAt: string | null }>;
    const deletedRow = withDeleted.find((u) => u.id === target.id);
    expect(deletedRow).toBeDefined();
    expect(deletedRow?.deletedAt).not.toBeNull();
    await app.close();
  });
});
