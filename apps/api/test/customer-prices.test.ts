import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { customerPriceInputSchema } from "@navet/shared";
import { CustomerNotFoundError } from "../src/modules/sales/service/sales.service.js";
import {
  CustomerPriceNotFoundError,
  DuplicateCustomerPriceError,
  PriceListNotFoundError,
} from "../src/modules/sales/service/sales.errors.js";
import { ArticleGroupNotFoundError, ArticleNotFoundError } from "../src/modules/article/service/article.service.js";

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

async function makeArticle(numberSuffix: string, groupId?: string) {
  return articleService.createArticle({
    articleNumber: `ART-CP-${numberSuffix}`,
    name: `Test Article ${numberSuffix}`,
    type: "purchased",
    unit: "st",
    active: true,
    groupId,
  });
}

async function makeArticleGroup(code: string, name: string) {
  return articleService.createArticleGroup({ code, name });
}

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

describe("customer prices (subresource CRUD)", () => {
  describe("zod: customerPriceInputSchema", () => {
    it("fails when both articleId and articleGroupId are set", () => {
      const result = customerPriceInputSchema.safeParse({
        articleId: crypto.randomUUID(),
        articleGroupId: crypto.randomUUID(),
        unitPrice: 10,
      });
      expect(result.success).toBe(false);
    });

    it("fails when neither articleId nor articleGroupId is set", () => {
      const result = customerPriceInputSchema.safeParse({ unitPrice: 10 });
      expect(result.success).toBe(false);
    });

    it("fails when both unitPrice and discountPercent are set", () => {
      const result = customerPriceInputSchema.safeParse({
        articleId: crypto.randomUUID(),
        unitPrice: 10,
        discountPercent: 5,
      });
      expect(result.success).toBe(false);
    });

    it("fails when neither unitPrice nor discountPercent is set", () => {
      const result = customerPriceInputSchema.safeParse({ articleId: crypto.randomUUID() });
      expect(result.success).toBe(false);
    });

    it("passes with exactly one target and exactly one value", () => {
      const result = customerPriceInputSchema.safeParse({ articleId: crypto.randomUUID(), unitPrice: 10 });
      expect(result.success).toBe(true);
    });
  });

  describe("addCustomerPrice / listCustomerPrices", () => {
    it("adds an article price rule and lists it joined to article number/name", async () => {
      const customer = await makeCustomer();
      const article = await makeArticle("A1");
      const rule = await salesService.addCustomerPrice(customer.id, {
        articleId: article.id,
        fromQuantity: 1,
        unitPrice: 42,
      });
      expect(rule).toMatchObject({ articleId: article.id, unitPrice: "42.0000" });

      const rows = await salesService.listCustomerPrices(customer.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        articleId: article.id,
        articleNumber: "ART-CP-A1",
        articleName: "Test Article A1",
        articleGroupId: null,
        articleGroupName: null,
        unitPrice: "42.0000",
        discountPercent: null,
      });
    });

    it("adds a group discount rule and lists it joined to group name", async () => {
      const customer = await makeCustomer();
      const group = await makeArticleGroup("101", "Skruv");
      const rule = await salesService.addCustomerPrice(customer.id, {
        articleGroupId: group.id,
        fromQuantity: 1,
        discountPercent: 15,
      });
      expect(rule).toMatchObject({ articleGroupId: group.id, discountPercent: "15.00" });

      const rows = await salesService.listCustomerPrices(customer.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        articleId: null,
        articleNumber: null,
        articleGroupId: group.id,
        articleGroupName: "Skruv",
        unitPrice: null,
        discountPercent: "15.00",
      });
    });

    it("sorts article rules before group rules, then by number/name + fromQuantity", async () => {
      const customer = await makeCustomer();
      const articleB = await makeArticle("B1");
      const articleA = await makeArticle("A1");
      const group = await makeArticleGroup("102", "Muttrar");

      // Inserted out of order to prove the query sorts, not insertion order.
      await salesService.addCustomerPrice(customer.id, { articleGroupId: group.id, fromQuantity: 1, discountPercent: 10 });
      await salesService.addCustomerPrice(customer.id, { articleId: articleB.id, fromQuantity: 1, unitPrice: 10 });
      await salesService.addCustomerPrice(customer.id, { articleId: articleA.id, fromQuantity: 10, unitPrice: 8 });
      await salesService.addCustomerPrice(customer.id, { articleId: articleA.id, fromQuantity: 1, unitPrice: 9 });

      const rows = await salesService.listCustomerPrices(customer.id);
      expect(
        rows.map((r) => ({
          articleNumber: r.articleNumber,
          articleGroupName: r.articleGroupName,
          fromQuantity: Number(r.fromQuantity),
        }))
      ).toEqual([
        { articleNumber: "ART-CP-A1", articleGroupName: null, fromQuantity: 1 },
        { articleNumber: "ART-CP-A1", articleGroupName: null, fromQuantity: 10 },
        { articleNumber: "ART-CP-B1", articleGroupName: null, fromQuantity: 1 },
        { articleNumber: null, articleGroupName: "Muttrar", fromQuantity: 1 },
      ]);
    });

    it("rejects a duplicate (customer, article, fromQuantity) with DuplicateCustomerPriceError (409)", async () => {
      const customer = await makeCustomer();
      const article = await makeArticle("DUP1");
      await salesService.addCustomerPrice(customer.id, { articleId: article.id, fromQuantity: 1, unitPrice: 10 });
      await expect(
        salesService.addCustomerPrice(customer.id, { articleId: article.id, fromQuantity: 1, unitPrice: 20 })
      ).rejects.toThrow(DuplicateCustomerPriceError);
    });

    it("rejects a duplicate (customer, group, fromQuantity) with DuplicateCustomerPriceError (409)", async () => {
      const customer = await makeCustomer();
      const group = await makeArticleGroup("103", "Dup grupp");
      await salesService.addCustomerPrice(customer.id, { articleGroupId: group.id, fromQuantity: 1, discountPercent: 5 });
      await expect(
        salesService.addCustomerPrice(customer.id, { articleGroupId: group.id, fromQuantity: 1, discountPercent: 8 })
      ).rejects.toThrow(DuplicateCustomerPriceError);
    });

    it("allows the same article at different fromQuantity breaks", async () => {
      const customer = await makeCustomer();
      const article = await makeArticle("BRK1");
      await salesService.addCustomerPrice(customer.id, { articleId: article.id, fromQuantity: 1, unitPrice: 10 });
      await salesService.addCustomerPrice(customer.id, { articleId: article.id, fromQuantity: 10, unitPrice: 8 });
      const rows = await salesService.listCustomerPrices(customer.id);
      expect(rows).toHaveLength(2);
    });

    it("throws CustomerNotFoundError when adding a price to an unknown customer", async () => {
      const article = await makeArticle("ORPH1");
      await expect(
        salesService.addCustomerPrice(crypto.randomUUID(), { articleId: article.id, fromQuantity: 1, unitPrice: 10 })
      ).rejects.toThrow(CustomerNotFoundError);
    });

    it("throws CustomerNotFoundError when listing prices for an unknown customer", async () => {
      await expect(salesService.listCustomerPrices(crypto.randomUUID())).rejects.toThrow(CustomerNotFoundError);
    });

    // C3 slutgranskning fynd 2: an unknown articleId/articleGroupId used to
    // fall straight through to the insert and surface as a raw FK violation
    // (23503 → 500).
    it("throws ArticleNotFoundError (not a raw 500) for an unknown articleId", async () => {
      const customer = await makeCustomer();
      await expect(
        salesService.addCustomerPrice(customer.id, { articleId: crypto.randomUUID(), fromQuantity: 1, unitPrice: 10 })
      ).rejects.toThrow(ArticleNotFoundError);
    });

    it("throws ArticleGroupNotFoundError (not a raw 500) for an unknown articleGroupId", async () => {
      const customer = await makeCustomer();
      await expect(
        salesService.addCustomerPrice(customer.id, {
          articleGroupId: crypto.randomUUID(),
          fromQuantity: 1,
          discountPercent: 10,
        })
      ).rejects.toThrow(ArticleGroupNotFoundError);
    });
  });

  describe("updateCustomerPrice", () => {
    it("edits fromQuantity and unitPrice", async () => {
      const customer = await makeCustomer();
      const article = await makeArticle("EDIT1");
      const rule = await salesService.addCustomerPrice(customer.id, {
        articleId: article.id,
        fromQuantity: 1,
        unitPrice: 100,
      });
      const updated = await salesService.updateCustomerPrice(customer.id, rule.id, { unitPrice: 75, fromQuantity: 5 });
      expect(updated).toMatchObject({ unitPrice: "75.0000", fromQuantity: "5.0000" });
    });

    it("switches a rule from price to discount, clearing the other field", async () => {
      const customer = await makeCustomer();
      const article = await makeArticle("SWITCH1");
      const rule = await salesService.addCustomerPrice(customer.id, {
        articleId: article.id,
        fromQuantity: 1,
        unitPrice: 100,
      });
      const updated = await salesService.updateCustomerPrice(customer.id, rule.id, { discountPercent: 20 });
      expect(updated).toMatchObject({ unitPrice: null, discountPercent: "20.00" });
    });

    it("throws CustomerPriceNotFoundError for an unknown id", async () => {
      const customer = await makeCustomer();
      await expect(
        salesService.updateCustomerPrice(customer.id, crypto.randomUUID(), { unitPrice: 1 })
      ).rejects.toThrow(CustomerPriceNotFoundError);
    });

    it("does not update a rule belonging to another customer (IDOR guard)", async () => {
      const owner = await makeCustomer();
      const stranger = await makeCustomer();
      const article = await makeArticle("IDOR1");
      const rule = await salesService.addCustomerPrice(owner.id, { articleId: article.id, fromQuantity: 1, unitPrice: 10 });
      await expect(
        salesService.updateCustomerPrice(stranger.id, rule.id, { unitPrice: 999 })
      ).rejects.toThrow(CustomerPriceNotFoundError);
    });
  });

  describe("deleteCustomerPrice", () => {
    it("deletes a rule", async () => {
      const customer = await makeCustomer();
      const article = await makeArticle("DEL1");
      const rule = await salesService.addCustomerPrice(customer.id, { articleId: article.id, fromQuantity: 1, unitPrice: 10 });
      await salesService.deleteCustomerPrice(customer.id, rule.id);
      const rows = await salesService.listCustomerPrices(customer.id);
      expect(rows).toHaveLength(0);
    });

    it("throws CustomerPriceNotFoundError for an unknown id", async () => {
      const customer = await makeCustomer();
      await expect(salesService.deleteCustomerPrice(customer.id, crypto.randomUUID())).rejects.toThrow(
        CustomerPriceNotFoundError
      );
    });

    it("does not delete a rule belonging to another customer (IDOR guard)", async () => {
      const owner = await makeCustomer();
      const stranger = await makeCustomer();
      const article = await makeArticle("IDOR2");
      const rule = await salesService.addCustomerPrice(owner.id, { articleId: article.id, fromQuantity: 1, unitPrice: 10 });
      await expect(salesService.deleteCustomerPrice(stranger.id, rule.id)).rejects.toThrow(CustomerPriceNotFoundError);
      const rows = await salesService.listCustomerPrices(owner.id);
      expect(rows).toHaveLength(1);
    });
  });
});

describe("customer priceListId assignment (PATCH /customers)", () => {
  it("assigns a price list to a customer and clears it with null", async () => {
    const list = await salesService.createPriceList({ code: "PL-CUST", name: "Kundlista" });
    const customer = await makeCustomer();

    const assigned = await salesService.updateCustomer(customer.id, { priceListId: list.id });
    expect(assigned.priceListId).toBe(list.id);

    const cleared = await salesService.updateCustomer(customer.id, { priceListId: null });
    expect(cleared.priceListId).toBeNull();
  });

  it("throws PriceListNotFoundError when assigning an unknown price list id", async () => {
    const customer = await makeCustomer();
    await expect(salesService.updateCustomer(customer.id, { priceListId: crypto.randomUUID() })).rejects.toThrow(
      PriceListNotFoundError
    );
  });
});
