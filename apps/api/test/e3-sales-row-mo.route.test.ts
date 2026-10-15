import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { db, salesOrderRows } from "@navet/db";
import { testArticleService, testDocumentPdfService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { manufacturingRoutes } from "../src/modules/manufacturing/routes/manufacturing.routes.js";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
// Konfigurator 4b: the row-configuration reader the sales service needs for
// PUT .../configuration — the same wiring as app.ts, taken from the 4b helper.
import { configurator, rowConfiguration } from "./helpers/configured-rows.js";

// Package 5 (uppföljningssvepet): route-level coverage for E3's KO→TO link
// error mappings — manufacturing.routes.ts's inline mapper on
// POST /sales-orders/:id/rows/:rowId/manufacturing-order, and sales.routes.
// ts's DELETE /sales-orders/:id/rows/:rowId RowHasManufacturingOrdersError
// branch. Previously only the service layer was covered
// (test/manufacturing-sales-link.test.ts). App-boot pattern (services +
// TRUNCATE list + buildApp with a fake req.user) copied verbatim from that
// file, which registers the same two route plugins the same way.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({
  async sendMail() {
    /* no-op fake transport — not exercised by these tests */
  },
}));
const documentPdfService = createDocumentPdfService(systemService);
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  undefined,
  undefined,
  undefined,
  undefined,
  rowConfiguration
);

const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});

const TRUNCATE = sql`TRUNCATE mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, configurator_templates, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `e3-route-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Producer",
    role: "admin",
  });
}

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

async function makeArticle(type: "manufactured" | "purchased" = "manufactured", salesPrice?: number) {
  return articleService.createArticle({
    articleNumber: `ART-E3-ROUTE-${crypto.randomUUID()}`,
    name: "Länkad artikel",
    type,
    unit: "st",
    active: true,
    salesPrice,
  });
}

async function makeOrderRow(opts: { confirm: boolean; type?: "manufactured" | "purchased"; quantity?: number }) {
  const user = await makeUser();
  const customer = await makeCustomer();
  const article = await makeArticle(opts.type ?? "manufactured");
  const { order, rows } = await salesService.createQuote(
    {
      customerId: customer.id,
      confirm: opts.confirm,
      rows: [{ articleId: article.id, quantity: opts.quantity ?? 10, unitPrice: 100 }],
    },
    user.id
  );
  return { user, customer, article, order, row: rows[0]! };
}

async function buildApp() {
  const routeUser = await makeUser();
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = routeUser as any;
  });
  await app.register(manufacturingRoutes, { service: mfgService });
  await app.register(salesRoutes, { service: salesService });
  return app;
}

describe("POST /sales-orders/:id/rows/:rowId/manufacturing-order", () => {
  it("404s (no code — this branch predates errorBody) for an unknown row", async () => {
    const { order } = await makeOrderRow({ confirm: true });
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/sales-orders/${order.id}/rows/00000000-0000-0000-0000-000000000000/manufacturing-order`,
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("linked-row-not-found");
    await app.close();
  });

  it("400s linked-row-not-manufactured for a row whose article is purchased", async () => {
    const { order, row } = await makeOrderRow({ confirm: true, type: "purchased" });
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/sales-orders/${order.id}/rows/${row.id}/manufacturing-order`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("linked-row-not-manufactured");
    await app.close();
  });

  it("409s linked-order-status for a row still on a quote (not confirmed)", async () => {
    const { order, row } = await makeOrderRow({ confirm: false });
    expect(order.status).toBe("quote");
    const app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/sales-orders/${order.id}/rows/${row.id}/manufacturing-order`,
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("linked-order-status");
    await app.close();
  });
});

describe("DELETE /sales-orders/:id/rows/:rowId", () => {
  it("409s row-has-manufacturing-orders when a (non-deleted) TO is linked to the row", async () => {
    const { order, row } = await makeOrderRow({ confirm: true, quantity: 10 });
    await mfgService.createManufacturingOrder({ quantity: 4, salesOrderRowId: row.id }, null);
    const app = await buildApp();

    const res = await app.inject({
      method: "DELETE",
      url: `/sales-orders/${order.id}/rows/${row.id}`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("row-has-manufacturing-orders");
    await app.close();
  });
});

// Konfigurator 4b: Ändra konfiguration — the route's own error mappings. The
// service rules are covered in sales-row-configuration.test.ts.
describe("PUT /sales-orders/:id/rows/:rowId/configuration", () => {
  it("400s configuration-not-allowed for an ordinary row", async () => {
    const { order, row } = await makeOrderRow({ confirm: false });
    const app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: `/sales-orders/${order.id}/rows/${row.id}/configuration`,
      payload: { selection: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("configuration-not-allowed");
    await app.close();
  });

  it("409s row-configuration-locked once the configured row has a delivery", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const template = await makeArticle("manufactured", 1000);
    await configurator.createTemplate(template.id, { mode: "to_order" });
    const lock = await configurator.createGroup(template.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
    await configurator.createValue(template.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: template.id, quantity: 2, configuration: { selection: { LOCK: "A" } } }] },
      user.id
    );
    await db.update(salesOrderRows).set({ quantityDelivered: "1" }).where(eq(salesOrderRows.id, rows[0]!.id));
    const app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: `/sales-orders/${order.id}/rows/${rows[0]!.id}/configuration`,
      payload: { selection: { LOCK: "A" } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("row-configuration-locked");
    await app.close();
  });

  it("404s sales-order-row-not-found for an unknown row", async () => {
    const { order } = await makeOrderRow({ confirm: false });
    const app = await buildApp();

    const res = await app.inject({
      method: "PUT",
      url: `/sales-orders/${order.id}/rows/00000000-0000-0000-0000-000000000000/configuration`,
      payload: { selection: {} },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("sales-order-row-not-found");
    await app.close();
  });
});
