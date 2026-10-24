import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { createReportsRepository } from "../src/modules/reports/repository/reports.repository.js";
import { createReportsService } from "../src/modules/reports/service/reports.service.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
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
const invoicePoster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
const supplierInvoiceService = createSupplierInvoiceService(createSupplierInvoiceRepository(db), invoicePoster);
const reportsService = createReportsService(createReportsRepository(db));

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, supplier_invoice_rows, supplier_invoices, article_suppliers, email_log, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, supplier_contacts, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

// Same rationale as supplier-invoice.service.test.ts's POSTING_DATE — dates
// itself "today" so the fiscal year setupPostingBaseline lays out always
// covers it, and so the default (current-month) report range picks it up.
const POSTING_DATE = new Date().toLocaleDateString("sv-SE");
const currentMonth = () => POSTING_DATE.slice(0, 7);

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `rep-purch-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Reporter",
    role: "admin",
  });
}

async function makeSupplier(name = "Lev AB") {
  return purchaseService.createSupplier({ name, active: true });
}

async function makeArticle(name = "Rapportartikel") {
  return articleService.createArticle({
    articleNumber: `REP-PURCH-${crypto.randomUUID()}`,
    name,
    type: "purchased",
    active: true,
  });
}

describe("reports service — purchase statistics: header vs rows basis", () => {
  it("month/supplier grouping sums the header net_amount; article grouping sums the row line_amount instead", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const article = await makeArticle();

    // Header net (150) deliberately differs from the row sum (100) — e.g. a
    // freight surcharge on the paper invoice with no article row.
    await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: `INV-${crypto.randomUUID()}`,
        invoiceDate: POSTING_DATE,
        netAmount: 150,
        vatAmount: 37.5,
        grossAmount: 187.5,
        rows: [{ description: "Material", articleId: article.id, quantity: 2, unitPrice: 50, vatRate: 25 }],
      },
      user.id
    ).then((inv) => supplierInvoiceService.approve(inv!.id, user.id));

    const byMonth = await reportsService.getPurchaseStatistics({ groupBy: "month" });
    expect(byMonth.basis).toBe("header");
    expect(byMonth.rows).toHaveLength(1);
    expect(byMonth.rows[0]!.key).toBe(currentMonth());
    expect(byMonth.rows[0]!.netAmount).toBe(150);
    expect(byMonth.rows[0]!.quantity).toBeNull();
    expect(byMonth.rows[0]!.invoiceCount).toBe(1);
    expect(byMonth.totalNet).toBe(150);

    const bySupplier = await reportsService.getPurchaseStatistics({ groupBy: "supplier" });
    expect(bySupplier.basis).toBe("header");
    expect(bySupplier.rows).toHaveLength(1);
    expect(bySupplier.rows[0]!.key).toBe(supplier.id);
    expect(bySupplier.rows[0]!.label).toBe(supplier.name);
    expect(bySupplier.rows[0]!.netAmount).toBe(150);

    const byArticle = await reportsService.getPurchaseStatistics({ groupBy: "article" });
    expect(byArticle.basis).toBe("rows");
    expect(byArticle.rows).toHaveLength(1);
    expect(byArticle.rows[0]!.key).toBe(article.id);
    expect(byArticle.rows[0]!.label).toBe(`${article.articleNumber} — ${article.name}`);
    expect(byArticle.rows[0]!.netAmount).toBe(100); // 2 × 50, the row basis
    expect(byArticle.rows[0]!.quantity).toBe(2);
    expect(byArticle.totalNet).toBe(100);
  });

  it("excludes draft and cancelled invoices from every grouping", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();

    // Left as a draft — never approved.
    await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: `INV-DRAFT-${crypto.randomUUID()}`,
        invoiceDate: POSTING_DATE,
        netAmount: 9999,
        vatAmount: 0,
        grossAmount: 9999,
        rows: [],
      },
      user.id
    );

    // Approved, then cancelled.
    const cancelled = await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: `INV-CANCEL-${crypto.randomUUID()}`,
        invoiceDate: POSTING_DATE,
        netAmount: 8888,
        vatAmount: 0,
        grossAmount: 8888,
        rows: [],
      },
      user.id
    );
    await supplierInvoiceService.approve(cancelled!.id, user.id);
    await supplierInvoiceService.cancel(cancelled!.id, user.id);

    const result = await reportsService.getPurchaseStatistics({ groupBy: "month" });
    expect(result.rows).toHaveLength(0);
    expect(result.totalNet).toBe(0);
  });

  it("groups article rows with no article as (Rader utan artikel)", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();

    const invoice = await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: `INV-FREIGHT-${crypto.randomUUID()}`,
        invoiceDate: POSTING_DATE,
        netAmount: 75,
        vatAmount: 0,
        grossAmount: 75,
        rows: [{ description: "Frakt", quantity: 1, unitPrice: 75, vatRate: 0 }],
      },
      user.id
    );
    await supplierInvoiceService.approve(invoice!.id, user.id);

    const result = await reportsService.getPurchaseStatistics({ groupBy: "article" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.key).toBe("null");
    expect(result.rows[0]!.label).toBe("(Rader utan artikel)");
    expect(result.rows[0]!.netAmount).toBe(75);
  });

  // Valuta: an EUR invoice is summed in SEK at its own rate, never next to a
  // SEK invoice in its own currency.
  it("converts each invoice to SEK at its rate before summing", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier();
    const euro = await purchaseService.createSupplier({ name: "Lieferant GmbH", currency: "EUR", country: "DE", active: true } as never);
    const article = await makeArticle();
    const approve = (inv: { id: string } | null) => supplierInvoiceService.approve(inv!.id, user.id);
    await supplierInvoiceService
      .create(
        { supplierId: supplier.id, invoiceNumber: `INV-${crypto.randomUUID()}`, invoiceDate: POSTING_DATE, netAmount: 100, vatAmount: 25, grossAmount: 125, rows: [] },
        user.id
      )
      .then(approve);
    await supplierInvoiceService
      .create(
        {
          supplierId: euro.id,
          invoiceNumber: `INV-${crypto.randomUUID()}`,
          invoiceDate: POSTING_DATE,
          netAmount: 1000,
          vatAmount: 0,
          grossAmount: 1000,
          exchangeRate: 11.131,
          rows: [{ description: "Material", articleId: article.id, quantity: 3, unitPrice: 333.33 }],
        },
        user.id
      )
      .then(approve);

    const byMonth = await reportsService.getPurchaseStatistics({ groupBy: "month" });
    expect(byMonth.rows[0]!.netAmount).toBe(100 + 11131);
    const bySupplier = await reportsService.getPurchaseStatistics({ groupBy: "supplier" });
    expect(bySupplier.rows.map((row) => [row.label, row.netAmount])).toEqual([
      ["Lieferant GmbH", 11131],
      [supplier.name, 100],
    ]);
    const byArticle = await reportsService.getPurchaseStatistics({ groupBy: "article" });
    // 999,99 EUR × 11,131 = 11 130,89 (round(x × rate, 2)).
    expect(byArticle.rows[0]!.netAmount).toBe(11130.89);
  });
});
