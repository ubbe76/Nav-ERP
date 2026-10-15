import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { articles, customerPrices, customers, db, priceListRows, priceLists } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { configuratorRoutes } from "../src/modules/oauth/routes/configurator.routes.js";
import type { SalesService } from "../src/modules/sales/service/sales.service.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({
  async sendMail() {
    /* not used by these tests */
  },
}));
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

const TRUNCATE = sql`TRUNCATE customer_prices, price_list_rows, price_lists, customers, article_groups, articles CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

async function makeArticle(opts: { salesPrice?: number } = {}) {
  const article = await articleService.createArticle({
    articleNumber: `ART-PQ-${crypto.randomUUID()}`,
    name: "Test Article",
    type: "purchased",
    unit: "st",
    active: true,
  });
  if (opts.salesPrice !== undefined) {
    await db.update(articles).set({ salesPrice: String(opts.salesPrice) }).where(eq(articles.id, article.id));
    return { ...article, salesPrice: String(opts.salesPrice) };
  }
  return article;
}

async function makePriceList() {
  const [list] = await db
    .insert(priceLists)
    .values({ code: `PL-PQ-${crypto.randomUUID().slice(0, 8)}`, name: `List ${crypto.randomUUID()}` })
    .returning();
  return list!;
}

async function assignPriceList(customerId: string, priceListId: string) {
  await db.update(customers).set({ priceListId }).where(eq(customers.id, customerId));
}

async function addListRow(priceListId: string, articleId: string, fromQuantity: number, unitPrice: number) {
  await db.insert(priceListRows).values({
    priceListId,
    articleId,
    fromQuantity: String(fromQuantity),
    unitPrice: String(unitPrice),
  });
}

async function addCustomerArticlePrice(
  customerId: string,
  articleId: string,
  fromQuantity: number,
  values: { unitPrice?: number; discountPercent?: number }
) {
  await db.insert(customerPrices).values({
    customerId,
    articleId,
    fromQuantity: String(fromQuantity),
    unitPrice: values.unitPrice !== undefined ? String(values.unitPrice) : null,
    discountPercent: values.discountPercent !== undefined ? String(values.discountPercent) : null,
  });
}

describe("getPriceQuote (service)", () => {
  it("returns a price object with source when a rule matches", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });
    await addCustomerArticlePrice(customer.id, article.id, 1, { unitPrice: 42 });

    const result = await salesService.getPriceQuote({ customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result).toEqual({
      articleNumber: article.articleNumber,
      price: { unitPrice: 42, discountPercent: 0, source: "customer_article" },
    });
  });

  it("returns price: null when no level yields a price", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle();

    const result = await salesService.getPriceQuote({ customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result).toEqual({ articleNumber: article.articleNumber, price: null });
  });

  it("returns null for an unknown article", async () => {
    const customer = await makeCustomer();

    const result = await salesService.getPriceQuote({
      customerId: customer.id,
      articleId: crypto.randomUUID(),
      quantity: 1,
    });

    expect(result).toBeNull();
  });

  it("quantity selects the matching break in the chain", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });
    const list = await makePriceList();
    await assignPriceList(customer.id, list.id);
    await addListRow(list.id, article.id, 1, 90);
    await addListRow(list.id, article.id, 10, 80);

    const below = await salesService.getPriceQuote({ customerId: customer.id, articleId: article.id, quantity: 5 });
    expect(below?.price).toEqual({ unitPrice: 90, discountPercent: 0, source: "price_list" });

    const atBreak = await salesService.getPriceQuote({
      customerId: customer.id,
      articleId: article.id,
      quantity: 10,
    });
    expect(atBreak?.price).toEqual({ unitPrice: 80, discountPercent: 0, source: "price_list" });
  });
});

describe("GET /price-quote (route, inject)", () => {
  function buildTestApp(service: Pick<SalesService, "getPriceQuote">) {
    const app = Fastify();
    app.register(configuratorRoutes, { salesService: service as SalesService, articleService });
    return app;
  }

  it("200s with the resolved price shape", async () => {
    const customerId = crypto.randomUUID();
    const articleId = crypto.randomUUID();
    const app = buildTestApp({
      async getPriceQuote(query) {
        expect(query).toEqual({ customerId, articleId, quantity: 3 });
        return { articleNumber: "ART-1", price: { unitPrice: 42, discountPercent: 0, source: "customer_article" } };
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/price-quote?customerId=${customerId}&articleId=${articleId}&quantity=3`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      articleNumber: "ART-1",
      price: { unitPrice: 42, discountPercent: 0, source: "customer_article" },
    });
  });

  it("200s with price: null when nothing matches", async () => {
    const customerId = crypto.randomUUID();
    const articleId = crypto.randomUUID();
    const app = buildTestApp({
      async getPriceQuote() {
        return { articleNumber: "ART-1", price: null };
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/price-quote?customerId=${customerId}&articleId=${articleId}&quantity=1`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ articleNumber: "ART-1", price: null });
  });

  it("404s for an unknown article", async () => {
    const customerId = crypto.randomUUID();
    const articleId = crypto.randomUUID();
    const app = buildTestApp({
      async getPriceQuote() {
        return null;
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/price-quote?customerId=${customerId}&articleId=${articleId}&quantity=1`,
    });

    expect(res.statusCode).toBe(404);
  });
});
