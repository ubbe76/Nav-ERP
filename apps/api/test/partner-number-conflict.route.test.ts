import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";

// Package 5 (uppföljningssvepet): route-level coverage for the customer/
// supplier duplicate-number 409s (sales.routes.ts / purchase.routes.ts POST
// /customers and POST /suppliers) — previously only the service layer's
// DuplicateCustomerNumberError/DuplicateSupplierNumberError were covered
// (customer/supplier duplicate-number unit tests), not the route mapping or
// the derived `code`. App-boot pattern copied from list-csv-export.test.ts —
// bare Fastify app, real services built from db, no auth (these routes carry
// no requireRole/requireAuth of their own — requireAuth is app.ts's job).

const articleService = createArticleService(createArticleRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));

const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail() {
    /* no-op — these tests never send mail */
  },
});
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const stockService = createStockService(createStockRepository(db));

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

const app = Fastify();
app.register(salesRoutes, { service: salesService });
app.register(purchaseRoutes, { service: purchaseService });

const TRUNCATE = sql`TRUNCATE purchase_order_rows, purchase_orders, suppliers, sales_order_rows, sales_orders, customers, delivery_terms, payment_terms, carriers, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

describe("POST /customers", () => {
  it("409s duplicate-customer-number when the explicit customerNumber already exists", async () => {
    await salesService.createCustomer({ name: "Första Kund AB", customerNumber: "K-DUP-1", active: true });

    const res = await app.inject({
      method: "POST",
      url: "/customers",
      payload: { name: "Andra Kund AB", customerNumber: "K-DUP-1" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("duplicate-customer-number");
  });
});

describe("POST /suppliers", () => {
  it("409s duplicate-supplier-number when the explicit supplierNumber already exists", async () => {
    await purchaseService.createSupplier({ name: "Första Leverantör AB", supplierNumber: "L-DUP-1", active: true });

    const res = await app.inject({
      method: "POST",
      url: "/suppliers",
      payload: { name: "Andra Leverantör AB", supplierNumber: "L-DUP-1" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("duplicate-supplier-number");
  });
});
