import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import { db, pluginDeliveries, pluginEvents as pluginEventsTable } from "@navet/db";
import { PLUGIN_EVENT_TYPES, type PluginEventType } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import { createPaymentService } from "../src/modules/sales/service/payment.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";
import { pluginEvents } from "../src/modules/system/service/plugin-events.js";
import {
  DEFAULT_POSTING_SETTINGS,
  setupPostingBaseline,
  testArticleService,
  testDocumentPdfService,
  testSystemService,
} from "./helpers/services.js";
import { insertTestPlugin } from "./helpers/plugins.js";

// Tillägg — every event in the catalogue is sent by its own path through the
// REAL services (wired as app.ts does), in the change's own transaction: one
// test per type (some paths send two), plus a rolled-back change that sends
// nothing.

const audit = createAuditRepository(db);
const authRepo = createAuthRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  articleService,
  testSystemService,
  (query) => resolvePrice(db, query)
);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  audit
);
const poster = createVerificationPoster({ read: readPostingSettings });
const pdfStub = {
  async render() {
    return Buffer.alloc(0);
  },
  async renderPaymentReminder() {
    return Buffer.alloc(0);
  },
};
const invoiceService = createInvoiceService(createInvoiceRepository(db), { async sendMail() { return null; } }, pdfStub, poster, audit);
const paymentService = createPaymentService(createPaymentRepository(db), poster, audit);

const TRUNCATE = sql`TRUNCATE plugin_deliveries, plugin_events, plugins, posting_rules, verification_rows, verifications,
  verification_counters, verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments,
  invoice_rows, invoices, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, purchase_receipts, purchase_order_rows,
  purchase_orders, suppliers, mo_reports, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders,
  routing_operations, bom_components, work_centers, stock_transactions, stock_locations, warehouses, articles, audit_log, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'plg-%'`;
const TODAY = new Date().toLocaleDateString("sv-SE");

let pluginId: string;
let userId: string;

async function events(): Promise<{ type: string; entityId: string; entityNumber: string | null; data: unknown }[]> {
  return db
    .select({ type: pluginEventsTable.type, entityId: pluginEventsTable.entityId, entityNumber: pluginEventsTable.entityNumber, data: pluginEventsTable.data })
    .from(pluginEventsTable)
    .orderBy(asc(pluginEventsTable.occurredAt));
}

const typesOf = async () => (await events()).map((e) => e.type);
const clear = () => db.execute(sql`TRUNCATE plugin_deliveries, plugin_events`);

async function makeArticle(type: "purchased" | "manufactured" = "purchased") {
  return articleService.createArticle({ articleNumber: `ART-${crypto.randomUUID().slice(0, 8)}`, name: "Plåt", type, unit: "st", active: true });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID()}`, active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  // Every event, every permission: one delivery per event.
  const plugin = await insertTestPlugin({
    key: "allt",
    events: [...PLUGIN_EVENT_TYPES],
    permissions: ["artiklar", "inkop", "forsaljning", "tillverkning", "lager"],
  });
  pluginId = plugin.id;
  const user = await authRepo.create({ email: `ev-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Händelser", role: "admin" });
  userId = user.id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS });
  pluginEvents.invalidate();
});

describe("every catalogue event is sent by its path", () => {
  const covered = new Set<PluginEventType>();
  const expectEvents = async (expected: { type: PluginEventType; entityId: string; entityNumber: string | null }[]) => {
    const got = await events();
    expect(got.map(({ type, entityId, entityNumber }) => ({ type, entityId, entityNumber }))).toEqual(expected);
    for (const e of expected) covered.add(e.type);
    // One delivery per event to the one subscribing plugin.
    const deliveries = await db.select().from(pluginDeliveries);
    expect(deliveries.length).toBe(got.length);
    expect(deliveries.every((d) => d.pluginId === pluginId)).toBe(true);
  };

  it("article.created and article.updated", async () => {
    const article = await makeArticle();
    await articleService.updateArticle(article.id, { name: "Ny benämning" });
    await articleService.updateStandardCost(article.id, 12.5);
    // The same cost again changes nothing: no event.
    await articleService.updateStandardCost(article.id, 12.5);
    await expectEvents([
      { type: "article.created", entityId: article.id, entityNumber: article.articleNumber },
      { type: "article.updated", entityId: article.id, entityNumber: article.articleNumber },
      { type: "article.updated", entityId: article.id, entityNumber: article.articleNumber },
    ]);
  });

  it("customer.created and customer.updated", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    await salesService.updateCustomer(customer.id, { name: "Kund AB (ny)" });
    await expectEvents([
      { type: "customer.created", entityId: customer.id, entityNumber: customer.customerNumber },
      { type: "customer.updated", entityId: customer.id, entityNumber: customer.customerNumber },
    ]);
  });

  it("supplier.created and supplier.updated", async () => {
    const supplier = await purchaseService.createSupplier({ name: "ACME AB", active: true });
    await purchaseService.updateSupplier(supplier.id, { name: "ACME AB (ny)" });
    await expectEvents([
      { type: "supplier.created", entityId: supplier.id, entityNumber: supplier.supplierNumber },
      { type: "supplier.updated", entityId: supplier.id, entityNumber: supplier.supplierNumber },
    ]);
  });

  it("quote.created, sales_order.confirmed (Bekräfta and Ny kundorder) and sales_order.cancelled", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle();
    await clear();
    const quote = await salesService.createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }] }, userId);
    await salesService.confirm(quote.order.id, userId);
    const confirmed = await salesService.getSalesOrder(quote.order.id);
    const direct = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }] },
      userId
    );
    await salesService.cancel(direct.order.id, userId);
    await expectEvents([
      { type: "quote.created", entityId: quote.order.id, entityNumber: quote.order.orderNumber },
      // The KO- number drawn at the confirmation.
      { type: "sales_order.confirmed", entityId: quote.order.id, entityNumber: confirmed!.orderNumber },
      { type: "sales_order.confirmed", entityId: direct.order.id, entityNumber: direct.order.orderNumber },
      { type: "sales_order.cancelled", entityId: direct.order.id, entityNumber: direct.order.orderNumber },
    ]);
    expect(confirmed!.orderNumber).not.toBe(quote.order.orderNumber);
  });

  it("sales_order.confirmed from Förlorad too; sales_order.cancelled only for an order, once — never for an offert or a stale transition", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle();
    const rows = [{ articleId: article.id, quantity: 1, unitPrice: 10 }];
    await clear();

    // Förlorad → an order status (the manual status) is a confirmation.
    const lost = (await salesService.createQuote({ customerId: customer.id, rows }, userId)).order;
    await salesService.setStatus(lost.id, "lost", userId);
    await salesService.setStatus(lost.id, "confirmed", userId);
    const lostConfirmed = (await salesService.getSalesOrder(lost.id))!;

    // Bekräfta racing Förlorad: the stale fromStatus writes nothing and sends nothing.
    const raced = (await salesService.createQuote({ customerId: customer.id, rows }, userId)).order;
    await salesService.setStatus(raced.id, "lost", userId);
    expect(await salesRepository.updateStatus(raced.id, "confirmed", null, "quote")).toBeNull();

    // A cancelled offert is not a cancelled order.
    const quote = (await salesService.createQuote({ customerId: customer.id, rows }, userId)).order;
    await salesService.cancel(quote.id, userId);

    // An order cancelled twice (Makulera, then the manual status) sends once.
    const order = (await salesService.createQuote({ customerId: customer.id, confirm: true, rows }, userId)).order;
    await salesService.cancel(order.id, userId);
    await salesService.setStatus(order.id, "cancelled", userId);

    await expectEvents([
      { type: "quote.created", entityId: lost.id, entityNumber: lost.orderNumber },
      { type: "sales_order.confirmed", entityId: lost.id, entityNumber: lostConfirmed.orderNumber },
      { type: "quote.created", entityId: raced.id, entityNumber: raced.orderNumber },
      { type: "quote.created", entityId: quote.id, entityNumber: quote.orderNumber },
      { type: "sales_order.confirmed", entityId: order.id, entityNumber: order.orderNumber },
      { type: "sales_order.cancelled", entityId: order.id, entityNumber: order.orderNumber },
    ]);
    expect(lostConfirmed.orderNumber).not.toBe(lost.orderNumber);
  });

  it("sales_order.delivered per följesedel, with the delivery as data — and nothing for a delivery that was rolled back", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle();
    const location = await makeLocation();
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 10, unitPrice: 10 }] },
      userId
    );
    await salesService.startProduction(order.id);
    await clear();

    // Over-delivery fails inside deliverBatch's transaction: no event.
    await expect(
      salesService.deliverBatch(order.id, { locationId: location.id, rows: [{ rowId: rows[0]!.id, quantity: 11 }] }, userId)
    ).rejects.toThrow();
    expect(await events()).toEqual([]);

    const delivery = await salesService.deliverBatch(order.id, { locationId: location.id, rows: [{ rowId: rows[0]!.id, quantity: 4 }] }, userId);
    await expectEvents([{ type: "sales_order.delivered", entityId: order.id, entityNumber: order.orderNumber }]);
    expect((await events())[0]!.data).toEqual({ deliveryId: delivery.deliveryId, deliveryNumber: delivery.deliveryNumber });
  });

  it("invoice.issued and invoice.paid", async () => {
    await setupPostingBaseline();
    await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 5 });
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    await clear();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Leverans", quantity: 1, unitPrice: 800, vatRate: 25 }] },
      userId
    );
    const issued = (await invoiceService.issue(draft!.id, userId))!;
    await paymentService.create(
      { customerId: customer.id, paymentDate: TODAY, bankAccountNumber: "1930", amount: 1000, rows: [{ invoiceId: issued.id, appliedAmount: 1000 }] },
      userId
    );
    await expectEvents([
      { type: "invoice.issued", entityId: issued.id, entityNumber: issued.invoiceNumber },
      { type: "invoice.paid", entityId: issued.id, entityNumber: issued.invoiceNumber },
    ]);
  });

  it("purchase_order.created and purchase_order.received per received row", async () => {
    const supplier = await purchaseService.createSupplier({ name: "ACME AB", active: true });
    const article = await makeArticle();
    const location = await makeLocation();
    await clear();
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, userId);
    const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 10, unitPrice: 42 });
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, userId);
    await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, userId);
    await expectEvents([
      { type: "purchase_order.created", entityId: order.id, entityNumber: order.orderNumber },
      { type: "purchase_order.received", entityId: order.id, entityNumber: order.orderNumber },
      { type: "purchase_order.received", entityId: order.id, entityNumber: order.orderNumber },
    ]);
  });

  it("manufacturing_order.created and manufacturing_order.completed (Slutför order)", async () => {
    const article = await makeArticle("manufactured");
    await clear();
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 2 }, userId);
    await mfgService.complete(mo.id, {}, userId);
    await expectEvents([
      { type: "manufacturing_order.created", entityId: mo.id, entityNumber: mo.orderNumber },
      { type: "manufacturing_order.completed", entityId: mo.id, entityNumber: mo.orderNumber },
    ]);
  });

  it("manufacturing_order.completed when the last operation's report finishes the order (Slutför operation, the terminal's path)", async () => {
    const article = await makeArticle("manufactured");
    const machine = await mfgService.createWorkCenter({ code: "100", name: "Svets", type: "machine", active: true });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
    await makeLocation();
    await clear();
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 2 }, userId);
    const [first, last] = (await mfgService.listOperations(mo.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
    await mfgService.completeOperation(first!.id, {}, userId);
    // A partial report on the last operation receives goods but doesn't finish.
    await mfgService.completeOperation(last!.id, { quantityCompleted: 1, quantityScrapped: 0 }, userId);
    await mfgService.completeOperation(last!.id, { quantityCompleted: 1, quantityScrapped: 0 }, userId);
    await expectEvents([
      { type: "manufacturing_order.created", entityId: mo.id, entityNumber: mo.orderNumber },
      { type: "manufacturing_order.completed", entityId: mo.id, entityNumber: mo.orderNumber },
    ]);
  });

  it("manufacturing_order.completed when a lego receipt reports the last operation", async () => {
    const supplier = await purchaseService.createSupplier({ name: "Lego AB", active: true });
    const machine = await mfgService.createWorkCenter({ code: "100", name: "Svets", type: "machine", active: true });
    const lego = await mfgService.createWorkCenter({ code: "900", name: "Ytbehandling AB", type: "subcontract", supplierId: supplier.id, active: true });
    const article = await makeArticle("manufactured");
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
    await mfgService.createRoutingOperation(article.id, { sequenceNo: 20, workCenterId: lego.id, setupTime: 0, runTimePerUnit: 0, unitPrice: 100 });
    const location = await makeLocation();
    const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 4 }, userId);
    const legoOp = (await mfgService.listOperations(mo.id)).find((op) => op.sequenceNo === 20)!;
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, userId);
    const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 4, unitPrice: 100, moOperationId: legoOp.id });
    await purchaseService.confirm(order.id);
    await clear();
    const received = await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, userId);
    expect(received.operationReport).toEqual({ ok: true });
    const types = await typesOf();
    expect(types.sort()).toEqual(["manufacturing_order.completed", "purchase_order.received"]);
    const completed = (await events()).find((e) => e.type === "manufacturing_order.completed")!;
    expect(completed).toMatchObject({ entityId: mo.id, entityNumber: mo.orderNumber });
  });

  it("covers the whole catalogue", () => {
    expect([...covered].sort()).toEqual([...PLUGIN_EVENT_TYPES].sort());
  });
});
