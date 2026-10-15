import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { articleGroups, customerPrices, customers, db, priceListRows, priceLists } from "@navet/db";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { configuratorRoutes as oauthConfiguratorRoutes } from "../src/modules/oauth/routes/configurator.routes.js";
import { makeArticle, makeVariantService, resetConfigurator } from "./helpers/configurator.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Delprojekt 4a, beslut C: a variant without agreements of its own is priced
// through the template's customer chain plus the configuration's additions.

// The configurator reads the template's chain WITHOUT the variant step (the recursion guard, as app.ts binds it)…
const configurator = makeVariantService({ prices: (q) => resolvePrice(db, q) });
// …and the sales chain carries the variant step, as app.ts binds it late.
const chain = (q: { customerId: string; articleId: string; quantity: number }) =>
  resolvePrice(db, q, { variantPrice: (vq) => configurator.variantPrice(vq) });
const registerService = createRegisterService(createRegisterRepository(db));
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
const salesService = createSalesService(
  createSalesRepository(db), registerService, mailService, testDocumentPdfService, createStockService(createStockRepository(db)),
  testArticleService, testSystemService, chain
);

const TRUNCATE = sql`TRUNCATE customer_prices, price_list_rows, price_lists, sales_order_rows, sales_orders, customers, article_groups CASCADE`;
async function reset() {
  await resetConfigurator();
  await db.execute(TRUNCATE);
}
beforeEach(reset);
afterAll(reset);

// Template: base 1000, LOCK A (+0) / B (+50) required, BREDD 500–2000 required (no price). Variant = B, 1200 ⇒ engine price 1050.
async function build() {
  const article = await makeArticle({ salesPrice: 1000 });
  await configurator.createTemplate(article.id, { mode: "variants" });
  const lock = await configurator.createGroup(article.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
  await configurator.createValue(article.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });
  await configurator.createValue(article.id, lock.id, { code: "B", name: "Lås B", priceAdd: 50, active: true });
  const bredd = await configurator.createGroup(article.id, {
    code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", minValue: 500, maxValue: 2000, step: null,
    defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0,
  });
  const { article: variant } = await configurator.resolveVariant(article.id, { LOCK: "B", BREDD: 1200 }, null);
  return { template: article, variant, bredd };
}
const makeCustomer = (discountPercent?: number) =>
  salesService.createCustomer({ name: "Kund AB", active: true, ...(discountPercent !== undefined ? { discountPercent } : {}) });
async function priceList(customerId: string, rows: [articleId: string, fromQuantity: number, unitPrice: number][]) {
  const [list] = await db.insert(priceLists).values({ code: `PL-${crypto.randomUUID().slice(0, 8)}`, name: "Lista" }).returning();
  await db.update(customers).set({ priceListId: list!.id }).where(sql`${customers.id} = ${customerId}`);
  for (const [articleId, fromQuantity, unitPrice] of rows) {
    await db.insert(priceListRows).values({ priceListId: list!.id, articleId, fromQuantity: String(fromQuantity), unitPrice: String(unitPrice) });
  }
}
const articleRule = (customerId: string, articleId: string, unitPrice: number) =>
  db.insert(customerPrices).values({ customerId, articleId, fromQuantity: "1", unitPrice: String(unitPrice), discountPercent: null });
const price = (customerId: string, articleId: string, quantity = 1) => chain({ customerId, articleId, quantity }).then((r) => r?.price);

describe("variant price chain", () => {
  it("customer article price on the variant wins", async () => {
    const { variant, template } = await build();
    const c = await makeCustomer();
    await articleRule(c.id, template.id, 900);
    await articleRule(c.id, variant.id, 700);
    expect(await price(c.id, variant.id)).toEqual({ unitPrice: 700, discountPercent: 0, source: "customer_article" });
  });

  it("price list row for the variant wins", async () => {
    const { variant, template } = await build();
    const c = await makeCustomer();
    await priceList(c.id, [[template.id, 1, 800], [variant.id, 1, 650]]);
    expect(await price(c.id, variant.id)).toEqual({ unitPrice: 650, discountPercent: 0, source: "price_list" });
  });

  it("template customer article price + additions", async () => {
    const { variant, template } = await build();
    const c = await makeCustomer();
    await articleRule(c.id, template.id, 900);
    expect(await price(c.id, variant.id)).toEqual({ unitPrice: 950, discountPercent: 0, source: "customer_article" });
  });

  it("template price list price + additions, and the staffel follows the quantity", async () => {
    const { variant, template } = await build();
    const c = await makeCustomer();
    await priceList(c.id, [[template.id, 1, 800], [template.id, 10, 700]]);
    expect(await price(c.id, variant.id, 1)).toEqual({ unitPrice: 850, discountPercent: 0, source: "price_list" });
    expect(await price(c.id, variant.id, 10)).toEqual({ unitPrice: 750, discountPercent: 0, source: "price_list" });
  });

  it("template customer group rule (discount form) rides on the template's base plus additions", async () => {
    const { variant, template } = await build();
    const [group] = await db.insert(articleGroups).values({ code: "710", name: "Papperskorgar" }).returning();
    await testArticleService.updateArticle(template.id, { groupId: group!.id } as never);
    const c = await makeCustomer();
    await db.insert(customerPrices).values({ customerId: c.id, articleGroupId: group!.id, fromQuantity: "1", unitPrice: null, discountPercent: "10" });
    expect(await price(c.id, variant.id)).toEqual({ unitPrice: 1050, discountPercent: 10, source: "customer_group" });
  });

  it("customer discount applies on the template's base plus additions", async () => {
    const { variant } = await build();
    const c = await makeCustomer(5);
    expect(await price(c.id, variant.id)).toEqual({ unitPrice: 1050, discountPercent: 5, source: "customer_discount" });
  });

  it("two customers with different template agreements get different variant prices", async () => {
    const { variant, template } = await build();
    const c1 = await makeCustomer();
    const c2 = await makeCustomer();
    await articleRule(c1.id, template.id, 900);
    await articleRule(c2.id, template.id, 800);
    expect((await price(c1.id, variant.id))!.unitPrice).toBe(950);
    expect((await price(c2.id, variant.id))!.unitPrice).toBe(850);
  });

  it("a stored selection that no longer validates ⇒ the variant's own price", async () => {
    const { variant, template, bredd } = await build();
    const c = await makeCustomer();
    await articleRule(c.id, template.id, 900);
    await configurator.updateGroup(template.id, bredd.id, { minValue: 1300 }); // 1200 is now out of range
    expect(await price(c.id, variant.id)).toEqual({ unitPrice: 1050, discountPercent: 0, source: "article" });
  });

  it("a plain article is unchanged; the template itself is not a variant (recursion guard)", async () => {
    const { template } = await build();
    const c = await makeCustomer();
    const plain = await makeArticle({ salesPrice: 1000 });
    expect(await price(c.id, plain.id)).toEqual({ unitPrice: 1000, discountPercent: 0, source: "article" });
    expect(await configurator.variantPrice({ customerId: c.id, variantArticleId: template.id, quantity: 1 })).toBeUndefined();
    expect(await configurator.variantPrice({ customerId: c.id, variantArticleId: plain.id, quantity: 1 })).toBeUndefined();
  });

  it("GET /price-quote, createQuote without a price and updateRow across a break all use the same chain", async () => {
    const { variant, template } = await build();
    const c = await makeCustomer();
    await priceList(c.id, [[template.id, 1, 800], [template.id, 10, 700]]);

    const app = Fastify();
    app.register(oauthConfiguratorRoutes, { salesService, articleService: testArticleService, configuratorService: configurator });
    const quote = await app.inject({ method: "GET", url: `/price-quote?customerId=${c.id}&articleId=${variant.id}&quantity=1` });
    expect(quote.json().price).toEqual({ unitPrice: 850, discountPercent: 0, source: "price_list" });
    await app.close();

    const { order } = await salesService.createQuote({ customerId: c.id, rows: [{ articleId: variant.id, quantity: 1 }] } as never, null);
    const [row] = await salesService.listRows(order.id);
    expect(Number(row!.unitPrice)).toBe(850);
    await salesService.updateRow(order.id, row!.id, { quantity: 10 } as never, null);
    const [updated] = await salesService.listRows(order.id);
    expect(Number(updated!.unitPrice)).toBe(750);
  });
});
