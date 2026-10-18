import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createPurchaseRepository } from "../src/modules/purchase/repository/purchase.repository.js";
import {
  createPurchaseService,
  InvalidStatusTransitionError,
  SupplierNotFoundError,
} from "../src/modules/purchase/service/purchase.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import {
  createSupplierInvoiceService,
  DuplicateSupplierInvoiceNumberError,
  InvalidSupplierInvoiceFileTypeError,
  PoMatchMismatchError,
  SupplierInvoiceFileLockedError,
  SupplierInvoiceFileNotFoundError,
  SupplierInvoiceNotFoundError,
} from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService);
const documentPdfService = createDocumentPdfService(systemService);
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
// Automatkontering (B2): approving an invoice now books an L verification.
// The poster reads its 14 account numbers from a fixed stub rather than the
// live system settings — this suite is about the invoice flow, not about the
// posting configuration (supplier-invoice-posting.test.ts drives the real
// readPostingSettings wiring), and system_settings survives the TRUNCATE below.
const invoicePoster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
const auditRepository = createAuditRepository(db);
const supplierInvoiceService = createSupplierInvoiceService(
  createSupplierInvoiceRepository(db),
  invoicePoster,
  auditRepository
);

// number_series is intentionally not truncated — the LF- seed must persist.
// The B1/B2 bookkeeping tables join the list because every approve() now
// writes a verification into them.
const TRUNCATE = sql`TRUNCATE supplier_invoice_files, posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, supplier_invoice_rows, supplier_invoices, article_suppliers, email_log, inquiry_rows, inquiries, purchase_order_rows, purchase_orders, supplier_contacts, suppliers, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

// The invoice date decides the posting period, so the transition tests date
// their invoices "today" — inside the fiscal year setupPostingBaseline lays
// out. A hard-coded year would go red the moment the calendar rolls over.
const POSTING_DATE = new Date().toLocaleDateString("sv-SE");

beforeEach(async () => {
  await db.execute(TRUNCATE);
  // A fiscal year covering today (the invoice date) + the BAS accounts the
  // posting settings point at — without them no invoice can be approved.
  await setupPostingBaseline();
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `ap-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "AP",
    role: "admin",
  });
}

async function makeSupplier(name = "Lev AB", currency = "SEK") {
  return purchaseService.createSupplier({ name, currency, active: true });
}

// payment_terms is shared base data and is deliberately NOT in the TRUNCATE
// above (same reasoning as number_series), so an entry a previous run left
// behind is reused rather than re-inserted into its unique code/name.
async function makePaymentTerm(code: string, name: string) {
  const existing = (await registerService.paymentTerms.list()).find((term) => term.code === code);
  return existing ?? registerService.paymentTerms.create({ code, name });
}

async function makeArticle(articleNumber: string) {
  return articleService.createArticle({ articleNumber, name: articleNumber, type: "purchased", active: true });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

// A draft invoice with one article row, for the transition/edit tests.
async function makeInvoice() {
  const user = await makeUser();
  const supplier = await makeSupplier();
  const article = await makeArticle(`ART-AP-${crypto.randomUUID()}`);
  const invoice = await supplierInvoiceService.create(
    {
      supplierId: supplier.id,
      invoiceNumber: `INV-${crypto.randomUUID()}`,
      invoiceDate: POSTING_DATE,
      netAmount: 100,
      vatAmount: 25,
      grossAmount: 125,
      rows: [{ description: "Material", articleId: article.id, quantity: 2, unitPrice: 50, vatRate: 25 }],
    },
    user.id
  );
  return { user, supplier, article, invoice: invoice! };
}

describe("supplier invoice — creation", () => {
  it("creates a draft invoice with an LF number, snapshots the currency, computes row amounts", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier("Valuta AB", "EUR");
    const invoice = await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: "INV-1001",
        invoiceDate: "2026-07-01",
        netAmount: 100,
        vatAmount: 25,
        grossAmount: 125,
        rows: [{ description: "Material", quantity: 2, unitPrice: 50, vatRate: 25 }],
      },
      user.id
    );

    expect(invoice!.registrationNumber).toMatch(/^LF-\d+$/);
    expect(invoice!.status).toBe("draft");
    expect(invoice!.currency).toBe("EUR");
    expect(invoice!.rows).toHaveLength(1);
    expect(invoice!.rows[0]!.lineAmount).toBe("100.00");
    expect(invoice!.rows[0]!.vatAmount).toBe("25.00");
  });

  it("404s for a missing supplier", async () => {
    const user = await makeUser();
    await expect(
      supplierInvoiceService.create(
        { supplierId: crypto.randomUUID(), invoiceNumber: "X", invoiceDate: "2026-07-01", rows: [] },
        user.id
      )
    ).rejects.toThrow(SupplierNotFoundError);
  });

  it("rejects a duplicate (supplier, invoiceNumber) but allows the same number for another supplier", async () => {
    const user = await makeUser();
    const s1 = await makeSupplier("S1");
    const s2 = await makeSupplier("S2");
    await supplierInvoiceService.create(
      { supplierId: s1.id, invoiceNumber: "DUP-1", invoiceDate: "2026-07-01", rows: [] },
      user.id
    );
    await expect(
      supplierInvoiceService.create(
        { supplierId: s1.id, invoiceNumber: "DUP-1", invoiceDate: "2026-07-02", rows: [] },
        user.id
      )
    ).rejects.toThrow(DuplicateSupplierInvoiceNumberError);
    const ok = await supplierInvoiceService.create(
      { supplierId: s2.id, invoiceNumber: "DUP-1", invoiceDate: "2026-07-02", rows: [] },
      user.id
    );
    expect(ok!.registrationNumber).toMatch(/^LF-\d+$/);
  });
});

// Leverantörsreskontra (B4): the due date is what the open-item list sorts
// and the overdue filter compares against, so it is derived at CREATE from
// the supplier's payment term when the client does not type one in.
describe("supplier invoice — förfallodatum", () => {
  async function makeSupplierWithTerm(name: string, code: string, termName: string) {
    const term = await makePaymentTerm(code, termName);
    return purchaseService.createSupplier({ name, currency: "SEK", active: true, paymentTermId: term.id });
  }

  it("derives the due date from the supplier's payment term when none is given", async () => {
    const user = await makeUser();
    const supplier = await makeSupplierWithTerm("Villkor AB", "30", "30 dagar netto");
    const invoice = await supplierInvoiceService.create(
      { supplierId: supplier.id, invoiceNumber: "DD-1", invoiceDate: "2026-07-01", rows: [] },
      user.id
    );
    expect(invoice!.dueDate).toBe("2026-07-31");
  });

  it("leaves the due date empty for a payment term that is not a number of days", async () => {
    const user = await makeUser();
    const supplier = await makeSupplierWithTerm("Kontant AB", "KONTANT", "Kontant");
    const invoice = await supplierInvoiceService.create(
      { supplierId: supplier.id, invoiceNumber: "DD-2", invoiceDate: "2026-07-01", rows: [] },
      user.id
    );
    expect(invoice!.dueDate).toBeNull();
  });

  it("keeps an explicit due date even when the supplier has a payment term", async () => {
    const user = await makeUser();
    const supplier = await makeSupplierWithTerm("Villkor AB", "30", "30 dagar netto");
    const invoice = await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: "DD-3",
        invoiceDate: "2026-07-01",
        dueDate: "2026-08-15",
        rows: [],
      },
      user.id
    );
    expect(invoice!.dueDate).toBe("2026-08-15");
  });
});

describe("supplier invoice — status flow", () => {
  // "paid" is not a transition this service offers any more (B4): it is a
  // side effect of registering a payment, covered by the payment suite.
  it("walks draft → approved", async () => {
    const { user, invoice } = await makeInvoice();
    expect((await supplierInvoiceService.approve(invoice.id, user.id))!.status).toBe("approved");
  });

  it("cancels from draft and from approved", async () => {
    const a = await makeInvoice();
    expect((await supplierInvoiceService.cancel(a.invoice.id, a.user.id))!.status).toBe("cancelled");

    const b = await makeInvoice();
    await supplierInvoiceService.approve(b.invoice.id, b.user.id);
    expect((await supplierInvoiceService.cancel(b.invoice.id, b.user.id))!.status).toBe("cancelled");
  });

  // What "paid" refuses is asserted where a paid invoice can actually be
  // produced — by registering a payment (the supplier-payment suite).
  it("rejects invalid transitions", async () => {
    const { user, invoice } = await makeInvoice();
    await supplierInvoiceService.approve(invoice.id, user.id);
    // approve from approved
    await expect(supplierInvoiceService.approve(invoice.id, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    await supplierInvoiceService.cancel(invoice.id, user.id);
    // cancelled is terminal: no second cancel, no approve
    await expect(supplierInvoiceService.cancel(invoice.id, user.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(supplierInvoiceService.approve(invoice.id, user.id)).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("blocks header and row edits outside draft", async () => {
    const { user, invoice } = await makeInvoice();
    await supplierInvoiceService.approve(invoice.id, user.id);
    const rowId = invoice.rows[0]!.id;

    await expect(supplierInvoiceService.updateHeader(invoice.id, { note: "x" })).rejects.toThrow(
      InvalidStatusTransitionError
    );
    await expect(
      supplierInvoiceService.addRow(invoice.id, { description: "y", quantity: 1, unitPrice: 1 })
    ).rejects.toThrow(InvalidStatusTransitionError);
    await expect(supplierInvoiceService.updateRow(invoice.id, rowId, { quantity: 3 })).rejects.toThrow(
      InvalidStatusTransitionError
    );
    await expect(supplierInvoiceService.deleteRow(invoice.id, rowId)).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("supplier invoice — rows and PO matching", () => {
  it("edits a row in draft and recomputes its amounts", async () => {
    const { invoice } = await makeInvoice();
    const rowId = invoice.rows[0]!.id;
    await supplierInvoiceService.updateRow(invoice.id, rowId, { quantity: 4, unitPrice: 10 });
    const full = await supplierInvoiceService.getInvoice(invoice.id);
    expect(full!.rows[0]!.lineAmount).toBe("40.00");
  });

  it("matches a row to a PO row and computes variance; rejects mismatches", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier("MatchLev");
    const otherSupplier = await makeSupplier("OtherLev");
    const article = await makeArticle(`ART-M-${crypto.randomUUID()}`);
    const article2 = await makeArticle(`ART-M2-${crypto.randomUUID()}`);
    const location = await makeLocation();
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const poRow = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 10, unitPrice: 42 });
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, poRow.id, { locationId: location.id, quantity: 8 }, user.id);

    // Another supplier to pay → the match against the order still stands
    const otherInvoice = await supplierInvoiceService.create(
      { supplierId: otherSupplier.id, invoiceNumber: "M-1", invoiceDate: "2026-07-01", rows: [] },
      user.id
    );
    const otherRow = await supplierInvoiceService.addRow(otherInvoice!.id, {
      description: "m",
      articleId: article.id,
      purchaseOrderRowId: poRow.id,
      quantity: 8,
      unitPrice: 45,
    });
    expect(otherRow.purchaseOrderRowId).toBe(poRow.id);

    // Unknown PO row → mismatch
    await expect(
      supplierInvoiceService.addRow(otherInvoice!.id, {
        description: "m",
        articleId: article.id,
        purchaseOrderRowId: crypto.randomUUID(),
        quantity: 8,
        unitPrice: 45,
      })
    ).rejects.toThrow(PoMatchMismatchError);

    // Wrong article → mismatch
    const invoice = await supplierInvoiceService.create(
      { supplierId: supplier.id, invoiceNumber: "M-2", invoiceDate: "2026-07-01", rows: [] },
      user.id
    );
    await expect(
      supplierInvoiceService.addRow(invoice!.id, {
        description: "m",
        articleId: article2.id,
        purchaseOrderRowId: poRow.id,
        quantity: 8,
        unitPrice: 45,
      })
    ).rejects.toThrow(PoMatchMismatchError);

    // Valid match → variance computed on read
    await supplierInvoiceService.addRow(invoice!.id, {
      description: "Material",
      articleId: article.id,
      purchaseOrderRowId: poRow.id,
      quantity: 8,
      unitPrice: 45,
    });
    const full = await supplierInvoiceService.getInvoice(invoice!.id);
    const row = full!.rows[0]!;
    expect(Number(row.priceVariance)).toBe(3); // 45 − 42
    expect(Number(row.quantityVariance)).toBe(0); // 8 invoiced − 8 received
  });
});

describe("supplier invoice — basis from purchase order", () => {
  // Mirrors the create dialog: rows carry the PO row id pulled from a
  // received order, and the header links the order.
  it("creates an invoice with rows matched to a received purchase order", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier("UnderlagLev");
    const article = await makeArticle(`ART-U-${crypto.randomUUID()}`);
    const location = await makeLocation();
    const order = await purchaseService.createPurchaseOrder({ supplierId: supplier.id }, user.id);
    const poRow = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 10, unitPrice: 40 });
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, poRow.id, { locationId: location.id, quantity: 7 }, user.id);

    const invoice = await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: "U-1",
        invoiceDate: "2026-07-01",
        purchaseOrderId: order.id,
        rows: [
          { description: "Material", articleId: article.id, quantity: 7, unitPrice: 42, purchaseOrderRowId: poRow.id },
        ],
      },
      user.id
    );

    expect(invoice!.purchaseOrderId).toBe(order.id);
    expect(invoice!.rows).toHaveLength(1);
    const row = invoice!.rows[0]!;
    expect(row.purchaseOrderRowId).toBe(poRow.id);
    expect(Number(row.priceVariance)).toBe(2); // 42 invoiced − 40 ordered
    expect(Number(row.quantityVariance)).toBe(0); // 7 invoiced − 7 received
  });

  it("creates an invoice paid to another supplier than the purchase order's, keeping the match", async () => {
    const user = await makeUser();
    const payee = await makeSupplier("Factoring AB");
    const orderedFrom = await makeSupplier("B");
    const article = await makeArticle(`ART-X-${crypto.randomUUID()}`);
    const order = await purchaseService.createPurchaseOrder({ supplierId: orderedFrom.id }, user.id);
    const poRow = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 5, unitPrice: 10 });

    const invoice = await supplierInvoiceService.create(
      {
        supplierId: payee.id,
        invoiceNumber: "X-1",
        invoiceDate: "2026-07-01",
        purchaseOrderId: order.id,
        rows: [
          { description: "m", articleId: article.id, quantity: 5, unitPrice: 12, purchaseOrderRowId: poRow.id },
        ],
      },
      user.id
    );
    expect(invoice!.supplierId).toBe(payee.id);
    expect(invoice!.purchaseOrderId).toBe(order.id);
    expect(invoice!.rows[0]!.purchaseOrderRowId).toBe(poRow.id);
    expect(Number(invoice!.rows[0]!.priceVariance)).toBe(2);
  });
});

describe("supplier invoice — byte av leverantör", () => {
  it("changes the supplier of a draft, keeps the PO match, re-snapshots the currency and logs it", async () => {
    const user = await makeUser();
    const orderedFrom = await makeSupplier("Beställd hos AB");
    const payee = await makeSupplier("Betalas till AB", "EUR");
    const article = await makeArticle(`ART-B-${crypto.randomUUID()}`);
    const location = await makeLocation();
    const order = await purchaseService.createPurchaseOrder({ supplierId: orderedFrom.id }, user.id);
    const poRow = await purchaseService.addRow(order.id, { articleId: article.id, quantity: 4, unitPrice: 25 });
    await purchaseService.confirm(order.id);
    await purchaseService.receiveGoods(order.id, poRow.id, { locationId: location.id, quantity: 4 }, user.id);
    const invoice = await supplierInvoiceService.create(
      {
        supplierId: orderedFrom.id,
        invoiceNumber: "B-1",
        invoiceDate: "2026-07-01",
        purchaseOrderId: order.id,
        rows: [{ description: "m", articleId: article.id, quantity: 4, unitPrice: 25, purchaseOrderRowId: poRow.id }],
      },
      user.id
    );
    expect(invoice!.currency).toBe("SEK");

    const updated = await supplierInvoiceService.updateHeader(invoice!.id, { supplierId: payee.id }, user.id);
    expect(updated!.supplierId).toBe(payee.id);
    expect(updated!.supplierName).toBe("Betalas till AB");
    expect(updated!.currency).toBe("EUR");
    expect(updated!.purchaseOrderId).toBe(order.id);
    expect(updated!.rows[0]!.purchaseOrderRowId).toBe(poRow.id);
    expect(Number(updated!.rows[0]!.quantityVariance)).toBe(0);

    // A row added afterwards can still be matched against the order.
    const added = await supplierInvoiceService.addRow(invoice!.id, {
      description: "m2",
      articleId: article.id,
      purchaseOrderRowId: poRow.id,
      quantity: 1,
      unitPrice: 25,
    });
    expect(added.purchaseOrderRowId).toBe(poRow.id);

    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, invoice!.registrationNumber), eq(auditLog.action, "supplier_changed")));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.detail).toEqual({
      before: { supplier: `${orderedFrom.supplierNumber} Beställd hos AB` },
      after: { supplier: `${payee.supplierNumber} Betalas till AB` },
    });
  });

  it("logs nothing when the same supplier is sent again", async () => {
    const { user, supplier, invoice } = await makeInvoice();
    await supplierInvoiceService.updateHeader(invoice.id, { supplierId: supplier.id, note: "x" }, user.id);
    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, invoice.registrationNumber), eq(auditLog.action, "supplier_changed")));
    expect(entries).toHaveLength(0);
  });

  it("404s an unknown supplier and refuses a duplicate invoice number at the new supplier", async () => {
    const { user, invoice } = await makeInvoice();
    await expect(
      supplierInvoiceService.updateHeader(invoice.id, { supplierId: crypto.randomUUID() }, user.id)
    ).rejects.toThrow(SupplierNotFoundError);

    const other = await makeSupplier("Annan AB");
    await supplierInvoiceService.create(
      { supplierId: other.id, invoiceNumber: invoice.invoiceNumber, invoiceDate: "2026-07-01", rows: [] },
      user.id
    );
    await expect(supplierInvoiceService.updateHeader(invoice.id, { supplierId: other.id }, user.id)).rejects.toThrow(
      DuplicateSupplierInvoiceNumberError
    );
  });

  it("refuses to change the supplier once the invoice is approved", async () => {
    const { user, invoice } = await makeInvoice();
    await supplierInvoiceService.approve(invoice.id, user.id);
    const other = await makeSupplier("Sen AB");
    await expect(supplierInvoiceService.updateHeader(invoice.id, { supplierId: other.id }, user.id)).rejects.toThrow(
      InvalidStatusTransitionError
    );
  });
});

describe("supplier invoice — list filters", () => {
  it("filters by articleId (only invoices with a row for that article); a freight-only row is allowed", async () => {
    const user = await makeUser();
    const supplier = await makeSupplier("FilterLev");
    const article = await makeArticle(`ART-F-${crypto.randomUUID()}`);
    const withArticle = await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: "F-1",
        invoiceDate: "2026-07-01",
        rows: [{ description: "Material", articleId: article.id, quantity: 1, unitPrice: 10 }],
      },
      user.id
    );
    // Freight-only invoice (no article on the row).
    await supplierInvoiceService.create(
      {
        supplierId: supplier.id,
        invoiceNumber: "F-2",
        invoiceDate: "2026-07-01",
        rows: [{ description: "Frakt", quantity: 1, unitPrice: 99 }],
      },
      user.id
    );

    const filtered = await supplierInvoiceService.list({ articleId: article.id, limit: 50, offset: 0 });
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0]!.id).toBe(withArticle!.id);
  });

  it("filters by status", async () => {
    const a = await makeInvoice();
    await supplierInvoiceService.approve(a.invoice.id, a.user.id);
    await makeInvoice(); // stays draft

    const approved = await supplierInvoiceService.list({ status: ["approved"], limit: 50, offset: 0 });
    expect(approved.total).toBe(1);
    expect(approved.rows[0]!.id).toBe(a.invoice.id);
  });
});

// G1: audit trail — one representative assertion per action class (same
// auditRows helper pattern as payroll-attest.test.ts / sales.service.test.ts).
async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

describe("supplier invoice — audit trail", () => {
  it("logs created, approved and cancelled under the invoice's LF-number", async () => {
    const { user, invoice } = await makeInvoice();

    const created = await auditRows("supplier_invoice", "created");
    expect(created).toHaveLength(1);
    expect(created[0]!.entityId).toBe(invoice.registrationNumber);
    expect(created[0]!.userId).toBe(user.id);

    await supplierInvoiceService.approve(invoice.id, user.id);
    const approved = await auditRows("supplier_invoice", "approved");
    expect(approved).toHaveLength(1);
    expect(approved[0]!.entityId).toBe(invoice.registrationNumber);

    await supplierInvoiceService.cancel(invoice.id, user.id);
    const cancelled = await auditRows("supplier_invoice", "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.entityId).toBe(invoice.registrationNumber);
  });
});

// Underlag — the supplier's invoice as a file. Räkenskapsinformation: always
// addable, removable only while the invoice is a draft.
describe("supplier invoice — underlag (files)", () => {
  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);

  it("stores the file with its SHA-256, lists it without data, logs it, and serves it back", async () => {
    const { user, invoice } = await makeInvoice();
    const data = pdf("faktura 4711");
    const row = await supplierInvoiceService.addFile(
      invoice.id,
      { filename: "faktura-4711.pdf", contentType: "application/pdf", data },
      user.id
    );

    const expectedHash = (await import("node:crypto")).createHash("sha256").update(data).digest("hex");
    expect(row).toMatchObject({ filename: "faktura-4711.pdf", sizeBytes: data.length, sha256: expectedHash, uploadedBy: user.id });
    expect(row).not.toHaveProperty("data");

    const detail = await supplierInvoiceService.getInvoice(invoice.id);
    expect(detail!.files.map((f) => f.id)).toEqual([row.id]);
    expect(detail!.files[0]).not.toHaveProperty("data");

    const file = await supplierInvoiceService.downloadFile(invoice.id, row.id);
    expect(Buffer.compare(file.data, data)).toBe(0);

    const logged = await auditRows("supplier_invoice", "file_added");
    expect(logged).toHaveLength(1);
    expect(logged[0]!.entityId).toBe(invoice.registrationNumber);
    expect(logged[0]!.detail).toMatchObject({ filename: "faktura-4711.pdf", sha256: expectedHash });
  });

  it("rejects file types other than PDF/JPEG/PNG", async () => {
    const { user, invoice } = await makeInvoice();
    await expect(
      supplierInvoiceService.addFile(
        invoice.id,
        { filename: "x.exe", contentType: "application/octet-stream", data: Buffer.from("MZ") },
        user.id
      )
    ).rejects.toBeInstanceOf(InvalidSupplierInvoiceFileTypeError);
  });

  it("lets a draft's file be removed (logged), but never an attested invoice's — adding still works", async () => {
    const { user, invoice } = await makeInvoice();
    const wrong = await supplierInvoiceService.addFile(
      invoice.id,
      { filename: "fel.pdf", contentType: "application/pdf", data: pdf("fel") },
      user.id
    );
    await supplierInvoiceService.deleteFile(invoice.id, wrong.id, user.id);
    expect((await supplierInvoiceService.listFiles(invoice.id))).toEqual([]);
    expect(await auditRows("supplier_invoice", "file_deleted")).toHaveLength(1);

    const right = await supplierInvoiceService.addFile(
      invoice.id,
      { filename: "ratt.pdf", contentType: "application/pdf", data: pdf("rätt") },
      user.id
    );
    await supplierInvoiceService.approve(invoice.id, user.id);

    await expect(supplierInvoiceService.deleteFile(invoice.id, right.id, user.id)).rejects.toBeInstanceOf(
      SupplierInvoiceFileLockedError
    );
    expect((await supplierInvoiceService.listFiles(invoice.id)).map((f) => f.id)).toEqual([right.id]);

    // A late second page can still be added to the attested invoice.
    await supplierInvoiceService.addFile(
      invoice.id,
      { filename: "sida2.png", contentType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      user.id
    );
    expect(await supplierInvoiceService.listFiles(invoice.id)).toHaveLength(2);
  });

  it("404s an unknown invoice or a file that belongs to another invoice", async () => {
    const a = await makeInvoice();
    const b = await makeInvoice();
    const file = await supplierInvoiceService.addFile(
      a.invoice.id,
      { filename: "a.pdf", contentType: "application/pdf", data: pdf("a") },
      a.user.id
    );
    await expect(supplierInvoiceService.downloadFile(b.invoice.id, file.id)).rejects.toBeInstanceOf(
      SupplierInvoiceFileNotFoundError
    );
    await expect(supplierInvoiceService.deleteFile(b.invoice.id, file.id, b.user.id)).rejects.toBeInstanceOf(
      SupplierInvoiceFileNotFoundError
    );
    await expect(supplierInvoiceService.listFiles(crypto.randomUUID())).rejects.toBeInstanceOf(
      SupplierInvoiceNotFoundError
    );
  });
});
