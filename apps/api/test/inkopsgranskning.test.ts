import {
  applyPaymentTolerance,
  createArticleSchema,
  createArticleSupplierSchema,
  createInquirySchema,
  createPlanningOrdersSchema,
  createPurchaseOrderSchema,
  createSupplierInvoiceSchema,
  createSupplierSchema,
  createWorkCenterSchema,
  sendDocumentEmailSchema,
} from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { eq, sql } from "drizzle-orm";
import {
  articleSuppliers,
  db,
  exchangeRates,
  inquiries,
  moOperations,
  purchaseOrderRows,
  purchaseOrders,
  stockTransactions,
  supplierContacts,
  supplierDeliveryAddresses,
  supplierInvoiceRows,
  supplierInvoices,
  type Tx,
} from "@navet/db";
import * as webTolerance from "../../web/lib/paymentTolerance.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { waitForLockWaiter } from "./helpers/year-end.js";
import { parsed } from "./helpers/parsed.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { ArticleNotFoundError, createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPlanningRepository } from "../src/modules/planning/repository/planning.repository.js";
import { createPlanningService } from "../src/modules/planning/service/planning.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { purchaseRoutes } from "../src/modules/purchase/routes/purchase.routes.js";
import { supplierInvoiceRoutes } from "../src/modules/purchase/routes/supplier-invoice.routes.js";
import {
  ArticleSupplierNotFoundError,
  ContactNotFoundError,
  createPurchaseService,
  DeliveryAddressNotFoundError,
  InvalidStatusTransitionError,
  LegoOperationArticleMismatchError,
  LegoOperationClosedError,
  MoOperationNotFoundError,
  NotLegoOperationError,
  PurchaseOrderExchangeRateError,
  PurchaseOrderNotFoundError,
} from "../src/modules/purchase/service/purchase.service.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";
import { createExchangeRateService, ExchangeRateUnavailableError } from "../src/modules/system/service/exchange-rates.js";
import { readPostingSettings } from "../src/modules/system/service/posting-settings.js";

// Inköpsgranskningen 2026-11-10: the rate of an order in another currency,
// the unlocked status reads and unconditional status writes, the demotion
// before a 404, the lego link on IO rows, unknown ids that became 500s and
// the float edge of the payment tolerance.

const TODAY = stockholmToday();
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const auditRepository = createAuditRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db), auditRepository);
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const salesRepository = createSalesRepository(db);
// What the fake SMTP server does while "sending" (the send-email race).
let onSend: (() => Promise<void>) | null = null;
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({
  async sendMail() {
    await onSend?.();
  },
}));
const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  testDocumentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  auditRepository,
  undefined,
  undefined,
  testSystemService
);
// The real rate service on the test database: manual rates only — Riksbanken
// never answers here.
const rates = createExchangeRateService({
  db,
  fetch: async () => {
    throw new Error("Riksbanken is not reachable from the tests");
  },
  timeoutMs: 50,
  log: () => {},
});
const purchaseRepository = createPurchaseRepository(db);
const purchaseService = createPurchaseService(
  purchaseRepository,
  registerService,
  mailService,
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  auditRepository,
  rates
);
const planningService = createPlanningService(createPlanningRepository(db), {
  purchase: purchaseService,
  manufacturing: mfgService,
  requirementsCacheMs: 0,
});
const invoiceRepository = createSupplierInvoiceRepository(db);
// Records every header patch the service writes (B10).
const headerPatches: Record<string, unknown>[] = [];
const invoices = createSupplierInvoiceService(
  {
    ...invoiceRepository,
    async updateHeader(id, patch) {
      headerPatches.push(patch);
      return invoiceRepository.updateHeader(id, patch);
    },
  },
  createVerificationPoster({ read: readPostingSettings }),
  undefined,
  rates
);

const TABLES = sql`TRUNCATE audit_log, email_log, exchange_rates, supplier_invoice_rows, supplier_invoices, inquiry_rows, inquiries,
  purchase_receipts, mo_report_materials, mo_reports, purchase_order_rows, purchase_orders, article_suppliers, supplier_contacts,
  supplier_delivery_addresses, suppliers, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders,
  routing_operations, work_centers, production_groups, stock_transactions, stock_locations, warehouses, bom_components, articles,
  users CASCADE`;

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  onSend = null;
  headerPatches.length = 0;
  user = await authRepo.create({ email: `inkop-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Inköpare", role: "admin" });
});
afterAll(async () => {
  await db.execute(TABLES);
});

async function supplier(currency = "SEK", name = `Leverantör ${currency}`) {
  return purchaseService.createSupplier(parsed(createSupplierSchema, { name, currency, active: true }));
}

async function article(number: string, type: "purchased" | "manufactured" = "purchased", defaultLocationId?: string) {
  return articleService.createArticle(parsed(createArticleSchema, { articleNumber: number, name: number, type, active: true, defaultLocationId }));
}

async function place(name: string) {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse!.id, name, active: true, fixed: true, blocked: false });
}

async function eurRate(rate: number) {
  await db.insert(exchangeRates).values({ currency: "EUR", date: TODAY, rate: String(rate), source: "manual" });
}

// A SEK order with one row per given quantity, confirmed unless `draft`.
async function order(quantities: number[], opts: { draft?: boolean } = {}) {
  const s = await supplier();
  const created = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: s.id }), user.id);
  const rows = [];
  for (const [i, quantity] of quantities.entries()) {
    const a = await article(`ART-${i}-${crypto.randomUUID().slice(0, 6)}`);
    rows.push(await purchaseService.addRow(created.id, { articleId: a.id, quantity, unitPrice: 10 }));
  }
  if (!opts.draft) await purchaseService.confirm(created.id);
  return { supplier: s, order: created, rows };
}

async function orderStatus(orderId: string) {
  const [row] = await db.select({ status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.id, orderId));
  return row!.status;
}

async function sentInquiry(supplierId: string) {
  const a = await article(`RFQ-${crypto.randomUUID().slice(0, 6)}`);
  const created = await purchaseService.createInquiry(
    parsed(createInquirySchema, { supplierId, rows: [{ articleId: a.id, quantity: 5, unitPrice: 20 }] }),
    user.id
  );
  await purchaseService.sendInquiry(created.inquiry.id);
  return { inquiry: created.inquiry, article: a };
}

async function draftInvoice(supplierId: string) {
  const invoice = await invoices.create(
    parsed(createSupplierInvoiceSchema, { supplierId, invoiceNumber: `F-${crypto.randomUUID()}`, invoiceDate: TODAY, rows: [] }),
    user.id
  );
  return invoice!;
}

// Runs `action` while another transaction holds the locks `lock` took, and
// lets that transaction commit once `action` is waiting on them — the
// deterministic shape of "someone else committed between the service's read
// and its write".
async function whileHolding<T>(lock: (tx: Tx) => Promise<unknown>, action: () => Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const hasLocks = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    await lock(tx);
    locked();
    await gate;
  });
  await Promise.race([hasLocks, holder]);
  const acting = action().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  );
  try {
    await waitForLockWaiter();
  } finally {
    release(); // never leave the holder's locks behind a failed wait
  }
  await holder;
  return acting;
}

// Legoartikel: operation 10 on a machine, 20 on a legoresurs; a released TO.
async function legoOrder() {
  const legoSupplier = await supplier("SEK", "Lego AB");
  const machine = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", type: "machine", active: true }));
  const lego = await mfgService.createWorkCenter(
    parsed(createWorkCenterSchema, { code: "900", name: "Ytbehandling AB", type: "subcontract", supplierId: legoSupplier.id, active: true })
  );
  const parent = await article(`LEGO-${crypto.randomUUID().slice(0, 6)}`, "manufactured");
  await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: machine.id, setupTime: 0, runTimePerUnit: 1 });
  await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: 500,
    unitPrice: 100,
  });
  const mo = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 4 }, user.id);
  const operations = await mfgService.listOperations(mo.id);
  const io = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: legoSupplier.id }), user.id);
  return {
    parent,
    io,
    machineOp: operations.find((op) => op.sequenceNo === 10)!,
    legoOp: operations.find((op) => op.sequenceNo === 20)!,
  };
}

async function buildApp() {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = { id: user.id } as any;
  });
  await app.register(purchaseRoutes, { service: purchaseService });
  await app.register(supplierInvoiceRoutes, { service: invoices });
  return app;
}

describe("B1 — kursen på en inköpsorder i annan valuta", () => {
  // The receipt stamps unit_cost = price × the order's rate: a EUR order
  // that silently got 1 valued the stock at a tenth of its cost.
  it("looks today's rate up when none is sent, and the receipt's unit_cost is in SEK", async () => {
    await eurRate(11.25);
    const eur = await supplier("EUR");
    const a1 = await place("A1");
    const a = await article("EUR-1", "purchased", a1.id);
    const created = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: eur.id }), user.id);
    expect(created).toMatchObject({ currency: "EUR", exchangeRate: "11.250000" });

    const row = await purchaseService.addRow(created.id, { articleId: a.id, quantity: 2, unitPrice: 10 });
    await purchaseService.confirm(created.id);
    await purchaseService.receiveGoods(created.id, row.id, { quantity: 2 }, user.id);
    const [movement] = await db.select().from(stockTransactions).where(eq(stockTransactions.articleId, a.id));
    expect(movement!.unitCost).toBe("112.5000");
  });

  it("an explicit rate wins over the looked-up one", async () => {
    await eurRate(11.25);
    const eur = await supplier("EUR");
    const created = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: eur.id, exchangeRate: 12 }), user.id);
    expect(created.exchangeRate).toBe("12.000000");
  });

  it("refuses the order when there is no rate, instead of saving 1", async () => {
    const eur = await supplier("EUR");
    await expect(
      purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: eur.id }), user.id)
    ).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    expect(await db.select().from(purchaseOrders)).toHaveLength(0);
  });

  it("SEK is always 1: another rate is refused at creation and on the header", async () => {
    const sek = await supplier();
    await expect(
      purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: sek.id, exchangeRate: 2 }), user.id)
    ).rejects.toBeInstanceOf(PurchaseOrderExchangeRateError);
    const created = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: sek.id }), user.id);
    expect(created.exchangeRate).toBe("1.000000");
    await expect(purchaseService.updatePurchaseOrderHeader(created.id, { exchangeRate: 2 })).rejects.toBeInstanceOf(PurchaseOrderExchangeRateError);
    // The card re-sends the stored rate with every save.
    await expect(purchaseService.updatePurchaseOrderHeader(created.id, { exchangeRate: 1, note: "x" })).resolves.toMatchObject({ note: "x" });
  });

  it("an inquiry converted to an order gets the rate too — and stays an inquiry without one", async () => {
    const eur = await supplier("EUR");
    const first = await sentInquiry(eur.id);
    await expect(purchaseService.convertInquiryToOrder(first.inquiry.id, user.id)).rejects.toBeInstanceOf(ExchangeRateUnavailableError);
    expect((await purchaseService.getInquiry(first.inquiry.id))!.status).toBe("sent");
    expect(await db.select().from(purchaseOrders)).toHaveLength(0);

    await eurRate(11.25);
    const converted = await purchaseService.convertInquiryToOrder(first.inquiry.id, user.id);
    expect(converted).toMatchObject({ currency: "EUR", exchangeRate: "11.250000" });
  });

  it("Skapa ordrar: the rate is looked up, and a catalog price in another currency is not the order's price", async () => {
    await eurRate(11.25);
    const eur = await supplier("EUR");
    const inEur = await article("PLAN-EUR");
    const inSek = await article("PLAN-SEK");
    await purchaseService.addArticleSupplier(inEur.id, parsed(createArticleSupplierSchema, { supplierId: eur.id, price: 5, currency: "EUR", isPrimary: true }));
    await purchaseService.addArticleSupplier(inSek.id, parsed(createArticleSupplierSchema, { supplierId: eur.id, price: 50, currency: "SEK", isPrimary: true }));

    const result = await planningService.createOrdersFromProposals(
      parsed(createPlanningOrdersSchema, {
        proposals: [
          { articleId: inEur.id, quantity: 10, kind: "purchase" },
          { articleId: inSek.id, quantity: 10, kind: "purchase" },
        ],
      }),
      user.id
    );
    expect(result.errors).toEqual([]);
    expect(result.purchaseOrders).toHaveLength(1);
    const created = await purchaseService.getPurchaseOrder(result.purchaseOrders[0]!.id);
    expect(created).toMatchObject({ currency: "EUR", exchangeRate: "11.250000" });
    const rows = await purchaseService.listRows(created!.id);
    expect(Number(rows.find((r) => r.articleId === inEur.id)!.unitPrice)).toBe(5);
    // 50 SEK is not 50 EUR: left at 0 for the buyer to fill in.
    expect(Number(rows.find((r) => r.articleId === inSek.id)!.unitPrice)).toBe(0);
  });

  it("Skapa ordrar: a missing rate is an error row per article, never an order at rate 1", async () => {
    const eur = await supplier("EUR");
    const sek = await supplier("SEK", "Svensk AB");
    const a = await article("PLAN-EUR");
    const b = await article("PLAN-SEK");
    await purchaseService.addArticleSupplier(a.id, parsed(createArticleSupplierSchema, { supplierId: eur.id, price: 5, currency: "EUR", isPrimary: true }));
    await purchaseService.addArticleSupplier(b.id, parsed(createArticleSupplierSchema, { supplierId: sek.id, price: 5, isPrimary: true }));

    const result = await planningService.createOrdersFromProposals(
      parsed(createPlanningOrdersSchema, {
        proposals: [
          { articleId: a.id, quantity: 10, kind: "purchase" },
          { articleId: b.id, quantity: 10, kind: "purchase" },
        ],
      }),
      user.id
    );
    // The SEK order is created; the EUR one is reported, not created.
    expect(result.purchaseOrders.map((o) => o.supplierId)).toEqual([sek.id]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ articleId: a.id });
    expect(result.errors[0]!.message).toMatch(/Ingen kurs för EUR/);
    expect(await db.select().from(purchaseOrders)).toHaveLength(1);
  });

  it("the routes answer 409 exchange-rate-unavailable and 400 purchase-order-exchange-rate", async () => {
    const app = await buildApp();
    const eur = await supplier("EUR");
    const sek = await supplier();
    const noRate = await app.inject({ method: "POST", url: "/purchase-orders", payload: { supplierId: eur.id } });
    expect([noRate.statusCode, noRate.json().code]).toEqual([409, "exchange-rate-unavailable"]);
    const sekRate = await app.inject({ method: "POST", url: "/purchase-orders", payload: { supplierId: sek.id, exchangeRate: 2 } });
    expect([sekRate.statusCode, sekRate.json().code]).toEqual([400, "purchase-order-exchange-rate"]);
    const { inquiry } = await sentInquiry(eur.id);
    const converting = await app.inject({ method: "POST", url: `/inquiries/${inquiry.id}/convert-to-order` });
    expect([converting.statusCode, converting.json().code]).toEqual([409, "exchange-rate-unavailable"]);
    await app.close();
  });
});

describe("B2 — förfrågan blir en inköpsorder en gång", () => {
  // Two clicks on Skapa inköpsorder both read "sent" and each created an order.
  it("a conversion that waited for another one is refused and creates no second order", async () => {
    const s = await supplier();
    const { inquiry } = await sentInquiry(s.id);
    const second = await whileHolding(
      async (tx) => {
        await tx.select({ id: inquiries.id }).from(inquiries).where(eq(inquiries.id, inquiry.id)).for("update");
        await tx.update(inquiries).set({ status: "ordered" }).where(eq(inquiries.id, inquiry.id));
      },
      () => purchaseService.convertInquiryToOrder(inquiry.id, user.id)
    );
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await db.select().from(purchaseOrders)).toHaveLength(0);
  });

  it("two conversions at once create exactly one order", async () => {
    const s = await supplier();
    const { inquiry } = await sentInquiry(s.id);
    const results = await Promise.allSettled([
      purchaseService.convertInquiryToOrder(inquiry.id, user.id),
      purchaseService.convertInquiryToOrder(inquiry.id, user.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.select().from(purchaseOrders)).toHaveLength(1);
  });
});

describe("B3 — ett okänt id tar inte bort huvudvalet", () => {
  // The demotion ran before the UPDATE that found no row, and committed.
  it("huvudleverantör survives a PATCH of an unknown catalog row", async () => {
    const s = await supplier();
    const a = await article("KAT-1");
    await purchaseService.addArticleSupplier(a.id, parsed(createArticleSupplierSchema, { supplierId: s.id, price: 5, isPrimary: true }));
    await expect(purchaseService.updateArticleSupplier(a.id, UNKNOWN, { isPrimary: true })).rejects.toBeInstanceOf(ArticleSupplierNotFoundError);
    const [row] = await db.select().from(articleSuppliers).where(eq(articleSuppliers.articleId, a.id));
    expect(row!.isPrimary).toBe(true);
  });

  it("huvudkontakt survives a PATCH of an unknown contact", async () => {
    const s = await supplier();
    await purchaseService.createSupplierContact(s.id, { name: "Anna", isPrimary: true });
    await expect(purchaseService.updateSupplierContact(s.id, UNKNOWN, { isPrimary: true })).rejects.toBeInstanceOf(ContactNotFoundError);
    const [row] = await db.select().from(supplierContacts).where(eq(supplierContacts.supplierId, s.id));
    expect(row!.isPrimary).toBe(true);
  });

  it("the default delivery address survives a PATCH of an unknown address — and a real switch still works", async () => {
    const s = await supplier();
    const first = await purchaseService.createSupplierDeliveryAddress(s.id, { label: "Lager", address: "Gatan 1", country: "SE", isDefault: true });
    const other = await purchaseService.createSupplierDeliveryAddress(s.id, { label: "Fabrik", address: "Gatan 2", country: "SE", isDefault: false });
    await expect(purchaseService.updateSupplierDeliveryAddress(s.id, UNKNOWN, { isDefault: true })).rejects.toBeInstanceOf(DeliveryAddressNotFoundError);
    const defaults = async () =>
      (await db.select().from(supplierDeliveryAddresses).where(eq(supplierDeliveryAddresses.supplierId, s.id))).filter((r) => r.isDefault).map((r) => r.id);
    expect(await defaults()).toEqual([first.id]);
    await purchaseService.updateSupplierDeliveryAddress(s.id, other.id, { isDefault: true });
    expect(await defaults()).toEqual([other.id]);
  });
});

describe("B4 — leverantörsfakturans rader efter attest", () => {
  // The service read "draft" unlocked; the attest booked the verification
  // from the rows and a row write then changed them underneath it.
  async function whileAttesting<T>(invoiceId: string, action: () => Promise<T>) {
    return whileHolding(async (tx) => {
      await tx.select({ id: supplierInvoices.id }).from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).for("update");
      await tx.update(supplierInvoices).set({ status: "approved" }).where(eq(supplierInvoices.id, invoiceId));
    }, action);
  }

  it("a row added while the attest commits is refused", async () => {
    const invoice = await draftInvoice((await supplier()).id);
    const adding = await whileAttesting(invoice.id, () => invoices.addRow(invoice.id, { description: "Sen rad", quantity: 1, unitPrice: 100 }));
    expect(!adding.ok && adding.error).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await db.select().from(supplierInvoiceRows)).toHaveLength(0);
  });

  it("a row changed or deleted while the attest commits is refused", async () => {
    const invoice = await draftInvoice((await supplier()).id);
    const row = await invoices.addRow(invoice.id, { description: "Rad", quantity: 1, unitPrice: 100 });
    const changing = await whileAttesting(invoice.id, () => invoices.updateRow(invoice.id, row.id, { unitPrice: 1 }));
    expect(!changing.ok && changing.error).toBeInstanceOf(InvalidStatusTransitionError);
    await db.update(supplierInvoices).set({ status: "draft" }).where(eq(supplierInvoices.id, invoice.id));
    const deleting = await whileAttesting(invoice.id, () => invoices.deleteRow(invoice.id, row.id));
    expect(!deleting.ok && deleting.error).toBeInstanceOf(InvalidStatusTransitionError);
    const [kept] = await db.select().from(supplierInvoiceRows);
    expect(kept).toMatchObject({ id: row.id, unitPrice: "100.0000" });
  });
});

describe("B5 — legoraden på en inköpsorder", () => {
  // The row's operation is what the receipt reports: any operation id was
  // accepted, so a receipt could report another article's or a machine's.
  it("accepts the article's own open lego operation and keeps the ställpris as sent", async () => {
    const f = await legoOrder();
    const row = await purchaseService.addRow(f.io.id, { articleId: f.parent.id, quantity: 4, unitPrice: 100, moOperationId: f.legoOp.id });
    expect(row).toMatchObject({ moOperationId: f.legoOp.id, setupPrice: null });
    const priced = await purchaseService.addRow(f.io.id, { articleId: f.parent.id, quantity: 4, unitPrice: 100, moOperationId: f.legoOp.id, setupPrice: 75 });
    expect(priced.setupPrice).toBe("75.00");
  });

  it("refuses another article's operation, a machine operation, a done one and an unknown one", async () => {
    const f = await legoOrder();
    const other = await article("ANNAN-1");
    const add = (articleId: string, moOperationId: string) => purchaseService.addRow(f.io.id, { articleId, quantity: 1, unitPrice: 1, moOperationId });
    await expect(add(other.id, f.legoOp.id)).rejects.toBeInstanceOf(LegoOperationArticleMismatchError);
    await expect(add(f.parent.id, f.machineOp.id)).rejects.toBeInstanceOf(NotLegoOperationError);
    await expect(add(f.parent.id, UNKNOWN)).rejects.toBeInstanceOf(MoOperationNotFoundError);
    await db.update(moOperations).set({ status: "done" }).where(eq(moOperations.id, f.legoOp.id));
    await expect(add(f.parent.id, f.legoOp.id)).rejects.toBeInstanceOf(LegoOperationClosedError);
    expect(await db.select().from(purchaseOrderRows)).toHaveLength(0);
  });

  it("the row route answers like the inquiry's: 400 for the wrong article, 409 for a closed operation", async () => {
    const app = await buildApp();
    const f = await legoOrder();
    const other = await article("ANNAN-1");
    const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/purchase-orders/${f.io.id}/rows`, payload });
    const mismatch = await post({ articleId: other.id, quantity: 1, unitPrice: 1, moOperationId: f.legoOp.id });
    expect([mismatch.statusCode, mismatch.json().code]).toEqual([400, "lego-operation-article-mismatch"]);
    const machine = await post({ articleId: f.parent.id, quantity: 1, unitPrice: 1, moOperationId: f.machineOp.id });
    expect([machine.statusCode, machine.json().code]).toEqual([400, "not-lego-operation"]);
    await db.update(moOperations).set({ status: "done" }).where(eq(moOperations.id, f.legoOp.id));
    const closed = await post({ articleId: f.parent.id, quantity: 1, unitPrice: 1, moOperationId: f.legoOp.id });
    expect([closed.statusCode, closed.json().code]).toEqual([409, "lego-operation-closed"]);
    await app.close();
  });
});

describe("B6 — statusskrivningar bara från den lästa statusen", () => {
  const setStatus = (orderId: string, status: "cancelled" | "closed" | "partially_received") => async (tx: Tx) => {
    await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, orderId)).for("update");
    await tx.update(purchaseOrders).set({ status }).where(eq(purchaseOrders.id, orderId));
  };

  // Bekräfta read "draft" and wrote "confirmed" over a Makulera.
  it("Bekräfta does not revive an order that was cancelled meanwhile", async () => {
    const f = await order([5], { draft: true });
    const confirming = await whileHolding(setStatus(f.order.id, "cancelled"), () => purchaseService.confirm(f.order.id, user.id));
    expect(!confirming.ok && confirming.error).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await orderStatus(f.order.id)).toBe("cancelled");
  });

  // Stäng read "received" and closed an order an Ångra inleverans had reopened.
  it("Stäng does not close an order whose receipt was undone meanwhile", async () => {
    const f = await order([5]);
    await db.update(purchaseOrders).set({ status: "received" }).where(eq(purchaseOrders.id, f.order.id));
    const closing = await whileHolding(setStatus(f.order.id, "partially_received"), () => purchaseService.close(f.order.id, user.id));
    expect(!closing.ok && closing.error).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await orderStatus(f.order.id)).toBe("partially_received");
  });

  // The mail has gone, so no error — but the status that moved stays.
  it("an order cancelled while its mail was being sent stays cancelled", async () => {
    await testSystemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
    const f = await order([5], { draft: true });
    onSend = async () => {
      await db.update(purchaseOrders).set({ status: "cancelled" }).where(eq(purchaseOrders.id, f.order.id));
    };
    const sent = await purchaseService.sendPurchaseOrderEmail(
      f.order.id,
      parsed(sendDocumentEmailSchema, { to: "lev@example.com", subject: "Order", message: "Hej" })
    );
    expect(sent!.status).toBe("cancelled");
    expect(await orderStatus(f.order.id)).toBe("cancelled");
  });

  it("a row is not added, changed or deleted on an order that was closed meanwhile", async () => {
    const f = await order([5]);
    const a = await article("NY-1");
    const adding = await whileHolding(setStatus(f.order.id, "closed"), () => purchaseService.addRow(f.order.id, { articleId: a.id, quantity: 1, unitPrice: 1 }));
    expect(!adding.ok && adding.error).toBeInstanceOf(InvalidStatusTransitionError);

    await db.update(purchaseOrders).set({ status: "confirmed" }).where(eq(purchaseOrders.id, f.order.id));
    // bumpRevision: false — the revision bump's own UPDATE would otherwise
    // wait on the order too and hide a missing lock.
    const changing = await whileHolding(setStatus(f.order.id, "closed"), () =>
      purchaseService.updateRow(f.order.id, f.rows[0]!.id, { quantity: 9, bumpRevision: false })
    );
    expect(!changing.ok && changing.error).toBeInstanceOf(InvalidStatusTransitionError);

    await db.update(purchaseOrders).set({ status: "confirmed" }).where(eq(purchaseOrders.id, f.order.id));
    const deleting = await whileHolding(setStatus(f.order.id, "closed"), () => purchaseService.deleteRow(f.order.id, f.rows[0]!.id, false));
    expect(!deleting.ok && deleting.error).toBeInstanceOf(InvalidStatusTransitionError);

    const rows = await db.select().from(purchaseOrderRows).where(eq(purchaseOrderRows.purchaseOrderId, f.order.id));
    expect(rows.map((r) => r.quantityOrdered)).toEqual(["5.0000"]);
  });

  // A row edit that completes the order and a receipt that completes the
  // other row each saw the other's row unfinished: all received, status
  // still Delvis mottagen.
  it("a row edit waits for a receipt on another row and sees its quantity when it recomputes the status", async () => {
    const f = await order([5, 5]);
    const [first, second] = f.rows;
    await db.update(purchaseOrderRows).set({ quantityReceived: "3" }).where(eq(purchaseOrderRows.id, first!.id));
    await db.update(purchaseOrders).set({ status: "partially_received" }).where(eq(purchaseOrders.id, f.order.id));
    const editing = await whileHolding(
      // The receipt of the whole second row: row → order, like receiveGoods.
      async (tx) => {
        await tx.select({ id: purchaseOrderRows.id }).from(purchaseOrderRows).where(eq(purchaseOrderRows.id, second!.id)).for("update");
        await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, f.order.id)).for("update");
        await tx.update(purchaseOrderRows).set({ quantityReceived: "5" }).where(eq(purchaseOrderRows.id, second!.id));
      },
      () => purchaseService.updateRow(f.order.id, first!.id, { quantity: 3, bumpRevision: false })
    );
    expect(editing.ok && editing.value?.orderStatus).toBe("received");
    expect(await orderStatus(f.order.id)).toBe("received");
  });

  // Makulera read "sent" and cancelled an inquiry that had become an order.
  it("an inquiry converted meanwhile is not cancelled, sent or marked answered over it", async () => {
    const s = await supplier();
    const { inquiry } = await sentInquiry(s.id);
    const ordered = async (tx: Tx) => {
      await tx.select({ id: inquiries.id }).from(inquiries).where(eq(inquiries.id, inquiry.id)).for("update");
      await tx.update(inquiries).set({ status: "ordered" }).where(eq(inquiries.id, inquiry.id));
    };
    const cancelling = await whileHolding(ordered, () => purchaseService.cancelInquiry(inquiry.id, user.id));
    expect(!cancelling.ok && cancelling.error).toBeInstanceOf(InvalidStatusTransitionError);
    await db.update(inquiries).set({ status: "sent" }).where(eq(inquiries.id, inquiry.id));
    const answering = await whileHolding(ordered, () => purchaseService.markInquiryAnswered(inquiry.id, user.id));
    expect(!answering.ok && answering.error).toBeInstanceOf(InvalidStatusTransitionError);
    await db.update(inquiries).set({ status: "draft" }).where(eq(inquiries.id, inquiry.id));
    const sending = await whileHolding(ordered, () => purchaseService.sendInquiry(inquiry.id, user.id));
    expect(!sending.ok && sending.error).toBeInstanceOf(InvalidStatusTransitionError);
    expect((await purchaseService.getInquiry(inquiry.id))!.status).toBe("ordered");
  });
});

describe("B7 — okända id:n är 404, inte 500", () => {
  it("an unknown article on an IO row and on an inquiry", async () => {
    const app = await buildApp();
    const f = await order([5], { draft: true });
    // Without a unit the FK answered (500); with one the unit lookup's error was unmapped.
    const row = await app.inject({ method: "POST", url: `/purchase-orders/${f.order.id}/rows`, payload: { articleId: UNKNOWN, quantity: 1, unitPrice: 1 } });
    expect([row.statusCode, row.json().code]).toEqual([404, "article-not-found"]);
    const withUnit = await app.inject({
      method: "POST",
      url: `/purchase-orders/${f.order.id}/rows`,
      payload: { articleId: UNKNOWN, quantity: 1, unitPrice: 1, unitId: UNKNOWN },
    });
    expect([withUnit.statusCode, withUnit.json().code]).toEqual([404, "article-not-found"]);
    const inquiry = await app.inject({ method: "POST", url: "/inquiries", payload: { supplierId: f.supplier.id, rows: [{ articleId: UNKNOWN, quantity: 1 }] } });
    expect([inquiry.statusCode, inquiry.json().code]).toEqual([404, "article-not-found"]);
    const { inquiry: existing } = await sentInquiry(f.supplier.id);
    const inquiryRow = await app.inject({ method: "POST", url: `/inquiries/${existing.id}/rows`, payload: { articleId: UNKNOWN, quantity: 1 } });
    expect([inquiryRow.statusCode, inquiryRow.json().code]).toEqual([404, "article-not-found"]);
    await app.close();
  });

  it("an unknown purchase order or article on a supplier invoice", async () => {
    const app = await buildApp();
    const s = await supplier();
    const header = { supplierId: s.id, invoiceDate: TODAY };
    const unknownOrder = await app.inject({
      method: "POST",
      url: "/supplier-invoices",
      payload: { ...header, invoiceNumber: "F-1", purchaseOrderId: UNKNOWN, rows: [] },
    });
    expect([unknownOrder.statusCode, unknownOrder.json().code]).toEqual([404, "purchase-order-not-found"]);
    const unknownArticle = await app.inject({
      method: "POST",
      url: "/supplier-invoices",
      payload: { ...header, invoiceNumber: "F-2", rows: [{ description: "Rad", articleId: UNKNOWN, quantity: 1, unitPrice: 1 }] },
    });
    expect([unknownArticle.statusCode, unknownArticle.json().code]).toEqual([404, "article-not-found"]);
    expect(await db.select().from(supplierInvoices)).toHaveLength(0);

    const invoice = await draftInvoice(s.id);
    const added = await app.inject({
      method: "POST",
      url: `/supplier-invoices/${invoice.id}/rows`,
      payload: { description: "Rad", articleId: UNKNOWN, quantity: 1, unitPrice: 1 },
    });
    expect([added.statusCode, added.json().code]).toEqual([404, "article-not-found"]);
    await app.close();
  });

  it("the service throws the same errors (the Fakturainkorg's conversion goes through prepareCreate)", async () => {
    const s = await supplier();
    const input = (extra: Record<string, unknown>) =>
      parsed(createSupplierInvoiceSchema, { supplierId: s.id, invoiceNumber: `F-${crypto.randomUUID()}`, invoiceDate: TODAY, rows: [], ...extra });
    await expect(invoices.prepareCreate(input({ purchaseOrderId: UNKNOWN }))).rejects.toBeInstanceOf(PurchaseOrderNotFoundError);
    const invoice = await draftInvoice(s.id);
    const row = await invoices.addRow(invoice.id, { description: "Rad", quantity: 1, unitPrice: 1 });
    await expect(invoices.updateRow(invoice.id, row.id, { articleId: UNKNOWN })).rejects.toBeInstanceOf(ArticleNotFoundError);
    await expect(invoices.updateHeader(invoice.id, { purchaseOrderId: UNKNOWN })).rejects.toBeInstanceOf(PurchaseOrderNotFoundError);
  });
});

describe("B8 — toleransens övre gräns", () => {
  // 0.18 + 0.5 is 0.6799999999999999 in floats, so 0.68 "exceeded" it.
  it("a payment of exactly open + tolerance is within the tolerance", () => {
    const expected = { ok: true, writeOffAmount: -0.5, settles: true, rest: 0, kind: "closes_with_writeoff" };
    expect(applyPaymentTolerance(0.18, 0.68, 0.5)).toEqual(expected);
    expect(webTolerance.applyPaymentTolerance(0.18, 0.68, 0.5)).toEqual(expected);
    expect(applyPaymentTolerance(-0.18, -0.68, 0.5)).toMatchObject({ ok: true, writeOffAmount: 0.5 });
  });

  it("one öre more is still refused", () => {
    expect(applyPaymentTolerance(0.18, 0.69, 0.5)).toEqual({ ok: false, reason: "exceeds_open" });
    expect(webTolerance.applyPaymentTolerance(0.18, 0.69, 0.5)).toEqual({ ok: false, reason: "exceeds_open" });
  });
});

describe("B10 — leverantörsfakturans huvud skriver bara det som skickats", () => {
  // Every PATCH wrote back the kostnadsställe/projekt it had read, undoing a
  // change someone else saved in between.
  it("a PATCH of the note leaves kostnadsställe and projekt out of the UPDATE", async () => {
    const invoice = await draftInvoice((await supplier()).id);
    await invoices.updateHeader(invoice.id, { note: "Ny notering" });
    expect(headerPatches).toHaveLength(1);
    expect(headerPatches[0]).toEqual({ note: "Ny notering" });
  });

  it("a sent kostnadsställe/projekt is written, also when it clears", async () => {
    const invoice = await draftInvoice((await supplier()).id);
    await invoices.updateHeader(invoice.id, { costCenterId: null });
    expect(headerPatches[0]).toEqual({ costCenterId: null });
    await invoices.updateHeader(invoice.id, { projectId: null });
    expect(headerPatches[1]).toEqual({ projectId: null });
  });
});
