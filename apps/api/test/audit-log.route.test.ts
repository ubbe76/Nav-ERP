import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import { auditLog, db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createUserSettingsRepository } from "../src/modules/auth/repository/user-settings.repository.js";
import { createUserSettingsService } from "../src/modules/auth/service/user-settings.service.js";
import { authRoutes } from "../src/modules/auth/routes/auth.routes.js";
import { createLoginThrottle } from "../src/modules/auth/service/login-throttle.js";
import { requireAuth, SESSION_COOKIE } from "../src/modules/auth/middleware/auth.middleware.js";
import { auditLogRoutes } from "../src/modules/system/routes/audit-log.routes.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// G1 (Agent 3) — route-level coverage for the read side of the audit trail:
// the admin gate (requireAuth + requireRole("admin"), same wiring as
// GET /auth/users), the filters (entityType/userId/from/to), search, the
// soft-deleted-user name join, and the CSV sibling. audit.repository.ts's
// listAuditLog itself has no service layer in front of it (see
// audit-log.routes.ts's own comment), so this file is the only place that
// exercises the query end to end. App-boot pattern copied from
// auth-users.route.test.ts: a bare Fastify app with the real authRoutes
// (for a genuine login → 401/403) plus a protectedRoutes-style wrapper
// mirroring app.ts's requireAuth hook in front of auditLogRoutes.

const authRepo = createAuthRepository(db);
const auditRepo = createAuditRepository(db);
const authService = createAuthService(authRepo, "test-secret", auditRepo);
const settingsRepo = createUserSettingsRepository(db);
const settingsService = createUserSettingsService(settingsRepo);

const TRUNCATE = sql`TRUNCATE audit_log, user_settings, users CASCADE`;

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
  app.register(async (protectedRoutes) => {
    protectedRoutes.addHook("preHandler", requireAuth(authService));
    await protectedRoutes.register(auditLogRoutes, { repo: auditRepo });
  });
  return app;
}

async function loginAs(app: ReturnType<typeof buildApp>, email: string, password: string) {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return `${SESSION_COOKIE}=${cookie!.value}`;
}

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

describe("GET /audit-log", () => {
  it("401s without a session cookie", async () => {
    const app = buildApp();
    const res = await app.inject({ url: "/audit-log" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s for a logged-in non-admin", async () => {
    const app = buildApp();
    const { cookie } = await createUserAndLogin(app, "user");
    const res = await app.inject({ url: "/audit-log", headers: { cookie } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("200s for an admin and returns { rows, total }", async () => {
    const app = buildApp();
    const { cookie } = await registerAdminAndLogin(app);
    await auditRepo.log({ entityType: "sales_order", entityId: "KO-2500001", action: "confirmed" });

    const res = await app.inject({ url: "/audit-log", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.rows).toHaveLength(1);
    await app.close();
  });

  it("filters by entityType, userId and date range", async () => {
    const app = buildApp();
    const { cookie } = await registerAdminAndLogin(app);
    const { user: other } = await createUserAndLogin(app, "user");

    await auditRepo.log({ entityType: "sales_order", entityId: "KO-2500001", action: "confirmed", userId: other.id });
    await auditRepo.log({ entityType: "purchase_order", entityId: "IO-2500001", action: "confirmed", userId: other.id });
    // Backdated far outside any from/to window used below.
    await db.insert(auditLog).values({
      entityType: "sales_order",
      entityId: "KO-2400001",
      action: "confirmed",
      userId: other.id,
      createdAt: new Date("2020-01-01T12:00:00Z"),
    });

    const byType = await app.inject({ url: "/audit-log?entityType=sales_order", headers: { cookie } });
    expect((byType.json() as { total: number }).total).toBe(2);

    const byUser = await app.inject({ url: `/audit-log?userId=${other.id}`, headers: { cookie } });
    expect((byUser.json() as { total: number }).total).toBe(3);

    // Scoped to entityType so the assertion isn't thrown off by
    // createUserAndLogin's own "user"/"created" audit entry (auth.service.ts
    // logs user creation now too, post-G1-merge) landing in today's window.
    const today = new Date().toISOString().slice(0, 10);
    const byDate = await app.inject({
      url: `/audit-log?entityType=sales_order&from=${today}&to=${today}`,
      headers: { cookie },
    });
    const dateRows = (byDate.json() as { rows: Array<{ entityId: string }> }).rows;
    expect(dateRows.some((r) => r.entityId === "KO-2400001")).toBe(false);
    expect(dateRows.map((r) => r.entityId)).toEqual(["KO-2500001"]);
    await app.close();
  });

  it("searches entityId and action via ILIKE", async () => {
    const app = buildApp();
    const { cookie } = await registerAdminAndLogin(app);
    await auditRepo.log({ entityType: "sales_order", entityId: "KO-2500042", action: "confirmed" });
    await auditRepo.log({ entityType: "purchase_order", entityId: "IO-2500099", action: "cancelled" });

    const res = await app.inject({ url: "/audit-log?search=2500042", headers: { cookie } });
    const rows = (res.json() as { rows: Array<{ entityId: string }> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe("KO-2500042");

    const byAction = await app.inject({ url: "/audit-log?search=cancelled", headers: { cookie } });
    const actionRows = (byAction.json() as { rows: Array<{ entityId: string }> }).rows;
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]!.entityId).toBe("IO-2500099");
    await app.close();
  });

  it("still resolves a soft-deleted user's name", async () => {
    const app = buildApp();
    const { cookie: adminCookie, email: adminEmail } = await registerAdminAndLogin(app);
    const { user: target } = await createUserAndLogin(app, "user");
    await auditRepo.log({ entityType: "sales_order", entityId: "KO-2500001", action: "confirmed", userId: target.id });

    const admin = await authRepo.findByEmail(adminEmail);
    // deleteUser (auth.service.ts, post-G1-merge) writes its OWN audit entry
    // attributed to the acting admin — scope to the manually-inserted
    // sales_order entry (attributed to the target) so that entry, not the
    // admin-attributed deletion event, is what's asserted on.
    await authService.deleteUser(target.id, admin!.id);

    const res = await app.inject({
      url: "/audit-log?entityType=sales_order&entityId=KO-2500001",
      headers: { cookie: adminCookie },
    });
    const rows = res.json() as { rows: Array<{ userName: string | null }> };
    expect(rows.rows[0]!.userName).toBe("Op");
    await app.close();
  });

  it("supports entityId exact-match filtering (the AuditTrailSection's own query shape)", async () => {
    const app = buildApp();
    const { cookie } = await registerAdminAndLogin(app);
    await auditRepo.log({ entityType: "sales_order", entityId: "KO-2500001", action: "confirmed" });
    await auditRepo.log({ entityType: "sales_order", entityId: "KO-2500001", action: "cancelled" });
    await auditRepo.log({ entityType: "sales_order", entityId: "KO-2500002", action: "confirmed" });

    const res = await app.inject({
      url: "/audit-log?entityType=sales_order&entityId=KO-2500001",
      headers: { cookie },
    });
    expect((res.json() as { total: number }).total).toBe(2);
    await app.close();
  });
});

describe("GET /audit-log/csv", () => {
  it("401s without a session cookie", async () => {
    const app = buildApp();
    const res = await app.inject({ url: "/audit-log/csv" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns a CSV attachment with rows for an admin", async () => {
    const app = buildApp();
    const { cookie } = await registerAdminAndLogin(app);
    await auditRepo.log({ entityType: "sales_order", entityId: "KO-2500001", action: "confirmed" });

    const res = await app.inject({ url: "/audit-log/csv", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const body = res.body;
    expect(body).toContain("KO-2500001");
    expect(body).toContain("Kundorder");
    expect(body).toContain("Bekräftad");
    await app.close();
  });
});
