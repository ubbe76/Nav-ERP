import { createArticleSchema } from "@navet/shared";
import type { AlertsResponse } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  customers,
  db,
  permissionGroups,
  purchaseOrderRows,
  purchaseOrders,
  salesOrderRows,
  salesOrders,
  suppliers,
} from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { testArticleService } from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";

// Fler kort på Översikten: the two API additions the new cards read —
// GET /alerts?kinds= (one card per alert kind without the behovsberäkning)
// and the order lists' deliveryTo + sort=delivery (Leveranser/Inleveranser
// denna vecka). Made-up data.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE purchase_order_rows, purchase_orders, suppliers, sales_order_rows, sales_orders, customers, stock_transactions, articles, user_settings, users, audit_log CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'OVK%'`;

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

async function userCookie(permissions: string[]) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `OVK${crypto.randomUUID().slice(0, 6)}`, name: "Översiktskort", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id });
  return login(email);
}

const day = (offset: number) => {
  const d = new Date(`${stockholmToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const get = (url: string, cookie: string) => app.inject({ url: `/api/v1${url}`, headers: { cookie } });

describe("GET /alerts?kinds=", () => {
  it("narrows to the given kinds in catalog order, never beyond what the user may see; an unknown kind is 400", async () => {
    const admin = await adminCookie();
    const narrowed = await get("/alerts?kinds=quote_followup,customer_invoice_overdue", admin);
    expect(narrowed.statusCode).toBe(200);
    expect((narrowed.json() as AlertsResponse).groups.map((g) => g.kind)).toEqual(["customer_invoice_overdue", "quote_followup"]);

    // Inköp may not see quotes: asking for them gives nothing for that kind.
    const purchasing = await userCookie(["inkop"]);
    const onlyTheirs = await get("/alerts?kinds=quote_followup,supplier_invoice_due", purchasing);
    expect((onlyTheirs.json() as AlertsResponse).groups.map((g) => g.kind)).toEqual(["supplier_invoice_due"]);

    expect((await get("/alerts?kinds=quote_followup,bogus", admin)).statusCode).toBe(400);
    // Empty = every visible kind, as without the parameter.
    const all = (await get("/alerts", admin)).json() as AlertsResponse;
    expect(((await get("/alerts?kinds=", admin)).json() as AlertsResponse).groups.map((g) => g.kind)).toEqual(all.groups.map((g) => g.kind));
  });
});

describe("the order lists' deliveryTo and sort=delivery", () => {
  async function article() {
    return testArticleService.createArticle(
      parsed(createArticleSchema, { articleNumber: `A-${crypto.randomUUID().slice(0, 8)}`, name: "Vara", type: "purchased", active: true })
    );
  }

  it("keeps the kundordrar whose Nästa leveransdatum is on or before the day, earliest first, late ones included and undated never", async () => {
    const admin = await adminCookie();
    const [customer] = await db.insert(customers).values({ customerNumber: "K1", name: "Exempel Storkök AB" }).returning();
    const item = await article();
    const order = async (number: string, header: string | null, rows: { date: string | null; delivered?: boolean }[]) => {
      const [o] = await db
        .insert(salesOrders)
        .values({ orderNumber: number, customerId: customer!.id, status: "confirmed", expectedDeliveryDate: header })
        .returning();
      for (const row of rows) {
        await db.insert(salesOrderRows).values({
          salesOrderId: o!.id,
          articleId: item.id,
          quantityOrdered: "1",
          quantityDelivered: row.delivered ? "1" : "0",
          unitPrice: "10",
          expectedDeliveryDate: row.date,
        });
      }
    };
    await order("KO-1", day(10), [{ date: null }]); // after the day
    await order("KO-2", "2020-01-01", [{ date: null }]); // late
    await order("KO-3", day(10), [{ date: day(2) }]); // a row earlier than the header
    await order("KO-4", null, [{ date: null }]); // undated
    await order("KO-5", day(1), [{ date: day(1), delivered: true }, { date: day(20) }]); // the open row decides
    await order("KO-6", day(6), [{ date: null }]); // the day itself

    const res = await get(`/sales-orders?status=confirmed,in_production&deliveryTo=${day(6)}&sort=delivery&limit=10`, admin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: { orderNumber: string; nextDeliveryDate: string }[]; total: number };
    expect(body.rows.map((r) => [r.orderNumber, r.nextDeliveryDate])).toEqual([
      ["KO-2", "2020-01-01"],
      ["KO-3", day(2)],
      ["KO-6", day(6)],
    ]);
    expect(body.total).toBe(3);
    // The list order without sort is unchanged (newest number first).
    const plain = (await get("/sales-orders?limit=10", admin)).json() as { rows: { orderNumber: string }[] };
    expect(plain.rows.map((r) => r.orderNumber)).toEqual(["KO-6", "KO-5", "KO-4", "KO-3", "KO-2", "KO-1"]);
    expect((await get("/sales-orders?deliveryTo=2026-13-40", admin)).statusCode).toBe(400);
    expect((await get("/sales-orders?sort=bogus", admin)).statusCode).toBe(400);
  });

  it("keeps the inköpsordrar whose arrival date is on or before the day — a confirmation wins over the requested date", async () => {
    const admin = await adminCookie();
    const [supplier] = await db.insert(suppliers).values({ supplierNumber: "L1", name: "Exempel Stål AB" }).returning();
    const item = await article();
    const order = async (number: string, header: { expected?: string; confirmed?: string }, row: { expected?: string; confirmed?: string } = {}) => {
      const [o] = await db
        .insert(purchaseOrders)
        .values({
          orderNumber: number,
          supplierId: supplier!.id,
          status: "confirmed",
          expectedDeliveryDate: header.expected ?? null,
          confirmedDeliveryDate: header.confirmed ?? null,
        })
        .returning();
      await db.insert(purchaseOrderRows).values({
        purchaseOrderId: o!.id,
        articleId: item.id,
        quantityOrdered: "4",
        unitPrice: "10",
        expectedDeliveryDate: row.expected ?? null,
        confirmedDeliveryDate: row.confirmed ?? null,
      });
    };
    await order("IO-1", { expected: day(2), confirmed: day(12) }); // confirmed later than the week
    await order("IO-2", { expected: day(12) }, { confirmed: day(3) }); // the row's confirmation is inside
    await order("IO-3", { expected: "2020-02-01" }); // late
    await order("IO-4", {}); // undated

    const res = await get(`/purchase-orders?status=confirmed,partially_received&deliveryTo=${day(6)}&sort=delivery`, admin);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { rows: { orderNumber: string; nextDeliveryDate: string }[]; total: number };
    expect(body.rows.map((r) => [r.orderNumber, r.nextDeliveryDate])).toEqual([
      ["IO-3", "2020-02-01"],
      ["IO-2", day(3)],
    ]);
    expect(body.total).toBe(2);
  });
});
