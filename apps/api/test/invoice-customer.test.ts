import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { auditLog, customers, db, invoices, permissionGroups, salesOrders, shipmentDeliveries, shipments } from "@navet/db";
import {
  createArticleSchema,
  createCustomerSchema,
  createQuoteSchema,
  createStockLocationSchema,
  updateCustomerSchema,
  updateSalesOrderHeaderSchema,
} from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import {
  CollectiveInvoicingCustomerError,
  createInvoiceService,
  SalesOrderRowMismatchError,
} from "../src/modules/sales/service/invoice.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import {
  CustomerIsInvoiceCustomerError,
  InvoiceCustomerHasInvoiceCustomerError,
} from "../src/modules/sales/service/sales.errors.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { parsed } from "./helpers/parsed.js";
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { makeDelivery } from "./helpers/shipping-fixtures.js";
import { resetVatCodes } from "./helpers/vat-codes.js";

// Fakturakund (migration 0230): the invoice for an order goes to another
// customer than the one ordering. The customer card's förval and its chain
// guard, the order's own field (header PATCH, the payment term that follows
// it), and the invoice: who an order is billable to, what the invoice takes
// from the paying customer (address, VAT, language, terms, ledger), what
// stays the orderer's (prices, Ert art.nr), the samlingsfaktura per paying
// customer, the freight, the credit note and the PDFs. All data made up.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const documentPdfService = createDocumentPdfService(systemService);
const auditRepository = createAuditRepository(db);
const authService = createAuthService(authRepo, "unused", auditRepository);
const registerService = createRegisterService(createRegisterRepository(db));
let freightArticleId: string | null = null;
const freightReader = { freightArticleId: async () => freightArticleId };
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository,
  undefined,
  undefined,
  undefined,
  undefined,
  freightReader
);
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  documentPdfService,
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  auditRepository,
  articleService,
  freightReader
);

const PASSWORD = "correcthorsebattery";
const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_documents, invoice_rows, invoices, shipment_deliveries, shipments, audit_log, delivery_rows, deliveries, sales_order_rows, sales_orders, customer_article_numbers, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, user_settings, users CASCADE`;

let app: ReturnType<typeof buildApp>;
let user: { id: string };
let cookie: string;
let seq = 0;
const groupIds: string[] = [];

beforeAll(async () => {
  app = buildApp(db);
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TABLES);
  await resetVatCodes();
  await setupPostingBaseline();
  freightArticleId = null;
  cachedLocation = null;
  const email = `fk-${crypto.randomUUID()}@example.com`;
  user = await authService.createUser({ email, password: PASSWORD, name: "Säljaren", role: "admin" });
  cookie = await login(email);
});
afterAll(async () => {
  await app.close();
  await db.execute(TABLES);
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
    .values({ code: `FK${crypto.randomUUID().slice(0, 6)}`, name: "Fakturakund", permissions })
    .returning();
  groupIds.push(group!.id);
  const email = `fk-user-${crypto.randomUUID()}@example.com`;
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

async function customer(name: string, extra: Record<string, unknown> = {}) {
  return salesService.createCustomer(parsed(createCustomerSchema, { name, ...extra }), user.id);
}
async function setInvoiceCustomer(customerId: string, invoiceCustomerId: string | null) {
  return salesService.updateCustomer(customerId, parsed(updateCustomerSchema, { invoiceCustomerId }), user.id);
}
async function article(name = "Bänkskiva") {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `FK-${++seq}-${crypto.randomUUID().slice(0, 6)}`, name, type: "purchased", active: true })
  );
}
// One warehouse per test (Flera lager is off by default).
let cachedLocation: Awaited<ReturnType<typeof stockService.createLocation>> | null = null;
async function location() {
  return (cachedLocation ??= await newLocation());
}
async function newLocation() {
  const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID().slice(0, 6)}`, active: true });
  return stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
}
type Row = { articleId: string; quantity: number; unitPrice: number };
async function quote(customerId: string, rows: Row[], extra: Record<string, unknown> = {}) {
  return salesService.createQuote(parsed(createQuoteSchema, { customerId, rows, ...extra }), user.id);
}
// A confirmed order, fully delivered from a stocked location.
async function deliveredOrder(customerId: string, rows: Row[]) {
  const loc = await location();
  for (const articleId of new Set(rows.map((r) => r.articleId))) {
    await stockService.recordTransaction({ articleId, locationId: loc.id, quantityDelta: 1000, transactionType: "inventory_adjustment" });
  }
  const created = await quote(customerId, rows, { confirm: true });
  await salesService.startProduction(created.order.id);
  await salesService.deliverBatch(
    created.order.id,
    { locationId: loc.id, rows: created.rows.map((r) => ({ rowId: r.id, quantity: Number(r.quantityOrdered) })) },
    user.id
  );
  return created;
}
async function invoiceFor(customerId: string, opts: { collective?: boolean } = {}) {
  const orders = await invoiceService.listInvoiceableOrders(customerId);
  return invoiceService.create(
    {
      customerId,
      rows: orders.flatMap((o) =>
        o.rows.map((r) => ({
          articleId: r.articleId,
          salesOrderRowId: r.salesOrderRowId,
          description: r.articleName,
          quantity: r.rest,
          unitPrice: Number(r.unitPrice),
          discountPercent: Number(r.discountPercent),
        }))
      ),
    },
    user.id,
    opts
  );
}
async function orderRow(orderId: string) {
  const [row] = await db.select().from(salesOrders).where(eq(salesOrders.id, orderId));
  return row!;
}
async function audits(action: string) {
  return db.select().from(auditLog).where(eq(auditLog.action, action));
}

describe("Fakturakund on the customer card", () => {
  it("stores the choice, shows both directions on the cards, treats the customer itself as none and logs the change", async () => {
    const orderer = await customer("Beställaren AB");
    const payer = await customer("Betalaren AB");

    const set = await call("PATCH", `/customers/${orderer.id}`, { invoiceCustomerId: payer.id });
    expect(set.statusCode).toBe(200);
    expect(set.json().invoiceCustomerId).toBe(payer.id);

    const card = (await call("GET", `/customers/${orderer.id}`)).json();
    expect(card.invoiceCustomer).toEqual({ id: payer.id, customerNumber: payer.customerNumber, name: "Betalaren AB" });
    expect(card.invoiceCustomerFor).toEqual([]);
    const payerCard = (await call("GET", `/customers/${payer.id}`)).json();
    expect(payerCard.invoiceCustomer).toBeNull();
    expect(payerCard.invoiceCustomerFor).toEqual([{ id: orderer.id, customerNumber: orderer.customerNumber, name: "Beställaren AB" }]);

    // The customer itself is "the customer": stored as null, not refused.
    const self = await call("PATCH", `/customers/${orderer.id}`, { invoiceCustomerId: orderer.id });
    expect(self.statusCode).toBe(200);
    expect(self.json().invoiceCustomerId).toBeNull();

    const log = (await audits("invoice_customer_changed")).filter((a) => a.entityType === "customer");
    expect(log.map((a) => a.detail)).toEqual([
      { before: null, after: { customerNumber: payer.customerNumber, name: "Betalaren AB" } },
      { before: { customerNumber: payer.customerNumber, name: "Betalaren AB" }, after: null },
    ]);

    // A new customer can be created with one.
    const created = await call("POST", "/customers", { name: "Dotterbolaget AB", invoiceCustomerId: payer.id });
    expect(created.statusCode).toBe(201);
    expect(created.json().invoiceCustomerId).toBe(payer.id);
  });

  it("refuses a chain in both directions, an inactive and an unknown customer — one code each", async () => {
    const a = await customer("A AB");
    const b = await customer("B AB");
    const c = await customer("C AB");
    await setInvoiceCustomer(a.id, b.id);

    // B is A's fakturakund: B cannot get one of its own…
    const up = await call("PATCH", `/customers/${b.id}`, { invoiceCustomerId: c.id });
    expect(up.statusCode).toBe(400);
    expect(up.json().code).toBe("customer-is-invoice-customer");
    expect(up.json().error).toContain(a.customerNumber);
    // …and A, which has one, cannot be chosen by C.
    const down = await call("PATCH", `/customers/${c.id}`, { invoiceCustomerId: a.id });
    expect(down.statusCode).toBe(400);
    expect(down.json().code).toBe("invoice-customer-has-invoice-customer");
    const onCreate = await call("POST", "/customers", { name: "Ny AB", invoiceCustomerId: a.id });
    expect(onCreate.statusCode).toBe(400);
    expect(onCreate.json().code).toBe("invoice-customer-has-invoice-customer");

    const inactive = await customer("Vilande AB", { active: false });
    const refused = await call("PATCH", `/customers/${c.id}`, { invoiceCustomerId: inactive.id });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("invoice-customer-inactive");

    const unknown = await call("PATCH", `/customers/${c.id}`, { invoiceCustomerId: crypto.randomUUID() });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("invoice-customer-not-found");

    const [stored] = await db.select().from(customers).where(eq(customers.id, c.id));
    expect(stored!.invoiceCustomerId).toBeNull();
  });

  it("two concurrent saves that together would build a chain: exactly one is stored", async () => {
    for (let round = 0; round < 5; round++) {
      const a = await customer(`A${round} AB`);
      const b = await customer(`B${round} AB`);
      const c = await customer(`C${round} AB`);
      const results = await Promise.allSettled([setInvoiceCustomer(a.id, b.id), setInvoiceCustomer(b.id, c.id)]);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(failed).toHaveLength(1);
      expect(
        failed[0]!.reason instanceof CustomerIsInvoiceCustomerError || failed[0]!.reason instanceof InvoiceCustomerHasInvoiceCustomerError
      ).toBe(true);
      const rows = await db.select().from(customers).where(inArray(customers.id, [a.id, b.id]));
      expect(rows.filter((r) => r.invoiceCustomerId !== null)).toHaveLength(1);
    }
  });

  it("needs Försäljning, and a read-only account cannot set it", async () => {
    const orderer = await customer("Beställaren AB");
    const payer = await customer("Betalaren AB");
    const noSales = await call("PATCH", `/customers/${orderer.id}`, { invoiceCustomerId: payer.id }, await userCookie(["inkop"]));
    expect(noSales.statusCode).toBe(403);
    const readOnly = await call("PATCH", `/customers/${orderer.id}`, { invoiceCustomerId: payer.id }, await userCookie(["forsaljning"], true));
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("read-only-account");
  });
});

describe("Fakturakund on the quote and the order", () => {
  it("a new quote takes the customer's förval and the paying customer's payment term; Skapa kundorder copies both", async () => {
    const term10 = await registerService.paymentTerms.create({ code: "10", name: "10 dagar netto" });
    const term30 = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const payer = await customer("Betalaren AB", { paymentTermId: term30.id });
    const orderer = await customer("Beställaren AB", { paymentTermId: term10.id, invoiceCustomerId: payer.id });
    const art = await article();

    const { order } = await quote(orderer.id, [{ articleId: art.id, quantity: 2, unitPrice: 100 }]);
    expect(order.invoiceCustomerId).toBe(payer.id);
    expect(order.paymentTermId).toBe(term30.id);

    const card = (await call("GET", `/sales-orders/${order.id}`)).json();
    expect(card.customerId).toBe(orderer.id);
    expect(card.invoiceCustomer).toEqual({ id: payer.id, customerNumber: payer.customerNumber, name: "Betalaren AB" });
    expect(card.billToCustomerId).toBe(payer.id);

    const created = await call("POST", `/sales-orders/${order.id}/create-order`);
    expect(created.statusCode).toBe(201);
    const copy = await orderRow(created.json().id);
    expect(copy.invoiceCustomerId).toBe(payer.id);
    expect(copy.paymentTermId).toBe(term30.id);

    // A customer without one: the order has none, the card says so.
    const plain = await quote(payer.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }]);
    expect(plain.order.invoiceCustomerId).toBeNull();
    const plainCard = (await call("GET", `/sales-orders/${plain.order.id}`)).json();
    expect(plainCard.invoiceCustomer).toBeNull();
    expect(plainCard.billToCustomerId).toBe(payer.id);
  });

  it("POST /quotes never takes the field from the caller — the förval applies", async () => {
    const payer = await customer("Betalaren AB");
    const other = await customer("Någon annan AB");
    const orderer = await customer("Beställaren AB", { invoiceCustomerId: payer.id });
    const art = await article();
    const res = await call("POST", "/quotes", {
      customerId: orderer.id,
      invoiceCustomerId: other.id,
      rows: [{ articleId: art.id, quantity: 1, unitPrice: 10 }],
    });
    expect(res.statusCode).toBe(201);
    expect((await orderRow(res.json().order.id)).invoiceCustomerId).toBe(payer.id);
  });

  it("the header PATCH sets it, the payment term follows unless sent, the orderer itself is none, and the change is logged", async () => {
    const term10 = await registerService.paymentTerms.create({ code: "10", name: "10 dagar netto" });
    const term30 = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const term60 = await registerService.paymentTerms.create({ code: "60", name: "60 dagar netto" });
    const orderer = await customer("Beställaren AB", { paymentTermId: term10.id });
    const payer = await customer("Betalaren AB", { paymentTermId: term30.id });
    const art = await article();
    const { order } = await quote(orderer.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }], { confirm: true });
    expect(order.paymentTermId).toBe(term10.id);

    const set = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: payer.id });
    expect(set.statusCode).toBe(200);
    expect(set.json().invoiceCustomerId).toBe(payer.id);
    expect(set.json().paymentTermId).toBe(term30.id);
    expect(set.json().revision).toBe(order.revision + 1);

    // The same choice again changes nothing (and the term typed in between stays).
    await call("PATCH", `/sales-orders/${order.id}`, { paymentTermId: term60.id });
    const again = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: payer.id });
    expect(again.json().paymentTermId).toBe(term60.id);

    // The orderer itself = none; the term goes back to the orderer's…
    const cleared = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: orderer.id });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().invoiceCustomerId).toBeNull();
    expect(cleared.json().paymentTermId).toBe(term10.id);
    // …unless the same PATCH sends one.
    const both = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: payer.id, paymentTermId: term60.id });
    expect(both.json().paymentTermId).toBe(term60.id);

    const log = (await audits("invoice_customer_changed")).filter((a) => a.entityType === "sales_order");
    expect(log).toHaveLength(3);
    expect(log.every((a) => a.entityId === order.orderNumber)).toBe(true);
    expect(log.map((a) => a.detail)).toContainEqual({ before: null, after: { customerNumber: payer.customerNumber, name: "Betalaren AB" } });
    expect(log.map((a) => a.detail)).toContainEqual({ before: { customerNumber: payer.customerNumber, name: "Betalaren AB" }, after: null });
  });

  it("refuses a customer with a fakturakund of its own, an inactive and an unknown one — and an order that is no longer editable", async () => {
    const orderer = await customer("Beställaren AB");
    const payer = await customer("Betalaren AB");
    const chained = await customer("Kedjan AB", { invoiceCustomerId: payer.id });
    const inactive = await customer("Vilande AB", { active: false });
    const art = await article();
    const { order } = await quote(orderer.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }]);

    const chain = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: chained.id });
    expect(chain.statusCode).toBe(400);
    expect(chain.json().code).toBe("invoice-customer-has-invoice-customer");
    const vilande = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: inactive.id });
    expect(vilande.statusCode).toBe(400);
    expect(vilande.json().code).toBe("invoice-customer-inactive");
    const unknown = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: crypto.randomUUID() });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe("invoice-customer-not-found");
    expect((await orderRow(order.id)).invoiceCustomerId).toBeNull();

    // "Tvärtom" is the customer card's rule only: an orderer that is itself
    // someone's fakturakund may have this one order billed elsewhere.
    const parentOrder = await quote(payer.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }]);
    const elsewhere = await call("PATCH", `/sales-orders/${parentOrder.order.id}`, { invoiceCustomerId: orderer.id });
    expect(elsewhere.statusCode).toBe(200);

    // The header's own status guard: a delivered order is not editable.
    const delivered = await deliveredOrder(orderer.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }]);
    const late = await call("PATCH", `/sales-orders/${delivered.order.id}`, { invoiceCustomerId: payer.id });
    expect(late.statusCode).toBe(409);
    expect(late.json().code).toBe("invalid-status-transition");
  });

  it("needs Försäljning, and a read-only account cannot set it", async () => {
    const orderer = await customer("Beställaren AB");
    const payer = await customer("Betalaren AB");
    const art = await article();
    const { order } = await quote(orderer.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }]);
    const noSales = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: payer.id }, await userCookie(["inkop"]));
    expect(noSales.statusCode).toBe(403);
    const readOnly = await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: payer.id }, await userCookie(["forsaljning"], true));
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().code).toBe("read-only-account");
    expect(updateSalesOrderHeaderSchema.safeParse({ invoiceCustomerId: "not-a-uuid" }).success).toBe(false);
  });

  it("the order's VAT is the paying customer's, the prices and the document the orderer's; the confirmation names the Fakturamottagare", async () => {
    const orderer = await customer("Beställaren AB");
    const payer = await customer("Zahler GmbH", { country: "DE", vatNumber: "DE123456789", language: "en" });
    const art = await article();
    const { order } = await quote(orderer.id, [{ articleId: art.id, quantity: 2, unitPrice: 100 }], { confirm: true });
    expect((await salesService.getSalesOrder(order.id))!.vatSummary).toMatchObject({ totalExclVat: 200, vatAmount: 50 });

    await call("PATCH", `/sales-orders/${order.id}`, { invoiceCustomerId: payer.id });
    const after = (await salesService.getSalesOrder(order.id))!;
    expect(after.vatSummary).toMatchObject({ totalExclVat: 200, vatAmount: 0, totalInclVat: 200 });
    expect(after.vatSummary!.lines.map((l) => l.code)).toEqual(["EUV"]);

    // Swedish (the orderer's language), addressed to the orderer, and the
    // paying customer named among the facts.
    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "confirmation")).content);
    expect(text).toContain("Orderbekräftelse");
    expect(text).toContain("Beställaren AB");
    expect(text).toContain(`Fakturamottagare`);
    expect(text).toContain(`${payer.customerNumber} Zahler GmbH`);

    // Without a fakturakund nothing is printed.
    const plain = await quote(orderer.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }], { confirm: true });
    expect(pdfText((await salesService.getSalesOrderPdf(plain.order.id, "confirmation")).content)).not.toContain("Fakturamottagare");
  });
});

describe("The invoice goes to the fakturakund", () => {
  it("the order is billable to the paying customer only, and the invoice takes address, VAT, language, terms and ledger from it", async () => {
    const term10 = await registerService.paymentTerms.create({ code: "10", name: "10 dagar netto" });
    const term45 = await registerService.paymentTerms.create({ code: "45", name: "45 days net" });
    const payer = await customer("Zahler GmbH", {
      country: "DE",
      vatNumber: "DE123456789",
      language: "en",
      paymentTermId: term45.id,
      invoiceAddress: "Rechnungsweg 9",
      invoicePostalCode: "10115",
      invoiceCity: "Berlin",
      invoiceCountry: "DE",
    });
    const orderer = await customer("Beställaren AB", { paymentTermId: term10.id, invoiceCustomerId: payer.id, address: "Verkstadsgatan 1", city: "Borås" });
    const art = await article("Diskbänk");
    await salesService.addCustomerArticleNumber(orderer.id, { articleId: art.id, customerArticleNumber: "BEST-4711" });
    await salesService.addCustomerArticleNumber(payer.id, { articleId: art.id, customerArticleNumber: "ZAHL-0001" });
    const { order } = await deliveredOrder(orderer.id, [{ articleId: art.id, quantity: 4, unitPrice: 250 }]);

    // Billable to the paying customer; the orderer has nothing to invoice.
    expect(await invoiceService.listInvoiceableOrders(orderer.id)).toEqual([]);
    const invoiceable = await invoiceService.listInvoiceableOrders(payer.id);
    expect(invoiceable).toHaveLength(1);
    expect(invoiceable[0]).toMatchObject({
      orderId: order.id,
      customerId: orderer.id,
      customerNumber: orderer.customerNumber,
      customerName: "Beställaren AB",
    });
    // The derived momskod is the paying customer's (EU sale, 0 %).
    expect(invoiceable[0]!.rows[0]!.vatCode!.code).toBe("EUV");

    // An invoice to the orderer cannot carry the order's rows.
    await expect(
      invoiceService.create(
        {
          customerId: orderer.id,
          rows: invoiceable[0]!.rows.map((r) => ({
            articleId: r.articleId,
            salesOrderRowId: r.salesOrderRowId,
            description: r.articleName,
            quantity: r.rest,
            unitPrice: Number(r.unitPrice),
          })),
        },
        user.id
      )
    ).rejects.toBeInstanceOf(SalesOrderRowMismatchError);

    const draft = await invoiceFor(payer.id);
    const issued = await invoiceService.issue(draft!.id, user.id);
    const invoice = (await invoiceService.getInvoice(issued!.id))!;
    expect(invoice.customerId).toBe(payer.id);
    expect(invoice.customerName).toBe("Zahler GmbH");
    expect(invoice.invoiceAddress).toBe("Rechnungsweg 9");
    expect(invoice.invoiceCity).toBe("Berlin");
    expect(invoice.vatNumber).toBe("DE123456789");
    expect(invoice.language).toBe("en");
    expect(invoice.paymentTermId ?? term45.id).toBe(term45.id);
    // 45 days from the invoice date.
    const due = new Date(`${invoice.invoiceDate}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 45);
    expect(invoice.dueDate).toBe(due.toISOString().slice(0, 10));
    expect(invoice.rows).toHaveLength(1);
    expect(invoice.rows[0]).toMatchObject({ vatRate: "0.00", lineAmount: "1000.00", vatAmount: "0.00", orderCustomerId: orderer.id, orderCustomerName: "Beställaren AB" });

    // The ledger: the open item is the paying customer's.
    const open = await db.select().from(invoices).where(and(eq(invoices.customerId, payer.id), eq(invoices.status, "issued")));
    expect(open.map((i) => i.id)).toEqual([invoice.id]);
    expect(await db.select().from(invoices).where(eq(invoices.customerId, orderer.id))).toEqual([]);

    // The PDF: English, addressed to the paying customer, the row naming the
    // orderer and carrying the ORDERER's article number.
    const text = pdfText((await invoiceService.renderPdf(invoice.id)).content);
    expect(text).toContain("Zahler GmbH");
    expect(text).toContain("Rechnungsweg 9");
    expect(text).toContain(`Ordered by: ${orderer.customerNumber} Beställaren AB`);
    expect(text).toContain("BEST-4711");
    expect(text).not.toContain("ZAHL-0001");
  });

  it("an invoice to the orderer itself prints no Beställare, and a free row keeps the invoice customer's article number", async () => {
    const plain = await customer("Vanliga AB");
    const art = await article("Diskbänk");
    await salesService.addCustomerArticleNumber(plain.id, { articleId: art.id, customerArticleNumber: "VAN-1" });
    await deliveredOrder(plain.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }]);
    const draft = await invoiceFor(plain.id);
    await invoiceService.addRow(draft!.id, { articleId: art.id, description: "Extra", quantity: 1, unitPrice: 5 }, user.id);
    const issued = await invoiceService.issue(draft!.id, user.id);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);
    expect(text).not.toContain("Beställare");
    expect(text.match(/VAN-1/g)).toHaveLength(2);
  });

  it("a change only decides invoices created afterwards: the issued invoice, its credit note and a draft's rows stay", async () => {
    const orderer = await customer("Beställaren AB");
    const first = await customer("Första Betalaren AB");
    const second = await customer("Andra Betalaren AB");
    const art = await article();
    const loc = await location();
    await stockService.recordTransaction({ articleId: art.id, locationId: loc.id, quantityDelta: 100, transactionType: "inventory_adjustment" });
    const created = await quote(orderer.id, [{ articleId: art.id, quantity: 10, unitPrice: 100 }], { confirm: true });
    await salesService.updateSalesOrderHeader(created.order.id, parsed(updateSalesOrderHeaderSchema, { invoiceCustomerId: first.id }), user.id);
    await salesService.startProduction(created.order.id);
    const row = created.rows[0]!;
    await salesService.deliverBatch(created.order.id, { locationId: loc.id, rows: [{ rowId: row.id, quantity: 4 }] }, user.id);

    const issued = await invoiceService.issue((await invoiceFor(first.id))!.id, user.id);
    // A second delivery, on a draft for the first payer.
    await salesService.deliverBatch(created.order.id, { locationId: loc.id, rows: [{ rowId: row.id, quantity: 3 }] }, user.id);
    const draft = (await invoiceFor(first.id))!;

    // The order is still Under tillverkning: the fakturakund is changed.
    await salesService.updateSalesOrderHeader(created.order.id, parsed(updateSalesOrderHeaderSchema, { invoiceCustomerId: second.id }), user.id);

    // Nothing moved on the existing invoices.
    expect((await invoiceService.getInvoice(issued!.id))!.customerId).toBe(first.id);
    expect((await invoiceService.getInvoice(draft.id))!.customerId).toBe(first.id);
    // The draft's row can still be edited (it keeps its order row)…
    const draftRow = (await invoiceService.getInvoice(draft.id))!.rows[0]!;
    await invoiceService.updateRow(draft.id, draftRow.id, { description: "Ändrad text" }, user.id);
    expect((await invoiceService.getInvoice(draft.id))!.rows[0]!.description).toBe("Ändrad text");
    // …but the first payer gets no NEW rows from this order,
    await expect(
      invoiceService.addRow(draft.id, { articleId: art.id, salesOrderRowId: row.id, description: "Mer", quantity: 1, unitPrice: 100 }, user.id)
    ).rejects.toBeInstanceOf(SalesOrderRowMismatchError);
    // …and the credit note of the issued invoice follows its source.
    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    expect(credit!.customerId).toBe(first.id);
    expect(credit!.rows[0]!.salesOrderRowId).toBe(row.id);
    await invoiceService.issue(credit!.id, user.id);

    // What is delivered from now on is the second payer's.
    await invoiceService.cancel(draft.id, user.id);
    await salesService.deliverBatch(created.order.id, { locationId: loc.id, rows: [{ rowId: row.id, quantity: 3 }] }, user.id);
    expect(await invoiceService.listInvoiceableOrders(first.id)).toEqual([]);
    const next = await invoiceService.listInvoiceableOrders(second.id);
    expect(next).toHaveLength(1);
    // 10 delivered; the 4 invoiced to the first payer are credited again,
    // so all 10 are open.
    expect(next[0]!.rows[0]!.rest).toBe(10);
    // A credit note follows its own invoice: the second payer's credit may
    // carry the row, the orderer's (never invoiced for it) may not.
    const secondInvoice = await invoiceService.issue((await invoiceFor(second.id))!.id, user.id);
    const secondCredit = await invoiceService.createCredit(secondInvoice!.id, { rows: [] }, user.id);
    await invoiceService.addRow(secondCredit!.id, { articleId: art.id, salesOrderRowId: row.id, description: "Kredit", quantity: 1, unitPrice: 100 }, user.id);
    const own = await invoiceService.create({ customerId: orderer.id, rows: [{ description: "Konsulttid", quantity: 1, unitPrice: 500 }] }, user.id);
    const ownCredit = await invoiceService.createCredit((await invoiceService.issue(own!.id, user.id))!.id, { rows: [] }, user.id);
    await expect(
      invoiceService.addRow(ownCredit!.id, { articleId: art.id, salesOrderRowId: row.id, description: "Kredit", quantity: 1, unitPrice: 100 }, user.id)
    ).rejects.toBeInstanceOf(SalesOrderRowMismatchError);
  });
});

describe("Samlingsfaktura per fakturakund", () => {
  it("one invoice per paying customer with every orderer's orders; the paying customer's flags decide", async () => {
    const payer = await customer("Koncernen AB", { collectiveInvoicing: true });
    const first = await customer("Dotter Ett AB", { invoiceCustomerId: payer.id });
    // Flagged itself, but its orders are billed to the (flagged) payer.
    const second = await customer("Dotter Två AB", { invoiceCustomerId: payer.id, collectiveInvoicing: true });
    // Flagged, billed to a customer that is NOT flagged: no candidate.
    const plainPayer = await customer("Vanliga Betalaren AB");
    const third = await customer("Dotter Tre AB", { invoiceCustomerId: plainPayer.id, collectiveInvoicing: true });
    const art = await article("Bänkskiva");
    const o1 = await deliveredOrder(first.id, [{ articleId: art.id, quantity: 2, unitPrice: 100 }]);
    const o2 = await deliveredOrder(second.id, [{ articleId: art.id, quantity: 3, unitPrice: 100 }]);
    const o3 = await deliveredOrder(payer.id, [{ articleId: art.id, quantity: 1, unitPrice: 100 }]);
    await deliveredOrder(third.id, [{ articleId: art.id, quantity: 5, unitPrice: 100 }]);

    const candidates = await invoiceService.listCollectiveInvoicingCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ customerId: payer.id, orderCount: 3, rowCount: 3, netAmount: 600 });

    // The dialog and the guard: the paying customer is billed by the routine.
    await expect(invoiceFor(payer.id)).rejects.toBeInstanceOf(CollectiveInvoicingCustomerError);
    // The unflagged payer is invoiced by hand, whatever the orderer's flag.
    const manual = await invoiceFor(plainPayer.id);
    expect(manual!.customerId).toBe(plainPayer.id);

    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [payer.id], issue: true }, user.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ customerId: payer.id, status: "issued" });
    const invoice = (await invoiceService.getInvoice(results[0]!.invoiceId!))!;
    expect(invoice.customerId).toBe(payer.id);
    expect(invoice.rows).toHaveLength(3);
    expect(new Set(invoice.rows.map((r) => r.salesOrderNumber))).toEqual(new Set([o1.order.orderNumber, o2.order.orderNumber, o3.order.orderNumber]));
    expect(new Set(invoice.rows.map((r) => r.orderCustomerName))).toEqual(new Set(["Dotter Ett AB", "Dotter Två AB", "Koncernen AB"]));
    // Each row of another orderer names it on the PDF; the payer's own does not.
    const text = pdfText((await invoiceService.renderPdf(invoice.id)).content);
    expect(text).toContain(`Beställare: ${first.customerNumber} Dotter Ett AB`);
    expect(text).toContain(`Beställare: ${second.customerNumber} Dotter Två AB`);
    expect(text).not.toContain("Beställare: " + payer.customerNumber);
    expect(await invoiceService.listCollectiveInvoicingCandidates()).toEqual([]);
  });

  it("Faktura i vänteläge is the paying customer's: the run leaves its invoice as a draft", async () => {
    const payer = await customer("Koncernen AB", { collectiveInvoicing: true, invoiceOnHold: true });
    const orderer = await customer("Dotter AB", { invoiceCustomerId: payer.id });
    const art = await article();
    await deliveredOrder(orderer.id, [{ articleId: art.id, quantity: 2, unitPrice: 100 }]);
    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [payer.id], issue: true }, user.id);
    expect(results[0]).toMatchObject({ customerId: payer.id, status: "draft", onHold: true });
  });
});

describe("The freight follows the fakturakund", () => {
  it("a booked shipment is billable to the paying customer of its order", async () => {
    const payer = await customer("Betalaren AB");
    const orderer = await customer("Beställaren AB");
    const art = await article();
    freightArticleId = (
      await articleService.createArticle(parsed(createArticleSchema, { articleNumber: `FRAKT-${crypto.randomUUID().slice(0, 6)}`, name: "Frakt", type: "service", active: true }))
    ).id;
    const delivery = await makeDelivery(orderer.id, [{ articleId: art.id, quantity: 2 }], { status: "delivered", invoiceCustomerId: payer.id });
    const [shipment] = await db
      .insert(shipments)
      .values({
        shipmentNumber: `FR-FK-${Date.now() % 1_000_000}`,
        status: "booked",
        providerShipmentId: "snd-fk",
        customerId: orderer.id,
        recipientName: "Beställaren AB",
        pickupDate: "2026-11-18",
        pickupFrom: "08:00",
        pickupTo: "16:00",
        customerPrice: "450.00",
        carrierPrice: "400.00",
        bookedAt: new Date(),
      })
      .returning();
    await db.insert(shipmentDeliveries).values({ shipmentId: shipment!.id, deliveryId: delivery.deliveryId });

    expect(await invoiceService.listInvoiceableShipments(orderer.id)).toEqual([]);
    const billable = await invoiceService.listInvoiceableShipments(payer.id);
    expect(billable.map((s) => s.shipmentId)).toEqual([shipment!.id]);

    const row = { articleId: freightArticleId!, shipmentId: shipment!.id, description: "Frakt", quantity: 1, unitPrice: 450 };
    await expect(invoiceService.create({ customerId: orderer.id, rows: [row] }, user.id)).rejects.toThrow(/tillhör en annan kund/);
    const draft = await invoiceService.create({ customerId: payer.id, rows: [row] }, user.id);
    expect(draft!.rows[0]!.shipmentId).toBe(shipment!.id);
  });
});
