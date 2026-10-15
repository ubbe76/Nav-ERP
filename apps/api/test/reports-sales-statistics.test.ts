import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
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
import { buildSalesStatisticsCsv } from "../src/modules/reports/service/reports-csv.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
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
const invoiceRepo = createInvoiceRepository(db);
// Same "fixed stub" idiom as customer-invoice.service.test.ts — this suite is
// about the reports aggregation, not about posting configuration.
const invoicePoster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
const invoiceService = createInvoiceService(invoiceRepo, mailService, documentPdfService, invoicePoster);
const reportsService = createReportsService(createReportsRepository(db));

const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_rows, invoices, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

let issuedBy: string;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await setupPostingBaseline();
  issuedBy = (await makeUser()).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `rep-sales-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Reporter",
    role: "admin",
  });
}

async function makeCustomer(name = "Kund AB") {
  return salesService.createCustomer({ name, active: true });
}

async function makeArticle(name = "Rapportartikel") {
  return articleService.createArticle({
    articleNumber: `REP-SALES-${crypto.randomUUID()}`,
    name,
    type: "manufactured",
    active: true,
  });
}

const currentMonth = () => new Date().toLocaleDateString("sv-SE").slice(0, 7);

describe("reports service — sales statistics: month grouping", () => {
  it("sums issued invoices, subtracts a credit note, and excludes draft/cancelled invoices", async () => {
    const customer = await makeCustomer();

    // Issued invoice: 2 × 100 = 200 net.
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Vara", quantity: 2, unitPrice: 100 }] },
      issuedBy
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    // Credit note for 1 × 100 = 100 net, subtracted from the total.
    const credit = await invoiceService.createCredit(
      issued!.id,
      { rows: [{ description: "Retur", quantity: 1, unitPrice: 100 }] },
      issuedBy
    );
    await invoiceService.issue(credit!.id, issuedBy);

    // A draft that's never issued must not count.
    await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Utkast", quantity: 5, unitPrice: 1000 }] },
      issuedBy
    );

    // A draft that gets cancelled must not count either.
    const toCancel = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Makulerad", quantity: 5, unitPrice: 1000 }] },
      issuedBy
    );
    await invoiceService.cancel(toCancel!.id);

    const result = await reportsService.getSalesStatistics({ groupBy: "month" });

    expect(result.groupBy).toBe("month");
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.key).toBe(currentMonth());
    expect(row.label).toBe(currentMonth());
    expect(row.netAmount).toBe(100); // 200 - 100
    expect(row.quantity).toBeNull();
    expect(row.invoiceCount).toBe(2); // the invoice + its credit note
    expect(result.totalNet).toBe(100);
  });

  it("returns a BOM-prefixed, semicolon-separated CSV with Swedish headers", async () => {
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Vara", quantity: 1, unitPrice: 50 }] },
      issuedBy
    );
    await invoiceService.issue(draft!.id, issuedBy);

    const result = await reportsService.getSalesStatistics({ groupBy: "month" });
    const csv = buildSalesStatisticsCsv(result);

    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("Grupp;Nettobelopp;Antal;Antal fakturor");
    expect(csv).toContain(`${currentMonth()};50,00;;1`);
  });
});

describe("reports service — sales statistics: customer grouping", () => {
  it("buckets net amount per customer, sorted by amount descending", async () => {
    const big = await makeCustomer("Stor Kund AB");
    const small = await makeCustomer("Liten Kund AB");

    const draftBig = await invoiceService.create(
      { customerId: big.id, rows: [{ description: "Stor order", quantity: 1, unitPrice: 1000 }] },
      issuedBy
    );
    await invoiceService.issue(draftBig!.id, issuedBy);

    const draftSmall = await invoiceService.create(
      { customerId: small.id, rows: [{ description: "Liten order", quantity: 1, unitPrice: 100 }] },
      issuedBy
    );
    await invoiceService.issue(draftSmall!.id, issuedBy);

    const result = await reportsService.getSalesStatistics({ groupBy: "customer" });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.key).toBe(big.id);
    expect(result.rows[0]!.label).toBe("Stor Kund AB");
    expect(result.rows[0]!.netAmount).toBe(1000);
    expect(result.rows[1]!.key).toBe(small.id);
    expect(result.rows[1]!.netAmount).toBe(100);
  });
});

describe("reports service — sales statistics: article grouping", () => {
  it("buckets net amount/quantity per article and groups free-text rows as (Fritextrader)", async () => {
    const customer = await makeCustomer();
    const article = await makeArticle("Kalkylartikel");

    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "Artikelrad", articleId: article.id, quantity: 3, unitPrice: 50 }, // 150 net
          { description: "Frakt", quantity: 1, unitPrice: 40 }, // 40 net, no article
        ],
      },
      issuedBy
    );
    await invoiceService.issue(draft!.id, issuedBy);

    const result = await reportsService.getSalesStatistics({ groupBy: "article" });

    expect(result.rows).toHaveLength(2);
    const articleRow = result.rows.find((r) => r.key === article.id)!;
    expect(articleRow.label).toBe(`${article.articleNumber} — ${article.name}`);
    expect(articleRow.netAmount).toBe(150);
    expect(articleRow.quantity).toBe(3);

    const freeTextRow = result.rows.find((r) => r.key === "null")!;
    expect(freeTextRow.label).toBe("(Fritextrader)");
    expect(freeTextRow.netAmount).toBe(40);
    expect(freeTextRow.quantity).toBe(1);
  });
});
