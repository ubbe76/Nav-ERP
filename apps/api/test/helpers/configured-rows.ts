// apps/api/test/helpers/configured-rows.ts
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../../src/modules/economy/service/verification-poster.js";
import { createMailRepository } from "../../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../../src/modules/mail/service/mail.service.js";
import { createPurchaseRepository } from "../../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../../src/modules/register/service/register.service.js";
import { createInvoiceRepository } from "../../src/modules/sales/repository/invoice.repository.js";
import { createSalesRepository } from "../../src/modules/sales/repository/sales.repository.js";
import { createInvoiceService } from "../../src/modules/sales/service/invoice.service.js";
import { resolvePrice } from "../../src/modules/sales/service/price-resolver.js";
import { createSalesService, type RowConfigurationReader } from "../../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../../src/modules/system/repository/audit.repository.js";
import { makeArticle, makeVariantService, resetConfigurator } from "./configurator.js";
import {
  DEFAULT_POSTING_SETTINGS,
  setupPostingBaseline,
  testArticleService,
  testDocumentPdfService,
  testSystemService,
} from "./services.js";

// Konfigurator 4b (beställningsvara på orderraden): the sales service wired
// with the configurator's row-configuration reader, exactly as app.ts binds
// it — shared by the 4b suites (configured rows, Ändra konfiguration,
// documents, invoices). A helper, not a test file: vitest only runs describe
// blocks in *.test.ts, and a test file importing another test file would run
// its tests twice.

export const configurator = makeVariantService({ prices: (q) => resolvePrice(db, q) });
export const rowConfiguration: RowConfigurationReader = {
  evaluate: (t, s, o) => configurator.evaluateRowConfiguration(t, s, o),
  variantOf: (id) => configurator.findVariantOf(id),
  resolveVariant: (t, s, u) => configurator.resolveVariant(t, s, u),
};
export const registerService = createRegisterService(createRegisterRepository(db));
// Recording fake SMTP transport — the document suite (Task 5) reads the
// attached PDF back out of it; the earlier suites never look at it.
export const sentMails: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    sentMails.push(opts);
  },
});
export const mailService = createMailService(createMailRepository(db), testSystemService, fakeTransportFactory);
export const stockService = createStockService(createStockRepository(db));
export const salesRepository = createSalesRepository(db);
export const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  stockService,
  testArticleService,
  testSystemService,
  (q) => resolvePrice(db, q, { variantPrice: (vq) => configurator.variantPrice(vq) }),
  // Real audit writer so the händelselogg assertions (Task 3) see the rows.
  createAuditRepository(db),
  undefined,
  undefined,
  undefined,
  rowConfiguration
);

export const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  {
    reportOperationQuantities: async () => {
      throw new Error("SubcontractOperationReporter not wired in this test");
    },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => {
      throw new Error("SubcontractOperationReporter not wired in this test");
    },
    updateRoutingOperation: async () => {
      throw new Error("RoutingPriceWriter not wired in this test");
    },
  }
);
// Invoicing (Task 5): the poster reads its accounts from the fixed stub, as
// customer-invoice.service.test.ts does — these suites are about the row's
// configuration copy, not the posting configuration.
export const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  testDocumentPdfService,
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  createAuditRepository(db),
  testArticleService
);

// Ändra konfiguration (Task 3) pushes rows past the guards — deliveries,
// linked TOs, invoice rows — so those tables are cleared too.
export const CONFIGURED_ROWS_TRUNCATE = sql`TRUNCATE audit_log, customer_prices, price_list_rows, price_lists, invoice_rows, invoices, manufacturing_orders, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, users CASCADE`;
export async function resetConfiguredRows() {
  await resetConfigurator();
  await db.execute(CONFIGURED_ROWS_TRUNCATE);
}

// Documents + invoices (Task 5): also clears the bookkeeping tables an issued
// invoice writes and the email log the sends land in, then seeds the fiscal
// year/accounts an issue needs and an SMTP config so the fake transport is
// reached. Kept apart from resetConfiguredRows so the earlier suites stay
// as fast as they are.
const DOCUMENTS_TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, email_log CASCADE`;
export async function resetDocuments() {
  await resetConfiguredRows();
  await db.execute(DOCUMENTS_TRUNCATE);
  await testSystemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
  await setupPostingBaseline();
}

export async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

export async function seedStock(articleId: string, locationId: string, quantity: number) {
  await stockService.recordTransaction({ articleId, locationId, quantityDelta: quantity, transactionType: "inventory_adjustment" });
}

const authRepo = createAuthRepository(db);
export async function makeUser() {
  return authRepo.create({
    email: `cfg-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Konfigurator",
    role: "admin",
  });
}

// Template: base 1000 (salesPrice), LOCK A (+0) / B (+50) required, AVLOPP
// ja/nej (+100), BREDD 500–2000 required (no price). salesPrice: null ⇒ no
// base price at all.
export async function buildToOrder(opts: { salesPrice?: number | null } = {}) {
  const article = await makeArticle({ salesPrice: opts.salesPrice === null ? undefined : (opts.salesPrice ?? 1000) });
  await configurator.createTemplate(article.id, { mode: "to_order" });
  const lock = await configurator.createGroup(article.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
  const a = await configurator.createValue(article.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });
  const b = await configurator.createValue(article.id, lock.id, { code: "B", name: "Lås B", priceAdd: 50, active: true });
  const avlopp = await configurator.createGroup(article.id, { code: "AVLOPP", name: "Avlopp", kind: "boolean", priceAdd: 100 });
  const bredd = await configurator.createGroup(article.id, {
    code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", minValue: 500, maxValue: 2000, step: null,
    defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0,
  });
  return { article, lock, a, b, avlopp, bredd };
}

export const makeCustomer = (discountPercent?: number) =>
  salesService.createCustomer({ name: "Kund AB", active: true, ...(discountPercent !== undefined ? { discountPercent } : {}) });

// Variant template (4a's configurator-variant-price build() without the
// variant): base 1000, LOCK A (+0) / B (+50) required, BREDD 500–2000
// required (no price). Variants are resolved by the caller.
export async function buildVariants() {
  const template = await makeArticle({ salesPrice: 1000 });
  await configurator.createTemplate(template.id, { mode: "variants" });
  const lock = await configurator.createGroup(template.id, { code: "LOCK", name: "Lås", kind: "choice", required: true });
  await configurator.createValue(template.id, lock.id, { code: "A", name: "Lås A", priceAdd: 0, active: true });
  await configurator.createValue(template.id, lock.id, { code: "B", name: "Lås B", priceAdd: 50, active: true });
  const bredd = await configurator.createGroup(template.id, {
    code: "BREDD", name: "Bredd", kind: "number", required: true, unit: "mm", minValue: 500, maxValue: 2000, step: null,
    defaultNumber: null, pricePerUnit: 0, priceBaseValue: 0,
  });
  return { template, lock, bredd };
}
