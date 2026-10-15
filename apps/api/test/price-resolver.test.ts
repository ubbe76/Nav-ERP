import { afterAll, beforeEach, describe, expect, it } from "vitest";
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

const TRUNCATE = sql`TRUNCATE customer_prices, price_list_rows, price_lists, customers, articles, article_groups CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeCustomer(discountPercent?: number) {
  return salesService.createCustomer({
    name: "Kund AB",
    active: true,
    ...(discountPercent !== undefined ? { discountPercent } : {}),
  });
}

// salesPrice is not yet wired into the article repository's create()/update()
// (that lands in a later C3 task per task-2-report.md) — tests set it with a
// direct DB update instead of going through the service.
async function makeArticle(opts: { salesPrice?: number; groupId?: string } = {}) {
  const article = await articleService.createArticle({
    articleNumber: `ART-PR-${crypto.randomUUID()}`,
    name: "Test Article",
    type: "purchased",
    unit: "st",
    active: true,
    ...(opts.groupId !== undefined ? { groupId: opts.groupId } : {}),
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
    .values({ code: `PL-${crypto.randomUUID().slice(0, 8)}`, name: `List ${crypto.randomUUID()}` })
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

async function addCustomerGroupPrice(
  customerId: string,
  articleGroupId: string,
  fromQuantity: number,
  values: { unitPrice?: number; discountPercent?: number }
) {
  await db.insert(customerPrices).values({
    customerId,
    articleGroupId,
    fromQuantity: String(fromQuantity),
    unitPrice: values.unitPrice !== undefined ? String(values.unitPrice) : null,
    discountPercent: values.discountPercent !== undefined ? String(values.discountPercent) : null,
  });
}

describe("resolvePrice", () => {
  // Konfigurator 4a: the optional variant step. A plain article is never a
  // variant — the reader answers undefined and the chain goes on unchanged.
  it("a plain article: the variant reader answers undefined and the chain is unchanged with or without opts", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });
    let calls = 0;
    const res = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 }, { variantPrice: async () => { calls++; return undefined; } });
    expect(res?.price).toEqual({ unitPrice: 100, discountPercent: 0, source: "article" });
    expect(calls).toBe(1); // called, answered "not a variant", chain continued
    const plain = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });
    expect(plain).toEqual(res);
  });

  it("falls through to the article's base price when nothing else matches", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result).toEqual({
      articleNumber: article.articleNumber,
      price: { unitPrice: 100, discountPercent: 0, source: "article" },
    });
  });

  it("returns price: null when no level yields a price", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle();

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result).toEqual({ articleNumber: article.articleNumber, price: null });
  });

  it("returns null for an unknown article", async () => {
    const customer = await makeCustomer();

    const result = await resolvePrice(db, {
      customerId: customer.id,
      articleId: crypto.randomUUID(),
      quantity: 1,
    });

    expect(result).toBeNull();
  });

  it("price list beats base price, highest break <= quantity wins", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });
    const list = await makePriceList();
    await assignPriceList(customer.id, list.id);
    await addListRow(list.id, article.id, 1, 90);
    await addListRow(list.id, article.id, 10, 80);

    const below = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 9 });
    expect(below?.price).toEqual({ unitPrice: 90, discountPercent: 0, source: "price_list" });

    const atBreak = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 10 });
    expect(atBreak?.price).toEqual({ unitPrice: 80, discountPercent: 0, source: "price_list" });

    const above = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 100 });
    expect(above?.price).toEqual({ unitPrice: 80, discountPercent: 0, source: "price_list" });
  });

  it("customer article price beats everything", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });
    const list = await makePriceList();
    await assignPriceList(customer.id, list.id);
    await addListRow(list.id, article.id, 1, 80);
    await addCustomerArticlePrice(customer.id, article.id, 1, { unitPrice: 50 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result?.price).toEqual({ unitPrice: 50, discountPercent: 0, source: "customer_article" });
  });

  it("customer group discount applies on the list price", async () => {
    const customer = await makeCustomer();
    const group = await articleService.createArticleGroup({ code: "310", name: "Grupp A" });
    const article = await makeArticle({ salesPrice: 100, groupId: group.id });
    const list = await makePriceList();
    await assignPriceList(customer.id, list.id);
    await addListRow(list.id, article.id, 1, 80);
    await addCustomerGroupPrice(customer.id, group.id, 1, { discountPercent: 10 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result?.price).toEqual({ unitPrice: 80, discountPercent: 10, source: "customer_group" });
  });

  it("customer discount applies on the base price when no list", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });
    await addCustomerArticlePrice(customer.id, article.id, 1, { discountPercent: 20 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result?.price).toEqual({ unitPrice: 100, discountPercent: 20, source: "customer_article" });
  });

  it("customer article rule beats group rule", async () => {
    const customer = await makeCustomer();
    const group = await articleService.createArticleGroup({ code: "311", name: "Grupp B" });
    const article = await makeArticle({ salesPrice: 100, groupId: group.id });
    await addCustomerGroupPrice(customer.id, group.id, 1, { discountPercent: 10 });
    await addCustomerArticlePrice(customer.id, article.id, 1, { unitPrice: 42 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result?.price).toEqual({ unitPrice: 42, discountPercent: 0, source: "customer_article" });
  });

  it("a discount rule with no underlying price yields price: null", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle(); // no salesPrice, no list
    await addCustomerArticlePrice(customer.id, article.id, 1, { discountPercent: 15 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result).toEqual({ articleNumber: article.articleNumber, price: null });
  });

  it("customer price breaks are quantity-tiered too", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle({ salesPrice: 100 });
    await addCustomerArticlePrice(customer.id, article.id, 1, { unitPrice: 95 });
    await addCustomerArticlePrice(customer.id, article.id, 50, { unitPrice: 85 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 50 });

    expect(result?.price).toEqual({ unitPrice: 85, discountPercent: 0, source: "customer_article" });
  });
});

// Kundrabatt (customers.discount_percent) — the price chain's last fallback,
// below every customer-specific rule but above the bare base/list price.
describe("resolvePrice — customer blanket discount (customer_discount)", () => {
  it("applies the customer's discount on the article's base price when nothing else matches", async () => {
    const customer = await makeCustomer(15);
    const article = await makeArticle({ salesPrice: 100 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result?.price).toEqual({ unitPrice: 100, discountPercent: 15, source: "customer_discount" });
  });

  it("applies the customer's discount on the price list price when a list is assigned", async () => {
    const customer = await makeCustomer(15);
    const article = await makeArticle({ salesPrice: 100 });
    const list = await makePriceList();
    await assignPriceList(customer.id, list.id);
    await addListRow(list.id, article.id, 1, 80);

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result?.price).toEqual({ unitPrice: 80, discountPercent: 15, source: "customer_discount" });
  });

  it("is beaten by a matching customer article rule — the rule's own discount wins, not the blanket one", async () => {
    const customer = await makeCustomer(15);
    const article = await makeArticle({ salesPrice: 100 });
    await addCustomerArticlePrice(customer.id, article.id, 1, { unitPrice: 50 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result?.price).toEqual({ unitPrice: 50, discountPercent: 0, source: "customer_article" });
  });

  it("is beaten by a matching customer group rule", async () => {
    const customer = await makeCustomer(15);
    const group = await articleService.createArticleGroup({ code: "312", name: "Grupp C" });
    const article = await makeArticle({ salesPrice: 100, groupId: group.id });
    await addCustomerGroupPrice(customer.id, group.id, 1, { discountPercent: 10 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    // The group rule's own 10 % wins, not the customer's blanket 15 %.
    expect(result?.price).toEqual({ unitPrice: 100, discountPercent: 10, source: "customer_group" });
  });

  it("discountPercent = 0 (the default) leaves the base/list source unchanged", async () => {
    const customer = await makeCustomer(0);
    const article = await makeArticle({ salesPrice: 100 });

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result?.price).toEqual({ unitPrice: 100, discountPercent: 0, source: "article" });
  });

  it("never conjures a price: a customer discount with no base/list price still yields null", async () => {
    const customer = await makeCustomer(15);
    const article = await makeArticle(); // no salesPrice, no list

    const result = await resolvePrice(db, { customerId: customer.id, articleId: article.id, quantity: 1 });

    expect(result).toEqual({ articleNumber: article.articleNumber, price: null });
  });
});
