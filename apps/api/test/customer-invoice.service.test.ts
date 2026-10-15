import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
import { auditLog, db, units, verifications } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import {
  createSalesService,
  CustomerNotFoundError,
  InvalidStatusTransitionError,
} from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import {
  createInvoiceService,
  EmptyInvoiceError,
  InvoiceNotFoundError,
  NotCreditableError,
  OverCreditError,
  OverInvoicingError,
  SalesOrderRowMismatchError,
} from "../src/modules/sales/service/invoice.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService, type MailTransportFactory } from "../src/modules/mail/service/mail.service.js";
import { createDocumentPdfService } from "../src/modules/mail/service/document-pdf.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { pdfText } from "./helpers/pdf.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));

const sentMails: { to: string; subject: string; attachments?: { filename: string; content: Buffer }[] }[] = [];
const fakeTransportFactory: MailTransportFactory = () => ({
  async sendMail(opts) {
    sentMails.push(opts);
  },
});

const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, fakeTransportFactory);
const documentPdfService = createDocumentPdfService(systemService);
const salesService = createSalesService(
  createSalesRepository(db),
  registerService,
  mailService,
  documentPdfService,
  stockService,
  articleService,
  systemService,
  (query) => resolvePrice(db, query)
);
const invoiceRepo = createInvoiceRepository(db);
// Automatkontering (B2): issuing an invoice now books an F verification.
// The poster reads its 14 account numbers from a fixed stub rather than the
// live system settings — this suite is about the invoice flow, not about the
// posting configuration (customer-invoice-posting.test.ts drives the real
// readPostingSettings wiring), and system_settings survives the TRUNCATE below.
const invoicePoster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
const auditRepository = createAuditRepository(db);
const invoiceService = createInvoiceService(
  invoiceRepo,
  mailService,
  documentPdfService,
  invoicePoster,
  auditRepository,
  articleService
);

// number_series is intentionally not truncated — the FA seed must persist
// for later tasks that issue invoices from this same test suite family.
// payment_terms IS truncated (Task 4 onwards creates them per-test for the
// due-date cases) — CASCADE takes customers/sales_orders/invoices with it,
// which are already listed explicitly. The B1/B2 bookkeeping tables join the
// list because every issue() now writes a verification into them.
const TRUNCATE = sql`TRUNCATE posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_rows, invoices, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

// The user every issue() below books its verification as — created fresh
// after each TRUNCATE (verifications.created_by/audit_log.user_id are real
// FKs). Tests that need their own actor still call makeUser().
let issuedBy: string;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  sentMails.length = 0;
  await systemService.updateSettings({ smtpHost: "smtp.test.local", smtpFromEmail: "erp@test.local" });
  // A fiscal year covering today (the invoice date) + the BAS accounts the
  // posting settings point at — without them no invoice can be issued.
  await setupPostingBaseline();
  issuedBy = (await makeUser()).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser() {
  return authRepo.create({
    email: `inv-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Biller",
    role: "admin",
  });
}

async function makeCustomer(name = "Kund AB") {
  return salesService.createCustomer({ name, active: true });
}

async function makeArticle(vatRate?: number) {
  return articleService.createArticle({
    articleNumber: `ART-INV-${crypto.randomUUID()}`,
    name: "Fakturaartikel",
    type: "manufactured",
    active: true,
    ...(vatRate !== undefined ? { vatRate } : {}),
  });
}

async function makeLocation() {
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  return stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
}

async function seedStock(articleId: string, locationId: string, quantity: number) {
  await stockService.recordTransaction({
    articleId,
    locationId,
    quantityDelta: quantity,
    transactionType: "inventory_adjustment",
  });
}

// Builds a customer + article + a sales order confirmed → in_production →
// delivered (delivered defaults to ordered, i.e. fully delivered). Returns
// the order and its single row for use as a delfaktureringslänk.
async function makeDeliveredOrderRow(opts: {
  customer?: Awaited<ReturnType<typeof makeCustomer>>;
  ordered?: number;
  delivered?: number;
  unitPrice?: number;
  vatRate?: number;
  discountPercent?: number;
}) {
  const user = await makeUser();
  const customer = opts.customer ?? (await makeCustomer());
  const article = await makeArticle(opts.vatRate);
  const location = await makeLocation();
  const ordered = opts.ordered ?? opts.delivered ?? 10;
  const delivered = opts.delivered ?? ordered;
  await seedStock(article.id, location.id, ordered);

  const { order, rows } = await salesService.createQuote(
    {
      customerId: customer.id,
      rows: [
        {
          articleId: article.id,
          quantity: ordered,
          unitPrice: opts.unitPrice ?? 100,
          ...(opts.discountPercent !== undefined ? { discountPercent: opts.discountPercent } : {}),
        },
      ],
      confirm: true,
    },
    user.id
  );
  await salesService.startProduction(order.id);
  if (delivered > 0) {
    await salesService.deliverGoods(order.id, rows[0]!.id, { locationId: location.id, quantity: delivered }, user.id);
  }
  const [row] = await salesService.listRows(order.id);
  return { user, customer, article, location, order, row: row! };
}

describe("customer invoice — creation", () => {
  it("creates a draft invoice with a free row (no article): vatRate defaults to 25, amounts computed", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Frakt", quantity: 2, unitPrice: 50 }] },
      user.id
    );

    expect(invoice!.status).toBe("draft");
    expect(invoice!.invoiceNumber).toBeNull();
    expect(invoice!.rows).toHaveLength(1);
    const row = invoice!.rows[0]!;
    expect(row.articleId).toBeNull();
    expect(row.vatRate).toBe("25.00");
    expect(row.lineAmount).toBe("100.00");
    expect(row.vatAmount).toBe("25.00");
  });

  it("an article row inherits the article's VAT rate; an explicit vatRate wins", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle(12);
    const invoice = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "Artikel", articleId: article.id, quantity: 1, unitPrice: 200 },
          { description: "Artikel, sänkt moms", articleId: article.id, quantity: 1, unitPrice: 200, vatRate: 6 },
        ],
      },
      user.id
    );

    expect(invoice!.rows[0]!.vatRate).toBe("12.00");
    expect(invoice!.rows[1]!.vatRate).toBe("6.00");
  });

  it("404s for a missing customer", async () => {
    const user = await makeUser();
    await expect(
      invoiceService.create({ customerId: crypto.randomUUID(), rows: [] }, user.id)
    ).rejects.toThrow(CustomerNotFoundError);
  });

  it("bakes discountPercent into lineAmount/vatAmount with a single rounding", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Rabatterad vara", quantity: 10, unitPrice: 100, discountPercent: 10 }],
      },
      user.id
    );

    const row = invoice!.rows[0]!;
    // 10 × 100 × (1 − 10 %) = 900.00 net, 25 % moms = 225.00.
    expect(row.lineAmount).toBe("900.00");
    expect(row.vatAmount).toBe("225.00");
  });
});

describe("customer invoice — list", () => {
  it("aggregates netAmount/vatAmount per invoice from its rows (positive amounts)", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "A", quantity: 2, unitPrice: 50 }, // 100.00 net, 25.00 vat
          { description: "B", quantity: 1, unitPrice: 40, vatRate: 0 }, // 40.00 net, 0.00 vat
        ],
      },
      user.id
    );

    const list = await invoiceService.list({ limit: 50, offset: 0 });
    const found = list.rows.find((r) => r.id === invoice!.id)!;
    expect(found.netAmount).toBe("140.00");
    expect(found.vatAmount).toBe("25.00");
  });
});

describe("customer invoice — listInvoiceableOrders (prefill)", () => {
  it("shows the remaining un-invoiced quantity per row; a fully drafted row is omitted", async () => {
    const { customer, order, article, row } = await makeDeliveredOrderRow({ ordered: 10, delivered: 10, unitPrice: 50 });
    const biller = await makeUser();

    // Invoice 4 of the 10 delivered as a draft.
    await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Delvis", articleId: article.id, salesOrderRowId: row.id, quantity: 4, unitPrice: 50 }],
      },
      biller.id
    );

    const list = await invoiceService.listInvoiceableOrders(customer.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.orderId).toBe(order.id);
    expect(list[0]!.rows).toHaveLength(1);
    expect(list[0]!.rows[0]!.salesOrderRowId).toBe(row.id);
    expect(list[0]!.rows[0]!.rest).toBe(6);

    // Invoice the remaining 6 — the row (and thus the order) drops out.
    await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Resten", articleId: article.id, salesOrderRowId: row.id, quantity: 6, unitPrice: 50 }],
      },
      biller.id
    );
    expect(await invoiceService.listInvoiceableOrders(customer.id)).toHaveLength(0);
  });

  it("carries the order row's discountPercent for the client to prefill", async () => {
    const { customer, order, row } = await makeDeliveredOrderRow({
      ordered: 5,
      delivered: 5,
      unitPrice: 100,
      discountPercent: 15,
    });

    const list = await invoiceService.listInvoiceableOrders(customer.id);
    expect(list[0]!.orderId).toBe(order.id);
    expect(list[0]!.rows[0]!.salesOrderRowId).toBe(row.id);
    expect(list[0]!.rows[0]!.discountPercent).toBe("15.00");
  });
});

describe("customer invoice — collection invoice across orders", () => {
  it("bills rows from two orders of the same customer in one invoice", async () => {
    const customer = await makeCustomer();
    const a = await makeDeliveredOrderRow({ customer, ordered: 5, delivered: 5, unitPrice: 40 });
    const b = await makeDeliveredOrderRow({ customer, ordered: 3, delivered: 3, unitPrice: 60 });
    const biller = await makeUser();

    const invoice = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "Order A", articleId: a.article.id, salesOrderRowId: a.row.id, quantity: 5, unitPrice: 40 },
          { description: "Order B", articleId: b.article.id, salesOrderRowId: b.row.id, quantity: 3, unitPrice: 60 },
        ],
      },
      biller.id
    );

    expect(invoice!.rows).toHaveLength(2);
  });

  it("rejects a row linked to another customer's sales order row", async () => {
    const customer = await makeCustomer("A AB");
    const other = await makeDeliveredOrderRow({ ordered: 5, delivered: 5 });
    const biller = await makeUser();

    await expect(
      invoiceService.create(
        {
          customerId: customer.id,
          rows: [
            {
              description: "Fel kund",
              articleId: other.article.id,
              salesOrderRowId: other.row.id,
              quantity: 1,
              unitPrice: 10,
            },
          ],
        },
        biller.id
      )
    ).rejects.toThrow(SalesOrderRowMismatchError);
  });

  it("rejects a row linked to a sales order row for a different article", async () => {
    const customer = await makeCustomer();
    const { row } = await makeDeliveredOrderRow({ customer, ordered: 5, delivered: 5 });
    const otherArticle = await makeArticle();
    const biller = await makeUser();

    await expect(
      invoiceService.create(
        {
          customerId: customer.id,
          rows: [
            { description: "Fel artikel", articleId: otherArticle.id, salesOrderRowId: row.id, quantity: 1, unitPrice: 10 },
          ],
        },
        biller.id
      )
    ).rejects.toThrow(SalesOrderRowMismatchError);
  });
});

describe("customer invoice — over-invoicing guard", () => {
  it("accumulates quantities across rows within the same create() batch, not just against prior invoices", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();

    // Two rows in ONE create() call, both linked to the same 5-delivered
    // order row. Each row alone (3) is within bounds, but the batch's
    // combined 6 is not — this must be rejected even though the DB has no
    // prior invoice yet when either row is individually resolved.
    await expect(
      invoiceService.create(
        {
          customerId: customer.id,
          rows: [
            { description: "Del 1", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 },
            { description: "Del 2", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 },
          ],
        },
        biller.id
      )
    ).rejects.toThrow(OverInvoicingError);
  });

  it("allows two rows on the same order row within one create() batch when their sum fits", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();

    const invoice = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "Del 1", articleId: article.id, salesOrderRowId: row.id, quantity: 2, unitPrice: 10 },
          { description: "Del 2", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 },
        ],
      },
      biller.id
    );
    expect(invoice!.rows).toHaveLength(2);
  });

  it("rejects invoicing more than what's been delivered", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();

    await expect(
      invoiceService.create(
        {
          customerId: customer.id,
          rows: [{ description: "För mycket", articleId: article.id, salesOrderRowId: row.id, quantity: 6, unitPrice: 10 }],
        },
        biller.id
      )
    ).rejects.toThrow(OverInvoicingError);
  });

  it("counts drafts across invoices: 3 + 3 on a 5-delivered row — the second invoice is stopped", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();

    await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Först", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 }],
      },
      biller.id
    );
    await expect(
      invoiceService.create(
        {
          customerId: customer.id,
          rows: [{ description: "Sen", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 }],
        },
        biller.id
      )
    ).rejects.toThrow(OverInvoicingError);
  });

  it("excludes the row's own previous quantity from the guard when updating it", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();
    const invoice = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "x", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 }],
      },
      biller.id
    );

    // Raising 3 → 5 on the SAME row must not count its own prior 3 twice.
    const updated = await invoiceService.updateRow(invoice!.id, invoice!.rows[0]!.id, { quantity: 5 });
    expect(updated.quantity).toBe("5.0000");

    // But raising past what's delivered still fails.
    await expect(
      invoiceService.updateRow(invoice!.id, invoice!.rows[0]!.id, { quantity: 6 })
    ).rejects.toThrow(OverInvoicingError);
  });
});

describe("customer invoice — draft status", () => {
  it("a draft has invoiceNumber null; header and row edits are blocked once status leaves draft", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const invoice = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      user.id
    );
    expect(invoice!.invoiceNumber).toBeNull();
    const rowId = invoice!.rows[0]!.id;

    // Task 4 owns the real draft → issued transition (with FA number
    // allocation); here we only need *a* non-draft status to exercise the
    // guard, so the raw repo setter stands in for it.
    await invoiceRepo.updateStatus(invoice!.id, "issued");

    await expect(invoiceService.updateHeader(invoice!.id, { note: "x" })).rejects.toThrow(
      InvalidStatusTransitionError
    );
    await expect(
      invoiceService.addRow(invoice!.id, { description: "y", quantity: 1, unitPrice: 1 })
    ).rejects.toThrow(InvalidStatusTransitionError);
    await expect(invoiceService.updateRow(invoice!.id, rowId, { quantity: 3 })).rejects.toThrow(
      InvalidStatusTransitionError
    );
    await expect(invoiceService.deleteRow(invoice!.id, rowId)).rejects.toThrow(InvalidStatusTransitionError);
  });
});

describe("customer invoice — repository: conditional status/row guards close post-check races", () => {
  it("cancelInvoice on an issued invoice is a no-op (null); status is unchanged", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    const result = await invoiceRepo.cancelInvoice(issued!.id);
    expect(result).toBeNull();

    const fetched = await invoiceRepo.findRawById(issued!.id);
    expect(fetched!.status).toBe("issued");
  });

  // B3: the manual "mark as paid" path is GONE — paid is now a consequence of
  // a registered payment settling the invoice's open amount (and issued comes
  // back when that payment is cancelled), all in the payment transaction's own
  // conditional UPDATEs. customer-payment.service.test.ts owns that flow; what
  // is pinned here is that no invoice-side shortcut into "paid" survives.
  it("no markPaid path exists on the invoice service or repository any more", () => {
    expect((invoiceService as unknown as Record<string, unknown>).markPaid).toBeUndefined();
    expect((invoiceRepo as unknown as Record<string, unknown>).markPaid).toBeUndefined();
  });

  it("addRow/updateRow/deleteRow against an issued invoice are no-ops (null) at the repository level, bypassing the service's own status guard", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Original", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const rowId = draft!.rows[0]!.id;
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    const attemptedRow = {
      articleId: null,
      salesOrderRowId: null,
      description: "Should never land",
      quantity: 9,
      unitPrice: 9,
      discountPercent: 0,
      unitId: null,
      unitFactor: null,
      vatRate: 25,
      lineAmount: 81,
      vatAmount: 20.25,
    };

    expect(await invoiceRepo.addRow(issued!.id, attemptedRow)).toBeNull();
    expect(await invoiceRepo.updateRow(issued!.id, rowId, attemptedRow)).toBeNull();
    expect(await invoiceRepo.deleteRow(issued!.id, rowId)).toBeNull();

    // The row set is exactly what it was at issue — untouched by any of the
    // three attempts above.
    const rows = await invoiceRepo.listRows(issued!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(rowId);
    expect(rows[0]!.description).toBe("Original");
    expect(Number(rows[0]!.quantity)).toBe(1);
  });
});

// Bankgiro Luhn check, copied from ocr.test.ts — the OCR the invoice gets
// stamped with at issue must independently verify as mod-10 valid.
function luhnValid(ocr: string): boolean {
  const sum = [...ocr].reverse().reduce((acc, ch, idx) => {
    let d = Number(ch);
    if (idx % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    return acc + d;
  }, 0);
  return sum % 10 === 0;
}

// Two calendar-date strings ("YYYY-MM-DD") compared as UTC midnights so the
// day delta is exact regardless of the server's local timezone/DST.
function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`).getTime();
  const db = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((db - da) / (24 * 60 * 60 * 1000));
}

describe("customer invoice — issue", () => {
  it("burns a number only on success — cancelling a draft in between leaves the FA series unbroken", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();

    const a = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "A", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issuedA = await invoiceService.issue(a!.id, issuedBy);

    const b = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "B", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    await invoiceService.cancel(b!.id);

    const c = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "C", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issuedC = await invoiceService.issue(c!.id, issuedBy);

    const numA = Number(issuedA!.invoiceNumber!.replace(/\D/g, ""));
    const numC = Number(issuedC!.invoiceNumber!.replace(/\D/g, ""));
    expect(numC).toBe(numA + 1);
  });

  it("stamps an OCR number derived from the invoice number, Luhn-valid", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    expect(issued!.ocrNumber).not.toBeNull();
    const digits = issued!.invoiceNumber!.replace(/\D/g, "");
    expect(issued!.ocrNumber!.startsWith(digits)).toBe(true);
    expect(luhnValid(issued!.ocrNumber!)).toBe(true);
  });

  it("invoiceDate is today; a numeric payment-term code sets a due date that many days later", async () => {
    const term = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, paymentTermId: term.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    expect(issued!.invoiceDate).toBe(new Date().toLocaleDateString("sv-SE"));
    expect(issued!.dueDate).not.toBeNull();
    expect(daysBetween(issued!.invoiceDate!, issued!.dueDate!)).toBe(30);
  });

  it("a non-numeric payment-term code (KONTANT) leaves the due date null", async () => {
    const term = await registerService.paymentTerms.create({ code: "KONTANT", name: "Kontant" });
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, paymentTermId: term.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    expect(issued!.dueDate).toBeNull();
  });

  it("falls back to the customer's own payment term when the invoice has none", async () => {
    const term = await registerService.paymentTerms.create({ code: "10", name: "10 dagar netto" });
    const customer = await salesService.createCustomer({ name: "Kund med villkor", paymentTermId: term.id, active: true });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    expect(daysBetween(issued!.invoiceDate!, issued!.dueDate!)).toBe(10);
  });

  it("freezes the customer snapshot at issue — later edits to the customer don't change getInvoice", async () => {
    const customer = await salesService.createCustomer({
      name: "Ursprungsnamn AB",
      invoiceAddress: "Gamla vägen 1",
      invoicePostalCode: "111 11",
      invoiceCity: "Gamlastad",
      active: true,
    });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    await invoiceService.issue(draft!.id, issuedBy);

    await salesService.updateCustomer(customer.id, {
      name: "Nya Namnet AB",
      invoiceAddress: "Nya vägen 2",
      invoiceCity: "Nystad",
    });

    const fetched = await invoiceService.getInvoice(draft!.id);
    expect(fetched!.customerName).toBe("Ursprungsnamn AB");
    expect(fetched!.invoiceAddress).toBe("Gamla vägen 1");
    expect(fetched!.invoiceCity).toBe("Gamlastad");
  });

  // Migration 0085: fakturanamn (invoiceName) replaces the customer name in
  // the snapshot, but only when the customer also has a separate invoice
  // address — same rule invoice.service.ts's issue() and sales.service.ts's
  // renderInvoicePdf apply, see the comment at issue()'s useInvoiceAddress.
  it("snapshots invoiceName as customerName and invoiceCountry when the customer has a separate invoice address", async () => {
    const customer = await salesService.createCustomer({
      name: "Kundens Juridiska Namn AB",
      active: true,
      invoiceName: "c/o Holdingbolaget AB",
      invoiceAddress: "Box 100",
      invoicePostalCode: "400 10",
      invoiceCity: "Göteborg",
      invoiceCountry: "DK",
    });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    expect(issued!.customerName).toBe("c/o Holdingbolaget AB");
    expect(issued!.invoiceCountry).toBe("DK");
  });

  it("snapshots the customer's own name (not invoiceName) when there is no separate invoice address", async () => {
    // invoiceName set but no invoiceAddress — the invoiceName is inert
    // until the customer also has a separate invoice address (matches
    // Monitor: fakturanamn lives on the invoice-address block).
    const customer = await salesService.createCustomer({
      name: "Kundens Juridiska Namn AB",
      active: true,
      invoiceName: "c/o Holdingbolaget AB",
      country: "NO",
    });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    expect(issued!.customerName).toBe("Kundens Juridiska Namn AB");
    // No invoice address -> falls back to the customer's own country.
    expect(issued!.invoiceCountry).toBe("NO");
  });

  it("invoice PDF prints the fakturanamn and the invoice address's country", async () => {
    const customer = await salesService.createCustomer({
      name: "Kundens Juridiska Namn AB",
      active: true,
      invoiceName: "c/o Holdingbolaget AB",
      invoiceAddress: "Box 100",
      invoicePostalCode: "400 10",
      invoiceCity: "Göteborg",
      invoiceCountry: "DK",
    });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);

    expect(text).toContain("c/o Holdingbolaget AB");
    expect(text).not.toContain("Kundens Juridiska Namn AB");
    expect(text).toContain("Danmark");
  });

  it("guards: an already-issued invoice can't be re-issued; an empty draft is rejected", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();

    const emptyDraft = await invoiceService.create({ customerId: customer.id, rows: [] }, biller.id);
    await expect(invoiceService.issue(emptyDraft!.id, issuedBy)).rejects.toThrow(EmptyInvoiceError);

    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    await expect(invoiceService.issue(issued!.id, issuedBy)).rejects.toThrow(InvalidStatusTransitionError);
  });

  // B3: the issued -> paid half of this case moved to the payment flow
  // (customer-payment.service.test.ts) — what stays here is that an issued
  // invoice is frozen for row edits and cancellation.
  it("an issued invoice can no longer be row-edited or cancelled", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const rowId = draft!.rows[0]!.id;
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    await expect(invoiceService.updateRow(issued!.id, rowId, { quantity: 3 })).rejects.toThrow(
      InvalidStatusTransitionError
    );
    await expect(invoiceService.cancel(issued!.id)).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("a lost double-issue race does not overwrite the snapshot or burn a second FA number", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();

    const a = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "A", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issuedA = await invoiceService.issue(a!.id, issuedBy);

    // Simulate the losing side of a concurrent double-issue by calling the
    // repository directly on the now-issued invoice — this bypasses the
    // service's own draft-status guard (which reads the invoice fresh and
    // would already reject a truly sequential re-issue before ever reaching
    // issueInvoice; the point of the repo-level conditional UPDATE is to
    // also catch two calls that both pass that guard concurrently). The
    // repo's conditional UPDATE (status = "draft") matches nothing here, so
    // it must report the conflict as `{ ok: false, reason: "race" }` — its
    // "no matching row" convention — rather than silently overwriting
    // invoice A's snapshot. The poster is handed in as a throwing stub: the
    // loser must give up at the conditional UPDATE, before any posting is
    // attempted.
    const raceResult = await invoiceRepo.issueInvoice(
      issuedA!.id,
      {
        invoiceDate: "2020-01-01",
        dueDate: null,
        customerName: "Should never be written",
        invoiceAddress: null,
        invoicePostalCode: null,
        invoiceCity: null,
        orgNumber: null,
        vatNumber: null,
        paymentTermCode: null,
        paymentTermName: null,
      },
      "invoice",
      issuedBy,
      {
        postCustomerInvoice: async () => {
          throw new Error("the losing side must never reach the posting");
        },
      }
    );
    expect(raceResult).toEqual({ ok: false, reason: "race" });

    // The real snapshot from the winning issue is untouched.
    const fetched = await invoiceService.getInvoice(issuedA!.id);
    expect(fetched!.customerName).not.toBe("Should never be written");

    // The losing attempt's number allocation rolled back with its
    // transaction — a fresh draft issued next gets the number immediately
    // after A's, not one skipped for the failed race.
    const b = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "B", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issuedB = await invoiceService.issue(b!.id, issuedBy);

    const numA = Number(issuedA!.invoiceNumber!.replace(/\D/g, ""));
    const numB = Number(issuedB!.invoiceNumber!.replace(/\D/g, ""));
    expect(numB).toBe(numA + 1);
  });
});

describe("customer invoice — issue: committed re-validation (closes over-invoicing without any race)", () => {
  it("credit-draft-then-cancel: a credit draft that temporarily frees quantity can't be used to slip a second invoice past what's delivered", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();

    // Invoice all 5, issue.
    const first = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Full", articleId: article.id, salesOrderRowId: row.id, quantity: 5, unitPrice: 10 }],
      },
      biller.id
    );
    await invoiceService.issue(first!.id, issuedBy);

    // Raise a draft credit for the full amount — at CREATE time this
    // "frees" the row back to 0 net invoiced (includeDrafts:true), so a
    // second full invoice's CREATE-time guard passes too.
    const credit = await invoiceService.createCredit(first!.id, {}, biller.id);

    const second = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Igen", articleId: article.id, salesOrderRowId: row.id, quantity: 5, unitPrice: 10 }],
      },
      biller.id
    );

    // The credit is still just a DRAFT (never issued) — it must not count
    // as freed quantity at the real commitment point. Without the fix, this
    // issue() would succeed (guard sees net 0 via includeDrafts:true), and
    // only cancelling the credit afterwards would reveal the double-booking.
    await expect(invoiceService.issue(second!.id, issuedBy)).rejects.toThrow(OverInvoicingError);

    // Cancelling the still-outstanding credit draft doesn't retroactively
    // make the rejected second invoice issuable via some other path — the
    // row stays fully (and only once) invoiced.
    await invoiceService.cancel(credit!.id);
    const net = await invoiceRepo.getInvoicedQuantities([row.id], { includeDrafts: false });
    expect(net.get(row.id)).toBe(5);
  });

  it("two overlapping drafts (3+3 against 5 delivered) that both passed the create-time guard: the first issues fine, the second's issue throws", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();

    const a = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "A", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 }] },
      biller.id
    );
    // Manufacture the second "overlapping" draft directly via the
    // repository (bypassing resolveRow's create-time guard) — this models
    // two concurrent create() calls that each independently read 0 already
    // invoiced before either's INSERT commits, the way a genuine race would
    // (same "bypass the service guard to simulate a race" idiom as the
    // lost-double-issue-race test above).
    const b = await invoiceRepo.create(
      { customerId: customer.id, paymentTermId: null, note: null },
      [
        {
          articleId: article.id,
          salesOrderRowId: row.id,
          shipmentId: null,
          description: "B",
          quantity: 3,
          unitPrice: 10,
          discountPercent: 0,
          unitId: null,
          unitFactor: null,
          vatRate: 25,
          lineAmount: 30,
          vatAmount: 7.5,
        },
      ],
      biller.id
    );

    const issuedA = await invoiceService.issue(a!.id, issuedBy);
    expect(issuedA!.status).toBe("issued");

    await expect(invoiceService.issue(b.id, issuedBy)).rejects.toThrow(OverInvoicingError);
  });
});

describe("customer invoice — issue: TRUE concurrency race (Task 3, closes C1's parked FOR UPDATE gap)", () => {
  it("two draft invoices (6+6 against 10 delivered) issued via genuinely concurrent transactions: exactly one wins, the loser gets OverInvoicingError, only one F-verifikat is posted, and the loser burned no FA number", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 10, delivered: 10, unitPrice: 10 });
    const biller = await makeUser();

    // Two SEPARATE draft invoices, each independently claiming 6 of the 10
    // delivered — built via repo.create directly, bypassing resolveRow's
    // create-time guard (same established test seam as the "two overlapping
    // drafts" test above and updateStatus's own doc comment): this models
    // two concurrent create() calls that each read 0 already-invoiced
    // before either committed, the state a real race would leave behind.
    const draftRow = (description: string) => ({
      articleId: article.id,
      salesOrderRowId: row.id,
      shipmentId: null,
      description,
      quantity: 6,
      unitPrice: 10,
      discountPercent: 0,
      unitId: null,
      unitFactor: null,
      vatRate: 25,
      lineAmount: 60,
      vatAmount: 15,
    });
    const a = await invoiceRepo.create(
      { customerId: customer.id, paymentTermId: null, note: null },
      [draftRow("A")],
      biller.id
    );
    const b = await invoiceRepo.create(
      { customerId: customer.id, paymentTermId: null, note: null },
      [draftRow("B")],
      biller.id
    );

    const [{ n: verificationsBefore }] = await db.select({ n: count() }).from(verifications);

    // TRUE concurrency: both issue() calls are fired without awaiting
    // between them, so their transactions genuinely interleave — this is
    // the exact race validateCommittedQuantities's FOR UPDATE lock (Task 3)
    // must serialize. Without the lock, both transactions read the
    // pre-commit committed-quantities state and both pass, over-invoicing
    // the row to 12 of 10 delivered once they both commit.
    const results = await Promise.allSettled([invoiceService.issue(a.id, issuedBy), invoiceService.issue(b.id, issuedBy)]);

    const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof invoiceService.issue>>> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(OverInvoicingError);

    // Exactly one of the two invoices actually made it to "issued".
    const rawA = await invoiceRepo.findRawById(a.id);
    const rawB = await invoiceRepo.findRawById(b.id);
    expect([rawA!.status, rawB!.status].filter((s) => s === "issued")).toHaveLength(1);
    expect([rawA!.status, rawB!.status].filter((s) => s === "draft")).toHaveLength(1);

    // Only one F-verifikat was booked — the loser's transaction rolled back
    // before ever reaching the poster (validateCommittedQuantities throws
    // before the posting call in issueInvoice).
    const [{ n: verificationsAfter }] = await db.select({ n: count() }).from(verifications);
    expect(Number(verificationsAfter) - Number(verificationsBefore)).toBe(1);

    // The winner burned an FA number; the loser burned none — asserted the
    // same relative-continuity way as "burns a number only on success"
    // above: issue a fresh invoice afterwards and check its number is
    // exactly one past the winner's, i.e. nothing was skipped for the loser.
    const winner = fulfilled[0]!.value!;
    const c = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "C", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issuedC = await invoiceService.issue(c!.id, issuedBy);
    const numWinner = Number(winner.invoiceNumber!.replace(/\D/g, ""));
    const numC = Number(issuedC!.invoiceNumber!.replace(/\D/g, ""));
    expect(numC).toBe(numWinner + 1);
  });
});

describe("customer invoice — issue: sales order status recompute", () => {
  it("a partial invoice (3 of 5) leaves the order delivered; the second invoice (the remaining 2) flips it to invoiced", async () => {
    const { customer, article, order, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();

    const draft1 = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Del 1", articleId: article.id, salesOrderRowId: row.id, quantity: 3, unitPrice: 10 }],
      },
      biller.id
    );
    await invoiceService.issue(draft1!.id, issuedBy);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("delivered");

    const draft2 = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Del 2", articleId: article.id, salesOrderRowId: row.id, quantity: 2, unitPrice: 10 }],
      },
      biller.id
    );
    await invoiceService.issue(draft2!.id, issuedBy);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("invoiced");
  });

  it("does not flip an order the user manually repositioned away from delivered (setStatus has no transition guard)", async () => {
    const { customer, article, order, row } = await makeDeliveredOrderRow({ ordered: 4, delivered: 4, unitPrice: 10 });
    const biller = await makeUser();
    await salesService.setStatus(order.id, "in_production");

    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "x", articleId: article.id, salesOrderRowId: row.id, quantity: 4, unitPrice: 10 }],
      },
      biller.id
    );
    await invoiceService.issue(draft!.id, issuedBy);

    expect((await salesService.getSalesOrder(order.id))!.status).toBe("in_production");
  });

  it("a fully-drafted row does not count toward the recompute — only issued/paid rows do", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const articleA = await makeArticle();
    const articleB = await makeArticle();
    const location = await makeLocation();
    await seedStock(articleA.id, location.id, 5);
    await seedStock(articleB.id, location.id, 2);

    const { order, rows } = await salesService.createQuote(
      {
        customerId: customer.id,
        rows: [
          { articleId: articleA.id, quantity: 5, unitPrice: 10 },
          { articleId: articleB.id, quantity: 2, unitPrice: 20 },
        ],
        confirm: true,
      },
      user.id
    );
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, rows[0]!.id, { locationId: location.id, quantity: 5 }, user.id);
    await salesService.deliverGoods(order.id, rows[1]!.id, { locationId: location.id, quantity: 2 }, user.id);
    // Re-fetch and match by articleId rather than array position — the two
    // rows are inserted in the same statement/transaction (identical
    // createdAt), and listRows' article/unit joins don't otherwise promise
    // to preserve insertion order between ties.
    const orderRows = await salesService.listRows(order.id);
    const rowA = orderRows.find((r) => r.articleId === articleA.id);
    const rowB = orderRows.find((r) => r.articleId === articleB.id);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("delivered");

    // Draft that fully covers row A — never issued, must not count.
    await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Draft A", articleId: articleA.id, salesOrderRowId: rowA!.id, quantity: 5, unitPrice: 10 }],
      },
      user.id
    );

    // Issue an invoice that fully covers row B only.
    const draftB = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "B", articleId: articleB.id, salesOrderRowId: rowB!.id, quantity: 2, unitPrice: 20 }],
      },
      user.id
    );
    await invoiceService.issue(draftB!.id, issuedBy);

    // Row A's draft doesn't count as invoiced — the order stays delivered.
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("delivered");
  });
});

describe("customer invoice — credit note", () => {
  it("prefills a draft credit as positive copies of the source invoice's rows, same customer/paymentTermId", async () => {
    const term = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10, vatRate: 12 });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        paymentTermId: term.id,
        rows: [
          { description: "Länkad", articleId: article.id, salesOrderRowId: row.id, quantity: 5, unitPrice: 10, vatRate: 12 },
          { description: "Frakt", quantity: 1, unitPrice: 50 },
        ],
      },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    const credit = await invoiceService.createCredit(issued!.id, {}, biller.id);

    expect(credit!.status).toBe("draft");
    expect(credit!.type).toBe("credit");
    expect(credit!.creditedInvoiceId).toBe(issued!.id);
    expect(credit!.customerId).toBe(customer.id);
    expect(credit!.paymentTermId).toBe(term.id);
    expect(credit!.invoiceNumber).toBeNull();
    expect(credit!.rows).toHaveLength(2);

    const linked = credit!.rows.find((r) => r.salesOrderRowId === row.id)!;
    expect(linked.articleId).toBe(article.id);
    expect(linked.quantity).toBe("5.0000"); // stored positive, not negated
    expect(linked.unitPrice).toBe("10.0000");
    expect(linked.vatRate).toBe("12.00");

    // A free row (no salesOrderRowId) is copied too and never guarded.
    const free = credit!.rows.find((r) => r.salesOrderRowId === null)!;
    expect(free.description).toBe("Frakt");
    expect(free.quantity).toBe("1.0000");
  });

  it("supports a partial credit (delkredit) — lowering the prefilled row's quantity after creation", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Full", articleId: article.id, salesOrderRowId: row.id, quantity: 5, unitPrice: 10 }],
      },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    const credit = await invoiceService.createCredit(issued!.id, {}, biller.id);
    const creditRowId = credit!.rows[0]!.id;
    const updated = await invoiceService.updateRow(credit!.id, creditRowId, { quantity: 2 });
    expect(updated.quantity).toBe("2.0000");

    const issuedCredit = await invoiceService.issue(credit!.id, issuedBy);
    expect(issuedCredit!.status).toBe("issued");

    const net = await invoiceRepo.getInvoicedQuantities([row.id], { includeDrafts: false });
    expect(net.get(row.id)).toBe(3); // 5 invoiced - 2 credited
  });

  it("an issued credit gets its own FA number from the same series as ordinary invoices", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    const credit = await invoiceService.createCredit(issued!.id, {}, biller.id);
    const issuedCredit = await invoiceService.issue(credit!.id, issuedBy);

    expect(issuedCredit!.invoiceNumber).not.toBeNull();
    expect(issuedCredit!.type).toBe("credit");
    const numInvoice = Number(issued!.invoiceNumber!.replace(/\D/g, ""));
    const numCredit = Number(issuedCredit!.invoiceNumber!.replace(/\D/g, ""));
    expect(numCredit).toBe(numInvoice + 1);
  });

  it("getInvoice(source).creditedBy: draft credit shows null invoiceNumber (\"Utkast\"), issuing fills it in, a cancelled credit drops out", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    // No credits yet.
    expect((await invoiceService.getInvoice(issued!.id))!.creditedBy).toEqual([]);

    // A still-draft credit is included with a null invoiceNumber — the web
    // labels that "Utkast" rather than hiding a credit already in progress.
    const credit = await invoiceService.createCredit(issued!.id, {}, biller.id);
    let creditedBy = (await invoiceService.getInvoice(issued!.id))!.creditedBy;
    expect(creditedBy).toEqual([{ id: credit!.id, invoiceNumber: null }]);

    // A cancelled credit never happened — same "still counts" rule as the
    // open-amount reader — and drops out again.
    const cancellable = await invoiceService.createCredit(issued!.id, {}, biller.id);
    await invoiceService.cancel(cancellable!.id);
    creditedBy = (await invoiceService.getInvoice(issued!.id))!.creditedBy;
    expect(creditedBy).toEqual([{ id: credit!.id, invoiceNumber: null }]);

    // Issuing the credit fills in its FA number.
    const issuedCredit = await invoiceService.issue(credit!.id, issuedBy);
    creditedBy = (await invoiceService.getInvoice(issued!.id))!.creditedBy;
    expect(creditedBy).toEqual([{ id: issuedCredit!.id, invoiceNumber: issuedCredit!.invoiceNumber }]);
  });

  it("invoice 5, credit 2: net invoiced becomes 3 and the order flips back invoiced -> delivered", async () => {
    const { customer, article, order, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Full", articleId: article.id, salesOrderRowId: row.id, quantity: 5, unitPrice: 10 }],
      },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("invoiced");

    const credit = await invoiceService.createCredit(
      issued!.id,
      { rows: [{ description: "Retur", articleId: article.id, salesOrderRowId: row.id, quantity: 2, unitPrice: 10 }] },
      biller.id
    );
    await invoiceService.issue(credit!.id, issuedBy);

    const net = await invoiceRepo.getInvoicedQuantities([row.id], { includeDrafts: false });
    expect(net.get(row.id)).toBe(3);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("delivered");
  });

  it("rejects crediting more than what's net invoiced (6 of 5) with OverCreditError", async () => {
    const { customer, article, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Full", articleId: article.id, salesOrderRowId: row.id, quantity: 5, unitPrice: 10 }],
      },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    await expect(
      invoiceService.createCredit(
        issued!.id,
        { rows: [{ description: "För mycket", articleId: article.id, salesOrderRowId: row.id, quantity: 6, unitPrice: 10 }] },
        biller.id
      )
    ).rejects.toThrow(OverCreditError);
  });

  it("a cancelled draft credit does not affect net invoiced or order status", async () => {
    const { customer, article, order, row } = await makeDeliveredOrderRow({ ordered: 5, delivered: 5, unitPrice: 10 });
    const biller = await makeUser();
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Full", articleId: article.id, salesOrderRowId: row.id, quantity: 5, unitPrice: 10 }],
      },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("invoiced");

    const credit = await invoiceService.createCredit(issued!.id, {}, biller.id);
    await invoiceService.cancel(credit!.id);

    const net = await invoiceRepo.getInvoicedQuantities([row.id], { includeDrafts: true });
    expect(net.get(row.id)).toBe(5);
    expect((await salesService.getSalesOrder(order.id))!.status).toBe("invoiced");
  });

  it("allows crediting a paid invoice too", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    // "paid" is only setup here — reaching it for real means registering a
    // payment that settles the whole open amount (B3), which is not what this
    // case is about, so the unconditional repository seam stands in for it
    // (same rationale as the status-guard cases above).
    await invoiceRepo.updateStatus(issued!.id, "paid");

    const credit = await invoiceService.createCredit(issued!.id, {}, biller.id);
    expect(credit!.status).toBe("draft");
    expect(credit!.creditedInvoiceId).toBe(issued!.id);
  });

  it("rejects crediting a draft, a cancelled invoice, or a credit note itself (no credit-of-credit)", async () => {
    const customer = await makeCustomer();
    const biller = await makeUser();

    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    await expect(invoiceService.createCredit(draft!.id, {}, biller.id)).rejects.toThrow(NotCreditableError);

    const toCancel = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "y", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    await invoiceService.cancel(toCancel!.id);
    await expect(invoiceService.createCredit(toCancel!.id, {}, biller.id)).rejects.toThrow(NotCreditableError);

    const issuable = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "z", quantity: 1, unitPrice: 10 }] },
      biller.id
    );
    const issued = await invoiceService.issue(issuable!.id, issuedBy);
    const credit = await invoiceService.createCredit(issued!.id, {}, biller.id);
    await invoiceService.issue(credit!.id, issuedBy);
    await expect(invoiceService.createCredit(credit!.id, {}, biller.id)).rejects.toThrow(NotCreditableError);
  });

  it("404s for a missing invoice", async () => {
    const biller = await makeUser();
    await expect(invoiceService.createCredit(crypto.randomUUID(), {}, biller.id)).rejects.toThrow(
      InvoiceNotFoundError
    );
  });
});

// Mirrors document-pdf.ts's formatNumber (including its U+2212 -> '-'
// normalization — WinAnsiEncoding has no glyph for the Unicode minus sign),
// so the credit-note assertions below build the expected string the same
// way instead of hardcoding a literal that would depend on ICU's choice.
function sv(n: number): string {
  return n.toLocaleString("sv-SE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace("−", "-");
}

describe("customer invoice — PDF and email", () => {
  it("perRow VAT: mixed 25/12 rows print both rate lines with correct sv-SE amounts and Att betala", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "A", quantity: 2, unitPrice: 100, vatRate: 25 }, // 200.00 net, 50.00 vat
          { description: "B", quantity: 1, unitPrice: 100, vatRate: 12 }, // 100.00 net, 12.00 vat
        ],
      },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    const { filename, content } = await invoiceService.renderPdf(issued!.id);
    expect(filename).toMatch(/^Faktura-FA-\d+\.pdf$/);
    const text = pdfText(content);

    expect(text).toContain("Moms (25 %)");
    expect(text).toContain("Moms (12 %)");
    expect(text).toContain("Summa exkl. moms");
    expect(text).toContain("Att betala");
    // net 300.00, 25 % vat 50.00, 12 % vat 12.00, att betala 362.00
    expect(text).toContain(sv(300));
    expect(text).toContain(sv(50));
    expect(text).toContain(sv(12));
    expect(text).toContain(sv(362));
  });

  it("perRow VAT: three distinct non-zero rates (25/12/6) all print their own Moms line", async () => {
    // Regression lock for the VAT block's page-break guard: it used to
    // reserve a fixed 3-line height regardless of how many distinct rates
    // perRow prints, which overflows into the footer zone once a document
    // has 2+ rates. This doesn't need to be near the page bottom to catch a
    // *crash*/overflow — the point is verifying all three lines render.
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          { description: "A", quantity: 2, unitPrice: 100, vatRate: 25 }, // 200.00 net, 50.00 vat
          { description: "B", quantity: 1, unitPrice: 100, vatRate: 12 }, // 100.00 net, 12.00 vat
          { description: "C", quantity: 1, unitPrice: 100, vatRate: 6 }, // 100.00 net, 6.00 vat
        ],
      },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);

    expect(text).toContain("Moms (25 %)");
    expect(text).toContain("Moms (12 %)");
    expect(text).toContain("Moms (6 %)");
    // net 400.00, vat 50+12+6=68.00, att betala 468.00
    expect(text).toContain(sv(400));
    expect(text).toContain(sv(50));
    expect(text).toContain(sv(12));
    expect(text).toContain(sv(6));
    expect(text).toContain(sv(468));
  });

  it("perRow VAT: only 0 % rows print no Moms line but the total is still correct", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Fritt", quantity: 3, unitPrice: 40, vatRate: 0 }] }, // 120.00
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);

    expect(text).not.toContain("Moms (");
    expect(text).toContain("Summa exkl. moms");
    expect(text).toContain("Att betala");
    // Summa exkl. moms and Att betala are both the unchanged net (no VAT).
    expect(text).toContain(sv(120));
  });

  it("C3: prints a Rabatt column, and the row's Summa cell is the stored lineAmount (not a re-derived qty×price×discount)", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [{ description: "Rabatterad vara", quantity: 10, unitPrice: 100, discountPercent: 10 }],
      },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);

    expect(text).toContain("Rabatt");
    expect(text).toContain("10 %");
    // 10 × 100 × (1 − 10 %) = 900.00 — the row's stored lineAmount, printed
    // verbatim rather than recomputed from quantity/unitPrice/discount.
    expect(text).toContain(sv(900));
  });

  it("payment box: prints OCR-nummer and Förfallodatum", async () => {
    const term = await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" });
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      { customerId: customer.id, paymentTermId: term.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);

    expect(text).toContain("OCR-nummer:");
    expect(text).toContain(issued!.ocrNumber!);
    expect(text).toContain("rfallodatum"); // Förfallodatum — å/ä/ö pass through WinAnsi
  });

  it("credit PDF: title Kreditfaktura, negated amounts, references the source invoice", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 2, unitPrice: 50, vatRate: 25 }] }, // 100 net, 25 vat, 125 total
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    const credit = await invoiceService.createCredit(issued!.id, {}, user.id);
    const issuedCredit = await invoiceService.issue(credit!.id, issuedBy);

    const { filename, content } = await invoiceService.renderPdf(issuedCredit!.id);
    expect(filename).toMatch(/^Kreditfaktura-FA-\d+\.pdf$/);
    const text = pdfText(content);

    expect(text).toContain("Kreditfaktura FA-");
    expect(text).toContain(`Krediterar faktura ${issued!.invoiceNumber}`);
    expect(text).toContain("Att betala");
    expect(text).toContain(sv(-125)); // negated total, quantities stay positive
    expect(text).toContain("2"); // the row's quantity is still printed positive
    // A credit note is nothing to pay via OCR — no payment box at all, even
    // though issue() stamped an ocrNumber on the credit like any other invoice.
    expect(issuedCredit!.ocrNumber).not.toBeNull();
    expect(text).not.toContain("OCR-nummer:");
    expect(text).not.toContain(issuedCredit!.ocrNumber!);
  });

  it("a delfaktureringslänk row entered in a display unit (factor ≠ 1) prints the unit quantity + code, matching the order confirmation's à-pris", async () => {
    // Article stocked in "st", sold in "kg" (1 st = 5 kg -> factor 5) — same
    // convention as sales-units.service.test.ts.
    let [kg] = await db.select().from(units).where(eq(units.code, "kg"));
    if (!kg) {
      [kg] = await db.insert(units).values({ code: "kg", name: "Kilogram" }).returning();
    }
    const kgId = kg!.id;

    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();
    await articleService.addArticleUnit(article.id, { unitId: kgId, quantityPerBase: 5 });
    const location = await makeLocation();
    await seedStock(article.id, location.id, 100); // 100 st = 500 kg

    const { order, rows } = await salesService.createQuote(
      { customerId: customer.id, rows: [{ articleId: article.id, quantity: 500, unitPrice: 12, unitId: kgId }], confirm: true },
      user.id
    );
    await salesService.startProduction(order.id);
    // Delivered in the base unit, same convention as the row's own stored
    // quantityOrdered/quantityDelivered (both base, see sales-units tests).
    await salesService.deliverGoods(order.id, rows[0]!.id, { locationId: location.id, quantity: 100 }, user.id);
    const [orderRow] = await salesService.listRows(order.id);
    expect(orderRow!.unitCode).toBe("kg");

    // The invoice row's own quantity/unitPrice are base-unit values too (the
    // delfaktureringslänk "rest" prefill is base, see listInvoiceableOrders)
    // — 100 st @ 60 kr/st is the same money as 500 kg @ 12 kr/kg.
    const draft = await invoiceService.create(
      {
        customerId: customer.id,
        rows: [
          {
            description: "Kg-artikel",
            articleId: article.id,
            salesOrderRowId: orderRow!.id,
            quantity: 100,
            unitPrice: 60,
          },
        ],
      },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    const invoiceText = pdfText((await invoiceService.renderPdf(issued!.id)).content);
    const orderText = pdfText((await salesService.getSalesOrderPdf(order.id, "confirmation")).content);

    // Printed in the display unit (kg) — not the stored base quantity/price
    // (100 st / 60 kr).
    expect(invoiceText).toContain("500");
    expect(invoiceText).toContain("kg");
    expect(invoiceText).toContain(sv(12)); // à-pris, kr/kg
    expect(invoiceText).not.toContain(sv(60));

    // Same à-pris as the order confirmation for the same row.
    expect(orderText).toContain(sv(12));
  });

  it("renderPdf/sendEmail reject a draft invoice", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      user.id
    );
    await expect(invoiceService.renderPdf(draft!.id)).rejects.toThrow(InvalidStatusTransitionError);
    await expect(
      invoiceService.sendEmail(draft!.id, { to: "kund@example.com", subject: "Faktura", message: "Se bifogad faktura." })
    ).rejects.toThrow(InvalidStatusTransitionError);
  });

  it("prints the snapshot address, not the live customer, after the customer is edited", async () => {
    const customer = await salesService.createCustomer({
      name: "Ursprungsnamn AB",
      invoiceAddress: "Gamla vägen 1",
      invoicePostalCode: "111 11",
      invoiceCity: "Gamlastad",
      active: true,
    });
    const user = await makeUser();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    await salesService.updateCustomer(customer.id, {
      name: "Nya Namnet AB",
      invoiceAddress: "Nya vägen 2",
      invoiceCity: "Nystad",
    });

    const text = pdfText((await invoiceService.renderPdf(issued!.id)).content);
    expect(text).toContain("Ursprungsnamn AB");
    expect(text).toContain("111 11 Gamlastad");
    expect(text).not.toContain("Nya Namnet AB");
    expect(text).not.toContain("Nystad");
  });

  it("emails the invoice as a PDF attachment and logs it with documentType invoice and the invoice's own id", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "x", quantity: 1, unitPrice: 10 }] },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    await invoiceService.sendEmail(issued!.id, {
      to: "faktura@kund.se",
      subject: "Faktura",
      message: "Se bifogad faktura.",
    });

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.attachments?.[0]?.filename).toMatch(/^Faktura-FA-\d+\.pdf$/);

    const log = await mailService.listEmailLog({ documentType: "invoice", documentId: issued!.id, limit: 10, offset: 0 });
    expect(log.total).toBe(1);
  });
});

describe("customer invoice — customer number snapshot", () => {
  it("stamps the customer number at issue; a later renumbering does not change the invoice", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Tjänst", quantity: 1, unitPrice: 100 }] },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    const raw = await invoiceRepo.findRawById(issued!.id);
    expect(raw!.customerNumber).toBe(customer.customerNumber);

    // Renumber the customer — the issued invoice keeps the frozen snapshot.
    await salesService.updateCustomer(customer.id, { customerNumber: "NYTT-99" });
    const { content } = await invoiceService.renderPdf(issued!.id);
    expect(pdfText(content)).toContain(`Kundnr: ${raw!.customerNumber}`);
    expect(pdfText(content)).not.toContain("Kundnr: NYTT-99");
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

describe("customer invoice — audit trail", () => {
  it("logs issued under the new FA-number, row_added/row_updated/row_deleted while draft (with articleNumber resolved), and re-keys the draft-time rows to the FA-number at issue", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const article = await makeArticle();
    // create() itself is a one-shot batch insert (not routed through the
    // service's own addRow), so it deliberately does not emit row_added —
    // start from an empty draft and add the row through addRow to exercise it.
    const draft = await invoiceService.create({ customerId: customer.id, rows: [] }, user.id);
    await invoiceService.addRow(
      draft!.id,
      { articleId: article.id, description: "Tjänst", quantity: 1, unitPrice: 100 },
      user.id
    );

    const added = await auditRows("invoice", "row_added");
    expect(added).toHaveLength(1);
    // Still a draft — no FA number yet, falls back to the invoice's own id.
    expect(added[0]!.entityId).toBe(draft!.id);
    // MINOR fix: articleNumber resolved via the injected article reader,
    // not the raw articleId uuid.
    expect(added[0]!.detail).toMatchObject({ articleNumber: article.articleNumber });

    const withRow = (await invoiceService.getInvoice(draft!.id))!;
    const rowId = withRow.rows[0]!.id;
    await invoiceService.updateRow(draft!.id, rowId, { quantity: 2 }, user.id);
    const updated = await auditRows("invoice", "row_updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]!.detail).toMatchObject({
      articleNumber: article.articleNumber,
      before: { quantity: "1.0000" },
      after: { quantity: "2.0000" },
    });

    await invoiceService.deleteRow(draft!.id, rowId, user.id);
    const deleted = await auditRows("invoice", "row_deleted");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.detail).toMatchObject({ articleNumber: article.articleNumber });

    // Re-add a row so the invoice isn't empty at issue.
    await invoiceService.addRow(
      draft!.id,
      { articleId: article.id, description: "Tjänst 2", quantity: 1, unitPrice: 50 },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);

    const issuedLog = await auditRows("invoice", "issued");
    expect(issuedLog).toHaveLength(1);
    expect(issuedLog[0]!.entityId).toBe(issued!.invoiceNumber);
    expect(issuedLog[0]!.userId).toBe(issuedBy);

    // IMPORTANT fix: the draft-time events (2× row_added, row_updated,
    // row_deleted) must be re-keyed to the invoiceNumber at issue — exactly
    // what the card's Historik queries by (entityType=invoice&entityId=<FA>),
    // otherwise they'd be orphaned under the invoice's now-irrelevant uuid.
    const allUnderInvoiceNumber = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "invoice"), eq(auditLog.entityId, issued!.invoiceNumber!)));
    expect(allUnderInvoiceNumber.map((r) => r.action).sort()).toEqual(
      ["issued", "row_added", "row_added", "row_deleted", "row_updated"].sort()
    );
    // Nothing left behind under the old uuid.
    const orphanedUnderUuid = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "invoice"), eq(auditLog.entityId, draft!.id)));
    expect(orphanedUnderUuid).toHaveLength(0);
  });

  it("logs cancelled (draft, falls back to uuid) and credit_created under the source invoice", async () => {
    const user = await makeUser();
    const customer = await makeCustomer();
    const toCancel = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "X", quantity: 1, unitPrice: 10 }] },
      user.id
    );
    await invoiceService.cancel(toCancel!.id, user.id);
    const cancelled = await auditRows("invoice", "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]!.entityId).toBe(toCancel!.id);

    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Y", quantity: 1, unitPrice: 10 }] },
      user.id
    );
    const issued = await invoiceService.issue(draft!.id, issuedBy);
    const credit = await invoiceService.createCredit(issued!.id, {}, issuedBy);

    const creditCreated = await auditRows("invoice", "credit_created");
    expect(creditCreated).toHaveLength(1);
    expect(creditCreated[0]!.entityId).toBe(issued!.invoiceNumber);
    expect(creditCreated[0]!.detail).toMatchObject({ creditInvoiceId: credit!.id });
  });

  it("logs reminder_sent", async () => {
    const { order, row, user } = await makeDeliveredOrderRow({});
    const invoice = await invoiceService.create(
      { customerId: order.customerId, rows: [{ salesOrderRowId: row.id, articleId: row.articleId, description: "X", quantity: Number(row.quantityDelivered), unitPrice: 100 }] },
      user.id
    );
    const issued = await invoiceService.issue(invoice!.id, issuedBy);
    await invoiceService.sendReminder(
      issued!.id,
      { to: "kund@example.com", subject: "Påminnelse", message: "Betala nu", withFee: false },
      issuedBy
    );

    const reminders = await auditRows("invoice", "reminder_sent");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.entityId).toBe(issued!.invoiceNumber);
    expect(reminders[0]!.detail).toMatchObject({ level: 1, fee: 0 });
  });
});
