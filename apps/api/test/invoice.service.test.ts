import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService, InvalidStatusTransitionError } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { pdfText } from "./helpers/pdf.js";
import { stampOrderInvoiced } from "./helpers/services.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));

const sentMails: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
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
  (query) => resolvePrice(db, query)
);

const TABLES = sql`TRUNCATE email_log, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
  sentMails.length = 0;
  await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
});

afterAll(async () => {
  await db.execute(TABLES);
});

// Order taken all the way to "delivered" so it can be invoiced.
async function makeDeliveredOrder(customerInput: Parameters<typeof salesService.createCustomer>[0]) {
  const customer = await salesService.createCustomer(customerInput);
  const article = await articleService.createArticle({
    articleNumber: `FAKT-${crypto.randomUUID().slice(0, 8)}`,
    name: "Fakturaartikel",
    type: "manufactured",
    isPhantom: false,
    active: true,
  });
  const { order } = await salesService.createQuote(
    { customerId: customer.id, rows: [{ articleId: article.id, quantity: 2, unitPrice: 500 }], confirm: true },
    null
  );
  const [row] = await salesService.listRows(order.id);
  await salesService.startProduction(order.id);
  await salesService.deliverGoods(order.id, row!.id, { quantity: 2 }, null);
  return { customer, order };
}

// Pre-C1, "invoicing" an order meant stamping status/invoiceNumber/invoicedAt
// straight onto the sales order (salesService.invoice / repo.invoiceOrder,
// both removed). Those columns and their read paths (getInvoicePdf/
// sendInvoiceEmail/renderInvoicePdf) stay for orders that were already
// invoiced before the cutover — this suite stamps orders the same way the
// old code did (stampOrderInvoiced) and asserts those legacy reads still
// work. New invoices are covered by customer-invoice.service.test.ts; the
// FA-number-assignment behavior itself now lives in the invoice module and
// is tested there, not here.
describe("sales — legacy stamped-order invoices (pre-C1)", () => {
  it("stamps a delivered order invoiced with a stable invoice number and timestamp", async () => {
    const { order } = await makeDeliveredOrder({ name: "Kund AB", active: true });

    await stampOrderInvoiced(db, order.id, "FA-1001");
    const invoiced = await salesService.getSalesOrder(order.id);
    expect(invoiced?.status).toBe("invoiced");
    expect(invoiced?.invoiceNumber).toBe("FA-1001");
    expect(invoiced?.invoicedAt).not.toBeNull();
  });

  it("refuses the invoice PDF until the order is invoiced", async () => {
    const { order } = await makeDeliveredOrder({ name: "Kund AB", active: true });
    await expect(salesService.getInvoicePdf(order.id)).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("prints the customer's invoice address and a VAT summary on the invoice", async () => {
    const term = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const { order } = await makeDeliveredOrder({
      name: "Kund AB",
      active: true,
      address: "Besöksgatan 1",
      postalCode: "111 11",
      city: "Visby",
      invoiceAddress: "Fakturavägen 9",
      invoicePostalCode: "222 22",
      invoiceCity: "Fakturastad",
      paymentTermId: term.id,
    });
    await stampOrderInvoiced(db, order.id, "FA-1002");

    const { filename, content } = await salesService.getInvoicePdf(order.id);
    expect(filename).toMatch(/^Faktura-FA-\d+\.pdf$/);
    const text = pdfText(content);

    expect(text).toContain("Faktura FA-");
    // The invoice address wins over the visiting address.
    expect(text).toContain("Fakturaväg");
    expect(text).toContain("222 22 Fakturastad");
    expect(text).not.toContain("222 22 Visby");
    // VAT block: 2 × 500 = 1000 excl., 250 moms, 1250 to pay.
    expect(text).toContain("Summa exkl. moms");
    expect(text).toContain("Moms (25 %)");
    expect(text).toContain("Att betala");
    // sv-SE thousands separator is a non-breaking space.
    expect(text).toMatch(/1[\s  ]250,00/);
    // Payment term "30" → due date printed.
    expect(text).toContain("rfallodatum"); // Förfallodatum
    // The originating order is referenced.
    expect(text).toContain(order.orderNumber);
  });

  it("falls back to the visiting address when no invoice address is set", async () => {
    const { order } = await makeDeliveredOrder({
      name: "Kund AB",
      active: true,
      address: "Besöksgatan 1",
      postalCode: "111 11",
      city: "Visby",
    });
    await stampOrderInvoiced(db, order.id, "FA-1003");
    const text = pdfText((await salesService.getInvoicePdf(order.id)).content);
    expect(text).toContain("111 11 Visby");
  });

  it("emails the invoice as a PDF attachment and logs it as documentType invoice", async () => {
    const { order } = await makeDeliveredOrder({ name: "Kund AB", active: true });
    await stampOrderInvoiced(db, order.id, "FA-1004");

    await salesService.sendInvoiceEmail(order.id, {
      to: "faktura@kund.se",
      subject: "Faktura",
      message: "Se bifogad faktura.",
      attachDrawings: false,
    });

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.attachments?.[0]?.filename).toMatch(/^Faktura-FA-\d+\.pdf$/);

    const log = await mailService.listEmailLog({ documentType: "invoice", documentId: order.id, limit: 10, offset: 0 });
    expect(log.total).toBe(1);
  });
});
