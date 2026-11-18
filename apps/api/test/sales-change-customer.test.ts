import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  articles,
  auditLog,
  customerDeliveryAddresses,
  db,
  deliveries,
  exchangeRates,
  permissionGroups,
  salesOrderRows,
  salesOrders,
  shipmentDeliveries,
  shipments,
  type Tx,
} from "@navet/db";
import { createArticleSchema, createStockLocationSchema, updateSystemSettingsSchema, type CustomerChangePreview } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import {
  customerChangeBasis,
  matchesExpectedCustomerChange,
  planCustomerChange,
  type CustomerChangeFacts,
} from "../src/modules/sales/service/customer-change.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { parsed } from "./helpers/parsed.js";
import { setupPostingBaseline, testArticleService, testSystemService } from "./helpers/services.js";
import { resetVatCodes } from "./helpers/vat-codes.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Byt kund på offert och kundorder: POST
// /sales-orders/:id/change-customer[/preview] through the real app — the
// statuses, every blocker, the prices (the new customer's chain, kept and
// converted, the ställkostnad, the configured row, the freight row), the
// currency and rate, what the order takes from the new customer and what is
// cleared, the stale preview, the permissions and the locks. The fixtures
// are created through the API and the services on the same database. All
// data made up.

const auditRepository = createAuditRepository(db);
const authService = createAuthService(createAuthRepository(db), "unused", auditRepository);
const registerService = createRegisterService(createRegisterRepository(db));
const stockService = createStockService(createStockRepository(db));

const PASSWORD = "correcthorsebattery";
const TODAY = stockholmToday();
const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts,
  audit_log, exchange_rates, deviation_links, deviations, invoice_documents, invoice_rows, invoices, shipment_deliveries, shipments,
  delivery_rows, deliveries, sales_order_rows, sales_orders, customer_prices, price_list_rows, price_lists, customer_contacts,
  customer_delivery_addresses, customers, delivery_terms, payment_terms, carriers, stock_transactions, stock_locations, warehouses,
  bom_components, articles, user_settings, users CASCADE`;
const DELETE_SETTINGS = sql`DELETE FROM system_settings WHERE key IN ('setup_charge_article_id', 'freight_article_id')`;

let app: ReturnType<typeof buildApp>;
let cookie: string;
let seq = 0;
const groupIds: string[] = [];

beforeAll(async () => {
  app = buildApp(db);
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_SETTINGS);
  await resetVatCodes();
  await setupPostingBaseline();
  location = null;
  const email = `bk-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Säljaren", role: "admin" });
  cookie = await login(email);
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
  await db.execute(DELETE_SETTINGS);
  await resetVatCodes();
  if (groupIds.length > 0) await db.delete(permissionGroups).where(inArray(permissionGroups.id, groupIds));
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}
async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `BK${crypto.randomUUID().slice(0, 6)}`, name: "Byt kund", permissions })
    .returning();
  groupIds.push(group!.id);
  const email = `bk-user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}
function call(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, as: string = cookie) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie: as, origin: "http://localhost" },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}
async function ok(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const res = await call(method, url, payload);
  expect([url, res.statusCode, res.statusCode >= 400 ? res.body : ""]).toEqual([url, res.statusCode < 400 ? res.statusCode : 200, ""]);
  return res.json();
}

async function customer(name: string, extra: Record<string, unknown> = {}) {
  return ok("POST", "/customers", { name, ...extra }) as Promise<{ id: string; customerNumber: string; name: string }>;
}
async function article(opts: { salesPrice?: number; type?: "purchased" | "service"; name?: string } = {}) {
  const created = await testArticleService.createArticle(
    parsed(createArticleSchema, {
      articleNumber: `BK-${++seq}-${crypto.randomUUID().slice(0, 6)}`,
      name: opts.name ?? "Diskbänk",
      type: opts.type ?? "purchased",
      active: true,
    })
  );
  if (opts.salesPrice !== undefined) await db.update(articles).set({ salesPrice: String(opts.salesPrice) }).where(eq(articles.id, created.id));
  return created;
}
async function customerPrice(customerId: string, articleId: string, unitPrice: number, extra: Record<string, unknown> = {}) {
  await ok("POST", `/customers/${customerId}/prices`, { articleId, unitPrice, ...extra });
}
async function eurRate(rate: number) {
  await db.insert(exchangeRates).values({ currency: "EUR", date: TODAY, rate: String(rate), source: "manual" });
}
type Row = { articleId: string; quantity: number; unitPrice?: number; discountPercent?: number };
// A quote (or, with confirm, an order) with one row per entry.
async function order(customerId: string, rows: Row[], extra: Record<string, unknown> = {}) {
  const created = await ok("POST", "/quotes", { customerId, rows, ...extra });
  return { order: created.order as { id: string; orderNumber: string; revision: number }, rows: created.rows as { id: string; articleId: string }[] };
}
async function stored(orderId: string) {
  const [o] = await db.select().from(salesOrders).where(eq(salesOrders.id, orderId));
  const rows = await db
    .select()
    .from(salesOrderRows)
    .where(eq(salesOrderRows.salesOrderId, orderId))
    .orderBy(asc(salesOrderRows.createdAt), asc(salesOrderRows.id));
  return { order: o!, rows };
}
function preview(orderId: string, customerId: string, extra: Record<string, unknown> = {}, as: string = cookie) {
  return call("POST", `/sales-orders/${orderId}/change-customer/preview`, { customerId, ...extra }, as);
}
function expectedOf(p: CustomerChangePreview) {
  return {
    customerId: p.from.customerId,
    currency: p.to.currency,
    exchangeRate: p.to.exchangeRate,
    rows: p.rows.map((r) => ({ rowId: r.rowId, unitPrice: r.after.unitPrice, discountPercent: r.after.discountPercent })),
  };
}
// Preview, then change with exactly what the preview showed.
async function change(orderId: string, customerId: string, extra: Record<string, unknown> = {}, as: string = cookie) {
  const p = await preview(orderId, customerId, extra);
  expect(p.statusCode).toBe(200);
  return call("POST", `/sales-orders/${orderId}/change-customer`, { customerId, ...extra, expected: expectedOf(p.json()) }, as);
}
function changeNow(orderId: string, customerId: string, seen: CustomerChangePreview) {
  return call("POST", `/sales-orders/${orderId}/change-customer`, { customerId, expected: expectedOf(seen) });
}
async function changeAudits() {
  return db.select().from(auditLog).where(eq(auditLog.action, "customer_changed"));
}

// One warehouse per test (Flera lager is off by default).
let location: { id: string } | null = null;
async function stock(articleId: string, quantity = 100) {
  if (!location) {
    const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID().slice(0, 6)}`, active: true });
    location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
  }
  await stockService.recordTransaction({ articleId, locationId: location.id, quantityDelta: quantity, transactionType: "inventory_adjustment" });
}
async function deliver(orderId: string, rowId: string, quantity: number) {
  return ok("POST", `/sales-orders/${orderId}/deliver`, { locationId: location!.id, rows: [{ rowId, quantity }] });
}
async function undoDelivery(orderId: string) {
  const [delivery] = await db.select().from(deliveries).where(eq(deliveries.salesOrderId, orderId)).orderBy(asc(deliveries.deliveredAt));
  const rows = await ok("GET", `/deliveries/${delivery!.id}/rows`);
  for (const row of rows.rows ?? rows) {
    if (!row.undoneAt) await ok("POST", `/sales-orders/${orderId}/deliveries/${delivery!.id}/rows/${row.id}/undo`, {});
  }
  return delivery!;
}

// Runs `action` while another transaction holds the locks `lock` took and
// lets it commit once `waiters` transactions wait on them.
async function whileHolding<T>(lock: (tx: Tx) => Promise<unknown>, action: () => Promise<T>, waiters = 1) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const hasLocks = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    await lock(tx);
    locked();
    await gate;
  });
  await Promise.race([hasLocks, holder]);
  const acting = action();
  try {
    await waitForLockWaiter(10_000, waiters);
  } finally {
    release();
  }
  await holder;
  return acting;
}

describe("status and what the order takes from the new customer", () => {
  it("changes the customer of a confirmed order: address, terms, Er referens and Fakturakund from the new customer; the old customer's numbers and the freight choice cleared; status kept, revision bumped once, audit row", async () => {
    const dt = await registerService.deliveryTerms.create({ code: "EXW", name: "Ex Works" });
    const pt10 = await registerService.paymentTerms.create({ code: "10", name: "10 dagar netto" });
    const pt30 = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const pt60 = await registerService.paymentTerms.create({ code: "60", name: "60 dagar netto" });
    const carrier = await registerService.carriers.create({ code: "BIL", name: "Egen bil" });
    const old = await customer("Gamla Kunden AB", { paymentTermId: pt10.id });
    const payer = await customer("Betalaren AB", { paymentTermId: pt60.id });
    const next = await customer("Nya Kunden AB", {
      deliveryTermId: dt.id,
      paymentTermId: pt30.id,
      carrierId: carrier.id,
      invoiceCustomerId: payer.id,
      contactName: "Växeln",
    });
    await ok("POST", `/customers/${next.id}/contacts`, { name: "Nora Nyberg", isPrimary: true });
    await ok("POST", `/customers/${next.id}/delivery-addresses`, { label: "Lager 2", address: "Hamngatan 4", postalCode: "41108", city: "Göteborg", isDefault: true });
    const art = await article({ salesPrice: 500 });
    const made = await order(old.id, [{ articleId: art.id, quantity: 2 }], {
      confirm: true,
      customerOrderNumber: "PO-4711",
      customerInquiryNumber: "RFQ-12",
      customerReference: "Gunnar Gammal",
      note: "Lossas på baksidan",
      newDeliveryAddress: { label: "Bygget", address: "Tillfällig väg 1", city: "Borås" },
    });
    await ok("PATCH", `/sales-orders/${made.order.id}`, { generalMarkupPercent: 20, expectedDeliveryDate: "2027-01-15", bumpRevision: false, confirmRepricing: true });
    await db.update(salesOrders).set({ freightQuote: { fetchedAt: new Date().toISOString(), rates: [] } as never, freightCarrierPrice: "450" }).where(eq(salesOrders.id, made.order.id));
    const before = await stored(made.order.id);
    const oneOffId = before.order.deliveryAddressId!;

    const p = await preview(made.order.id, next.id);
    expect(p.statusCode).toBe(200);
    const body = p.json() as CustomerChangePreview;
    expect(body).toMatchObject({
      orderNumber: made.order.orderNumber,
      documentKind: "order",
      status: "confirmed",
      from: { customerId: old.id, customerName: "Gamla Kunden AB", currency: "SEK", exchangeRate: 1 },
      to: { customerId: next.id, customerNumber: next.customerNumber, customerName: "Nya Kunden AB", currency: "SEK", exchangeRate: 1 },
      header: {
        deliveryAddress: "Lager 2, Hamngatan 4, 41108 Göteborg",
        deliveryTerm: "EXW · Ex Works",
        // The paying customer's term (Fakturakund), not the new customer's own.
        paymentTerm: "60 · 60 dagar netto",
        carrier: "BIL · Egen bil",
        customerReference: "Nora Nyberg",
        invoiceCustomer: `${payer.customerNumber} Betalaren AB`,
      },
      clears: { customerOrderNumber: "PO-4711", customerInquiryNumber: "RFQ-12", freight: true, oneOffDeliveryAddress: true },
      blockers: [],
    });
    // The preview wrote nothing.
    expect(await stored(made.order.id)).toEqual(before);

    const res = await call("POST", `/sales-orders/${made.order.id}/change-customer`, { customerId: next.id, expected: expectedOf(body) });
    expect(res.statusCode).toBe(200);
    expect(res.json().order).toMatchObject({ customerId: next.id, customerName: "Nya Kunden AB", status: "confirmed" });
    expect(res.json().change.to.customerId).toBe(next.id);

    const after = await stored(made.order.id);
    const [defaultAddress] = await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.customerId, next.id));
    expect(after.order).toMatchObject({
      customerId: next.id,
      invoiceCustomerId: payer.id,
      status: "confirmed",
      orderNumber: made.order.orderNumber,
      revision: before.order.revision + 1,
      deliveryAddressId: defaultAddress!.id,
      deliveryTermId: dt.id,
      paymentTermId: pt60.id,
      carrierId: carrier.id,
      customerReference: "Nora Nyberg",
      customerOrderNumber: null,
      customerInquiryNumber: null,
      freightProductId: null,
      freightCarrierPrice: null,
      freightQuote: null,
      // Untouched: the order's own markup, the dates and the note.
      generalMarkupPercent: "20.00",
      expectedDeliveryDate: "2027-01-15",
      note: "Lossas på baksidan",
    });
    // The order's engångsadress is gone with the old customer.
    expect(await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.id, oneOffId))).toEqual([]);

    const log = await changeAudits();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entityType: "sales_order", entityId: made.order.orderNumber });
    expect(log[0]!.detail).toMatchObject({
      before: { customer: `${old.customerNumber} Gamla Kunden AB`, currency: "SEK", customerOrderNumber: "PO-4711", customerInquiryNumber: "RFQ-12" },
      after: { customer: `${next.customerNumber} Nya Kunden AB`, currency: "SEK", invoiceCustomer: `${payer.customerNumber} Betalaren AB` },
    });
  });

  it("a quote stays a quote with its OF number; an order Under tillverkning keeps its status; the new customer's Kontaktperson is the reference without a huvudkontakt", async () => {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB", { contactName: "Kim Kontakt" });
    const art = await article({ salesPrice: 100 });
    const quote = await order(old.id, [{ articleId: art.id, quantity: 1 }]);
    const p = (await preview(quote.order.id, next.id)).json() as CustomerChangePreview;
    expect(p).toMatchObject({ documentKind: "quote", status: "quote", header: { customerReference: "Kim Kontakt", deliveryAddress: null, invoiceCustomer: null } });
    expect((await changeNow(quote.order.id, next.id, p)).statusCode).toBe(200);
    expect((await stored(quote.order.id)).order).toMatchObject({
      customerId: next.id,
      status: "quote",
      orderNumber: quote.order.orderNumber,
      quoteNumber: quote.order.orderNumber,
      customerReference: "Kim Kontakt",
      deliveryAddressId: null,
      invoiceCustomerId: null,
    });

    const inProduction = await order(old.id, [{ articleId: art.id, quantity: 1 }], { confirm: true });
    await ok("POST", `/sales-orders/${inProduction.order.id}/start-production`, {});
    expect((await change(inProduction.order.id, next.id)).statusCode).toBe(200);
    expect((await stored(inProduction.order.id)).order).toMatchObject({ customerId: next.id, status: "in_production" });
  });

  it("400 for the customer the order already has and for an inactive customer, 404 for an unknown customer or order", async () => {
    const old = await customer("Gamla Kunden AB");
    const inactive = await customer("Vilande AB", { active: false });
    const art = await article({ salesPrice: 100 });
    const { order: o } = await order(old.id, [{ articleId: art.id, quantity: 1 }]);

    const same = await preview(o.id, old.id);
    expect(same.statusCode).toBe(400);
    expect(same.json().code).toBe("sales-order-same-customer");
    const vilande = await preview(o.id, inactive.id);
    expect(vilande.statusCode).toBe(400);
    expect(vilande.json().code).toBe("customer-inactive");
    const unknownCustomer = await preview(o.id, crypto.randomUUID());
    expect(unknownCustomer.statusCode).toBe(404);
    expect(unknownCustomer.json().code).toBe("customer-not-found");
    const unknownOrder = await preview(crypto.randomUUID(), old.id);
    expect(unknownOrder.statusCode).toBe(404);
    expect(unknownOrder.json().code).toBe("sales-order-not-found");
    // The same answers from the change itself; a body without `expected` is a 400.
    const expected = { customerId: old.id, currency: "SEK", exchangeRate: 1, rows: [] };
    expect((await call("POST", `/sales-orders/${o.id}/change-customer`, { customerId: old.id, expected })).json().code).toBe("sales-order-same-customer");
    expect((await call("POST", `/sales-orders/${o.id}/change-customer`, { customerId: inactive.id, expected })).json().code).toBe("customer-inactive");
    expect((await call("POST", `/sales-orders/${o.id}/change-customer`, { customerId: inactive.id })).statusCode).toBe(400);
    expect((await call("POST", `/sales-orders/${o.id}/change-customer/preview`, { customerId: inactive.id, extra: 1 })).statusCode).toBe(400);
    expect((await stored(o.id)).order.customerId).toBe(old.id);
  });
});

describe("the blockers", () => {
  async function fixture(opts: { confirm?: boolean } = {}) {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB");
    const art = await article({ salesPrice: 100 });
    await stock(art.id);
    const made = await order(old.id, [{ articleId: art.id, quantity: 10 }], { confirm: opts.confirm ?? true });
    return { old, next, art, order: made.order, row: made.rows[0]! };
  }

  async function expectBlocked(orderId: string, customerId: string, oldCustomerId: string, codes: string[]) {
    const p = await preview(orderId, customerId);
    expect(p.statusCode).toBe(200);
    expect(p.json().blockers.map((b: { code: string }) => b.code)).toEqual(codes);
    const res = await call("POST", `/sales-orders/${orderId}/change-customer`, { customerId, expected: expectedOf(p.json()) });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe(codes[0]);
    if (codes[0] !== "invalid-status-transition") expect(res.json().blockers).toEqual(p.json().blockers);
    expect(res.json().error).toBe(p.json().blockers[0].message);
    expect((await stored(orderId)).order.customerId).toBe(oldCustomerId);
    expect(await changeAudits()).toHaveLength(0);
    return p.json() as CustomerChangePreview;
  }

  it("the statuses: Order (a quote that gave an order), Förlorad, Makulerad, Levererad and Fakturerad are refused", async () => {
    const f = await fixture({ confirm: false });
    // ordered: the quote stays as Order when it gives a kundorder.
    const ordered = await order(f.old.id, [{ articleId: f.art.id, quantity: 1 }]);
    await ok("POST", `/sales-orders/${ordered.order.id}/create-order`);
    await expectBlocked(ordered.order.id, f.next.id, f.old.id, ["invalid-status-transition"]);

    const cancelled = await order(f.old.id, [{ articleId: f.art.id, quantity: 1 }]);
    await ok("POST", `/sales-orders/${cancelled.order.id}/cancel`, {});
    await expectBlocked(cancelled.order.id, f.next.id, f.old.id, ["invalid-status-transition"]);

    for (const status of ["lost", "delivered", "invoiced"] as const) {
      const made = await order(f.old.id, [{ articleId: f.art.id, quantity: 1 }]);
      await db.update(salesOrders).set({ status }).where(eq(salesOrders.id, made.order.id));
      const p = await expectBlocked(made.order.id, f.next.id, f.old.id, ["invalid-status-transition"]);
      expect(p.blockers[0]!.message).toBe("Kunden kan bara bytas på en offert eller på en kundorder som är Bekräftad eller Under tillverkning.");
    }
  });

  it("a live delivery blocks; an undone one does not", async () => {
    const f = await fixture();
    await ok("POST", `/sales-orders/${f.order.id}/start-production`, {});
    await deliver(f.order.id, f.row.id, 4);
    await expectBlocked(f.order.id, f.next.id, f.old.id, ["sales-order-has-deliveries"]);
    await undoDelivery(f.order.id);
    expect((await change(f.order.id, f.next.id)).statusCode).toBe(200);
    expect((await stored(f.order.id)).order).toMatchObject({ customerId: f.next.id, status: "in_production" });
  });

  it("an order row on an invoice blocks — the issued invoice and its credit note still do after the delivery is undone; a cancelled draft does not", async () => {
    const f = await fixture();
    await ok("POST", `/sales-orders/${f.order.id}/start-production`, {});
    await deliver(f.order.id, f.row.id, 4);
    const invoiceRows = (await ok("GET", `/invoiceable-orders?customerId=${f.old.id}`))[0].rows.map(
      (r: { articleId: string; salesOrderRowId: string; articleName: string; rest: number; unitPrice: string }) => ({
        articleId: r.articleId,
        salesOrderRowId: r.salesOrderRowId,
        description: r.articleName,
        quantity: r.rest,
        unitPrice: Number(r.unitPrice),
      })
    );
    // A draft: both the delivery and the invoice block.
    const draft = await ok("POST", "/invoices", { customerId: f.old.id, rows: invoiceRows });
    const both = await expectBlocked(f.order.id, f.next.id, f.old.id, ["sales-order-has-deliveries", "sales-order-has-invoice-rows"]);
    expect(both.blockers[1]!.message).toBe("Ordern finns på faktura utkast — kunden kan inte bytas.");
    // The cancelled draft is history: only the delivery is left.
    await ok("POST", `/invoices/${draft.id}/cancel`, {});
    await expectBlocked(f.order.id, f.next.id, f.old.id, ["sales-order-has-deliveries"]);

    // Issued, fully credited and the delivery undone: the invoices remain.
    const issued = await ok("POST", `/invoices/${(await ok("POST", "/invoices", { customerId: f.old.id, rows: invoiceRows })).id}/issue`, {});
    const credit = await ok("POST", `/invoices/${issued.id}/credit`, {});
    const creditIssued = await ok("POST", `/invoices/${credit.id}/issue`, {});
    await undoDelivery(f.order.id);
    const p = await expectBlocked(f.order.id, f.next.id, f.old.id, ["sales-order-has-invoice-rows"]);
    expect(p.blockers[0]!.message).toContain(issued.invoiceNumber);
    expect(p.blockers[0]!.message).toContain(creditIssued.invoiceNumber);
  });

  it("a live shipment over one of the order's följesedlar blocks; a cancelled one does not", async () => {
    const f = await fixture();
    await ok("POST", `/sales-orders/${f.order.id}/start-production`, {});
    await deliver(f.order.id, f.row.id, 4);
    const [delivery] = await db.select().from(deliveries).where(eq(deliveries.salesOrderId, f.order.id));
    const [shipment] = await db
      .insert(shipments)
      .values({
        shipmentNumber: `FR-BK-${Date.now() % 1_000_000}`,
        status: "booked",
        customerId: f.old.id,
        recipientName: "Gamla Kunden AB",
        pickupDate: "2026-11-18",
        pickupFrom: "08:00",
        pickupTo: "16:00",
        bookedAt: new Date(),
      })
      .returning();
    await db.insert(shipmentDeliveries).values({ shipmentId: shipment!.id, deliveryId: delivery!.id });
    const p = await expectBlocked(f.order.id, f.next.id, f.old.id, ["sales-order-has-deliveries", "sales-order-has-shipments"]);
    expect(p.blockers[1]!.message).toContain(shipment!.shipmentNumber);
    await db.update(shipments).set({ status: "cancelled" }).where(eq(shipments.id, shipment!.id));
    await expectBlocked(f.order.id, f.next.id, f.old.id, ["sales-order-has-deliveries"]);
  });

  it("a reklamation at the current customer that points at the order blocks; a cancelled one does not", async () => {
    const f = await fixture();
    const deviation = await call("POST", "/deviations", { type: "customer", title: "Repor i ytan", customerId: f.old.id, salesOrderId: f.order.id });
    expect(deviation.statusCode).toBe(201);
    const p = await expectBlocked(f.order.id, f.next.id, f.old.id, ["sales-order-has-deviations"]);
    expect(p.blockers[0]!.message).toContain(deviation.json().deviationNumber);
    expect((await call("POST", `/deviations/${deviation.json().id}/cancel`, { reason: "Fel order" })).statusCode).toBe(200);
    expect((await change(f.order.id, f.next.id)).statusCode).toBe(200);
  });
});

describe("the prices", () => {
  it("rows the chain priced get the new customer's chain (kundpris, kundrabatt, the article's price); a handwritten price stays and is marked", async () => {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB", { discountPercent: 10 });
    const special = await article({ salesPrice: 100 });
    const listed = await article({ salesPrice: 200 });
    const manual = await article({ salesPrice: 300 });
    await customerPrice(old.id, special.id, 80);
    await customerPrice(next.id, special.id, 70);
    const made = await order(old.id, [
      { articleId: special.id, quantity: 5 },
      { articleId: listed.id, quantity: 2 },
      { articleId: manual.id, quantity: 1, unitPrice: 250 },
    ]);
    expect((await stored(made.order.id)).rows.map((r) => [r.unitPrice, r.priceOrigin])).toEqual([
      ["80.0000", "chain"],
      ["200.0000", "chain"],
      ["250.0000", "manual"],
    ]);

    const p = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;
    expect(p.rows.map((r) => [r.kind, r.before.unitPrice, r.after.unitPrice, r.after.discountPercent, r.origin, r.review])).toEqual([
      ["article", 80, 70, 0, "chain", null],
      // The article's price with the new customer's kundrabatt.
      ["article", 200, 200, 10, "chain", null],
      ["article", 250, 250, 0, "unchanged", "manual"],
    ]);
    expect(p.rows[0]!.after.source).toBe("customer_article");
    expect((await changeNow(made.order.id, next.id, p)).statusCode).toBe(200);
    expect((await stored(made.order.id)).rows.map((r) => [r.unitPrice, r.discountPercent, r.priceOrigin])).toEqual([
      ["70.0000", "0.00", "chain"],
      ["200.0000", "10.00", "chain"],
      ["250.0000", "0.00", "manual"],
    ]);
    const [log] = await changeAudits();
    expect((log!.detail as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it("a chain row the new customer's chain has no price for keeps its price and is marked", async () => {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB");
    const art = await article();
    await customerPrice(old.id, art.id, 45);
    const made = await order(old.id, [{ articleId: art.id, quantity: 3 }]);
    const p = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;
    expect(p.rows[0]).toMatchObject({ before: { unitPrice: 45, priceOrigin: "chain" }, after: { unitPrice: 45, priceOrigin: "chain", source: null }, origin: "unchanged", review: "no-price" });
    expect((await changeNow(made.order.id, next.id, p)).statusCode).toBe(200);
    expect((await stored(made.order.id)).rows[0]).toMatchObject({ unitPrice: "45.0000", priceOrigin: "chain" });
  });

  it("the ställkostnadsrad follows its article row: the new customer's ställpris when the rule has one, else kept and marked; a configured row and the freight row keep their prices", async () => {
    const setup = await article({ type: "service", name: "Ställkostnad" });
    const freight = await article({ type: "service", name: "Frakt" });
    await testSystemService.updateSettings(updateSystemSettingsSchema.parse({ setupChargeArticleId: setup.id }));
    await db.execute(sql`INSERT INTO system_settings (key, value) VALUES ('freight_article_id', ${freight.id}) ON CONFLICT (key) DO UPDATE SET value = ${freight.id}`);
    const old = await customer("Gamla Kunden AB");
    const withSetup = await customer("Nya Med Ställpris AB");
    const withoutSetup = await customer("Nya Utan Ställpris AB");
    const art = await article({ salesPrice: 100 });
    const configured = await article({ salesPrice: 900 });
    await customerPrice(old.id, art.id, 80, { setupPrice: 400 });
    await customerPrice(withSetup.id, art.id, 75, { setupPrice: 650 });
    await customerPrice(withoutSetup.id, art.id, 78);

    const build = async () => {
      const made = await order(old.id, [
        { articleId: art.id, quantity: 5 },
        { articleId: configured.id, quantity: 1 },
        { articleId: freight.id, quantity: 1, unitPrice: 450 },
      ]);
      const rows = (await stored(made.order.id)).rows;
      expect(rows.map((r) => [r.articleId, r.unitPrice, r.setupForRowId !== null])).toEqual([
        [art.id, "80.0000", false],
        [setup.id, "400.0000", true],
        [configured.id, "900.0000", false],
        [freight.id, "450.0000", false],
      ]);
      // A configured row (beställningsvara): the template priced it.
      await db.update(salesOrderRows).set({ configuration: { templateId: configured.id, choices: [] } as never, priceOrigin: "manual" }).where(eq(salesOrderRows.id, rows[2]!.id));
      return made;
    };

    const first = await build();
    const p1 = (await preview(first.order.id, withSetup.id)).json() as CustomerChangePreview;
    expect(p1.rows.map((r) => [r.kind, r.after.unitPrice, r.origin, r.review])).toEqual([
      ["article", 75, "chain", null],
      ["setup", 650, "chain", null],
      ["configured", 900, "unchanged", "configured"],
      ["freight", 450, "unchanged", "freight"],
    ]);
    expect((await changeNow(first.order.id, withSetup.id, p1)).statusCode).toBe(200);
    expect((await stored(first.order.id)).rows.map((r) => r.unitPrice)).toEqual(["75.0000", "650.0000", "900.0000", "450.0000"]);

    const second = await build();
    const p2 = (await preview(second.order.id, withoutSetup.id)).json() as CustomerChangePreview;
    expect(p2.rows.map((r) => [r.kind, r.after.unitPrice, r.origin, r.review])).toEqual([
      ["article", 78, "chain", null],
      ["setup", 400, "unchanged", "setup"],
      ["configured", 900, "unchanged", "configured"],
      ["freight", 450, "unchanged", "freight"],
    ]);
    expect((await changeNow(second.order.id, withoutSetup.id, p2)).statusCode).toBe(200);
    // No row was added or removed by the change.
    expect((await stored(second.order.id)).rows.map((r) => r.unitPrice)).toEqual(["78.0000", "400.0000", "900.0000", "450.0000"]);
  });

  it("SEK → EUR: today's rate, the chain's prices in EUR, the others converted to the same value in kronor", async () => {
    await eurRate(11);
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Neue Kunde GmbH", { currency: "EUR" });
    const listed = await article({ salesPrice: 220 });
    const special = await article({ salesPrice: 500 });
    const manual = await article({ salesPrice: 100 });
    await customerPrice(next.id, special.id, 40);
    const made = await order(old.id, [
      { articleId: listed.id, quantity: 1 },
      { articleId: special.id, quantity: 1 },
      { articleId: manual.id, quantity: 1, unitPrice: 110, discountPercent: 5 },
    ]);
    const p = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;
    expect(p.to).toMatchObject({ currency: "EUR", exchangeRate: 11 });
    expect(p.rows.map((r) => [r.after.unitPrice, r.after.discountPercent, r.origin, r.review])).toEqual([
      // The article's SEK price at today's rate: 220 / 11.
      [20, 0, "chain", null],
      // The new customer's own price, in its currency.
      [40, 0, "chain", null],
      // 110 kr = 10 EUR; the handwritten discount stays.
      [10, 5, "converted", "manual"],
    ]);
    expect((await changeNow(made.order.id, next.id, p)).statusCode).toBe(200);
    const after = await stored(made.order.id);
    expect(after.order).toMatchObject({ currency: "EUR", exchangeRate: "11.000000", customerId: next.id });
    expect(after.rows.map((r) => r.unitPrice)).toEqual(["20.0000", "40.0000", "10.0000"]);
    expect((await changeAudits())[0]!.detail).toMatchObject({ before: { currency: "SEK", exchangeRate: 1 }, after: { currency: "EUR", exchangeRate: 11 } });
  });

  it("EUR → SEK: the rate becomes 1 and kept prices kronor at the order's own rate; the same foreign currency keeps the order's rate", async () => {
    await eurRate(11);
    const old = await customer("Alte Kunde GmbH", { currency: "EUR" });
    const next = await customer("Nya Kunden AB");
    const sister = await customer("Schwester GmbH", { currency: "EUR" });
    const art = await article({ salesPrice: 220 });
    // The order was made at another rate than today's.
    const made = await order(old.id, [{ articleId: art.id, quantity: 1, unitPrice: 30 }], { exchangeRate: 10 });
    const same = (await preview(made.order.id, sister.id)).json() as CustomerChangePreview;
    expect(same.to).toMatchObject({ currency: "EUR", exchangeRate: 10 });
    expect(same.rows[0]).toMatchObject({ after: { unitPrice: 30 }, origin: "unchanged", review: "manual" });

    const p = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;
    expect(p.to).toMatchObject({ currency: "SEK", exchangeRate: 1 });
    expect(p.rows[0]).toMatchObject({ before: { unitPrice: 30 }, after: { unitPrice: 300 }, origin: "converted" });
    expect((await changeNow(made.order.id, next.id, p)).statusCode).toBe(200);
    expect((await stored(made.order.id)).order).toMatchObject({ currency: "SEK", exchangeRate: "1.000000" });
  });

  it("no rate today ⇒ 409 exchange-rate-unavailable and nothing written; a typed rate goes through", async () => {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Neue Kunde GmbH", { currency: "EUR" });
    const art = await article({ salesPrice: 100 });
    const made = await order(old.id, [{ articleId: art.id, quantity: 1, unitPrice: 120 }]);
    const missing = await preview(made.order.id, next.id);
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ code: "exchange-rate-unavailable", currency: "EUR" });
    expect((await stored(made.order.id)).order.customerId).toBe(old.id);

    const res = await change(made.order.id, next.id, { exchangeRate: 12 });
    expect(res.statusCode).toBe(200);
    const after = await stored(made.order.id);
    expect(after.order).toMatchObject({ currency: "EUR", exchangeRate: "12.000000" });
    expect(after.rows[0]!.unitPrice).toBe("10.0000");
  });

  it("the order's own markup stays and prices the new customer's rows as the markup repricing would", async () => {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB");
    const art = await article({ salesPrice: 100 });
    const made = await order(old.id, [{ articleId: art.id, quantity: 1 }]);
    await ok("PATCH", `/sales-orders/${made.order.id}`, { generalMarkupPercent: 15, confirmRepricing: true });
    // No calculation: the chain's Kalkylpris step falls through to the
    // article's price for both customers — the same answer the header's own
    // repricing gives.
    const p = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;
    expect(p.rows[0]).toMatchObject({ after: { unitPrice: 100, priceOrigin: "chain" }, origin: "chain", review: null });
    expect((await changeNow(made.order.id, next.id, p)).statusCode).toBe(200);
    expect((await stored(made.order.id)).order.generalMarkupPercent).toBe("15.00");
  });
});

describe("the preview must still hold", () => {
  it("409 with the fresh preview when a price, a row, the new customer's agreement or the customer moved since the preview — nothing written", async () => {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB");
    const art = await article({ salesPrice: 100 });
    const made = await order(old.id, [{ articleId: art.id, quantity: 1, unitPrice: 90 }]);
    const seen = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;

    // The row's price is changed on the card meanwhile.
    await ok("PATCH", `/sales-orders/${made.order.id}/rows/${made.rows[0]!.id}`, { unitPrice: 95, bumpRevision: false });
    const before = await stored(made.order.id);
    let res = await changeNow(made.order.id, next.id, seen);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("sales-order-customer-change-stale");
    expect(res.json().preview.rows[0].after.unitPrice).toBe(95);
    expect(await stored(made.order.id)).toEqual(before);

    // A row is added (priced by the chain).
    let fresh = res.json().preview as CustomerChangePreview;
    await ok("POST", `/sales-orders/${made.order.id}/rows`, { articleId: art.id, quantity: 2, bumpRevision: false });
    res = await changeNow(made.order.id, next.id, fresh);
    expect(res.statusCode).toBe(409);
    expect(res.json().preview.rows).toHaveLength(2);

    // The new customer gets a price of its own.
    fresh = res.json().preview as CustomerChangePreview;
    await customerPrice(next.id, art.id, 60);
    res = await changeNow(made.order.id, next.id, fresh);
    expect(res.statusCode).toBe(409);
    expect(res.json().preview.rows.map((r: { after: { unitPrice: number } }) => r.after.unitPrice)).toEqual([95, 60]);

    // The order was moved to a third customer: the preview's "from" is gone.
    const third = await customer("Tredje Kunden AB");
    const final = res.json().preview as CustomerChangePreview;
    expect((await change(made.order.id, third.id)).statusCode).toBe(200);
    res = await changeNow(made.order.id, next.id, final);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("sales-order-customer-change-stale");
    expect(res.json().preview.from.customerId).toBe(third.id);
    expect((await stored(made.order.id)).order.customerId).toBe(third.id);
    expect(await changeAudits()).toHaveLength(1);

    // …and with the fresh preview it goes through.
    res = await changeNow(made.order.id, next.id, res.json().preview);
    expect(res.statusCode).toBe(200);
  });

  it("the facts are read again under the locks: a price committed while the change waits makes it stale", async () => {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB");
    const art = await article({ salesPrice: 100 });
    const made = await order(old.id, [{ articleId: art.id, quantity: 1, unitPrice: 90 }]);
    const seen = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;
    const { revision } = (await stored(made.order.id)).order;

    const res = await whileHolding(
      (tx) => tx.update(salesOrderRows).set({ unitPrice: "150" }).where(eq(salesOrderRows.id, made.rows[0]!.id)),
      () => changeNow(made.order.id, next.id, seen)
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("sales-order-customer-change-stale");
    expect(res.json().preview.rows[0].after.unitPrice).toBe(150);
    expect((await stored(made.order.id)).order).toMatchObject({ customerId: old.id, revision });
  });

  it("the new customer's förval are part of the basis: a term changed while the change waits makes it stale", async () => {
    const pt = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB");
    const art = await article({ salesPrice: 100 });
    const made = await order(old.id, [{ articleId: art.id, quantity: 1 }]);
    const seen = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;
    const res = await whileHolding(
      async (tx) => {
        await tx.select().from(salesOrders).where(eq(salesOrders.id, made.order.id)).for("update");
        await tx.execute(sql`UPDATE customers SET payment_term_id = ${pt.id} WHERE id = ${next.id}`);
      },
      () => changeNow(made.order.id, next.id, seen)
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("sales-order-customer-change-stale");
    expect(res.json().preview.header.paymentTerm).toBe("30 · 30 dagar netto");
    expect((await stored(made.order.id)).order.customerId).toBe(old.id);
  });
});

describe("concurrency with a delivery", () => {
  async function fixture() {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB");
    const art = await article({ salesPrice: 100 });
    await stock(art.id);
    const made = await order(old.id, [{ articleId: art.id, quantity: 4 }], { confirm: true });
    await ok("POST", `/sales-orders/${made.order.id}/start-production`, {});
    const seen = (await preview(made.order.id, next.id)).json() as CustomerChangePreview;
    return { old, next, order: made.order, row: made.rows[0]!, seen };
  }

  it("the change waits for a delivery holding the row and is then refused (rows before the order — no deadlock)", async () => {
    const f = await fixture();
    // The delivery's locks: row, then order — and what it writes.
    const changed = await whileHolding(
      async (tx) => {
        await tx.select().from(salesOrderRows).where(eq(salesOrderRows.id, f.row.id)).for("update");
        await tx.select().from(salesOrders).where(eq(salesOrders.id, f.order.id)).for("update");
        await tx.update(salesOrderRows).set({ quantityDelivered: "4" }).where(eq(salesOrderRows.id, f.row.id));
        await tx.update(salesOrders).set({ status: "delivered" }).where(eq(salesOrders.id, f.order.id));
      },
      () => changeNow(f.order.id, f.next.id, f.seen)
    );
    expect(changed.statusCode).toBe(409);
    expect(changed.json().code).toBe("invalid-status-transition");
    expect((await stored(f.order.id)).order).toMatchObject({ customerId: f.old.id, status: "delivered" });
    expect(await changeAudits()).toHaveLength(0);
  });

  it("a plain race with a real delivery ends consistently: delivered at the old customer, or changed and then delivered at the new", async () => {
    for (let i = 0; i < 3; i++) {
      const f = await fixture();
      const [delivered, changed] = await Promise.all([
        call("POST", `/sales-orders/${f.order.id}/deliver`, { locationId: location!.id, rows: [{ rowId: f.row.id, quantity: 4 }] }),
        changeNow(f.order.id, f.next.id, f.seen),
      ]);
      const after = await stored(f.order.id);
      expect(delivered.statusCode).toBe(201);
      if (changed.statusCode === 200) {
        // The change committed first; the delivery then ran on the new customer's order.
        expect(after.order.customerId).toBe(f.next.id);
      } else {
        expect(changed.statusCode).toBe(409);
        expect(["sales-order-has-deliveries", "invalid-status-transition"]).toContain(changed.json().code);
        expect(after.order.customerId).toBe(f.old.id);
      }
      expect(after.order.status).toBe("delivered");
    }
  });

  it("two changes at once: one goes through, the other finds the order already at that customer", async () => {
    const f = await fixture();
    const { revision } = (await stored(f.order.id)).order;
    const [a, b] = await Promise.all([changeNow(f.order.id, f.next.id, f.seen), changeNow(f.order.id, f.next.id, f.seen)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expect((await stored(f.order.id)).order).toMatchObject({ customerId: f.next.id, revision: revision + 1 });
    expect(await changeAudits()).toHaveLength(1);
  });
});

describe("permissions", () => {
  it("needs Försäljning; a read-only account may preview but not change", async () => {
    const old = await customer("Gamla Kunden AB");
    const next = await customer("Nya Kunden AB");
    const art = await article({ salesPrice: 100 });
    const { order: o } = await order(old.id, [{ articleId: art.id, quantity: 1 }]);
    const seen = (await preview(o.id, next.id)).json() as CustomerChangePreview;
    const body = { customerId: next.id, expected: expectedOf(seen) };

    const other = await userCookie(["inkop", "tillverkning"]);
    expect((await preview(o.id, next.id, {}, other)).statusCode).toBe(403);
    expect((await call("POST", `/sales-orders/${o.id}/change-customer`, body, other)).statusCode).toBe(403);

    const readOnly = await userCookie(["forsaljning"], true);
    expect((await preview(o.id, next.id, {}, readOnly)).statusCode).toBe(200);
    const refused = await call("POST", `/sales-orders/${o.id}/change-customer`, body, readOnly);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("read-only-account");
    expect((await stored(o.id)).order.customerId).toBe(old.id);

    const seller = await userCookie(["forsaljning"]);
    expect((await call("POST", `/sales-orders/${o.id}/change-customer`, body, seller)).statusCode).toBe(200);
    expect((await stored(o.id)).order.customerId).toBe(next.id);
  });
});

describe("the pure plan", () => {
  const facts = (): CustomerChangeFacts => ({
    order: {
      id: "o",
      orderNumber: "KO-1",
      documentKind: "order",
      status: "confirmed",
      customerId: "c-old",
      customerNumber: "1001",
      customerName: "Gamla",
      currency: "SEK",
      exchangeRate: 1,
      generalMarkupPercent: null,
      materialMarkupPercent: null,
      customerOrderNumber: null,
      customerInquiryNumber: null,
      deliveryAddressId: null,
      deliveryAddressOneOff: false,
      hasFreightChoice: false,
    },
    customer: {
      id: "c-new",
      customerNumber: "1002",
      name: "Nya",
      currency: "EUR",
      deliveryTermId: null,
      paymentTermId: null,
      carrierId: null,
      deliveryTerm: null,
      paymentTerm: null,
      carrier: null,
      customerReference: null,
      defaultDeliveryAddress: null,
      invoiceCustomer: null,
    },
    rows: [
      { rowId: "r1", articleId: "a1", articleNumber: "A1", articleName: "Ett", quantity: 3, quantityDelivered: 0, unitPrice: 33.3333, discountPercent: 2.5, priceOrigin: "manual", unitCode: "st", unitFactor: null, configured: false, setupForRowId: null },
      { rowId: "r2", articleId: "a2", articleNumber: "A2", articleName: "Två", quantity: 1, quantityDelivered: 0, unitPrice: 100, discountPercent: 0, priceOrigin: "calculated", unitCode: "st", unitFactor: null, configured: false, setupForRowId: null },
    ],
    liveDeliveries: 0,
    invoices: [],
    shipments: [],
    deviations: [],
  });

  it("converts kept prices with four decimals at old rate / new rate and takes the chain's step as the origin", () => {
    const plan = planCustomerChange(facts(), {
      newRate: 11.5,
      freightArticleId: null,
      chain: new Map([["r2", { unitPrice: 9.87654, discountPercent: 0, source: "calculated" as const }]]),
    });
    expect(plan.rows[0]!.after).toEqual({ unitPrice: 2.8985, discountPercent: 2.5, priceOrigin: "manual", source: null });
    expect(plan.rows[1]!.after).toEqual({ unitPrice: 9.8765, discountPercent: 0, priceOrigin: "calculated", source: "calculated" });
    // An answer for a handwritten row is never used.
    const ignored = planCustomerChange(facts(), { newRate: 11.5, freightArticleId: null, chain: new Map([["r1", { unitPrice: 1, discountPercent: 0, source: "article" as const }]]) });
    expect(ignored.rows[0]!.review).toBe("manual");
    expect(ignored.rows[1]!.review).toBe("no-price");
  });

  it("matchesExpected compares at the columns' scales and the rows as a set; the basis moves with every input of the plan", () => {
    const plan = planCustomerChange(facts(), { newRate: 11.5, freightArticleId: null, chain: new Map() });
    const expected = {
      customerId: "c-old",
      currency: "EUR",
      exchangeRate: 11.5000001,
      rows: [...plan.rows].reverse().map((r) => ({ rowId: r.rowId, unitPrice: r.after.unitPrice + 0.00001, discountPercent: r.after.discountPercent })),
    };
    expect(matchesExpectedCustomerChange(plan, expected)).toBe(true);
    expect(matchesExpectedCustomerChange(plan, { ...expected, rows: expected.rows.slice(1) })).toBe(false);
    expect(matchesExpectedCustomerChange(plan, { ...expected, currency: "SEK" })).toBe(false);
    expect(matchesExpectedCustomerChange(plan, { ...expected, rows: expected.rows.map((r) => ({ ...r, discountPercent: r.discountPercent + 1 })) })).toBe(false);

    const base = customerChangeBasis(facts());
    const moved = (edit: (f: CustomerChangeFacts) => void) => {
      const f = facts();
      edit(f);
      return customerChangeBasis(f) !== base;
    };
    expect(moved((f) => (f.rows[0]!.unitPrice = 34))).toBe(true);
    expect(moved((f) => (f.rows[0]!.priceOrigin = "chain"))).toBe(true);
    expect(moved((f) => (f.order.exchangeRate = 2))).toBe(true);
    expect(moved((f) => (f.order.generalMarkupPercent = "10.00"))).toBe(true);
    expect(moved((f) => (f.customer.currency = "SEK"))).toBe(true);
    expect(moved((f) => (f.customer.customerReference = "Ny"))).toBe(true);
    expect(moved((f) => f.rows.reverse())).toBe(false);
    // What is only cleared, or judged as a blocker, is not part of it.
    expect(moved((f) => (f.order.customerOrderNumber = "PO-1"))).toBe(false);
    expect(moved((f) => (f.order.status = "delivered"))).toBe(false);
  });
});
