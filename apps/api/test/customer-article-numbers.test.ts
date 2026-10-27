// Kundens artikelnummer (migration 0160): the customer card's CRUD and the
// "Ert art.nr" line on the sales documents.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleSchema } from "@navet/shared";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";
import {
  CustomerArticleNumberNotFoundError,
  DuplicateCustomerArticleNumberError,
} from "../src/modules/sales/service/sales.errors.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail() {
    /* no-op */
  },
});
const systemService = createSystemService(createSystemRepository(db));
const documentPdfService = createDocumentPdfService(systemService);
const salesService = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), systemService, fakeTransportFactory),
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  createAuditRepository(db)
);

const TRUNCATE = sql`TRUNCATE email_log, audit_log, customer_article_numbers, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticle(articleNumber: string) {
  return articleService.createArticle(
    createArticleSchema.parse({ articleNumber, name: "Diskbänk 1200", type: "manufactured", active: true })
  );
}

describe("Kundens artikelnummer", () => {
  it("adds, updates, refuses a duplicate and deletes on the customer card", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle("ART-KAN-1");
    const row = await salesService.addCustomerArticleNumber(customer.id, {
      articleId: article.id,
      customerArticleNumber: "KND-4711",
    });
    expect(await salesService.listCustomerArticleNumbers(customer.id)).toMatchObject([
      { articleNumber: "ART-KAN-1", customerArticleNumber: "KND-4711" },
    ]);
    await expect(
      salesService.addCustomerArticleNumber(customer.id, { articleId: article.id, customerArticleNumber: "X" })
    ).rejects.toBeInstanceOf(DuplicateCustomerArticleNumberError);
    const updated = await salesService.updateCustomerArticleNumber(customer.id, row.id, "KND-4712");
    expect(updated.customerArticleNumber).toBe("KND-4712");
    await salesService.deleteCustomerArticleNumber(customer.id, row.id);
    expect(await salesService.listCustomerArticleNumbers(customer.id)).toEqual([]);
    await expect(salesService.deleteCustomerArticleNumber(customer.id, row.id)).rejects.toBeInstanceOf(
      CustomerArticleNumberNotFoundError
    );
  });

  it("prints Ert art.nr on the quote and the pick list, only for that customer", async () => {
    const user = await authRepo.create({
      email: `kan-${crypto.randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      name: "Säljare",
      role: "admin",
    });
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const other = await salesService.createCustomer({ name: "Annan AB", active: true });
    const article = await makeArticle("ART-KAN-2");
    await salesService.addCustomerArticleNumber(customer.id, { articleId: article.id, customerArticleNumber: "KND-99" });

    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 100 }] },
      user.id
    );
    expect(pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content)).toContain("Ert art.nr: KND-99");
    await salesService.confirm(order.id);
    expect(pdfText((await salesService.getPickListPdf(order.id)).content)).toContain("Ert art.nr: KND-99");

    const { order: otherOrder } = await salesService.createQuote(
      { customerId: other.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 100 }] },
      user.id
    );
    expect(pdfText((await salesService.getSalesOrderPdf(otherOrder.id, "quote")).content)).not.toContain("Ert art.nr");
  });
});
