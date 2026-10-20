import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { db, deliveryRows, shipmentDeliveries, shipments } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";

// Ångra utleverans — the route's status codes and error envelope (the
// service rules themselves are in sales-delivery-undo.test.ts).

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const salesService = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  mailService,
  createDocumentPdfService(systemService),
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query)
);

const TRUNCATE = sql`TRUNCATE shipment_deliveries, shipments, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function setup() {
  const user = await authRepo.create({
    email: `undo-route-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Säljare",
    role: "admin",
  });
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
  const article = await articleService.createArticle({
    articleNumber: `ART-UNDO-R-${crypto.randomUUID().slice(0, 8)}`,
    name: "Artikel",
    type: "purchased",
    unit: "st",
    active: true,
  });
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
  await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
  const { order, rows } = await salesService.createQuote(
    { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 10, unitPrice: 10 }] },
    user.id
  );
  await salesService.startProduction(order.id);
  const delivery = await salesService.deliverBatch(
    order.id,
    { locationId: location.id, rows: [{ rowId: rows[0]!.id, quantity: 10 }] },
    user.id
  );
  const [deliveryRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, delivery.deliveryId));

  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = user as any;
  });
  await app.register(salesRoutes, { service: salesService });
  const undoUrl = `/sales-orders/${order.id}/deliveries/${delivery.deliveryId}/rows/${deliveryRow!.id}/undo`;
  return { app, customer, order, delivery, deliveryRow: deliveryRow!, undoUrl };
}

describe("POST /sales-orders/:id/deliveries/:deliveryId/rows/:deliveryRowId/undo", () => {
  it("200 with the undone row and the new order status, then 409 delivery-row-already-undone", async () => {
    const { app, deliveryRow, undoUrl } = await setup();

    const ok = await app.inject({ method: "POST", url: undoUrl });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ deliveryRowId: deliveryRow.id, orderStatus: "in_production" });
    expect(typeof ok.json().undoneAt).toBe("string");

    const again = await app.inject({ method: "POST", url: undoUrl });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("delivery-row-already-undone");
  });

  it("404 delivery-not-found / delivery-row-not-found", async () => {
    const { app, order, delivery } = await setup();

    const noDelivery = await app.inject({
      method: "POST",
      url: `/sales-orders/${order.id}/deliveries/${crypto.randomUUID()}/rows/${crypto.randomUUID()}/undo`,
    });
    expect(noDelivery.statusCode).toBe(404);
    expect(noDelivery.json().code).toBe("delivery-not-found");

    const noRow = await app.inject({
      method: "POST",
      url: `/sales-orders/${order.id}/deliveries/${delivery.deliveryId}/rows/${crypto.randomUUID()}/undo`,
    });
    expect(noRow.statusCode).toBe(404);
    expect(noRow.json().code).toBe("delivery-row-not-found");
  });

  it("409 delivery-row-not-undoable for a row without a stock link", async () => {
    const { app, deliveryRow, undoUrl } = await setup();
    await db.update(deliveryRows).set({ stockTransactionId: null, locationId: null }).where(eq(deliveryRows.id, deliveryRow.id));

    const res = await app.inject({ method: "POST", url: undoUrl });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("delivery-row-not-undoable");
  });

  it("409 delivery-on-shipment with a Swedish message naming the shipment", async () => {
    const { app, customer, delivery, undoUrl } = await setup();
    const [shipment] = await db
      .insert(shipments)
      .values({
        shipmentNumber: "FR-ROUTE-1",
        customerId: customer.id,
        recipientName: "Kund AB",
        pickupDate: "2030-01-07",
        pickupFrom: "08:00",
        pickupTo: "16:00",
      })
      .returning();
    await db.insert(shipmentDeliveries).values({ shipmentId: shipment!.id, deliveryId: delivery.deliveryId });

    const res = await app.inject({ method: "POST", url: undoUrl });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "delivery-on-shipment" });
    expect(res.json().error).toContain(`Följesedel ${delivery.deliveryNumber} ligger på försändelse FR-ROUTE-1`);
  });

  it("the pallet card of a fully undone följesedel is 409 delivery-undone", async () => {
    const { app, delivery, undoUrl } = await setup();
    await app.inject({ method: "POST", url: undoUrl });

    const res = await app.inject({ method: "GET", url: `/deliveries/${delivery.deliveryId}/pallet-card` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("delivery-undone");
  });
});
