import {
  createArticleSchema,
  createPurchaseOrderSchema,
  createStockLocationSchema,
  createSupplierSchema,
  receiptLabelsSchema,
  receiptPalletCardSchema,
  receiveGoodsSchema,
  updateSystemSettingsSchema,
} from "@navet/shared";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { db, permissionGroups, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import {
  createPurchaseService,
  PurchaseReceiptAlreadyUndoneError,
  PurchaseReceiptNotFoundError,
  PurchaseReceiptRowsDifferError,
} from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { BATCH_TRACKING_ENABLED_KEY } from "../src/modules/stock/service/batch-tracking.js";
import { MULTIPLE_WAREHOUSES_KEY } from "../src/modules/stock/service/warehouse-mode.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { stockholmDateOf } from "../src/modules/system/service/delivery-days.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { parsed } from "./helpers/parsed.js";
import { pdfPagesText, pdfRectCount, pdfRects, pdfText } from "./helpers/pdf.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";

// Etikett och pallkort vid inleverans: the inleveransetikett (A4-ark and
// etikettskrivare, label-pdf.ts) and the pallkort INLEVERANS (kind
// "receipt" in renderPalletCard) for receipts on an inköpsorder — what they
// print, the errors, and the two routes through the real app.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const auditRepository = createAuditRepository(db);
const salesRepository = createSalesRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});
const purchaseService = createPurchaseService(
  createPurchaseRepository(db),
  createRegisterService(createRegisterRepository(db)),
  createMailService(createMailRepository(db), testSystemService),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  auditRepository
);

const TABLES = sql`TRUNCATE audit_log, purchase_receipts, mo_reports, purchase_order_rows, purchase_orders, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_transactions, stock_batches, stock_locations, warehouses, bom_components, articles, users CASCADE`;
const SETTING_KEYS = [BATCH_TRACKING_ENABLED_KEY, MULTIPLE_WAREHOUSES_KEY, "pallet_card_code"];
const resetSettings = () => db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));

beforeEach(async () => {
  await db.execute(TABLES);
  await resetSettings();
  await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { batchTrackingEnabled: true }));
});
afterAll(async () => {
  await db.execute(TABLES);
  await resetSettings();
});

// One confirmed IO from "Stålbolaget AB" with three rows — plain, batchstyrd
// and serienummerstyrd — and one place, A1-03, in Huvudlager.
async function makeFixture() {
  const user = await authRepo.create({
    email: `receipt-print-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Mottagaren",
    role: "admin",
  });
  const supplier = await purchaseService.createSupplier(parsed(createSupplierSchema, { name: "Stålbolaget AB", active: true }));
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = (await stockService.createLocation(
    parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1-03", active: true })
  ))!;
  const article = (articleNumber: string, name: string, extra: Record<string, unknown> = {}) =>
    articleService.createArticle(parsed(createArticleSchema, { articleNumber, name, type: "purchased", active: true, ...extra }));
  const plain = await article("PL-2040", "Plåt 2 mm rostfri");
  const batched = await article("LIM-10", "Lim", { tracking: "batch" });
  const serial = await article("MOT-5", "Motor", { tracking: "serial" });
  // A service row books no stock row, so its receipt has no place.
  const service = await article("MONT-1", "Montage", { type: "service" });
  const order = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: supplier.id }), user.id);
  const plainRow = await purchaseService.addRow(order.id, { articleId: plain.id, quantity: 1000, unitPrice: 10 });
  const batchRow = await purchaseService.addRow(order.id, { articleId: batched.id, quantity: 50, unitPrice: 10 });
  const serialRow = await purchaseService.addRow(order.id, { articleId: serial.id, quantity: 5, unitPrice: 10 });
  const serviceRow = await purchaseService.addRow(order.id, { articleId: service.id, quantity: 1, unitPrice: 10 });
  await purchaseService.confirm(order.id);
  const receive = (rowId: string, quantity: number, extra: Record<string, unknown> = {}) =>
    purchaseService.receiveGoods(order.id, rowId, parsed(receiveGoodsSchema, { locationId: location.id, quantity, ...extra }), user.id);
  return { user, supplier, location, order, plainRow, batchRow, serialRow, serviceRow, receive };
}

const flat = (text: string) => text.replace(/\s+/g, " ");

// Visual check: PDF_DUMP_DIR=<dir> writes the labels and cards there, to
// rasterize with pdftoppm when the layout changes.
function dump(filename: string, content: Buffer) {
  const dir = process.env.PDF_DUMP_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content);
}

describe("inleveransetiketter", () => {
  it("prints one label per receipt and copy: the article and its quantity, the order and supplier, the day, the place and the batch or serial number", async () => {
    const f = await makeFixture();
    const plain = await f.receive(f.plainRow.id, 400);
    const batch = await f.receive(f.batchRow.id, 20, { batchNumber: "L-778", expiresOn: "2027-03-01" });
    const serials = await f.receive(f.serialRow.id, 2, { serialNumbers: ["SN-1", "SN-2"] });
    expect(serials.receiptIds).toHaveLength(2);
    const today = stockholmDateOf(new Date());

    const { pdf, filename } = await purchaseService.receiptLabelsPdf(
      f.order.id,
      parsed(receiptLabelsSchema, { receiptIds: [plain.receiptId, batch.receiptId, ...serials.receiptIds!], format: "single" })
    );
    expect(filename).toBe(`inleveransetiketter-${f.order.orderNumber}.pdf`);
    dump("etiketter-skrivare.pdf", pdf);
    const pages = pdfPagesText(pdf).map(flat);
    expect(pages).toHaveLength(4);
    for (const part of ["PL-2040", "400 st", "Plåt 2 mm rostfri", `${f.order.orderNumber} · Stålbolaget AB`, `Mottagen ${today} · A1-03`]) {
      expect(pages[0], part).toContain(part);
    }
    expect(pages[0]).not.toContain("Batch");
    expect(pages[1]).toContain("LIM-10");
    expect(pages[1]).toContain("20 st");
    expect(pages[1]).toContain("Batch L-778 utg. 2027-03-01");
    expect(pages[2]).toContain("Serienummer SN-1");
    expect(pages[2]).toContain("1 st");
    expect(pages[3]).toContain("Serienummer SN-2");
    // Flera lager off: the place without its lager.
    expect(pages.join(" ")).not.toContain("Huvudlager");
    // The article number as Code 128 (bars are rects).
    expect(pdfRectCount(pdf)).toBeGreaterThan(40);

    // A4-ark: copies per receipt, one sheet.
    const sheet = await purchaseService.receiptLabelsPdf(
      f.order.id,
      parsed(receiptLabelsSchema, { receiptIds: [plain.receiptId, batch.receiptId], format: "a4", copies: 3, start: 5 })
    );
    dump("etiketter-a4.pdf", sheet.pdf);
    const sheetText = pdfText(sheet.pdf);
    expect(sheetText.split("Plåt 2 mm rostfri").length - 1).toBe(3);
    expect(sheetText.split("L-778").length - 1).toBe(3);
    expect(pdfPagesText(sheet.pdf)).toHaveLength(1);
  });

  it("prints the place with its lager when Flera lager is on, and the received day of a backdated receipt", async () => {
    const f = await makeFixture();
    await db
      .insert(systemSettings)
      .values({ key: MULTIPLE_WAREHOUSES_KEY, value: "true" })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: "true" } });
    const yesterday = stockholmDateOf(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const receipt = await f.receive(f.plainRow.id, 5, { receivedOn: yesterday });
    const { pdf } = await purchaseService.receiptLabelsPdf(f.order.id, parsed(receiptLabelsSchema, { receiptIds: [receipt.receiptId], format: "a4" }));
    expect(flat(pdfText(pdf))).toContain(`Mottagen ${yesterday} · Huvudlager — A1-03`);
  });

  it("refuses an unknown receipt, one on another order (404) and an undone one (409)", async () => {
    const f = await makeFixture();
    const receipt = await f.receive(f.plainRow.id, 5);
    const input = (receiptIds: string[]) => parsed(receiptLabelsSchema, { receiptIds, format: "a4" });

    await expect(purchaseService.receiptLabelsPdf(f.order.id, input([crypto.randomUUID()]))).rejects.toThrow(PurchaseReceiptNotFoundError);
    const otherOrder = await purchaseService.createPurchaseOrder(parsed(createPurchaseOrderSchema, { supplierId: f.supplier.id }), f.user.id);
    await expect(purchaseService.receiptLabelsPdf(otherOrder.id, input([receipt.receiptId]))).rejects.toThrow(PurchaseReceiptNotFoundError);

    await purchaseService.undoReceipt(f.order.id, receipt.receiptId, f.user.id);
    await expect(purchaseService.receiptLabelsPdf(f.order.id, input([receipt.receiptId]))).rejects.toThrow(PurchaseReceiptAlreadyUndoneError);
    await expect(
      purchaseService.receiptPalletCardPdf(f.order.id, parsed(receiptPalletCardSchema, { cards: [{ receiptIds: [receipt.receiptId], quantities: [5] }] }))
    ).rejects.toThrow(PurchaseReceiptAlreadyUndoneError);
  });
});

describe("pallkort INLEVERANS", () => {
  it("prints one card per kolli with the receipt's grid, ending above the fold", async () => {
    const f = await makeFixture();
    await testSystemService.updateSettings(parsed(updateSystemSettingsSchema, { palletCardCode: "barcode" }));
    const batch = await f.receive(f.batchRow.id, 20, { batchNumber: "L-778", expiresOn: "2027-03-01" });

    const { pdf, filename } = await purchaseService.receiptPalletCardPdf(
      f.order.id,
      parsed(receiptPalletCardSchema, { cards: [{ receiptIds: [batch.receiptId], quantities: [12, 8] }] })
    );
    expect(filename).toContain(f.order.orderNumber);
    dump("pallkort-streckkod.pdf", pdf);
    const pages = pdfPagesText(pdf).map(flat);
    expect(pages).toHaveLength(2);
    for (const part of [
      "PALLKORT",
      "INLEVERANS",
      "ARTIKELNUMMER",
      "LIM-10",
      "BENÄMNING",
      "Lim",
      "12 st",
      "Kolli 1 av 2",
      "LEVERANTÖR",
      "Stålbolaget AB",
      "INKÖPSORDER",
      f.order.orderNumber,
      "LAGERPLATS",
      "A1-03",
      "MOTTAGEN",
      stockholmDateOf(new Date()),
      "MOTTAGEN AV",
      "Mottagaren",
      "BATCH",
      "L-778 utg. 2027-03-01",
    ]) {
      expect(pages[0], part).toContain(part);
    }
    expect(pages[1]).toContain("8 st");
    expect(pages[1]).toContain("Kolli 2 av 2");
    // Internal and Swedish; no REFERENS cell (the order number is in the grid).
    expect(pages[0]).not.toContain("REFERENS");
    expect(pages[0]).not.toContain("TILL KUND");
    // Kod på pallkort = Streckkod: the article and order numbers as Code 128.
    expect(pdfRectCount(pdf)).toBeGreaterThan(40);
    for (const frame of pdfRects(pdf).filter((r) => r.width > 400 && r.height > 100)) {
      expect(frame.y + frame.height).toBeLessThanOrEqual(841.89 / 2);
    }
  });

  it("puts a serial receive call on one card — the numbers in the SERIENUMMER cell — and refuses receipts of different rows", async () => {
    const f = await makeFixture();
    const serials = await f.receive(f.serialRow.id, 3, { serialNumbers: ["SN-001001", "SN-001002", "SN-001003"] });
    const plain = await f.receive(f.plainRow.id, 10);

    const { pdf } = await purchaseService.receiptPalletCardPdf(
      f.order.id,
      parsed(receiptPalletCardSchema, { cards: [{ receiptIds: serials.receiptIds!, quantities: [3] }] })
    );
    dump("pallkort-serienummer.pdf", pdf);
    const text = flat(pdfText(pdf));
    expect(text).toContain("SERIENUMMER");
    expect(text).toContain("SN-001001–SN-001003");
    expect(text).toContain("3 st");
    expect(text).toContain("Kolli 1 av 1");

    await expect(
      purchaseService.receiptPalletCardPdf(
        f.order.id,
        parsed(receiptPalletCardSchema, { cards: [{ receiptIds: [serials.receiptIds![0]!, plain.receiptId], quantities: [1] }] })
      )
    ).rejects.toThrow(PurchaseReceiptRowsDifferError);
  });

  it("shows only the day for a backdated receipt and a dash for a receipt without a place", async () => {
    const f = await makeFixture();
    const yesterday = stockholmDateOf(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const receipt = await f.receive(f.plainRow.id, 5, { receivedOn: yesterday });
    const { pdf } = await purchaseService.receiptPalletCardPdf(
      f.order.id,
      parsed(receiptPalletCardSchema, { cards: [{ receiptIds: [receipt.receiptId], quantities: [5] }] })
    );
    const text = flat(pdfText(pdf));
    expect(text).toContain(yesterday);
    expect(text).not.toMatch(new RegExp(`${yesterday} \\d\\d:\\d\\d`));
    expect(text).toContain("A1-03");

    const service = await f.receive(f.serviceRow.id, 1);
    const serviceCard = flat(
      pdfText(
        (
          await purchaseService.receiptPalletCardPdf(
            f.order.id,
            parsed(receiptPalletCardSchema, { cards: [{ receiptIds: [service.receiptId], quantities: [1] }] })
          )
        ).pdf
      )
    );
    expect(serviceCard).toContain("MONT-1");
    expect(serviceCard).toContain("LAGERPLATS—");
  });
});

describe("the routes (buildApp)", () => {
  const authService = createAuthService(authRepo, "unused", auditRepository);
  const PASSWORD = "correcthorsebattery";
  const groupIds: string[] = [];
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await db.execute(sql`TRUNCATE users CASCADE`);
    if (groupIds.length > 0) await db.delete(permissionGroups).where(inArray(permissionGroups.id, groupIds));
  });

  async function userCookie(permissions: string[], readOnly = false) {
    const [group] = await db
      .insert(permissionGroups)
      .values({ code: `RCP${crypto.randomUUID().slice(0, 6)}`, name: "Inleverans", permissions })
      .returning();
    groupIds.push(group!.id);
    const email = `receipt-route-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(200);
    return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
  }
  const post = (cookie: string, url: string, payload: unknown) =>
    app.inject({ method: "POST", url, headers: { cookie, origin: "http://localhost" }, payload: payload as object });

  it("office prints labels and pallet cards (an Endast läsning account too), the terminal alone is refused; 404, 409 and 400 as the service says", async () => {
    const f = await makeFixture();
    const receipt = await f.receive(f.plainRow.id, 400);
    const serials = await f.receive(f.serialRow.id, 2, { serialNumbers: ["SN-1", "SN-2"] });
    const labels = `/api/v1/purchase-orders/${f.order.id}/receipts/labels`;
    const card = `/api/v1/purchase-orders/${f.order.id}/receipts/pallet-card`;

    const stock = await userCookie(["lager"]);
    const printed = await post(stock, labels, { receiptIds: [receipt.receiptId], format: "single", copies: 2 });
    expect(printed.statusCode).toBe(200);
    expect(printed.headers["content-type"]).toBe("application/pdf");
    expect(printed.headers["content-disposition"]).toContain("inleveransetiketter-");
    expect(pdfPagesText(printed.rawPayload)).toHaveLength(2);

    const cardPrinted = await post(stock, card, { cards: [{ receiptIds: [receipt.receiptId], quantities: [300, 100] }] });
    expect(cardPrinted.statusCode).toBe(200);
    expect(cardPrinted.headers["content-type"]).toBe("application/pdf");
    expect(pdfPagesText(cardPrinted.rawPayload)).toHaveLength(2);

    const readOnly = await userCookie(["inkop"], true);
    expect((await post(readOnly, labels, { receiptIds: [receipt.receiptId], format: "a4" })).statusCode).toBe(200);
    expect((await post(readOnly, card, { cards: [{ receiptIds: [receipt.receiptId], quantities: [1] }] })).statusCode).toBe(200);
    const terminal = await userCookie(["terminal"]);
    expect((await post(terminal, labels, { receiptIds: [receipt.receiptId], format: "a4" })).statusCode).toBe(403);
    expect((await post(terminal, card, { cards: [{ receiptIds: [receipt.receiptId], quantities: [1] }] })).statusCode).toBe(403);

    const missing = await post(stock, labels, { receiptIds: [crypto.randomUUID()], format: "a4" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe("purchase-receipt-not-found");
    const mixed = await post(stock, card, { cards: [{ receiptIds: [receipt.receiptId, serials.receiptIds![0]], quantities: [1] }] });
    expect(mixed.statusCode).toBe(400);
    expect(mixed.json().code).toBe("purchase-receipt-rows-differ");
    expect((await post(stock, labels, { receiptIds: [], format: "a4" })).statusCode).toBe(400);
    expect((await post(stock, card, { cards: [{ receiptIds: [receipt.receiptId], quantities: [] }] })).statusCode).toBe(400);
    expect((await post(stock, card, { cards: [{ receiptIds: [receipt.receiptId], quantities: [0] }] })).statusCode).toBe(400);

    await purchaseService.undoReceipt(f.order.id, receipt.receiptId, f.user.id);
    const undone = await post(stock, labels, { receiptIds: [receipt.receiptId], format: "a4" });
    expect(undone.statusCode).toBe(409);
    expect(undone.json().code).toBe("purchase-receipt-already-undone");
  });
});
