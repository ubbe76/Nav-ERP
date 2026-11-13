import {
  completeOperationSchema,
  createArticleSchema,
  createCustomerSchema,
  createQuoteSchema,
  createStockLocationSchema,
  createWorkCenterSchema,
  deliverBatchSchema,
  listStockTransactionsQuerySchema,
  updateSystemSettingsSchema,
} from "@navet/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { db, deliveryRows, stockBatches, systemSettings } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { formatBatchInfo } from "../src/modules/mail/service/document-pdf.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { deliveredBatchesForOrderRows } from "../src/modules/sales/repository/delivered-batches.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { stockRoutes } from "../src/modules/stock/routes/stock.routes.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { createStockCountService } from "../src/modules/stock/service/stock-count.service.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Batch (#8), steg 3a — the batch on the documents: följesedel and pallkort
// till kund (named batches only, decision 14), plocklistan (the cells in the
// order Automatiskt draws, Okänd included), fakturan (frozen at Utfärda,
// decision 13), TO:ns pallkort (the TO number, decision 17), räknelistan and
// lagerloggens CSV.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const auditRepository = createAuditRepository(db);
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  createRegisterService(createRegisterRepository(db)),
  mailService,
  testDocumentPdfService,
  stockService,
  articleService,
  testSystemService,
  (query) => resolvePrice(db, query),
  auditRepository
);
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  testDocumentPdfService,
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  auditRepository,
  articleService
);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const countRepo = createStockCountRepository(db);
const countService = createStockCountService({ repo: countRepo, pdf: testDocumentPdfService, audit: auditRepository });

const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_rows, invoices, audit_log, stock_count_rows, stock_count_sessions, mo_reports, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));

let user: { id: string };
let warehouseId: string;

beforeEach(async () => {
  await db.execute(TABLES);
  await resetSetting();
  await setupPostingBaseline();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
  user = await authRepo.create({ email: `batch-doc-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Lagerchef", role: "admin" });
  warehouseId = (await stockService.createWarehouse({ name: "Huvudlager", active: true }))!.id;
});

afterAll(async () => {
  await db.execute(TABLES);
  await resetSetting();
});

const makeLocation = (name: string) => stockService.createLocation(parsed(createStockLocationSchema, { warehouseId, name, active: true }));

let n = 0;
async function makeArticle(patch: Record<string, unknown> = {}) {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `BD-${++n}-${crypto.randomUUID().slice(0, 6)}`, name: "Plåt", type: "purchased", active: true, batchTracked: true, ...patch })
  );
}

const adjust = (articleId: string, locationId: string, quantityDelta: number, batchNumber?: string) =>
  stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment", batchNumber });

const DAY = 24 * 60 * 60 * 1000;
const age = (batchNumber: string, days: number) =>
  db.update(stockBatches).set({ createdAt: new Date(Date.now() - days * DAY) }).where(eq(stockBatches.batchNumber, batchNumber));

async function batchId(articleId: string, batchNumber: string) {
  const [row] = await db.select().from(stockBatches).where(and(eq(stockBatches.articleId, articleId), eq(stockBatches.batchNumber, batchNumber)));
  return row!.id;
}

// Huvudplats A1 with Okänd 2, GAMMAL 5 and NY 6; B2 with GAMMAL 4.
async function stocked(patch: Record<string, unknown> = {}) {
  const [a1, b2] = [await makeLocation("A1"), await makeLocation("B2")];
  const article = await makeArticle({ defaultLocationId: a1.id, ...patch });
  await adjust(article.id, a1.id, 2);
  await adjust(article.id, a1.id, 5, "GAMMAL");
  await adjust(article.id, a1.id, 6, "NY");
  await adjust(article.id, b2.id, 4, "GAMMAL");
  await age("GAMMAL", 30);
  await age("NY", 2);
  return { article, a1, b2 };
}

async function makeOrder(articleId: string, quantity: number, customerPatch: Record<string, unknown> = {}) {
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true, ...customerPatch }));
  const { order, rows } = await salesService.createQuote(parsed(createQuoteSchema, { customerId: customer.id, rows: [{ articleId, quantity, unitPrice: 10 }] }), user.id);
  await salesService.confirm(order.id);
  await salesService.startProduction(order.id);
  return { customer, order, row: rows[0]! };
}

async function deliver(orderId: string, rows: { rowId: string; quantity: number; locationId?: string; batchId?: string | null }[]) {
  const result = await salesService.deliverBatch(orderId, parsed(deliverBatchSchema, { rows }), user.id);
  const [deliveryRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, result.deliveryId));
  return { ...result, deliveryRowId: deliveryRow!.id };
}

describe("formatBatchInfo", () => {
  it("one batch over the whole row is the number alone; several, or one beside left-out parts, carry their quantities", () => {
    expect(formatBatchInfo([])).toBeNull();
    expect(formatBatchInfo([{ batchNumber: "A", quantity: 4 }, { batchNumber: "A", quantity: 2 }])).toBe("A");
    expect(formatBatchInfo([{ batchNumber: "A", quantity: 4 }], { whole: false })).toBe("A (4)");
    expect(formatBatchInfo([{ batchNumber: "A", quantity: 4 }, { batchNumber: "B", quantity: 2.5 }, { batchNumber: "A", quantity: 1 }])).toBe("A (5), B (2,50)");
    expect(formatBatchInfo([{ batchNumber: "A", quantity: 1 }, { batchNumber: "B", quantity: 2.5 }], { language: "en" })).toBe("A (1), B (2.50)");
  });
});

describe("Följesedel and pallkort till kund", () => {
  it("print the row's named batches summed per batch — Okänd never — and nothing for an article without batches", async () => {
    const { article, a1 } = await stocked();
    const plain = await makeArticle({ batchTracked: false, defaultLocationId: a1.id });
    await adjust(plain.id, a1.id, 5);
    const { order, row } = await makeOrder(article.id, 20);
    // Automatiskt: Okänd 2, GAMMAL 5 (A1) + 4 (B2), NY 2.
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 13 }]);

    const note = pdfText((await salesService.deliveryNotePdf(d.deliveryId)).pdf);
    expect(note).toContain("Batch: GAMMAL (9), NY (2)");
    expect(note).not.toContain("Okänd");

    const card = pdfText((await salesService.deliveryPalletCardPdf(d.deliveryId)).pdf);
    expect(card).toContain("BATCH");
    expect(card).toContain("GAMMAL (9), NY (2)");
    expect(card).not.toContain("Okänd");

    // One named batch covering the row: the number alone.
    const single = await deliver(order.id, [{ rowId: row.id, quantity: 3, batchId: await batchId(article.id, "NY") }]);
    const singleNote = pdfText((await salesService.deliveryNotePdf(single.deliveryId)).pdf);
    expect(singleNote).toContain("Batch: NY");
    expect(singleNote).not.toContain("NY (");

    // Okänd only: no batch line and no BATCH cell at all.
    const unknown = await deliver(order.id, [{ rowId: row.id, quantity: 1, batchId: null }]);
    expect(pdfText((await salesService.deliveryNotePdf(unknown.deliveryId)).pdf)).not.toContain("Batch");
    expect(pdfText((await salesService.deliveryPalletCardPdf(unknown.deliveryId)).pdf)).not.toContain("BATCH");

    const other = await makeOrder(plain.id, 5);
    const plainDelivery = await deliver(other.order.id, [{ rowId: other.row.id, quantity: 2 }]);
    expect(pdfText((await salesService.deliveryNotePdf(plainDelivery.deliveryId)).pdf)).not.toContain("Batch");
    expect(pdfText((await salesService.deliveryPalletCardPdf(plainDelivery.deliveryId)).pdf)).not.toContain("BATCH");
  });

  it("Batchstyrd switched off: the batches are no longer printed (decision 10)", async () => {
    const { article } = await stocked();
    const { order, row } = await makeOrder(article.id, 20);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 13 }]);
    await articleService.updateArticle(article.id, { batchTracked: false });
    expect(pdfText((await salesService.deliveryNotePdf(d.deliveryId)).pdf)).not.toContain("Batch");
  });

  it("an English customer: the English delivery note and pallet card carry the batch in their own words and number format", async () => {
    const { article, a1 } = await stocked();
    await adjust(article.id, a1.id, 2.5, "HALV");
    await age("HALV", 60);
    const { order, row } = await makeOrder(article.id, 20, { language: "en" });
    // Okänd 2, HALV 2.5, GAMMAL 1.
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 5.5 }]);
    const note = await salesService.deliveryNotePdf(d.deliveryId);
    expect(note.filename).toMatch(/^Delivery-note-/);
    const text = pdfText(note.pdf);
    expect(text).toContain("Delivery note");
    expect(text).toContain("Batch: HALV (2.50), GAMMAL (1)");
    expect(text).not.toContain("Okänd");
    const card = pdfText((await salesService.deliveryPalletCardPdf(d.deliveryId)).pdf);
    expect(card).toContain("BATCH NO.");
    expect(card).toContain("HALV (2.50), GAMMAL (1)");
  });
});

describe("Plocklistan", () => {
  it("lists a batchstyrd article's cells in the order Automatiskt draws — Okänd included, blocked places left out — and other articles per place as before", async () => {
    const { article, a1, b2 } = await stocked();
    const plain = await makeArticle({ batchTracked: false, defaultLocationId: a1.id, name: "Skruv" });
    await adjust(plain.id, a1.id, 7);
    const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true }));
    const { order } = await salesService.createQuote(
      parsed(createQuoteSchema, {
        customerId: customer.id,
        rows: [
          { articleId: article.id, quantity: 10, unitPrice: 10 },
          { articleId: plain.id, quantity: 3, unitPrice: 1 },
        ],
      }),
      user.id
    );
    await salesService.confirm(order.id);

    const text = pdfText((await salesService.getPickListPdf(order.id)).content);
    const cells = ["Huvudlager — A1 · Batch Okänd: 2", "Huvudlager — A1 · Batch GAMMAL: 5", "Huvudlager — B2 · Batch GAMMAL: 4", "Huvudlager — A1 · Batch NY: 6"];
    const flat = text.replace(/\s+/g, " ");
    const positions = cells.map((cell) => flat.indexOf(cell));
    expect(positions.every((p) => p >= 0), flat).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    // The article without batches: its place and balance, no batch.
    expect(flat).toContain("Huvudlager — A1: 7");

    await stockService.blockLocation(b2.id, null, user.id);
    const blocked = pdfText((await salesService.getPickListPdf(order.id)).content).replace(/\s+/g, " ");
    expect(blocked).not.toContain("B2");
    expect(blocked).toContain("Huvudlager — A1 · Batch GAMMAL: 5");
  });
});

describe("Fakturan", () => {
  it("carries the order row's live named batches at Utfärda — and an Ångra utleverans afterwards never changes the issued invoice; a credit note prints none", async () => {
    const { article } = await stocked();
    const { customer, order, row } = await makeOrder(article.id, 20);
    const old = await batchId(article.id, "GAMMAL");
    const young = await batchId(article.id, "NY");
    const first = await deliver(order.id, [{ rowId: row.id, quantity: 6, batchId: old }]);
    const second = await deliver(order.id, [{ rowId: row.id, quantity: 4, batchId: young }]);

    // The one reader: live parts, named batches, per order row.
    const live = await deliveredBatchesForOrderRows(db, [row.id]);
    expect(live.get(row.id)).toMatchObject({ complete: true, batches: [{ batchNumber: "GAMMAL", quantity: 6 }, { batchNumber: "NY", quantity: 4 }] });

    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Del", articleId: article.id, salesOrderRowId: row.id, quantity: 6, unitPrice: 10 }] },
      user.id
    );
    const issued = (await invoiceService.issue(draft!.id, user.id))!;
    const text = pdfText((await invoiceService.renderPdf(issued.id)).content);
    expect(text).toContain("Batch: GAMMAL (6), NY (4)");

    // 10 delivered, 6 invoiced: the 4 of NY can still be undone.
    await salesService.undoDeliveryRow(order.id, second.deliveryId, second.deliveryRowId, user.id);
    expect((await deliveredBatchesForOrderRows(db, [row.id])).get(row.id)!.batches.map((b) => b.batchNumber)).toEqual(["GAMMAL"]);
    // The archived invoice is what it was.
    expect(pdfText((await invoiceService.renderPdf(issued.id)).content)).toContain("Batch: GAMMAL (6), NY (4)");
    // The följesedel that is left prints its own batch.
    expect(pdfText((await salesService.deliveryNotePdf(first.deliveryId)).pdf)).toContain("Batch: GAMMAL");

    const credit = await invoiceService.createCredit(issued.id, {}, user.id);
    const issuedCredit = (await invoiceService.issue(credit!.id, user.id))!;
    const creditText = pdfText((await invoiceService.renderPdf(issuedCredit.id)).content);
    expect(creditText).toContain("Kreditfaktura");
    expect(creditText).not.toContain("Batch");
  });

  it("Okänd is left out (the named batch then carries its quantity), and a row without named batches has no batch line", async () => {
    const { article, a1 } = await stocked();
    const plain = await makeArticle({ batchTracked: false, defaultLocationId: a1.id });
    await adjust(plain.id, a1.id, 5);
    const { customer, order, row } = await makeOrder(article.id, 20);
    // Automatiskt: Okänd 2 + GAMMAL 3.
    await deliver(order.id, [{ rowId: row.id, quantity: 5 }]);
    const other = await salesService.createQuote(parsed(createQuoteSchema, { customerId: customer.id, rows: [{ articleId: plain.id, quantity: 5, unitPrice: 1 }] }), user.id);
    await salesService.confirm(other.order.id);
    await salesService.startProduction(other.order.id);
    await deliver(other.order.id, [{ rowId: other.rows[0]!.id, quantity: 2 }]);

    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "Del", articleId: article.id, salesOrderRowId: row.id, quantity: 5, unitPrice: 10 },
          { description: "Skruv", articleId: plain.id, salesOrderRowId: other.rows[0]!.id, quantity: 2, unitPrice: 1 },
          { description: "Fri rad", quantity: 1, unitPrice: 100 },
        ],
      },
      user.id
    );
    const issued = (await invoiceService.issue(draft!.id, user.id))!;
    const text = pdfText((await invoiceService.renderPdf(issued.id)).content);
    expect(text).toContain("Batch: GAMMAL (3)");
    expect(text.split("Batch:").length - 1).toBe(1);
    expect(text).not.toContain("Okänd");
  });
});

describe("TO:ns pallkort", () => {
  async function makeManufacturingOrder(batchTracked: boolean) {
    const a1 = await makeLocation("A1");
    const parent = await makeArticle({ type: "manufactured", defaultLocationId: a1.id, batchTracked });
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Svets", active: true }));
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 10, runTimePerUnit: 2 });
    await mfgService.createRoutingOperation(parent.id, { sequenceNo: 20, workCenterId: workCenter.id, setupTime: 5, runTimePerUnit: 1 });
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 5 }, user.id);
    const [first] = (await mfgService.listOperations(order.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
    return { order, first: first! };
  }

  it("the internal card carries the TO number as BATCH when the article is batchstyrd (decision 17) — per operation and per report", async () => {
    const mo = await makeManufacturingOrder(true);
    const card = pdfText((await mfgService.getOperationPalletCardPdf(mo.order.id, mo.first.id)).content);
    expect(card).toContain("INTERNT");
    expect(card).toContain("BATCH");
    // The number: TILLVERKNINGSORDER, the reference "TO… · op 10" and the batch.
    expect(card.split(mo.order.orderNumber).length - 1).toBe(3);

    await mfgService.completeOperation(mo.first.id, parsed(completeOperationSchema, { quantityCompleted: 2 }), user.id);
    const [report] = await mfgService.listReports(mo.order.id);
    expect(pdfText((await mfgService.getReportPalletCardPdf(mo.order.id, report!.id)).content)).toContain("BATCH");
  });

  it("…and no BATCH cell for an article without batches", async () => {
    const mo = await makeManufacturingOrder(false);
    const card = pdfText((await mfgService.getOperationPalletCardPdf(mo.order.id, mo.first.id)).content);
    expect(card).not.toContain("BATCH");
    expect(card.split(mo.order.orderNumber).length - 1).toBe(2);
  });
});

describe("Räknelistan", () => {
  it("prints the batch under each row of a batchstyrd article — Okänd under its label — and nothing for other articles", async () => {
    const { article, a1 } = await stocked();
    const plain = await makeArticle({ batchTracked: false, name: "Skruv" });
    await adjust(plain.id, a1.id, 7);
    const session = await countRepo.createSession({ locationId: a1.id, blocksTransactions: false }, null);
    const text = pdfText((await countService.getCountSheetPdf(session.id, true)).content);
    expect(text).toContain("Batch: Okänd");
    expect(text).toContain("Batch: GAMMAL");
    expect(text).toContain("Batch: NY");
    expect(text.split("Batch:").length - 1).toBe(3);
    expect(text.split(article.articleNumber).length - 1).toBe(3);
  });
});

describe("Lagerloggens export", () => {
  function buildApp() {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { id: user.id, role: "admin", permissions: [] };
    });
    app.register(stockRoutes, { service: stockService, valuation: {} as never, counts: {} as never });
    return app;
  }

  it("the CSV and its Excel twin carry the column Batch — the number, blank for Okänd", async () => {
    const { article } = await stocked();
    const rows = (await stockService.listTransactions(parsed(listStockTransactionsQuerySchema, { articleId: article.id }))).rows;
    expect(rows.map((r) => r.batchNumber).sort()).toEqual(["GAMMAL", "GAMMAL", "NY", null].sort());

    const app = buildApp();
    const csv = await app.inject({ method: "GET", url: `/stock/transactions/csv?articleId=${article.id}` });
    expect(csv.statusCode).toBe(200);
    const lines = csv.body.replace(/^﻿/, "").trim().split(/\r?\n/);
    const header = lines[0]!.split(";");
    expect(header.slice(0, 6)).toEqual(["Datum", "Registrerad", "Artikel", "Lagerplats", "Batch", "Typ"]);
    const column = header.indexOf("Batch");
    expect(lines.slice(1).map((line) => line.split(";")[column]).sort()).toEqual(["", "GAMMAL", "GAMMAL", "NY"]);

    const xlsx = await app.inject({ method: "GET", url: `/stock/transactions/xlsx?articleId=${article.id}` });
    expect(xlsx.statusCode).toBe(200);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe("PK");
  });
});
