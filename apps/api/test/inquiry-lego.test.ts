import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db } from "@navet/db";
import { pdfText } from "./helpers/pdf.js";
import { testArticleService, testDocumentPdfService, testSystemService } from "./helpers/services.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createManufacturingRepository } from "../src/modules/manufacturing/repository/manufacturing.repository.js";
import { createManufacturingService } from "../src/modules/manufacturing/service/manufacturing.service.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import {
  createPurchaseService,
  DuplicateInquiryRowError,
  InquiryRowPriceNotApplicableError,
  LegoOperationArticleMismatchError,
  LegoOperationClosedError,
  LegoOperationNotFoundError,
  NotLegoOperationError,
} from "../src/modules/purchase/service/purchase.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { markSalesOrderInProduction } from "../src/modules/sales/service/production-transition.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

// Legoförfrågan: RFQ rows linked to a lego operation (TO operation from the
// behovsberäkning, or the article's routing operation for a TO-less price
// inquiry), the convert to IO, the RFQ PDF/email, and the prisåterföring
// back to the routing operation.

const articleService = createArticleService(createArticleRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const salesRepository = createSalesRepository(db);
const purchaseRepository = createPurchaseRepository(db);
const auditRepository = createAuditRepository(db);
const mfgService = createManufacturingService(createManufacturingRepository(db), testDocumentPdfService, testArticleService, {
  findRowForManufacturing: salesRepository.findRowForManufacturing,
  lockRowForManufacturing: salesRepository.lockRowForManufacturing,
  markInProduction: markSalesOrderInProduction,
});

// Fake SMTP transport — records outgoing mails.
const sentMails: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    sentMails.push(opts);
  },
});

// The REAL cross-module wiring under test: the manufacturing service both
// reports the operation at goods receipt and takes the price write-back.
const purchaseService = createPurchaseService(
  purchaseRepository,
  registerService,
  createMailService(createMailRepository(db), testSystemService, fakeTransportFactory),
  testDocumentPdfService,
  testArticleService,
  testSystemService,
  mfgService,
  auditRepository
);

const TABLES = sql`TRUNCATE email_log, audit_log, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, routing_operation_files, article_files, mo_material_consumptions, mo_operation_scrap, mo_operations, manufacturing_orders, routing_operations, work_centers, production_groups, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, users CASCADE`;

beforeEach(async () => {
  await db.execute(TABLES);
  sentMails.length = 0;
  await testSystemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
});

afterAll(async () => {
  await db.execute(TABLES);
});

async function makeUser() {
  return authRepo.create({
    email: `rfq-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Inköpare",
    role: "admin",
  });
}

async function makeSupplier(name = "Lego AB") {
  return purchaseService.createSupplier({ name, active: true });
}

// Manufactured article with weight, one machine operation (10) and one lego
// operation (20, ställpris 500 / styckpris 100, net weight on).
async function makeLegoRouting(opts?: { setupPrice?: number | null }) {
  const user = await makeUser();
  const supplier = await makeSupplier();
  const machine = await mfgService.createWorkCenter({ code: "100", name: "Svets", type: "machine", active: true });
  const lego = await mfgService.createWorkCenter({
    code: "900",
    name: "Ytbehandling AB",
    type: "subcontract",
    supplierId: supplier.id,
    active: true,
  });

  const parent = await articleService.createArticle({
    articleNumber: `LEGO-${crypto.randomUUID()}`,
    name: "Legodetalj",
    type: "manufactured",
    unit: "st",
    weight: 2.5,
    active: true,
  });

  const machineOp = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 10,
    workCenterId: machine.id,
    setupTime: 10,
    runTimePerUnit: 2,
  });
  const routingLegoOp = await mfgService.createRoutingOperation(parent.id, {
    sequenceNo: 20,
    description: "Ytbehandling",
    workCenterId: lego.id,
    setupTime: 0,
    runTimePerUnit: 0,
    setupPrice: opts?.setupPrice === undefined ? 500 : opts.setupPrice,
    unitPrice: 100,
    showNetWeight: true,
  });

  return { user, supplier, machine, lego, parent, machineOp, routingLegoOp };
}

// The fixture plus a released TO of 4 — `moLegoOp` is the operation
// snapshot the behovsberäkning raises an RFQ for.
async function releasedMo(quantity = 4) {
  const fixture = await makeLegoRouting();
  const order = await mfgService.createManufacturingOrder(
    { articleId: fixture.parent.id, quantity },
    fixture.user.id
  );
  const operations = await mfgService.listOperations(order.id);
  const moLegoOp = operations.find((op) => op.sequenceNo === 20)!;
  return { ...fixture, order, moLegoOp };
}

async function moOperation(orderId: string, sequenceNo: number) {
  return (await mfgService.listOperations(orderId)).find((op) => op.sequenceNo === sequenceNo)!;
}

async function auditRows(action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "inquiry"), eq(auditLog.action, action)));
}

describe("lego inquiry rows — creation", () => {
  it("links a TO operation: stores the MO operation AND its routing operation, defaults the ställpris", async () => {
    const f = await releasedMo();
    const { rows } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 4, moOperationId: f.moLegoOp.id }] },
      f.user.id
    );
    expect(rows[0]!.moOperationId).toBe(f.moLegoOp.id);
    expect(rows[0]!.routingOperationId).toBe(f.routingLegoOp.id);
    expect(rows[0]!.setupPrice).toBe("500.00");
    // An RFQ asks for the price — never defaulted from the operation.
    expect(rows[0]!.unitPrice).toBeNull();
  });

  it("an explicit ställpris wins over the operation's, 0 included", async () => {
    const f = await releasedMo();
    const { rows } = await purchaseService.createInquiry(
      {
        supplierId: f.supplier.id,
        rows: [{ articleId: f.parent.id, quantity: 4, moOperationId: f.moLegoOp.id, setupPrice: 0 }],
      },
      f.user.id
    );
    expect(rows[0]!.setupPrice).toBe("0.00");
  });

  it("links a routing operation for a TO-less price inquiry", async () => {
    const f = await makeLegoRouting();
    const { inquiry, rows } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 10, routingOperationId: f.routingLegoOp.id }] },
      f.user.id
    );
    expect(rows[0]!.moOperationId).toBeNull();
    expect(rows[0]!.routingOperationId).toBe(f.routingLegoOp.id);
    expect(rows[0]!.setupPrice).toBe("500.00");

    const listed = await purchaseService.listInquiryRows(inquiry.id);
    expect(listed[0]!.moOrderNumber).toBeNull();
    expect(listed[0]!.legoSequenceNo).toBe(20);
    expect(listed[0]!.legoDescription).toBe("Ytbehandling");
    expect(listed[0]!.legoShowNetWeight).toBe(true);
  });

  it("refuses an unknown operation, another article's operation and a non-lego operation", async () => {
    const f = await makeLegoRouting();
    const other = await articleService.createArticle({
      articleNumber: `OTHER-${crypto.randomUUID()}`,
      name: "Annan",
      type: "manufactured",
      unit: "st",
      active: true,
    });
    const rows = (row: object) => ({ supplierId: f.supplier.id, rows: [{ quantity: 1, ...row }] });

    await expect(
      purchaseService.createInquiry(rows({ articleId: f.parent.id, routingOperationId: crypto.randomUUID() }), f.user.id)
    ).rejects.toBeInstanceOf(LegoOperationNotFoundError);
    await expect(
      purchaseService.createInquiry(rows({ articleId: other.id, routingOperationId: f.routingLegoOp.id }), f.user.id)
    ).rejects.toBeInstanceOf(LegoOperationArticleMismatchError);
    await expect(
      purchaseService.createInquiry(rows({ articleId: f.parent.id, routingOperationId: f.machineOp.id }), f.user.id)
    ).rejects.toBeInstanceOf(NotLegoOperationError);
  });

  it("addInquiryRow takes the same lego link, and ställpris is only editable on lego rows", async () => {
    const f = await makeLegoRouting();
    const plain = await articleService.createArticle({
      articleNumber: `PLAIN-${crypto.randomUUID()}`,
      name: "Vanlig",
      type: "purchased",
      unit: "st",
      active: true,
    });
    const { inquiry, rows } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: plain.id, quantity: 1 }] },
      f.user.id
    );
    const legoRow = await purchaseService.addInquiryRow(inquiry.id, {
      articleId: f.parent.id,
      quantity: 2,
      routingOperationId: f.routingLegoOp.id,
    });
    expect(legoRow.routingOperationId).toBe(f.routingLegoOp.id);
    expect(legoRow.setupPrice).toBe("500.00");

    const updated = await purchaseService.updateInquiryRow(inquiry.id, legoRow.id, { setupPrice: 250 });
    expect(updated.setupPrice).toBe("250.00");
    const cleared = await purchaseService.updateInquiryRow(inquiry.id, legoRow.id, { setupPrice: null });
    expect(cleared.setupPrice).toBeNull();

    await expect(
      purchaseService.updateInquiryRow(inquiry.id, rows[0]!.id, { setupPrice: 100 })
    ).rejects.toBeInstanceOf(NotLegoOperationError);
  });

  it("addInquiryRow refuses an article already on the inquiry (409, not a 500)", async () => {
    const f = await makeLegoRouting();
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 1 }] },
      f.user.id
    );
    await expect(
      purchaseService.addInquiryRow(inquiry.id, { articleId: f.parent.id, quantity: 1 })
    ).rejects.toBeInstanceOf(DuplicateInquiryRowError);
  });

  it("createInquiry refuses the same article twice in its own rows", async () => {
    const f = await makeLegoRouting();
    await expect(
      purchaseService.createInquiry(
        {
          supplierId: f.supplier.id,
          rows: [
            { articleId: f.parent.id, quantity: 1 },
            { articleId: f.parent.id, quantity: 2 },
          ],
        },
        f.user.id
      )
    ).rejects.toBeInstanceOf(DuplicateInquiryRowError);
  });

  it("refuses linking a done MO operation", async () => {
    const f = await releasedMo(4);
    await mfgService.reportOperationQuantities(f.moLegoOp.id, {
      quantityOk: 4,
      quantityScrapped: 0,
      markDone: true,
      createdBy: f.user.id,
    });
    // A planned (unreleased) MO's operation can't be exercised here: mo_
    // operations rows are only snapshotted from the routing at release()
    // (manufacturing.repository.ts's release()), so there is no
    // moOperationId to link before release — only the "done" closed-state
    // is reachable from the outside.
    await expect(
      purchaseService.createInquiry(
        { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 4, moOperationId: f.moLegoOp.id }] },
        f.user.id
      )
    ).rejects.toBeInstanceOf(LegoOperationClosedError);
  });
});

describe("lego inquiry rows — convert to purchase order", () => {
  it("a TO row becomes a lego IO row: goods receipt reports the operation", async () => {
    const f = await releasedMo(4);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 4, moOperationId: f.moLegoOp.id }] },
      f.user.id
    );
    await purchaseService.sendInquiry(inquiry.id, f.user.id);
    const order = await purchaseService.convertInquiryToOrder(inquiry.id, f.user.id);

    const [row] = await purchaseRepository.listRowsByOrder(order.id);
    expect(row!.moOperationId).toBe(f.moLegoOp.id);
    expect(row!.setupPrice).toBe("500.00");
    // Unanswered price → 0, as for every converted inquiry.
    expect(row!.unitPrice).toBe("0.0000");

    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row!.id, { quantity: 4 }, f.user.id);
    const op = await moOperation(f.order.id, 20);
    expect(Number(op.quantityCompleted)).toBe(4);
    expect(op.status).toBe("done");
  });

  it("a TO-less row becomes a plain IO row with its ställpris — nothing is reported at receipt", async () => {
    const f = await releasedMo(4);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 4, routingOperationId: f.routingLegoOp.id }] },
      f.user.id
    );
    await purchaseService.sendInquiry(inquiry.id, f.user.id);
    const order = await purchaseService.convertInquiryToOrder(inquiry.id, f.user.id);

    const [row] = await purchaseRepository.listRowsByOrder(order.id);
    expect(row!.moOperationId).toBeNull();
    expect(row!.setupPrice).toBe("500.00");

    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, row!.id, { quantity: 4 }, f.user.id);
    const op = await moOperation(f.order.id, 20);
    expect(Number(op.quantityCompleted)).toBe(0);
    expect(op.status).toBe("pending");
  });
});

describe("lego inquiry rows — RFQ PDF", () => {
  it("prints the TO reference, the ställpris, the net weight and Ytbehandling/Färg on a TO row", async () => {
    const f = await releasedMo(4);
    await articleService.updateArticle(f.parent.id, { surfaceTreatment: "Pulverlack RAL 9010", colour: "Vit" });
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 4, moOperationId: f.moLegoOp.id }] },
      f.user.id
    );
    const text = pdfText((await purchaseService.getInquiryPdf(inquiry.id)).content);
    expect(text).toContain(`Lego för ${f.order.orderNumber} · Op 20 · Ytbehandling`);
    expect(text).toContain("Ställpris: 500,00 SEK");
    // 2.5 kg × 4 st.
    expect(text).toContain("Nettovikt: 10,0 kg");
    expect(text).toContain("Ytbehandling: Pulverlack RAL 9010 · Färg: Vit");
  });

  it("prints 'Lego · Op …' without a TO, and no net weight when the article has none", async () => {
    const f = await makeLegoRouting();
    await articleService.updateArticle(f.parent.id, { weight: null });
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 10, routingOperationId: f.routingLegoOp.id }] },
      f.user.id
    );
    const text = pdfText((await purchaseService.getInquiryPdf(inquiry.id)).content);
    expect(text).toContain("Lego · Op 20 · Ytbehandling");
    expect(text).toContain("Ställpris: 500,00 SEK");
    expect(text).not.toContain("Nettovikt");
    expect(text).not.toContain("Lego för");
  });

  it("an ordinary row on the same article prints no lego lines and no Ytbehandling/Färg", async () => {
    const f = await makeLegoRouting();
    await articleService.updateArticle(f.parent.id, { surfaceTreatment: "Pulverlack", colour: "Vit" });
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 10 }] },
      f.user.id
    );
    const text = pdfText((await purchaseService.getInquiryPdf(inquiry.id)).content);
    // ("Lego" alone also matches the article name "Legodetalj".)
    expect(text).not.toContain("Lego ·");
    expect(text).not.toContain("Lego för");
    expect(text).not.toContain("Ställpris");
    expect(text).not.toContain("Ytbehandling:");
  });

  it("a degraded TO-less row (routing operation removed) keeps its ställpris but drops the Lego · Op line", async () => {
    const f = await makeLegoRouting();
    const { inquiry, rows } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 10, routingOperationId: f.routingLegoOp.id }] },
      f.user.id
    );
    expect(rows[0]!.setupPrice).toBe("500.00");

    // ON DELETE SET NULL on inquiry_rows.routing_operation_id — the row
    // degrades to a plain row (isLego goes false) but the ställpris column
    // itself is untouched.
    await mfgService.removeRoutingOperation(f.parent.id, f.routingLegoOp.id);

    const text = pdfText((await purchaseService.getInquiryPdf(inquiry.id)).content);
    expect(text).toContain("Ställpris: 500,00 SEK");
    expect(text).not.toContain("Lego ·");
    expect(text).not.toContain("Lego för");
  });

  it("the lego IO row prints Ytbehandling/Färg too (purchase order PDF)", async () => {
    const f = await releasedMo(4);
    await articleService.updateArticle(f.parent.id, { surfaceTreatment: "Pulverlack", colour: null });
    const ioOrder = await purchaseService.createPurchaseOrder({ supplierId: f.supplier.id }, f.user.id);
    await purchaseService.addRow(ioOrder.id, {
      articleId: f.parent.id,
      quantity: 4,
      unitPrice: 100,
      setupPrice: 500,
      moOperationId: f.moLegoOp.id,
    });
    const text = pdfText((await purchaseService.getPurchaseOrderPdf(ioOrder.id)).content);
    expect(text).toContain(`Lego för ${f.order.orderNumber} · Op 20 · Ytbehandling`);
    expect(text).toContain("Ytbehandling: Pulverlack");
    expect(text).not.toContain("Färg:");
  });
});

describe("lego inquiry rows — RFQ email attachments", () => {
  const drawing = { filename: "ritning.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4 drawing") };

  it("always attaches the article's drawing for a lego row, even without the checkbox", async () => {
    const f = await makeLegoRouting();
    await articleService.addFile(f.parent.id, drawing);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 10, routingOperationId: f.routingLegoOp.id }] },
      f.user.id
    );
    await purchaseService.sendInquiryEmail(inquiry.id, {
      to: "lego@example.com",
      subject: "Förfrågan",
      message: "Hej",
      attachDrawings: false,
    });
    const filenames = sentMails[0]!.attachments!.map((a) => a.filename);
    expect(filenames).toEqual([`${inquiry.inquiryNumber}.pdf`, "ritning.pdf"]);
  });

  it("attaches the operation's own file instead when the operation says so, and dedupes a name clash", async () => {
    const f = await makeLegoRouting();
    await articleService.addFile(f.parent.id, drawing);
    await mfgService.updateRoutingOperation(f.parent.id, f.routingLegoOp.id, { useArticleDrawing: false });
    // Same filename as the article drawing — the second gets " (2)".
    await mfgService.putOperationFile(f.parent.id, f.routingLegoOp.id, {
      filename: "ritning.pdf",
      contentType: "application/pdf",
      data: Buffer.from("%PDF-1.4 operation drawing"),
    });
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 10, routingOperationId: f.routingLegoOp.id }] },
      f.user.id
    );

    await purchaseService.sendInquiryEmail(inquiry.id, {
      to: "lego@example.com",
      subject: "Förfrågan",
      message: "Hej",
      attachDrawings: false,
    });
    expect(sentMails[0]!.attachments!.map((a) => a.filename)).toEqual([`${inquiry.inquiryNumber}.pdf`, "ritning.pdf"]);
    expect(sentMails[0]!.attachments![1]!.content.toString()).toContain("operation drawing");

    // With the checkbox the article drawing comes along too — renamed.
    await purchaseService.sendInquiryEmail(inquiry.id, {
      to: "lego@example.com",
      subject: "Förfrågan",
      message: "Hej",
      attachDrawings: true,
    });
    expect(sentMails[1]!.attachments!.map((a) => a.filename)).toEqual([
      `${inquiry.inquiryNumber}.pdf`,
      "ritning.pdf",
      "ritning (2).pdf",
    ]);
  });

  it("an ordinary row still only gets drawings when the checkbox asks", async () => {
    const f = await makeLegoRouting();
    await articleService.addFile(f.parent.id, drawing);
    const { inquiry } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 10 }] },
      f.user.id
    );
    await purchaseService.sendInquiryEmail(inquiry.id, {
      to: "lego@example.com",
      subject: "Förfrågan",
      message: "Hej",
      attachDrawings: false,
    });
    expect(sentMails[0]!.attachments!.map((a) => a.filename)).toEqual([`${inquiry.inquiryNumber}.pdf`]);
  });
});

describe("lego inquiry rows — prisåterföring to the routing operation", () => {
  async function answeredLegoInquiry(opts?: { withPrice?: boolean; setupPrice?: number }) {
    const f = await makeLegoRouting();
    const otherSupplier = await makeSupplier("Annan Lego AB");
    const { inquiry, rows } = await purchaseService.createInquiry(
      {
        supplierId: otherSupplier.id,
        rows: [
          {
            articleId: f.parent.id,
            quantity: 10,
            routingOperationId: f.routingLegoOp.id,
            ...(opts?.setupPrice !== undefined ? { setupPrice: opts.setupPrice } : {}),
          },
        ],
      },
      f.user.id
    );
    await purchaseService.sendInquiry(inquiry.id, f.user.id);
    await purchaseService.markInquiryAnswered(inquiry.id, f.user.id);
    if (opts?.withPrice !== false) {
      await purchaseService.updateInquiryRow(inquiry.id, rows[0]!.id, { unitPrice: 87.5 });
    }
    return { ...f, otherSupplier, inquiry, row: rows[0]! };
  }

  async function routingOp(articleId: string, id: string) {
    return (await mfgService.listRoutingOperations(articleId)).find((op) => op.id === id)!;
  }

  it("writes styckpris, ställpris and the inquiry's supplier to the routing operation, with an audit row", async () => {
    const f = await answeredLegoInquiry({ setupPrice: 300 });
    await purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, f.row.id, f.user.id);

    const op = await routingOp(f.parent.id, f.routingLegoOp.id);
    expect(op.unitPrice).toBe("87.5000");
    expect(op.setupPrice).toBe("300.00");
    expect(op.subcontractSupplierId).toBe(f.otherSupplier.id);

    const rows = await auditRows("price_applied_to_routing");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(f.inquiry.inquiryNumber);
    expect(rows[0]!.userId).toBe(f.user.id);
  });

  it("is refused before the inquiry is answered (draft, sent) and after cancellation", async () => {
    const f = await makeLegoRouting();
    const { inquiry, rows } = await purchaseService.createInquiry(
      { supplierId: f.supplier.id, rows: [{ articleId: f.parent.id, quantity: 10, routingOperationId: f.routingLegoOp.id }] },
      f.user.id
    );
    await purchaseService.updateInquiryRow(inquiry.id, rows[0]!.id, { unitPrice: 87.5 });

    await expect(purchaseService.applyInquiryRowPriceToRouting(inquiry.id, rows[0]!.id)).rejects.toBeInstanceOf(
      InquiryRowPriceNotApplicableError
    );
    await purchaseService.sendInquiry(inquiry.id, f.user.id);
    await expect(purchaseService.applyInquiryRowPriceToRouting(inquiry.id, rows[0]!.id)).rejects.toBeInstanceOf(
      InquiryRowPriceNotApplicableError
    );
    await purchaseService.cancelInquiry(inquiry.id, f.user.id);
    await expect(purchaseService.applyInquiryRowPriceToRouting(inquiry.id, rows[0]!.id)).rejects.toBeInstanceOf(
      InquiryRowPriceNotApplicableError
    );
    // Nothing leaked through.
    const op = await routingOp(f.parent.id, f.routingLegoOp.id);
    expect(op.unitPrice).toBe("100.0000");
    expect(await auditRows("price_applied_to_routing")).toHaveLength(0);
  });

  it("is refused on an answered row without a price, and on an ordinary row", async () => {
    const f = await answeredLegoInquiry({ withPrice: false });
    await expect(purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, f.row.id)).rejects.toThrow(
      "Raden saknar pris"
    );

    const plain = await purchaseService.addInquiryRow(f.inquiry.id, { articleId: f.parent.id, quantity: 1 }).catch(
      () => null
    );
    // Same article twice is blocked by the unique index — use a fresh one.
    expect(plain).toBeNull();
    const other = await articleService.createArticle({
      articleNumber: `PLAIN-${crypto.randomUUID()}`,
      name: "Vanlig",
      type: "purchased",
      unit: "st",
      active: true,
    });
    const plainRow = await purchaseService.addInquiryRow(f.inquiry.id, { articleId: other.id, quantity: 1, unitPrice: 5 });
    await expect(purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, plainRow.id)).rejects.toThrow(
      "Raden är ingen legorad"
    );
  });

  it("still works after the inquiry was converted (ordered)", async () => {
    const f = await answeredLegoInquiry();
    await purchaseService.convertInquiryToOrder(f.inquiry.id, f.user.id);
    await purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, f.row.id, f.user.id);
    const op = await routingOp(f.parent.id, f.routingLegoOp.id);
    expect(op.unitPrice).toBe("87.5000");
  });

  it("is refused once the routing operation moved to a non-lego resource, or was deleted", async () => {
    const f = await answeredLegoInquiry();
    await mfgService.updateRoutingOperation(f.parent.id, f.routingLegoOp.id, { workCenterId: f.machine.id });
    await expect(purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, f.row.id)).rejects.toThrow(
      "inte längre på en legoresurs"
    );

    await mfgService.removeRoutingOperation(f.parent.id, f.routingLegoOp.id);
    // ON DELETE set null on inquiry_rows.routing_operation_id — a TO-less
    // lego row whose operation is gone degrades to a plain row, so the
    // refusal is "not a lego row" rather than "operation missing".
    await expect(purchaseService.applyInquiryRowPriceToRouting(f.inquiry.id, f.row.id)).rejects.toBeInstanceOf(
      InquiryRowPriceNotApplicableError
    );
    expect((await purchaseService.listInquiryRows(f.inquiry.id))[0]!.routingOperationId).toBeNull();
  });
});

describe("purchase order list — Legoinköp filter", () => {
  it("kind=lego keeps orders with at least one TO-linked row, kind=regular the rest", async () => {
    const f = await releasedMo(4);
    const plain = await articleService.createArticle({
      articleNumber: `SKRUV-${crypto.randomUUID()}`, name: "Skruv", type: "purchased", unit: "st", active: true,
    });
    // createPurchaseOrder takes the header only; rows go through addRow.
    const order = async (rows: { articleId: string; quantity: number; unitPrice: number; moOperationId?: string }[]) => {
      const o = await purchaseService.createPurchaseOrder({ supplierId: f.supplier.id }, f.user.id);
      for (const r of rows) await purchaseService.addRow(o.id, r, f.user.id);
      return o;
    };
    const legoRow = { articleId: f.parent.id, quantity: 4, unitPrice: 100, moOperationId: f.moLegoOp.id };
    const plainRow = { articleId: plain.id, quantity: 10, unitPrice: 2 };
    const lego = await order([legoRow]);
    const regular = await order([plainRow]);
    const mixed = await order([plainRow, legoRow]);
    const numbers = async (kind?: "lego" | "regular") =>
      (await purchaseService.listPurchaseOrders({ kind, limit: 50, offset: 0 })).rows.map((o) => o.orderNumber).sort();

    expect(await numbers("lego")).toEqual([lego.orderNumber, mixed.orderNumber].sort());
    expect(await numbers("regular")).toEqual([regular.orderNumber]);
    expect(await numbers()).toEqual([lego.orderNumber, regular.orderNumber, mixed.orderNumber].sort());
    const { total } = await purchaseService.listPurchaseOrders({ kind: "lego", limit: 1, offset: 0 });
    expect(total).toBe(2);
  });
});
