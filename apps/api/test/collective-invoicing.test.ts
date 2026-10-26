import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, salesOrders } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import {
  CollectiveInvoicingCustomerError,
  createInvoiceService,
} from "../src/modules/sales/service/invoice.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { vatRateGroupId } from "./helpers/vat-group.js";

// Samlingsfakturering: customers flagged collective_invoicing are billed by
// the routine (one invoice per customer across all delivered orders) and
// refused by the ordinary create(). Wiring mirrors customer-invoice.service.test.ts.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));

const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail() {},
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
  (query) => resolvePrice(db, query)
);
const invoiceRepo = createInvoiceRepository(db);
const invoicePoster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
const invoiceService = createInvoiceService(
  invoiceRepo,
  mailService,
  documentPdfService,
  invoicePoster,
  createAuditRepository(db),
  articleService
);

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_rows, invoices, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

let biller: string;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  biller = (await makeUser()).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `coll-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Biller",
    role: "admin",
  });
}

async function makeCustomer(
  opts: { name?: string; collectiveInvoicing?: boolean; privatePerson?: boolean; ourSupplierNumber?: string } = {}
) {
  return salesService.createCustomer({
    name: opts.name ?? "Kund AB",
    active: true,
    collectiveInvoicing: opts.collectiveInvoicing ?? false,
    privatePerson: opts.privatePerson ?? false,
    ...(opts.ourSupplierNumber ? { ourSupplierNumber: opts.ourSupplierNumber } : {}),
  });
}

async function makeArticle(vatRate?: number) {
  return articleService.createArticle({
    articleNumber: `ART-COLL-${crypto.randomUUID()}`,
    name: "Fakturaartikel",
    type: "manufactured",
    active: true,
    ...(vatRate !== undefined ? { groupId: await vatRateGroupId(vatRate) } : {}),
  });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

async function makeDeliveredOrderRow(opts: {
  customer: Awaited<ReturnType<typeof makeCustomer>>;
  quantity?: number;
  unitPrice?: number;
  vatRate?: number;
  customerOrderNumber?: string;
}) {
  const user = await makeUser();
  const article = await makeArticle(opts.vatRate);
  const location = await makeLocation();
  const quantity = opts.quantity ?? 10;
  await stockService.recordTransaction({
    articleId: article.id,
    locationId: location.id,
    quantityDelta: quantity,
    transactionType: "inventory_adjustment",
  });
  const { order, rows } = await salesService.createQuote(
    {
      customerId: opts.customer.id,
      rows: [{ articleId: article.id, quantity, unitPrice: opts.unitPrice ?? 100 }],
      confirm: true,
      ...(opts.customerOrderNumber ? { customerOrderNumber: opts.customerOrderNumber } : {}),
    },
    user.id
  );
  await salesService.startProduction(order.id);
  await salesService.deliverGoods(order.id, rows[0]!.id, { locationId: location.id, quantity }, user.id);
  const [row] = await salesService.listRows(order.id);
  return { order, row: row!, article };
}

async function orderStatus(orderId: string) {
  const [o] = await db.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, orderId));
  return o!.status;
}

describe("samlingsfakturering — candidates", () => {
  it("lists only flagged customers with an uninvoiced delivered rest, aggregated per customer", async () => {
    const flagged = await makeCustomer({ name: "Samlad AB", collectiveInvoicing: true });
    const plain = await makeCustomer({ name: "Vanlig AB" });
    await makeCustomer({ name: "Tom AB", collectiveInvoicing: true }); // flagged, nothing delivered
    await makeDeliveredOrderRow({ customer: flagged, quantity: 5, unitPrice: 40 });
    await makeDeliveredOrderRow({ customer: flagged, quantity: 3, unitPrice: 60 });
    await makeDeliveredOrderRow({ customer: plain, quantity: 2 });

    const candidates = await invoiceService.listCollectiveInvoicingCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      customerId: flagged.id,
      customerNumber: flagged.customerNumber,
      name: "Samlad AB",
      orderCount: 2,
      rowCount: 2,
      netAmount: 5 * 40 + 3 * 60,
    });
  });

  it("excludes quantity already sitting on a draft invoice", async () => {
    const flagged = await makeCustomer({ collectiveInvoicing: true });
    const a = await makeDeliveredOrderRow({ customer: flagged, quantity: 4, unitPrice: 10 });
    await makeDeliveredOrderRow({ customer: flagged, quantity: 6, unitPrice: 10 });
    // A draft (made via the routine's own back door) covering order A only.
    await invoiceService.create(
      {
        customerId: flagged.id,
        rows: [{ description: "A", articleId: a.article.id, salesOrderRowId: a.row.id, quantity: 4, unitPrice: 10 }],
      },
      biller,
      { collective: true }
    );

    const [candidate] = await invoiceService.listCollectiveInvoicingCandidates();
    expect(candidate).toMatchObject({ orderCount: 1, rowCount: 1, netAmount: 60 });
  });
});

describe("samlingsfakturering — run", () => {
  it("creates ONE draft invoice per selected customer covering rows from all its orders", async () => {
    const c1 = await makeCustomer({ name: "Ett AB", collectiveInvoicing: true });
    const c2 = await makeCustomer({ name: "Två AB", collectiveInvoicing: true });
    const a = await makeDeliveredOrderRow({ customer: c1, quantity: 5, unitPrice: 40 });
    const b = await makeDeliveredOrderRow({ customer: c1, quantity: 3, unitPrice: 60 });
    await makeDeliveredOrderRow({ customer: c2, quantity: 1, unitPrice: 500 });

    const { results } = await invoiceService.runCollectiveInvoicing(
      { customerIds: [c1.id, c2.id], issue: false },
      biller
    );
    expect(results).toHaveLength(2);
    const r1 = results.find((r) => r.customerId === c1.id)!;
    expect(r1).toMatchObject({ status: "draft", rowCount: 2, invoiceNumber: null, error: null });
    const inv1 = await invoiceService.getInvoice(r1.invoiceId!);
    expect(inv1!.rows.map((r) => r.salesOrderRowId).sort()).toEqual([a.row.id, b.row.id].sort());
    expect(inv1!.rows.map((r) => r.salesOrderNumber).sort()).toEqual(
      [a.order.orderNumber, b.order.orderNumber].sort()
    );
    const r2 = results.find((r) => r.customerId === c2.id)!;
    expect(r2).toMatchObject({ status: "draft", rowCount: 1 });
    // Both orders still 'delivered' — a draft invoices nothing yet.
    expect(await orderStatus(a.order.id)).toBe("delivered");
  });

  it("with issue: true issues each invoice (FA number, F verification) and flips the orders to invoiced", async () => {
    const c1 = await makeCustomer({ collectiveInvoicing: true });
    const a = await makeDeliveredOrderRow({ customer: c1, quantity: 5, unitPrice: 40 });
    const b = await makeDeliveredOrderRow({ customer: c1, quantity: 3, unitPrice: 60 });

    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [c1.id], issue: true }, biller);
    expect(results[0]).toMatchObject({ status: "issued", error: null });
    expect(results[0]!.invoiceNumber).toMatch(/^FA/);
    const inv = await invoiceService.getInvoice(results[0]!.invoiceId!);
    expect(inv!.verificationId).not.toBeNull();
    expect(await orderStatus(a.order.id)).toBe("invoiced");
    expect(await orderStatus(b.order.id)).toBe("invoiced");
    // Nothing left to bill.
    expect(await invoiceService.listCollectiveInvoicingCandidates()).toHaveLength(0);
  });

  it("reports per-customer errors and keeps going: unknown id and unflagged customer fail, the flagged one succeeds", async () => {
    const plain = await makeCustomer({ name: "Vanlig AB" });
    await makeDeliveredOrderRow({ customer: plain, quantity: 1 });
    const flagged = await makeCustomer({ collectiveInvoicing: true });
    await makeDeliveredOrderRow({ customer: flagged, quantity: 2, unitPrice: 10 });
    const ghost = crypto.randomUUID();

    const { results } = await invoiceService.runCollectiveInvoicing(
      { customerIds: [ghost, plain.id, flagged.id], issue: false },
      biller
    );
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ customerId: ghost, invoiceId: null });
    expect(results[0]!.error).toBeTruthy();
    expect(results[1]).toMatchObject({ customerId: plain.id, invoiceId: null });
    expect(results[1]!.error).toBeTruthy();
    expect(results[2]).toMatchObject({ customerId: flagged.id, status: "draft", rowCount: 1, error: null });
  });

  it("skips a flagged customer with nothing to invoice", async () => {
    const flagged = await makeCustomer({ collectiveInvoicing: true });
    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [flagged.id], issue: true }, biller);
    expect(results[0]).toMatchObject({
      customerId: flagged.id,
      invoiceId: null,
      status: "skipped",
      rowCount: 0,
      error: null,
    });
  });
});

describe("samlingsfakturering — the ordinary create is refused for flagged customers", () => {
  it("create() throws CollectiveInvoicingCustomerError, but a credit note against the collective invoice works", async () => {
    const flagged = await makeCustomer({ collectiveInvoicing: true });
    const a = await makeDeliveredOrderRow({ customer: flagged, quantity: 2, unitPrice: 10 });

    await expect(
      invoiceService.create(
        { customerId: flagged.id, rows: [{ description: "Fri rad", quantity: 1, unitPrice: 5 }] },
        biller
      )
    ).rejects.toBeInstanceOf(CollectiveInvoicingCustomerError);

    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [flagged.id], issue: true }, biller);
    const credit = await invoiceService.createCredit(results[0]!.invoiceId!, {}, biller);
    expect(credit!.type).toBe("credit");
    expect(credit!.rows[0]!.salesOrderRowId).toBe(a.row.id);
  });
});

describe("samlingsfakturering — invoice PDF prints the order per row", () => {
  it("shows 'Order KO…' (and 'Ert ordernr' when set) under each linked row, plus Vårt leverantörsnr", async () => {
    const flagged = await makeCustomer({ collectiveInvoicing: true, ourSupplierNumber: "LEV-4711" });
    const a = await makeDeliveredOrderRow({
      customer: flagged,
      quantity: 1,
      unitPrice: 10,
      customerOrderNumber: "PO-999",
    });
    const b = await makeDeliveredOrderRow({ customer: flagged, quantity: 1, unitPrice: 10 });
    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [flagged.id], issue: true }, biller);
    const { content } = await invoiceService.renderPdf(results[0]!.invoiceId!);
    const text = pdfText(content);
    expect(text).toContain(`Order ${a.order.orderNumber}`);
    expect(text).toContain("Ert ordernr PO-999");
    expect(text).toContain(`Order ${b.order.orderNumber}`);
    expect(text).toContain("Vårt leverantörsnr hos er: LEV-4711");
  });
});

describe("privatperson — documents print prices including VAT", () => {
  it("quote PDF: unit price and line amount grossed up, 'Summa inkl. moms' + 'Varav moms', no 'exkl. moms'", async () => {
    const person = await makeCustomer({ name: "Anna Andersson", privatePerson: true });
    const article = await makeArticle(25);
    const user = await makeUser();
    const { order } = await salesService.createQuote(
      { customerId: person.id, rows: [{ articleId: article.id, quantity: 2, unitPrice: 100 }] },
      user.id
    );
    const { content } = await salesService.getSalesOrderPdf(order.id, "quote");
    const text = pdfText(content);
    expect(text).toContain("Priser inklusive moms");
    expect(text).toContain("125,00"); // à-pris inkl. moms
    expect(text).toContain("250,00"); // radsumma + summa inkl. moms
    expect(text).toContain("Summa inkl. moms");
    expect(text).toContain("Varav moms");
    expect(text).toContain("50,00");
    expect(text).not.toContain("exkl. moms");
  });

  it("quote PDF for an ordinary customer is unchanged (net prices, plain 'Summa')", async () => {
    const company = await makeCustomer({ name: "Bolag AB" });
    const article = await makeArticle(25);
    const user = await makeUser();
    const { order } = await salesService.createQuote(
      { customerId: company.id, rows: [{ articleId: article.id, quantity: 2, unitPrice: 100 }] },
      user.id
    );
    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(text).not.toContain("inkl. moms");
    expect(text).not.toContain("Varav moms");
    expect(text).toContain("200,00");
  });

  it("invoice PDF follows the snapshot: issued as private person → gross prices even after the flag is cleared", async () => {
    const person = await makeCustomer({ name: "Anna Andersson", privatePerson: true });
    const a = await makeDeliveredOrderRow({ customer: person, quantity: 2, unitPrice: 100, vatRate: 25 });
    const invoice = await invoiceService.create(
      {
        customerId: person.id,
        rows: [
          { description: "Rad", articleId: a.article.id, salesOrderRowId: a.row.id, quantity: 2, unitPrice: 100 },
        ],
      },
      biller
    );
    await invoiceService.issue(invoice!.id, biller);
    await salesService.updateCustomer(person.id, { privatePerson: false });

    const text = pdfText((await invoiceService.renderPdf(invoice!.id)).content);
    expect(text).toContain("Priser inklusive moms");
    expect(text).toContain("125,00");
    expect(text).toContain("Att betala");
    expect(text).toContain("Varav moms");
    expect(text).not.toContain("exkl. moms");
  });
});
