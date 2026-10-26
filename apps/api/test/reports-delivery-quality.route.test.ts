import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Leveransprecision — Gruppera: Motpart through the real app: per supplier
// the precision of its received orders plus the quality columns from the
// avvikelser (the month view is unchanged), and the CSV. Made-up data.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE deviations, purchase_receipts, purchase_order_rows, purchase_orders, suppliers, customers, stock_transactions, stock_locations, warehouses, articles, user_settings, audit_log, users CASCADE`;

let app: ReturnType<typeof buildApp>;
let cookie: string;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  cookie = `session=${res.cookies.find((c) => c.name === "session")!.value}`;
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
});

const get = (url: string) => app.inject({ method: "GET", url: `/api/v1${url}`, headers: { cookie } });
const post = (url: string, payload?: unknown) => app.inject({ method: "POST", url: `/api/v1${url}`, headers: { cookie }, payload });

const isoDate = (offsetDays: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

async function receivedOrder(supplierId: string, articleId: string, expected: string) {
  const po = (await post("/purchase-orders", { supplierId, expectedDeliveryDate: expected })).json();
  const row = (await post(`/purchase-orders/${po.id}/rows`, { articleId, quantity: 4, unitPrice: 10 })).json();
  expect((await post(`/purchase-orders/${po.id}/confirm`)).statusCode).toBeLessThan(300);
  expect((await post(`/purchase-orders/${po.id}/rows/${row.id}/receive`, { quantity: 4 })).statusCode).toBeLessThan(300);
  return po;
}

describe("leveransprecision per motpart", () => {
  it("adds deviations, defect-free share, claimed quantity and cost per supplier; the CSV follows", async () => {
    const article = (await post("/articles", { articleNumber: `LQ-${crypto.randomUUID().slice(0, 6)}`, name: "Plåt 2 mm", type: "purchased" })).json();
    const steel = (await post("/suppliers", { name: "Exempel Stål AB" })).json();
    const bolts = (await post("/suppliers", { name: "Exempel Fäste AB" })).json();
    const late = await receivedOrder(steel.id, article.id, isoDate(-3));
    await receivedOrder(steel.id, article.id, isoDate(5));
    await receivedOrder(bolts.id, article.id, isoDate(5));

    const claim = (await post("/deviations", { type: "supplier", title: "Repig plåt", supplierId: steel.id, purchaseOrderId: late.id, articleId: article.id, quantity: 3 })).json();
    await post(`/deviations/${claim.id}/costs`, { kind: "material", amount: 500 });
    await post(`/deviations/${claim.id}/costs`, { kind: "recovery", amount: 100 });
    // A cancelled case never counts.
    const cancelled = (await post("/deviations", { type: "supplier", title: "Dubblett", supplierId: bolts.id, quantity: 9 })).json();
    await post(`/deviations/${cancelled.id}/cancel`, { reason: "Dubblett" });

    const month = (await get("/reports/delivery-precision")).json();
    expect(month.groupBy).toBe("month");
    expect(month.purchase.counterparties).toBeUndefined();
    expect(month.purchase.totals.total).toBe(3);

    const res = await get("/reports/delivery-precision?groupBy=counterparty");
    expect(res.statusCode).toBe(200);
    const purchase = res.json().purchase.counterparties;
    expect(purchase.rows.map((r: { counterpartyName: string }) => r.counterpartyName)).toEqual(["Exempel Fäste AB", "Exempel Stål AB"]);
    expect(purchase.rows[1]).toMatchObject({
      counterpartyId: steel.id,
      total: 2,
      onTime: 1,
      late: 1,
      precisionPct: 50,
      deviations: 1,
      ordersWithDeviation: 1,
      defectFreePct: 50,
      claimedQuantity: 3,
      claimedUnit: "st",
      deviationCost: 400,
    });
    expect(purchase.rows[0]).toMatchObject({ total: 1, deviations: 0, ordersWithDeviation: 0, defectFreePct: 100, claimedQuantity: null, deviationCost: 0 });
    expect(purchase.totals).toMatchObject({ total: 3, deviations: 1, defectFreePct: 67, deviationCost: 400 });
    expect(res.json().sales.counterparties).toEqual({ rows: [], totals: expect.objectContaining({ total: 0, deviations: 0 }) });

    const csv = await get("/reports/delivery-precision/csv?kind=purchase&groupBy=counterparty");
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-disposition"]).toContain("leveransprecision-purchase-motpart-");
    expect(csv.body).toContain("Leverantör;Antal ordrar;I tid;Försenade;Precision %");
    expect(csv.body).toContain("Avvikelsekostnad");
    expect(csv.body).toContain("Exempel Stål AB");
    expect(csv.body).toContain("Totalt");
    expect((await get("/reports/delivery-precision?groupBy=bogus")).statusCode).toBe(400);
  });
});
