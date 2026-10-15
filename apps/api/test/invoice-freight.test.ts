import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { customers, db, salesOrderRows, shipmentDeliveries, shipments } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import {
  createInvoiceService,
  InvalidShipmentInvoiceRowError,
  ShipmentAlreadyInvoicedError,
} from "../src/modules/sales/service/invoice.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createShippingRepository } from "../src/modules/shipping/repository/shipping.repository.js";
import { createFreightSettingsService } from "../src/modules/shipping/service/freight-settings.service.js";
import { createShippingService } from "../src/modules/shipping/service/shipping.service.js";
import { FreightCancelInProgressError, ShipmentOnDraftInvoiceError } from "../src/modules/shipping/service/shipping.errors.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { FreightAlreadyInvoicedError, ShipmentNotBillableError } from "../src/modules/sales/service/sales.errors.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createFakeFreightProvider } from "./helpers/fake-freight-provider.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { enableFreight, makeArticle, makeCustomer, makeDelivery } from "./helpers/shipping-fixtures.js";

// Frakt etapp 2 — the freight row on the customer invoice: a booked shipment
// is billed exactly once (pre-check + the partial unique index), the row is
// bound to the freight article, and the collective invoicing routine picks the
// freight up after the order rows. Wiring mirrors collective-invoicing.test.ts;
// shipments are written straight to the DB (no Sendify involved).

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);

const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail() {},
});

const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const invoiceRepo = createInvoiceRepository(db);
const invoicePoster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });

let freightArticleId: string;
const invoiceService = createInvoiceService(
  invoiceRepo,
  mailService,
  documentPdfService,
  invoicePoster,
  createAuditRepository(db),
  articleService,
  { freightArticleId: async () => freightArticleId }
);

const shippingRepo = createShippingRepository(db);
const noAudit = { log: async () => {} };
// The fake broker only matters for Avboka (cancel with the freight on a draft
// invoice) — the shipments themselves are written straight to the DB.
const fake = createFakeFreightProvider();
const shippingService = createShippingService({
  repo: shippingRepo,
  settings: createFreightSettingsService({ repo: shippingRepo, audit: noAudit, providerFactory: fake.factory }),
  audit: noAudit,
});

// "Lägg till frakt" on the order (setFreightRow) — the other way a freight
// can be billed, which must refuse once the shipment is on an invoice.
const salesService = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  mailService,
  documentPdfService,
  createStockService(createStockRepository(db)),
  articleService,
  systemService,
  (query) => resolvePrice(db, query)
);

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_documents, invoice_rows, invoices, shipment_tracking_events, shipment_files, shipment_parcels, shipment_deliveries, shipments, freight_products, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

let biller: string;
let seq = 0;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  await enableFreight();
  fake.calls.length = 0;
  Object.assign(fake.state, { cancelError: null, cancelDelayMs: 0 });
  biller = (
    await authRepo.create({
      email: `freight-${crypto.randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      name: "Biller",
      role: "admin",
    })
  ).id;
  freightArticleId = (await makeArticle({ type: "service", articleNumber: "F", name: "Frakt" })).id;
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// A customer (given or new) with one delivered order row of 2 st and its följesedel.
async function deliveredOrder(given?: { id: string }) {
  const customer = given ?? (await makeCustomer());
  const article = await makeArticle({ weight: 5 });
  const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 2 }], { status: "delivered" });
  const [orderRow] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, delivery.orderId));
  return { customer, delivery: { ...delivery, articleId: article.id, orderRowId: orderRow!.id } };
}

// A booked shipment over one delivery of `orderId`, customer price 450.
async function bookedShipment(customerId: string, deliveryId: string, over: Partial<typeof shipments.$inferInsert> = {}) {
  const [s] = await db
    .insert(shipments)
    .values({
      shipmentNumber: `FR-T-${Date.now() % 1_000_000}-${++seq}`,
      status: "booked",
      providerShipmentId: `snd-${seq}`,
      customerId,
      recipientName: "Mottagare AB",
      pickupDate: "2026-10-08",
      pickupFrom: "08:00",
      pickupTo: "16:00",
      customerPrice: "450.00",
      carrierPrice: "400.00",
      bookedAt: new Date(),
      ...over,
    })
    .returning();
  await db.insert(shipmentDeliveries).values({ shipmentId: s!.id, deliveryId });
  return s!;
}

const freightRow = (shipmentId: string) => ({
  articleId: freightArticleId,
  shipmentId,
  description: "Frakt",
  quantity: 1,
  unitPrice: 450,
});

describe("fakturerbara försändelser", () => {
  it("lists a booked, uninvoiced shipment with the freight article and description", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const rows = await invoiceService.listInvoiceableShipments(customer.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shipmentId: s.id,
      shipmentNumber: s.shipmentNumber,
      customerPrice: "450.00",
      articleId: freightArticleId,
      articleNumber: "F",
      vatRate: "25",
      deliveryNumbers: [delivery.deliveryNumber],
    });
    expect(rows[0]!.description).toContain(s.shipmentNumber);
  });

  it("skips a shipment whose order already has a freight-article row (also hand-added)", async () => {
    const { customer, delivery } = await deliveredOrder();
    await db.insert(salesOrderRows).values({
      salesOrderId: delivery.orderId,
      articleId: freightArticleId,
      quantityOrdered: "1",
      unitPrice: "300",
    });
    await bookedShipment(customer.id, delivery.deliveryId);
    expect(await invoiceService.listInvoiceableShipments(customer.id)).toEqual([]);
  });

  it("skips draft and cancelled shipments, another customer's, and everything when no freight article is set", async () => {
    const { customer, delivery } = await deliveredOrder();
    await bookedShipment(customer.id, delivery.deliveryId, { status: "draft" });
    expect(await invoiceService.listInvoiceableShipments(customer.id)).toEqual([]);

    const second = await deliveredOrder(customer);
    await bookedShipment(customer.id, second.delivery.deliveryId, { status: "cancelled", cancelledAt: new Date() });
    expect(await invoiceService.listInvoiceableShipments(customer.id)).toEqual([]);

    const third = await deliveredOrder(customer);
    await bookedShipment(customer.id, third.delivery.deliveryId);
    expect(await invoiceService.listInvoiceableShipments(customer.id)).toHaveLength(1);
    const other = await makeCustomer();
    expect(await invoiceService.listInvoiceableShipments(other.id)).toEqual([]);

    const noArticle = createInvoiceService(
      invoiceRepo,
      mailService,
      documentPdfService,
      invoicePoster,
      createAuditRepository(db),
      articleService
    );
    expect(await noArticle.listInvoiceableShipments(customer.id)).toEqual([]);
  });
});

describe("fraktrad", () => {
  it("an invoice with the row makes the shipment non-invoiceable; cancelling the draft frees it", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const inv = await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    expect(inv!.rows[0]).toMatchObject({ shipmentId: s.id, shipmentNumber: s.shipmentNumber });
    expect(await invoiceService.listInvoiceableShipments(customer.id)).toEqual([]);
    // The shipment card sees the draft.
    expect((await shippingService.get(s.id)).invoice).toEqual({ invoiceId: inv!.id, invoiceNumber: null, status: "draft" });

    await invoiceService.cancel(inv!.id, biller);
    expect(await invoiceService.listInvoiceableShipments(customer.id)).toHaveLength(1);
    expect((await shippingService.get(s.id)).invoice).toBeNull();
    // The cancelled draft keeps its row but no longer holds the shipment.
    const cancelled = await invoiceService.getInvoice(inv!.id);
    expect(cancelled!.rows[0]!.shipmentId).toBeNull();
  });

  it("an issued invoice shows on the shipment card with its number", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const inv = await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    const issued = await invoiceService.issue(inv!.id, biller);
    expect((await shippingService.get(s.id)).invoice).toEqual({
      invoiceId: inv!.id,
      invoiceNumber: issued!.invoiceNumber,
      status: "issued",
    });
  });

  it("a second invoice for the same shipment is a Swedish 409", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    // The pre-check's view of the shipment (the unique index is the backstop).
    expect((await invoiceRepo.findShipmentForInvoicing(s.id))?.invoiced).toBe(true);
    const err = await invoiceService
      .create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ShipmentAlreadyInvoicedError);
    expect((err as Error).message).toBe(`Frakten för ${s.shipmentNumber} är redan fakturerad`);
  });

  it("the race rethrow names the shipment that was actually taken, not the first linked row", async () => {
    const { customer, delivery } = await deliveredOrder();
    const first = await bookedShipment(customer.id, delivery.deliveryId);
    const second = await bookedShipment(customer.id, (await deliveredOrder(customer)).delivery.deliveryId);
    // Bill `second` elsewhere; make the pre-check blind so the index fires.
    await invoiceService.create({ customerId: customer.id, rows: [freightRow(second.id)] }, biller);
    // The pre-check reads once per row (two calls); the rethrow's re-reads
    // after the index fired see the real flag.
    const original = invoiceRepo.findShipmentForInvoicing;
    let calls = 0;
    invoiceRepo.findShipmentForInvoicing = async (id) => {
      const row = await original(id);
      return ++calls <= 2 && row ? { ...row, invoiced: false } : row;
    };
    try {
      const err = await invoiceService
        .create({ customerId: customer.id, rows: [freightRow(first.id), freightRow(second.id)] }, biller)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ShipmentAlreadyInvoicedError);
      expect((err as Error).message).toBe(`Frakten för ${second.shipmentNumber} är redan fakturerad`);
      expect(calls).toBeGreaterThan(2);
    } finally {
      invoiceRepo.findShipmentForInvoicing = original;
    }
  });

  it("the unique index catches the race past the pre-check (create and addRow)", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const original = invoiceRepo.findShipmentForInvoicing;
    invoiceRepo.findShipmentForInvoicing = async (id) => ({ ...(await original(id))!, invoiced: false });
    try {
      const first = await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
      await expect(
        invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller)
      ).rejects.toBeInstanceOf(ShipmentAlreadyInvoicedError);
      await expect(invoiceService.addRow(first!.id, freightRow(s.id), biller)).rejects.toBeInstanceOf(
        ShipmentAlreadyInvoicedError
      );
    } finally {
      invoiceRepo.findShipmentForInvoicing = original;
    }
  });

  it("rejects wrong customer, wrong article, quantity ≠ 1, order link, draft shipment and unknown shipment", async () => {
    const { customer, delivery } = await deliveredOrder();
    const other = await makeCustomer();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const draftShipment = await bookedShipment(customer.id, (await deliveredOrder(customer)).delivery.deliveryId, {
      status: "draft",
    });
    const cases = [
      { customerId: other.id, rows: [freightRow(s.id)] },
      { customerId: customer.id, rows: [{ ...freightRow(s.id), articleId: delivery.articleId }] },
      { customerId: customer.id, rows: [{ ...freightRow(s.id), articleId: null }] },
      { customerId: customer.id, rows: [{ ...freightRow(s.id), quantity: 2 }] },
      { customerId: customer.id, rows: [{ ...freightRow(s.id), salesOrderRowId: delivery.orderRowId }] },
      { customerId: customer.id, rows: [freightRow(draftShipment.id)] },
      { customerId: customer.id, rows: [freightRow(crypto.randomUUID())] },
    ];
    for (const input of cases) {
      await expect(invoiceService.create(input, biller)).rejects.toBeInstanceOf(InvalidShipmentInvoiceRowError);
    }
    // Nothing was created, so the shipment is still billable.
    expect(await invoiceService.listInvoiceableShipments(customer.id)).toHaveLength(1);
  });

  it("without a freight article configured, a shipment row is refused", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const noArticle = createInvoiceService(
      invoiceRepo,
      mailService,
      documentPdfService,
      invoicePoster,
      createAuditRepository(db),
      articleService
    );
    await expect(noArticle.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller)).rejects.toThrow(
      "Ingen fraktartikel är vald — välj en under System → Frakt"
    );
  });

  it("a row update cannot break the freight row's rules", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const inv = await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    const rowId = inv!.rows[0]!.id;
    await expect(invoiceService.updateRow(inv!.id, rowId, { quantity: 2 }, biller)).rejects.toBeInstanceOf(
      InvalidShipmentInvoiceRowError
    );
    await expect(
      invoiceService.updateRow(inv!.id, rowId, { articleId: delivery.articleId }, biller)
    ).rejects.toBeInstanceOf(InvalidShipmentInvoiceRowError);
    await expect(
      invoiceService.updateRow(inv!.id, rowId, { salesOrderRowId: delivery.orderRowId }, biller)
    ).rejects.toBeInstanceOf(InvalidShipmentInvoiceRowError);
    // Price and text are the client's ("manuellt vinner"); the link survives.
    const updated = await invoiceService.updateRow(inv!.id, rowId, { unitPrice: 500, description: "Frakt DHL" }, biller);
    expect(updated).toMatchObject({ shipmentId: s.id, unitPrice: "500.0000", description: "Frakt DHL" });
  });

  it("credit notes never carry the shipment — copied or explicit", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const inv = await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    await invoiceService.issue(inv!.id, biller);
    const credit = await invoiceService.createCredit(inv!.id, {}, biller);
    expect(credit!.rows).toHaveLength(1);
    expect(credit!.rows[0]!.shipmentId).toBeNull();
    expect(credit!.rows[0]!.articleId).toBe(freightArticleId);
    expect(await invoiceService.listInvoiceableShipments(customer.id)).toEqual([]);
    await expect(invoiceService.createCredit(inv!.id, { rows: [freightRow(s.id)] }, biller)).rejects.toBeInstanceOf(
      InvalidShipmentInvoiceRowError
    );
  });
});

describe("Lägg till frakt när försändelsen är fakturerad", () => {
  const orderFreightRows = (orderId: string) =>
    db
      .select()
      .from(salesOrderRows)
      .where(and(eq(salesOrderRows.salesOrderId, orderId), eq(salesOrderRows.articleId, freightArticleId)));

  // An order whose rows are still editable (Under tillverkning) with one
  // följesedel — deliveredOrder's "delivered" status would lock the rows.
  async function openOrder() {
    const customer = await makeCustomer();
    const article = await makeArticle({ weight: 5 });
    const delivery = await makeDelivery(customer.id, [{ articleId: article.id, quantity: 2 }]);
    return { customer, delivery };
  }

  it("refuses a freight row on the order while its shipment is on an invoice; a cancelled draft frees it", async () => {
    const { customer, delivery } = await openOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const inv = await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    const err = await salesService
      .setFreightRow(delivery.orderId, { articleId: freightArticleId, unitPrice: 450 }, null)
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(FreightAlreadyInvoicedError);
    expect((err as Error).message).toContain(s.shipmentNumber);
    expect(await orderFreightRows(delivery.orderId)).toHaveLength(0);

    await invoiceService.cancel(inv!.id, biller);
    const row = await salesService.setFreightRow(delivery.orderId, { articleId: freightArticleId, unitPrice: 450 }, null);
    expect(row.articleId).toBe(freightArticleId);
    expect(await orderFreightRows(delivery.orderId)).toHaveLength(1);
  });

  it("refuses to reprice an existing freight row too, and ignores an inactive följesedel link", async () => {
    const { customer, delivery } = await openOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    // A freight row typed by hand before the invoice existed.
    await db.insert(salesOrderRows).values({
      salesOrderId: delivery.orderId,
      articleId: freightArticleId,
      quantityOrdered: "1",
      unitPrice: "300",
    });
    await expect(
      salesService.setFreightRow(delivery.orderId, { articleId: freightArticleId, unitPrice: 500 }, null)
    ).rejects.toBeInstanceOf(FreightAlreadyInvoicedError);
    expect(Number((await orderFreightRows(delivery.orderId))[0]!.unitPrice)).toBe(300);

    // The följesedel left the shipment (the link is inactive): the invoice
    // row still names the shipment, but it is no longer this order's freight.
    await db.update(shipmentDeliveries).set({ active: false }).where(eq(shipmentDeliveries.shipmentId, s.id));
    const row = await salesService.setFreightRow(delivery.orderId, { articleId: freightArticleId, unitPrice: 500 }, null);
    expect(Number(row.unitPrice)).toBe(500);
  });
});

describe("avboka med frakten på en faktura", () => {
  const cancelCalls = () => fake.calls.filter((c) => c.method === "cancel").length;

  it("refuses while the freight is on a draft invoice, and allows it once the draft is cancelled", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const inv = await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    await expect(shippingService.cancel(s.id, null)).rejects.toBeInstanceOf(ShipmentOnDraftInvoiceError);
    expect((await shippingService.get(s.id)).status).toBe("booked");
    expect(cancelCalls()).toBe(0);

    await invoiceService.cancel(inv!.id, biller);
    expect((await shippingService.cancel(s.id, null)).status).toBe("cancelled");
    expect(cancelCalls()).toBe(1);
  });

  it("an issued invoice does not block cancelling (the credit note is the remedy)", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const inv = await invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller);
    await invoiceService.issue(inv!.id, biller);
    expect((await shippingService.cancel(s.id, null)).status).toBe("cancelled");
    expect(cancelCalls()).toBe(1);
  });

  // Frakt-uppföljning: the cancellation reserves the shipment before Sendify
  // is called, and the invoice's insert transaction locks the shipment FOR
  // SHARE and re-checks — so no freight is ever billed for a transport that
  // is being (or has been) cancelled, whatever resolveRow's pre-check saw.
  it("refuses a freight row while the cancellation is at Sendify", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    fake.state.cancelDelayMs = 200;
    const cancelling = shippingService.cancel(s.id, null);
    await new Promise((r) => setTimeout(r, 50));
    await expect(invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller)).rejects.toBeInstanceOf(
      ShipmentNotBillableError
    );
    expect((await cancelling).status).toBe("cancelled");
  });

  it("never bills a shipment that was cancelled after the pre-check saw it booked", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const inv = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Montage", quantity: 1, unitPrice: 100 }] },
      biller
    );
    const stale = await invoiceRepo.findShipmentForInvoicing(s.id);
    await db.update(shipments).set({ status: "cancelled" }).where(eq(shipments.id, s.id));
    // resolveRow's unlocked read still says "booked"; the insert's lock must not.
    vi.spyOn(invoiceRepo, "findShipmentForInvoicing").mockResolvedValueOnce(stale);
    await expect(invoiceService.addRow(inv!.id, freightRow(s.id), biller)).rejects.toBeInstanceOf(ShipmentNotBillableError);
    await expect(invoiceService.create({ customerId: customer.id, rows: [freightRow(s.id)] }, biller)).rejects.toBeInstanceOf(
      InvalidShipmentInvoiceRowError
    );
  });

  it("a cancellation that died after Sendify can be retried once its reservation expired", async () => {
    const { customer, delivery } = await deliveredOrder();
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    vi.spyOn(shippingRepo, "cancelShipment").mockRejectedValueOnce(new Error("connection reset"));
    await expect(shippingService.cancel(s.id, null)).rejects.toThrow("connection reset");
    expect((await shippingService.get(s.id)).status).toBe("booked");
    await expect(shippingService.cancel(s.id, null)).rejects.toBeInstanceOf(FreightCancelInProgressError);
    await db.update(shipments).set({ cancelStartedAt: new Date(Date.now() - 3 * 60_000) }).where(eq(shipments.id, s.id));
    expect((await shippingService.cancel(s.id, null)).status).toBe("cancelled");
    expect(cancelCalls()).toBe(2);
  });
});

describe("samlingsfakturering", () => {
  it("orders the candidates like the customer register, freight-only customers included", async () => {
    const numbers = ["b-2", "B1", "a3"];
    for (const [i, customerNumber] of numbers.entries()) {
      const { customer, delivery } = await deliveredOrder(await makeCustomer({ customerNumber, collectiveInvoicing: true }));
      // Some candidates also carry freight — the freight block must not reorder them.
      if (i % 2 === 0) await bookedShipment(customer.id, delivery.deliveryId);
    }
    const expected = await db
      .select({ customerNumber: customers.customerNumber })
      .from(customers)
      .where(inArray(customers.customerNumber, numbers))
      .orderBy(asc(customers.customerNumber));
    const candidates = await invoiceService.listCollectiveInvoicingCandidates();
    expect(candidates.map((c) => c.customerNumber)).toEqual(expected.map((c) => c.customerNumber));
  });

  it("adds the freight after the order rows, and a freight-only customer is a candidate", async () => {
    const customer = await makeCustomer({ collectiveInvoicing: true });
    const { delivery } = await deliveredOrder(customer);
    const s = await bookedShipment(customer.id, delivery.deliveryId);
    const candidates = await invoiceService.listCollectiveInvoicingCandidates();
    // 2 st × 100 from the order row + the 450 freight.
    expect(candidates.find((c) => c.customerId === customer.id)).toMatchObject({
      shipmentCount: 1,
      rowCount: 1,
      orderCount: 1,
      netAmount: 650,
    });
    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [customer.id], issue: false }, biller);
    expect(results[0]).toMatchObject({ status: "draft", rowCount: 2, error: null });
    const inv = await invoiceService.getInvoice(results[0]!.invoiceId!);
    expect(inv!.rows).toHaveLength(2);
    expect(inv!.rows[0]).toMatchObject({ salesOrderRowId: delivery.orderRowId, shipmentId: null });
    expect(inv!.rows.at(-1)).toMatchObject({
      shipmentId: s.id,
      articleId: freightArticleId,
      quantity: "1.0000",
      unitPrice: "450.0000",
    });
    expect(inv!.rows.at(-1)!.description).toContain(s.shipmentNumber);
    // Billed: no longer a candidate on either count.
    expect((await invoiceService.listCollectiveInvoicingCandidates()).find((c) => c.customerId === customer.id)).toBeUndefined();

    const freightOnly = await makeCustomer({ collectiveInvoicing: true });
    const fo = await deliveredOrder(freightOnly);
    // Bill the order rows first (straight through the repo — the service
    // refuses flagged customers) so only the freight is left.
    await invoiceRepo.create(
      { customerId: freightOnly.id, paymentTermId: null, note: null },
      [
        {
          articleId: fo.delivery.articleId,
          salesOrderRowId: fo.delivery.orderRowId,
          shipmentId: null,
          description: "Order",
          quantity: 2,
          unitPrice: 100,
          discountPercent: 0,
          unitId: null,
          unitFactor: null,
          vatRate: 25,
          lineAmount: 200,
          vatAmount: 50,
        },
      ],
      biller
    );
    const s2 = await bookedShipment(freightOnly.id, fo.delivery.deliveryId);
    expect(
      (await invoiceService.listCollectiveInvoicingCandidates()).find((c) => c.customerId === freightOnly.id)
    ).toMatchObject({ shipmentCount: 1, rowCount: 0, orderCount: 0, netAmount: 450, name: freightOnly.name });
    const run = await invoiceService.runCollectiveInvoicing({ customerIds: [freightOnly.id], issue: true }, biller);
    expect(run.results[0]).toMatchObject({ status: "issued", rowCount: 1, error: null });
    const issued = await invoiceService.getInvoice(run.results[0]!.invoiceId!);
    expect(issued!.rows[0]).toMatchObject({ shipmentId: s2.id, shipmentNumber: s2.shipmentNumber });
  });

  it("an unflagged customer's shipment never appears among the candidates", async () => {
    const { customer, delivery } = await deliveredOrder();
    await bookedShipment(customer.id, delivery.deliveryId);
    expect((await invoiceService.listCollectiveInvoicingCandidates()).find((c) => c.customerId === customer.id)).toBeUndefined();
  });
});
