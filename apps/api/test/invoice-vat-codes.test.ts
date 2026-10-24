import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accounts, db, deliveries, deliveryRows, invoiceRows, vatCodes, verificationRows } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { VatNumberRequiredError } from "../src/modules/sales/service/sales.errors.js";
import { InvalidVatCodeError } from "../src/modules/economy/service/document-vat-code.js";
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
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { resetVatCodes, vatCodeId } from "./helpers/vat-codes.js";

// Momskoder steg 2 (spec 4.1–4.5): the customer invoice rows get their
// momskod from salesVatCode (explicit vatCodeId wins, a bare vatRate is its
// domestic code), credit rows mirror their source row's code and
// leveransdatum, Utfärda refuses an EU sale / OB without a well-formed
// momsregistreringsnummer, and the PDFs print the buyer's number, the codes'
// texts, a VAT summary per code and "Levererad <date>".

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
const documentPdfService = createDocumentPdfService(systemService);
const auditRepository = createAuditRepository(db);
let freightArticleId: string | null = null;
const freightReader = { freightArticleId: async () => freightArticleId };
const salesService = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query),
  auditRepository,
  undefined,
  undefined,
  undefined,
  undefined,
  freightReader
);
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  documentPdfService,
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  auditRepository,
  articleService,
  freightReader
);

const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_documents, invoice_rows, invoices, audit_log, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  await resetVatCodes();
  await setupPostingBaseline();
  freightArticleId = null;
  user = await authRepo.create({
    email: `vat-inv-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Fakturerare",
    role: "admin",
  });
});

afterAll(async () => {
  await db.execute(TABLES);
  await resetVatCodes();
});

type CustomerOverrides = Partial<Parameters<typeof salesService.createCustomer>[0]>;
async function makeCustomer(overrides: CustomerOverrides = {}) {
  return salesService.createCustomer({
    name: "Kund AB",
    active: true,
    country: "SE",
    discountPercent: 0,
    collectiveInvoicing: false,
    privatePerson: false,
    reverseChargeConstruction: false,
    showConfigurationPrices: false,
    invoiceDelivery: "email",
    ...overrides,
  } as Parameters<typeof salesService.createCustomer>[0]);
}

async function makeArticle(type: "manufactured" | "purchased" | "service" = "purchased", vatRate?: number) {
  return articleService.createArticle({
    articleNumber: `ART-VAT-${crypto.randomUUID().slice(0, 8)}`,
    name: type === "service" ? "Montagetjänst" : "Bänkskiva",
    type,
    active: true,
    ...(vatRate !== undefined ? { vatRate } : {}),
  } as Parameters<typeof articleService.createArticle>[0]);
}

async function codeOfRow(rowId: string) {
  const [row] = await db
    .select({ code: vatCodes.code, vatRate: invoiceRows.vatRate, vatAmount: invoiceRows.vatAmount })
    .from(invoiceRows)
    .innerJoin(vatCodes, eq(vatCodes.id, invoiceRows.vatCodeId))
    .where(eq(invoiceRows.id, rowId));
  return row!;
}

// A confirmed order delivered in full, ready to invoice.
async function deliveredOrder(customerId: string, articleId: string, quantity = 4, delivered = quantity) {
  const location = await stockService.createLocation({
    warehouseId: (await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID().slice(0, 6)}`, active: true })).id,
    name: "A1",
    active: true,
  });
  await stockService.recordTransaction({ articleId, locationId: location.id, quantityDelta: 100, transactionType: "inventory_adjustment" });
  const { order, rows } = await salesService.createQuote(
    { customerId, rows: [{ articleId, quantity, unitPrice: 100 }], confirm: true },
    user.id
  );
  await salesService.startProduction(order.id);
  const delivery = await salesService.deliverBatch(
    order.id,
    { locationId: location.id, rows: [{ rowId: rows[0]!.id, quantity: delivered }] },
    user.id
  );
  return { order, row: rows[0]!, location, delivery };
}

describe("invoice rows — derived momskod (create/addRow)", () => {
  it("derives EUV/EUT for an EU customer with a VAT number, domestic without one", async () => {
    const eu = await makeCustomer({ name: "Kunde GmbH", country: "DE", vatNumber: "DE123456789" });
    const goods = await makeArticle("purchased");
    const service = await makeArticle("service");
    const invoice = await invoiceService.create(
      {
        customerId: eu.id,
        rows: [
          { articleId: goods.id, description: "Bänkskiva", quantity: 1, unitPrice: 1000 },
          { articleId: service.id, description: "Montage", quantity: 2, unitPrice: 500 },
          { description: "Fri rad", quantity: 1, unitPrice: 50 },
        ],
      },
      user.id
    );
    expect(invoice!.rows.map((r) => r.vatCode.code)).toEqual(["EUV", "EUT", "EUV"]);
    expect(invoice!.rows[0]!.vatCode).toEqual({
      id: await vatCodeId("EUV"),
      code: "EUV",
      name: "Varor till annat EU-land",
      rate: 0,
      invoiceText: "Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)",
    });
    expect(invoice!.rows.every((r) => r.vatRate === "0.00" && r.vatAmount === "0.00")).toBe(true);

    const noNumber = await makeCustomer({ name: "Ohne Nummer", country: "DE" });
    const domestic = await invoiceService.create(
      { customerId: noNumber.id, rows: [{ articleId: goods.id, description: "Bänkskiva", quantity: 1, unitPrice: 1000 }] },
      user.id
    );
    expect(domestic!.rows[0]!.vatCode.code).toBe("MP25");
    expect(domestic!.rows[0]!.vatAmount).toBe("250.00");
  });

  it("derives OB for a service to a construction customer, EXV/EXT outside the EU, domestic for a private person", async () => {
    const service = await makeArticle("service");
    const goods = await makeArticle("purchased", 12);
    const bygg = await makeCustomer({ name: "Bygg AB", reverseChargeConstruction: true, vatNumber: "SE556677889901" });
    const ob = await invoiceService.create(
      {
        customerId: bygg.id,
        rows: [
          { articleId: service.id, description: "Montage", quantity: 1, unitPrice: 100 },
          { articleId: goods.id, description: "Bänkskiva", quantity: 1, unitPrice: 100 },
        ],
      },
      user.id
    );
    expect(ob!.rows.map((r) => r.vatCode.code)).toEqual(["OB", "MP12"]);
    expect(ob!.rows[1]!.vatAmount).toBe("12.00");

    const norway = await makeCustomer({ name: "Norsk AS", country: "NO" });
    const exp = await invoiceService.create(
      {
        customerId: norway.id,
        rows: [
          { articleId: goods.id, description: "Bänkskiva", quantity: 1, unitPrice: 100 },
          { articleId: service.id, description: "Montage", quantity: 1, unitPrice: 100 },
        ],
      },
      user.id
    );
    expect(exp!.rows.map((r) => r.vatCode.code)).toEqual(["EXV", "EXT"]);

    const privateDk = await makeCustomer({ name: "Privat", country: "DK", privatePerson: true });
    const priv = await invoiceService.create(
      { customerId: privateDk.id, rows: [{ articleId: goods.id, description: "Bänkskiva", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    expect(priv!.rows[0]!.vatCode.code).toBe("MP12");

    // A private person outside the EU: goods are export whoever buys them
    // (artikel 146), a service is svensk moms.
    const privateNo = await makeCustomer({ name: "Privat Norge", country: "NO", privatePerson: true });
    const privExport = await invoiceService.create(
      {
        customerId: privateNo.id,
        rows: [
          { articleId: goods.id, description: "Bänkskiva", quantity: 1, unitPrice: 100 },
          { articleId: service.id, description: "Montage", quantity: 1, unitPrice: 100 },
        ],
      },
      user.id
    );
    expect(privExport!.rows.map((r) => [r.vatCode.code, r.vatAmount])).toEqual([
      ["EXV", "0.00"],
      ["MP25", "25.00"],
    ]);
  });

  it("counts the freight article as goods even when it is a service article", async () => {
    const freight = await makeArticle("service");
    freightArticleId = freight.id;
    const eu = await makeCustomer({ country: "FR", vatNumber: "FR12345678901" });
    const invoice = await invoiceService.create(
      { customerId: eu.id, rows: [{ articleId: freight.id, description: "Frakt", quantity: 1, unitPrice: 300 }] },
      user.id
    );
    expect(invoice!.rows[0]!.vatCode.code).toBe("EUV");
  });

  it("lets an explicit vatCodeId win, and a bare vatRate mean its domestic code", async () => {
    const eu = await makeCustomer({ country: "DE", vatNumber: "DE123456789" });
    const goods = await makeArticle("purchased");
    const invoice = await invoiceService.create(
      {
        customerId: eu.id,
        rows: [
          { articleId: goods.id, description: "Explicit", quantity: 1, unitPrice: 100, vatCodeId: await vatCodeId("MP6") },
          { articleId: goods.id, description: "Legacy 25", quantity: 1, unitPrice: 100, vatRate: 25 },
          { articleId: goods.id, description: "Legacy 0", quantity: 1, unitPrice: 100, vatRate: 0 },
          // vatCodeId wins over vatRate.
          { articleId: goods.id, description: "Both", quantity: 1, unitPrice: 100, vatRate: 25, vatCodeId: await vatCodeId("EXV") },
        ],
      },
      user.id
    );
    expect(invoice!.rows.map((r) => [r.vatCode.code, r.vatRate, r.vatAmount])).toEqual([
      ["MP6", "6.00", "6.00"],
      ["MP25", "25.00", "25.00"],
      ["MF", "0.00", "0.00"],
      ["EXV", "0.00", "0.00"],
    ]);
  });

  it("refuses an unknown, inactive or purchase code with InvalidVatCodeError", async () => {
    const customer = await makeCustomer();
    const row = { description: "Rad", quantity: 1, unitPrice: 100 };
    await expect(
      invoiceService.create({ customerId: customer.id, rows: [{ ...row, vatCodeId: crypto.randomUUID() }] }, user.id)
    ).rejects.toMatchObject({ name: "InvalidVatCodeError", reason: "unknown" });
    await expect(
      invoiceService.create({ customerId: customer.id, rows: [{ ...row, vatCodeId: await vatCodeId("IEUV25") }] }, user.id)
    ).rejects.toMatchObject({ reason: "not_applicable" });
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "EXV"));
    await expect(
      invoiceService.create({ customerId: customer.id, rows: [{ ...row, vatCodeId: await vatCodeId("EXV") }] }, user.id)
    ).rejects.toBeInstanceOf(InvalidVatCodeError);
    // A derived code that has been deactivated is refused too — never posted silently.
    const norway = await makeCustomer({ country: "NO" });
    await expect(invoiceService.create({ customerId: norway.id, rows: [row] }, user.id)).rejects.toMatchObject({ reason: "inactive" });
  });

  it("addRow derives, PATCH keeps the row's code unless vatCodeId or vatRate is sent", async () => {
    const eu = await makeCustomer({ country: "DE", vatNumber: "DE123456789" });
    const goods = await makeArticle("purchased");
    const draft = await invoiceService.create({ customerId: eu.id, rows: [] }, user.id);
    const added = await invoiceService.addRow(draft!.id, { articleId: goods.id, description: "Bänkskiva", quantity: 2, unitPrice: 100 }, user.id);
    expect((await codeOfRow(added.id)).code).toBe("EUV");

    await invoiceService.updateRow(draft!.id, added.id, { quantity: 3 }, user.id);
    expect((await codeOfRow(added.id)).code).toBe("EUV");

    // The code may be deactivated meanwhile — an unrelated edit keeps it.
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "EUV"));
    await invoiceService.updateRow(draft!.id, added.id, { description: "Bänkskiva XL" }, user.id);
    expect((await codeOfRow(added.id)).code).toBe("EUV");

    await invoiceService.updateRow(draft!.id, added.id, { vatCodeId: await vatCodeId("MP25") }, user.id);
    expect(await codeOfRow(added.id)).toEqual({ code: "MP25", vatRate: "25.00", vatAmount: "75.00" });
    await invoiceService.updateRow(draft!.id, added.id, { vatRate: 12 }, user.id);
    expect((await codeOfRow(added.id)).code).toBe("MP12");
  });

  it("offers the derived code on the invoiceable order rows and bills them with it (samlingsfaktura too)", async () => {
    const eu = await makeCustomer({ country: "DE", vatNumber: "DE123456789", collectiveInvoicing: true });
    const goods = await makeArticle("manufactured");
    await deliveredOrder(eu.id, goods.id);
    const [order] = await invoiceService.listInvoiceableOrders(eu.id);
    expect(order!.rows[0]!.vatCode).toMatchObject({ code: "EUV", rate: 0 });
    expect(order!.rows[0]!.vatCodeId).toBe(await vatCodeId("EUV"));

    const { results } = await invoiceService.runCollectiveInvoicing({ customerIds: [eu.id], issue: false }, user.id);
    expect(results[0]!.status).toBe("draft");
    const invoice = await invoiceService.getInvoice(results[0]!.invoiceId!);
    expect(invoice!.rows.map((r) => r.vatCode.code)).toEqual(["EUV"]);
  });
});

describe("invoice rows — leveransdatum", () => {
  it("takes the order row's last non-undone delivery day (Stockholm) and lets PATCH set or clear it", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle("purchased");
    const { order, row, location } = await deliveredOrder(customer.id, goods.id, 6, 2);
    // Two more deliveries on later days: the last one is undone again.
    await db.update(deliveries).set({ deliveredAt: new Date("2026-03-02T09:00:00Z") });
    const second = await salesService.deliverBatch(order.id, { locationId: location.id, rows: [{ rowId: row.id, quantity: 2 }] }, user.id);
    // 23:30 UTC on March 9 is March 10 in Stockholm.
    await db.update(deliveries).set({ deliveredAt: new Date("2026-03-09T23:30:00Z") }).where(eq(deliveries.id, second.deliveryId));
    const third = await salesService.deliverBatch(order.id, { locationId: location.id, rows: [{ rowId: row.id, quantity: 2 }] }, user.id);
    await db.update(deliveries).set({ deliveredAt: new Date("2026-03-20T10:00:00Z") }).where(eq(deliveries.id, third.deliveryId));
    const [thirdRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, third.deliveryId));
    await salesService.undoDeliveryRow(order.id, third.deliveryId, thirdRow!.id, user.id);

    const invoice = await invoiceService.create(
      { customerId: customer.id, rows: [{ articleId: goods.id, salesOrderRowId: row.id, description: "Bänkskiva", quantity: 4, unitPrice: 100 }] },
      user.id
    );
    const invoiceRow = invoice!.rows[0]!;
    expect(invoiceRow.deliveryDate).toBe("2026-03-10");

    // An unrelated PATCH keeps it, an explicit one sets or clears it.
    await invoiceService.updateRow(invoice!.id, invoiceRow.id, { quantity: 3 }, user.id);
    expect((await invoiceService.getInvoice(invoice!.id))!.rows[0]!.deliveryDate).toBe("2026-03-10");
    await invoiceService.updateRow(invoice!.id, invoiceRow.id, { deliveryDate: "2026-03-12" }, user.id);
    expect((await invoiceService.getInvoice(invoice!.id))!.rows[0]!.deliveryDate).toBe("2026-03-12");
    await invoiceService.updateRow(invoice!.id, invoiceRow.id, { deliveryDate: null }, user.id);
    expect((await invoiceService.getInvoice(invoice!.id))!.rows[0]!.deliveryDate).toBeNull();
  });

  it("is null on a row without an order link, and on an order row whose only delivery is undone", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle("purchased");
    const free = await invoiceService.create({ customerId: customer.id, rows: [{ description: "Fri", quantity: 1, unitPrice: 10 }] }, user.id);
    expect(free!.rows[0]!.deliveryDate).toBeNull();

    const { row, delivery, order } = await deliveredOrder(customer.id, goods.id, 2);
    const [dRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, delivery.deliveryId));
    const repo = createInvoiceRepository(db);
    expect(await repo.latestDeliveryDate(row.id)).not.toBeNull();
    await salesService.undoDeliveryRow(order.id, delivery.deliveryId, dRow!.id, user.id);
    expect(await repo.latestDeliveryDate(row.id)).toBeNull();
  });
});

describe("Utfärda — leveransdatum of a delivery undone after the draft row was made", () => {
  it("moves the date to the last live delivery day, keeps one that still stands and one set by hand", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle("purchased");
    const { order, row, location } = await deliveredOrder(customer.id, goods.id, 6, 2);
    await db.update(deliveries).set({ deliveredAt: new Date("2026-03-02T09:00:00Z") });
    const second = await salesService.deliverBatch(order.id, { locationId: location.id, rows: [{ rowId: row.id, quantity: 2 }] }, user.id);
    await db.update(deliveries).set({ deliveredAt: new Date("2026-03-10T09:00:00Z") }).where(eq(deliveries.id, second.deliveryId));

    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ articleId: goods.id, salesOrderRowId: row.id, description: "Bänkskiva", quantity: 2, unitPrice: 100 }] },
      user.id
    );
    expect(draft!.rows[0]!.deliveryDate).toBe("2026-03-10");

    // The later delivery is undone — still 2 delivered, so the draft's 2 do
    // not stop the undo — and the draft row now points at a day without a
    // delivery.
    const [secondRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, second.deliveryId));
    await salesService.undoDeliveryRow(order.id, second.deliveryId, secondRow!.id, user.id);
    expect((await invoiceService.getInvoice(draft!.id))!.rows[0]!.deliveryDate).toBe("2026-03-10");

    const issued = await invoiceService.issue(draft!.id, user.id);
    expect(issued!.rows[0]!.deliveryDate).toBe("2026-03-02");
    expect(pdfText((await invoiceService.renderPdf(issued!.id)).content)).toContain("Levererad 2026-03-02");

    // A date that is still a live delivery day stays as it is.
    const third = await salesService.deliverBatch(order.id, { locationId: location.id, rows: [{ rowId: row.id, quantity: 2 }] }, user.id);
    await db.update(deliveries).set({ deliveredAt: new Date("2026-03-15T09:00:00Z") }).where(eq(deliveries.id, third.deliveryId));
    const kept = await invoiceService.create(
      { customerId: customer.id, rows: [{ articleId: goods.id, salesOrderRowId: row.id, description: "Bänkskiva", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    await invoiceService.updateRow(kept!.id, kept!.rows[0]!.id, { deliveryDate: "2026-03-02" }, user.id);
    expect((await invoiceService.issue(kept!.id, user.id))!.rows[0]!.deliveryDate).toBe("2026-03-02");

    // So does a date set by hand that never was a delivery day of the row.
    const manual = await invoiceService.create(
      { customerId: customer.id, rows: [{ articleId: goods.id, salesOrderRowId: row.id, description: "Bänkskiva", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    await invoiceService.updateRow(manual!.id, manual!.rows[0]!.id, { deliveryDate: "2026-03-05" }, user.id);
    expect((await invoiceService.issue(manual!.id, user.id))!.rows[0]!.deliveryDate).toBe("2026-03-05");

    // A free row (no order link) is never touched.
    const free = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Fri", quantity: 1, unitPrice: 10, deliveryDate: "2026-01-05" }] },
      user.id
    );
    expect((await invoiceService.issue(free!.id, user.id))!.rows[0]!.deliveryDate).toBe("2026-01-05");
  });

  it("clears the date when the order row has no live delivery left", async () => {
    const customer = await makeCustomer();
    const goods = await makeArticle("purchased");
    const { order, row, location } = await deliveredOrder(customer.id, goods.id, 4, 2);
    // The draft is made against the order row before anything else
    // happens; then the only delivery is undone and the row redelivered
    // later than the invoice date can see (a future day).
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ articleId: goods.id, salesOrderRowId: row.id, description: "Bänkskiva", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    expect(draft!.rows[0]!.deliveryDate).not.toBeNull();
    const second = await salesService.deliverBatch(order.id, { locationId: location.id, rows: [{ rowId: row.id, quantity: 2 }] }, user.id);
    const [first] = await db
      .select()
      .from(deliveryRows)
      .where(and(eq(deliveryRows.salesOrderRowId, row.id), sql`${deliveryRows.deliveryId} <> ${second.deliveryId}`));
    await salesService.undoDeliveryRow(order.id, first!.deliveryId, first!.id, user.id);
    await db.update(deliveries).set({ deliveredAt: new Date("2099-01-01T09:00:00Z") }).where(eq(deliveries.id, second.deliveryId));

    expect((await invoiceService.issue(draft!.id, user.id))!.rows[0]!.deliveryDate).toBeNull();
  });
});

describe("credit notes — mirror the source row's momskod and leveransdatum", () => {
  it("copies vat_code_id and delivery_date, even when the code was deactivated since", async () => {
    const eu = await makeCustomer({ country: "DE", vatNumber: "DE123456789" });
    const goods = await makeArticle("purchased");
    const { row } = await deliveredOrder(eu.id, goods.id, 2);
    const invoice = await invoiceService.create(
      { customerId: eu.id, rows: [{ articleId: goods.id, salesOrderRowId: row.id, description: "Bänkskiva", quantity: 2, unitPrice: 100 }] },
      user.id
    );
    await invoiceService.updateRow(invoice!.id, invoice!.rows[0]!.id, { deliveryDate: "2026-02-01" }, user.id);
    const issued = await invoiceService.issue(invoice!.id, user.id);

    // The customer's facts change and EUV is deactivated: the credit still
    // mirrors the source row.
    await salesService.updateCustomer(eu.id, { vatNumber: null });
    await db.update(vatCodes).set({ active: false }).where(eq(vatCodes.code, "EUV"));
    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    expect(credit!.rows[0]!.vatCode.code).toBe("EUV");
    expect(credit!.rows[0]!.deliveryDate).toBe("2026-02-01");

    // A partial credit linked to the same order row takes them too.
    await invoiceService.cancel(credit!.id, user.id);
    const partial = await invoiceService.createCredit(
      issued!.id,
      { rows: [{ articleId: goods.id, salesOrderRowId: row.id, description: "Retur", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    expect(partial!.rows[0]!.vatCode.code).toBe("EUV");
    expect(partial!.rows[0]!.deliveryDate).toBe("2026-02-01");
  });
});

describe("Utfärda — the buyer's momsregistreringsnummer", () => {
  it("refuses an EU sale without a VAT number, and rolls the FA number back", async () => {
    const customer = await makeCustomer({ country: "DE" });
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Bänkskiva", quantity: 1, unitPrice: 100, vatCodeId: await vatCodeId("EUV") }] },
      user.id
    );
    const view = await invoiceService.getInvoice(draft!.id);
    expect(view!.vatNumberProblem).toEqual({ reason: "missing", code: "EUV" });
    const err = await invoiceService.issue(draft!.id, user.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VatNumberRequiredError);
    expect(err).toMatchObject({ reason: "missing" });
    expect((err as Error).message).toBe(
      "Kunden saknar momsregistreringsnummer — det krävs för EU-försäljning och omvänd betalningsskyldighet"
    );
    const after = await invoiceService.getInvoice(draft!.id);
    expect(after!.status).toBe("draft");
    expect(after!.invoiceNumber).toBeNull();
  });

  it("refuses a VAT number without the buyer's country prefix, and an OB number not of the form SE…01", async () => {
    const de = await makeCustomer({ country: "DE", vatNumber: "123456789" });
    const euDraft = await invoiceService.create(
      { customerId: de.id, rows: [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    expect(euDraft!.rows[0]!.vatCode.code).toBe("EUV");
    await expect(invoiceService.issue(euDraft!.id, user.id)).rejects.toMatchObject({ reason: "eu_format" });

    const service = await makeArticle("service");
    const bygg = await makeCustomer({ name: "Bygg AB", reverseChargeConstruction: true, vatNumber: "556677-8899" });
    const obDraft = await invoiceService.create(
      { customerId: bygg.id, rows: [{ articleId: service.id, description: "Montage", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    await expect(invoiceService.issue(obDraft!.id, user.id)).rejects.toMatchObject({ reason: "ob_format" });

    // Corrected on the customer, the same draft issues and books 3231.
    await salesService.updateCustomer(bygg.id, { vatNumber: "SE556677889901" });
    expect((await invoiceService.getInvoice(obDraft!.id))!.vatNumberProblem).toBeNull();
    const issued = await invoiceService.issue(obDraft!.id, user.id);
    expect(issued!.status).toBe("issued");
    expect(issued!.vatNumber).toBe("SE556677889901");
    const posted = await db
      .select({ number: accounts.number, credit: verificationRows.credit })
      .from(verificationRows)
      .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
      .where(and(eq(verificationRows.verificationId, issued!.verificationId!), sql`${verificationRows.credit} > 0`));
    expect(posted).toEqual([{ number: "3231", credit: "100.00" }]);
  });

  it("accepts another member state's number for an EU sale, with a warning on the draft (artikel 138)", async () => {
    const de = await makeCustomer({ country: "DE", vatNumber: "ATU12345678" });
    const draft = await invoiceService.create({ customerId: de.id, rows: [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }] }, user.id);
    expect(draft!.rows[0]!.vatCode.code).toBe("EUV");
    const view = await invoiceService.getInvoice(draft!.id);
    expect(view!.vatNumberProblem).toBeNull();
    expect(view!.vatNumberWarning).toEqual({ reason: "eu_country_mismatch", code: "EUV", prefix: "AT", expectedPrefix: "DE" });
    const issued = await invoiceService.issue(draft!.id, user.id);
    expect(issued!.status).toBe("issued");
    // Only drafts carry the problem/warning.
    expect(issued!.vatNumberWarning).toBeNull();

    // A Swedish number is never an EU sale's.
    const se = await makeCustomer({ country: "DE", vatNumber: "SE556677889901" });
    const seDraft = await invoiceService.create({ customerId: se.id, rows: [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }] }, user.id);
    await expect(invoiceService.issue(seDraft!.id, user.id)).rejects.toMatchObject({ reason: "eu_format" });
  });

  it("a credit note is checked against, and stamps, the credited invoice's number — not the customer's current one", async () => {
    const de = await makeCustomer({ country: "DE", vatNumber: "DE123456789" });
    const draft = await invoiceService.create({ customerId: de.id, rows: [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }] }, user.id);
    const issued = await invoiceService.issue(draft!.id, user.id);
    expect(issued!.vatNumber).toBe("DE123456789");

    // The customer loses its number: a new invoice could not be an EU sale,
    // but the credit of the one issued to DE123456789 can.
    await salesService.updateCustomer(de.id, { vatNumber: null });
    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    const creditView = await invoiceService.getInvoice(credit!.id);
    expect(creditView!.buyerVatNumber).toBe("DE123456789");
    expect(creditView!.vatNumberProblem).toBeNull();
    const issuedCredit = await invoiceService.issue(credit!.id, user.id);
    expect(issuedCredit!.status).toBe("issued");
    expect(issuedCredit!.vatNumber).toBe("DE123456789");

    // And the other way round: a new number on the customer does not reach
    // the credit of an invoice issued without one.
    const plain = await makeCustomer({ country: "SE" });
    const plainIssued = await invoiceService.issue(
      (await invoiceService.create({ customerId: plain.id, rows: [{ description: "Rad", quantity: 1, unitPrice: 100 }] }, user.id))!.id,
      user.id
    );
    await salesService.updateCustomer(plain.id, { vatNumber: "SE556677889901" });
    const plainCredit = await invoiceService.createCredit(plainIssued!.id, {}, user.id);
    expect((await invoiceService.issue(plainCredit!.id, user.id))!.vatNumber).toBeNull();
  });

  it("issues an EU sale with a well-formed number", async () => {
    const de = await makeCustomer({ country: "DE", vatNumber: "de 123 456 789" });
    const draft = await invoiceService.create({ customerId: de.id, rows: [{ description: "Bänkskiva", quantity: 1, unitPrice: 100 }] }, user.id);
    const issued = await invoiceService.issue(draft!.id, user.id);
    expect(issued!.status).toBe("issued");
    expect(issued!.buyerVatNumber).toBe("de 123 456 789");
  });
});

describe("invoice PDF — momskoder", () => {
  it("prints Ert momsreg.nr, a summary line per code, the codes' texts and Levererad when it differs from the invoice date", async () => {
    const de = await makeCustomer({ name: "Kunde GmbH", country: "DE", vatNumber: "DE123456789" });
    const goods = await makeArticle("purchased");
    const { row } = await deliveredOrder(de.id, goods.id, 2);
    await db.update(vatCodes).set({ invoiceText: "Omsättning undantagen från skatteplikt" }).where(eq(vatCodes.code, "MF"));
    const draft = await invoiceService.create(
      {
        customerId: de.id,
        rows: [
          { articleId: goods.id, salesOrderRowId: row.id, description: "Bänkskiva", quantity: 2, unitPrice: 1000, deliveryDate: "2026-01-15" },
          { description: "Avgift", quantity: 1, unitPrice: 50, vatCodeId: await vatCodeId("MF") },
          { description: "Hantering", quantity: 1, unitPrice: 100, vatCodeId: await vatCodeId("MP25") },
        ],
      },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, user.id);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);

    expect(text).toContain("Ert momsreg.nr: DE123456789");
    expect(text).toContain("Levererad 2026-01-15");
    // One summary line per code: 25 % and the two 0 % codes by name.
    expect(text).toContain("Moms (25 %)");
    expect(text).toContain("Varor till annat EU-land");
    expect(text).toContain("Momsfri");
    // The texts, once each, in catalog order (MF before EUV).
    const mf = text.indexOf("Omsättning undantagen från skatteplikt");
    const euv = text.indexOf("Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)");
    expect(mf).toBeGreaterThan(-1);
    expect(euv).toBeGreaterThan(mf);
    expect(text.split("Unionsintern leverans").length).toBe(2);
  });

  it("leaves Levererad out when the delivery date is the invoice date, and prints no text for a plain domestic invoice", async () => {
    const customer = await makeCustomer();
    const today = new Date().toLocaleDateString("sv-SE");
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Bänkskiva", quantity: 1, unitPrice: 100, deliveryDate: today }] },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, user.id);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);
    expect(text).not.toContain("Levererad");
    expect(text).not.toContain("Ert momsreg.nr");
    expect(text).not.toContain("mervärdesskattedirektivet");
  });
});

describe("quote / order confirmation PDF — momskoder", () => {
  it("prints the EU sale's text on the quote of an EU customer", async () => {
    const de = await makeCustomer({ name: "Kunde GmbH", country: "DE", vatNumber: "DE123456789" });
    const goods = await makeArticle("purchased");
    const { order } = await salesService.createQuote({ customerId: de.id, rows: [{ articleId: goods.id, quantity: 1, unitPrice: 100 }] }, user.id);
    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(text).toContain("Unionsintern leverans (artikel 138 i mervärdesskattedirektivet)");
  });

  it("grosses a private person's prices up by the derived (domestic) rate and prints no text", async () => {
    const privat = await makeCustomer({ name: "Privat Person", country: "DE", privatePerson: true });
    const goods = await makeArticle("purchased", 12);
    const { order } = await salesService.createQuote({ customerId: privat.id, rows: [{ articleId: goods.id, quantity: 1, unitPrice: 100 }] }, user.id);
    const text = pdfText((await salesService.getSalesOrderPdf(order.id, "quote")).content);
    expect(text).toContain("Priser inklusive moms");
    expect(text).toContain("112,00");
    expect(text).not.toContain("mervärdesskattedirektivet");
  });
});
