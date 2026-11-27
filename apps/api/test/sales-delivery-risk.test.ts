import { createArticleSchema, createStockLocationSchema, listSalesOrdersQuerySchema, splitLateFilter, type AlertsResponse, type SalesOrderListOutlook } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { customers, db, salesOrderRows, salesOrders } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createDeliveryRiskReader } from "../src/modules/planning/service/delivery-risk.js";
import type { SalesOrderDeliveryOutlook } from "../src/modules/planning/service/delivery-outlook.js";
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createSalesService, type DeliveryRiskReader } from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { addDays, stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { unwiredSalesOrderLinks } from "./helpers/unwired.js";

// Leverans i fara in the kundorder list (leveransläget, etapp 3c): the
// filter `status=delivery_risk`, the mark on the rows and the CSV column —
// and that the list, the alert Kundordrar med leverans i fara and the
// planning service's deliveryRiskOrderIds are the same orders. Through the
// real app, so the late binding in app.ts (deliveryRiskRef) is what runs.
// The outlook's own rules are in delivery-outlook*.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const stockService = createStockService(createStockRepository(db));
// The planning service on its own, as app.ts builds it for what this test
// reads (no order is ever created through it).
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: {
    createPurchaseOrder: async () => {
      throw new Error("not used");
    },
    addRow: async () => {},
    cancel: async () => {},
  },
  manufacturing: createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, unwiredSalesOrderLinks),
});
const PASSWORD = "correcthorsebattery";

const TABLES = sql`TRUNCATE sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, articles, audit_log, user_settings, users CASCADE`;

let app: ReturnType<typeof buildApp>;
let cookie: string;
let placeId: string;
beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  cookie = `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  placeId = (await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }))).id;
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
});

const today = stockholmToday();
const AHEAD = addDays(today, 30);
const PAST = addDays(today, -3);
let seq = 0;

// One order of `quantity` st of its own purchased article with `stock` st on
// the shelf: short ⇒ Saknar täckning (at risk), covered ⇒ I tid.
async function order(opts: { status?: "quote" | "confirmed" | "in_production" | "delivered"; promised?: string | null; quantity?: number; stock?: number; delivered?: number }) {
  const article = await articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `A-${crypto.randomUUID().slice(0, 8)}`, name: "Beslag", type: "purchased", active: true })
  );
  if (opts.stock) {
    await stockService.recordTransaction({ articleId: article.id, locationId: placeId, quantityDelta: opts.stock, transactionType: "inventory_adjustment" });
  }
  const [customer] = await db.insert(customers).values({ customerNumber: `K${crypto.randomUUID().slice(0, 6)}`, name: "Kund AB" }).returning();
  seq += 1;
  const [created] = await db
    .insert(salesOrders)
    .values({
      orderNumber: `KO-${String(seq).padStart(5, "0")}`,
      customerId: customer!.id,
      status: opts.status ?? "confirmed",
      expectedDeliveryDate: opts.promised === undefined ? AHEAD : opts.promised,
    })
    .returning();
  await db.insert(salesOrderRows).values({
    salesOrderId: created!.id,
    articleId: article.id,
    quantityOrdered: String(opts.quantity ?? 5),
    quantityDelivered: String(opts.delivered ?? 0),
    unitPrice: "777.25",
  });
  return created!;
}

type ListRow = { id: string; orderNumber: string; status: string; deliveryOutlook: SalesOrderListOutlook | null };
async function list(query: string) {
  const res = await app.inject({ url: `/api/v1/sales-orders${query}`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { rows: ListRow[]; total: number };
}
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

// Three at risk (one of them also Sen, one in production), one late but
// covered, one on time, a quote and a delivered order.
async function world() {
  const short = await order({ stock: 3 });
  const shortLate = await order({ status: "in_production", promised: PAST });
  const shortUndated = await order({ promised: null });
  const lateCovered = await order({ promised: PAST, stock: 5 });
  const onTime = await order({ stock: 5 });
  const quote = await order({ status: "quote" });
  const delivered = await order({ status: "delivered", delivered: 5 });
  return { short, shortLate, shortUndated, lateCovered, onTime, quote, delivered, atRisk: [short, shortLate, shortUndated] };
}

describe("GET /sales-orders?status=delivery_risk", () => {
  it("lists exactly the orders of the alert group, of deliveryRiskOrderIds and of the cards' own answer", async () => {
    const w = await world();
    const listed = await list("?status=delivery_risk");
    expect(ids(listed.rows)).toEqual(ids(w.atRisk));
    expect(listed.total).toBe(3);

    // The alert group the list is opened from.
    const alerts = await app.inject({ url: "/api/v1/alerts?kinds=sales_order_delivery_risk", headers: { cookie } });
    expect(alerts.statusCode, alerts.body).toBe(200);
    const group = (alerts.json() as AlertsResponse).groups.find((g) => g.kind === "sales_order_delivery_risk")!;
    expect(group).toMatchObject({ count: 3, error: false, listHref: "/forsaljning/ordrar?status=delivery_risk" });
    expect(group.items.map((i) => i.key).sort()).toEqual(ids(listed.rows));

    // The planning service's own list, and the adapter app.ts binds.
    expect((await planningService.deliveryRiskOrderIds()).sort()).toEqual(ids(listed.rows));
    const reader = createDeliveryRiskReader(planningService);
    expect([...(await reader.deliveryRiskOutlooks()).keys()].sort()).toEqual(ids(listed.rows));
    expect((await reader.deliveryRiskOrders()).map((o) => o.orderId).sort()).toEqual(ids(listed.rows));

    // And what each card says: atRisk for those three, for no other order.
    for (const o of [w.short, w.shortLate, w.shortUndated, w.lateCovered, w.onTime, w.quote, w.delivered]) {
      const res = await app.inject({ url: `/api/v1/sales-orders/${o.id}/delivery-outlook`, headers: { cookie } });
      expect((res.json() as SalesOrderDeliveryOutlook).atRisk).toBe(w.atRisk.includes(o));
    }
  });

  it("total follows the filter and the paging stays in SQL", async () => {
    const w = await world();
    const first = await list("?status=delivery_risk&limit=2");
    expect(first.total).toBe(3);
    expect(first.rows).toHaveLength(2);
    const second = await list("?status=delivery_risk&limit=2&offset=2");
    expect(second.total).toBe(3);
    expect(second.rows).toHaveLength(1);
    expect(ids([...first.rows, ...second.rows])).toEqual(ids(w.atRisk));
    // The list's own order: newest order number first.
    expect([...first.rows, ...second.rows].map((r) => r.orderNumber)).toEqual(
      w.atRisk.map((o) => o.orderNumber).sort().reverse()
    );
    // Search and kind narrow it like any other filter.
    expect((await list(`?status=delivery_risk&search=${w.short.orderNumber}`)).total).toBe(1);
    expect((await list("?status=delivery_risk&kind=quote")).total).toBe(0);
  });

  it("together with Sen or a real status all apply", async () => {
    const w = await world();
    expect(ids((await list("?status=late")).rows)).toEqual(ids([w.shortLate, w.lateCovered]));
    const both = await list("?status=delivery_risk,late");
    expect(ids(both.rows)).toEqual([w.shortLate.id]);
    expect(both.total).toBe(1);
    expect(ids((await list("?status=delivery_risk,in_production")).rows)).toEqual([w.shortLate.id]);
    expect(ids((await list("?status=delivery_risk,confirmed")).rows)).toEqual(ids([w.short, w.shortUndated]));
    expect((await list("?status=delivery_risk,delivered")).total).toBe(0);
    expect((await list("?status=delivery_risk,late,confirmed")).total).toBe(0);
  });

  it("nothing at risk answers an empty list, not every order", async () => {
    await order({ stock: 5 });
    expect(await list("?status=delivery_risk")).toEqual({ rows: [], total: 0 });
  });

  it("is a value of the kundorder list only", async () => {
    expect(listSalesOrdersQuerySchema.safeParse({ status: "delivery_risk,late,confirmed" }).success).toBe(true);
    expect(listSalesOrdersQuerySchema.safeParse({ status: "component_late" }).success).toBe(false);
    for (const url of ["/api/v1/purchase-orders?status=delivery_risk", "/api/v1/manufacturing-orders?status=delivery_risk"]) {
      expect((await app.inject({ url, headers: { cookie } })).statusCode).toBe(400);
    }
    expect(splitLateFilter(["confirmed", "delivery_risk"])).toEqual({ statuses: ["confirmed"], late: false, componentLate: false, deliveryRisk: true });
    expect(splitLateFilter(["late"])).toEqual({ statuses: undefined, late: true, componentLate: false, deliveryRisk: false });
    expect(splitLateFilter(undefined)).toEqual({ statuses: undefined, late: false, componentLate: false, deliveryRisk: false });
  });
});

describe("deliveryOutlook on the list's rows", () => {
  it("marks the page's rows that are a demand; a quote and a closed order have none", async () => {
    const w = await world();
    const listed = await list("?withOutlook=true");
    const outlook = (o: { id: string }) => listed.rows.find((r) => r.id === o.id)!.deliveryOutlook;
    expect(listed.total).toBe(7);
    expect(outlook(w.short)).toEqual({ status: "uncovered", daysLate: 0, atRisk: true });
    expect(outlook(w.shortLate)).toEqual({ status: "uncovered", daysLate: 0, atRisk: true });
    expect(outlook(w.shortUndated)).toEqual({ status: "uncovered", daysLate: 0, atRisk: true });
    // Promised three days ago but on the shelf: the lists' Sen, not at risk.
    expect(outlook(w.lateCovered)).toEqual({ status: "on_time", daysLate: 0, atRisk: false });
    expect(outlook(w.onTime)).toEqual({ status: "on_time", daysLate: 0, atRisk: false });
    expect(outlook(w.quote)).toBeNull();
    expect(outlook(w.delivered)).toBeNull();
    // The filtered list carries the same mark as the plain one.
    const filtered = await list("?status=delivery_risk&withOutlook=true");
    expect(filtered.rows).toHaveLength(3);
    for (const row of filtered.rows) expect(row.deliveryOutlook).toEqual({ status: "uncovered", daysLate: 0, atRisk: true });
    // The offert list: nothing.
    expect((await list("?kind=quote&withOutlook=true")).rows.map((r) => r.deliveryOutlook)).toEqual([null]);
  });

  it("is opt-in: without withOutlook=true no row carries a mark — the filter still finds its orders", async () => {
    const w = await world();
    for (const q of ["", "?withOutlook=false", "?status=confirmed,in_production&limit=1000"]) {
      expect((await list(q)).rows.map((r) => r.deliveryOutlook).filter((o) => o !== null), q).toEqual([]);
    }
    const filtered = await list("?status=delivery_risk");
    expect(ids(filtered.rows)).toEqual(ids(w.atRisk));
    expect(filtered.rows.map((r) => r.deliveryOutlook)).toEqual([null, null, null]);
    expect((await app.inject({ url: "/api/v1/sales-orders?withOutlook=ja", headers: { cookie } })).statusCode).toBe(400);
  });

  it("the CSV has the column Leveransläge as text — only when asked for with withOutlook=true", async () => {
    const w = await world();
    const without = await app.inject({ url: "/api/v1/sales-orders/csv?kind=order", headers: { cookie } });
    expect(without.statusCode, without.body).toBe(200);
    expect(without.body.replace(/^\uFEFF/, "").split(/\r?\n/)[0]!.split(";").slice(0, 5)).toEqual(["Ordernummer", "Offertnummer", "Kund", "Status", "Leveransdatum"]);
    const res = await app.inject({ url: "/api/v1/sales-orders/csv?kind=order&withOutlook=true", headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    const lines = res.body.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l !== "");
    const header = lines[0]!.split(";");
    expect(header.slice(0, 6)).toEqual(["Ordernummer", "Offertnummer", "Kund", "Status", "Leveransläge", "Leveransdatum"]);
    const cell = (o: { orderNumber: string }) => lines.find((l) => l.startsWith(`${o.orderNumber};`))!.split(";")[4];
    expect(cell(w.short)).toBe("Saknar täckning");
    expect(cell(w.onTime)).toBe("I tid");
    expect(cell(w.delivered)).toBe("");
    expect(res.body).not.toContain("777");
    const filtered = await app.inject({ url: "/api/v1/sales-orders/csv?kind=order&status=delivery_risk&withOutlook=true", headers: { cookie } });
    expect(filtered.body.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l !== "")).toHaveLength(4);
  });
});

// The service on its own — the fixtures that build it without the planning
// service, and what it asks of the reader.
describe("listSalesOrders and its DeliveryRiskReader", () => {
  const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
  function service(repo: ReturnType<typeof createSalesRepository>, reader: DeliveryRiskReader | null) {
    return createSalesService(
      repo,
      createRegisterService(createRegisterRepository(db)),
      mailService,
      testDocumentPdfService,
      stockService,
      articleService,
      testSystemService,
      (query) => resolvePrice(db, query),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reader
    );
  }
  const query = (input: Record<string, string>) => listSalesOrdersQuerySchema.parse(input);

  it("without a reader the filter answers an empty list and asks the database nothing", async () => {
    await order({});
    const untouchable = {
      ...createSalesRepository(db),
      listSalesOrders: async () => {
        throw new Error("the list must not be read");
      },
    };
    expect(await service(untouchable, null).listSalesOrders(query({ status: "delivery_risk" }))).toEqual({ rows: [], total: 0 });
    expect(await service(untouchable, null).listSalesOrders(query({ status: "delivery_risk,confirmed" }))).toEqual({ rows: [], total: 0 });
    // The plain list still works, with no mark.
    const plain = await service(createSalesRepository(db), null).listSalesOrders(query({}));
    expect(plain.rows.map((r) => r.deliveryOutlook)).toEqual([null]);
  });

  it("the filter is one load: the ids and the marks together; the plain list asks only for the rows that are a demand", async () => {
    const a = await order({});
    const b = await order({});
    const quote = await order({ status: "quote" });
    const calls: string[] = [];
    const mark: SalesOrderListOutlook = { status: "late", daysLate: 2, atRisk: true };
    const reader: DeliveryRiskReader = {
      deliveryRiskOutlooks: async () => {
        calls.push("risk");
        return new Map([[a.id, mark]]);
      },
      outlookByOrder: async (orderIds) => {
        calls.push(`page:${[...orderIds].sort().join(",")}`);
        return new Map([[b.id, { status: "on_time", daysLate: 0, atRisk: false }]]);
      },
    };
    const svc = service(createSalesRepository(db), reader);
    const filtered = await svc.listSalesOrders(query({ status: "delivery_risk", withOutlook: "true" }));
    expect(filtered.total).toBe(1);
    expect(filtered.rows.map((r) => [r.id, r.deliveryOutlook])).toEqual([[a.id, mark]]);
    expect(calls).toEqual(["risk"]);

    calls.length = 0;
    const plain = await svc.listSalesOrders(query({ withOutlook: "true" }));
    expect(calls).toEqual([`page:${[a.id, b.id].sort().join(",")}`]);
    expect(plain.rows.find((r) => r.id === b.id)!.deliveryOutlook).toEqual({ status: "on_time", daysLate: 0, atRisk: false });
    // Absent from the reader's answer, and a quote: no mark.
    expect(plain.rows.find((r) => r.id === a.id)!.deliveryOutlook).toBeNull();
    expect(plain.rows.find((r) => r.id === quote.id)!.deliveryOutlook).toBeNull();

    // A page of quotes never calls the reader.
    calls.length = 0;
    await svc.listSalesOrders(query({ kind: "quote", withOutlook: "true" }));
    expect(calls).toEqual([]);

    // Without the flag (the order pickers, the Översikt's counts): the plain
    // list never calls the reader, and the filter only for its ids.
    const unmarked = await svc.listSalesOrders(query({}));
    expect(calls).toEqual([]);
    expect(unmarked.rows.map((r) => r.deliveryOutlook)).toEqual([null, null, null]);
    const riskOnly = await svc.listSalesOrders(query({ status: "delivery_risk" }));
    expect(calls).toEqual(["risk"]);
    expect(riskOnly.rows.map((r) => [r.id, r.deliveryOutlook])).toEqual([[a.id, null]]);
  });
});
