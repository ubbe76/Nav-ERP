import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, moReports, systemSettings } from "@navet/db";
import {
  createRoutingOperationSchema,
  createWorkCenterSchema,
  deliveryPalletCardQuerySchema,
  palletCardQuerySchema,
  type PalletCardCode,
} from "@navet/shared";
import { pdfPageCount, pdfRectCount, pdfText } from "./helpers/pdf.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import {
  createManufacturingService,
  InvalidStatusTransitionError,
  MoReportNoPalletCardError,
  MoReportNotFoundError,
  MOOperationNotFoundError,
} from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService, DeliveryRowNotInDeliveryError } from "../src/modules/sales/service/sales.service.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService, formatStockholmDateTime } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createTimeReportRepository } from "../src/modules/timereport/repository/timereport.repository.js";
import { createTimeReportService } from "../src/modules/timereport/service/timereport.service.js";
import { testArticleService } from "./helpers/services.js";
import { insertPlannedManufacturingOrder } from "./helpers/planned-manufacturing-order.js";

// Pallkort (Etapp F + ny design/omutskrift): the card placed on the pallet
// when an operation is reported (manufacturing) or a delivery leaves
// (sales). Same service construction as manufacturing-sales-link.test.ts,
// plus the system service as the manufacturing service's settings reader
// (Kod på pallkort) and the time report service for the terminal's reportId.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const stockService = createStockService(createStockRepository(db));
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const fakeTransportFactory: MailTransportFactory = () => ({ async sendMail() {} });
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const salesRepository = createSalesRepository(db);
const salesService = createSalesService(
  salesRepository,
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query)
);

const mfgService = createManufacturingService(
  createManufacturingRepository(db),
  documentPdfService,
  testArticleService,
  {
    findRowForManufacturing: salesRepository.findRowForManufacturing,
    lockRowForManufacturing: salesRepository.lockRowForManufacturing,
    markInProduction: markSalesOrderInProduction,
  },
  undefined,
  undefined,
  undefined,
  systemService
);
const timeReportService = createTimeReportService(
  createTimeReportRepository(db),
  mfgService,
  { isDateLocked: async () => false },
  { log: async () => {} }
);

const TRUNCATE = sql`TRUNCATE email_log, stamp_sessions, time_reports, employees, mo_reports, delivery_rows, deliveries, mo_operation_scrap, mo_material_consumptions, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, sales_order_rows, sales_orders, customer_delivery_addresses, customers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

// system_settings survives the TRUNCATE and is shared with every other test
// file — the code type is reset after each test so nothing leaks.
async function setSystemCode(code: PalletCardCode) {
  await systemService.updateSettings({ palletCardCode: code });
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterEach(async () => {
  await db.delete(systemSettings).where(eq(systemSettings.key, "pallet_card_code"));
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser(name = "Operator") {
  return authRepo.create({
    email: `pallkort-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name,
    role: "admin",
  });
}

// Short article numbers on purpose — the card prints them in 34 pt with
// ellipsis, so a UUID-length number would be truncated in the assertions.
// Work center codes are unique — a test that builds two orders needs two.
let workCenterSeq = 100;
async function makeRoutedArticle(articleNumber: string) {
  const workCenter = await mfgService.createWorkCenter(createWorkCenterSchema.parse({ code: String(workCenterSeq++), name: "Svets" }));
  const article = await articleService.createArticle({
    articleNumber,
    name: "Diskbänk 1200",
    type: "manufactured",
    unit: "st",
    active: true,
  });
  await mfgService.createRoutingOperation(
    article.id,
    createRoutingOperationSchema.parse({
      sequenceNo: 10,
      description: "Kapning",
      workCenterId: workCenter.id,
      setupTime: 10,
      runTimePerUnit: 2,
    })
  );
  await mfgService.createRoutingOperation(
    article.id,
    createRoutingOperationSchema.parse({
      sequenceNo: 20,
      description: "Montering",
      workCenterId: workCenter.id,
      setupTime: 5,
      runTimePerUnit: 1,
    })
  );
  return article;
}

// A released KO-linked TO on a two-operation routing — the "final card on
// the last operation" case this feature exists for.
async function makeLinkedReleasedMo(opts: { customerOrderNumber?: string; customerCode?: PalletCardCode | null; withAddress?: boolean } = {}) {
  const user = await makeUser();
  const customer = await salesService.createCustomer({ name: "Kund AB", active: true, palletCardCode: opts.customerCode ?? null });
  const address = opts.withAddress
    ? await salesService.createDeliveryAddress(customer.id, {
        label: "Lagret",
        address: "Lagervägen 7\nPort 3",
        postalCode: "987 65",
        city: "Småstad",
        country: "NO",
        isDefault: false,
      })
    : null;
  const article = await makeRoutedArticle("PALL-FIN");
  const { order, rows } = await salesService.createQuote(
    {
      customerId: customer.id,
      confirm: true,
      customerOrderNumber: opts.customerOrderNumber,
      deliveryAddressId: address?.id ?? undefined,
      rows: [{ articleId: article.id, quantity: 10, unitPrice: 100 }],
    },
    user.id
  );
  const mo = await mfgService.createManufacturingOrder({ quantity: 10, salesOrderRowId: rows[0]!.id }, null);
  const operations = (await mfgService.listOperations(mo.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  return { user, customer, article, order, mo, op10: operations[0]!, op20: operations[1]! };
}

async function makeUnlinkedReleasedMo() {
  const article = await makeRoutedArticle("PALL-INT");
  const mo = await mfgService.createManufacturingOrder({ articleId: article.id, quantity: 5 }, null);
  const operations = (await mfgService.listOperations(mo.id)).sort((a, b) => a.sequenceNo - b.sequenceNo);
  return { article, mo, op10: operations[0]!, op20: operations[1]! };
}

describe("pallkort — TO operation (GET .../operations/:opId/pallet-card)", () => {
  it("prints the final card on the last operation of a KO-linked TO: customer, both order numbers, explicit quantity", async () => {
    const { order, mo, op20 } = await makeLinkedReleasedMo({ customerOrderNumber: "KUND-PO-77" });

    const { filename, content } = await mfgService.getOperationPalletCardPdf(mo.id, op20.id, [7]);
    const text = pdfText(content);

    expect(filename).toBe(`pallkort-${mo.orderNumber}-op20.pdf`);
    expect(text).toContain("PALLKORT");
    expect(text).toContain("TILL KUND");
    expect(text).toContain("PALL-FIN");
    expect(text).toContain("BENÄMNING");
    expect(text).toContain("Diskbänk 1200");
    expect(text).toContain("Kund AB");
    expect(text).toContain("KUND-PO-77");
    expect(text).toContain(order.orderNumber);
    expect(text).toContain("7 st");
    // A single card is always Kolli 1 av 1.
    expect(text).toContain("Kolli 1 av 1");
    // The final card names no next operation and no delivery address (the
    // order has none chosen).
    expect(text).not.toContain("NÄSTA OPERATION");
    expect(text).not.toContain("LEVERANSADRESS");
    // Bottom row: print time, no reporter, the operation reference.
    expect(text).toContain("DATUM");
    expect(text).not.toContain("RAPPORTERAD AV");
    expect(text).toContain(`${mo.orderNumber} · op 20`);
    expect(pdfPageCount(content)).toBe(1);
  });

  it("prints '—' when the linked order has no customer order number", async () => {
    const { mo, op20 } = await makeLinkedReleasedMo();

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op20.id)).content);

    expect(text).toContain("KUNDENS ORDERNUMMER");
    expect(text).toContain("—");
  });

  it("prints the order's delivery address on the final card", async () => {
    const { mo, op20 } = await makeLinkedReleasedMo({ withAddress: true });

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op20.id)).content);

    expect(text).toContain("LEVERANSADRESS");
    expect(text).toContain("Lagervägen 7, Port 3");
    expect(text).toContain("987 65 Småstad");
    expect(text).toContain("Norge");
  });

  it("prints the internal card on a non-last operation: TO number and next operation, no customer", async () => {
    const { mo, op10 } = await makeLinkedReleasedMo({ customerOrderNumber: "KUND-PO-77" });

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op10.id, [3])).content);

    expect(text).toContain("INTERNT");
    expect(text).toContain("BENÄMNING");
    expect(text).toContain("Diskbänk 1200");
    expect(text).toContain("TILLVERKNINGSORDER");
    expect(text).toContain(mo.orderNumber);
    // Next operation = lowest sequence number after this one, description first,
    // rendered side by side with TILLVERKNINGSORDER under its own label.
    expect(text).toContain("NÄSTA OPERATION");
    expect(text).toContain("20 · Montering");
    expect(text).toContain("3 st");
    expect(text).toContain(`${mo.orderNumber} · op 10`);
    // A pallet moving to the next operation names no customer.
    expect(text).not.toContain("Kund AB");
    expect(text).not.toContain("KUND-PO-77");
    expect(text).not.toContain("TILL KUND");
  });

  it("prints the internal card with '—' as next operation on the last op of an UNLINKED TO", async () => {
    const { mo, op20 } = await makeUnlinkedReleasedMo();

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op20.id)).content);

    expect(text).toContain("TILLVERKNINGSORDER");
    expect(text).toContain(mo.orderNumber);
    // The cell stays so the grid keeps its shape.
    expect(text).toContain("NÄSTA OPERATION");
    expect(text).toContain("—");
    // No ?quantity and nothing reported — falls back to the order quantity.
    expect(text).toContain("5 st");
  });

  it("defaults the quantity to the operation's accumulated OK quantity when reported", async () => {
    const { mo, op10 } = await makeUnlinkedReleasedMo();
    await mfgService.reportOperationQuantities(op10.id, {
      quantityOk: 4,
      quantityScrapped: 0,
      markDone: false,
      createdBy: null,
    });

    const text = pdfText((await mfgService.getOperationPalletCardPdf(mo.id, op10.id)).content);

    expect(text).toContain("4 st");
  });

  it("prints one card per kolli with its own quantity, numbered Kolli n av m, without checking the sum", async () => {
    const { mo, op10 } = await makeUnlinkedReleasedMo();

    const { content } = await mfgService.getOperationPalletCardPdf(mo.id, op10.id, [2, 2, 0.5]);
    const text = pdfText(content);

    expect(pdfPageCount(content)).toBe(3);
    expect(text.match(/2 st/g)).toHaveLength(2);
    expect(text).toContain("0,50 st");
    expect(text).toContain("Kolli 1 av 3");
    expect(text).toContain("Kolli 2 av 3");
    expect(text).toContain("Kolli 3 av 3");
  });

  it("rejects a planned order (no operations snapshotted yet) with InvalidStatusTransitionError", async () => {
    const article = await makeRoutedArticle("PALL-PLAN");
    const mo = await insertPlannedManufacturingOrder({ articleId: article.id, quantity: 5 });

    await expect(
      mfgService.getOperationPalletCardPdf(mo.id, "00000000-0000-0000-0000-000000000000")
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("404s an operation id that does not belong to the order", async () => {
    const { mo } = await makeUnlinkedReleasedMo();

    await expect(
      mfgService.getOperationPalletCardPdf(mo.id, "00000000-0000-0000-0000-000000000000")
    ).rejects.toBeInstanceOf(MOOperationNotFoundError);
  });
});

describe("pallkort — per rapport (GET .../reports/:reportId/pallet-card)", () => {
  it("prints the report's quantity, its time and the employee's name", async () => {
    const { user, mo, op10 } = await makeLinkedReleasedMo();
    const employee = await timeReportService.createEmployee({ employeeNumber: "E-1", name: "Anna Andersson", active: true });
    const { reportId } = await mfgService.reportOperationQuantities(op10.id, {
      quantityOk: 4,
      quantityScrapped: 0,
      markDone: false,
      employeeId: employee.id,
      createdBy: user.id,
    });
    // A later report on the same operation does not change the card.
    await mfgService.reportOperationQuantities(op10.id, { quantityOk: 3, quantityScrapped: 0, markDone: false, createdBy: user.id });
    const [report] = await db.select().from(moReports).where(eq(moReports.id, reportId));

    const { filename, content } = await mfgService.getReportPalletCardPdf(mo.id, reportId);
    const text = pdfText(content);

    expect(filename).toBe(`pallkort-${mo.orderNumber}-op10.pdf`);
    expect(text).toContain("INTERNT");
    expect(text).toContain("4 st");
    expect(text).not.toContain("7 st");
    expect(text).toContain("RAPPORTERAD AV");
    expect(text).toContain("Anna Andersson");
    expect(text).toContain(formatStockholmDateTime(report!.createdAt));
    expect(text).toContain(`${mo.orderNumber} · op 10`);
  });

  it("falls back to the user's name without an employee, takes repeated ?quantity, and is final on the last operation", async () => {
    const { order, user, mo, op20 } = await makeLinkedReleasedMo({ customerOrderNumber: "KUND-PO-78" });
    const { reportId } = await mfgService.reportOperationQuantities(op20.id, {
      quantityOk: 6,
      quantityScrapped: 0,
      markDone: false,
      createdBy: user.id,
    });

    const { content } = await mfgService.getReportPalletCardPdf(mo.id, reportId, [2, 4]);
    const text = pdfText(content);

    expect(pdfPageCount(content)).toBe(2);
    expect(text).toContain("Kolli 1 av 2");
    expect(text).toContain("Kolli 2 av 2");
    expect(text).toContain("TILL KUND");
    expect(text).toContain("Kund AB");
    expect(text).toContain("KUND-PO-78");
    expect(text).toContain(order.orderNumber);
    expect(text).toContain("2 st");
    expect(text).toContain("4 st");
    expect(text).not.toContain("6 st");
    expect(text).toContain("RAPPORTERAD AV");
    expect(text).toContain("Operator");
  });

  it("404s a report on another order, 409s an undone report and a non-operation report", async () => {
    const { user, mo, op10 } = await makeLinkedReleasedMo();
    const other = await makeUnlinkedReleasedMo();
    const { reportId } = await mfgService.reportOperationQuantities(op10.id, {
      quantityOk: 1,
      quantityScrapped: 0,
      markDone: false,
      createdBy: user.id,
    });

    await expect(mfgService.getReportPalletCardPdf(other.mo.id, reportId)).rejects.toBeInstanceOf(MoReportNotFoundError);
    await expect(mfgService.getReportPalletCardPdf(mo.id, crypto.randomUUID())).rejects.toBeInstanceOf(MoReportNotFoundError);

    // A Slutför order report (kind completion) has no card.
    await mfgService.complete(mo.id, {}, user.id);
    const [completion] = await db.select().from(moReports).where(eq(moReports.kind, "completion"));
    const refusal = await mfgService.getReportPalletCardPdf(mo.id, completion!.id).catch((e) => e);
    expect(refusal).toBeInstanceOf(MoReportNoPalletCardError);
    expect(refusal.message).toBe("Rapporten har inget pallkort — bara en operationsrapport som inte är ångrad kan skrivas ut");

    // Undone — the quantities are gone, so is the card.
    await mfgService.undoReport(mo.id, completion!.id, user.id);
    await mfgService.undoReport(mo.id, reportId, user.id);
    await expect(mfgService.getReportPalletCardPdf(mo.id, reportId)).rejects.toBeInstanceOf(MoReportNoPalletCardError);
  });

  it("Slutför operation and the terminal's stamp-out both answer with the report's id", async () => {
    const { user, mo, op10 } = await makeLinkedReleasedMo();
    const completed = await mfgService.completeOperation(op10.id, { quantityCompleted: 2 }, user.id);
    expect(completed.reportId).toEqual(expect.any(String));
    expect((await mfgService.getReportPalletCardPdf(mo.id, completed.reportId)).filename).toBe(`pallkort-${mo.orderNumber}-op10.pdf`);

    const employee = await timeReportService.createEmployee({ employeeNumber: "E-2", name: "Bertil", active: true });
    const session = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: op10.id }, user.id);
    const stopped = await timeReportService.stampOut(session.id, { quantityOk: 3, quantityScrapped: 0 }, user.id);
    expect(stopped.reportId).toEqual(expect.any(String));
    const text = pdfText((await mfgService.getReportPalletCardPdf(mo.id, stopped.reportId!)).content);
    expect(text).toContain("3 st");
    expect(text).toContain("RAPPORTERAD AV");
    expect(text).toContain("Bertil");

    // A stamp-out with nothing to report still writes a (time-only) report row.
    const second = await timeReportService.stampIn({ employeeId: employee.id, moOperationId: op10.id }, user.id);
    const idle = await timeReportService.stampOut(second.id, {}, user.id);
    expect(idle.reportId).toEqual(expect.any(String));
  });
});

describe("pallkort — Kod på pallkort", () => {
  it("prints no codes by default, bars for barcode and modules for qr (system setting)", async () => {
    const { mo, op10 } = await makeUnlinkedReleasedMo();

    const none = pdfRectCount((await mfgService.getOperationPalletCardPdf(mo.id, op10.id)).content);
    await setSystemCode("barcode");
    const barcode = pdfRectCount((await mfgService.getOperationPalletCardPdf(mo.id, op10.id)).content);
    await setSystemCode("qr");
    const qr = pdfRectCount((await mfgService.getOperationPalletCardPdf(mo.id, op10.id)).content);

    // Band + frame only; two Code 128 symbols (article + TO number) add their
    // bars; two QR codes add a few hundred modules.
    expect(none).toBeLessThan(5);
    expect(barcode).toBeGreaterThan(40);
    expect(barcode).toBeLessThan(200);
    expect(qr).toBeGreaterThan(300);
  });

  it("the customer's choice wins on the final card but not on the internal card", async () => {
    await setSystemCode("barcode");
    const { mo, op10, op20 } = await makeLinkedReleasedMo({ customerCode: "qr" });

    const finalCard = pdfRectCount((await mfgService.getOperationPalletCardPdf(mo.id, op20.id)).content);
    const internalCard = pdfRectCount((await mfgService.getOperationPalletCardPdf(mo.id, op10.id)).content);

    expect(finalCard).toBeGreaterThan(300);
    expect(internalCard).toBeGreaterThan(40);
    expect(internalCard).toBeLessThan(200);
  });

  it("'none' on the customer switches the codes off on the final card even with a system default", async () => {
    await setSystemCode("barcode");
    const { mo, op20 } = await makeLinkedReleasedMo({ customerCode: "none" });

    expect(pdfRectCount((await mfgService.getOperationPalletCardPdf(mo.id, op20.id)).content)).toBeLessThan(5);
  });

  it("round-trips the customer's palletCardCode (null = follow the system)", async () => {
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true });
    expect((await salesService.getCustomer(customer.id))!.palletCardCode).toBeNull();
    await salesService.updateCustomer(customer.id, { palletCardCode: "qr" });
    expect((await salesService.getCustomer(customer.id))!.palletCardCode).toBe("qr");
    await salesService.updateCustomer(customer.id, { palletCardCode: null });
    expect((await salesService.getCustomer(customer.id))!.palletCardCode).toBeNull();
    const withCode = await salesService.createCustomer({ name: "Kund 2 AB", active: true, palletCardCode: "barcode" });
    expect(withCode.palletCardCode).toBe("barcode");
  });
});

describe("pallkort — delivery (GET /deliveries/:id/pallet-card)", () => {
  async function makeDelivery(opts: { customerCode?: PalletCardCode | null; withAddress?: boolean } = {}) {
    const user = await makeUser("Leif Leverans");
    const customer = await salesService.createCustomer({ name: "Kund AB", active: true, palletCardCode: opts.customerCode ?? null });
    const address = opts.withAddress
      ? await salesService.createDeliveryAddress(customer.id, {
          label: "Lagret",
          address: "Lagervägen 7",
          postalCode: "987 65",
          city: "Småstad",
          country: "SE",
          isDefault: false,
        })
      : null;
    const articleA = await articleService.createArticle({
      articleNumber: "PALL-A",
      name: "Modul A",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const articleB = await articleService.createArticle({
      articleNumber: "PALL-B",
      name: "Modul B",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
    const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
    for (const article of [articleA, articleB]) {
      await stockService.recordTransaction({
        articleId: article.id,
        locationId: location.id,
        quantityDelta: 10,
        transactionType: "inventory_adjustment",
      });
    }

    const { order, rows } = await salesService.createQuote(
      {
        customerId: customer.id,
        confirm: true,
        customerOrderNumber: "KUND-PO-88",
        deliveryAddressId: address?.id ?? undefined,
        rows: [
          { articleId: articleA.id, quantity: 10, unitPrice: 10 },
          { articleId: articleB.id, quantity: 5, unitPrice: 20 },
        ],
      },
      user.id
    );
    await salesService.startProduction(order.id);
    const rowA = rows.find((r) => r.articleId === articleA.id)!;
    const rowB = rows.find((r) => r.articleId === articleB.id)!;

    const result = await salesService.deliverBatch(
      order.id,
      {
        locationId: location.id,
        rows: [
          { rowId: rowA.id, quantity: 10 },
          { rowId: rowB.id, quantity: 5 },
        ],
      },
      user.id
    );
    return { user, customer, order, deliveryId: result.deliveryId, deliveryNumber: result.deliveryNumber };
  }

  it("renders one card page per delivered row, all in the final variant, dated on the delivery and without a reporter", async () => {
    const { order, deliveryId, deliveryNumber } = await makeDelivery();

    const { pdf, filename } = await salesService.deliveryPalletCardPdf(deliveryId);
    const text = pdfText(pdf);

    expect(filename).toBe(`pallkort-${deliveryNumber}.pdf`);
    expect(pdfPageCount(pdf)).toBe(2);
    expect(text).toContain("TILL KUND");
    expect(text).toContain("PALL-A");
    expect(text).toContain("PALL-B");
    expect(text).toContain("Kund AB");
    expect(text).toContain("KUND-PO-88");
    expect(text).toContain(order.orderNumber);
    expect(text).toContain("10 st");
    expect(text).toContain("5 st");
    expect(text).not.toContain("RAPPORTERAD AV");
    expect(text).not.toContain("Leif Leverans");
    expect(text).toContain(deliveryNumber);
    expect(text.match(/Kolli 1 av 1/g)).toHaveLength(2);
    expect(text).not.toContain("LEVERANSADRESS");
  });

  it("GET /deliveries/:id/rows lists the rows with id, article and quantity in the row's unit", async () => {
    const { deliveryId, deliveryNumber } = await makeDelivery();

    const rows = await salesService.deliveryRows(deliveryId);

    expect(rows.deliveryNumber).toBe(deliveryNumber);
    expect(rows.rows).toEqual([
      { id: expect.any(String), articleNumber: "PALL-A", articleName: "Modul A", quantity: 10, unit: "st", undoneAt: null, undoneByName: null, undoable: true },
      { id: expect.any(String), articleNumber: "PALL-B", articleName: "Modul B", quantity: 5, unit: "st", undoneAt: null, undoneByName: null, undoable: true },
    ]);
  });

  it("row= picks rows and gives each kolli its quantity; an empty list skips; an unknown row is refused", async () => {
    const { deliveryId } = await makeDelivery();
    const { rows } = await salesService.deliveryRows(deliveryId);
    const [a, b] = rows;

    const { pdf } = await salesService.deliveryPalletCardPdf(deliveryId, [
      { deliveryRowId: a!.id, quantities: [4, 6] },
      { deliveryRowId: b!.id, quantities: [] },
    ]);
    const text = pdfText(pdf);

    expect(pdfPageCount(pdf)).toBe(2);
    expect(text.match(/PALL-A/g)).toHaveLength(2);
    expect(text).not.toContain("PALL-B");
    expect(text).toContain("4 st");
    expect(text).toContain("6 st");
    expect(text).not.toContain("10 st");
    expect(text).toContain("Kolli 1 av 2");
    expect(text).toContain("Kolli 2 av 2");

    await expect(
      salesService.deliveryPalletCardPdf(deliveryId, [{ deliveryRowId: crypto.randomUUID(), quantities: [1] }])
    ).rejects.toBeInstanceOf(DeliveryRowNotInDeliveryError);
  });

  it("prints the order's delivery address and the customer's code type", async () => {
    await setSystemCode("none");
    const { deliveryId } = await makeDelivery({ withAddress: true, customerCode: "barcode" });

    const { pdf } = await salesService.deliveryPalletCardPdf(deliveryId);
    const text = pdfText(pdf);

    expect(text).toContain("LEVERANSADRESS");
    expect(text).toContain("Lagervägen 7");
    expect(text).toContain("987 65 Småstad");
    // Two cards × two barcodes: well above the band+frame baseline, below QR.
    expect(pdfRectCount(pdf)).toBeGreaterThan(80);
    expect(pdfRectCount(pdf)).toBeLessThan(400);
  });
});

describe("pallkort — query schemas", () => {
  it("palletCardQuerySchema: quantity is one positive number or a list of 1–50", () => {
    expect(palletCardQuerySchema.parse({ quantity: "3" })).toEqual({ quantity: [3] });
    expect(palletCardQuerySchema.parse({ quantity: ["10", "10", "4.5"] })).toEqual({ quantity: [10, 10, 4.5] });
    expect(palletCardQuerySchema.parse({})).toEqual({});
    expect(palletCardQuerySchema.safeParse({ quantity: "0" }).success).toBe(false);
    expect(palletCardQuerySchema.safeParse({ quantity: ["1", "x"] }).success).toBe(false);
    expect(palletCardQuerySchema.safeParse({ quantity: Array(51).fill("1") }).success).toBe(false);
  });

  it("deliveryPalletCardQuerySchema: a string or an array of row=<id>:<antal>,<antal>,…", () => {
    const id = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    expect(deliveryPalletCardQuerySchema.parse({ row: `${id}:2.5,3` })).toEqual({ row: [{ deliveryRowId: id, quantities: [2.5, 3] }] });
    expect(deliveryPalletCardQuerySchema.parse({ row: [`${id}:`, `${id2}:1`] })).toEqual({
      row: [
        { deliveryRowId: id, quantities: [] },
        { deliveryRowId: id2, quantities: [1] },
      ],
    });
    expect(deliveryPalletCardQuerySchema.parse({})).toEqual({});
    // Zero cards, a non-uuid, a zero quantity, too many kolli, a bad shape.
    expect(deliveryPalletCardQuerySchema.safeParse({ row: [`${id}:`] }).success).toBe(false);
    expect(deliveryPalletCardQuerySchema.safeParse({ row: "abc:1" }).success).toBe(false);
    expect(deliveryPalletCardQuerySchema.safeParse({ row: `${id}:0` }).success).toBe(false);
    expect(deliveryPalletCardQuerySchema.safeParse({ row: `${id}:${Array(51).fill("1").join(",")}` }).success).toBe(false);
    expect(deliveryPalletCardQuerySchema.safeParse({ row: id }).success).toBe(false);
  });
});
