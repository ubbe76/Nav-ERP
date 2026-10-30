import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { effectiveOverDeliveryPercent } from "@navet/shared";
import { buildApp } from "../src/app.js";

// Tillåten överleverans till kund (#24): the system setting, the customer's
// own choice (Systemets förval / Tillåt / Tillåt inte) and what a delivery
// past the ordered quantity then means for the order.

const TRUNCATE = sql`TRUNCATE sales_orders, customers, stock_transactions, stock_locations, warehouses, articles, audit_log, users CASCADE`;
const PASSWORD = "ett-tillräckligt-långt-lösenord";

let app: ReturnType<typeof buildApp>;
let admin: string;

const cookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
const call = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { cookie: admin }, ...(payload === undefined ? {} : { payload: payload as never }) });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  app = buildApp();
  await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: "admin@example.com", password: PASSWORD, name: "Admin", setupCode: app.setup.code.code },
  });
  admin = cookieOf(await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: PASSWORD } }));
});

afterEach(async () => {
  await db.execute(sql`DELETE FROM system_settings WHERE key = 'sales_over_delivery_percent'`);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticle(articleNumber: string) {
  const res = await call("POST", "/articles", { articleNumber, name: `Artikel ${articleNumber}`, type: "purchased", unit: "st", active: true });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

// A customer with the given Överleverans and an order of 10 (+ 5 of a second
// article), started so it can be delivered.
async function makeOrder(customerFields: Record<string, unknown> = {}) {
  const customer = (await call("POST", "/customers", { name: "Kök & Bad AB", active: true, ...customerFields })).json() as { id: string };
  const screw = await makeArticle(`SK-${crypto.randomUUID().slice(0, 6)}`);
  const nut = await makeArticle(`MU-${crypto.randomUUID().slice(0, 6)}`);
  const res = await call("POST", "/quotes", {
    customerId: customer.id,
    confirm: true,
    rows: [
      { articleId: screw.id, quantity: 10, unitPrice: 20 },
      { articleId: nut.id, quantity: 5, unitPrice: 5 },
    ],
  });
  expect(res.statusCode).toBe(201);
  const { order } = res.json() as { order: { id: string } };
  expect((await call("POST", `/sales-orders/${order.id}/start-production`)).statusCode).toBe(200);
  const rows = (await call("GET", `/sales-orders/${order.id}/rows`)).json() as { id: string; articleId: string }[];
  return {
    customerId: customer.id,
    orderId: order.id,
    screwRow: rows.find((r) => r.articleId === screw.id)!.id,
    nutRow: rows.find((r) => r.articleId === nut.id)!.id,
  };
}

const deliver = (orderId: string, rowId: string, quantity: number) =>
  call("POST", `/sales-orders/${orderId}/deliver`, { rows: [{ rowId, quantity }] });
const setSystem = (percent: number | null) => call("PATCH", "/settings", { salesOverDeliveryPercent: percent });

describe("effectiveOverDeliveryPercent", () => {
  it("lets the customer's choice win over the system setting", () => {
    expect(effectiveOverDeliveryPercent({ overDelivery: null, overDeliveryPercent: null }, 10)).toBe(10);
    expect(effectiveOverDeliveryPercent({ overDelivery: null, overDeliveryPercent: null }, null)).toBeNull();
    expect(effectiveOverDeliveryPercent({ overDelivery: "deny", overDeliveryPercent: null }, 10)).toBe(0);
    expect(effectiveOverDeliveryPercent({ overDelivery: "allow", overDeliveryPercent: "5.00" }, 0)).toBe(5);
    expect(effectiveOverDeliveryPercent({ overDelivery: "allow", overDeliveryPercent: null }, 0)).toBeNull();
  });
});

describe("Tillåten överleverans på kundorder", () => {
  it("never delivers more than ordered by default, and names the limit when refusing", async () => {
    expect((await call("GET", "/settings")).json().salesOverDeliveryPercent).toBe(0);
    const o = await makeOrder();
    expect((await call("GET", `/sales-orders/${o.orderId}`)).json().overDeliveryPercent).toBe(0);
    const res = await deliver(o.orderId, o.screwRow, 11);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "over-delivery", allowedPercent: 0, maxQuantity: 10 });
  });

  it("follows the system percentage up to the limit, and the order is delivered", async () => {
    expect((await setSystem(10)).json().salesOverDeliveryPercent).toBe(10);
    const o = await makeOrder();
    expect((await call("GET", `/sales-orders/${o.orderId}`)).json().overDeliveryPercent).toBe(10);
    expect((await deliver(o.orderId, o.screwRow, 11)).statusCode).toBe(201);
    const refused = await deliver(o.orderId, o.screwRow, 0.5);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ allowedPercent: 10, maxQuantity: 11 });

    // The other row still open: an edit of the over-delivered row that keeps
    // its quantity goes through; a reduction below delivered does not.
    expect((await call("PATCH", `/sales-orders/${o.orderId}/rows/${o.screwRow}`, { quantity: 10, unitPrice: 21 })).statusCode).toBe(200);
    expect((await call("PATCH", `/sales-orders/${o.orderId}/rows/${o.screwRow}`, { quantity: 9 })).statusCode).toBe(409);

    const result = await deliver(o.orderId, o.nutRow, 5);
    expect(result.json().orderStatus).toBe("delivered");

    // Invoiced as delivered: 11 of the 10 ordered.
    const invoiceable = (await call("GET", `/invoiceable-orders?customerId=${o.customerId}`)).json() as {
      rows: { salesOrderRowId: string; rest: number }[];
    }[];
    const screwRest = invoiceable.flatMap((order) => order.rows).find((r) => r.salesOrderRowId === o.screwRow);
    expect(screwRest?.rest).toBe(11);
  });

  it("lets the customer deny, allow its own percentage or allow without limit", async () => {
    await setSystem(10);
    const denied = await makeOrder({ overDelivery: "deny" });
    expect((await deliver(denied.orderId, denied.screwRow, 10.5)).json()).toMatchObject({ code: "over-delivery", allowedPercent: 0 });

    const own = await makeOrder({ overDelivery: "allow", overDeliveryPercent: 5 });
    expect((await call("GET", `/sales-orders/${own.orderId}`)).json().overDeliveryPercent).toBe(5);
    expect((await deliver(own.orderId, own.screwRow, 10.5)).statusCode).toBe(201);
    expect((await deliver(own.orderId, own.screwRow, 0.5)).json()).toMatchObject({ allowedPercent: 5, maxQuantity: 10.5 });

    const unlimited = await makeOrder({ overDelivery: "allow" });
    expect((await call("GET", `/sales-orders/${unlimited.orderId}`)).json().overDeliveryPercent).toBeNull();
    expect((await deliver(unlimited.orderId, unlimited.screwRow, 50)).statusCode).toBe(201);
  });

  it("delivers without limit when the system setting is empty", async () => {
    await setSystem(null);
    const o = await makeOrder();
    expect((await deliver(o.orderId, o.screwRow, 30)).statusCode).toBe(201);
  });
});

describe("Överleverans on the customer card", () => {
  it("keeps the percentage only with Tillåt", async () => {
    const customer = (await call("POST", "/customers", { name: "Kök & Bad AB", active: true, overDelivery: "deny", overDeliveryPercent: 5 })).json();
    expect(customer).toMatchObject({ overDelivery: "deny", overDeliveryPercent: null });

    const allowed = (await call("PATCH", `/customers/${customer.id}`, { overDelivery: "allow", overDeliveryPercent: 7.5 })).json();
    expect(allowed).toMatchObject({ overDelivery: "allow", overDeliveryPercent: "7.50" });
    // The percentage alone, while Tillåt: changed.
    expect((await call("PATCH", `/customers/${customer.id}`, { overDeliveryPercent: 3 })).json().overDeliveryPercent).toBe("3.00");

    const back = (await call("PATCH", `/customers/${customer.id}`, { overDelivery: null })).json();
    expect(back).toMatchObject({ overDelivery: null, overDeliveryPercent: null });
    // The percentage alone without Tillåt is dropped, never a constraint error.
    const alone = await call("PATCH", `/customers/${customer.id}`, { overDeliveryPercent: 4 });
    expect(alone.statusCode).toBe(200);
    expect(alone.json().overDeliveryPercent).toBeNull();
  });
});
