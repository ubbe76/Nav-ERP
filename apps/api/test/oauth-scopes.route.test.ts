import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, articles, customers, salesOrderRows, salesOrders, units } from "@navet/db";
import { API_CLIENT_SCOPES, type ApiClientScope } from "@navet/shared";
import { buildApp } from "../src/app.js";

// Every route a client token reaches, with and without its scope, and the
// customer binding. Sessions are covered by the existing route tests.

const TRUNCATE = sql`TRUNCATE api_clients, sales_orders, customers, articles, audit_log, user_settings, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";
const NO_ID = "00000000-0000-4000-8000-000000000000";
let app: ReturnType<typeof buildApp>;
let admin: string;
let ownCustomer: string;
let otherCustomer: string;
let articleId: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

async function clientToken(scopes: ApiClientScope[], customerId: string | null = null) {
  const created = (await app.inject({ method: "POST", url: "/api/v1/api-clients", headers: { cookie: admin }, payload: { name: "Klient", scopes, customerId } })).json();
  const token = (await app.inject({ method: "POST", url: "/api/v1/oauth/token", payload: { clientId: created.client.id, clientSecret: created.clientSecret } })).json();
  return { id: created.client.id as string, auth: { authorization: `Bearer ${token.accessToken}` } };
}

const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers, payload: payload as never });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  app = buildApp();
  await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code } });
  admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
  [{ id: ownCustomer }] = await db.insert(customers).values({ customerNumber: "K-1", name: "Egen kund" }).returning({ id: customers.id });
  [{ id: otherCustomer }] = await db.insert(customers).values({ customerNumber: "K-2", name: "Annan kund" }).returning({ id: customers.id });
  // Other test files may have removed the seeded unit — make sure it exists.
  await db.insert(units).values({ code: "st", name: "Styck" }).onConflictDoNothing();
  const [st] = await db.select({ id: units.id }).from(units).where(eq(units.code, "st"));
  [{ id: articleId }] = await db.insert(articles).values({ articleNumber: "A-1", name: "Artikel", type: "purchased", unitId: st!.id, salesPrice: "100" }).returning({ id: articles.id });
});
afterEach(async () => app.close());
afterAll(async () => db.execute(TRUNCATE));

const quote = (customerId: string, confirm = false) => ({ customerId, confirm, rows: [{ articleId, quantity: 1 }] });

describe("klienträttigheter per rutt", () => {
  const cases: { name: string; scope: ApiClientScope; method: "GET" | "POST"; url: () => string; payload?: () => unknown }[] = [
    { name: "mallarna", scope: "configurator:read", method: "GET", url: () => "/configurator/templates" },
    { name: "prisfrågan", scope: "prices:read", method: "GET", url: () => `/price-quote?customerId=${ownCustomer}&articleId=${articleId}&quantity=1` },
    { name: "offerten", scope: "quotes:create", method: "POST", url: () => "/quotes", payload: () => quote(ownCustomer) },
    { name: "strukturen", scope: "structure:read", method: "GET", url: () => `/articles/${articleId}/bom` },
  ];
  for (const c of cases) {
    it(`${c.name} needs ${c.scope}`, async () => {
      const others = API_CLIENT_SCOPES.filter((s) => s !== c.scope);
      const without = await clientToken(others);
      const denied = await call(c.method, c.url(), without.auth, c.payload?.());
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("client-scope-missing");
      const withScope = await clientToken([c.scope]);
      expect((await call(c.method, c.url(), withScope.auth, c.payload?.())).statusCode).toBeLessThan(300);
    });
  }

  it("needs orders:confirm for confirm: true, and writes nothing without it", async () => {
    const quoteOnly = await clientToken(["quotes:create"]);
    const denied = await call("POST", "/quotes", quoteOnly.auth, quote(ownCustomer, true));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("client-scope-missing");
    expect(await db.select().from(salesOrders)).toHaveLength(0);
    const both = await clientToken(["quotes:create", "orders:confirm"]);
    const ok = await call("POST", "/quotes", both.auth, quote(ownCustomer, true));
    expect(ok.json().order.status).toBe("confirmed");
  });

  it("needs orders:confirm to confirm an order", async () => {
    const order = (await call("POST", "/quotes", (await clientToken(["quotes:create"])).auth, quote(ownCustomer))).json().order;
    expect((await call("POST", `/sales-orders/${order.id}/confirm`, (await clientToken(["quotes:create"])).auth)).json().code).toBe("client-scope-missing");
    expect((await call("POST", `/sales-orders/${order.id}/confirm`, (await clientToken(["orders:confirm"])).auth)).statusCode).toBe(200);
  });
});

describe("knuten kund", () => {
  it("lets a bound client act on its own customer only", async () => {
    const bound = await clientToken(["quotes:create", "prices:read", "orders:confirm"], ownCustomer);
    const mismatch = await call("POST", "/quotes", bound.auth, quote(otherCustomer));
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json().code).toBe("client-customer-mismatch");
    expect(await db.select().from(salesOrders)).toHaveLength(0);
    expect((await call("GET", `/price-quote?customerId=${otherCustomer}&articleId=${articleId}&quantity=1`, bound.auth)).json().code).toBe("client-customer-mismatch");
    const own = await call("POST", "/quotes", bound.auth, quote(ownCustomer));
    expect(own.statusCode).toBe(201);
    expect((await call("POST", `/sales-orders/${own.json().order.id}/confirm`, bound.auth)).statusCode).toBe(200);
  });

  it("refuses to confirm another customer's order", async () => {
    const other = (await call("POST", "/quotes", (await clientToken(["quotes:create"])).auth, quote(otherCustomer))).json().order;
    const bound = await clientToken(["orders:confirm"], ownCustomer);
    const res = await call("POST", `/sales-orders/${other.id}/confirm`, bound.auth);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("client-customer-mismatch");
    const [row] = await db.select().from(salesOrders).where(eq(salesOrders.id, other.id));
    expect(row!.status).toBe("quote");
    expect((await call("POST", `/sales-orders/${NO_ID}/confirm`, bound.auth)).statusCode).toBe(404);
  });
});

describe("pris från klienten", () => {
  // A client bound to a customer never sets the price: Nav prices the row
  // from the customer's price chain. An unbound (internal) client may.
  const pricedQuote = (customerId: string, row: Record<string, unknown>) => ({ customerId, rows: [{ articleId, quantity: 2, ...row }] });

  it("refuses a bound client's own unit price or discount and writes nothing", async () => {
    const reseller = await clientToken(["quotes:create", "orders:confirm"], ownCustomer);
    for (const row of [{ unitPrice: 0.01 }, { discountPercent: 90 }]) {
      const res = await call("POST", "/quotes", reseller.auth, { ...pricedQuote(ownCustomer, row), confirm: true });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("client-price-not-allowed");
    }
    expect(await db.select().from(salesOrders)).toHaveLength(0);
  });

  it("prices a bound client's row from the price chain", async () => {
    const reseller = await clientToken(["quotes:create"], ownCustomer);
    const res = await call("POST", "/quotes", reseller.auth, pricedQuote(ownCustomer, {}));
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, res.json().order.id));
    expect(Number(row!.unitPrice)).toBe(100);
  });

  it("still lets an internal (unbound) client set the price", async () => {
    const internal = await clientToken([...API_CLIENT_SCOPES]);
    const res = await call("POST", "/quotes", internal.auth, pricedQuote(ownCustomer, { unitPrice: 50 }));
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, res.json().order.id));
    expect(Number(row!.unitPrice)).toBe(50);
  });
});

describe("prisuträkningen i konfiguratorn", () => {
  // A customerId in evaluate is a price lookup: it needs prices:read, and a
  // bound client may only name its own customer. Without a customer the
  // answer is the template's own price (configurator:read is enough).
  const evaluate = (auth: Record<string, string>, body: unknown) =>
    call("POST", `/configurator/${NO_ID}/evaluate`, auth, body);

  it("refuses another customer's prices to a bound client", async () => {
    const website = await clientToken(["configurator:read", "quotes:create", "prices:read"], ownCustomer);
    const res = await evaluate(website.auth, { selection: {}, customerId: otherCustomer });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("client-customer-mismatch");
  });

  it("needs prices:read to price for a customer", async () => {
    const website = await clientToken(["configurator:read", "quotes:create"], ownCustomer);
    const res = await evaluate(website.auth, { selection: {}, customerId: ownCustomer });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("client-scope-missing");
  });

  it("lets the check through with prices:read for the own customer, and without a customer at all", async () => {
    const reseller = await clientToken(["configurator:read", "prices:read"], ownCustomer);
    // NO_ID is no template: getting past the check means the template lookup answers.
    expect((await evaluate(reseller.auth, { selection: {}, customerId: ownCustomer })).json().code).toBe("configurator-template-not-found");
    const website = await clientToken(["configurator:read"], ownCustomer);
    expect((await evaluate(website.auth, { selection: {} })).json().code).toBe("configurator-template-not-found");
  });
});

describe("rättigheterna gäller direkt", () => {
  it("denies the next call with the same token once the scope is removed", async () => {
    const client = await clientToken(["configurator:read", "prices:read"]);
    expect((await call("GET", "/configurator/templates", client.auth)).statusCode).toBe(200);
    await app.inject({ method: "PATCH", url: `/api/v1/api-clients/${client.id}`, headers: { cookie: admin }, payload: { scopes: ["prices:read"] } });
    expect((await call("GET", "/configurator/templates", client.auth)).statusCode).toBe(403);
  });

  it("still answers 401 for a revoked client", async () => {
    const client = await clientToken([...API_CLIENT_SCOPES]);
    await app.inject({ method: "POST", url: `/api/v1/api-clients/${client.id}/revoke`, headers: { cookie: admin } });
    expect((await call("GET", "/configurator/templates", client.auth)).statusCode).toBe(401);
  });

  it("leaves sessions alone", async () => {
    expect((await call("GET", "/configurator/templates", { cookie: admin })).statusCode).toBe(200);
  });
});
