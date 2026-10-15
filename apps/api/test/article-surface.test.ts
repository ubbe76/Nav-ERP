// Task 5 — Ytbehandling/Färg: article persistence + the quote/confirmation
// PDF's articleInfo line. The invoice PDF must never print it (see
// CLAUDE.md's Sales PDFs note and document-pdf.ts's DocumentPdfRow comment).
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleSchema, updateArticleSchema } from "@navet/shared";
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
import { stampOrderInvoiced } from "./helpers/services.js";

const articleRepo = createArticleRepository(db);
const articleService = createArticleService(articleRepo);
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const auditRepository = createAuditRepository(db);

const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail() {
    /* no-op — these tests never send mail */
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
  (query) => resolvePrice(db, query),
  auditRepository
);

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE email_log, audit_log, sales_order_rows, sales_orders, customers, price_lists, delivery_terms, payment_terms, carriers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`
  );
});

afterAll(async () => {
  await db.execute(
    sql`TRUNCATE email_log, audit_log, sales_order_rows, sales_orders, customers, price_lists, delivery_terms, payment_terms, carriers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`
  );
});

async function makeUser() {
  return authRepo.create({
    email: `surface-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Seller",
    role: "admin",
  });
}

async function makeCustomer() {
  return salesService.createCustomer({ name: "Kund AB", active: true });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

async function seedStock(articleId: string, locationId: string, quantity: number) {
  await stockService.recordTransaction({
    articleId,
    locationId,
    quantityDelta: quantity,
    transactionType: "inventory_adjustment",
  });
}

describe("article surface treatment / colour — persistence", () => {
  it("creates an article with both values and GET returns them", async () => {
    const created = await articleService.createArticle(
      createArticleSchema.parse({
        articleNumber: `ART-SURF-${crypto.randomUUID()}`,
        name: "Lackad plåt",
        type: "purchased",
        surfaceTreatment: "Pulverlack RAL 9010",
        colour: "Vit",
        active: true,
      })
    );
    expect(created.surfaceTreatment).toBe("Pulverlack RAL 9010");
    expect(created.colour).toBe("Vit");

    const fetched = await articleService.getArticle(created.id);
    expect(fetched!.surfaceTreatment).toBe("Pulverlack RAL 9010");
    expect(fetched!.colour).toBe("Vit");
  });

  it("creates an article with neither value set as null", async () => {
    const created = await articleService.createArticle(
      createArticleSchema.parse({
        articleNumber: `ART-SURF-${crypto.randomUUID()}`,
        name: "Omålad plåt",
        type: "purchased",
        active: true,
      })
    );
    expect(created.surfaceTreatment).toBeNull();
    expect(created.colour).toBeNull();
  });

  it("clears surfaceTreatment to null on PATCH with an empty string", async () => {
    const created = await articleService.createArticle(
      createArticleSchema.parse({
        articleNumber: `ART-SURF-${crypto.randomUUID()}`,
        name: "Lackad plåt",
        type: "purchased",
        surfaceTreatment: "Pulverlack RAL 9010",
        colour: "Vit",
        active: true,
      })
    );

    const updated = await articleService.updateArticle(created.id, updateArticleSchema.parse({ surfaceTreatment: "" }));
    expect(updated!.surfaceTreatment).toBeNull();
    // colour is untouched by the partial patch.
    expect(updated!.colour).toBe("Vit");
  });

  it("rejects a surfaceTreatment/colour value over 200 characters with a zod error", () => {
    const tooLong = "x".repeat(201);
    expect(createArticleSchema.safeParse({ articleNumber: "A-1", name: "x", type: "purchased", surfaceTreatment: tooLong }).success).toBe(false);
    expect(createArticleSchema.safeParse({ articleNumber: "A-1", name: "x", type: "purchased", colour: tooLong }).success).toBe(false);
    expect(updateArticleSchema.safeParse({ surfaceTreatment: tooLong }).success).toBe(false);
    expect(updateArticleSchema.safeParse({ colour: tooLong }).success).toBe(false);
  });
});

describe("article surface treatment / colour — sales PDFs", () => {
  async function makeQuoteWithSurfaceRow(opts: { surfaceTreatment?: string; colour?: string }) {
    const user = await makeUser();
    const customer = await makeCustomer();
    const location = await makeLocation();
    const article = await articleService.createArticle(
      createArticleSchema.parse({
        articleNumber: `ART-SURF-${crypto.randomUUID()}`,
        name: "Lackad plåt",
        type: "manufactured",
        surfaceTreatment: opts.surfaceTreatment,
        colour: opts.colour,
        active: true,
      })
    );
    await seedStock(article.id, location.id, 5);
    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 2, unitPrice: 100 }] },
      user.id
    );
    return { user, customer, article, location, order, row: rows[0]! };
  }

  it("prints Ytbehandling + Färg on the quote and confirmation PDFs", async () => {
    const { order } = await makeQuoteWithSurfaceRow({ surfaceTreatment: "Pulverlack RAL 9010", colour: "Vit" });

    const quoteText = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(quoteText).toContain("Ytbehandling: Pulverlack RAL 9010 · Färg: Vit");

    const confirmationText = pdfText((await salesService.getSalesOrderPdf(order.id, "confirmation")).content);
    expect(confirmationText).toContain("Ytbehandling: Pulverlack RAL 9010 · Färg: Vit");
  });

  it("prints only Färg when surfaceTreatment is null", async () => {
    const { order } = await makeQuoteWithSurfaceRow({ colour: "Vit" });

    const quoteText = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(quoteText).toContain("Färg: Vit");
    expect(quoteText).not.toContain("Ytbehandling:");
  });

  it("does not print the articleInfo line on the invoice PDF for the same order", async () => {
    const { order, row, location, user } = await makeQuoteWithSurfaceRow({
      surfaceTreatment: "Pulverlack RAL 9010",
      colour: "Vit",
    });
    await salesService.confirm(order.id);
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, row.id, { locationId: location.id, quantity: 2 }, user.id);
    await stampOrderInvoiced(db, order.id, "FA-SURF-1");

    const invoiceText = pdfText((await salesService.getInvoicePdf(order.id)).content);
    expect(invoiceText).not.toContain("Ytbehandling:");
    expect(invoiceText).not.toContain("Färg: Vit");
  });
});
