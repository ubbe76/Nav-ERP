import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { listAccountsQuerySchema, listArticlesQuerySchema, listQuerySchema, listPurchaseOrdersQuerySchema } from "@navet/shared";
import { registerListCsvRoute } from "../src/modules/system/routes/csv-export.js";
import { CUSTOMER_CSV_COLUMNS } from "../src/modules/sales/service/export-columns.js";
import { PURCHASE_ORDER_CSV_COLUMNS } from "../src/modules/purchase/service/export-columns.js";
import { articleExportColumns } from "../src/modules/article/service/export-columns.js";
import { accountExportColumns } from "../src/modules/economy/service/export-columns.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { requireRole } from "../src/modules/auth/middleware/auth.middleware.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
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

// F2: end-to-end coverage for two of the purchase/sales CSV export endpoints
// (the route-helper mechanics themselves — pagination stripping, the 10k cap,
// preHandler passthrough — are already covered by csv-export-route.test.ts).
// These two exercise the real service + column defs against a real database,
// registered on a bare Fastify app the same way purchase.routes.ts/
// sales.routes.ts wire the /csv siblings (no auth — requireAuth is applied by
// app.ts's protected scope, not by these routes themselves).

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));

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
  (query) => resolvePrice(db, query)
);

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

// F2: /articles/csv (article module) and /accounts/csv (economy module,
// admin-only like its JSON sibling) — registered on the same bare app as the
// purchase/sales pair above.
const economyService = createEconomyService(createEconomyRepository(db), { log: async () => {} });

const app = Fastify();
registerListCsvRoute(app, {
  path: "/customers/csv",
  querySchema: listQuerySchema,
  filenameBase: "kunder",
  columns: CUSTOMER_CSV_COLUMNS,
  fetch: (q) => salesService.listCustomers(q),
});
registerListCsvRoute(app, {
  path: "/purchase-orders/csv",
  querySchema: listPurchaseOrdersQuerySchema,
  filenameBase: "inkopsordrar",
  columns: PURCHASE_ORDER_CSV_COLUMNS,
  fetch: (q) => purchaseService.listPurchaseOrders(q),
});
registerListCsvRoute(app, {
  path: "/articles/csv",
  querySchema: listArticlesQuerySchema,
  filenameBase: "artiklar",
  columns: articleExportColumns,
  fetch: (q) => articleService.listArticles(q),
});
registerListCsvRoute(app, {
  path: "/accounts/csv",
  preHandler: requireRole("admin"),
  querySchema: listAccountsQuerySchema,
  filenameBase: "kontoplan",
  columns: accountExportColumns,
  fetch: (q) => economyService.listAccounts(q),
});

const TRUNCATE = sql`TRUNCATE purchase_order_rows, purchase_orders, suppliers, sales_order_rows, sales_orders, customers, delivery_terms, payment_terms, carriers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `csv-export-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Exporter",
    role: "admin",
  });
}

describe("GET /customers/csv", () => {
  it("returns a BOM-prefixed, semicolon-separated CSV with Swedish headers and respects ?search=", async () => {
    await salesService.createCustomer({ name: "Skruv & Mutter AB", active: true });
    await salesService.createCustomer({ name: "Annan Kund AB", active: true });

    const res = await app.inject({ url: "/customers/csv?search=Skruv" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    // UTF-8 BOM + the header row, semicolon-separated, in the same order as
    // the web list's own Table columns (CustomersPageClient.tsx).
    expect(res.body.startsWith("﻿Kundnr;Namn;Kontaktperson;E-post;Telefon;Status;")).toBe(true);
    expect(res.body).toContain("Skruv & Mutter AB");
    expect(res.body).not.toContain("Annan Kund AB");
  });
});

describe("GET /purchase-orders/csv", () => {
  it("respects the ?status= filter", async () => {
    const user = await makeUser();
    const supplier = await purchaseService.createSupplier({ name: "CSV-Leverantör AB", active: true });
    const draftOrder = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const confirmedOrder = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    await purchaseService.confirm(confirmedOrder.id);

    const res = await app.inject({ url: "/purchase-orders/csv?status=confirmed" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(confirmedOrder.orderNumber);
    expect(res.body).not.toContain(draftOrder.orderNumber);
    expect(res.body).toContain("Bekräftad");
  });
});

describe("GET /articles/csv", () => {
  it("returns a BOM-prefixed CSV with Swedish headers and respects ?search=", async () => {
    await articleService.createArticle({ articleNumber: "A-CSV-1", name: "Skruv 8x40", type: "purchased" });
    await articleService.createArticle({ articleNumber: "A-CSV-2", name: "Annan artikel", type: "purchased" });

    const res = await app.inject({ url: "/articles/csv?search=Skruv" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    // Same column order as ArticlesPageClient.tsx's Table, plus the
    // export-only Ytbehandling/Färg columns appended at the end.
    expect(
      res.body.startsWith("﻿Artikelnummer;Benämning;Typ;Grupp;Enhet;Standardkostnad;Status;Ytbehandling;Färg")
    ).toBe(true);
    expect(res.body).toContain("Skruv 8x40");
    expect(res.body).not.toContain("Annan artikel");
  });
});

describe("GET /accounts/csv", () => {
  it("403s for a request without the admin role, mirroring GET /accounts' guard", async () => {
    const res = await app.inject({ url: "/accounts/csv" });
    expect(res.statusCode).toBe(403);
  });
});
