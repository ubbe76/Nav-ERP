import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, purchaseOrders } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const documentPdfService = createDocumentPdfService(systemService);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  // Lego (Etapp G): SubcontractOperationReporter — never reached in this
  // suite, and loud if it ever is.
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  }
);
// Automatkontering (B2): the service takes a poster since approve/cancel are
// bookkeeping events. This suite only ever cancels a DRAFT (nothing is
// booked), so the fixed-settings stub is never actually called — it exists
// because the constructor requires it.
const invoicePoster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
const supplierInvoiceService = createSupplierInvoiceService(createSupplierInvoiceRepository(db), invoicePoster);

// 2f fixture only: a released lego (subcontract) operation, so a pure lego
// receipt (no purchase_receipt stock transaction) can be exercised below.
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), documentPdfService, articleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});

// The B1/B2 bookkeeping tables join the list so a leftover verification from
// an earlier suite can never keep supplier_invoices from being truncated
// (supplier_invoices.verification_id is ON DELETE restrict). mo_operations/
// manufacturing_orders/routing_operations/work_centers/production_groups are
// the 2f lego fixture's tables.
const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, supplier_invoice_rows, supplier_invoices, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `basis-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Basis",
    role: "admin",
  });
}

async function makeArticle(articleNumber: string) {
  return articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", active: true });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

// A released MO with one lego (subcontract) operation, and a supplier to
// order it from — minimal fixture for the 2f "pure lego IO" test below.
async function makeLegoOperation() {
  const user = await makeUser();
  const supplier = await purchaseService.createSupplier({ name: `Lego AB ${crypto.randomUUID()}`, active: true });
  const lego = await mfgService.createWorkCenter({
    code: String(100 + Math.floor(Math.random() * 800)),
    name: "Ytbehandling",
    type: "subcontract",
    supplierId: supplier.id,
    active: true,
  });
  const parent = await articleService.createArticle({
    articleNumber: `LEGO-B-${crypto.randomUUID()}`,
    name: "Legodetalj",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 10,
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: 0,
    unitPrice: 50,
  });
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 2 }, user.id);
  const legoOp = (await mfgService.listOperations(order.id))[0]!;
  return { user, supplier, parent, legoOp };
}

async function makeReceivedOrder(opts?: { supplierName?: string; qty?: number; price?: number; received?: number }) {
  const user = await makeUser();
  const supplier = await purchaseService.createSupplier({ name: opts?.supplierName ?? "Lev AB", active: true });
  const article = await makeArticle(`ART-B-${crypto.randomUUID()}`);
  const location = await makeLocation();
  const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
  const qty = opts?.qty ?? 10;
  const price = opts?.price ?? 25;
  const row = await purchaseService.addRow(order.id, { articleId: article.id, quantity: qty, unitPrice: price });
  await purchaseService.confirm(order.id);
  const received = opts?.received ?? qty;
  await purchaseService.receiveGoods(order.id, row.id, { locationId: location.id, quantity: received }, user.id);
  return { user, supplier, article, order, row, received, price };
}

describe("purchase invoice basis (fakturaunderlag)", () => {
  it("lists a received order with received value and receipt date", async () => {
    const { order, received, price } = await makeReceivedOrder({ qty: 10, price: 25, received: 6 });
    const basis = await purchaseService.listInvoiceBasis({ limit: 50, offset: 0 });
    const entry = basis.rows.find((r) => r.id === order.id);
    expect(entry).toBeTruthy();
    expect(Number(entry!.receivedValue)).toBe(received * price); // 6 × 25 = 150
    expect(entry!.receivedAt).toBeTruthy();
    expect(entry!.invoiceId).toBeNull();
  });

  it("excludes draft/confirmed orders (only inlevererade appear)", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "Ej mottaget AB", active: true });
    const article = await makeArticle(`ART-D-${crypto.randomUUID()}`);
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.addRow(order.id, { articleId: article.id, quantity: 3, unitPrice: 10 });
    await purchaseService.confirm(order.id); // confirmed, not received

    const basis = await purchaseService.listInvoiceBasis({ invoiced: "all", limit: 50, offset: 0 });
    expect(basis.rows.some((r) => r.id === order.id)).toBe(false);
  });

  it("moves an order to invoiced when a live supplier invoice is linked; a cancelled one does not count", async () => {
    const user = await makeUser();
    const { order, supplier } = await makeReceivedOrder({ qty: 5, price: 20, received: 5 });

    let uninvoiced = await purchaseService.listInvoiceBasis({ invoiced: "uninvoiced", limit: 50, offset: 0 });
    expect(uninvoiced.rows.some((r) => r.id === order.id)).toBe(true);

    // A cancelled linked invoice must NOT mark the order as invoiced.
    const cancelledInv = await supplierInvoiceService.create(
      { supplierId: supplier.id, invoiceNumber: "C-1", invoiceDate: "2026-07-01", purchaseOrderId: order.id, rows: [] },
      user.id
    );
    await supplierInvoiceService.cancel(cancelledInv!.id, user.id);
    uninvoiced = await purchaseService.listInvoiceBasis({ invoiced: "uninvoiced", limit: 50, offset: 0 });
    expect(uninvoiced.rows.some((r) => r.id === order.id)).toBe(true);

    // A live linked invoice drops the order from the worklist.
    const inv = await supplierInvoiceService.create(
      { supplierId: supplier.id, invoiceNumber: "L-1", invoiceDate: "2026-07-02", purchaseOrderId: order.id, rows: [] },
      user.id
    );
    uninvoiced = await purchaseService.listInvoiceBasis({ invoiced: "uninvoiced", limit: 50, offset: 0 });
    expect(uninvoiced.rows.some((r) => r.id === order.id)).toBe(false);

    const invoiced = await purchaseService.listInvoiceBasis({ invoiced: "invoiced", limit: 50, offset: 0 });
    const entry = invoiced.rows.find((r) => r.id === order.id);
    expect(entry).toBeTruthy();
    expect(entry!.invoiceId).toBe(inv!.id);
    expect(entry!.invoiceRegistrationNumber).toBe(inv!.registrationNumber);
  });

  it("filters by supplierId and search, and 'all' shows regardless of invoice status", async () => {
    const a = await makeReceivedOrder({ supplierName: "Alfa AB" });
    const b = await makeReceivedOrder({ supplierName: "Beta AB" });

    const bySupplier = await purchaseService.listInvoiceBasis({ supplierId: a.supplier.id, limit: 50, offset: 0 });
    expect(bySupplier.rows.every((r) => r.supplierId === a.supplier.id)).toBe(true);
    expect(bySupplier.rows.some((r) => r.id === a.order.id)).toBe(true);
    expect(bySupplier.rows.some((r) => r.id === b.order.id)).toBe(false);

    const bySearch = await purchaseService.listInvoiceBasis({ search: b.order.orderNumber, limit: 50, offset: 0 });
    expect(bySearch.total).toBe(1);
    expect(bySearch.rows[0]!.id).toBe(b.order.id);

    // Invoice a, then "all" still lists both orders.
    const user = await makeUser();
    await supplierInvoiceService.create(
      { supplierId: a.supplier.id, invoiceNumber: "ALL-1", invoiceDate: "2026-07-01", purchaseOrderId: a.order.id, rows: [] },
      user.id
    );
    const all = await purchaseService.listInvoiceBasis({ invoiced: "all", limit: 50, offset: 0 });
    expect(all.rows.some((r) => r.id === a.order.id)).toBe(true);
    expect(all.rows.some((r) => r.id === b.order.id)).toBe(true);
  });

  // 2f: a pure lego IO never books a purchase_receipt (the units come home
  // via the MO's own mo_receipt), so the receivedAt subquery is null even
  // though the order is fully received — the listing must fall back to the
  // order's updated_at rather than showing no date at all.
  it("falls back to the order's updated_at for a pure lego receipt (no purchase_receipt to derive receivedAt from)", async () => {
    const { user, supplier, parent, legoOp } = await makeLegoOperation();
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const row = await purchaseService.addRow(order.id, {
      articleId: parent.id,
      quantity: 2,
      unitPrice: 50,
      moOperationId: legoOp.id,
    });
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row.id, { quantity: 2 }, user.id);

    const basis = await purchaseService.listInvoiceBasis({ limit: 50, offset: 0 });
    const entry = basis.rows.find((r) => r.id === order.id);
    expect(entry).toBeTruthy();
    expect(entry!.receivedAt).toBeTruthy();

    const [dbOrder] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, order.id));
    expect(new Date(entry!.receivedAt as unknown as string).getTime()).toBe(dbOrder!.updatedAt.getTime());
  });
});
