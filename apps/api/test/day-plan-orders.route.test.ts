import { createArticleSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { customers, db, permissionGroups, purchaseOrderRows, purchaseOrders, salesOrderRows, salesOrders, suppliers } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import type { DayPlanOrdersResult } from "../src/modules/planning/service/day-plan-orders.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";

// GET /planning/day-plan/orders through the real app: the shape, that no
// price leaves with it, the dagplan's window and who may read it —
// customers and suppliers are office data, so the workshop profile that
// reads the dagplan itself gets 403 here. The rules are in
// day-plan-orders.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE sales_order_rows, sales_orders, customers, purchase_order_rows, purchase_orders, suppliers, stock_transactions, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'DPO%'`;

let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
});

const today = stockholmToday();
const yesterday = (() => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();

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
    .values({ code: `DPO${crypto.randomUUID().slice(0, 6)}`, name: "Dagplan", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const get = (cookie: string, query = "") => app.inject({ url: `/api/v1/planning/day-plan/orders${query}`, headers: { cookie } });

// One kundorder row to ship today and one inköpsorder row to arrive today,
// both with prices that must not leave.
async function world() {
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `A-${crypto.randomUUID().slice(0, 8)}`, name: "Beslag", type: "purchased", active: true, standardCost: 12.5 })
  );
  const [customer] = await db.insert(customers).values({ customerNumber: `K${crypto.randomUUID().slice(0, 6)}`, name: "Kund AB" }).returning();
  const [order] = await db
    .insert(salesOrders)
    .values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 6)}`, customerId: customer!.id, status: "confirmed", expectedDeliveryDate: today })
    .returning();
  await db.insert(salesOrderRows).values({ salesOrderId: order!.id, articleId: article.id, quantityOrdered: "5", unitPrice: "777.25", discountPercent: "10" });
  const [supplier] = await db.insert(suppliers).values({ supplierNumber: `L${crypto.randomUUID().slice(0, 6)}`, name: "Leverantör AB" }).returning();
  const [po] = await db
    .insert(purchaseOrders)
    .values({ orderNumber: `IO-${crypto.randomUUID().slice(0, 6)}`, supplierId: supplier!.id, status: "confirmed", expectedDeliveryDate: today })
    .returning();
  await db.insert(purchaseOrderRows).values({ purchaseOrderId: po!.id, articleId: article.id, quantityOrdered: "8", unitPrice: "333.75" });
  return { article, order: order!, po: po! };
}

describe("GET /planning/day-plan/orders", () => {
  it("answers the day's shipments and arrivals — and no price", async () => {
    const w = await world();
    const res = await get(await adminCookie());
    expect(res.statusCode, res.body).toBe(200);
    const body: DayPlanOrdersResult = res.json();
    expect(body).toMatchObject({ today, date: today, previousDate: null });
    expect(body.shipments).toEqual([
      expect.objectContaining({ orderNumber: w.order.orderNumber, customerName: "Kund AB", restQuantity: 5, shipDate: today, status: "on_time" }),
    ]);
    // Covered by the inköpsorder that arrives the same day.
    expect(body.shipments[0]!.allocations).toEqual([expect.objectContaining({ kind: "purchase_order", documentNumber: w.po.orderNumber, quantity: 5 })]);
    expect(body.arrivals).toEqual([
      expect.objectContaining({ orderNumber: w.po.orderNumber, supplierName: "Leverantör AB", restQuantity: 8, arrivalDate: today }),
    ]);
    expect(res.body).not.toMatch(/price|cost|amount|discount|margin|777\.25|333\.75/i);
  });

  it("400 outside the dagplan's window, 400 for a malformed date", async () => {
    const cookie = await adminCookie();
    const past = await get(cookie, `?date=${yesterday}`);
    expect(past.statusCode).toBe(400);
    expect(past.json()).toMatchObject({ code: "day-plan-date-out-of-range" });
    expect((await get(cookie, "?date=2030-02-30")).statusCode).toBe(400);
  });

  it("is read with any menu and by a read-only account — not by the workshop profile, not without a session", async () => {
    await world();
    expect((await get(await userCookie(["inkop"]))).statusCode).toBe(200);
    expect((await get(await userCookie(["tillverkning"], true))).statusCode).toBe(200);
    const workshop = await userCookie(["tillverkningsorder_las", "terminal"]);
    expect((await app.inject({ url: "/api/v1/planning/day-plan", headers: { cookie: workshop } })).statusCode).toBe(200);
    expect((await get(workshop)).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/v1/planning/day-plan/orders" })).statusCode).toBe(401);
  });
});
