import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";

// The credential guards through the real app: the failed-attempt throttle on
// POST /auth/login and POST /oauth/token (one throttle per buildApp instance)
// and the one-time setup code on the bootstrap POST /auth/register.

const TRUNCATE = sql`TRUNCATE user_settings, users, audit_log CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;

async function registerAdmin(email: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  expect(res.statusCode).toBe(201);
}

function login(email: string, password: string, headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, headers });
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterEach(async () => {
  await app?.close();
  delete process.env.TRUST_PROXY;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

describe("login throttle", () => {
  it("refuses the account after 10 failures — even with the right password — and names the wait", async () => {
    app = buildApp();
    await registerAdmin("admin@example.com");

    for (let i = 0; i < 10; i++) expect((await login("admin@example.com", "fel-lösenord")).statusCode).toBe(401);

    const res = await login("Admin@Example.com", PASSWORD);
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBe(String(15 * 60));
    expect(res.json()).toMatchObject({ code: "login-throttled", retryAfterSeconds: 15 * 60 });
  });

  it("does not count successful logins and leaves other accounts alone", async () => {
    app = buildApp();
    await registerAdmin("admin@example.com");

    for (let i = 0; i < 9; i++) await login("admin@example.com", "fel-lösenord");
    expect((await login("admin@example.com", PASSWORD)).statusCode).toBe(200);
    // The success cleared the count: nine more failures still do not lock.
    for (let i = 0; i < 9; i++) await login("admin@example.com", "fel-lösenord");
    expect((await login("admin@example.com", PASSWORD)).statusCode).toBe(200);

    for (let i = 0; i < 10; i++) await login("other@example.com", "fel-lösenord");
    expect((await login("other@example.com", "fel-lösenord")).statusCode).toBe(429);
    expect((await login("admin@example.com", PASSWORD)).statusCode).toBe(200);
  });

  it("has no per-IP limit unless TRUST_PROXY is set", async () => {
    app = buildApp();
    await registerAdmin("admin@example.com");
    for (let i = 0; i < 40; i++) await login(`spray${i}@example.com`, "fel-lösenord");
    expect((await login("admin@example.com", PASSWORD)).statusCode).toBe(200);
  });

  it("limits a client IP after 30 failures across accounts when TRUST_PROXY is set", async () => {
    process.env.TRUST_PROXY = "1";
    app = buildApp();
    await registerAdmin("admin@example.com");
    const attacker = { "x-forwarded-for": "203.0.113.7" };

    for (let i = 0; i < 30; i++) await login(`spray${i}@example.com`, "fel-lösenord", attacker);
    expect((await login("admin@example.com", PASSWORD, attacker)).statusCode).toBe(429);
    // Another address is unaffected, and so is the account itself.
    expect((await login("admin@example.com", PASSWORD, { "x-forwarded-for": "198.51.100.2" })).statusCode).toBe(200);
  });
});

describe("OAuth token throttle", () => {
  it("refuses a client id after 10 failed secrets", async () => {
    app = buildApp();
    const clientId = randomUUID();
    const token = () =>
      app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId, clientSecret: "fel" } });

    for (let i = 0; i < 10; i++) expect((await token()).statusCode).toBe(401);
    const res = await token();
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe("login-throttled");
  });
});

describe("bootstrap registration setup code", () => {
  function register(setupCode?: string) {
    return app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode },
    });
  }

  it("refuses the first account without the code or with a wrong one", async () => {
    app = buildApp();
    for (const code of [undefined, "", "AAAA-BBBB-CCCC"]) {
      const res = await register(code);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("invalid-setup-code");
    }
    // Nothing was created — registration is still open.
    expect(await app.setup.needsSetup()).toBe(true);
  });

  it("accepts the code regardless of case, spaces and dashes, then closes", async () => {
    app = buildApp();
    const loose = ` ${app.setup.code.code.replace(/-/g, " ").toLowerCase()} `;
    expect((await register(loose)).statusCode).toBe(201);
    expect(await app.setup.needsSetup()).toBe(false);

    const again = await register(app.setup.code.code);
    expect(again.statusCode).toBe(403);
    expect(again.json().code).toBe("registration-closed");
  });

  it("draws a fresh code per app and honours SETUP_CODE", async () => {
    app = buildApp();
    const first = app.setup.code;
    await app.close();
    app = buildApp();
    expect(app.setup.code.code).not.toBe(first.code);
    expect(app.setup.code.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(app.setup.code.fromEnvironment).toBe(false);
    await app.close();

    process.env.SETUP_CODE = "min-egen-kod";
    try {
      app = buildApp();
      expect(app.setup.code.fromEnvironment).toBe(true);
      expect((await register("MIN-EGEN-KOD")).statusCode).toBe(201);
    } finally {
      delete process.env.SETUP_CODE;
    }
  });
});
