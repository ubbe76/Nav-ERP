import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import {
  ArticleNotFoundError,
  createArticleService,
} from "../src/modules/article/service/article.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import {
  ArticleSupplierNotFoundError,
  createPurchaseService,
  DuplicateArticleSupplierError,
  SupplierInactiveError,
} from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { articleSupplierPriceBreaks } from "@navet/db";
import { createArticleSupplierSchema, updateArticleSupplierSchema } from "@navet/shared";

const articleService = createArticleService(createArticleRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const documentPdfService = createDocumentPdfService(systemService);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  // Lego (Etapp G): SubcontractOperationReporter — never reached in this
  // suite, and loud if it ever is.
  {
    reportOperationQuantities: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("SubcontractOperationReporter not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("RoutingPriceWriter not wired in this test"); },
  }
);

const TRUNCATE = sql`TRUNCATE article_supplier_price_breaks, article_suppliers, supplier_contacts, suppliers, bom_components, stock_transactions, articles CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticle(articleNumber: string) {
  return articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", active: true });
}

async function makeSupplier(name: string, active = true) {
  return purchaseService.createSupplier({ name, active });
}

describe("article supplier catalog", () => {
  it("adds a supplier, moves the huvudleverantör flag, and lists primary-first", async () => {
    const article = await makeArticle(`ART-${crypto.randomUUID()}`);
    const s1 = await makeSupplier("Alfa AB");
    const s2 = await makeSupplier("Beta AB");

    await purchaseService.addArticleSupplier(article.id, {
      supplierId: s1.id,
      supplierArticleNumber: "A-1",
      price: 10,
      isPrimary: true,
    });
    await purchaseService.addArticleSupplier(article.id, { supplierId: s2.id, price: 12, isPrimary: true });

    const list = await purchaseService.listArticleSuppliers(article.id);
    expect(list).toHaveLength(2);
    // Only one primary, and it's the most recent one.
    const primaries = list.filter((r) => r.isPrimary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]!.supplierId).toBe(s2.id);
    // Primary sorts first.
    expect(list[0]!.isPrimary).toBe(true);
    expect(list[0]!.supplierName).toBe("Beta AB");
  });

  it("updates a catalog row and demotes the previous primary on the way", async () => {
    const article = await makeArticle(`ART-${crypto.randomUUID()}`);
    const s1 = await makeSupplier("Alfa AB");
    const s2 = await makeSupplier("Beta AB");
    const first = await purchaseService.addArticleSupplier(article.id, { supplierId: s1.id, isPrimary: true });
    const second = await purchaseService.addArticleSupplier(article.id, { supplierId: s2.id, isPrimary: false });

    await purchaseService.updateArticleSupplier(article.id, second.id, { isPrimary: true, price: 99 });
    const list = await purchaseService.listArticleSuppliers(article.id);
    expect(list.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second.id]);
    expect(list.find((r) => r.id === first.id)!.isPrimary).toBe(false);
    expect(list.find((r) => r.id === second.id)!.price).toBe("99.0000");
  });

  it("rejects a duplicate (article, supplier)", async () => {
    const article = await makeArticle(`ART-${crypto.randomUUID()}`);
    const supplier = await makeSupplier("Alfa AB");
    await purchaseService.addArticleSupplier(article.id, { supplierId: supplier.id });
    await expect(
      purchaseService.addArticleSupplier(article.id, { supplierId: supplier.id })
    ).rejects.toThrow(DuplicateArticleSupplierError);
  });

  it("rejects an inactive supplier and an unknown article", async () => {
    const article = await makeArticle(`ART-${crypto.randomUUID()}`);
    const inactive = await makeSupplier("Nedlagd AB", false);
    await expect(
      purchaseService.addArticleSupplier(article.id, { supplierId: inactive.id })
    ).rejects.toThrow(SupplierInactiveError);

    const supplier = await makeSupplier("Alfa AB");
    await expect(
      purchaseService.addArticleSupplier(crypto.randomUUID(), { supplierId: supplier.id })
    ).rejects.toThrow(ArticleNotFoundError);
  });

  it("scopes update/delete to the article (a row from another article 404s)", async () => {
    const a = await makeArticle(`ART-A-${crypto.randomUUID()}`);
    const b = await makeArticle(`ART-B-${crypto.randomUUID()}`);
    const supplier = await makeSupplier("Alfa AB");
    const row = await purchaseService.addArticleSupplier(a.id, { supplierId: supplier.id });

    await expect(
      purchaseService.updateArticleSupplier(b.id, row.id, { price: 5 })
    ).rejects.toThrow(ArticleSupplierNotFoundError);
    await expect(purchaseService.removeArticleSupplier(b.id, row.id)).rejects.toThrow(ArticleSupplierNotFoundError);

    await purchaseService.removeArticleSupplier(a.id, row.id);
    expect(await purchaseService.listArticleSuppliers(a.id)).toHaveLength(0);
  });
});

// Stafflade leverantörspriser: breaks ride on the catalog row as a set that
// is replaced whole on every save.
describe("article supplier catalog — staffel (price breaks)", () => {
  async function fixture() {
    const article = await makeArticle(`ART-${crypto.randomUUID()}`);
    const supplier = await makeSupplier("Stål AB");
    return { article, supplier };
  }

  it("stores breaks on create and lists them ascending by from-quantity", async () => {
    const { article, supplier } = await fixture();
    const created = await purchaseService.addArticleSupplier(article.id, {
      supplierId: supplier.id,
      price: 10,
      priceBreaks: [
        { fromQuantity: 100, price: 8 },
        { fromQuantity: 10, price: 9 },
      ],
    });
    expect(created.priceBreaks.map((b) => [b.fromQuantity, b.price])).toEqual([
      [10, 9],
      [100, 8],
    ]);

    const [row] = await purchaseService.listArticleSuppliers(article.id);
    expect(row!.priceBreaks.map((b) => [b.fromQuantity, b.price])).toEqual([
      [10, 9],
      [100, 8],
    ]);
  });

  it("replaces the whole set on update, clears it with [], and accepts a breaks-only PATCH", async () => {
    const { article, supplier } = await fixture();
    const row = await purchaseService.addArticleSupplier(article.id, {
      supplierId: supplier.id,
      price: 10,
      priceBreaks: [{ fromQuantity: 10, price: 9 }],
    });

    // Only priceBreaks — the empty-`set` guard in the repository.
    const replaced = await purchaseService.updateArticleSupplier(article.id, row.id, {
      priceBreaks: [
        { fromQuantity: 50, price: 7 },
        { fromQuantity: 20, price: 8 },
      ],
    });
    expect(replaced.priceBreaks.map((b) => b.fromQuantity)).toEqual([20, 50]);
    expect(replaced.price).toBe("10.0000");

    // Other fields untouched when priceBreaks is omitted.
    const priced = await purchaseService.updateArticleSupplier(article.id, row.id, { price: 11 });
    expect(priced.priceBreaks.map((b) => b.fromQuantity)).toEqual([20, 50]);

    const cleared = await purchaseService.updateArticleSupplier(article.id, row.id, { priceBreaks: [] });
    expect(cleared.priceBreaks).toEqual([]);
    expect(cleared.price).toBe("11.0000");
  });

  it("deletes the breaks with the catalog row", async () => {
    const { article, supplier } = await fixture();
    const row = await purchaseService.addArticleSupplier(article.id, {
      supplierId: supplier.id,
      priceBreaks: [{ fromQuantity: 10, price: 9 }],
    });
    await purchaseService.removeArticleSupplier(article.id, row.id);
    expect(await db.select().from(articleSupplierPriceBreaks)).toHaveLength(0);
  });

  it("rejects a break at quantity 1 and duplicate from-quantities in the input schema", async () => {
    const supplierId = crypto.randomUUID();
    expect(
      createArticleSupplierSchema.safeParse({ supplierId, priceBreaks: [{ fromQuantity: 1, price: 9 }] }).success
    ).toBe(false);
    expect(
      updateArticleSupplierSchema.safeParse({
        priceBreaks: [
          { fromQuantity: 10, price: 9 },
          { fromQuantity: 10, price: 8 },
        ],
      }).success
    ).toBe(false);
    expect(
      updateArticleSupplierSchema.safeParse({ priceBreaks: [{ fromQuantity: 10, price: 9 }] }).success
    ).toBe(true);
  });

  it("quotes the staffel price for the order's supplier and quantity", async () => {
    const { article, supplier } = await fixture();
    const other = await makeSupplier("Annan AB");
    await purchaseService.addArticleSupplier(article.id, {
      supplierId: supplier.id,
      price: 10,
      currency: "EUR",
      priceBreaks: [{ fromQuantity: 10, price: 9 }],
    });
    await purchaseService.addArticleSupplier(article.id, { supplierId: other.id, price: 1 });

    const base = await purchaseService.getSupplierPriceQuote({ supplierId: supplier.id, articleId: article.id, quantity: 9 });
    expect(base).toEqual({
      articleNumber: article.articleNumber,
      price: { unitPrice: 10, currency: "EUR", fromQuantity: 1, source: "base" },
    });
    const tier = await purchaseService.getSupplierPriceQuote({ supplierId: supplier.id, articleId: article.id, quantity: 10 });
    expect(tier!.price).toEqual({ unitPrice: 9, currency: "EUR", fromQuantity: 10, source: "break" });

    // Another supplier's row is never used; no row at all → price null.
    const third = await makeSupplier("Tredje AB");
    const none = await purchaseService.getSupplierPriceQuote({ supplierId: third.id, articleId: article.id, quantity: 10 });
    expect(none).toEqual({ articleNumber: article.articleNumber, price: null });

    expect(
      await purchaseService.getSupplierPriceQuote({ supplierId: supplier.id, articleId: crypto.randomUUID(), quantity: 1 })
    ).toBeNull();
  });
});
