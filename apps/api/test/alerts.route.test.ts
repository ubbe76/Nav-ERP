import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { customers, db, permissionGroups, salesOrderRows, salesOrders } from "@navet/db";
import type { AlertsResponse } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { testArticleService } from "./helpers/services.js";
import { ALERT_KIND_CATALOG } from "../src/modules/alerts/service/alert-kinds.js";

// GET /alerts through the real app: the response shape, the kinds filtered
// by the session user's permissions, and that a read-only account may read
// it (a GET passes the readOnlyGuard like every other read).

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";

const TRUNCATE = sql`TRUNCATE sales_order_rows, sales_orders, customers, stock_transactions, articles, user_settings, users, audit_log CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'AVI%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function adminCookie() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return login(email);
}

async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `AVI${crypto.randomUUID().slice(0, 6)}`, name: "Aviseringar", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

// A confirmed order with rest, due last year — late whatever today is.
async function lateSalesOrder() {
  const [customer] = await db.insert(customers).values({ customerNumber: `K${crypto.randomUUID().slice(0, 6)}`, name: "Kund AB" }).returning();
  const article = await testArticleService.createArticle({ articleNumber: `A-${crypto.randomUUID().slice(0, 8)}`, name: "Vara", type: "purchased", unit: "st", active: true });
  const [order] = await db
    .insert(salesOrders)
    .values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 6)}`, customerId: customer!.id, status: "confirmed", expectedDeliveryDate: "2020-01-01" })
    .returning();
  await db.insert(salesOrderRows).values({ salesOrderId: order!.id, articleId: article.id, quantityOrdered: "1", unitPrice: "10" });
  return order!;
}

describe("GET /alerts", () => {
  it("401s without a session and 403s a user without any menu permission", async () => {
    expect((await app.inject({ url: "/api/v1/alerts" })).statusCode).toBe(401);
    const cookie = await userCookie(["terminal"]);
    expect((await app.inject({ url: "/api/v1/alerts", headers: { cookie } })).statusCode).toBe(403);
  });

  it("answers the admin with every kind in catalog order, in the documented shape", async () => {
    const order = await lateSalesOrder();
    const res = await app.inject({ url: "/api/v1/alerts", headers: { cookie: await adminCookie() } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AlertsResponse;
    expect(Date.parse(body.computedAt)).not.toBeNaN();
    expect(body.groups.map((g) => g.kind)).toEqual(ALERT_KIND_CATALOG.map((d) => d.kind));
    for (const g of body.groups) {
      expect(g).toEqual({
        kind: expect.any(String),
        label: expect.any(String),
        severity: expect.stringMatching(/^(red|yellow)$/),
        count: expect.any(Number),
        listHref: expect.any(String),
        items: expect.any(Array),
        error: false,
        message: null,
      });
    }
    const late = body.groups.find((g) => g.kind === "sales_order_late")!;
    expect(late.count).toBe(1);
    expect(late.items).toHaveLength(1);
    expect(late.items[0]).toEqual({
      key: order.id,
      severity: "yellow",
      href: `/forsaljning/ordrar/${order.id}`,
      primary: `${order.orderNumber} Kund AB`,
      secondary: expect.stringMatching(/^\d+ dagar försenad · leveransdatum 2020-01-01$/),
      date: "2020-01-01",
    });
  });

  it("gives a user with only Inköp the purchase kinds — never the late sales order, never the admin-only mail kind", async () => {
    await lateSalesOrder();
    const res = await app.inject({ url: "/api/v1/alerts", headers: { cookie: await userCookie(["inkop"]) } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AlertsResponse;
    expect(body.groups.map((g) => g.kind)).toEqual(["supplier_invoice_due", "purchase_order_late", "purchase_needed"]);
  });

  it("lets a read-only account read it", async () => {
    const res = await app.inject({ url: "/api/v1/alerts", headers: { cookie: await userCookie(["inkop", "forsaljning"], true) } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as AlertsResponse).groups.map((g) => g.kind)).toEqual([
      "customer_invoice_overdue",
      "supplier_invoice_due",
      "einvoice_failed",
      "sales_order_late",
      "purchase_order_late",
      "purchase_needed",
    ]);
  });
});
