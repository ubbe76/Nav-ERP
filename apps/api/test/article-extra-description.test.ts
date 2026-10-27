// Extra benämning (migration 0157): the article's multi-line free text,
// the system setting extraDescriptionDocuments that picks the documents
// printing it, and the PDFs themselves.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleSchema, updateArticleSchema, updateSystemSettingsSchema } from "@navet/shared";
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
import { createDocumentPdfService, extraDescriptionFor } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";

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

const TRUNCATE = sql`TRUNCATE email_log, audit_log, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key = 'extra_description_documents'`);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key = 'extra_description_documents'`);
});

const TEXT = "Rostfritt slipat\nLevereras i delar";

async function makeArticle(extraDescription?: string) {
  return articleService.createArticle(
    createArticleSchema.parse({
      articleNumber: `ART-EXTRA-${crypto.randomUUID().slice(0, 8)}`,
      name: "Diskbänk 1200",
      type: "manufactured",
      extraDescription,
      active: true,
    })
  );
}

describe("Extra benämning — persistence", () => {
  it("stores the multi-line text, clears it with an empty string and caps it at 2000", async () => {
    const created = await makeArticle(TEXT);
    expect(created.extraDescription).toBe(TEXT);
    expect((await articleService.getArticle(created.id))!.extraDescription).toBe(TEXT);

    const cleared = await articleService.updateArticle(created.id, updateArticleSchema.parse({ extraDescription: "" }));
    expect(cleared!.extraDescription).toBeNull();

    expect(updateArticleSchema.safeParse({ extraDescription: "x".repeat(2001) }).success).toBe(false);
    expect(updateArticleSchema.safeParse({ extraDescription: "x".repeat(2000) }).success).toBe(true);
  });

  it("is copied by Kopiera från → Information", async () => {
    const source = await makeArticle(TEXT);
    const copy = await articleService.createArticle(
      createArticleSchema.parse({
        articleNumber: `ART-EXTRA-COPY-${crypto.randomUUID().slice(0, 8)}`,
        name: "Kopia",
        type: "manufactured",
        active: true,
        copyFrom: { articleId: source.id, parts: ["information"] },
      })
    );
    expect(copy.extraDescription).toBe(TEXT);
  });
});

describe("Extra benämning — the setting", () => {
  it("defaults to no documents and stores the list in catalog order without duplicates", async () => {
    expect((await systemService.getSettings()).extraDescriptionDocuments).toEqual([]);
    await systemService.updateSettings(
      updateSystemSettingsSchema.parse({ extraDescriptionDocuments: ["invoice", "quote", "quote"] })
    );
    expect((await systemService.getSettings()).extraDescriptionDocuments).toEqual(["quote", "invoice"]);
    expect(updateSystemSettingsSchema.safeParse({ extraDescriptionDocuments: ["receipt"] }).success).toBe(false);
  });

  it("reads a broken stored value as no documents", async () => {
    await db.execute(
      sql`INSERT INTO system_settings (key, value) VALUES ('extra_description_documents', 'inte json')
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    );
    expect((await systemService.getSettings()).extraDescriptionDocuments).toEqual([]);
  });

  it("extraDescriptionFor passes the text only for a chosen document", () => {
    const settings = { extraDescriptionDocuments: ["quote" as const] };
    expect(extraDescriptionFor(settings, "quote")(TEXT)).toBe(TEXT);
    expect(extraDescriptionFor(settings, "invoice")(TEXT)).toBeNull();
    expect(extraDescriptionFor(settings, "quote")(null)).toBeNull();
    expect(extraDescriptionFor({}, "quote")(TEXT)).toBeNull();
  });
});

describe("Extra benämning — documents", () => {
  async function quoteWith(text: string) {
    const user = await authRepo.create({
      email: `extra-${crypto.randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
      name: "Säljare",
      role: "admin",
    });
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    const article = await makeArticle(text);
    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 2, unitPrice: 100 }] },
      user.id
    );
    return order;
  }

  it("prints on the quote and pick list only when the setting lists them", async () => {
    const order = await quoteWith(TEXT);
    const before = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(before).not.toContain("Rostfritt slipat");

    await systemService.updateSettings(updateSystemSettingsSchema.parse({ extraDescriptionDocuments: ["quote", "pickList"] }));
    const quote = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(quote).toContain("Rostfritt slipat");
    expect(quote).toContain("Levereras i delar");
    const confirmation = pdfText((await salesService.getSalesOrderPdf(order.id, "confirmation")).content);
    expect(confirmation).not.toContain("Rostfritt slipat");

    await salesService.confirm(order.id);
    const pickList = pdfText((await salesService.getPickListPdf(order.id)).content);
    expect(pickList).toContain("Rostfritt slipat");
    expect(pickList).toContain("Levereras i delar");
  });

  it("prints a long multi-line text on the delivery note and the TO without overlapping the next row", async () => {
    const long = Array.from({ length: 6 }, (_, i) => `Rad ${i + 1}: ${"lång text ".repeat(12)}`).join("\n");
    const note = await documentPdfService.renderDeliveryNote({
      documentNumber: "UL-1",
      orderNumber: "KO-1",
      deliveredAt: new Date("2026-10-27T08:00:00Z"),
      undoneAt: null,
      customerName: "Kund AB",
      customerOrderNumber: null,
      customerReference: null,
      carrier: null,
      deliveryAddress: null,
      rows: [
        { articleNumber: "A-1", articleName: "Diskbänk", quantity: 1, unit: "st", priorDelivered: 0, undoneAt: null, extraDescription: long },
        { articleNumber: "A-2", articleName: "Underrede", quantity: 1, unit: "st", priorDelivered: 0, undoneAt: null },
      ],
    } as never);
    const text = pdfText(note);
    expect(text).toContain("Rad 6:");
    expect(text).toContain("Underrede");

    const mo = pdfText(
      await documentPdfService.renderManufacturingOrder({
        orderNumber: "TO-1",
        printedAt: new Date("2026-10-27T08:00:00Z"),
        articleNumber: "A-1",
        articleName: "Diskbänk",
        quantity: "1",
        statusLabel: "Frisläppt",
        note: null,
        extraDescription: TEXT,
        operations: [],
        materials: [],
      })
    );
    expect(mo).toContain("Rostfritt slipat");
    expect(mo).toContain("Levereras i delar");
  });
});
