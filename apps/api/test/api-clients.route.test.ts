import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, auditLog, customers } from "@navet/db";
import { buildApp } from "../src/app.js";

const TRUNCATE = sql`TRUNCATE api_clients, customers, audit_log, user_settings, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";
let app: ReturnType<typeof buildApp>;
let cookie: string;
let customerId: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const create = (payload: unknown) => app.inject({ method: "POST", url: "/api/v1/api-clients", headers: { cookie }, payload });
const patch = (id: string, payload: unknown) => app.inject({ method: "PATCH", url: `/api/v1/api-clients/${id}`, headers: { cookie }, payload });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  app = buildApp();
  await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code } });
  cookie = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
  [{ id: customerId }] = await db.insert(customers).values({ customerNumber: "K-WEB", name: "Webbförfrågningar" }).returning({ id: customers.id });
});
afterEach(async () => app.close());
afterAll(async () => db.execute(TRUNCATE));

describe("API-klienternas administration", () => {
  it("creates a client with scopes and a customer, and lists them", async () => {
    const res = await create({ name: "Hemsidan", scopes: ["configurator:read", "quotes:create"], customerId });
    expect(res.statusCode).toBe(201);
    expect(res.json().client).toMatchObject({
      scopes: ["configurator:read", "quotes:create"],
      customerId,
      customer: { id: customerId, customerNumber: "K-WEB", name: "Webbförfrågningar" },
    });
    const list = (await app.inject({ method: "GET", url: "/api/v1/api-clients", headers: { cookie } })).json();
    expect(list[0]).toMatchObject({ name: "Hemsidan", customer: { customerNumber: "K-WEB", name: "Webbförfrågningar" } });
  });

  it("refuses no scopes, unknown scopes and an unknown customer", async () => {
    expect((await create({ name: "X", scopes: [] })).statusCode).toBe(400);
    expect((await create({ name: "X", scopes: ["admin:all"] })).statusCode).toBe(400);
    const res = await create({ name: "X", scopes: ["configurator:read"], customerId: "00000000-0000-4000-8000-000000000000" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("api-client-customer-not-found");
  });

  it("changes scopes and customer with PATCH, logs it, and refuses an empty scope list", async () => {
    const id = (await create({ name: "Partner", scopes: ["configurator:read"] })).json().client.id;
    const res = await patch(id, { scopes: ["configurator:read", "prices:read"], customerId });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      scopes: ["configurator:read", "prices:read"],
      customerId,
      customer: { customerNumber: "K-WEB", name: "Webbförfrågningar" },
    });
    expect((await patch(id, { customerId: null })).json().customerId).toBeNull();
    expect((await patch(id, { scopes: [] })).statusCode).toBe(400);
    const logged = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "api_client"), eq(auditLog.action, "updated")));
    expect(logged).toHaveLength(2);
    // Keyed by the client's id (names need not be unique), the name in the detail.
    expect(logged.every((row) => row.entityId === id)).toBe(true);
    expect(logged[0]!.detail).toMatchObject({ name: "Partner" });
    expect((await patch("00000000-0000-4000-8000-000000000000", { scopes: ["configurator:read"] })).statusCode).toBe(404);
  });

  it("is admin only", async () => {
    await app.inject({ method: "POST", url: "/api/v1/auth/users", headers: { cookie }, payload: { email: "u@example.com", password: PASSWORD, name: "U", role: "user" } });
    const user = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "u@example.com", password: PASSWORD } }));
    expect((await app.inject({ method: "POST", url: "/api/v1/api-clients", headers: { cookie: user }, payload: { name: "X", scopes: ["configurator:read"] } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/api-clients/00000000-0000-4000-8000-000000000000", headers: { cookie: user }, payload: { scopes: ["configurator:read"] } })).statusCode).toBe(403);
  });
});
