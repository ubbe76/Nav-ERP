// Ställpris som egen orderrad (migration 0161): the customer price's
// ställpris becomes a linked Ställkostnad row on new quote/order rows.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleSchema, updateSystemSettingsSchema } from "@navet/shared";
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
import { SetupChargeArticleNotFoundError } from "../src/modules/system/service/system.service.js";

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

const TRUNCATE = sql`TRUNCATE email_log, audit_log, customer_prices, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key = 'setup_charge_article_id'`);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key = 'setup_charge_article_id'`);
});

async function makeArticle(articleNumber: string, type: "manufactured" | "service" = "manufactured") {
  return articleService.createArticle(
    createArticleSchema.parse({ articleNumber, name: `Artikel ${articleNumber}`, type, salesPrice: 100, active: true })
  );
}

async function makeUser() {
  return authRepo.create({
    email: `setup-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Säljare",
    role: "admin",
  });
}

// A customer with ställpris rules on A-1 (400) and A-2 (250), and the
// Ställkostnadsartikel chosen in the settings.
async function scenario(opts: { setupArticle?: boolean } = {}) {
  const user = await makeUser();
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
  const a1 = await makeArticle("A-1");
  const a2 = await makeArticle("A-2");
  const setup = await makeArticle("STALL", "service");
  await salesService.addCustomerPrice(customer.id, { articleId: a1.id, fromQuantity: 1, unitPrice: 1890, setupPrice: 400 });
  await salesService.addCustomerPrice(customer.id, { articleId: a2.id, fromQuantity: 1, unitPrice: 500, setupPrice: 250 });
  if (opts.setupArticle !== false) {
    await systemService.updateSettings(updateSystemSettingsSchema.parse({ setupChargeArticleId: setup.id }));
  }
  return { user, customer, a1, a2, setup };
}

describe("Ställkostnad som egen orderrad", () => {
  it("adds a linked Ställkostnad row per article on a new quote, even with a typed price", async () => {
    const { user, customer, a1, a2, setup } = await scenario();
    const { order } = await salesService.createQuote(
      {
        customerId: customer.id,
        rows: [
          { articleId: a1.id, quantity: 10 },
          { articleId: a2.id, quantity: 2, unitPrice: 450 },
        ],
      },
      user.id
    );
    const rows = await salesService.listRows(order.id);
    expect(rows.map((r) => [r.articleId, Number(r.quantityOrdered), Number(r.unitPrice)])).toEqual([
      [a1.id, 10, 1890],
      [setup.id, 1, 400],
      [a2.id, 2, 450],
      [setup.id, 1, 250],
    ]);
    expect(rows[1]!.setupForRowId).toBe(rows[0]!.id);
    expect(rows[3]!.setupForRowId).toBe(rows[2]!.id);

    const pdf = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(pdf).toContain("Ställkostnad för A-1");
    expect(pdf).toContain("Ställkostnad för A-2");
  });

  it("adds nothing without a Ställkostnadsartikel, and never on the article itself", async () => {
    const { user, customer, a1, setup } = await scenario({ setupArticle: false });
    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: a1.id, quantity: 1 }] },
      user.id
    );
    expect(await salesService.listRows(order.id)).toHaveLength(1);

    await systemService.updateSettings(updateSystemSettingsSchema.parse({ setupChargeArticleId: setup.id }));
    await salesService.addRow(order.id, { articleId: setup.id, quantity: 1, unitPrice: 99 });
    expect(await salesService.listRows(order.id)).toHaveLength(2);
  });

  it("adds the row on Lägg till rad and removes an undelivered one with its article row", async () => {
    const { user, customer, a1, a2, setup } = await scenario();
    const { order } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: a2.id, quantity: 1 }] },
      user.id
    );
    const added = await salesService.addRow(order.id, { articleId: a1.id, quantity: 3 });
    const rows = await salesService.listRows(order.id);
    const charge = rows.find((r) => r.setupForRowId === added.id);
    expect(charge).toMatchObject({ articleId: setup.id, unitPrice: "400.0000" });

    await salesService.deleteRow(order.id, added.id);
    const after = await salesService.listRows(order.id);
    expect(after.map((r) => r.articleId)).toEqual([a2.id, setup.id]);
  });

  it("refuses an unknown article as Ställkostnadsartikel", async () => {
    await expect(
      systemService.updateSettings(updateSystemSettingsSchema.parse({ setupChargeArticleId: crypto.randomUUID() }))
    ).rejects.toBeInstanceOf(SetupChargeArticleNotFoundError);
    expect((await systemService.getSettings()).setupChargeArticleId).toBeNull();
  });
});
