import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { rejectMalformedIds } from "../src/modules/system/middleware/reject-malformed-ids.js";

const ID = "11111111-1111-4111-8111-111111111111";

describe("rejectMalformedIds", () => {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof ZodError ? 400 : 500).send({}));
  app.addHook("preHandler", rejectMalformedIds());
  app.get("/things/:id", async () => ({ ok: true }));
  app.get("/things/:id/rows/:rowId", async () => ({ ok: true }));
  app.get("/years/:year/:entity", async () => ({ ok: true }));

  it("400s a non-uuid id or …Id parameter and lets a uuid through", async () => {
    expect((await app.inject({ url: `/things/${ID}` })).statusCode).toBe(200);
    expect((await app.inject({ url: "/things/not-a-uuid" })).statusCode).toBe(400);
    expect((await app.inject({ url: `/things/${ID}/rows/42` })).statusCode).toBe(400);
  });

  it("leaves other parameters alone", async () => {
    expect((await app.inject({ url: "/years/2026/articles" })).statusCode).toBe(200);
  });
});

describe("wired into the app", () => {
  const app = buildApp();
  const TRUNCATE = sql`TRUNCATE audit_log, user_settings, users CASCADE`;
  beforeAll(async () => {
    await app.ready();
    await db.execute(TRUNCATE);
  });
  afterAll(async () => {
    await db.execute(TRUNCATE);
    await app.close();
  });

  it("answers GET /sales-orders/<non-uuid> with 400, not 500", async () => {
    const email = `admin-${crypto.randomUUID()}@example.com`;
    const password = "correcthorsebattery";
    await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email, password, name: "Admin", setupCode: app.setup.code.code } });
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password } });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await app.inject({ url: "/api/v1/sales-orders/not-a-uuid", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation-failed");
  });
});
