import {
  completeOperationSchema,
  createArticleSchema,
  createCustomerSchema,
  createQuoteSchema,
  createStockLocationSchema,
  createWorkCenterSchema,
  deliverBatchSchema,
  listStockBatchesQuerySchema,
  updateSystemSettingsSchema,
} from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import { db, deliveryRows, numberSeries, permissionGroups, stockBatches, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { formatSerialInfo } from "../src/modules/mail/service/document-pdf.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { deliveredBatchesForOrderRows, deliveredSerialsForOrderRows } from "../src/modules/sales/repository/delivered-batches.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createSalesService, pickListCellLines } from "../src/modules/sales/service/sales.service.js";
import { createStockCountRepository } from "../src/modules/stock/repository/stock-count.repository.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { StockBatchNotFoundError } from "../src/modules/stock/service/batch.errors.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { createStockCountService } from "../src/modules/stock/service/stock-count.service.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { pdfRects, pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline, testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Serienummer (#8 etapp 2, steg 5) — on the documents (följesedel, pallkort,
// faktura fryst vid Utfärda, plocklista, räknelista, TO:ns pallkort), in the
// trace (the group node against Postgres, a number created at a delivery and
// a burnt one) and on the labels. The compression itself is
// serials.shared.test.ts, the tree's rules batch-trace.test.ts.

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

const TABLES = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_rows, invoices, audit_log, stock_count_rows, stock_count_sessions, mo_reports, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, delivery_rows, deliveries, sales_order_rows, sales_orders, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'SDO%'`;
const resetSetting = () => db.delete(systemSettings).where(eq(systemSettings.key, BATCH_TRACKING_ENABLED_KEY));
const resetSeries = async () => {
  await db.delete(numberSeries).where(like(numberSeries.key, "serial\\_%"));
  await db.update(numberSeries).set({ prefix: "SN-", nextNumber: 1, digits: 6 }).where(eq(numberSeries.key, "serial"));
};

let user: { id: string };
let warehouseId: string;

beforeEach(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
  await resetSetting();
  await resetSeries();
  await setupPostingBaseline();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
  user = await authRepo.create({ email: `serial-doc-${crypto.randomUUID()}@example.com`, passwordHash: "not-a-real-hash", name: "Lagerchef", role: "admin" });
  warehouseId = (await stockService.createWarehouse({ name: "Huvudlager", active: true }))!.id;
});

afterAll(async () => {
  await db.execute(TABLES);
  await db.execute(DELETE_GROUPS);
  await resetSetting();
  await resetSeries();
});

const makeLocation = async (name: string) => (await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId, name, active: true })))!;
let n = 0;
const makeArticle = (patch: Record<string, unknown> = {}) =>
  articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `SD-${++n}-${crypto.randomUUID().slice(0, 6)}`, name: "Motor", type: "purchased", active: true, tracking: "serial", ...patch })
  );
const sn = (i: number) => `SN-${String(i).padStart(6, "0")}`;
const s = (i: number) => `S-${String(i).padStart(2, "0")}`;
const adjust = (articleId: string, locationId: string, quantityDelta: number, batchNumber?: string) =>
  stockService.recordTransaction({ articleId, locationId, quantityDelta, transactionType: "inventory_adjustment", batchNumber });
const DAY = 24 * 60 * 60 * 1000;
async function idOf(articleId: string, number: string) {
  const [row] = await db.select().from(stockBatches).where(and(eq(stockBatches.articleId, articleId), eq(stockBatches.batchNumber, number)));
  return row!.id;
}
const idsOf = (articleId: string, ...numbers: string[]) => Promise.all(numbers.map((number) => idOf(articleId, number)));

// S-01 … S-<count> on A1, the lowest number the oldest.
async function stocked(count: number, patch: Record<string, unknown> = {}) {
  const a1 = await makeLocation("A1");
  const article = await makeArticle({ defaultLocationId: a1.id, ...patch });
  for (let i = 1; i <= count; i++) {
    await adjust(article.id, a1.id, 1, s(i));
    await db
      .update(stockBatches)
      .set({ createdAt: new Date(Date.now() - (100 - i) * DAY) })
      .where(and(eq(stockBatches.articleId, article.id), eq(stockBatches.batchNumber, s(i))));
  }
  return { article, a1 };
}

async function makeOrder(articleId: string, quantity: number, customerPatch: Record<string, unknown> = {}) {
  const customer = await salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", active: true, ...customerPatch }));
  const { order, rows } = await salesService.createQuote(parsed(createQuoteSchema, { customerId: customer.id, rows: [{ articleId, quantity, unitPrice: 10 }] }), user.id);
  await salesService.confirm(order.id);
  await salesService.startProduction(order.id);
  return { customer, order, row: rows[0]! };
}

type DeliverRow = { rowId: string; quantity: number; locationId?: string; batchId?: string | null; serialIds?: string[]; serialNumbers?: string[] };
async function deliver(orderId: string, rows: DeliverRow[]) {
  const result = await salesService.deliverBatch(orderId, parsed(deliverBatchSchema, { rows }), user.id);
  const [deliveryRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, result.deliveryId));
  return { ...result, deliveryRowId: deliveryRow!.id };
}

const noteText = async (deliveryId: string) => pdfText((await salesService.deliveryNotePdf(deliveryId)).pdf);
const cardText = async (deliveryId: string) => pdfText((await salesService.deliveryPalletCardPdf(deliveryId)).pdf);
const flat = (text: string) => text.replace(/\s+/g, " ");

describe("formatSerialInfo", () => {
  it("compresses to ranges, lists the rest, and is null without numbers", () => {
    expect(formatSerialInfo([])).toBeNull();
    expect(formatSerialInfo(["SN-1015", ...Array.from({ length: 10 }, (_, i) => `SN-${1001 + i}`)])).toBe("SN-1001–SN-1010, SN-1015");
  });
});

describe("Följesedel and pallkort till kund — serienummer ur lagret", () => {
  it("print the row's numbers compressed; Okänd never, and no Batch line for a serial number", async () => {
    const { article, a1 } = await stocked(12);
    await adjust(article.id, a1.id, 2);
    const { order, row } = await makeOrder(article.id, 20);
    const chosen = await deliver(order.id, [{ rowId: row.id, quantity: 5, serialIds: await idsOf(article.id, s(9), s(1), s(3), s(2), s(7)) }]);

    const note = await noteText(chosen.deliveryId);
    expect(note).toContain("Serienummer: S-01–S-03, S-07, S-09");
    expect(note).not.toContain("Batch");
    expect(note).not.toContain("Okänd");

    const card = await cardText(chosen.deliveryId);
    expect(card).toContain("SERIENUMMER");
    expect(card).toContain("S-01–S-03, S-07, S-09");
    expect(card).not.toContain("BATCH");

    // Automatiskt: Okänd 2 first, then the oldest number left — only the
    // number is printed.
    const automatic = await deliver(order.id, [{ rowId: row.id, quantity: 3 }]);
    const automaticNote = await noteText(automatic.deliveryId);
    expect(automaticNote).toContain("Serienummer: S-04");
    expect(automaticNote).not.toContain("Okänd");

    // Okänd only: no line and no cell.
    const unknown = await makeOrder(article.id, 1);
    await adjust(article.id, a1.id, 1);
    const none = await deliver(unknown.order.id, [{ rowId: unknown.row.id, quantity: 1, batchId: null }]);
    expect(await noteText(none.deliveryId)).not.toContain("Serienummer");
    expect(await cardText(none.deliveryId)).not.toContain("SERIENUMMER");
  });

  it("an English customer reads Serial no.", async () => {
    const { article } = await stocked(4);
    const { order, row } = await makeOrder(article.id, 4, { language: "en" });
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 4 }]);
    const note = await salesService.deliveryNotePdf(d.deliveryId);
    expect(note.filename).toMatch(/^Delivery-note-/);
    const text = pdfText(note.pdf);
    expect(text).toContain("Serial no.: S-01–S-04");
    expect(text).not.toContain("Serienummer");
    const card = await cardText(d.deliveryId);
    expect(card).toContain("SERIAL NO.");
    expect(card).toContain("S-01–S-04");
    expect(card).not.toContain("SERIENUMMER");
  });

  it("numbers that do not fit the pallet card's cell become the count with a pointer to the följesedel — the card keeps its height", async () => {
    const a1 = await makeLocation("A1");
    const article = await makeArticle({ defaultLocationId: a1.id });
    const numbers = Array.from({ length: 8 }, (_, i) => `MÄRKSKYLT-${String(1001 + 2 * i)}`);
    for (const number of numbers) await adjust(article.id, a1.id, 1, number);
    const { order, row } = await makeOrder(article.id, 8);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 8 }]);

    const pdf = (await salesService.deliveryPalletCardPdf(d.deliveryId)).pdf;
    const card = pdfText(pdf);
    expect(card).toContain("SERIENUMMER");
    expect(card).toContain("8 st — se följesedel");
    expect(card).not.toContain("MÄRKSKYLT-1003");
    // The följesedel lists every one of them.
    const note = flat(await noteText(d.deliveryId));
    for (const number of numbers) expect(note).toContain(number);

    // The frame is exactly as tall as that of a card without the cell.
    const plain = await makeArticle({ tracking: "none", defaultLocationId: a1.id });
    await adjust(plain.id, a1.id, 5);
    const other = await makeOrder(plain.id, 5);
    const plainDelivery = await deliver(other.order.id, [{ rowId: other.row.id, quantity: 5 }]);
    const frameOf = (buffer: Buffer) => pdfRects(buffer).filter((r) => r.width > 400 && r.height > 100)[0]!;
    expect(frameOf(pdf).height).toBeCloseTo(frameOf((await salesService.deliveryPalletCardPdf(plainDelivery.deliveryId)).pdf).height, 3);

    const english = await makeOrder(article.id, 8, { language: "en" });
    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.deliveryRowId, user.id);
    const again = await deliver(english.order.id, [{ rowId: english.row.id, quantity: 8 }]);
    expect(await cardText(again.deliveryId)).toContain("8 pcs — see delivery note");
  });

  it("an article that changed Spårning prints both: its old batch as Batch and its numbers as Serienummer — the sort is the row's", async () => {
    const a1 = await makeLocation("A1");
    const article = await makeArticle({ tracking: "batch", defaultLocationId: a1.id });
    await adjust(article.id, a1.id, 5, "GAMMAL");
    await db.update(stockBatches).set({ createdAt: new Date(Date.now() - 50 * DAY) }).where(eq(stockBatches.batchNumber, "GAMMAL"));
    await articleService.updateArticle(article.id, { tracking: "serial" });
    await adjust(article.id, a1.id, 1, "S-1");
    await adjust(article.id, a1.id, 1, "S-2");
    const { customer, order, row } = await makeOrder(article.id, 7);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 7 }]);

    const note = await noteText(d.deliveryId);
    expect(note).toContain("Batch: GAMMAL (5)");
    expect(note).toContain("Serienummer: S-1, S-2");
    const card = await cardText(d.deliveryId);
    expect(card).toContain("GAMMAL (5)");
    expect(card).toContain("S-1, S-2");

    // The invoice's two readers split the same way.
    expect((await deliveredBatchesForOrderRows(db, [row.id])).get(row.id)).toMatchObject({ complete: false, batches: [{ batchNumber: "GAMMAL", quantity: 5 }] });
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Del", articleId: article.id, salesOrderRowId: row.id, quantity: 7, unitPrice: 10 }] },
      user.id
    );
    const issued = (await invoiceService.issue(draft!.id, user.id))!;
    const invoice = pdfText((await invoiceService.renderPdf(issued.id)).content);
    expect(invoice).toContain("Batch: GAMMAL (5)");
    expect(invoice).toContain("Serienummer: S-1, S-2");

    // Spårning Ingen: the batch is no longer printed (decision 10) — the
    // serial numbers are the styck's own and stay.
    await articleService.updateArticle(article.id, { tracking: "none" });
    const after = await noteText(d.deliveryId);
    expect(after).not.toContain("Batch");
    expect(after).toContain("Serienummer: S-1, S-2");
  });
});

describe("Serienummer skapas vid utleverans — on the documents", () => {
  async function atDelivery() {
    const a1 = await makeLocation("A1");
    const article = await makeArticle({ defaultLocationId: a1.id, serialAssignedAt: "delivery" });
    await adjust(article.id, a1.id, 20);
    return { article, a1 };
  }

  it("följesedeln and the pallet card carry the numbers the delivery gave — the series' and the hand-written ones", async () => {
    const { article } = await atDelivery();
    const { order, row } = await makeOrder(article.id, 10);
    const first = await deliver(order.id, [{ rowId: row.id, quantity: 3 }]);
    expect(await noteText(first.deliveryId)).toContain(`Serienummer: ${sn(1)}–${sn(3)}`);
    const card = await cardText(first.deliveryId);
    expect(card).toContain("SERIENUMMER");
    expect(card).toContain(`${sn(1)}–${sn(3)}`);

    const own = await deliver(order.id, [{ rowId: row.id, quantity: 2, serialNumbers: ["MÄRK-9", "MÄRK-7"] }]);
    const ownNote = await noteText(own.deliveryId);
    expect(ownNote).toContain("Serienummer: MÄRK-7, MÄRK-9");
    expect(ownNote).not.toContain("Okänd");
    expect(ownNote).not.toContain("Batch");
  });

  it("the invoice carries the order row's numbers, frozen at Utfärda: an Ångra utleverans afterwards burns the numbers but never changes the issued invoice; a credit note prints none", async () => {
    const { article } = await atDelivery();
    const { customer, order, row } = await makeOrder(article.id, 10);
    const first = await deliver(order.id, [{ rowId: row.id, quantity: 3 }]);
    const second = await deliver(order.id, [{ rowId: row.id, quantity: 2, serialNumbers: ["MÄRK-9", "MÄRK-7"] }]);
    expect((await deliveredSerialsForOrderRows(db, [row.id])).get(row.id)).toEqual(["MÄRK-7", "MÄRK-9", sn(1), sn(2), sn(3)]);

    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Del", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 }] },
      user.id
    );
    const issued = (await invoiceService.issue(draft!.id, user.id))!;
    const line = `Serienummer: MÄRK-7, MÄRK-9, ${sn(1)}–${sn(3)}`;
    expect(flat(pdfText((await invoiceService.renderPdf(issued.id)).content))).toContain(line);

    // 5 delivered, 3 invoiced: the two hand-written ones can be undone.
    await salesService.undoDeliveryRow(order.id, second.deliveryId, second.deliveryRowId, user.id);
    expect((await deliveredSerialsForOrderRows(db, [row.id])).get(row.id)).toEqual([sn(1), sn(2), sn(3)]);
    expect(flat(pdfText((await invoiceService.renderPdf(issued.id)).content))).toContain(line);
    // The undone följesedel row is marked and its burnt numbers are gone; the other one is as it was.
    const undone = await noteText(second.deliveryId);
    expect(undone).toContain("Ångrad");
    expect(undone).not.toContain("Serienummer");
    expect(undone).not.toContain("MÄRK-7");
    expect(await noteText(first.deliveryId)).toContain(`Serienummer: ${sn(1)}–${sn(3)}`);

    const credit = await invoiceService.createCredit(issued.id, {}, user.id);
    const issuedCredit = (await invoiceService.issue(credit!.id, user.id))!;
    const creditText = pdfText((await invoiceService.renderPdf(issuedCredit.id)).content);
    expect(creditText).toContain("Kreditfaktura");
    expect(creditText).not.toContain("Serienummer");
  });
});

describe("Fakturan — serienummer ur lagret", () => {
  it("is frozen at Utfärda like the batch, and writes no Batch line for a serial number", async () => {
    const { article } = await stocked(6);
    const { customer, order, row } = await makeOrder(article.id, 6);
    await deliver(order.id, [{ rowId: row.id, quantity: 3 }]);
    const second = await deliver(order.id, [{ rowId: row.id, quantity: 1, serialIds: await idsOf(article.id, s(6)) }]);
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Del", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 }] },
      user.id
    );
    const issued = (await invoiceService.issue(draft!.id, user.id))!;
    const text = pdfText((await invoiceService.renderPdf(issued.id)).content);
    expect(text).toContain("Serienummer: S-01–S-03, S-06");
    expect(text).not.toContain("Batch");
    await salesService.undoDeliveryRow(order.id, second.deliveryId, second.deliveryRowId, user.id);
    expect((await deliveredSerialsForOrderRows(db, [row.id])).get(row.id)).toEqual([s(1), s(2), s(3)]);
    expect(pdfText((await invoiceService.renderPdf(issued.id)).content)).toContain("Serienummer: S-01–S-03, S-06");
  });
});

describe("Plocklistan", () => {
  it("pickListCellLines: a place's serial numbers together, compressed, on the line of its oldest number; batches and Okänd as before", () => {
    const cell = (locationName: string, batchNumber: string | null, batchKind: "batch" | "serial" | null, patch: Record<string, unknown> = {}) => ({
      locationId: locationName,
      warehouseName: "Huvudlager",
      locationName,
      batchNumber,
      batchKind,
      expiresOn: null,
      expired: false,
      quantity: "1.0000",
      ...patch,
    });
    expect(
      pickListCellLines([
        cell("A1", null, null, { quantity: "2.0000" }),
        cell("A1", "S-01", "serial"),
        cell("B2", "S-02", "serial"),
        cell("A1", "S-03", "serial"),
        cell("A1", "S-04", "serial"),
        cell("A1", "S-05", "serial"),
        cell("A1", "L-778", "batch", { quantity: "6.0000", expiresOn: "2027-03-01" }),
        cell("A1", "S-20", "serial", { expiresOn: "2020-01-01", expired: true }),
      ])
    ).toEqual([
      "Huvudlager — A1 · Batch Okänd: 2",
      "Huvudlager — A1 · Serienummer S-01, S-03–S-05: 4",
      "Huvudlager — B2 · Serienummer S-02: 1",
      "Huvudlager — A1 · Batch L-778 utg. 2027-03-01: 6",
      "Huvudlager — A1 · Serienummer S-20 utg. 2020-01-01: 1 — UTGÅNGEN — plocka inte",
    ]);
  });

  it("prints the numbers per place for a serial article — blocked places left out", async () => {
    const { article, a1 } = await stocked(5);
    const [b2, sp] = [await makeLocation("B2"), await makeLocation("SP")];
    await adjust(article.id, b2.id, 1, s(6));
    await adjust(article.id, b2.id, 1, s(8));
    await adjust(article.id, sp.id, 1, "S-99");
    await stockService.blockLocation(sp.id, "Karantän", user.id);
    await adjust(article.id, a1.id, 2);
    const { order } = await makeOrder(article.id, 6);
    const text = flat(pdfText((await salesService.getPickListPdf(order.id)).content));
    expect(text).toContain("Batch Okänd: 2");
    expect(text).toContain("Serienummer S-01–S-05: 5");
    expect(text).toContain("Serienummer S-06, S-08: 2");
    expect(text).not.toContain("S-99");
  });
});

describe("Räknelistan", () => {
  it("has one row per serial number — Serienummer under the name — and Okänd as a batch row", async () => {
    const { article, a1 } = await stocked(3);
    await adjust(article.id, a1.id, 2);
    const session = await countRepo.createSession({ locationId: a1.id, blocksTransactions: false }, null);
    const text = pdfText((await countService.getCountSheetPdf(session.id, true)).content);
    for (const number of [s(1), s(2), s(3)]) expect(text).toContain(`Serienummer: ${number}`);
    expect(text.split("Serienummer:").length - 1).toBe(3);
    expect(text).toContain("Batch: Okänd");
    expect(text.split(article.articleNumber).length - 1).toBe(4);
  });
});

// A serial-numbered manufactured article with one operation and one batch-
// tracked component (2 per styck, L-1 on A1).
async function manufactured(quantity: number) {
  const a1 = await makeLocation("A1");
  const raw = await makeArticle({ tracking: "batch", name: "Plåt", defaultLocationId: a1.id });
  const parent = await makeArticle({ type: "manufactured", defaultLocationId: a1.id });
  const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Montering", active: true }));
  const op = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 0, runTimePerUnit: 1 });
  await articleService.addBomComponent(parent.id, { componentArticleId: raw.id, quantity: 2, routingOperationId: op.id });
  await adjust(raw.id, a1.id, 100, "L-1");
  const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity }, user.id);
  const [operation] = await mfgService.listOperations(order.id);
  return { a1, raw, parent, order, operation: operation! };
}

describe("TO:ns pallkort", () => {
  it("carries the numbers the TO has received so far — none before the first inleverans, none of an undone report", async () => {
    const mo = await manufactured(5);
    const before = pdfText((await mfgService.getOperationPalletCardPdf(mo.order.id, mo.operation.id)).content);
    expect(before).not.toContain("SERIENUMMER");

    await mfgService.completeOperation(mo.operation.id, parsed(completeOperationSchema, { quantityCompleted: 3 }), user.id);
    const [report] = await mfgService.listReports(mo.order.id);
    expect(report!.receiptSerialNumbers).toEqual([sn(1), sn(2), sn(3)]);
    const card = pdfText((await mfgService.getOperationPalletCardPdf(mo.order.id, mo.operation.id)).content);
    expect(card).toContain("SERIENUMMER");
    expect(card).toContain(`${sn(1)}–${sn(3)}`);
    expect(card).not.toContain("BATCH");
    expect(pdfText((await mfgService.getReportPalletCardPdf(mo.order.id, report!.id)).content)).toContain(`${sn(1)}–${sn(3)}`);
    // A second report: its own card carries its own numbers, the operation's all of them.
    await mfgService.completeOperation(mo.operation.id, parsed(completeOperationSchema, { quantityCompleted: 2 }), user.id);
    const [latest] = await mfgService.listReports(mo.order.id);
    expect(latest!.receiptSerialNumbers).toEqual([sn(4), sn(5)]);
    const latestCard = pdfText((await mfgService.getReportPalletCardPdf(mo.order.id, latest!.id)).content);
    expect(latestCard).toContain(`${sn(4)}, ${sn(5)}`);
    expect(latestCard).not.toContain(sn(1));
    expect(pdfText((await mfgService.getOperationPalletCardPdf(mo.order.id, mo.operation.id)).content)).toContain(`${sn(1)}–${sn(5)}`);
    await mfgService.undoReport(mo.order.id, latest!.id, user.id);

    await mfgService.undoReport(mo.order.id, report!.id, user.id);
    expect(pdfText((await mfgService.getOperationPalletCardPdf(mo.order.id, mo.operation.id)).content)).not.toContain("SERIENUMMER");
  });
});

describe("Spårningen för serienummer", () => {
  const list = (query: Record<string, unknown>) => stockService.listBatches(parsed(listStockBatchesQuerySchema, query));

  it("a råvarubatch forward: the TO's numbers are ONE group node, its utleveranser per följesedel with their numbers, the rest per place; backward from a delivered number: its TO and the batch it drew", async () => {
    const mo = await manufactured(5);
    await mfgService.completeOperation(mo.operation.id, parsed(completeOperationSchema, { quantityCompleted: 5 }), user.id);
    const first = await makeOrder(mo.parent.id, 2);
    const second = await makeOrder(mo.parent.id, 1, { name: "Annan Kund AB" });
    const d1 = await deliver(first.order.id, [{ rowId: first.row.id, quantity: 2, serialIds: await idsOf(mo.parent.id, sn(1), sn(2)) }]);
    const d2 = await deliver(second.order.id, [{ rowId: second.row.id, quantity: 1, serialIds: await idsOf(mo.parent.id, sn(4)) }]);

    const forward = (await stockService.traceBatch(await idOf(mo.raw.id, "L-1"))).forward;
    expect(forward.batch).toMatchObject({ batchNumber: "L-1", kind: "batch", burnt: false });
    expect(forward.consumedBy).toHaveLength(1);
    expect(forward.consumedBy[0]).toMatchObject({ manufacturingOrderId: mo.order.id, quantity: 10 });
    const [group, ...others] = forward.consumedBy[0]!.produced;
    expect(others).toEqual([]);
    expect(group).toMatchObject({
      stop: null,
      quantity: 5,
      batch: { batchNumber: sn(1), kind: "serial", articleId: mo.parent.id },
      serials: { count: 5, numbers: `${sn(1)}–${sn(5)}` },
      onHand: [{ locationName: "A1", quantity: 2 }],
      consumedBy: [],
      events: [],
    });
    expect(group!.serials!.batchIds).toEqual(await idsOf(mo.parent.id, sn(1), sn(2), sn(3), sn(4), sn(5)));
    expect(group!.deliveries).toHaveLength(2);
    expect(group!.deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deliveryId: d1.deliveryId, customerName: "Kund AB", quantity: 2, serialNumbers: `${sn(1)}, ${sn(2)}`, undoneAt: null }),
        expect.objectContaining({ deliveryId: d2.deliveryId, customerName: "Annan Kund AB", quantity: 1, serialNumbers: sn(4), undoneAt: null }),
      ])
    );

    // One number of its own: an ordinary node.
    const one = await stockService.traceBatch(await idOf(mo.parent.id, sn(4)));
    expect(one.batch).toMatchObject({ batchNumber: sn(4), kind: "serial", tracking: "serial", batchTracked: false, burnt: false });
    expect(one.forward.serials).toBeUndefined();
    expect(one.forward.deliveries).toMatchObject([{ deliveryId: d2.deliveryId, quantity: 1 }]);
    expect(one.forward.onHand).toEqual([]);
    expect(one.backward.deliveryOrigin).toBeUndefined();
    expect(one.backward.manufacturingOrders).toHaveLength(1);
    expect(one.backward.manufacturingOrders[0]).toMatchObject({ manufacturingOrderId: mo.order.id, quantity: 1 });
    // The material is the TO's, not the styck's.
    expect(one.backward.manufacturingOrders[0]!.materials).toMatchObject([{ batch: { batchNumber: "L-1", kind: "batch" }, quantity: 10, stop: null }]);
    expect(one.truncated).toBe(false);

    // The register: kind on the rows and as a filter.
    expect((await list({ kind: "serial" })).total).toBe(5);
    expect((await list({ kind: "batch" })).rows).toMatchObject([{ batchNumber: "L-1", kind: "batch", burnt: false }]);
    expect((await list({ search: sn(4) })).rows).toMatchObject([{ batchNumber: sn(4), kind: "serial", origin: "manufacturing_order", quantity: 0 }]);
  });

  it("backward through a TO that drew serial numbers: they are one group node with their inleverans merged", async () => {
    const a1 = await makeLocation("A1");
    const part = await makeArticle({ defaultLocationId: a1.id, name: "Givare" });
    const parent = await makeArticle({ tracking: "batch", type: "manufactured", defaultLocationId: a1.id });
    const workCenter = await mfgService.createWorkCenter(parsed(createWorkCenterSchema, { code: "100", name: "Montering", active: true }));
    const op = await mfgService.createRoutingOperation(parent.id, { sequenceNo: 10, workCenterId: workCenter.id, setupTime: 0, runTimePerUnit: 1 });
    await articleService.addBomComponent(parent.id, { componentArticleId: part.id, quantity: 1, routingOperationId: op.id });
    for (let i = 1; i <= 4; i++) await adjust(part.id, a1.id, 1, s(i));
    const order = await mfgService.createManufacturingOrder({ articleId: parent.id, quantity: 3 }, user.id);
    const [operation] = await mfgService.listOperations(order.id);
    await mfgService.completeOperation(operation!.id, parsed(completeOperationSchema, { quantityCompleted: 3 }), user.id);

    const trace = await stockService.traceBatch(await idOf(parent.id, order.orderNumber));
    const [group, ...others] = trace.backward.manufacturingOrders[0]!.materials;
    expect(others).toEqual([]);
    expect(group).toMatchObject({ stop: null, quantity: 3, batch: { kind: "serial", articleId: part.id }, serials: { count: 3 }, receipts: [], manufacturingOrders: [] });
    // The three numbers each came in through a justering of 1 — one event of 3.
    expect(group!.events).toMatchObject([{ kind: "adjustment", quantity: 3 }]);
    expect(trace.truncated).toBe(false);
  });

  it("a number created at a delivery: forward its följesedel, order and customer; backward the delivery that created it and nothing more", async () => {
    const a1 = await makeLocation("A1");
    const article = await makeArticle({ defaultLocationId: a1.id, serialAssignedAt: "delivery" });
    await adjust(article.id, a1.id, 20);
    const { order, row, customer } = await makeOrder(article.id, 10);
    const d = await deliver(order.id, [{ rowId: row.id, quantity: 3 }]);
    const id = await idOf(article.id, sn(2));

    const trace = await stockService.traceBatch(id);
    expect(trace.batch).toMatchObject({ batchNumber: sn(2), kind: "serial", origin: "delivery", burnt: false });
    expect(trace.forward).toMatchObject({ stop: null, consumedBy: [], events: [], onHand: [] });
    expect(trace.forward.deliveries).toMatchObject([
      { deliveryId: d.deliveryId, salesOrderId: order.id, customerId: customer.id, customerName: "Kund AB", quantity: 1, undoneAt: null },
    ]);
    expect(trace.backward).toMatchObject({ stop: null, receipts: [], manufacturingOrders: [], events: [] });
    expect(trace.backward.deliveryOrigin).toMatchObject({
      deliveryId: d.deliveryId,
      deliveryRowId: d.deliveryRowId,
      salesOrderId: order.id,
      salesOrderRowId: row.id,
      customerName: "Kund AB",
      rowQuantity: 3,
      undoneAt: null,
    });
    expect(trace.backward.deliveryOrigin!.deliveryNumber).toBe(trace.forward.deliveries[0]!.deliveryNumber);
    expect((await list({ search: sn(2) })).rows).toMatchObject([{ kind: "serial", origin: "delivery", burnt: false, quantity: 0 }]);

    // Ångra utleverans burns the number: it is shown as ångrad, both ways.
    await salesService.undoDeliveryRow(order.id, d.deliveryId, d.deliveryRowId, user.id);
    const burnt = await stockService.traceBatch(id);
    expect(burnt.batch.burnt).toBe(true);
    expect(burnt.forward.deliveries).toHaveLength(1);
    expect(typeof burnt.forward.deliveries[0]!.undoneAt).toBe("string");
    expect(typeof burnt.backward.deliveryOrigin!.undoneAt).toBe("string");
    expect((await list({ search: sn(2) })).rows).toMatchObject([{ burnt: true }]);
    // A new delivery gets new numbers; the burnt ones stay burnt.
    const again = await deliver(order.id, [{ rowId: row.id, quantity: 1 }]);
    expect(again.assignedSerials).toEqual([{ rowId: row.id, serialNumbers: [sn(4)] }]);
    expect((await list({ kind: "serial", limit: 50 })).rows.map((r) => [r.batchNumber, r.burnt]).sort()).toEqual([
      [sn(1), true],
      [sn(2), true],
      [sn(3), true],
      [sn(4), false],
    ]);
  });
});

describe("Batch- och serienummeretiketter", () => {
  it("renderBatchLabels: one label per number and copy, with the article — the row's own sort as the eyebrow", async () => {
    const { article, a1 } = await stocked(3);
    const batchArticle = await makeArticle({ tracking: "batch", name: "Plåt" });
    await adjust(batchArticle.id, a1.id, 5, "L-778");
    const ids = [...(await idsOf(article.id, s(2), s(1))), await idOf(batchArticle.id, "L-778"), crypto.randomUUID()];

    const sheet = pdfText(await stockService.renderBatchLabels({ batchIds: ids, format: "a4", copies: 2, start: 3 }));
    expect(sheet.split("SERIENUMMER").length - 1).toBe(4);
    expect(sheet.split("BATCH").length - 1).toBe(2);
    expect(sheet).toContain(s(1));
    expect(sheet).toContain("L-778");
    expect(flat(sheet)).toContain(`${article.articleNumber} · Motor`);
    expect(sheet).not.toContain(s(3));

    const single = await stockService.renderBatchLabels({ batchIds: [ids[0]!], format: "single", copies: 1, start: 1 });
    expect(pdfText(single)).toContain(s(2));
    await expect(stockService.renderBatchLabels({ batchIds: [crypto.randomUUID()], format: "a4", copies: 1, start: 1 })).rejects.toThrow(StockBatchNotFoundError);
  });

  describe("POST /stock/batches/labels", () => {
    const authService = createAuthService(authRepo, "unused", auditRepository);
    const PASSWORD = "correcthorsebattery";
    let app: ReturnType<typeof buildApp>;

    beforeAll(async () => {
      app = buildApp();
      await app.ready();
    });
    afterAll(async () => {
      await app.close();
    });

    async function userCookie(permissions: string[], readOnly = false) {
      const [group] = await db
        .insert(permissionGroups)
        .values({ code: `SDO${crypto.randomUUID().slice(0, 6)}`, name: "Etiketter", permissions })
        .returning();
      const email = `labels-${crypto.randomUUID()}@example.com`;
      await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
      const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
      expect(res.statusCode).toBe(200);
      return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
    }
    const post = (cookie: string, payload: unknown) =>
      app.inject({ method: "POST", url: "/api/v1/stock/batches/labels", headers: { cookie, origin: "http://localhost" }, payload: payload as object });

    it("office prints (an Endast läsning account too), the terminal alone is refused; 404 for unknown ids and 400 for a bad body", async () => {
      const { article } = await stocked(2);
      const batchIds = await idsOf(article.id, s(1), s(2));

      const buyer = await userCookie(["inkop"]);
      const printed = await post(buyer, { batchIds, format: "single" });
      expect(printed.statusCode).toBe(200);
      expect(printed.headers["content-type"]).toBe("application/pdf");
      expect(printed.headers["content-disposition"]).toContain("batchetiketter.pdf");
      const text = pdfText(printed.rawPayload);
      expect(text).toContain(s(1));
      expect(text).toContain("SERIENUMMER");

      expect((await post(await userCookie(["lager"], true), { batchIds, format: "a4", copies: 2, start: 5 })).statusCode).toBe(200);
      expect((await post(await userCookie(["terminal"]), { batchIds, format: "a4" })).statusCode).toBe(403);

      const missing = await post(buyer, { batchIds: [crypto.randomUUID()], format: "a4" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().code).toBe("stock-batch-not-found");
      expect((await post(buyer, { batchIds: [], format: "a4" })).statusCode).toBe(400);
      expect((await post(buyer, { batchIds, format: "a5" })).statusCode).toBe(400);
      expect((await post(buyer, { batchIds: ["inte-ett-id"], format: "a4" })).statusCode).toBe(400);
    });
  });
});

