import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Byt lösenord (Mina inställningar, 2026-11-13): POST /me/password changes the
// signed-in user's own password behind the current one, ends the account's
// other sessions and gives this one a fresh cookie; wrong current passwords
// count in the login throttle; an Endast läsning account may change its own.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const TRUNCATE = sql`TRUNCATE user_settings, audit_log, users CASCADE`;
const PASSWORD = "correcthorsebattery";
const NEW_PASSWORD = "ett-helt-nytt-losenord";

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM permission_groups WHERE code LIKE 'LOSEN%'`);
});

afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM permission_groups WHERE code LIKE 'LOSEN%'`);
});

async function login(email: string, password = PASSWORD) {
  return app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
}
const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  `session=${res.cookies.find((c) => c.name === "session")!.value}`;

async function user(options: { readOnly?: boolean } = {}) {
  const email = `losen-${crypto.randomUUID()}@example.com`;
  let permissionGroupId: string | undefined;
  if (options.readOnly) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `LOSEN${Math.floor(Math.random() * 1e6)}`, name: "Läs", permissions: ["forsaljning"] })
      .returning();
    permissionGroupId = group!.id;
  }
  await authService.createUser({
    email,
    password: PASSWORD,
    name: "Anna",
    role: options.readOnly ? "user" : "admin",
    ...(permissionGroupId ? { permissionGroupId, readOnly: true } : {}),
  });
  const res = await login(email);
  expect(res.statusCode).toBe(200);
  return { email, cookie: cookieOf(res) };
}

const change = (cookie: string, payload: object) =>
  app.inject({ method: "POST", url: "/api/v1/me/password", headers: { cookie }, payload });
const me = (cookie: string) => app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } });

describe("POST /me/password", () => {
  it("changes the password, ends the other sessions and keeps this one on a fresh cookie", async () => {
    const { email, cookie } = await user();
    const otherDevice = cookieOf(await login(email));
    const res = await change(cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(204);
    const fresh = cookieOf(res);
    expect((await me(fresh)).statusCode).toBe(200);
    expect((await me(otherDevice)).statusCode).toBe(401);
    expect((await me(cookie)).statusCode).toBe(401);
    expect((await login(email)).statusCode).toBe(401);
    expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
    const [audit] = await db.execute<{ detail: Record<string, unknown> }>(
      sql`SELECT detail FROM audit_log WHERE entity_type = 'user' AND entity_id = ${email} AND action = 'updated'`
    );
    expect(audit!.detail).toEqual({ changedFields: ["password"], password_changed: true, own: true });
  });

  it("refuses a wrong current password and changes nothing", async () => {
    const { email, cookie } = await user();
    const res = await change(cookie, { currentPassword: "fel-losenord", newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("wrong-current-password");
    expect((await me(cookie)).statusCode).toBe(200);
    expect((await login(email)).statusCode).toBe(200);
  });

  it("needs at least 8 characters, like a new account", async () => {
    const { cookie } = await user();
    const res = await change(cookie, { currentPassword: PASSWORD, newPassword: "kort" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation-failed");
  });

  it("stops after 10 wrong current passwords, even for the right one", async () => {
    const { cookie } = await user();
    for (let i = 0; i < 10; i++) {
      expect((await change(cookie, { currentPassword: `fel-${i}-losenord`, newPassword: NEW_PASSWORD })).statusCode).toBe(400);
    }
    const res = await change(cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("password-change-throttled");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("lets an Endast läsning account change its own password", async () => {
    const { email, cookie } = await user({ readOnly: true });
    expect((await change(cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).statusCode).toBe(204);
    expect((await login(email, NEW_PASSWORD)).statusCode).toBe(200);
  });

  it("needs a session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/me/password",
      payload: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });
});
