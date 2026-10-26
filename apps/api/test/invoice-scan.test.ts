import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like, sql } from "drizzle-orm";
import {
  auditLog,
  companyInfo,
  db,
  invoiceScanHints,
  invoiceScans,
  purchaseOrderRows,
  purchaseOrders,
  supplierInvoiceFiles,
  supplierInvoices,
  suppliers,
  systemSettings,
} from "@navet/db";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import {
  createSupplierInvoiceService,
  DuplicateSupplierInvoiceNumberError,
  SupplierInvoiceFileFromScanError,
} from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createInvoiceScanRepository, MAX_HINTS_PER_FIELD } from "../src/modules/purchase/repository/invoice-scan.repository.js";
import {
  createInvoiceScanService,
  InvoiceScanAiNotConfiguredError,
  InvoiceScanDuplicateError,
  type UploadedFile,
} from "../src/modules/purchase/service/invoice-scan.service.js";
import { createInvoiceScanSettingsService } from "../src/modules/purchase/service/invoice-scan-settings.service.js";
import { InvalidStatusTransitionError } from "../src/modules/purchase/service/purchase.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { extractPdfText } from "../src/modules/purchase/service/invoice-scan/pdf-text.js";
import { DEFAULT_POSTING_SETTINGS, testArticleService } from "./helpers/services.js";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { createAlertsService } from "../src/modules/alerts/service/alerts.service.js";
import { brokenPdf, FAKE_BUYER, FAKE_OCR, FAKE_SUPPLIER, imageOnlyPdf, invoicePdf, jpegImage, pngImage } from "./helpers/invoice-pdf.js";

// Fakturaskanning — the inbox against the database (spec §6, steg 1):
// upload, the rules on a generated PDF, the own-identifier filter, the
// conversion in one transaction, the learning, avvisa/återställ/radera, the
// purchase order matching on and off. All data is made up.

const TODAY = "2026-10-15";
const audit = createAuditRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const supplierInvoiceService = createSupplierInvoiceService(
  createSupplierInvoiceRepository(db),
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  audit
);
const repo = createInvoiceScanRepository(db);
const settings = createInvoiceScanSettingsService({ repo, audit });
const service = createInvoiceScanService({
  repo,
  supplierInvoices: supplierInvoiceService,
  company: systemService,
  settings,
  audit,
  today: () => TODAY,
  log: () => {},
});
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE invoice_scan_hints, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, purchase_order_rows, purchase_orders, article_suppliers, supplier_contacts, suppliers, bom_components, articles, audit_log, users CASCADE`;

let companyBefore: typeof companyInfo.$inferSelect | undefined;
let userId: string;

beforeAll(async () => {
  [companyBefore] = await db.select().from(companyInfo).limit(1);
  if (!companyBefore) await db.insert(companyInfo).values({ name: FAKE_BUYER.name });
  await db.update(companyInfo).set({
    name: FAKE_BUYER.name,
    orgNumber: FAKE_BUYER.orgNumber,
    vatNumber: FAKE_BUYER.vatNumber,
    bankgiro: FAKE_BUYER.bankgiro,
    plusgiro: null,
    iban: null,
    postalCode: FAKE_BUYER.postalCode,
  });
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
  const user = await authRepo.create({ email: `fi-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Inköpare", role: "admin" });
  userId = user.id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
  if (companyBefore) {
    const { id: _id, ...rest } = companyBefore;
    await db.update(companyInfo).set(rest);
  } else {
    await db.delete(companyInfo);
  }
});

async function makeSupplier(over: Partial<typeof suppliers.$inferInsert> = {}) {
  const [row] = await db
    .insert(suppliers)
    .values({ supplierNumber: `L${crypto.randomUUID().slice(0, 8)}`, name: FAKE_SUPPLIER.name, orgNumber: FAKE_SUPPLIER.orgNumber, currency: "SEK", ...over })
    .returning();
  return row!;
}

function pdfFile(data: Buffer, filename = "faktura.pdf"): UploadedFile {
  return { filename, contentType: "application/pdf", data, truncated: false };
}

async function uploadOne(data: Buffer, filename?: string) {
  const result = await service.upload([pdfFile(data, filename)], userId);
  expect(result.created).toHaveLength(1);
  return result.created[0]!;
}

function convertInput(supplierId: string, over: Record<string, unknown> = {}) {
  return {
    supplierId,
    invoiceNumber: "10045",
    invoiceDate: "2026-10-01",
    dueDate: "2026-10-31",
    netAmount: 1000,
    vatAmount: 250,
    grossAmount: 1250,
    paymentReference: { kind: "ocr" as const, value: FAKE_OCR },
    rows: [],
    ...over,
  };
}

async function auditActions(entityType: string) {
  return (await db.select().from(auditLog).where(eq(auditLog.entityType, entityType))).map((r) => r.action).sort();
}

describe("upload", () => {
  it("stores the file, gives it an FI- number and interprets it with the rules", async () => {
    const supplier = await makeSupplier();
    const created = await uploadOne(await invoicePdf());
    expect(created).toMatchObject({
      scanNumber: expect.stringMatching(/^FI-\d+$/),
      status: "interpreted",
      source: "upload",
      supplierId: supplier.id,
      supplierName: supplier.name,
      invoiceNumber: "10045",
      grossAmount: 1250,
      currency: "SEK",
      uncertain: false,
    });
    expect(created).not.toHaveProperty("data");
    expect(created).not.toHaveProperty("result");
    const detail = await service.get(created.id);
    expect(detail).toMatchObject({ hasTextLayer: true, pageCount: 1, interpretedBy: "rules", aiAvailable: false, poMatching: true });
    expect(detail.result).toMatchObject({ supplier: { matchedSupplierId: supplier.id, matchedBy: "org_number" }, invoiceDate: { value: "2026-10-01" } });
    expect(await auditActions("invoice_scan")).toEqual(["received"]);
  });

  it("takes several files and reports duplicates and refused files beside the created ones", async () => {
    const pdf = await invoicePdf();
    const first = await uploadOne(pdf);
    const result = await service.upload(
      [
        pdfFile(pdf, "samma.pdf"),
        { filename: "faktura.xml", contentType: "application/xml", data: Buffer.from("<x/>"), truncated: false },
        { filename: "stor.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.7"), truncated: true },
        { filename: "falsk.pdf", contentType: "application/pdf", data: Buffer.from("hello"), truncated: false },
        { filename: "tom.png", contentType: "image/png", data: Buffer.alloc(0), truncated: false },
        { filename: "foto.jpg", contentType: "image/jpeg", data: jpegImage(), truncated: false },
      ],
      userId
    );
    expect(result.created.map((c) => c.filename)).toEqual(["foto.jpg"]);
    expect(result.duplicates).toEqual([{ filename: "samma.pdf", existing: { id: first.id, scanNumber: first.scanNumber, status: "interpreted" } }]);
    expect(result.rejected.map((r) => [r.filename, r.reason])).toEqual([
      ["faktura.xml", "Filtypen stöds inte — ladda upp PDF, JPEG eller PNG"],
      ["stor.pdf", "Filen är för stor — max 20 MB"],
      ["falsk.pdf", "Filens innehåll är inte en PDF, JPEG eller PNG"],
      ["tom.png", "Filen är tom"],
    ]);
    // The duplicate burned no FI- number: the image got the next one.
    expect(Number(result.created[0]!.scanNumber.slice(3))).toBe(Number(first.scanNumber.slice(3)) + 1);
  });

  it("leaves an image for the AI or the hand: interpreted with an empty proposal", async () => {
    const [created] = (await service.upload([{ filename: "foto.png", contentType: "image/png", data: pngImage(), truncated: false }], userId)).created;
    const detail = await service.get(created!.id);
    expect(detail).toMatchObject({ status: "interpreted", hasTextLayer: null });
    expect(detail.result!.checks).toEqual(["Bilder tolkas inte lokalt — tolka med AI eller fyll i fälten för hand"]);
    expect(detail.uncertain).toBe(true);
  });

  it("marks a scanned PDF without a text layer", async () => {
    const created = await uploadOne(await imageOnlyPdf());
    const detail = await service.get(created.id);
    expect(detail).toMatchObject({ status: "interpreted", hasTextLayer: false, pageCount: 1 });
    expect(detail.result!.checks[0]).toMatch(/saknar textlager/);
  });

  it("keeps a PDF pdfjs cannot read in new with the check — never an error", async () => {
    const created = await uploadOne(brokenPdf());
    const detail = await service.get(created.id);
    expect(detail.status).toBe("new");
    expect(detail.result!.checks).toEqual(["PDF:en gick inte att läsa"]);
    expect(detail.interpretedBy).toBeNull();
  });

  it("survives an extraction that crashes outright", async () => {
    const crashing = createInvoiceScanService({
      repo,
      supplierInvoices: supplierInvoiceService,
      company: systemService,
      settings,
      today: () => TODAY,
      extractText: async () => {
        throw new TypeError("boom");
      },
      log: () => {},
    });
    const result = await crashing.upload([pdfFile(await invoicePdf())], userId);
    expect(result.created[0]).toMatchObject({ status: "new" });
  });

  it("never matches the buyer's own organisationsnummer to a supplier", async () => {
    // A supplier that happens to be registered with the COMPANY's number.
    await makeSupplier({ name: "Spegel AB", orgNumber: FAKE_BUYER.orgNumber });
    const created = await uploadOne(await invoicePdf({ seller: { name: "Främmande Säljare AB" } }));
    expect(created.supplierId).toBeNull();
  });

  it("points at an existing supplier invoice with the same number", async () => {
    const supplier = await makeSupplier();
    const existing = await supplierInvoiceService.create(convertInput(supplier.id), userId);
    const created = await uploadOne(await invoicePdf());
    const detail = await service.get(created.id);
    expect(detail.result!.duplicateOf).toEqual({ supplierInvoiceId: existing!.id, registrationNumber: existing!.registrationNumber });
  });
});

describe("Tolka igen / Tolka med AI", () => {
  it("re-runs the rules and replaces the result", async () => {
    const created = await uploadOne(await invoicePdf());
    expect(created.supplierId).toBeNull();
    const supplier = await makeSupplier();
    const again = await service.interpret(created.id, "rules");
    expect(again.result!.supplier.matchedSupplierId).toBe(supplier.id);
  });

  it("answers Tolka med AI with ai-not-configured until the AI step", async () => {
    const created = await uploadOne(await invoicePdf());
    await expect(service.interpret(created.id, "ai")).rejects.toBeInstanceOf(InvoiceScanAiNotConfiguredError);
  });

  it("refuses to interpret a rejected scan", async () => {
    const created = await uploadOne(await invoicePdf());
    await service.reject(created.id, "Reklam", userId);
    await expect(service.interpret(created.id, "rules")).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });
});

describe("Skapa leverantörsfaktura (convert)", () => {
  it("creates the draft, moves the file and learns the labels in one transaction", async () => {
    const supplier = await makeSupplier();
    const pdf = await invoicePdf({ labels: { invoiceNumber: "Verifikat:" } });
    const created = await uploadOne(pdf);
    // The unusual label is unknown to the rules.
    expect(created.invoiceNumber).toBeNull();

    const invoice = await service.convert(created.id, convertInput(supplier.id), userId);
    expect(invoice).toMatchObject({ status: "draft", invoiceNumber: "10045", supplierId: supplier.id, grossAmount: "1250.00" });
    expect(invoice!.files).toHaveLength(1);
    expect(invoice!.files[0]).toMatchObject({ filename: "faktura.pdf", contentType: "application/pdf" });

    const [scan] = await db.select().from(invoiceScans).where(eq(invoiceScans.id, created.id));
    expect(scan).toMatchObject({ status: "converted", supplierInvoiceId: invoice!.id, supplierInvoiceFileId: invoice!.files[0]!.id, data: null });
    const [file] = await db.select().from(supplierInvoiceFiles).where(eq(supplierInvoiceFiles.id, scan!.supplierInvoiceFileId!));
    expect(file!.sha256).toBe(scan!.sha256);
    expect(file!.data.equals(pdf)).toBe(true);
    // The file is still served — now from the supplier invoice's underlag.
    expect((await service.readFile(created.id)).data.equals(pdf)).toBe(true);

    const hints = await db.select().from(invoiceScanHints).where(eq(invoiceScanHints.supplierId, supplier.id));
    expect(hints.map((h) => [h.field, h.label]).sort()).toEqual(
      [
        ["dueDate", "förfallodatum"],
        ["grossAmount", "att betala"],
        ["invoiceDate", "fakturadatum"],
        ["invoiceNumber", "verifikat"],
        ["netAmount", "summa exkl. moms"],
        ["paymentReference", "ocr-nummer"],
        ["vatAmount", "moms 25 %"],
      ].sort()
    );
    expect(await auditActions("invoice_scan")).toEqual(["converted", "received"]);
    expect(await auditActions("supplier_invoice")).toEqual(["created", "file_added"]);
    const [fileAdded] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "supplier_invoice"), eq(auditLog.action, "file_added")));
    expect(fileAdded!.detail).toMatchObject({ fromScan: created.scanNumber, sha256: scan!.sha256 });

    // The next invoice from the supplier reads the learned label.
    const next = await uploadOne(await invoicePdf({ labels: { invoiceNumber: "Verifikat:" }, invoiceNumber: "10046" }));
    const detail = await service.get(next.id);
    expect(detail.result!.invoiceNumber).toEqual({ value: "10046", confidence: "high", source: "learned" });
    // A learned label that is used again is strengthened.
    await service.convert(next.id, convertInput(supplier.id, { invoiceNumber: "10046" }), userId);
    const [hint] = await db
      .select()
      .from(invoiceScanHints)
      .where(and(eq(invoiceScanHints.supplierId, supplier.id), eq(invoiceScanHints.field, "invoiceNumber")));
    expect(hint!.hits).toBe(2);
  });

  it("changes nothing when the invoice number already exists for the supplier", async () => {
    const supplier = await makeSupplier();
    await supplierInvoiceService.create(convertInput(supplier.id), userId);
    const created = await uploadOne(await invoicePdf());
    await expect(service.convert(created.id, convertInput(supplier.id), userId)).rejects.toBeInstanceOf(DuplicateSupplierInvoiceNumberError);
    const [scan] = await db.select().from(invoiceScans).where(eq(invoiceScans.id, created.id));
    expect(scan).toMatchObject({ status: "interpreted", supplierInvoiceId: null, supplierInvoiceFileId: null });
    expect(scan!.data).not.toBeNull();
    expect(await db.select().from(supplierInvoiceFiles)).toHaveLength(0);
    expect(await db.select().from(invoiceScanHints)).toHaveLength(0);
    expect(await db.select().from(supplierInvoices)).toHaveLength(1);
  });

  it("refuses a converted or rejected scan", async () => {
    const supplier = await makeSupplier();
    const created = await uploadOne(await invoicePdf());
    await service.convert(created.id, convertInput(supplier.id), userId);
    await expect(service.convert(created.id, convertInput(supplier.id, { invoiceNumber: "2" }), userId)).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    const other = await uploadOne(await invoicePdf({ invoiceNumber: "777" }));
    await service.reject(other.id, "Fel mottagare", userId);
    await expect(service.convert(other.id, convertInput(supplier.id, { invoiceNumber: "777" }), userId)).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("keeps the inbox's file on the supplier invoice draft", async () => {
    const supplier = await makeSupplier();
    const created = await uploadOne(await invoicePdf());
    const invoice = await service.convert(created.id, convertInput(supplier.id), userId);
    await expect(supplierInvoiceService.deleteFile(invoice!.id, invoice!.files[0]!.id, userId)).rejects.toBeInstanceOf(SupplierInvoiceFileFromScanError);
  });

  it("keeps at most five labels per supplier and field", async () => {
    const supplier = await makeSupplier();
    await db.transaction(async (tx) => {
      for (let i = 0; i < MAX_HINTS_PER_FIELD + 2; i++) {
        await repo.upsertHintsInTx(tx, supplier.id, [{ field: "invoiceNumber", label: `etikett ${i}` }]);
      }
    });
    const rows = await db.select().from(invoiceScanHints).where(eq(invoiceScanHints.supplierId, supplier.id));
    expect(rows).toHaveLength(MAX_HINTS_PER_FIELD);
  });
});

describe("Avvisa, Återställ, Radera", () => {
  it("deletes only a rejected scan, and logs the file", async () => {
    const created = await uploadOne(await invoicePdf());
    await expect(service.remove(created.id, userId)).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    const rejected = await service.reject(created.id, "Reklam", userId);
    expect(rejected).toMatchObject({ status: "rejected", rejectedReason: "Reklam", rejectedBy: userId });
    await service.remove(created.id, userId);
    expect(await db.select().from(invoiceScans)).toHaveLength(0);
    const [deleted] = await db.select().from(auditLog).where(eq(auditLog.action, "deleted"));
    expect(deleted).toMatchObject({ entityType: "invoice_scan", entityId: created.scanNumber });
    expect(deleted!.detail).toMatchObject({ filename: "faktura.pdf", reason: "Reklam", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("restores to where the scan was", async () => {
    const interpreted = await uploadOne(await invoicePdf());
    await service.reject(interpreted.id, "Fel", userId);
    expect((await service.restore(interpreted.id, userId)).status).toBe("interpreted");
    const unread = await uploadOne(brokenPdf());
    await service.reject(unread.id, "Fel", userId);
    const restored = await service.restore(unread.id, userId);
    expect(restored).toMatchObject({ status: "new", rejectedReason: null, rejectedAt: null });
    await expect(service.restore(unread.id, userId)).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("lets a rejected file be uploaded again — and then refuses to restore the old one", async () => {
    const pdf = await invoicePdf();
    const first = await uploadOne(pdf);
    await service.reject(first.id, "Dubblett", userId);
    const again = await uploadOne(pdf);
    await expect(service.restore(first.id, userId)).rejects.toMatchObject({
      constructor: InvoiceScanDuplicateError,
      existing: { id: again.id, scanNumber: again.scanNumber },
    });
  });
});

describe("Matcha mot inköpsorder", () => {
  async function receivedOrder(supplierId: string, orderNumber: string) {
    const article = await testArticleService.createArticle({ articleNumber: `ART-${crypto.randomUUID().slice(0, 6)}`, name: "Plåt", type: "purchased", active: true });
    const [order] = await db.insert(purchaseOrders).values({ orderNumber, supplierId, status: "received" }).returning();
    await db.insert(purchaseOrderRows).values({ purchaseOrderId: order!.id, articleId: article.id, quantityOrdered: "4", quantityReceived: "4", unitPrice: "250" });
    return order!;
  }

  it("finds the purchase order named on the invoice", async () => {
    const supplier = await makeSupplier();
    await receivedOrder(supplier.id, "IO-9101");
    const order = await receivedOrder(supplier.id, "IO-9102");
    const created = await uploadOne(await invoicePdf({ orderReference: "IO-9102" }));
    const detail = await service.get(created.id);
    expect(detail.result!.purchaseOrderId).toEqual({ value: order.id, confidence: "high", source: "rules" });
  });

  it("proposes the supplier's one open received order (low) when the invoice names none", async () => {
    const supplier = await makeSupplier();
    const order = await receivedOrder(supplier.id, "IO-9201");
    const created = await uploadOne(await invoicePdf());
    expect((await service.get(created.id)).result!.purchaseOrderId).toEqual({ value: order.id, confidence: "low", source: "rules" });
  });

  it("does not propose an order whose received goods are already invoiced", async () => {
    const supplier = await makeSupplier();
    const order = await receivedOrder(supplier.id, "IO-9251");
    const [row] = await db.select().from(purchaseOrderRows).where(eq(purchaseOrderRows.purchaseOrderId, order.id));
    await supplierInvoiceService.create(
      convertInput(supplier.id, {
        invoiceNumber: "TIDIGARE-1",
        purchaseOrderId: order.id,
        rows: [{ description: "Plåt", articleId: row!.articleId, purchaseOrderRowId: row!.id, quantity: 4, unitPrice: 250 }],
      }),
      userId
    );
    const created = await uploadOne(await invoicePdf());
    expect((await service.get(created.id)).result!.purchaseOrderId.value).toBeNull();
  });

  it("leaves the purchase order fields empty when the setting is off", async () => {
    const supplier = await makeSupplier();
    await receivedOrder(supplier.id, "IO-9301");
    await settings.update({ poMatching: false }, userId);
    const created = await uploadOne(await invoicePdf({ orderReference: "IO-9301" }));
    const detail = await service.get(created.id);
    expect(detail.poMatching).toBe(false);
    expect(detail.result!.purchaseOrderId.value).toBeNull();
    expect(detail.result!.purchaseOrderReference.value).toBeNull();
  });
});

describe("the alert invoice_scans_pending", () => {
  it("lists the scans still to review (new + interpreted), oldest first", async () => {
    const alerts = createAlertsService({
      repo: createAlertsRepository(db),
      planning: { requirementProposals: async () => [], orderPlanSummaries: async () => new Map() },
      settings: { supplierInvoiceDays: async () => 7, quoteFollowupDays: async () => 7 },
      today: () => TODAY,
    });
    const supplier = await makeSupplier();
    const first = await uploadOne(await invoicePdf());
    const unread = await uploadOne(brokenPdf(), "trasig.pdf");
    const rejected = await uploadOne(await invoicePdf({ invoiceNumber: "555" }));
    await service.reject(rejected.id, "Reklam", userId);
    const converted = await uploadOne(await invoicePdf({ invoiceNumber: "556" }));
    await service.convert(converted.id, convertInput(supplier.id, { invoiceNumber: "556" }), userId);

    const [group] = (await alerts.computeAlerts(["invoice_scans_pending"])).groups;
    expect(group).toMatchObject({ kind: "invoice_scans_pending", label: "Fakturor i inkorgen att granska", severity: "yellow", count: 2, listHref: "/inkop/fakturainkorg", error: false });
    expect(group!.items.map((i) => i.key)).toEqual([first.id, unread.id]);
    expect(group!.items[0]).toMatchObject({
      href: `/inkop/fakturainkorg/${first.id}`,
      primary: `${first.scanNumber} faktura.pdf`,
      secondary: `Uppladdad · ${FAKE_SUPPLIER.name} · fakturanr 10045`,
    });
  });
});

describe("the text extraction", () => {
  it("reads the generated invoice's text in well under the time limit", async () => {
    const started = Date.now();
    const text = await extractPdfText(await invoicePdf());
    expect(text.charCount).toBeGreaterThan(200);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
