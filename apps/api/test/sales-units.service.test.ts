import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, units } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService, InvalidUnitError } from "../src/modules/article/service/article.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
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

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const fakeTransportFactory: MailTransportFactory = () => ({ async sendMail() {} });
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

const TABLES = sql`TRUNCATE email_log, sales_order_rows, sales_orders, customer_delivery_addresses, customers, stock_transactions, stock_locations, warehouses, article_units, articles, units, users CASCADE`;

let kgId: string;

beforeEach(async () => {
  await db.execute(TABLES);
  const [kg] = await db.insert(units).values({ code: "kg", name: "Kilogram" }).returning();
  kgId = kg!.id;
});

afterAll(async () => {
  await db.execute(TABLES);
});

// Article stocked in st, weighing 5 kg apiece (1 st = 5 kg → factor 5).
async function makeKgArticle(articleNumber: string) {
  const article = await articleService.createArticle({
    articleNumber,
    name: articleNumber,
    type: "manufactured",
    isPhantom: false,
    active: true,
  });
  await articleService.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 5 });
  return article;
}

describe("sales — order rows in alternative units", () => {
  it("converts quote rows to the base unit and snapshots the factor", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeKgArticle("SA-1");

    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 500, unitPrice: 12, unitId: kgId }], confirm: false },
      null
    );

    const [row] = await salesService.listRows(order.id);
    expect(row?.quantityOrdered).toBe("100.0000");
    expect(row?.unitPrice).toBe("60.0000");
    expect(row?.unitId).toBe(kgId);
    expect(Number(row?.unitFactor)).toBe(5);
    expect(row?.unitCode).toBe("kg");
  });

  it("interprets a row PATCH in the row's unit and can switch back to the base unit", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeKgArticle("SA-2");
    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 500, unitPrice: 12, unitId: kgId }], confirm: false },
      null
    );
    const [row] = await salesService.listRows(order.id);

    await salesService.updateRow(order.id, row!.id, { quantity: 250, unitPrice: 10 });
    let [updated] = await salesService.listRows(order.id);
    expect(updated?.quantityOrdered).toBe("50.0000");
    expect(updated?.unitPrice).toBe("50.0000");

    await salesService.updateRow(order.id, row!.id, { quantity: 10, unitPrice: 55, unitId: null });
    [updated] = await salesService.listRows(order.id);
    expect(updated?.quantityOrdered).toBe("10.0000");
    expect(updated?.unitPrice).toBe("55.0000");
    expect(updated?.unitCode).toBe("st");
  });

  it("rejects a unit the article does not have", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await articleService.createArticle({
      articleNumber: "SA-3",
      name: "SA-3",
      type: "manufactured",
      isPhantom: false,
      active: true,
    });
    await expect(
      salesService.createQuote(
        { customerId: customer.id, rows: [{ articleId: article.id, quantity: 1, unitPrice: 1, unitId: kgId }], confirm: false },
        null
      )
    ).rejects.toThrow(InvalidUnitError);
  });

  it("delivers in the base unit and completes the order as before", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeKgArticle("SA-4");
    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 500, unitPrice: 12, unitId: kgId }], confirm: true },
      null
    );
    const [row] = await salesService.listRows(order.id);

    await salesService.startProduction(order.id);
    const result = await salesService.deliverGoods(order.id, row!.id, { quantity: 100 }, null);
    expect(result.orderStatus).toBe("delivered");

    const balances = await stockService.balancesForArticles([article.id]);
    expect(Number(balances[0]?.quantityOnHand)).toBe(-100);
  });
});
