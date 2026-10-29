import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { articles, db } from "@navet/db";
import { testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";

// Prishistorik (migration 0169): the försäljningspris and the supplier catalog
// get their history from triggers, so every writer records it — the services
// below and a plain SQL UPDATE alike. The catalog snapshot is taken at commit
// from the row's final state (row + staffel), once per transaction.

const articleService = createArticleService(createArticleRepository(db));
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  articleService,
  testSystemService,
  {
    reportOperationQuantities: async () => { throw new Error("not wired in this test"); },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => { throw new Error("not wired in this test"); },
    updateRoutingOperation: async () => { throw new Error("not wired in this test"); },
  }
);

// suppliers is left out for the same reason as in costing.service.test.ts —
// its cascade is slow; each test names its own suppliers.
const TRUNCATE = sql`TRUNCATE article_suppliers, articles CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeArticle(salesPrice?: number) {
  return articleService.createArticle({
    articleNumber: `PH-${crypto.randomUUID()}`,
    name: "Konsol",
    type: "purchased",
    unit: "st",
    salesPrice,
    active: true,
  });
}

async function makeSupplier() {
  return purchaseService.createSupplier({ name: `Lev-${crypto.randomUUID()}`, active: true });
}

describe("prishistorik — försäljningspris", () => {
  it("records the price at creation and every change, from any writer", async () => {
    const article = await makeArticle(100);
    await articleService.updateArticle(article.id, { salesPrice: 120 });
    await articleService.updateSalesPrice(article.id, 130);
    // A writer the application does not know about.
    await db.update(articles).set({ salesPrice: "140" }).where(eq(articles.id, article.id));

    const { salesPrice } = await articleService.listPriceHistory(article.id);
    expect(salesPrice.map((r) => r.value)).toEqual(["140.0000", "130.0000", "120.0000", "100.0000"]);
  });

  it("records a cleared price, and nothing when the value did not change", async () => {
    const article = await makeArticle(100);
    await articleService.updateArticle(article.id, { salesPrice: 100 });
    await articleService.updateArticle(article.id, { name: "Annat namn" });
    await articleService.updateArticle(article.id, { salesPrice: null });

    const { salesPrice } = await articleService.listPriceHistory(article.id);
    expect(salesPrice.map((r) => r.value)).toEqual([null, "100.0000"]);
  });

  it("keeps one row per transaction", async () => {
    const article = await makeArticle();
    await db.transaction(async (tx) => {
      await tx.update(articles).set({ salesPrice: "50" }).where(eq(articles.id, article.id));
      await tx.update(articles).set({ salesPrice: "60" }).where(eq(articles.id, article.id));
    });
    const { salesPrice } = await articleService.listPriceHistory(article.id);
    expect(salesPrice.map((r) => r.value)).toEqual(["60.0000"]);
  });

  it("lists the standard cost history next to it", async () => {
    const article = await makeArticle();
    await articleService.updateStandardCost(article.id, 10);
    await articleService.updateStandardCost(article.id, 12);
    const { standardCost } = await articleService.listPriceHistory(article.id);
    expect(standardCost.map((r) => r.value)).toEqual(["12.0000", "10.0000"]);
  });
});

describe("prishistorik — leverantörskatalogen", () => {
  it("snapshots price, currency and staffel together when the row is added", async () => {
    const article = await makeArticle();
    const supplier = await makeSupplier();
    await purchaseService.addArticleSupplier(article.id, {
      supplierId: supplier.id,
      price: 10,
      currency: "EUR",
      isPrimary: true,
      priceBreaks: [{ fromQuantity: 100, price: 8 }, { fromQuantity: 10, price: 9 }],
    });

    const history = await purchaseService.listArticleSupplierPriceHistory(article.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      supplierId: supplier.id,
      supplierName: supplier.name,
      price: "10.0000",
      currency: "EUR",
      isPrimary: true,
      removed: false,
    });
    expect(history[0]!.priceBreaks.map((b) => [Number(b.fromQuantity), Number(b.price)])).toEqual([
      [10, 9],
      [100, 8],
    ]);
  });

  it("writes one snapshot per change — a staffel-only change too — and none for a save without change", async () => {
    const article = await makeArticle();
    const supplier = await makeSupplier();
    const row = await purchaseService.addArticleSupplier(article.id, { supplierId: supplier.id, price: 10, currency: "SEK", isPrimary: true });
    await purchaseService.updateArticleSupplier(article.id, row.id, { price: 11, currency: "EUR" });
    await purchaseService.updateArticleSupplier(article.id, row.id, { priceBreaks: [{ fromQuantity: 5, price: 10 }] });
    await purchaseService.updateArticleSupplier(article.id, row.id, { price: 11 });

    const history = await purchaseService.listArticleSupplierPriceHistory(article.id);
    expect(history.map((h) => [h.price, h.currency, h.priceBreaks.length])).toEqual([
      ["11.0000", "EUR", 1],
      ["11.0000", "EUR", 0],
      ["10.0000", "SEK", 0],
    ]);
  });

  it("records a switch of primary supplier for both rows, and a removal", async () => {
    const article = await makeArticle();
    const first = await makeSupplier();
    const second = await makeSupplier();
    const row = await purchaseService.addArticleSupplier(article.id, { supplierId: first.id, price: 10, currency: "SEK", isPrimary: true });
    await purchaseService.addArticleSupplier(article.id, { supplierId: second.id, price: 9, currency: "SEK", isPrimary: true });
    await purchaseService.removeArticleSupplier(article.id, row.id);

    const history = await purchaseService.listArticleSupplierPriceHistory(article.id);
    const of = (supplierId: string) =>
      history.filter((h) => h.supplierId === supplierId).map((h) => ({ isPrimary: h.isPrimary, removed: h.removed }));
    expect(of(first.id)).toEqual([
      { isPrimary: false, removed: true },
      { isPrimary: false, removed: false },
      { isPrimary: true, removed: false },
    ]);
    expect(of(second.id)).toEqual([{ isPrimary: true, removed: false }]);
  });

  it("lets the history go with a deleted article without failing the commit", async () => {
    const article = await makeArticle();
    const supplier = await makeSupplier();
    await purchaseService.addArticleSupplier(article.id, { supplierId: supplier.id, price: 10, currency: "SEK", isPrimary: true });
    await db.delete(articles).where(eq(articles.id, article.id));

    const [{ n }] = (await db.execute(sql`select count(*)::int as n from article_supplier_price_history where article_id = ${article.id}`)) as unknown as {
      n: number;
    }[];
    expect(n).toBe(0);
  });
});
