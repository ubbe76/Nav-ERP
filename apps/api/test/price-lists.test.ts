import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { customers, db, type Db } from "@navet/db";
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
import {
  DuplicatePriceListError,
  DuplicatePriceListRowError,
  PriceListInUseError,
  PriceListNotFoundError,
  PriceListRowNotFoundError,
} from "../src/modules/sales/service/sales.errors.js";
import { ArticleNotFoundError } from "../src/modules/article/service/article.service.js";

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

const TRUNCATE = sql`TRUNCATE price_list_rows, price_lists, customers, articles CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

// A fixed, caller-chosen suffix (rather than price-resolver.test.ts's random
// UUID) so tests that assert row ORDER by articleNumber stay deterministic.
async function makeArticle(numberSuffix: string) {
  return articleService.createArticle({
    articleNumber: `ART-PL-${numberSuffix}`,
    name: `Test Article ${numberSuffix}`,
    type: "purchased",
    unit: "st",
    active: true,
  });
}

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

describe("price lists (register CRUD)", () => {
  describe("createPriceList / listPriceLists", () => {
    it("creates a price list and lists it with rowCount 0", async () => {
      const list = await salesService.createPriceList({ code: "PL-1", name: "Standardlista" });
      expect(list).toMatchObject({ code: "PL-1", name: "Standardlista", description: null });

      const { rows, total } = await salesService.listPriceLists({ limit: 50, offset: 0 });
      expect(total).toBe(1);
      expect(rows[0]).toMatchObject({ code: "PL-1", name: "Standardlista", rowCount: 0 });
    });

    it("supports search (code or name) and pagination", async () => {
      await salesService.createPriceList({ code: "PL-A", name: "Alfa" });
      await salesService.createPriceList({ code: "PL-B", name: "Beta" });
      await salesService.createPriceList({ code: "PL-C", name: "Gamma" });

      const byCode = await salesService.listPriceLists({ search: "PL-B", limit: 50, offset: 0 });
      expect(byCode.total).toBe(1);
      expect(byCode.rows[0]?.name).toBe("Beta");

      const byName = await salesService.listPriceLists({ search: "gamma", limit: 50, offset: 0 });
      expect(byName.total).toBe(1);
      expect(byName.rows[0]?.code).toBe("PL-C");

      const page1 = await salesService.listPriceLists({ limit: 2, offset: 0 });
      expect(page1.rows).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = await salesService.listPriceLists({ limit: 2, offset: 2 });
      expect(page2.rows).toHaveLength(1);
      expect(page2.total).toBe(3);
    });

    it("rejects a duplicate code with DuplicatePriceListError (409)", async () => {
      await salesService.createPriceList({ code: "PL-DUP", name: "First" });
      await expect(salesService.createPriceList({ code: "PL-DUP", name: "Second" })).rejects.toThrow(
        DuplicatePriceListError
      );
    });

    it("rejects a duplicate name with DuplicatePriceListError (409)", async () => {
      await salesService.createPriceList({ code: "PL-X", name: "Samma namn" });
      await expect(salesService.createPriceList({ code: "PL-Y", name: "Samma namn" })).rejects.toThrow(
        DuplicatePriceListError
      );
    });
  });

  describe("updatePriceList", () => {
    it("updates code/name/description", async () => {
      const list = await salesService.createPriceList({ code: "PL-E", name: "Original" });
      const updated = await salesService.updatePriceList(list.id, { name: "Nytt namn", description: "En text" });
      expect(updated).toMatchObject({ code: "PL-E", name: "Nytt namn", description: "En text" });
    });

    it("throws PriceListNotFoundError for an unknown id", async () => {
      await expect(salesService.updatePriceList(crypto.randomUUID(), { name: "X" })).rejects.toThrow(
        PriceListNotFoundError
      );
    });

    // description is nullable on the update schema (unlike create) so PATCH
    // can clear it back to NULL rather than only ever being able to store "".
    it("clears description back to null", async () => {
      const list = await salesService.createPriceList({ code: "PL-CLEAR", name: "Clear", description: "En text" });
      expect(list.description).toBe("En text");

      const cleared = await salesService.updatePriceList(list.id, { description: null });
      expect(cleared.description).toBeNull();
    });

    it("rejects renaming into another list's code with DuplicatePriceListError", async () => {
      await salesService.createPriceList({ code: "PL-TAKEN", name: "Taken" });
      const other = await salesService.createPriceList({ code: "PL-FREE", name: "Free" });
      await expect(salesService.updatePriceList(other.id, { code: "PL-TAKEN" })).rejects.toThrow(
        DuplicatePriceListError
      );
    });
  });

  describe("getPriceList", () => {
    it("returns the list with rows joined to article number/name, sorted by article then fromQuantity", async () => {
      const list = await salesService.createPriceList({ code: "PL-ROWS", name: "Med rader" });
      const articleA = await makeArticle("A1");
      const articleB = await makeArticle("B1");
      // Inserted out of order to prove the query sorts, not insertion order.
      await salesService.addPriceListRow(list.id, { articleId: articleB.id, fromQuantity: 1, unitPrice: 50 });
      await salesService.addPriceListRow(list.id, { articleId: articleA.id, fromQuantity: 10, unitPrice: 80 });
      await salesService.addPriceListRow(list.id, { articleId: articleA.id, fromQuantity: 1, unitPrice: 90 });

      const found = await salesService.getPriceList(list.id);
      expect(found.rows.map((r) => ({ articleNumber: r.articleNumber, fromQuantity: Number(r.fromQuantity) }))).toEqual([
        { articleNumber: "ART-PL-A1", fromQuantity: 1 },
        { articleNumber: "ART-PL-A1", fromQuantity: 10 },
        { articleNumber: "ART-PL-B1", fromQuantity: 1 },
      ]);
      expect(found.rows[0]).toMatchObject({ articleName: "Test Article A1", unitPrice: "90.0000" });
    });

    it("throws PriceListNotFoundError for an unknown id", async () => {
      await expect(salesService.getPriceList(crypto.randomUUID())).rejects.toThrow(PriceListNotFoundError);
    });
  });

  describe("price list rows", () => {
    it("rejects a duplicate (list, article, fromQuantity) with DuplicatePriceListRowError (409)", async () => {
      const list = await salesService.createPriceList({ code: "PL-DUPROW", name: "Duprow" });
      const article = await makeArticle("DUP1");
      await salesService.addPriceListRow(list.id, { articleId: article.id, fromQuantity: 1, unitPrice: 100 });
      await expect(
        salesService.addPriceListRow(list.id, { articleId: article.id, fromQuantity: 1, unitPrice: 90 })
      ).rejects.toThrow(DuplicatePriceListRowError);
    });

    it("throws PriceListNotFoundError when adding a row to an unknown list", async () => {
      const article = await makeArticle("ORPH1");
      await expect(
        salesService.addPriceListRow(crypto.randomUUID(), { articleId: article.id, fromQuantity: 1, unitPrice: 10 })
      ).rejects.toThrow(PriceListNotFoundError);
    });

    // C3 slutgranskning fynd 2: an unknown articleId used to fall straight
    // through to the insert and surface as a raw FK violation (23503 → 500).
    it("throws ArticleNotFoundError (not a raw 500) for an unknown articleId", async () => {
      const list = await salesService.createPriceList({ code: "PL-NOARTICLE", name: "No article" });
      await expect(
        salesService.addPriceListRow(list.id, { articleId: crypto.randomUUID(), fromQuantity: 1, unitPrice: 10 })
      ).rejects.toThrow(ArticleNotFoundError);
    });

    it("edits a row's price and from-quantity (radredigering)", async () => {
      const list = await salesService.createPriceList({ code: "PL-EDIT", name: "Edit" });
      const article = await makeArticle("EDIT1");
      const row = await salesService.addPriceListRow(list.id, { articleId: article.id, fromQuantity: 1, unitPrice: 100 });

      const updated = await salesService.updatePriceListRow(list.id, row.id, { unitPrice: 75, fromQuantity: 5 });
      expect(updated).toMatchObject({ unitPrice: "75.0000", fromQuantity: "5.0000" });
    });

    it("throws PriceListRowNotFoundError when editing an unknown row", async () => {
      const list = await salesService.createPriceList({ code: "PL-NOROW", name: "Norow" });
      await expect(
        salesService.updatePriceListRow(list.id, crypto.randomUUID(), { unitPrice: 1 })
      ).rejects.toThrow(PriceListRowNotFoundError);
    });

    it("deletes a row", async () => {
      const list = await salesService.createPriceList({ code: "PL-DELROW", name: "Delrow" });
      const article = await makeArticle("DEL1");
      const row = await salesService.addPriceListRow(list.id, { articleId: article.id, fromQuantity: 1, unitPrice: 10 });

      await salesService.deletePriceListRow(list.id, row.id);

      const found = await salesService.getPriceList(list.id);
      expect(found.rows).toHaveLength(0);
    });

    it("throws PriceListRowNotFoundError when deleting an unknown row", async () => {
      const list = await salesService.createPriceList({ code: "PL-NODEL", name: "Nodel" });
      await expect(salesService.deletePriceListRow(list.id, crypto.randomUUID())).rejects.toThrow(
        PriceListRowNotFoundError
      );
    });
  });

  describe("deletePriceList", () => {
    it("deletes an empty price list", async () => {
      const list = await salesService.createPriceList({ code: "PL-EMPTY", name: "Empty" });
      await salesService.deletePriceList(list.id);
      await expect(salesService.getPriceList(list.id)).rejects.toThrow(PriceListNotFoundError);
    });

    it("throws PriceListInUseError when a customer is assigned to it", async () => {
      const list = await salesService.createPriceList({ code: "PL-INUSE", name: "In use" });
      const customer = await makeCustomer();
      // customers.priceListId is not yet wired into createCustomerSchema (a
      // later C3 task) — same direct-DB-update workaround as
      // price-resolver.test.ts's assignPriceList.
      await db.update(customers).set({ priceListId: list.id }).where(eq(customers.id, customer.id));

      await expect(salesService.deletePriceList(list.id)).rejects.toThrow(PriceListInUseError);
    });

    it("throws PriceListNotFoundError for an unknown id", async () => {
      await expect(salesService.deletePriceList(crypto.randomUUID())).rejects.toThrow(PriceListNotFoundError);
    });

    // FK-race fix: the pre-check above only catches a customer that was
    // ALREADY assigned when the SELECT ran — a customer assigned in the
    // window between that SELECT and the DELETE used to hit the raw
    // customers_price_list_id_price_lists_id_fk violation as an unhandled
    // 500. Reproducing the actual race deterministically would need real
    // transaction interleaving, so this stubs `db` to force exactly that
    // ordering: the pre-check's SELECT finds no customer, but the DELETE
    // still throws the FK violation — proving the repository's try/catch
    // (not just the pre-check) maps it to PriceListInUseError.
    it("catches a FK violation on delete (pre-check-passed race) as PriceListInUseError", async () => {
      const listRow = { id: crypto.randomUUID(), code: "PL-RACE", name: "Race", description: null };
      const fkError = Object.assign(
        new Error('update or delete on table "price_lists" violates foreign key constraint'),
        { code: "23503", constraint_name: "customers_price_list_id_price_lists_id_fk" }
      );
      let selectCalls = 0;
      const stubDb = {
        select: () => ({
          from: () => ({
            where: () => {
              selectCalls++;
              // 1st call: the list-exists lookup. 2nd call: the in-use
              // pre-check — returns empty, as if no customer pointed at the
              // list yet when it ran.
              return selectCalls === 1 ? Promise.resolve([listRow]) : { limit: () => Promise.resolve([]) };
            },
          }),
        }),
        delete: () => ({
          // The actual DELETE — this is where the race would really be
          // caught, after another transaction assigned the customer.
          where: () => Promise.reject(fkError),
        }),
      } as unknown as Db;

      const raceRepo = createSalesRepository(stubDb);
      await expect(raceRepo.deletePriceList(listRow.id)).rejects.toThrow(PriceListInUseError);
    });
  });
});
