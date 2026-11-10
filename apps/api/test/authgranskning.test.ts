import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sql } from "drizzle-orm";
import { createUserSchema, registerSchema, updateUserSchema } from "@navet/shared";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import {
  createAuthService,
  DuplicateEmailError,
  LastAdminError,
} from "../src/modules/auth/service/auth.service.js";
import { SESSION_COOKIE } from "../src/modules/auth/middleware/auth.middleware.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";

// Auth-granskningen 2026-11-10 (granskare A): e-post utan skiftläge, nytt
// lösenord avslutar sessionerna, inloggningens svarstid, händelseloggen för
// behörighetsgrupper och API-klienter, id-vakten på användarrutterna,
// OAuth-spärrens nyckel och sista admin / dubblettadressen under samtidighet.

const TRUNCATE = sql`TRUNCATE user_settings, users, audit_log, api_clients CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";
// The secret buildApp signs with (app.ts).
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";

const authService = createAuthService(createAuthRepository(db), JWT_SECRET, createAuditRepository(db));

let app: ReturnType<typeof buildApp>;

function cookieOf(res: { cookies: { name: string; value: string }[] }): string {
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  expect(cookie, "a session cookie").toBeDefined();
  return `${SESSION_COOKIE}=${cookie!.value}`;
}

async function registerAdmin(email = "admin@example.com") {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, cookie: cookieOf(res) };
}

function login(email: string, password = PASSWORD) {
  return app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
}

function me(cookie: string) {
  return app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });
}

function createUser(admin: string, email: string, role: "user" | "supervisor" | "admin" = "user") {
  return app.inject({
    method: "POST",
    url: "/api/v1/auth/users",
    headers: { cookie: admin },
    payload: { email, password: PASSWORD, name: "Op", role },
  });
}

function patchUser(admin: string, id: string, payload: Record<string, unknown>) {
  return app.inject({ method: "PATCH", url: `/api/v1/auth/users/${id}`, headers: { cookie: admin }, payload });
}

async function auditRows(entityType: string) {
  const rows = await db.execute<{ entity_id: string; action: string; detail: Record<string, unknown> }>(
    sql`SELECT entity_id, action, detail FROM audit_log WHERE entity_type = ${entityType} ORDER BY created_at, id`
  );
  return [...rows];
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM permission_groups WHERE code LIKE 'AG%'`);
  app = buildApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM permission_groups WHERE code LIKE 'AG%'`);
});

describe("e-post utan skiftläge", () => {
  it("stores the address in lower case and logs in whatever the case", async () => {
    const admin = await registerAdmin("Admin@Example.com");
    const created = await createUser(admin.cookie, "  Anna.Berg@Firma.se ");
    expect(created.statusCode).toBe(201);
    expect(created.json().email).toBe("anna.berg@firma.se");

    for (const variant of ["anna.berg@firma.se", "ANNA.BERG@FIRMA.SE", "Anna.Berg@Firma.se"]) {
      expect((await login(variant)).statusCode).toBe(200);
    }
    expect((await login("admin@example.com")).statusCode).toBe(200);
  });

  it("refuses a second account that differs only by case — on create and on a change", async () => {
    const admin = await registerAdmin();
    expect((await createUser(admin.cookie, "anna@x.se")).statusCode).toBe(201);
    const clash = await createUser(admin.cookie, "ANNA@x.se");
    expect([clash.statusCode, clash.json().code]).toEqual([409, "duplicate-email"]);

    const other = await createUser(admin.cookie, "bo@x.se");
    const renamed = await patchUser(admin.cookie, other.json().id, { email: "Anna@X.se" });
    expect([renamed.statusCode, renamed.json().code]).toEqual([409, "duplicate-email"]);
  });

  it("finds an address stored in mixed case before 0205 (lower() on both sides)", async () => {
    const admin = await registerAdmin();
    const created = await createUser(admin.cookie, "old@example.com");
    await db.execute(sql`UPDATE users SET email = 'Old.Style@Example.com' WHERE id = ${created.json().id}`);
    expect((await login("old.style@example.com")).statusCode).toBe(200);
  });

  it("the unique index is case-insensitive even past the API", async () => {
    await registerAdmin("admin@example.com");
    await expect(
      db.execute(sql`INSERT INTO users (email, password_hash, name) VALUES ('ADMIN@example.com', 'x', 'Kopia')`)
    ).rejects.toThrow();
  });
});

describe("nytt lösenord avslutar sessionerna", () => {
  it("ends every session of the account; the new password logs in", async () => {
    const admin = await registerAdmin();
    const user = (await createUser(admin.cookie, "op@example.com")).json();
    const first = cookieOf(await login("op@example.com"));
    const second = cookieOf(await login("op@example.com"));
    expect((await me(first)).statusCode).toBe(200);

    expect((await patchUser(admin.cookie, user.id, { password: "ett-helt-nytt-lösenord" })).statusCode).toBe(200);

    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(401);
    expect((await login("op@example.com")).statusCode).toBe(401);
    expect((await me(cookieOf(await login("op@example.com", "ett-helt-nytt-lösenord")))).statusCode).toBe(200);
  });

  it("a change without a password keeps the sessions", async () => {
    const admin = await registerAdmin();
    const user = (await createUser(admin.cookie, "op@example.com")).json();
    const session = cookieOf(await login("op@example.com"));
    expect((await patchUser(admin.cookie, user.id, { name: "Nytt namn" })).statusCode).toBe(200);
    expect((await me(session)).statusCode).toBe(200);
  });

  it("an admin changing their own password gets a fresh cookie; their other sessions end", async () => {
    const admin = await registerAdmin();
    const elsewhere = cookieOf(await login("admin@example.com"));

    const res = await patchUser(admin.cookie, admin.id, { password: "ett-helt-nytt-lösenord" });
    expect(res.statusCode).toBe(200);
    const fresh = cookieOf(res);

    expect((await me(fresh)).statusCode).toBe(200);
    expect((await me(admin.cookie)).statusCode).toBe(401);
    expect((await me(elsewhere)).statusCode).toBe(401);
  });

  it("Logga ut ends only this device — the account's other sessions stay", async () => {
    await registerAdmin();
    const phone = cookieOf(await login("admin@example.com"));
    const desk = cookieOf(await login("admin@example.com"));
    const out = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie: phone } });
    expect(out.statusCode).toBe(204);
    expect((await me(desk)).statusCode).toBe(200);
  });

  it("a session issued before 0205 (no ver claim) still holds until the first password change", async () => {
    const admin = await registerAdmin();
    const old = `${SESSION_COOKIE}=${jwt.sign({ sub: admin.id, role: "admin" }, JWT_SECRET, { expiresIn: "1h" })}`;
    expect((await me(old)).statusCode).toBe(200);
    await patchUser(admin.cookie, admin.id, { password: "ett-helt-nytt-lösenord" });
    expect((await me(old)).statusCode).toBe(401);
  });
});

describe("inloggningens svarstid", () => {
  it("runs one bcrypt comparison for an unknown, an inactive and a plugin account too", async () => {
    const admin = await registerAdmin();
    const inactive = (await createUser(admin.cookie, "inaktiv@example.com")).json();
    await patchUser(admin.cookie, inactive.id, { active: false });
    const plugin = (await createUser(admin.cookie, "tillagg@example.com")).json();
    await db.execute(sql`UPDATE users SET kind = 'plugin' WHERE id = ${plugin.id}`);

    const compare = vi.spyOn(bcrypt, "compare");
    for (const email of ["okand@example.com", "inaktiv@example.com", "tillagg@example.com", "admin@example.com"]) {
      compare.mockClear();
      const res = await login(email, "fel-lösenord");
      expect(res.statusCode, email).toBe(401);
      expect(res.json().code).toBe("invalid-credentials");
      expect(compare, email).toHaveBeenCalledTimes(1);
    }
  });
});

describe("händelseloggen", () => {
  it("logs a permission group's create, change (before/after) and removal with the moved users", async () => {
    const admin = await registerAdmin();
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/v1/permission-groups", headers: { cookie: admin.cookie }, payload });
    const a = (await post({ code: "AGA", name: "Verkstad", permissions: ["terminal"] })).json();
    const b = (await post({ code: "AGB", name: "Kontor", permissions: ["inkop"] })).json();

    const nothing = await app.inject({
      method: "PATCH",
      url: `/api/v1/permission-groups/${a.id}`,
      headers: { cookie: admin.cookie },
      payload: { permissions: ["terminal"] },
    });
    expect(nothing.statusCode).toBe(200);
    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/permission-groups/${a.id}`,
      headers: { cookie: admin.cookie },
      payload: { permissions: ["terminal", "ekonomi"] },
    });
    expect(changed.statusCode).toBe(200);

    const member = (await createUser(admin.cookie, "op@example.com")).json();
    await patchUser(admin.cookie, member.id, { permissionGroupId: a.id });
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/permission-groups/${a.id}?replacementId=${b.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(removed.statusCode).toBe(204);

    const rows = await auditRows("permission_group");
    expect(rows.map((r) => [r.entity_id, r.action])).toEqual([
      ["AGA", "created"],
      ["AGB", "created"],
      ["AGA", "updated"],
      ["AGA", "deleted"],
    ]);
    expect(rows[2]!.detail).toMatchObject({
      changedFields: ["permissions"],
      permissions: { before: ["terminal"], after: ["terminal", "ekonomi"] },
    });
    expect(rows[3]!.detail).toMatchObject({ replacement: "AGB", movedUsers: 1 });
  });

  it("logs an API client's creation and its revocation once", async () => {
    const admin = await registerAdmin();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/api-clients",
      headers: { cookie: admin.cookie },
      payload: { name: "Hemsidan", scopes: ["configurator:read"] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().client.id as string;
    for (let i = 0; i < 2; i++) {
      const revoked = await app.inject({ method: "POST", url: `/api/v1/api-clients/${id}/revoke`, headers: { cookie: admin.cookie } });
      expect([revoked.statusCode, revoked.json().active]).toEqual([200, false]);
    }

    const rows = await auditRows("api_client");
    expect(rows.map((r) => [r.entity_id, r.action])).toEqual([
      [id, "created"],
      [id, "revoked"],
    ]);
    expect(rows[0]!.detail).toMatchObject({ name: "Hemsidan", scopes: ["configurator:read"] });
    // The secret never reaches the log.
    expect(JSON.stringify(rows)).not.toContain(created.json().clientSecret);
  });
});

describe("id-vakten på användarrutterna", () => {
  it("a malformed :id is 400 validation-failed, not a Postgres cast error", async () => {
    const admin = await registerAdmin();
    for (const method of ["PATCH", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: "/api/v1/auth/users/abc",
        headers: { cookie: admin.cookie },
        payload: method === "PATCH" ? { name: "X" } : undefined,
      });
      expect([res.statusCode, res.json().code], method).toEqual([400, "validation-failed"]);
    }
  });
});

describe("OAuth-spärrens nyckel", () => {
  it("counts every spelling of a client id as the same client", async () => {
    const clientId = randomUUID();
    const token = (id: string) =>
      app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: id, clientSecret: "fel" } });
    for (let i = 0; i < 10; i++) {
      const spelling = i % 2 === 0 ? clientId.toUpperCase() : clientId;
      expect((await token(spelling)).statusCode).toBe(401);
    }
    const res = await token(clientId.replace(/[a-f]/, (c) => c.toUpperCase()));
    expect([res.statusCode, res.json().code]).toEqual([429, "login-throttled"]);
  });
});

describe("samtidiga ändringar i användarregistret", () => {
  async function twoAdmins() {
    const a = await authService.register(parsed(registerSchema, { email: "a@example.com", password: PASSWORD, name: "A" }));
    const b = await authService.createUser(parsed(createUserSchema, { email: "b@example.com", password: PASSWORD, name: "B", role: "admin" }));
    return { a: a.user.id, b: b.id };
  }

  async function activeAdmins() {
    const [row] = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active`
    );
    return row!.n;
  }

  it("two admins demoting each other at once: one wins, the other gets LastAdminError", async () => {
    const { a, b } = await twoAdmins();
    const results = await Promise.allSettled([
      authService.updateUser(b, parsed(updateUserSchema, { role: "user" }), a),
      authService.updateUser(a, parsed(updateUserSchema, { role: "user" }), b),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(LastAdminError);
    expect(await activeAdmins()).toBe(1);
  });

  it("deactivating and deleting the other admin at once leaves one admin", async () => {
    const { a, b } = await twoAdmins();
    const results = await Promise.allSettled([
      authService.deleteUser(b, a),
      authService.updateUser(a, parsed(updateUserSchema, { active: false }), b),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(LastAdminError);
    expect(await activeAdmins()).toBe(1);
  });

  it("the last admin still cannot demote, deactivate or delete themselves sequentially", async () => {
    const { a, b } = await twoAdmins();
    await authService.updateUser(b, parsed(updateUserSchema, { role: "user" }), a);
    await expect(authService.updateUser(a, parsed(updateUserSchema, { role: "supervisor" }), a)).rejects.toBeInstanceOf(LastAdminError);
    await expect(authService.updateUser(a, parsed(updateUserSchema, { active: false }), a)).rejects.toBeInstanceOf(LastAdminError);
    // Demoting a non-admin needs no other admin.
    await authService.updateUser(b, parsed(updateUserSchema, { role: "supervisor" }), a);
    expect(await activeAdmins()).toBe(1);
  });

  it("two creates with the same address at once: one account, the other DuplicateEmailError", async () => {
    await authService.register(parsed(registerSchema, { email: "a@example.com", password: PASSWORD, name: "A" }));
    const input = (email: string) => parsed(createUserSchema, { email, password: PASSWORD, name: "Dubbel" });
    const results = await Promise.allSettled([
      authService.createUser(input("dubbel@example.com")),
      authService.createUser(input("Dubbel@Example.com")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateEmailError);
    const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM users WHERE lower(email) = 'dubbel@example.com'`);
    expect(row!.n).toBe(1);
  });
});
