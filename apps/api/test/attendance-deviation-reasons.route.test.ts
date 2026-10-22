import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Register Avvikelseorsaker: the stamp terminal (and office) read it, only
// admins write, and there is no delete (sessions keep reasons as history).

const TRUNCATE = sql`TRUNCATE attendance_deviation_reasons, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'ADR%'`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

describe("/attendance-deviation-reasons", () => {
  const app = buildApp();
  const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));

  afterAll(async () => {
    await app.close();
  });

  async function session(role: "admin" | "user", permissions: string[] = []) {
    const email = `r-${crypto.randomUUID()}@example.com`;
    if (role === "admin") {
      await authService.createUser({ email, password: "correcthorse", name: "R", role });
    } else {
      const [group] = await db
        .insert(permissionGroups)
        .values({ code: `ADR${crypto.randomUUID().slice(0, 8)}`, name: "Orsaker", permissions })
        .returning();
      await authService.createUser({ email, password: "correcthorse", name: "R", role, permissionGroupId: group!.id });
    }
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
    return { cookie: `session=${res.cookies.find((c) => c.name === "session")!.value}` };
  }

  it("lets admin create, list and inactivate; active filter hides inactive", async () => {
    const admin = await session("admin");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/attendance-deviation-reasons",
      headers: { cookie: admin.cookie },
      payload: { code: "TRAFIK", name: "Trafik/resa" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ code: "TRAFIK", name: "Trafik/resa", active: true });

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance-deviation-reasons/${created.json().id}`,
      headers: { cookie: admin.cookie },
      payload: { active: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().active).toBe(false);

    const active = await app.inject({ method: "GET", url: "/api/v1/attendance-deviation-reasons", headers: { cookie: admin.cookie } });
    expect(active.json()).toEqual([]);
    const all = await app.inject({
      method: "GET",
      url: "/api/v1/attendance-deviation-reasons?includeInactive=true",
      headers: { cookie: admin.cookie },
    });
    expect(all.json()).toHaveLength(1);
  });

  it("lets a terminal-only user and an office user read, but not write", async () => {
    const admin = await session("admin");
    await app.inject({
      method: "POST",
      url: "/api/v1/attendance-deviation-reasons",
      headers: { cookie: admin.cookie },
      payload: { code: "VAB", name: "Vård av barn" },
    });

    for (const permissions of [["terminal"], ["tillverkning"]]) {
      const user = await session("user", permissions);
      const read = await app.inject({ method: "GET", url: "/api/v1/attendance-deviation-reasons", headers: { cookie: user.cookie } });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toHaveLength(1);

      const write = await app.inject({
        method: "POST",
        url: "/api/v1/attendance-deviation-reasons",
        headers: { cookie: user.cookie },
        payload: { code: "X", name: "X" },
      });
      expect(write.statusCode).toBe(403);
    }
  });

  it("answers 409 for a duplicate code or name and 404 for an unknown id", async () => {
    const admin = await session("admin");
    const post = (payload: object) =>
      app.inject({ method: "POST", url: "/api/v1/attendance-deviation-reasons", headers: { cookie: admin.cookie }, payload });
    expect((await post({ code: "SJUK", name: "Sjuk" })).statusCode).toBe(201);
    const dupCode = await post({ code: "SJUK", name: "Annat" });
    expect(dupCode.statusCode).toBe(409);
    expect(dupCode.json().code).toBe("duplicate-payroll-code");
    expect((await post({ code: "ANNAT", name: "Sjuk" })).statusCode).toBe(409);

    const missing = await app.inject({
      method: "PATCH",
      url: `/api/v1/attendance-deviation-reasons/${crypto.randomUUID()}`,
      headers: { cookie: admin.cookie },
      payload: { name: "Nytt" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("has no DELETE route", async () => {
    const admin = await session("admin");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/attendance-deviation-reasons/${crypto.randomUUID()}`,
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
