import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, customerDeliveryAddresses, db, manufacturingOrders, numberSeries, salesOrders, units } from "@navet/db";
import { createQuoteSchema, updateSalesOrderHeaderSchema } from "@navet/shared";
import { PriceNotFoundError, RowHasManufacturingOrdersError } from "../src/modules/sales/service/sales.errors.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import {
  createSalesService,
  ContactNotFoundError,
  CustomerNotFoundError,
  DeliveryAddressNotFoundError,
  DuplicateCustomerNumberError,
  InvalidStatusTransitionError,
  OverDeliveryError,
  RowHasDeliveriesError,
} from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService, RegisterEntryNotFoundError } from "../src/modules/register/service/register.service.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import {
  createMailService,
  MailSendError,
  type MailTransportFactory,
} from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";
import { stampOrderInvoiced } from "./helpers/services.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const auditRepository = createAuditRepository(db);

// Fake SMTP transport — records outgoing mails, fails on demand.
const sentMails: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
let failNextSend = false;
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    if (failNextSend) {
      failNextSend = false;
      throw new Error("SMTP connection refused");
    }
    sentMails.push(opts);
  },
});

const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository
);

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE email_log, audit_log, sales_order_rows, sales_orders, customer_contacts, customers, price_lists, delivery_terms, payment_terms, carriers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`
  );
  sentMails.length = 0;
  failNextSend = false;
  await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
});

afterAll(async () => {
  await db.execute(
    sql`TRUNCATE email_log, audit_log, sales_order_rows, sales_orders, customer_contacts, customers, price_lists, delivery_terms, payment_terms, carriers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`
  );
});

// Bypasses authService.register (bootstrap-only, one admin) since these
// tests only need a valid user id for createdBy — not auth policy itself.
async function makeUser() {
  return authRepo.create({
    email: `sales-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Seller",
    role: "admin",
  });
}

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

// salesPrice is optional and off by default: most tests send an explicit
// unitPrice and want an article with no price chain at all. Pass it when the
// test needs a quantity-only PATCH to survive — C3 re-resolves the chain then
// (see the comment in "logs row_added/row_updated/row_deleted" below).
async function makeArticle(salesPrice?: number) {
  return articleService.createArticle({
    articleNumber: `ART-SO-${crypto.randomUUID()}`,
    name: "Test Article",
    type: "manufactured",
    unit: "st",
    salesPrice,
    active: true,
  });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

async function seedStock(articleId: string, locationId: string, quantity: number) {
  await stockService.recordTransaction({
    articleId,
    locationId,
    quantityDelta: quantity,
    transactionType: "inventory_adjustment",
  });
}

// E3: a minimal manufacturing_orders row linked to a sales order row, via a
// direct insert rather than the manufacturing module's own service — this
// suite is only exercising the FK's effect on the sales side (deleteRow),
// not TO creation itself, so it stays independent of that module's wiring.
async function linkManufacturingOrder(
  articleId: string,
  salesOrderRowId: string,
  status: "planned" | "cancelled" = "planned"
) {
  const [mo] = await db
    .insert(manufacturingOrders)
    .values({
      // varchar(20) — a full UUID doesn't fit, an 8-char slice does.
      orderNumber: `MO-${crypto.randomUUID().slice(0, 8)}`,
      articleId,
      quantity: "1.0000",
      status,
      salesOrderRowId,
    })
    .returning();
  return mo!;
}

async function makeQuoteWithRow(quantity = 10) {
  const user = await makeUser();
  const customer = await makeCustomer();
  const article = await makeArticle();
  const location = await makeLocation();
  await seedStock(article.id, location.id, quantity);

  const { order, rows } = await salesService.createQuote(
    { customerId: customer.id, rows: [{ articleId: article.id, quantity, unitPrice: 99 }] },
    user.id
  );
  return { user, customer, article, location, order, row: rows[0]! };
}

describe("sales service — quote lifecycle", () => {
  it("creates a customer and a quote with rows atomically", async () => {
    const { order, row } = await makeQuoteWithRow(10);

    expect(order.status).toBe("quote");
    expect(order.orderNumber.startsWith("KO-")).toBe(true);
    expect(row.quantityOrdered).toBe("10.0000");
    expect(row.quantityDelivered).toBe("0.0000");
  });

  it("allows adding rows through in_production but blocks once delivered", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    // One article per row — the row table has a unique (order, article) index.
    const articleB = await makeArticle();
    const articleC = await makeArticle();
    await salesService.confirm(order.id);

    // Editable statuses: confirmed and in_production both accept new rows.
    const extra = await salesService.addRow(order.id, { articleId: articleB.id, quantity: 2, unitPrice: 1 });
    await salesService.startProduction(order.id);
    await salesService.deleteRow(order.id, extra.id);

    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 10 }, user.id);
    await expect(
      salesService.addRow(order.id, { articleId: articleC.id, quantity: 1, unitPrice: 1 })
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("allows cancel from quote and from confirmed", async () => {
    const { order: quoteOrder } = await makeQuoteWithRow(5);
    const cancelledQuote = await salesService.cancel(quoteOrder.id);
    expect(cancelledQuote?.status).toBe("cancelled");

    const { order: confirmedOrder } = await makeQuoteWithRow(5);
    await salesService.confirm(confirmedOrder.id);
    const cancelledConfirmed = await salesService.cancel(confirmedOrder.id);
    expect(cancelledConfirmed?.status).toBe("cancelled");
  });

  it("blocks cancel once production has started", async () => {
    const { order } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);

    await expect(salesService.cancel(order.id)).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("sales service — delivery", () => {
  it("rejects delivery before production has started", async () => {
    const { order, row, location } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);

    await expect(
      salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 1 }, order.createdBy!)
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("stays in_production until all rows are fully delivered, then moves to delivered", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);

    const partial = await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);
    expect(partial.orderStatus).toBe("in_production");
    expect(partial.row.quantityDelivered).toBe("4.0000");

    const rest = await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, user.id);
    expect(rest.orderStatus).toBe("delivered");
    expect(rest.row.quantityDelivered).toBe("10.0000");
  });

  it("rejects delivering more than what remains on the row", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 8 }, user.id);

    await expect(
      salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 3 }, user.id)
    ).rejects.toThrow(OverDeliveryError);
  });

  it("records a negative stock_transactions row and decreases stock_balances", async () => {
    const { order, row, article, location, user } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 7 }, user.id);

    const balances = await stockService.getBalances({ articleId: article.id, limit: 50, offset: 0 });
    expect(balances.rows).toHaveLength(1);
    expect(balances.rows[0]?.quantityOnHand).toBe("3.0000");
  });
});

// The "invoices an order only once fully delivered" case was removed here —
// salesService.invoice/repo.invoiceOrder no longer exist post-C1; the
// equivalent order-status-recompute behavior (an order only flips to
// "invoiced" once every row is fully invoiced) is covered by
// customer-invoice.service.test.ts against the new invoice module instead.

describe("sales service — order list filters", () => {
  it("search also matches an order's article number/benämning, not just order number/kund", async () => {
    const { order: matching, article } = await makeQuoteWithRow(10);
    // A different article, with a distinct name, on the "unrelated" order —
    // makeArticle() always names its article "Test Article", which would
    // otherwise make the byName search match both orders.
    const user = await makeUser();
    const customer = await makeCustomer();
    const otherArticle = await articleService.createArticle({
      articleNumber: `ART-SO-OTHER-${crypto.randomUUID()}`,
      name: `Orelaterad artikel ${crypto.randomUUID()}`,
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const unrelated = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: otherArticle.id, quantity: 1, unitPrice: 1 }] },
      user.id
    );

    const byNumber = await salesService.listSalesOrders({
      search: article.articleNumber,
      limit: 50,
      offset: 0,
    });
    expect(byNumber.rows.map((r) => r.id)).toEqual([matching.id]);

    const byName = await salesService.listSalesOrders({ search: article.name, limit: 50, offset: 0 });
    expect(byName.rows.map((r) => r.id)).toEqual([matching.id]);

    expect(byNumber.rows.map((r) => r.id)).not.toContain(unrelated.order.id);
  });

  it("withOpenRows adds an accurate openRowCount, and costs nothing when omitted", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    // Partially delivered — the row still has 6 open.
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    const withoutFlag = await salesService.listSalesOrders({
      search: order.orderNumber,
      limit: 50,
      offset: 0,
    });
    expect(withoutFlag.rows[0]).not.toHaveProperty("openRowCount");

    const withFlag = await salesService.listSalesOrders({
      search: order.orderNumber,
      withOpenRows: true,
      limit: 50,
      offset: 0,
    });
    expect(withFlag.rows[0]?.openRowCount).toBe(1);

    // Fully deliver the row — it no longer counts as open.
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 6 }, user.id);
    const afterFullyDelivered = await salesService.listSalesOrders({
      search: order.orderNumber,
      withOpenRows: true,
      limit: 50,
      offset: 0,
    });
    expect(afterFullyDelivered.rows[0]?.openRowCount).toBe(0);
  });

  // The stored Sendify answer (freight_quote jsonb) is detail-only: the
  // register list would otherwise ship it on every row.
  it("leaves the freight quote out of the list rows but keeps it on the detail", async () => {
    const { order } = await makeQuoteWithRow(10);
    const quote = { fetchedAt: "2026-10-08T08:00:00.000Z", warnings: [], rates: [] };
    await db.update(salesOrders).set({ freightQuote: quote }).where(eq(salesOrders.id, order.id));

    const list = await salesService.listSalesOrders({ search: order.orderNumber, limit: 50, offset: 0 });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).not.toHaveProperty("freightQuote");
    expect(list.rows[0]?.orderNumber).toBe(order.orderNumber);

    expect((await salesService.getSalesOrder(order.id))?.freightQuote).toEqual(quote);
  });
});

describe("sales — editable customers", () => {
  it("updates customer fields and 404s on unknown ids", async () => {
    const customer = await makeCustomer();
    const updated = await salesService.updateCustomer(customer.id, {
      name: "Storköket i Exempelby AB",
      contactName: "Eva Ek",
    });
    expect(updated.name).toBe("Storköket i Exempelby AB");
    expect(updated.contactName).toBe("Eva Ek");

    await expect(salesService.updateCustomer(crypto.randomUUID(), { name: "X" })).rejects.toBeInstanceOf(
      CustomerNotFoundError
    );
  });

  it("rejects changing a customer's number to one already taken, own unchanged number is fine", async () => {
    const a = await salesService.createCustomer({ name: "Kund F", customerNumber: "NUM-A", active: true });
    await salesService.createCustomer({ name: "Kund G", customerNumber: "NUM-B", active: true });

    await expect(salesService.updateCustomer(a.id, { customerNumber: "NUM-B" })).rejects.toThrow(
      DuplicateCustomerNumberError
    );

    // PATCH:ing the customer's own unchanged number is a no-op, not a duplicate.
    const same = await salesService.updateCustomer(a.id, { customerNumber: "NUM-A", name: "Kund F2" });
    expect(same.customerNumber).toBe("NUM-A");
    expect(same.name).toBe("Kund F2");
  });

  it("finds customers by customer number in the list search", async () => {
    await salesService.createCustomer({ name: "Sökkund AB", customerNumber: "SOKNUM-42", active: true });
    await salesService.createCustomer({ name: "Annan AB", active: true });

    const hit = await salesService.listCustomers({ search: "soknum", limit: 50, offset: 0 });
    expect(hit.total).toBe(1);
    expect(hit.rows[0]!.customerNumber).toBe("SOKNUM-42");
  });

  it("defaults collectiveInvoicing and privatePerson to false on create", async () => {
    const customer = await salesService.createCustomer({ name: "Ny kund AB", active: true });
    expect(customer.collectiveInvoicing).toBe(false);
    expect(customer.privatePerson).toBe(false);
  });

  it("sets ourSupplierNumber, collectiveInvoicing, privatePerson and website", async () => {
    const customer = await makeCustomer();
    const updated = await salesService.updateCustomer(customer.id, {
      ourSupplierNumber: "LEV-1",
      collectiveInvoicing: true,
      privatePerson: true,
      website: "www.example.se",
    });
    expect(updated.ourSupplierNumber).toBe("LEV-1");
    expect(updated.collectiveInvoicing).toBe(true);
    expect(updated.privatePerson).toBe(true);
    expect(updated.website).toBe("www.example.se");
  });

  it("clears ourSupplierNumber/website with null while the booleans can be set back to false", async () => {
    const customer = await makeCustomer();
    await salesService.updateCustomer(customer.id, {
      ourSupplierNumber: "LEV-2",
      collectiveInvoicing: true,
      privatePerson: true,
      website: "www.example.se",
    });

    const cleared = await salesService.updateCustomer(customer.id, {
      ourSupplierNumber: null,
      website: null,
      collectiveInvoicing: false,
      privatePerson: false,
    });
    expect(cleared.ourSupplierNumber).toBeNull();
    expect(cleared.website).toBeNull();
    expect(cleared.collectiveInvoicing).toBe(false);
    expect(cleared.privatePerson).toBe(false);
  });
});

describe("sales service — customer card fields", () => {
  it("stores address, terms and carrier references and clears them with null", async () => {
    const term = await registerService.deliveryTerms.create({ code: "DAP", name: "Delivered at Place" });
    const carrier = await registerService.carriers.create({ code: "DHL", name: "DHL Freight" });

    const customer = await salesService.createCustomer({
      name: "Kortkund AB",
      address: "Storgatan 1",
      postalCode: "981 32",
      city: "Kiruna",
      orgNumber: "556000-0001",
      vatNumber: "SE556000000101",
      deliveryTermId: term.id,
      carrierId: carrier.id,
      carrierCustomerNumber: "K-778899",
      active: true,
    });
    expect(customer.postalCode).toBe("981 32");
    expect(customer.deliveryTermId).toBe(term.id);

    const found = await salesService.getCustomer(customer.id);
    expect(found?.deliveryTermName).toBe("Delivered at Place");
    expect(found?.carrierCode).toBe("DHL");
    expect(found?.paymentTermName).toBeNull();

    const cleared = await salesService.updateCustomer(customer.id, { deliveryTermId: null });
    expect(cleared.deliveryTermId).toBeNull();
  });

  it("rejects an unknown delivery term reference", async () => {
    const customer = await salesService.createCustomer({ name: "Kund utan villkor", active: true });
    await expect(
      salesService.updateCustomer(customer.id, { deliveryTermId: "00000000-0000-0000-0000-000000000000" })
    ).rejects.toThrow(RegisterEntryNotFoundError);
  });
});

// Migration 0085: country/discountPercent/invoiceName/invoiceCountry on the
// customer, and country on delivery addresses. The zod defaulting/coercion
// (country "dk" -> "DK", bad codes -> 400) lives in packages/shared/src/
// sales.ts and is exercised at the route layer — createCustomer/
// updateCustomer here take the already-parsed CreateCustomerInput/
// UpdateCustomerInput, so these tests are about what the service+repository
// persist and return, not the zod parsing itself.
describe("sales service — customer country, discount and invoice name (migration 0085)", () => {
  it("defaults country to SE when omitted on create", async () => {
    const customer = await salesService.createCustomer({ name: "Utan land AB", active: true });
    expect(customer.country).toBe("SE");
  });

  it("stores an explicit country on create and updates it via PATCH", async () => {
    const customer = await salesService.createCustomer({ name: "Dansk Kund AB", active: true, country: "DK" });
    expect(customer.country).toBe("DK");

    const updated = await salesService.updateCustomer(customer.id, { country: "NO" });
    expect(updated.country).toBe("NO");
  });

  it("defaults discountPercent to 0 and stores/updates a non-zero value", async () => {
    const customer = await salesService.createCustomer({ name: "Nolla AB", active: true });
    expect(Number(customer.discountPercent)).toBe(0);

    const created = await salesService.createCustomer({ name: "Rabatt AB", active: true, discountPercent: 15 });
    // numeric(5,2) — same string-return shape as customer_prices.discountPercent
    // elsewhere in this file ("10.00").
    expect(created.discountPercent).toBe("15.00");

    const updated = await salesService.updateCustomer(created.id, { discountPercent: 20 });
    expect(updated.discountPercent).toBe("20.00");

    const clearedToZero = await salesService.updateCustomer(created.id, { discountPercent: 0 });
    expect(clearedToZero.discountPercent).toBe("0.00");
  });

  it("stores invoiceName and invoiceCountry, and nulls them via PATCH", async () => {
    const customer = await salesService.createCustomer({
      name: "Moderbolag AB",
      active: true,
      invoiceName: "c/o Holdingbolaget AB",
      invoiceAddress: "Box 1",
      invoiceCountry: "DK",
    });
    expect(customer.invoiceName).toBe("c/o Holdingbolaget AB");
    expect(customer.invoiceCountry).toBe("DK");

    const cleared = await salesService.updateCustomer(customer.id, { invoiceName: null, invoiceCountry: null });
    expect(cleared.invoiceName).toBeNull();
    expect(cleared.invoiceCountry).toBeNull();
  });

  it("leaves invoiceCountry null when not set on create — it is not defaulted like country", async () => {
    const customer = await salesService.createCustomer({ name: "Utan fakturaland AB", active: true });
    expect(customer.invoiceCountry).toBeNull();
  });
});

describe("sales service — customer contacts", () => {
  it("creates, lists (primary first), updates and deletes contacts", async () => {
    const customer = await salesService.createCustomer({ name: "Kontaktkund AB", active: true });

    await salesService.createCustomerContact(customer.id, { name: "Berit Byggare", isPrimary: false });
    const anna = await salesService.createCustomerContact(customer.id, {
      name: "Anna Ansvarig",
      phone: "0980-123 45",
      mobile: "070-111 22 33",
      email: "anna@example.com",
      comment: "Nås bäst förmiddagar",
      isPrimary: true,
    });

    const list = await salesService.listCustomerContacts(customer.id);
    expect(list.map((c) => c.name)).toEqual(["Anna Ansvarig", "Berit Byggare"]);
    expect(list[0]?.isPrimary).toBe(true);
    expect(list[0]?.mobile).toBe("070-111 22 33");

    const updated = await salesService.updateCustomerContact(customer.id, anna.id, { phone: null, comment: "Semester v.30" });
    expect(updated.phone).toBeNull();
    expect(updated.comment).toBe("Semester v.30");

    await salesService.deleteCustomerContact(customer.id, anna.id);
    expect(await salesService.listCustomerContacts(customer.id)).toHaveLength(1);
  });

  it("moves the primary flag when another contact becomes primary", async () => {
    const customer = await salesService.createCustomer({ name: "Primärkund AB", active: true });
    const first = await salesService.createCustomerContact(customer.id, { name: "Första", isPrimary: true });
    const second = await salesService.createCustomerContact(customer.id, { name: "Andra", isPrimary: false });

    await salesService.updateCustomerContact(customer.id, second.id, { isPrimary: true });

    const list = await salesService.listCustomerContacts(customer.id);
    expect(list.filter((c) => c.isPrimary).map((c) => c.id)).toEqual([second.id]);
    expect(list.find((c) => c.id === first.id)?.isPrimary).toBe(false);
  });

  it("404s for unknown customers and contacts under the wrong customer", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await expect(salesService.listCustomerContacts(fakeId)).rejects.toThrow(CustomerNotFoundError);

    const a = await salesService.createCustomer({ name: "Kund A", active: true });
    const b = await salesService.createCustomer({ name: "Kund B", active: true });
    const contact = await salesService.createCustomerContact(a.id, { name: "Hos A", isPrimary: false });
    await expect(salesService.updateCustomerContact(b.id, contact.id, { name: "X" })).rejects.toThrow(
      ContactNotFoundError
    );
    await expect(salesService.deleteCustomerContact(b.id, contact.id)).rejects.toThrow(ContactNotFoundError);
  });
});

describe("sales service — skapa kundorder direkt (confirm)", () => {
  it("creates a confirmed order when confirm is true", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();

    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, confirm: true, rows: [{ articleId: article.id, quantity: 2, unitPrice: 50 }] },
      user.id
    );
    expect(order.status).toBe("confirmed");
    expect(rows).toHaveLength(1);

    const fetched = await salesService.getSalesOrder(order.id);
    expect(fetched?.status).toBe("confirmed");
  });

  it("defaults confirm to false in the schema (quote as before)", () => {
    const parsed = createQuoteSchema.parse({
      customerId: crypto.randomUUID(),
      rows: [{ articleId: crypto.randomUUID(), quantity: 1, unitPrice: 0 }],
    });
    expect(parsed.confirm).toBe(false);
  });
});

describe("sales service — document email", () => {
  const sendBase = { to: "kund@example.com", subject: "Dokument", message: "Se bilaga" };

  it("emails the order confirmation on a quote and confirms it", async () => {
    const { order } = await makeQuoteWithRow(2);

    const updated = await salesService.sendSalesOrderEmail(order.id, { ...sendBase, variant: "confirmation" });
    expect(updated?.status).toBe("confirmed");

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.attachments?.[0]?.filename).toBe(`Orderbekraftelse-${order.orderNumber}.pdf`);
    expect(sentMails[0]?.attachments?.[0]?.content.subarray(0, 4).toString()).toBe("%PDF");

    const log = await mailService.listEmailLog({ documentId: order.id, limit: 50, offset: 0 });
    expect(log.rows[0]?.documentType).toBe("order_confirmation");
    expect(log.rows[0]?.status).toBe("sent");
  });

  it("emails the quote without changing status", async () => {
    const { order } = await makeQuoteWithRow(2);

    const updated = await salesService.sendSalesOrderEmail(order.id, { ...sendBase, variant: "quote" });
    expect(updated?.status).toBe("quote");
    expect(sentMails[0]?.attachments?.[0]?.filename).toBe(`Offert-${order.orderNumber}.pdf`);

    const log = await mailService.listEmailLog({ documentId: order.id, limit: 50, offset: 0 });
    expect(log.rows[0]?.documentType).toBe("quote");
  });

  it("resends the confirmation on a confirmed order without a new transition", async () => {
    const { order } = await makeQuoteWithRow(2);
    await salesService.confirm(order.id);

    const updated = await salesService.sendSalesOrderEmail(order.id, { ...sendBase, variant: "confirmation" });
    expect(updated?.status).toBe("confirmed");
    expect(sentMails).toHaveLength(1);
  });

  it("refuses to email a cancelled order", async () => {
    const { order } = await makeQuoteWithRow(2);
    await salesService.cancel(order.id);

    await expect(
      salesService.sendSalesOrderEmail(order.id, { ...sendBase, variant: "confirmation" })
    ).rejects.toThrow(InvalidStatusTransitionError);
    expect(sentMails).toHaveLength(0);
  });

  it("keeps the quote status when SMTP fails", async () => {
    const { order } = await makeQuoteWithRow(2);
    failNextSend = true;

    await expect(
      salesService.sendSalesOrderEmail(order.id, { ...sendBase, variant: "confirmation" })
    ).rejects.toThrow(MailSendError);

    const after = await salesService.getSalesOrder(order.id);
    expect(after?.status).toBe("quote");

    const log = await mailService.listEmailLog({ documentId: order.id, limit: 50, offset: 0 });
    expect(log.rows[0]?.status).toBe("failed");
  });
});

// articles.rounding (Avrundning): the service rounds the BASE quantity up to
// the article's step on create and on every quantity PATCH — the same
// roundUpToMultiple behovsberäkningen applies to proposals.
describe("sales service — Avrundning on rows", () => {
  // salesPrice so a quantity-only PATCH (which re-resolves the price chain,
  // C3) has a price to land on.
  async function makeRoundedArticle(rounding: number, salesPrice = 10) {
    return articleService.createArticle({
      articleNumber: `ART-RND-${crypto.randomUUID()}`,
      name: "Rundad artikel",
      type: "purchased",
      unit: "st",
      rounding,
      salesPrice,
      active: true,
    });
  }

  it("rounds the row quantity up on quote creation and on a quantity PATCH", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeRoundedArticle(5);

    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 12, unitPrice: 10 }] },
      user.id
    );
    expect(rows[0]!.quantityOrdered).toBe("15.0000");

    const patched = await salesService.updateRow(order.id, rows[0]!.id, { quantity: 16, unitPrice: 10 });
    expect(patched.row.quantityOrdered).toBe("20.0000");

    // An exact multiple is left alone, and a unit-price-only PATCH never
    // touches the quantity.
    const exact = await salesService.updateRow(order.id, rows[0]!.id, { quantity: 25 });
    expect(exact.row.quantityOrdered).toBe("25.0000");
    const priceOnly = await salesService.updateRow(order.id, rows[0]!.id, { unitPrice: 11 });
    expect(priceOnly.row.quantityOrdered).toBe("25.0000");
  });

  it("rounds in the BASE unit when the row is entered in an alternative unit", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeRoundedArticle(5);
    const [metre] = await db.insert(units).values({ code: "m", name: "meter" }).onConflictDoNothing().returning();
    const metreId = metre?.id ?? (await db.select().from(units).where(eq(units.code, "m")))[0]!.id;
    // 1 st = 0.89 m ⇒ quantity_per_base 0.89; 1 m entered ⇒ 1.1236 st base.
    await articleService.addArticleUnit(article.id, { unitId: metreId, quantityPerBase: 0.89 });

    const { rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitId: metreId, unitPrice: 10 }] },
      user.id
    );
    // Rounded up to 5 st in the base unit — the row's display quantity in
    // metres (5 × 0.89 = 4.45 m) is therefore no longer what was typed.
    expect(rows[0]!.quantityOrdered).toBe("5.0000");
    expect(rows[0]!.unitId).toBe(metreId);
  });

  it("rounds before the price chain so a staffel sees the ordered quantity", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    // Article price 100, customer price 80 from 10 units: 7 typed → 10 → the
    // break applies.
    const article = await makeRoundedArticle(10, 100);
    await salesService.addCustomerPrice(customer.id, { articleId: article.id, fromQuantity: 10, unitPrice: 80 });

    const { rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 7 }] },
      user.id
    );
    expect(rows[0]!.quantityOrdered).toBe("10.0000");
    expect(rows[0]!.unitPrice).toBe("80.0000");
  });
});

describe("sales service — row editing", () => {
  it("updates quantity and price on a confirmed order", async () => {
    const { order, row } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);

    const result = await salesService.updateRow(order.id, row.id, { quantity: 7, unitPrice: 120.5 });
    expect(result.row.quantityOrdered).toBe("7.0000");
    expect(result.row.unitPrice).toBe("120.5000");
    expect(result.orderStatus).toBe("confirmed");
  });

  it("refuses a quantity below what's already delivered", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    // unitPrice sent (matching the row's existing price) — this test is
    // about the over-delivery guard, not C3's price re-resolution; the
    // article carries no price-chain data so an omitted unitPrice would
    // 400 with PriceNotFoundError before the guard even runs.
    await expect(salesService.updateRow(order.id, row.id, { quantity: 3, unitPrice: 99 })).rejects.toThrow(
      OverDeliveryError
    );
  });

  it("completes an in-production order when the quantity is lowered to what's delivered", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    // unitPrice sent for the same reason as above — this test is about the
    // status recompute, not price resolution.
    const result = await salesService.updateRow(order.id, row.id, { quantity: 4, unitPrice: 99 });
    expect(result.orderStatus).toBe("delivered");
    expect((await salesService.getSalesOrder(order.id))?.status).toBe("delivered");
  });

  it("deletes an untouched row but refuses one with deliveries", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    const articleB = await makeArticle();
    await salesService.confirm(order.id);
    const extraRow = await salesService.addRow(order.id, { articleId: articleB.id, quantity: 5, unitPrice: 2 });
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    await expect(salesService.deleteRow(order.id, row.id)).rejects.toThrow(RowHasDeliveriesError);
    await salesService.deleteRow(order.id, extraRow.id);
    expect(await salesService.listRows(order.id)).toHaveLength(1);
  });

  it("refuses to delete a row with a linked manufacturing order", async () => {
    const { order, row, article } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await linkManufacturingOrder(article.id, row.id);

    await expect(salesService.deleteRow(order.id, row.id)).rejects.toThrow(RowHasManufacturingOrdersError);
    expect(await salesService.listRows(order.id)).toHaveLength(1);
  });

  // E3: manufacturing_orders.sales_order_row_id is a plain restrict FK — it
  // has no idea what "cancelled" means, so even a row whose only link is to
  // a cancelled TO stays blocked. Documented as a deliberate choice: the
  // link is kept as history (matches how coverage/linking reads it
  // elsewhere), not cleared on cancel, so unlinking would need its own
  // explicit step rather than falling out of this guard.
  it("still refuses deletion when the only linked manufacturing order is cancelled", async () => {
    const { order, row, article } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await linkManufacturingOrder(article.id, row.id, "cancelled");

    await expect(salesService.deleteRow(order.id, row.id)).rejects.toThrow(RowHasManufacturingOrdersError);
    expect(await salesService.listRows(order.id)).toHaveLength(1);
  });

  it("locks rows on cancelled orders", async () => {
    const { order, row } = await makeQuoteWithRow(10);
    await salesService.cancel(order.id);

    await expect(salesService.updateRow(order.id, row.id, { quantity: 2 })).rejects.toThrow(
      InvalidStatusTransitionError
    );
    await expect(salesService.deleteRow(order.id, row.id)).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("sales service — C3 kundpriser: row pricing", () => {
  // Article with no sales price and no rules — the empty chain, for the
  // "no price found" test.
  async function makeArticleNoPrice() {
    return articleService.createArticle({
      articleNumber: `ART-SO-${crypto.randomUUID()}`,
      name: "Test Article",
      type: "manufactured",
      unit: "st",
      active: true,
    });
  }

  it("resolves price and discount when unitPrice is omitted", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();

    const list = await salesService.createPriceList({ code: `PL-${crypto.randomUUID().slice(0, 8)}`, name: "Lista" });
    await salesService.addPriceListRow(list.id, { articleId: article.id, fromQuantity: 1, unitPrice: 90 });
    await salesService.updateCustomer(customer.id, { priceListId: list.id });
    // A discount-form customer rule (no unitPrice) — it wins the chain but
    // needs the list price above as its base.
    await salesService.addCustomerPrice(customer.id, { articleId: article.id, fromQuantity: 1, discountPercent: 10 });

    const { rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] },
      user.id
    );
    expect(rows[0]!.unitPrice).toBe("90.0000");
    expect(rows[0]!.discountPercent).toBe("10.00");
  });

  // Kundrabatt (customers.discount_percent) — the price chain's last
  // fallback below every customer-specific rule (price-resolver.test.ts
  // covers resolvePrice directly; this locks in that the discount also
  // reaches the order row through the normal omitted-unitPrice path).
  it("resolves the customer's blanket discount onto the row when no rule matches", async () => {
    const user = await makeUser();
    const customer = await salesService.createCustomer({ name: "Rabattkund AB", active: true, discountPercent: 15 });
    const article = await makeArticle(100);

    const { rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] },
      user.id
    );
    expect(rows[0]!.unitPrice).toBe("100.0000");
    expect(rows[0]!.discountPercent).toBe("15.00");
  });

  it("uses a sent unitPrice verbatim — including 0", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();

    const { rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 0 }] },
      user.id
    );
    expect(rows[0]!.unitPrice).toBe("0.0000");
    expect(rows[0]!.discountPercent).toBe("0.00");
  });

  it("throws PriceNotFoundError when omitted and the chain is empty", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticleNoPrice();

    await expect(
      salesService.createQuote({ customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] }, user.id)
    ).rejects.toThrow(PriceNotFoundError);
  });

  it("keeps the row's price and discount when a quantity change finds no price in the chain", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticleNoPrice();
    // Priced by hand, since the chain is empty.
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 75, discountPercent: 5 }] },
      user.id
    );
    // A quantity-only PATCH re-resolves the chain; with no rule at all there is
    // no staffel to have crossed, so the row's own price stands.
    const { row } = await salesService.updateRow(order.id, rows[0]!.id, { quantity: 4 });
    expect(Number(row.quantityOrdered)).toBe(4);
    expect(Number(row.unitPrice)).toBe(75);
    expect(Number(row.discountPercent)).toBe(5);
  });

  it("re-resolves on quantity change when unitPrice is omitted", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();

    const list = await salesService.createPriceList({ code: `PL-${crypto.randomUUID().slice(0, 8)}`, name: "Lista" });
    await salesService.addPriceListRow(list.id, { articleId: article.id, fromQuantity: 1, unitPrice: 90 });
    await salesService.addPriceListRow(list.id, { articleId: article.id, fromQuantity: 10, unitPrice: 80 });
    await salesService.updateCustomer(customer.id, { priceListId: list.id });

    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1 }] },
      user.id
    );
    expect(rows[0]!.unitPrice).toBe("90.0000");

    const result = await salesService.updateRow(order.id, rows[0]!.id, { quantity: 10 });
    expect(result.row.unitPrice).toBe("80.0000");
  });

  it("keeps price on unit-only PATCH", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();

    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 55, discountPercent: 5 }] },
      user.id
    );

    const result = await salesService.updateRow(order.id, rows[0]!.id, { unitId: null });
    expect(result.row.unitPrice).toBe("55.0000");
    expect(result.row.discountPercent).toBe("5.00");
  });

  it("stores an explicit discountPercent on the row", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();

    const { rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 200, discountPercent: 15 }] },
      user.id
    );
    expect(rows[0]!.unitPrice).toBe("200.0000");
    expect(rows[0]!.discountPercent).toBe("15.00");
  });
});

describe("sales service — pick list", () => {
  it("renders a pick list PDF for the remaining quantities", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    const { filename, content } = await salesService.getPickListPdf(order.id);
    expect(filename).toBe(`Plocklista-${order.orderNumber}.pdf`);
    expect(content.subarray(0, 4).toString()).toBe("%PDF");
    expect(content.length).toBeGreaterThan(1000);
  });

  it("refuses a pick list for a cancelled order", async () => {
    const { order } = await makeQuoteWithRow(5);
    await salesService.cancel(order.id);

    await expect(salesService.getPickListPdf(order.id)).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("sales service — delivery addresses", () => {
  it("creates, lists, updates and deletes delivery addresses on a customer", async () => {
    const customer = await makeCustomer();

    const created = await salesService.createDeliveryAddress(customer.id, {
      label: "Huvudlager",
      address: "Lagervägen 1",
      postalCode: "123 45",
      city: "Göteborg",
      isDefault: true,
    });
    expect(created.isDefault).toBe(true);

    await salesService.createDeliveryAddress(customer.id, {
      label: "Filial Nord",
      address: "Norrvägen 2",
      isDefault: false,
    });

    const list = await salesService.listDeliveryAddresses(customer.id);
    expect(list).toHaveLength(2);
    // Default first, then by label.
    expect(list[0]!.label).toBe("Huvudlager");

    const updated = await salesService.updateDeliveryAddress(customer.id, created.id, { city: "Mölndal" });
    expect(updated.city).toBe("Mölndal");

    await salesService.deleteDeliveryAddress(customer.id, created.id);
    expect(await salesService.listDeliveryAddresses(customer.id)).toHaveLength(1);
  });

  it("keeps at most one default — setting a new default demotes the old one", async () => {
    const customer = await makeCustomer();
    const first = await salesService.createDeliveryAddress(customer.id, {
      label: "A",
      address: "Gata 1",
      isDefault: true,
    });
    const second = await salesService.createDeliveryAddress(customer.id, {
      label: "B",
      address: "Gata 2",
      isDefault: true,
    });

    const list = await salesService.listDeliveryAddresses(customer.id);
    expect(list.find((a) => a.id === first.id)!.isDefault).toBe(false);
    expect(list.find((a) => a.id === second.id)!.isDefault).toBe(true);

    // Promoting via PATCH demotes as well.
    await salesService.updateDeliveryAddress(customer.id, first.id, { isDefault: true });
    const after = await salesService.listDeliveryAddresses(customer.id);
    expect(after.find((a) => a.id === first.id)!.isDefault).toBe(true);
    expect(after.find((a) => a.id === second.id)!.isDefault).toBe(false);
  });

  it("scopes addresses to their customer (404 across customers)", async () => {
    const customer = await makeCustomer();
    const other = await salesService.createCustomer({ name: "Annan Kund AB", active: true });
    const address = await salesService.createDeliveryAddress(customer.id, { label: "A", address: "Gata 1", isDefault: false });

    await expect(
      salesService.updateDeliveryAddress(other.id, address.id, { city: "Fel" })
    ).rejects.toThrow(DeliveryAddressNotFoundError);
    await expect(salesService.deleteDeliveryAddress(other.id, address.id)).rejects.toThrow(
      DeliveryAddressNotFoundError
    );
    await expect(salesService.listDeliveryAddresses(crypto.randomUUID())).rejects.toThrow(CustomerNotFoundError);
  });

  it("stores invoice fields on the customer", async () => {
    const customer = await salesService.createCustomer({
      name: "Faktura AB",
      active: true,
      invoiceAddress: "Box 100",
      invoicePostalCode: "400 10",
      invoiceCity: "Göteborg",
      invoiceEmail: "faktura@example.com",
    });
    expect(customer.invoiceEmail).toBe("faktura@example.com");

    const updated = await salesService.updateCustomer(customer.id, { invoiceEmail: null, invoiceCity: "Borås" });
    expect(updated.invoiceEmail).toBeNull();
    expect(updated.invoiceCity).toBe("Borås");
  });

  it("defaults a delivery address's country to SE and updates it via PATCH", async () => {
    const customer = await makeCustomer();

    const created = await salesService.createDeliveryAddress(customer.id, {
      label: "Utan land",
      address: "Gata 1",
      isDefault: false,
    });
    expect(created.country).toBe("SE");

    const withCountry = await salesService.createDeliveryAddress(customer.id, {
      label: "Norska filialen",
      address: "Storgata 2",
      country: "NO",
      isDefault: false,
    });
    expect(withCountry.country).toBe("NO");

    const updated = await salesService.updateDeliveryAddress(customer.id, created.id, { country: "DK" });
    expect(updated.country).toBe("DK");
  });
});

describe("sales service — order header fields", () => {
  async function makeOrderWithAddress() {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();
    const address = await salesService.createDeliveryAddress(customer.id, {
      label: "Huvudlager",
      address: "Lagervägen 1",
      postalCode: "123 45",
      city: "Göteborg",
      isDefault: true,
    });
    const { order } = await salesService.createQuote(
      {
        customerId: customer.id,
        customerOrderNumber: "PO-4711",
        customerReference: "Anna",
        deliveryAddressId: address.id,
        rows: [{ articleId: article.id, quantity: 2, unitPrice: 50 }],
      },
      user.id
    );
    return { user, customer, article, address, order };
  }

  it("stores customer order number, reference and delivery address on the quote", async () => {
    const { order, address } = await makeOrderWithAddress();
    const fetched = await salesService.getSalesOrder(order.id);
    expect(fetched!.customerOrderNumber).toBe("PO-4711");
    expect(fetched!.customerReference).toBe("Anna");
    expect(fetched!.deliveryAddressId).toBe(address.id);
    expect(fetched!.deliveryAddressLabel).toBe("Huvudlager");
    expect(fetched!.deliveryAddress).toBe("Lagervägen 1");
  });

  it("rejects a delivery address belonging to another customer", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const other = await salesService.createCustomer({ name: "Annan Kund AB", active: true });
    const foreignAddress = await salesService.createDeliveryAddress(other.id, {
      label: "Fel kund",
      address: "Gata 1",
      isDefault: false,
    });
    const article = await makeArticle();

    await expect(
      salesService.createQuote(
        {
          customerId: customer.id,
          deliveryAddressId: foreignAddress.id,
          rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }],
        },
        user.id
      )
    ).rejects.toThrow(DeliveryAddressNotFoundError);
  });

  it("updates the header while quote/confirmed/in_production but refuses after delivered", async () => {
    const { order, customer } = await makeOrderWithAddress();

    const updated = await salesService.updateSalesOrderHeader(order.id, { customerOrderNumber: "PO-9999" });
    expect(updated.customerOrderNumber).toBe("PO-9999");

    await salesService.confirm(order.id);
    const inConfirmed = await salesService.updateSalesOrderHeader(order.id, { customerReference: "Bertil" });
    expect(inConfirmed.customerReference).toBe("Bertil");

    // Clearing the address works too.
    const cleared = await salesService.updateSalesOrderHeader(order.id, { deliveryAddressId: null });
    expect(cleared.deliveryAddressId).toBeNull();

    // Förväntat leveransdatum (Leveranstidskontrollens Använd datumet): set and cleared.
    const dated = await salesService.updateSalesOrderHeader(order.id, { expectedDeliveryDate: "2030-03-25" });
    expect(dated.expectedDeliveryDate).toBe("2030-03-25");
    const undated = await salesService.updateSalesOrderHeader(order.id, { expectedDeliveryDate: null });
    expect(undated.expectedDeliveryDate).toBeNull();

    // A foreign customer's address is rejected on PATCH as well.
    const other = await salesService.createCustomer({ name: "Annan Kund AB", active: true });
    const foreignAddress = await salesService.createDeliveryAddress(other.id, {
      label: "Fel",
      address: "Gata 9",
      isDefault: false,
    });
    await expect(
      salesService.updateSalesOrderHeader(order.id, { deliveryAddressId: foreignAddress.id })
    ).rejects.toThrow(DeliveryAddressNotFoundError);

    await salesService.cancel(order.id);
    await expect(salesService.updateSalesOrderHeader(order.id, { customerReference: "X" })).rejects.toThrow(
      InvalidStatusTransitionError
    );
    void customer;
  });

  it("creates an order with a Ny leveransadress — an engångsadress hidden from the customer's register", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();
    const { order } = await salesService.createQuote(
      {
        customerId: customer.id,
        newDeliveryAddress: {
          label: "Bygget Solna",
          address: "Arenavägen 7",
          postalCode: "169 79",
          city: "Solna",
          country: "SE",
          saveToCustomer: false,
        },
        rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }],
      },
      user.id
    );
    const fetched = await salesService.getSalesOrder(order.id);
    expect(fetched!.deliveryAddressLabel).toBe("Bygget Solna");
    expect(fetched!.deliveryCity).toBe("Solna");
    expect(fetched!.deliveryAddressOneOff).toBe(true);
    expect(await salesService.listDeliveryAddresses(customer.id)).toHaveLength(0);

    // Not reachable through the customer's address routes …
    await expect(
      salesService.updateDeliveryAddress(customer.id, fetched!.deliveryAddressId!, { city: "Fel" })
    ).rejects.toThrow(DeliveryAddressNotFoundError);
    await expect(salesService.deleteDeliveryAddress(customer.id, fetched!.deliveryAddressId!)).rejects.toThrow(
      DeliveryAddressNotFoundError
    );
    // … nor pickable on another order of the same customer.
    await expect(
      salesService.createQuote(
        {
          customerId: customer.id,
          deliveryAddressId: fetched!.deliveryAddressId!,
          rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }],
        },
        user.id
      )
    ).rejects.toThrow(DeliveryAddressNotFoundError);
    // The order itself may send its own address back unchanged.
    const same = await salesService.updateSalesOrderHeader(order.id, {
      deliveryAddressId: fetched!.deliveryAddressId!,
      customerReference: "Kalle",
    });
    expect(same.deliveryAddressId).toBe(fetched!.deliveryAddressId);
  });

  it("saves a Ny leveransadress on the customer when Spara på kunden is ticked", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();
    const { order } = await salesService.createQuote(
      {
        customerId: customer.id,
        newDeliveryAddress: { label: "Lager Väst", address: "Hamngatan 3", country: "SE", saveToCustomer: true },
        rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }],
      },
      user.id
    );
    const list = await salesService.listDeliveryAddresses(customer.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe("Lager Väst");
    expect(list[0]!.isDefault).toBe(false);
    expect(list[0]!.id).toBe(order.deliveryAddressId);
    expect((await salesService.getSalesOrder(order.id))!.deliveryAddressOneOff).toBe(false);
  });

  it("replaces the order's address via PATCH and deletes the engångsadress it no longer uses", async () => {
    const { order, address, customer } = await makeOrderWithAddress();
    const exists = async (id: string) =>
      (await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.id, id))).length === 1;

    const first = await salesService.updateSalesOrderHeader(order.id, {
      newDeliveryAddress: { label: "Engång 1", address: "Gata 1", country: "SE", saveToCustomer: false },
    });
    const firstId = first.deliveryAddressId!;
    expect(first.deliveryAddressLabel).toBe("Engång 1");
    // The customer's saved address is left alone.
    expect(await exists(address.id)).toBe(true);

    const second = await salesService.updateSalesOrderHeader(order.id, {
      newDeliveryAddress: { label: "Engång 2", address: "Gata 2", country: "SE", saveToCustomer: false },
    });
    expect(second.deliveryAddressLabel).toBe("Engång 2");
    expect(await exists(firstId)).toBe(false);

    const back = await salesService.updateSalesOrderHeader(order.id, { deliveryAddressId: address.id });
    expect(back.deliveryAddressId).toBe(address.id);
    expect(await exists(second.deliveryAddressId!)).toBe(false);
    expect((await salesService.listDeliveryAddresses(customer.id)).map((a) => a.id)).toEqual([address.id]);

    // A saved address the order stops using stays on the customer.
    const saved = await salesService.updateSalesOrderHeader(order.id, {
      newDeliveryAddress: { label: "Sparad", address: "Gata 3", country: "SE", saveToCustomer: true },
    });
    await salesService.updateSalesOrderHeader(order.id, { deliveryAddressId: null });
    expect(await exists(saved.deliveryAddressId!)).toBe(true);
  });

  it("refuses a Ny leveransadress outside the editable statuses", async () => {
    const { order } = await makeOrderWithAddress();
    await salesService.cancel(order.id);
    await expect(
      salesService.updateSalesOrderHeader(order.id, {
        newDeliveryAddress: { label: "Sen", address: "Gata 4", country: "SE", saveToCustomer: false },
      })
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("accepts either deliveryAddressId or newDeliveryAddress, never both", () => {
    const newDeliveryAddress = { label: "A", address: "Gata 1" };
    const base = { customerId: crypto.randomUUID(), rows: [{ articleId: crypto.randomUUID(), quantity: 1 }] };
    expect(createQuoteSchema.safeParse({ ...base, newDeliveryAddress }).success).toBe(true);
    expect(
      createQuoteSchema.safeParse({ ...base, newDeliveryAddress, deliveryAddressId: crypto.randomUUID() }).success
    ).toBe(false);
    expect(updateSalesOrderHeaderSchema.safeParse({ newDeliveryAddress }).success).toBe(true);
    expect(updateSalesOrderHeaderSchema.safeParse({ newDeliveryAddress, deliveryAddressId: null }).success).toBe(false);
  });

  it("bumps the revision on content changes but not on status transitions or deliveries", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    // createQuote inserts its rows in the same transaction — a new order is rev 1.
    expect((await salesService.getSalesOrder(order.id))!.revision).toBe(1);

    await salesService.updateSalesOrderHeader(order.id, { customerReference: "Stina" });
    expect((await salesService.getSalesOrder(order.id))!.revision).toBe(2);

    // One row per article per order — the extra row needs its own article.
    const otherArticle = await makeArticle();
    const extra = await salesService.addRow(order.id, { articleId: otherArticle.id, quantity: 1, unitPrice: 1 });
    // unitPrice sent (matching the row's existing price) — this test is
    // about the revision counter, not C3's price re-resolution; the article
    // carries no price-chain data so an omitted unitPrice would 400.
    await salesService.updateRow(order.id, row.id, { quantity: 8, unitPrice: 99 });
    await salesService.deleteRow(order.id, extra.id);
    expect((await salesService.getSalesOrder(order.id))!.revision).toBe(5);

    // Status transitions and deliveries leave the revision untouched.
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 2 }, user.id);
    expect((await salesService.getSalesOrder(order.id))!.revision).toBe(5);

    // A rejected row edit (quantity below delivered) does not bump either.
    await expect(salesService.updateRow(order.id, row.id, { quantity: 1, unitPrice: 99 })).rejects.toThrow();
    expect((await salesService.getSalesOrder(order.id))!.revision).toBe(5);
  });

  it("saves without bumping the revision when bumpRevision is false", async () => {
    const { order, row } = await makeQuoteWithRow(10); // rev 1

    await salesService.updateSalesOrderHeader(order.id, { customerReference: "Stina", bumpRevision: false });
    await salesService.updateRow(order.id, row.id, { quantity: 8, unitPrice: 99, bumpRevision: false });
    const otherArticle = await makeArticle();
    const extra = await salesService.addRow(order.id, {
      articleId: otherArticle.id,
      quantity: 1,
      unitPrice: 1,
      bumpRevision: false,
    });
    await salesService.deleteRow(order.id, extra.id, false);

    const after = await salesService.getSalesOrder(order.id);
    expect(after!.revision).toBe(1);
    // The edits themselves went through.
    expect(after!.customerReference).toBe("Stina");
    expect((await salesService.listRows(order.id)).length).toBe(1);
  });

  it("sets any status manually — reviving terminal orders, never assigning invoice numbers", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(5);
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 5 }, user.id);
    await stampOrderInvoiced(db, order.id, "FA-9001");
    const invoiced = await salesService.getSalesOrder(order.id);
    expect(invoiced!.invoiceNumber).toBeTruthy();

    // Invoiced is terminal for the state machine — the manual override
    // deliberately ignores that, and the invoice number survives the trip.
    const backed = await salesService.setStatus(order.id, "in_production");
    expect(backed!.status).toBe("in_production");
    expect(backed!.invoiceNumber).toBe(invoiced!.invoiceNumber);
    expect(backed!.revision).toBe(1); // status hops never bump

    // Manually setting "invoiced" does NOT create an invoice.
    const { order: other } = await makeQuoteWithRow(2);
    const manual = await salesService.setStatus(other.id, "invoiced");
    expect(manual!.status).toBe("invoiced");
    expect(manual!.invoiceNumber).toBeNull();

    // Cancelled orders can be revived too.
    await salesService.setStatus(other.id, "cancelled");
    expect((await salesService.setStatus(other.id, "quote"))!.status).toBe("quote");
  });

  it("prints the revision after the order number on quote/confirmation PDFs but not on the invoice", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(3);
    await salesService.updateSalesOrderHeader(order.id, { customerReference: "Stina" }); // rev 2

    const confirmation = await salesService.getSalesOrderPdf(order.id, "confirmation");
    expect(pdfText(confirmation.content)).toContain(`${order.orderNumber} / 2`);

    // Turning the setting off leaves the order number bare.
    await systemService.updateSettings({ showOrderRevisionOnDocuments: false });
    try {
      const off = await salesService.getSalesOrderPdf(order.id, "confirmation");
      expect(pdfText(off.content)).toContain(order.orderNumber);
      expect(pdfText(off.content)).not.toContain(`${order.orderNumber} / `);
    } finally {
      await systemService.updateSettings({ showOrderRevisionOnDocuments: true });
    }

    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 3 }, user.id);
    await stampOrderInvoiced(db, order.id, "FA-9002");
    const invoice = await salesService.getInvoicePdf(order.id);
    expect(pdfText(invoice.content)).not.toContain(" / 2");
  });

  it("prints the customer number on the quote/order confirmation PDF", async () => {
    const { order, customer } = await makeQuoteWithRow(2);

    const quote = await salesService.getSalesOrderPdf(order.id, "quote");
    expect(pdfText(quote.content)).toContain(`Kundnr: ${customer.customerNumber}`);

    const confirmation = await salesService.getSalesOrderPdf(order.id, "confirmation");
    expect(pdfText(confirmation.content)).toContain(`Kundnr: ${customer.customerNumber}`);
  });

  it("prints article/drawing revisions on the order confirmation only when the setting is on", async () => {
    const { order, article } = await makeQuoteWithRow(2);
    await articleService.createRevision(article.id, { revision: "A", isActive: false });

    await systemService.updateSettings({ showRevisionsOnDocuments: false });
    const off = await salesService.getSalesOrderPdf(order.id, "confirmation");
    expect(pdfText(off.content)).not.toContain("Rev A");

    await systemService.updateSettings({ showRevisionsOnDocuments: true });
    try {
      const on = await salesService.getSalesOrderPdf(order.id, "confirmation");
      expect(pdfText(on.content)).toContain("Rev A");
    } finally {
      await systemService.updateSettings({ showRevisionsOnDocuments: false });
    }
  });

  it("renders order + pick list PDFs with the header fields present", async () => {
    const { order } = await makeOrderWithAddress();
    const { content } = await salesService.getSalesOrderPdf(order.id, "confirmation");
    expect(content.subarray(0, 4).toString()).toBe("%PDF");
    expect(content.length).toBeGreaterThan(1000);

    const pickList = await salesService.getPickListPdf(order.id);
    expect(pickList.content.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("C3: prints a Rabatt column with the row's discount on the quote/confirmation PDF", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();

    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 2, unitPrice: 100, discountPercent: 10 }] },
      user.id
    );

    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(text).toContain("Rabatt");
    expect(text).toContain("10 %");
    // 2 × 100 × (1 − 10 %) = 180.00 row amount and total.
    expect(text).toContain("180,00");
  });

  // Superseded the C3-era expectation that the empty column still printed its
  // header: the uppföljningssvep made the column conditional (colsFor in
  // document-pdf.ts), because an always-present Rabatt header also leaked onto
  // the inquiry/PO documents — where rows can't carry a discount at all — and
  // cost Benämning ~27 pt of width there.
  it("drops the Rabatt column entirely from a quote with no discounted rows", async () => {
    const { order } = await makeQuoteWithRow(2);

    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(text).not.toContain("Rabatt");
    expect(text).not.toContain("%");
    // The columns that must survive the narrower table.
    expect(text).toContain("Benämning");
    expect(text).toContain("Summa");
  });

  it("configurator flow without the new fields still works", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();
    const parsed = createQuoteSchema.parse({
      customerId: customer.id,
      rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }],
    });
    const { order } = await salesService.createQuote(parsed, user.id);
    expect(order.customerOrderNumber).toBeNull();
    expect(order.deliveryAddressId).toBeNull();
  });
});

describe("sales service — order terms (villkor)", () => {
  it("snapshots the customer's terms onto a new quote and allows header edits", async () => {
    const user = await makeUser();
    const deliveryTerm = await registerService.deliveryTerms.create({ code: "DAP", name: "Delivered at Place" });
    const paymentTerm = await registerService.paymentTerms.create({ code: "N30", name: "30 dagar netto" });
    const customer = await salesService.createCustomer({
      name: "Villkorskund AB",
      active: true,
      deliveryTermId: deliveryTerm.id,
      paymentTermId: paymentTerm.id,
    });
    const article = await makeArticle();

    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 10 }] },
      user.id
    );
    const fetched = await salesService.getSalesOrder(order.id);
    expect(fetched!.deliveryTermId).toBe(deliveryTerm.id);
    expect(fetched!.paymentTermCode).toBe("N30");
    expect(fetched!.carrierId).toBeNull();

    // Header PATCH: change + clear + unknown id rejected.
    const carrier = await registerService.carriers.create({ code: "BRING", name: "Bring" });
    const updated = await salesService.updateSalesOrderHeader(order.id, {
      carrierId: carrier.id,
      deliveryTermId: null,
    });
    expect(updated!.carrierCode).toBe("BRING");
    expect(updated!.deliveryTermId).toBeNull();
    await expect(
      salesService.updateSalesOrderHeader(order.id, { paymentTermId: crypto.randomUUID() })
    ).rejects.toThrow(RegisterEntryNotFoundError);

    // PDF renders with terms present.
    const { content } = await salesService.getSalesOrderPdf(order.id, "quote");
    expect(content.subarray(0, 4).toString()).toBe("%PDF");
  });
});

describe("customer numbers (kundnummer)", () => {
  it("auto-allocates sequential customer numbers from the number series", async () => {
    const a = await salesService.createCustomer({ name: "Kund A", active: true });
    const b = await salesService.createCustomer({ name: "Kund B", active: true });

    // number_series is never truncated, so the counter survives across
    // tests — assert the relative sequence, never absolute values. (The
    // "walks past" test below pins nextNumber immediately before asserting,
    // so absolute values there are safe despite the shared counter.)
    expect(a.customerNumber).toMatch(/^\d+$/);
    expect(Number(b.customerNumber)).toBe(Number(a.customerNumber) + 1);
  });

  it("respects a manually supplied customer number", async () => {
    const c = await salesService.createCustomer({ name: "Kund C", customerNumber: "KUND-77", active: true });
    expect(c.customerNumber).toBe("KUND-77");
  });

  it("rejects a duplicate customer number at create", async () => {
    await salesService.createCustomer({ name: "Kund D", customerNumber: "DUBLETT-1", active: true });
    await expect(
      salesService.createCustomer({ name: "Kund E", customerNumber: "DUBLETT-1", active: true })
    ).rejects.toThrow(DuplicateCustomerNumberError);
  });

  it("walks past a manually taken number instead of wedging the series", async () => {
    // Take a number by hand, then point the series straight at it: the next
    // auto-allocated create must step over it rather than fail — and keep
    // working afterwards.
    const taken = await salesService.createCustomer({ name: "Upptagen AB", customerNumber: "8100", active: true });
    await db.update(numberSeries).set({ nextNumber: 8100 }).where(eq(numberSeries.key, "customer"));

    const next = await salesService.createCustomer({ name: "Nästa AB", active: true });
    expect(next.customerNumber).toBe("8101");
    expect(taken.customerNumber).toBe("8100");

    const after = await salesService.createCustomer({ name: "Därefter AB", active: true });
    expect(after.customerNumber).toBe("8102");
  });

  it("still rejects a manually supplied duplicate without retrying", async () => {
    await salesService.createCustomer({ name: "Först AB", customerNumber: "8200", active: true });
    const [before] = await db.select().from(numberSeries).where(eq(numberSeries.key, "customer"));

    await expect(
      salesService.createCustomer({ name: "Andra AB", customerNumber: "8200", active: true })
    ).rejects.toThrow(DuplicateCustomerNumberError);

    // Asserting only the thrown error would also pass if the code retried
    // (and burned numbers) before giving up — prove "without retrying" by
    // checking the series counter didn't move at all.
    const [after] = await db.select().from(numberSeries).where(eq(numberSeries.key, "customer"));
    expect(after!.nextNumber).toBe(before!.nextNumber);
  });
});

// G1: audit trail — one representative assertion per action class rather
// than every permutation (mirrors payroll-attest.test.ts's auditRows helper).
async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

describe("sales service — audit trail", () => {
  it("logs status transitions with the acting user", async () => {
    const { order, user } = await makeQuoteWithRow(5);
    await salesService.confirm(order.id, user.id);
    await salesService.startProduction(order.id, user.id);

    const confirmed = await auditRows("sales_order", "confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.entityId).toBe(order.orderNumber);
    expect(confirmed[0]!.userId).toBe(user.id);

    const started = await auditRows("sales_order", "production_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.entityId).toBe(order.orderNumber);
  });

  it("logs cancel and setStatus with before/after", async () => {
    const { order: quoteOrder, user } = await makeQuoteWithRow(5);
    await salesService.cancel(quoteOrder.id, user.id);
    const cancelled = await auditRows("sales_order", "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.entityId).toBe(quoteOrder.orderNumber);
    expect(cancelled[0]!.userId).toBe(user.id);

    const { order } = await makeQuoteWithRow(5);
    await salesService.setStatus(order.id, "invoiced", user.id);
    const statusSet = await auditRows("sales_order", "status_set");
    expect(statusSet).toHaveLength(1);
    expect(statusSet[0]!.detail).toMatchObject({ before: "quote", after: "invoiced" });
  });

  it("logs row_added/row_updated/row_deleted under the parent order with article number and before/after", async () => {
    const { order, user } = await makeQuoteWithRow(5);
    // The row is PATCHed with quantity only further down, and C3 re-resolves
    // the price chain for such a PATCH (a new quantity may cross a staffel
    // break). The article therefore needs a price, or the chain comes back
    // empty and PriceNotFoundError is thrown before any audit row is written.
    // 10 is the same price addRow sends, so unitPrice is unchanged in the
    // audit row's before/after and only the quantity moves.
    const articleB = await makeArticle(10);
    const extra = await salesService.addRow(order.id, { articleId: articleB.id, quantity: 2, unitPrice: 10 }, user.id);

    const added = await auditRows("sales_order_row", "row_added");
    expect(added).toHaveLength(1);
    expect(added[0]!.entityId).toBe(order.orderNumber);
    expect(added[0]!.detail).toMatchObject({ articleNumber: articleB.articleNumber, quantity: "2.0000" });

    await salesService.updateRow(order.id, extra.id, { quantity: 3 }, user.id);
    const updated = await auditRows("sales_order_row", "row_updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.detail).toMatchObject({
      articleNumber: articleB.articleNumber,
      before: { quantity: "2.0000" },
      after: { quantity: "3.0000" },
    });

    await salesService.deleteRow(order.id, extra.id, true, user.id);
    const deleted = await auditRows("sales_order_row", "row_deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.detail).toMatchObject({ articleNumber: articleB.articleNumber });
  });

  it("logs a delivered delivery under its own FS-number", async () => {
    const { order, row, location, user } = await makeQuoteWithRow(10);
    await salesService.confirm(order.id, user.id);
    await salesService.startProduction(order.id, user.id);
    const result = await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 4 }, user.id);

    const delivered = await auditRows("delivery", "delivered");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.entityId).toBe(result.deliveryNumber);
    expect(delivered[0]!.detail).toMatchObject({ orderNumber: order.orderNumber });
  });

  it("logs price list create/row CRUD and customer price CRUD", async () => {
    const user = await makeUser();
    const article = await makeArticle();
    const list = await salesService.createPriceList({ code: "PL-1", name: "Prislista 1" }, user.id);
    const createdList = await auditRows("price_list", "created");
    expect(createdList).toHaveLength(1);
    expect(createdList[0]!.entityId).toBe("PL-1");

    const row = await salesService.addPriceListRow(list.id, { articleId: article.id, fromQuantity: 1, unitPrice: 50 }, user.id);
    const rowAdded = await auditRows("price_list", "row_added");
    expect(rowAdded).toHaveLength(1);
    expect(rowAdded[0]!.detail).toMatchObject({ articleNumber: article.articleNumber });

    await salesService.updatePriceListRow(list.id, row.id, { unitPrice: 60 }, user.id);
    const rowUpdated = await auditRows("price_list", "row_updated");
    expect(rowUpdated).toHaveLength(1);
    expect(rowUpdated[0]!.detail).toMatchObject({ before: { unitPrice: "50.0000" }, after: { unitPrice: "60.0000" } });

    const customer = await makeCustomer();
    const price = await salesService.addCustomerPrice(customer.id, { articleId: article.id, fromQuantity: 1, unitPrice: 40 }, user.id);
    const priceCreated = await auditRows("customer_price", "created");
    expect(priceCreated).toHaveLength(1);
    expect(priceCreated[0]!.entityId).toBe(price.id);

    await salesService.deleteCustomerPrice(customer.id, price.id, user.id);
    const priceDeleted = await auditRows("customer_price", "deleted");
    expect(priceDeleted).toHaveLength(1);
  });
});
