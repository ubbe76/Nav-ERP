import { createArticleSchema, createStockLocationSchema } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { customers, db, permissionGroups, salesOrderRows, salesOrders } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import type { SalesOrderDeliveryOutlook } from "../src/modules/planning/service/delivery-outlook.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";

// GET /sales-orders/:id/delivery-outlook through the real app: the answer's
// shape, 404, who may ask (DELIVERY_CHECK — Försäljning or Tillverkning; a
// read-only account too, it is a GET) and that no price leaves with it. The
// rules are in delivery-outlook.test.ts (pure) and
// delivery-outlook.integration.test.ts (Postgres).

const articleService = createArticleService(createArticleRepository(db));
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const stockService = createStockService(createStockRepository(db));
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, articles, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'DOL%'`;

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
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const promised = addDays(today, 30);

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
    .values({ code: `DOL${crypto.randomUUID().slice(0, 6)}`, name: "Leveransläge", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
const get = (cookie: string, orderId: string) => app.inject({ url: `/api/v1/sales-orders/${orderId}/delivery-outlook`, headers: { cookie } });

// A confirmed order of 5 st of a purchased article with 3 st on the shelf.
async function world(status: "quote" | "confirmed" = "confirmed") {
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `A-${crypto.randomUUID().slice(0, 8)}`, name: "Beslag", type: "purchased", active: true, standardCost: 12.5 })
  );
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const place = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
  await stockService.recordTransaction({ articleId: article.id, locationId: place.id, quantityDelta: 3, transactionType: "inventory_adjustment" });
  const [customer] = await db.insert(customers).values({ customerNumber: `K${crypto.randomUUID().slice(0, 6)}`, name: "Kund AB" }).returning();
  const [order] = await db
    .insert(salesOrders)
    .values({ orderNumber: `KO-${crypto.randomUUID().slice(0, 6)}`, customerId: customer!.id, status, expectedDeliveryDate: promised })
    .returning();
  const [row] = await db
    .insert(salesOrderRows)
    .values({ salesOrderId: order!.id, articleId: article.id, quantityOrdered: "5", unitPrice: "777.25", discountPercent: "10" })
    .returning();
  return { article, order: order!, row: row! };
}

describe("GET /sales-orders/:id/delivery-outlook", () => {
  it("answers the order's outlook and its rows — and no price", async () => {
    const w = await world();
    const res = await get(await adminCookie(), w.order.id);
    expect(res.statusCode, res.body).toBe(200);
    const body: SalesOrderDeliveryOutlook = res.json();
    expect(body).toEqual({
      salesOrderId: w.order.id,
      orderNumber: w.order.orderNumber,
      orderStatus: "confirmed",
      today,
      status: "uncovered",
      daysLate: 0,
      atRisk: true,
      promisedDate: promised,
      estimatedDeliveryDate: null,
      counts: { late: 0, uncovered: 1, undated: 0, componentLate: 0 },
      rows: [
        {
          salesOrderRowId: w.row.id,
          articleId: w.article.id,
          articleNumber: w.article.articleNumber,
          articleName: "Beslag",
          restQuantity: 5,
          configured: false,
          promisedDate: promised,
          promisedShipDate: promised,
          allocations: [
            { kind: "stock", documentId: null, documentNumber: null, quantity: 3, readyDate: today, late: false, undated: false, daysLate: 0, isDraft: false, componentLate: false },
          ],
          uncovered: 2,
          readyDate: null,
          estimatedShipDate: null,
          estimatedDeliveryDate: null,
          status: "uncovered",
          daysLate: 0,
          componentLate: false,
          overdue: false,
          atRisk: true,
        },
      ],
    });
    // Priser är kontorsdata: nothing that smells of money in the answer.
    expect(res.body).not.toMatch(/price|cost|amount|discount|margin|777\.25/i);
  });

  it("a quote answers none without rows", async () => {
    const w = await world("quote");
    const res = await get(await adminCookie(), w.order.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ salesOrderId: w.order.id, orderStatus: "quote", status: "none", atRisk: false, rows: [] });
  });

  it("404 sales-order-not-found for an unknown order, 400 for a malformed id", async () => {
    const cookie = await adminCookie();
    const res = await get(cookie, crypto.randomUUID());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "sales-order-not-found" });
    expect((await get(cookie, "not-a-uuid")).statusCode).toBe(400);
  });

  it("is read by Försäljning, by Tillverkning and by a read-only account — not by Inköp alone, not without a session", async () => {
    const w = await world();
    expect((await get(await userCookie(["forsaljning"]), w.order.id)).statusCode).toBe(200);
    expect((await get(await userCookie(["tillverkning"]), w.order.id)).statusCode).toBe(200);
    expect((await get(await userCookie(["forsaljning"], true), w.order.id)).statusCode).toBe(200);
    const denied = await get(await userCookie(["inkop"]), w.order.id);
    expect(denied.statusCode).toBe(403);
    expect((await get(await userCookie(["inkop", "lager"]), w.order.id)).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/sales-orders/${w.order.id}/delivery-outlook` })).statusCode).toBe(401);
  });
});
