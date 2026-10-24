import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { db, vatCodes } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { invoiceRoutes } from "../src/modules/sales/routes/invoice.routes.js";
import { salesRoutes } from "../src/modules/sales/routes/sales.routes.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createPurchaseService } from "../src/modules/purchase/service/purchase.service.js";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { supplierInvoiceRoutes } from "../src/modules/purchase/routes/supplier-invoice.routes.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { resetVatCodes, vatCodeId } from "./helpers/vat-codes.js";

// Momskoder steg 2 — the HTTP contract of the document fields and their
// errors on a bare app (permissions are permissions-coverage's; steg 2 adds
// no routes): invoice rows' vatCodeId/vatCode/deliveryDate, Utfärda's 409
// vat-number-required, the customer's reverseChargeConstruction/
// vatTreatment, the supplier's country/defaultVatCode and the supplier
// invoice's vatCode/reverseVat — invalid codes are 400 invalid-vat-code with
// `reason`.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const documentPdfService = createDocumentPdfService(systemService);
const auditRepository = createAuditRepository(db);
const poster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
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
const invoiceService = createInvoiceService(createInvoiceRepository(db), mailService, documentPdfService, poster, auditRepository, articleService);
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  registerService,
  mailService,
  documentPdfService,
  articleService,
  systemService,
  {
    reportOperationQuantities: async () => {
      throw new Error("not wired");
    },
    assertMaterialBeforeSubcontractReceipt: async () => {},
    undoPurchaseReceiptReportInTx: async () => {
      throw new Error("not wired");
    },
    updateRoutingOperation: async () => {
      throw new Error("not wired");
    },
  }
);
const supplierInvoiceService = createSupplierInvoiceService(createSupplierInvoiceRepository(db), poster, auditRepository);

const TRUNCATE = sql`TRUNCATE supplier_invoice_files, posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, supplier_invoice_rows, supplier_invoices, supplier_contacts, suppliers, invoice_documents, invoice_rows, invoices, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, bom_components, articles, audit_log, users CASCADE`;
const TODAY = new Date().toLocaleDateString("sv-SE");

let userId: string;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
  await setupPostingBaseline();
  userId = (await authRepo.create({ email: `vcd-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Route", role: "admin" })).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
});

function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: userId, email: "test@example.com", name: "Testanvändare", role: "admin" } as never;
  });
  app.register(invoiceRoutes, { service: invoiceService });
  app.register(salesRoutes, { service: salesService } as never);
  app.register(purchaseRoutes, { service: purchaseService });
  app.register(supplierInvoiceRoutes, { service: supplierInvoiceService });
  return app;
}

describe("customer invoices", () => {
  it("POST /invoices answers the rows' vatCode and deliveryDate; GET adds buyerVatNumber and vatNumberProblem", async () => {
    const app = buildApp();
    const customer = await app.inject({ method: "POST", url: "/customers", payload: { name: "Kunde GmbH", country: "DE", vatNumber: "DE123456789" } });
    expect(customer.statusCode).toBe(201);
    expect(customer.json()).toMatchObject({ reverseChargeConstruction: false, vatTreatment: "eu" });

    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      payload: { customerId: customer.json().id, rows: [{ description: "Bänkskiva", quantity: 1, unitPrice: 100, deliveryDate: "2026-02-03" }] },
    });
    expect(res.statusCode).toBe(201);
    const invoice = res.json();
    expect(invoice.rows[0].vatCode).toEqual({
      id: await vatCodeId("EUV"),
      code: "EUV",
      name: "Varor till annat EU-land",
      rate: 0,
      invoiceText: "Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)",
    });
    expect(invoice.rows[0].vatCodeId).toBe(await vatCodeId("EUV"));
    expect(invoice.rows[0].deliveryDate).toBe("2026-02-03");
    expect(invoice.buyerVatNumber).toBe("DE123456789");
    expect(invoice.vatNumberProblem).toBeNull();

    // The row PATCH takes vatCodeId and deliveryDate.
    const patched = await app.inject({
      method: "PATCH",
      url: `/invoices/${invoice.id}/rows/${invoice.rows[0].id}`,
      payload: { vatCodeId: await vatCodeId("MP25"), deliveryDate: null },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ vatCodeId: await vatCodeId("MP25"), vatRate: "25.00", vatAmount: "25.00", deliveryDate: null });
    const bad = await app.inject({ method: "PATCH", url: `/invoices/${invoice.id}/rows/${invoice.rows[0].id}`, payload: { deliveryDate: "3.2.2026" } });
    expect(bad.statusCode).toBe(400);
  });

  it("400 invalid-vat-code with reason for an unknown, purchase or inactive code; 404 for an unknown customer", async () => {
    const app = buildApp();
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true } as never);
    const post = async (vatCodeIdValue: string) =>
      app.inject({
        method: "POST",
        url: "/invoices",
        payload: { customerId: customer.id, rows: [{ description: "Rad", quantity: 1, unitPrice: 1, vatCodeId: vatCodeIdValue }] },
      });
    const unknown = await post(crypto.randomUUID());
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "invalid-vat-code", reason: "unknown" });
    const purchase = await post(await vatCodeId("IEUV25"));
    expect(purchase.json()).toMatchObject({ code: "invalid-vat-code", reason: "not_applicable" });
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "EXT"));
    const inactive = await post(await vatCodeId("EXT"));
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json()).toMatchObject({ code: "invalid-vat-code", reason: "inactive" });

    const noCustomer = await app.inject({ method: "POST", url: "/invoices", payload: { customerId: crypto.randomUUID(), rows: [] } });
    expect(noCustomer.statusCode).toBe(404);
  });

  it("409 vat-number-required with reason on Utfärda", async () => {
    const app = buildApp();
    const customer = await salesService.createCustomer({ name: "Kunde GmbH", country: "DE", active: true } as never);
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Rad", quantity: 1, unitPrice: 100, vatCodeId: await vatCodeId("EUT") }] },
      userId
    );
    const view = await app.inject({ url: `/invoices/${draft!.id}` });
    expect(view.json().vatNumberProblem).toEqual({ reason: "missing", code: "EUT" });
    const res = await app.inject({ method: "POST", url: `/invoices/${draft!.id}/issue` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "Kunden saknar momsregistreringsnummer — det krävs för EU-försäljning och omvänd betalningsskyldighet",
      code: "vat-number-required",
      reason: "missing",
    });
  });
});

describe("customers", () => {
  it("PATCH /customers/:id takes reverseChargeConstruction, GET answers vatTreatment", async () => {
    const app = buildApp();
    const customer = await salesService.createCustomer({ name: "Bygg AB", active: true } as never);
    const res = await app.inject({ method: "PATCH", url: `/customers/${customer.id}`, payload: { reverseChargeConstruction: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().reverseChargeConstruction).toBe(true);
    const got = await app.inject({ url: `/customers/${customer.id}` });
    expect(got.json()).toMatchObject({ reverseChargeConstruction: true, vatTreatment: "domestic" });
    const bad = await app.inject({ method: "PATCH", url: `/customers/${customer.id}`, payload: { reverseChargeConstruction: "ja" } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("suppliers and supplier invoices", () => {
  it("POST/PATCH /suppliers take country and defaultVatCodeId, GET answers defaultVatCode; a sales code is 400", async () => {
    const app = buildApp();
    const created = await app.inject({ method: "POST", url: "/suppliers", payload: { name: "Lieferant GmbH", country: "de", currency: "EUR" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ country: "DE", defaultVatCodeId: null, defaultVatCode: { code: "IEUV25", rate: 25, derived: true } });
    const id = created.json().id;

    const own = await app.inject({ method: "PATCH", url: `/suppliers/${id}`, payload: { defaultVatCodeId: await vatCodeId("IEUT") } });
    expect(own.statusCode).toBe(200);
    expect((await app.inject({ url: `/suppliers/${id}` })).json().defaultVatCode).toMatchObject({ code: "IEUT", derived: false });

    const sales = await app.inject({ method: "PATCH", url: `/suppliers/${id}`, payload: { defaultVatCodeId: await vatCodeId("EUV") } });
    expect(sales.statusCode).toBe(400);
    expect(sales.json()).toMatchObject({ code: "invalid-vat-code", reason: "not_applicable" });
    const country = await app.inject({ method: "PATCH", url: `/suppliers/${id}`, payload: { country: "Tyskland" } });
    expect(country.statusCode).toBe(400);
  });

  it("POST/PATCH /supplier-invoices take vatCodeId on the header and the rows; GET answers vatCode and reverseVat", async () => {
    const app = buildApp();
    const supplier = await purchaseService.createSupplier({ name: "Lieferant GmbH", currency: "SEK", country: "DE", active: true } as never);
    const res = await app.inject({
      method: "POST",
      url: "/supplier-invoices",
      payload: {
        supplierId: supplier.id,
        invoiceNumber: "R-77",
        invoiceDate: TODAY,
        netAmount: 1000,
        grossAmount: 1000,
        rows: [{ description: "Konsult", quantity: 1, unitPrice: 400, vatCodeId: await vatCodeId("IEUT") }, { description: "Plåt", quantity: 1, unitPrice: 600 }],
      },
    });
    expect(res.statusCode).toBe(201);
    const invoice = res.json();
    expect(invoice.vatCode).toMatchObject({ code: "IEUV25", rate: 25 });
    expect(invoice.rows.map((r: { vatCode: { code: string } | null }) => r.vatCode?.code ?? null)).toEqual(["IEUT", null]);
    expect(invoice.reverseVat).toEqual([
      { code: "IEUV25", base: 600, vat: 150 },
      { code: "IEUT", base: 400, vat: 100 },
    ]);

    const header = await app.inject({ method: "PATCH", url: `/supplier-invoices/${invoice.id}`, payload: { vatCodeId: await vatCodeId("OB") } });
    expect(header.statusCode).toBe(400);
    expect(header.json()).toMatchObject({ code: "invalid-vat-code", reason: "not_applicable" });
    const row = await app.inject({
      method: "PATCH",
      url: `/supplier-invoices/${invoice.id}/rows/${invoice.rows[0].id}`,
      payload: { vatCodeId: null },
    });
    expect(row.statusCode).toBe(200);
    const after = (await app.inject({ url: `/supplier-invoices/${invoice.id}` })).json();
    expect(after.reverseVat).toEqual([{ code: "IEUV25", base: 1000, vat: 250 }]);
  });
});
