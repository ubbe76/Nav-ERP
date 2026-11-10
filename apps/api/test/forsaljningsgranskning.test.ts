import {
  createArticleSchema,
  createContactSchema,
  createCreditInvoiceSchema,
  createCustomerSchema,
  createDeliveryAddressSchema,
  createInvoiceRowSchema,
  createInvoiceSchema,
  createPaymentSchema,
  createQuoteSchema,
  createSalesOrderRowSchema,
  createStockLocationSchema,
  deliverBatchSchema,
  deliverGoodsSchema,
  round4,
  runCollectiveInvoicingSchema,
  updateContactSchema,
  updateDeliveryAddressSchema,
  updateInvoiceRowSchema,
  updateSalesOrderRowSchema,
} from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  customerContacts,
  customerDeliveryAddresses,
  db,
  deliveryRows,
  invoiceReminders,
  invoiceRows,
  invoices,
  referenceRates,
  salesOrderRows,
  salesOrders,
  stockTransactions,
  type Tx,
} from "@navet/db";
import { buildApp } from "../src/app.js";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createMailRepository } from "../src/modules/mail/repository/mail.repository.js";
import { createMailService } from "../src/modules/mail/service/mail.service.js";
import { createRegisterRepository } from "../src/modules/register/repository/register.repository.js";
import { createRegisterService } from "../src/modules/register/service/register.service.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createPaymentRepository } from "../src/modules/sales/repository/payment.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import {
  createInvoiceService,
  CreditExceedsInvoiceError,
  OverCreditError,
  OverInvoicingError,
} from "../src/modules/sales/service/invoice.service.js";
import { capitalPayments, lateInterest } from "../src/modules/sales/service/late-interest.js";
import { createLateInterestService } from "../src/modules/sales/service/late-interest.service.js";
import { createPaymentService } from "../src/modules/sales/service/payment.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import {
  ContactNotFoundError,
  createSalesService,
  DeliveryAddressNotFoundError,
  InvalidStatusTransitionError,
  RowHasDeliveriesError,
  RowHasInvoiceRowsError,
} from "../src/modules/sales/service/sales.service.js";
import { createStockRepository } from "../src/modules/stock/repository/stock.repository.js";
import { createStockService } from "../src/modules/stock/service/stock.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { referenceRatesFor } from "../src/modules/system/repository/reference-rates.js";
import {
  DEFAULT_POSTING_SETTINGS,
  POSTING_BASELINE_YEAR,
  setupPostingBaseline,
  testDocumentPdfService,
  testSystemService,
} from "./helpers/services.js";
import { parsed } from "./helpers/parsed.js";
import { waitForLockWaiter } from "./helpers/year-end.js";

// Försäljningsgranskningen 2026-11-10: the float edge of the invoicing
// guards, order rows with history, credit notes that exceed their invoice,
// the lock order of Utfärda, unknown ids that became 500s, a primary/default
// demoted on the way to a 404, delivery addresses that changed under their
// orders, the unlocked status reads and the påminnelseavgift before capital.

const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const auditRepository = createAuditRepository(db);
const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db), auditRepository);
const authRepo = createAuthRepository(db);
const mailService = createMailService(createMailRepository(db), testSystemService, () => ({ async sendMail() {} }));
const salesService = createSalesService(
  createSalesRepository(db),
  createRegisterService(createRegisterRepository(db)),
  mailService,
  testDocumentPdfService,
  stockService,
  articleService,
  testSystemService,
  (query) => resolvePrice(db, query),
  auditRepository
);
const poster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
const invoiceRepo = createInvoiceRepository(db);
const invoiceService = createInvoiceService(invoiceRepo, mailService, testDocumentPdfService, poster, auditRepository, articleService);
const paymentService = createPaymentService(createPaymentRepository(db), poster);

const TABLES = sql`TRUNCATE late_interest_charges, reference_rates, posting_rules, verification_rows, verifications, verification_counters,
  verification_series, accounting_periods, fiscal_years, accounts, customer_payment_rows, customer_payments, invoice_reminders,
  invoice_documents, invoice_rows, invoices, shipment_deliveries, shipments, audit_log, email_log, delivery_rows, deliveries,
  sales_order_rows, sales_orders, customer_contacts, customer_delivery_addresses, customers, payment_terms, stock_transactions,
  stock_locations, warehouses, bom_components, articles, users CASCADE`;

let user: { id: string };

beforeEach(async () => {
  await db.execute(TABLES);
  await setupPostingBaseline();
  user = await authRepo.create({ email: `salj-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Säljare", role: "admin" });
});
afterAll(async () => {
  await db.execute(TABLES);
});

// The real app for the route envelopes (status + code), with a session.
const app = buildApp();
const authService = createAuthService(authRepo, "unused", auditRepository);
beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
async function session() {
  const email = `salj-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: "correcthorse", name: "Säljare", role: "admin", permissionGroupId: null });
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: "correcthorse" } });
  return { cookie: `session=${login.cookies.find((c) => c.name === "session")!.value}` };
}

async function customer(opts: { name?: string; collectiveInvoicing?: boolean } = {}) {
  return salesService.createCustomer(
    parsed(createCustomerSchema, { name: opts.name ?? "Kund AB", active: true, collectiveInvoicing: opts.collectiveInvoicing ?? false })
  );
}

async function article() {
  return articleService.createArticle(
    parsed(createArticleSchema, { articleNumber: `ART-${crypto.randomUUID().slice(0, 8)}`, name: "Artikel", type: "purchased", active: true })
  );
}

let locationSeq = 0;
async function stockedArticle(quantity: number) {
  const a = await article();
  locationSeq += 1;
  const warehouse = await stockService.createWarehouse({ name: `Lager ${locationSeq}-${crypto.randomUUID().slice(0, 6)}`, active: true });
  const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
  await stockService.recordTransaction({ articleId: a.id, locationId: location.id, quantityDelta: quantity, transactionType: "inventory_adjustment" });
  return { article: a, location };
}

// A confirmed order (Under tillverkning unless `confirmedOnly`) with one row
// per given quantity, each on its own stocked article.
async function order(quantities: number[], opts: { customerId?: string; confirmedOnly?: boolean; deliveryAddressId?: string } = {}) {
  const customerId = opts.customerId ?? (await customer()).id;
  const stocked: Awaited<ReturnType<typeof stockedArticle>>[] = [];
  for (const quantity of quantities) stocked.push(await stockedArticle(quantity + 10));
  const created = await salesService.createQuote(
    parsed(createQuoteSchema, {
      customerId,
      confirm: true,
      ...(opts.deliveryAddressId ? { deliveryAddressId: opts.deliveryAddressId } : {}),
      rows: quantities.map((quantity, i) => ({ articleId: stocked[i]!.article.id, quantity, unitPrice: 100 })),
    }),
    user.id
  );
  if (!opts.confirmedOnly) await salesService.startProduction(created.order.id);
  // createQuote answers the rows in the request's order.
  const rows = created.rows.map((row, i) => ({ ...row, location: stocked[i]!.location }));
  return { customerId, order: created.order, rows };
}

// One order row with `delivered` of `ordered` delivered.
async function deliveredRow(ordered: number, delivered: number, opts: { customerId?: string } = {}) {
  const f = await order([ordered], opts);
  const row = f.rows[0]!;
  const delivery = await salesService.deliverGoods(
    f.order.id,
    row.id,
    parsed(deliverGoodsSchema, { locationId: row.location.id, quantity: delivered }),
    user.id
  );
  return { ...f, row, deliveryId: delivery!.deliveryId };
}

function linkedRow(row: { id: string; articleId: string }, quantity: number) {
  return { description: "Leverans", articleId: row.articleId, salesOrderRowId: row.id, quantity, unitPrice: 100 };
}

async function draft(customerId: string, rows: ReturnType<typeof linkedRow>[]) {
  const invoice = await invoiceService.create(parsed(createInvoiceSchema, { customerId, rows }), user.id);
  return invoice!;
}

// An issued invoice with one free row (no order row): 3 × 100 + 25 % = 375.
async function freeInvoice() {
  const c = await customer();
  const created = await invoiceService.create(
    parsed(createInvoiceSchema, { customerId: c.id, rows: [{ description: "Konsulttimmar", quantity: 3, unitPrice: 100, vatRate: 25 }] }),
    user.id
  );
  const issued = (await invoiceService.issue(created!.id, user.id))!;
  return { customer: c, invoice: issued, sourceRowId: issued.rows[0]!.id };
}

async function invoiceStatus(id: string) {
  const [row] = await db.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, id));
  return row!.status;
}

async function orderStatus(id: string) {
  const [row] = await db.select({ status: salesOrders.status }).from(salesOrders).where(eq(salesOrders.id, id));
  return row!.status;
}

// Runs `action` while another transaction holds the locks `lock` took, and
// lets that transaction commit once `action` is waiting on them — the
// deterministic shape of "someone else committed between the service's read
// and its write". `beforeCommit` runs in the holder once `action` waits.
async function whileHolding<T>(lock: (tx: Tx) => Promise<unknown>, action: () => Promise<T>, beforeCommit?: (tx: Tx) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const hasLocks = new Promise<void>((resolve) => (locked = resolve));
  const holder = db.transaction(async (tx) => {
    await lock(tx);
    locked();
    await gate;
    await beforeCommit?.(tx);
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

const setOrderStatus = (orderId: string, status: "cancelled" | "delivered") => async (tx: Tx) => {
  await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, orderId)).for("update");
  await tx.update(salesOrders).set({ status }).where(eq(salesOrders.id, orderId));
};

describe("A1 — fakturavakterna jämför i fyra decimaler", () => {
  // The sums are added as JS numbers: 0.1 + 0.2 = 0.30000000000000004, which
  // "exceeded" the 0.3 delivered — at create (resolveRow) and at Utfärda.
  it("0,1 and then 0,2 of 0,3 delivered are invoiced and issued", async () => {
    expect(round4(0.1 + 0.2)).toBe(0.3);
    const f = await deliveredRow(1, 0.3);
    const first = await draft(f.customerId, [linkedRow(f.row, 0.1)]);
    await invoiceService.issue(first.id, user.id);
    const second = await draft(f.customerId, [linkedRow(f.row, 0.2)]);
    const issued = await invoiceService.issue(second.id, user.id);
    expect(issued!.status).toBe("issued");
  });

  // 0.3 − 0.1 − 0.2 = −2.8e-17 in floats: "below zero".
  it("0,1 + 0,2 on two rows credit an invoice of 0,3 in full", async () => {
    const f = await deliveredRow(1, 0.3);
    const invoice = await draft(f.customerId, [linkedRow(f.row, 0.3)]);
    await invoiceService.issue(invoice.id, user.id);
    const credit = await invoiceService.createCredit(
      invoice.id,
      parsed(createCreditInvoiceSchema, { rows: [linkedRow(f.row, 0.1), linkedRow(f.row, 0.2)] }),
      user.id
    );
    const issued = await invoiceService.issue(credit!.id, user.id);
    expect(issued!.status).toBe("issued");
  });

  // The rest 0.9 − 0.3 = 0.6000000000000001 was billed as is and refused by
  // the guard: the customer's samlingsfaktura "failed".
  it("samlingsfaktureringen bills the rest 0,6 of 0,9 delivered", async () => {
    const c = await customer({ collectiveInvoicing: true });
    const f = await deliveredRow(0.9, 0.9, { customerId: c.id });
    const part = await invoiceService.create(parsed(createInvoiceSchema, { customerId: c.id, rows: [linkedRow(f.row, 0.3)] }), user.id, {
      collective: true,
    });
    await invoiceService.issue(part!.id, user.id);

    const [candidate] = await invoiceService.listCollectiveInvoicingCandidates();
    expect(candidate).toMatchObject({ customerId: c.id, rowCount: 1, netAmount: 60 });
    const { results } = await invoiceService.runCollectiveInvoicing(parsed(runCollectiveInvoicingSchema, { customerIds: [c.id], issue: true }), user.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "issued", error: null, rowCount: 1 });
    const rest = await db.select({ quantity: invoiceRows.quantity }).from(invoiceRows).where(eq(invoiceRows.invoiceId, results[0]!.invoiceId!));
    expect(rest.map((r) => r.quantity)).toEqual(["0.6000"]);
    expect(await orderStatus(f.order.id)).toBe("invoiced");
  });

  it("a real over-invoice (0,4 of 0,3) and a real over-credit are still refused", async () => {
    const f = await deliveredRow(1, 0.3);
    await expect(draft(f.customerId, [linkedRow(f.row, 0.4)])).rejects.toBeInstanceOf(OverInvoicingError);
    const first = await draft(f.customerId, [linkedRow(f.row, 0.1)]);
    await invoiceService.issue(first.id, user.id);
    await expect(draft(f.customerId, [linkedRow(f.row, 0.2001)])).rejects.toBeInstanceOf(OverInvoicingError);
    await expect(
      invoiceService.createCredit(first.id, parsed(createCreditInvoiceSchema, { rows: [linkedRow(f.row, 0.1001)] }), user.id)
    ).rejects.toBeInstanceOf(OverCreditError);
    // Two drafts of 0.2 each pass create (drafts of the other are not
    // committed quantity for Utfärda); the second Utfärda is the over-invoice.
    const a = await draft(f.customerId, [linkedRow(f.row, 0.2)]);
    await db.update(invoiceRows).set({ quantity: "0.2001" }).where(eq(invoiceRows.invoiceId, a.id));
    await expect(invoiceService.issue(a.id, user.id)).rejects.toBeInstanceOf(OverInvoicingError);
  });
});

describe("A2 — en orderrad med historik tas inte bort", () => {
  // A free row on a cancelled draft, linked to the order row directly: the
  // service only bills delivered quantity, and a delivery would be the
  // delivery history the guard reports first.
  async function cancelledDraftOn(customerId: string, rowId: string) {
    const created = await invoiceService.create(
      parsed(createInvoiceSchema, { customerId, rows: [{ description: "Rad", quantity: 1, unitPrice: 100 }] }),
      user.id
    );
    await db.update(invoiceRows).set({ salesOrderRowId: rowId }).where(eq(invoiceRows.invoiceId, created!.id));
    await invoiceService.cancel(created!.id, user.id);
  }

  async function undoneDelivery() {
    const f = await deliveredRow(5, 5);
    const [deliveryRow] = await db.select().from(deliveryRows).where(eq(deliveryRows.deliveryId, f.deliveryId));
    await salesService.undoDeliveryRow(f.order.id, f.deliveryId, deliveryRow!.id, user.id);
    return f;
  }

  // quantity_delivered is 0 again, but delivery_rows keeps the undone row:
  // its restrict FK answered a bare 23503 (500).
  it("a delivered and undone row is refused with RowHasDeliveriesError", async () => {
    const f = await undoneDelivery();
    const [row] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, f.row.id));
    expect(Number(row!.quantityDelivered)).toBe(0);
    await expect(salesService.deleteRow(f.order.id, f.row.id, false, user.id)).rejects.toBeInstanceOf(RowHasDeliveriesError);
    expect(await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, f.row.id))).toHaveLength(1);
  });

  it("a row on a cancelled invoice draft is refused with RowHasInvoiceRowsError", async () => {
    const f = await order([5]);
    await cancelledDraftOn(f.customerId, f.rows[0]!.id);
    await expect(salesService.deleteRow(f.order.id, f.rows[0]!.id, false, user.id)).rejects.toBeInstanceOf(RowHasInvoiceRowsError);
    expect(await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, f.rows[0]!.id))).toHaveLength(1);
  });

  it("the route answers 409 row-has-deliveries and 409 row-has-invoice-rows", async () => {
    const headers = await session();
    const undone = await undoneDelivery();
    const delivered = await app.inject({ method: "DELETE", url: `/api/v1/sales-orders/${undone.order.id}/rows/${undone.row.id}`, headers });
    expect([delivered.statusCode, delivered.json().code]).toEqual([409, "row-has-deliveries"]);

    const f = await order([5]);
    await cancelledDraftOn(f.customerId, f.rows[0]!.id);
    const invoiced = await app.inject({ method: "DELETE", url: `/api/v1/sales-orders/${f.order.id}/rows/${f.rows[0]!.id}`, headers });
    expect([invoiced.statusCode, invoiced.json().code]).toEqual([409, "row-has-invoice-rows"]);
  });

  // The row's Ställkostnad went with it "while undelivered" — and that
  // DELETE hit the same restrict FK when the ställkostnadsrad had history.
  it("the main row goes, its ställkostnadsrad with history stays as a plain row", async () => {
    const f = await order([5, 1]);
    const [main, setup] = f.rows;
    await db.update(salesOrderRows).set({ setupForRowId: main!.id }).where(eq(salesOrderRows.id, setup!.id));
    await cancelledDraftOn(f.customerId, setup!.id);

    await salesService.deleteRow(f.order.id, main!.id, false, user.id);
    const left = await db.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, f.order.id));
    expect(left.map((r) => [r.id, r.setupForRowId])).toEqual([[setup!.id, null]]);
  });

  it("a ställkostnadsrad without history still goes with its row", async () => {
    const f = await order([5, 1]);
    const [main, setup] = f.rows;
    await db.update(salesOrderRows).set({ setupForRowId: main!.id }).where(eq(salesOrderRows.id, setup!.id));
    await salesService.deleteRow(f.order.id, main!.id, false, user.id);
    expect(await db.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, f.order.id))).toHaveLength(0);
  });
});

describe("A3 — kreditfakturorna överstiger aldrig fakturan", () => {
  // The quantity guard only sees rows linked to an order row: a free row
  // (a räntefaktura, freight) could be credited in full twice.
  it("the second full credit of a free row is refused at Utfärda and stays a draft", async () => {
    const f = await freeInvoice();
    const first = await invoiceService.createCredit(f.invoice.id, parsed(createCreditInvoiceSchema, {}), user.id);
    const second = await invoiceService.createCredit(f.invoice.id, parsed(createCreditInvoiceSchema, {}), user.id);
    const issued = await invoiceService.issue(first!.id, user.id);
    expect(issued!.status).toBe("issued");
    await expect(invoiceService.issue(second!.id, user.id)).rejects.toBeInstanceOf(CreditExceedsInvoiceError);
    expect(await invoiceStatus(second!.id)).toBe("draft");
  });

  it("the route answers 409 credit-exceeds-invoice", async () => {
    const headers = await session();
    const f = await freeInvoice();
    const first = await invoiceService.createCredit(f.invoice.id, parsed(createCreditInvoiceSchema, {}), user.id);
    const second = await invoiceService.createCredit(f.invoice.id, parsed(createCreditInvoiceSchema, {}), user.id);
    await invoiceService.issue(first!.id, user.id);
    const res = await app.inject({ method: "POST", url: `/api/v1/invoices/${second!.id}/issue`, headers });
    expect([res.statusCode, res.json().code]).toEqual([409, "credit-exceeds-invoice"]);
    expect(await invoiceStatus(second!.id)).toBe("draft");
  });

  it("a partial credit and the rest go through exactly to the amount — one öre more does not", async () => {
    const f = await freeInvoice();
    const part = (quantity: number, unitPrice = 100) =>
      invoiceService.createCredit(
        f.invoice.id,
        parsed(createCreditInvoiceSchema, { rows: [{ sourceRowId: f.sourceRowId, description: "Konsulttimmar", quantity, unitPrice }] }),
        user.id
      );
    const one = await part(1);
    const rest = await part(2);
    const extra = await part(1, 0.01);
    expect((await invoiceService.issue(one!.id, user.id))!.status).toBe("issued");
    expect((await invoiceService.issue(rest!.id, user.id))!.status).toBe("issued");
    await expect(invoiceService.issue(extra!.id, user.id)).rejects.toBeInstanceOf(CreditExceedsInvoiceError);
  });

  // Both read "nothing credited yet" unless the source invoice serializes them.
  it("two credit drafts of one invoice issued at once: exactly one is issued", async () => {
    const f = await freeInvoice();
    const first = await invoiceService.createCredit(f.invoice.id, parsed(createCreditInvoiceSchema, {}), user.id);
    const second = await invoiceService.createCredit(f.invoice.id, parsed(createCreditInvoiceSchema, {}), user.id);
    const racing = await whileHolding(
      (tx) => tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, f.invoice.id)).for("update"),
      () => Promise.allSettled([invoiceService.issue(first!.id, user.id), invoiceService.issue(second!.id, user.id)])
    );
    expect(racing.ok).toBe(true);
    const results = racing.ok ? racing.value : [];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(CreditExceedsInvoiceError);
    expect([await invoiceStatus(first!.id), await invoiceStatus(second!.id)].sort()).toEqual(["draft", "issued"]);
  });
});

describe("A9 — Utfärda låser fakturan först", () => {
  // Utfärda validated the rows and only then took the invoice (its UPDATE):
  // a row change committing in between was issued unvalidated. The holder is
  // that row change — it holds the draft's lock, as updateRow does.
  it("waits for a row change in progress and validates with it", async () => {
    const f = await deliveredRow(1, 0.3);
    const invoice = await draft(f.customerId, [linkedRow(f.row, 0.3)]);
    const issuing = await whileHolding(
      async (tx) => {
        await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, invoice.id)).for("update");
        await tx.update(invoiceRows).set({ quantity: "0.4" }).where(eq(invoiceRows.invoiceId, invoice.id));
      },
      () => invoiceService.issue(invoice.id, user.id)
    );
    expect(!issuing.ok && issuing.error).toBeInstanceOf(OverInvoicingError);
    expect(await invoiceStatus(invoice.id)).toBe("draft");
  });

  // The other side (the draft's lock in addRow/updateRow predates the
  // review): a row write that waited for Utfärda changes nothing.
  it("a row added or changed while Utfärda commits is refused", async () => {
    const f = await deliveredRow(1, 0.3);
    const invoice = await draft(f.customerId, [linkedRow(f.row, 0.2)]);
    const rowId = invoice.rows[0]!.id;
    const issued = async (tx: Tx) => {
      await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, invoice.id)).for("update");
      await tx.update(invoices).set({ status: "issued" }).where(eq(invoices.id, invoice.id));
    };
    const adding = await whileHolding(issued, () =>
      invoiceService.addRow(invoice.id, parsed(createInvoiceRowSchema, { description: "Sen rad", quantity: 1, unitPrice: 100 }), user.id)
    );
    expect(!adding.ok && adding.error).toBeInstanceOf(InvalidStatusTransitionError);

    await db.update(invoices).set({ status: "draft" }).where(eq(invoices.id, invoice.id));
    const changing = await whileHolding(issued, () =>
      invoiceService.updateRow(invoice.id, rowId, parsed(updateInvoiceRowSchema, { quantity: 0.1 }), user.id)
    );
    // Refused — today as InvoiceRowNotFoundError (the service's reading of
    // the repository's null), so only the outcome is pinned here.
    expect(changing.ok).toBe(false);
    const rows = await db.select({ id: invoiceRows.id, quantity: invoiceRows.quantity }).from(invoiceRows).where(eq(invoiceRows.invoiceId, invoice.id));
    expect(rows).toEqual([{ id: rowId, quantity: "0.2000" }]);
  });
});

describe("A4 — okänd kund eller artikel är 404, inte 500", () => {
  // The FK answered: POST /quotes is the external API's entry point.
  it("POST /quotes with an unknown customer or an unknown row article", async () => {
    const headers = await session();
    const c = await customer();
    const a = await article();
    const row = { articleId: a.id, quantity: 1, unitPrice: 10 };
    const noCustomer = await app.inject({ method: "POST", url: "/api/v1/quotes", headers, payload: { customerId: crypto.randomUUID(), rows: [row] } });
    expect([noCustomer.statusCode, noCustomer.json().code]).toEqual([404, "customer-not-found"]);
    const noArticle = await app.inject({
      method: "POST",
      url: "/api/v1/quotes",
      headers,
      payload: { customerId: c.id, rows: [row, { ...row, articleId: crypto.randomUUID() }] },
    });
    expect([noArticle.statusCode, noArticle.json().code]).toEqual([404, "article-not-found"]);
    expect(await db.select().from(salesOrders)).toHaveLength(0);
  });

  it("POST /sales-orders/:id/rows with an unknown article", async () => {
    const headers = await session();
    const f = await order([5], { confirmedOnly: true });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/sales-orders/${f.order.id}/rows`,
      headers,
      payload: { articleId: crypto.randomUUID(), quantity: 1, unitPrice: 10 },
    });
    expect([res.statusCode, res.json().code]).toEqual([404, "article-not-found"]);
    expect(await db.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, f.order.id))).toHaveLength(1);
  });
});

describe("A5 — ett okänt id tar inte bort huvudvalet", () => {
  // The demotion ran before the UPDATE that found no row, and committed.
  it("huvudkontakt survives a PATCH of an unknown contact — and a real switch still works", async () => {
    const c = await customer();
    const anna = await salesService.createCustomerContact(c.id, parsed(createContactSchema, { name: "Anna", isPrimary: true }));
    const bo = await salesService.createCustomerContact(c.id, parsed(createContactSchema, { name: "Bo" }));
    await expect(salesService.updateCustomerContact(c.id, UNKNOWN, parsed(updateContactSchema, { isPrimary: true }))).rejects.toBeInstanceOf(
      ContactNotFoundError
    );
    const primaries = async () =>
      (await db.select().from(customerContacts).where(eq(customerContacts.customerId, c.id))).filter((r) => r.isPrimary).map((r) => r.id);
    expect(await primaries()).toEqual([anna.id]);
    // Another customer's contact is unknown here too.
    const other = await customer({ name: "Annan AB" });
    await expect(salesService.updateCustomerContact(other.id, bo.id, parsed(updateContactSchema, { isPrimary: true }))).rejects.toBeInstanceOf(
      ContactNotFoundError
    );
    expect(await primaries()).toEqual([anna.id]);
    await salesService.updateCustomerContact(c.id, bo.id, parsed(updateContactSchema, { isPrimary: true }));
    expect(await primaries()).toEqual([bo.id]);
  });

  it("the default delivery address survives a PATCH of an unknown address and of an engångsadress", async () => {
    const c = await customer();
    const first = await salesService.createDeliveryAddress(c.id, parsed(createDeliveryAddressSchema, { label: "Lager", address: "Gatan 1", isDefault: true }));
    const other = await salesService.createDeliveryAddress(c.id, parsed(createDeliveryAddressSchema, { label: "Fabrik", address: "Gatan 2" }));
    const a = await article();
    const quote = await salesService.createQuote(
      parsed(createQuoteSchema, {
        customerId: c.id,
        newDeliveryAddress: { label: "Bygget", address: "Byggvägen 3" },
        rows: [{ articleId: a.id, quantity: 1, unitPrice: 10 }],
      }),
      user.id
    );
    const oneOffId = quote.order.deliveryAddressId!;
    const [oneOff] = await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.id, oneOffId));
    expect(oneOff!.oneOff).toBe(true);

    const makeDefault = parsed(updateDeliveryAddressSchema, { isDefault: true });
    await expect(salesService.updateDeliveryAddress(c.id, UNKNOWN, makeDefault)).rejects.toBeInstanceOf(DeliveryAddressNotFoundError);
    await expect(salesService.updateDeliveryAddress(c.id, oneOffId, makeDefault)).rejects.toBeInstanceOf(DeliveryAddressNotFoundError);
    const defaults = async () =>
      (await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.customerId, c.id))).filter((r) => r.isDefault).map((r) => r.id);
    expect(await defaults()).toEqual([first.id]);
    await salesService.updateDeliveryAddress(c.id, other.id, makeDefault);
    expect(await defaults()).toEqual([other.id]);
  });
});

describe("A6 — leveransadressen ändras och tas bort utan att ordrarna flyttar", () => {
  async function addressWithOrders() {
    const c = await customer();
    const address = await salesService.createDeliveryAddress(
      c.id,
      parsed(createDeliveryAddressSchema, { label: "Lager", address: "Gamla gatan 1", postalCode: "111 11", city: "Gammelstad" })
    );
    const first = await order([1], { customerId: c.id, confirmedOnly: true, deliveryAddressId: address.id });
    const second = await order([1], { customerId: c.id, confirmedOnly: true, deliveryAddressId: address.id });
    return { customer: c, address, orderIds: [first.order.id, second.order.id] };
  }

  async function addressesOf(orderIds: string[]) {
    const orders = await db
      .select({ id: salesOrders.id, deliveryAddressId: salesOrders.deliveryAddressId, revision: salesOrders.revision })
      .from(salesOrders)
      .where(inArray(salesOrders.id, orderIds));
    const out = [];
    for (const id of orderIds) {
      const o = orders.find((row) => row.id === id)!;
      const [address] = o.deliveryAddressId
        ? await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.id, o.deliveryAddressId))
        : [];
      out.push({ order: o, address: address ?? null });
    }
    return out;
  }

  const OLD = { label: "Lager", address: "Gamla gatan 1", postalCode: "111 11", city: "Gammelstad", country: "SE", oneOff: true, isDefault: false };

  it("the list carries orderCount", async () => {
    const f = await addressWithOrders();
    await salesService.createDeliveryAddress(f.customer.id, parsed(createDeliveryAddressSchema, { label: "Oanvänd", address: "Gatan 9" }));
    const list = await salesService.listDeliveryAddresses(f.customer.id);
    expect(list.map((a) => [a.label, a.orderCount])).toEqual([
      ["Lager", 2],
      ["Oanvänd", 0],
    ]);
  });

  // Ändra inte befintliga ordrar: one copy per order — an order that switches
  // address deletes its engångsadress, so a shared copy would vanish from
  // the other.
  it("keepOnOrders gives every order its own engångsadress with the old values", async () => {
    const f = await addressWithOrders();
    const updated = await salesService.updateDeliveryAddress(
      f.customer.id,
      f.address.id,
      parsed(updateDeliveryAddressSchema, { address: "Nya gatan 2", city: "Nystad", keepOnOrders: true })
    );
    expect(updated).toMatchObject({ id: f.address.id, address: "Nya gatan 2", city: "Nystad", oneOff: false });
    expect(updated).not.toHaveProperty("keepOnOrders");

    const after = await addressesOf(f.orderIds);
    for (const { address } of after) {
      expect(address).toMatchObject({ ...OLD, customerId: f.customer.id });
      expect(address!.id).not.toBe(f.address.id);
    }
    expect(after[0]!.address!.id).not.toBe(after[1]!.address!.id);
    const list = await salesService.listDeliveryAddresses(f.customer.id);
    expect(list.map((a) => [a.id, a.address, a.orderCount])).toEqual([[f.address.id, "Nya gatan 2", 0]]);
  });

  it("without keepOnOrders the orders follow the address, as before", async () => {
    const f = await addressWithOrders();
    await salesService.updateDeliveryAddress(f.customer.id, f.address.id, parsed(updateDeliveryAddressSchema, { address: "Nya gatan 2", keepOnOrders: false }));
    await salesService.updateDeliveryAddress(f.customer.id, f.address.id, parsed(updateDeliveryAddressSchema, { city: "Nystad" }));
    const after = await addressesOf(f.orderIds);
    expect(after.map((a) => [a.order.deliveryAddressId, a.address!.address, a.address!.city])).toEqual([
      [f.address.id, "Nya gatan 2", "Nystad"],
      [f.address.id, "Nya gatan 2", "Nystad"],
    ]);
    expect(await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.customerId, f.customer.id))).toHaveLength(1);
  });

  // The FK's set null moved the orders to the customer's own address.
  it("DELETE leaves every order with its own engångsadress, never null", async () => {
    const f = await addressWithOrders();
    await salesService.deleteDeliveryAddress(f.customer.id, f.address.id);
    expect(await salesService.listDeliveryAddresses(f.customer.id)).toEqual([]);
    const after = await addressesOf(f.orderIds);
    for (const { address } of after) expect(address).toMatchObject({ ...OLD, customerId: f.customer.id });
    expect(after[0]!.address!.id).not.toBe(after[1]!.address!.id);
    expect(await db.select().from(customerDeliveryAddresses).where(eq(customerDeliveryAddresses.id, f.address.id))).toHaveLength(0);
  });

  // A header PATCH holds its order's lock and then takes KEY SHARE on the
  // address it points the order at (the FK check). FOR UPDATE on the address
  // while detachOrdersFromAddress waits for that order would be a deadlock
  // (40P01); FOR NO KEY UPDATE lets the FK check through.
  it("an order header change in progress and keepOnOrders both finish", async () => {
    const f = await addressWithOrders();
    const orderId = f.orderIds[0]!;
    const updating = await whileHolding(
      (tx) => tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, orderId)).for("update"),
      () =>
        salesService.updateDeliveryAddress(f.customer.id, f.address.id, parsed(updateDeliveryAddressSchema, { address: "Nya gatan 2", keepOnOrders: true })),
      // Once the address change waits for the order: away from the address
      // and back to it, so the second UPDATE runs the FK check against it.
      async (tx) => {
        await tx.update(salesOrders).set({ deliveryAddressId: null }).where(eq(salesOrders.id, orderId));
        await tx.update(salesOrders).set({ deliveryAddressId: f.address.id }).where(eq(salesOrders.id, orderId));
      }
    );
    expect(updating.ok ? null : updating.error).toBeNull();
    const after = await addressesOf(f.orderIds);
    for (const { address } of after) expect(address).toMatchObject(OLD);
    expect((await salesService.listDeliveryAddresses(f.customer.id)).map((a) => [a.address, a.orderCount])).toEqual([["Nya gatan 2", 0]]);
  });
});

describe("A7 — orderns status läses om under låset", () => {
  // Starta tillverkning read "confirmed" and wrote "in_production" over a Makulera.
  it("startProduction does not revive an order that was cancelled meanwhile", async () => {
    const f = await order([5], { confirmedOnly: true });
    const starting = await whileHolding(setOrderStatus(f.order.id, "cancelled"), () => salesService.startProduction(f.order.id, user.id));
    expect(!starting.ok && starting.error).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await orderStatus(f.order.id)).toBe("cancelled");
  });

  // The service's status check is unlocked: the row landed on an order a
  // delivery had just made Levererad.
  it("addRow does not add a row to an order that became Levererad meanwhile", async () => {
    const f = await order([5]);
    const a = await article();
    const adding = await whileHolding(setOrderStatus(f.order.id, "delivered"), () =>
      salesService.addRow(f.order.id, parsed(createSalesOrderRowSchema, { articleId: a.id, quantity: 1, unitPrice: 10, bumpRevision: false }), user.id)
    );
    expect(!adding.ok && adding.error).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await db.select().from(salesOrderRows).where(eq(salesOrderRows.salesOrderId, f.order.id))).toHaveLength(1);
  });

  it("the row route answers 409 for the same race", async () => {
    const headers = await session();
    const f = await order([5]);
    const a = await article();
    const adding = await whileHolding(setOrderStatus(f.order.id, "delivered"), () =>
      app.inject({ method: "POST", url: `/api/v1/sales-orders/${f.order.id}/rows`, headers, payload: { articleId: a.id, quantity: 1, unitPrice: 10 } })
    );
    expect(adding.ok && adding.value.statusCode).toBe(409);
  });

  // deliverBatch read "in_production" unlocked and delivered on a Makulera.
  it("deliverBatch delivers nothing on an order that was cancelled meanwhile", async () => {
    const f = await order([5]);
    const row = f.rows[0]!;
    const movementsBefore = (await db.select().from(stockTransactions)).length;
    const delivering = await whileHolding(setOrderStatus(f.order.id, "cancelled"), () =>
      salesService.deliverBatch(f.order.id, parsed(deliverBatchSchema, { locationId: row.location.id, rows: [{ rowId: row.id, quantity: 5 }] }), user.id)
    );
    expect(!delivering.ok && delivering.error).toBeInstanceOf(InvalidStatusTransitionError);
    expect(await orderStatus(f.order.id)).toBe("cancelled");
    const [after] = await db.select().from(salesOrderRows).where(eq(salesOrderRows.id, row.id));
    expect(Number(after!.quantityDelivered)).toBe(0);
    expect(await db.select().from(stockTransactions)).toHaveLength(movementsBefore);
    expect(await db.select().from(deliveryRows)).toHaveLength(0);
  });

  // A row lowered to its delivered quantity and a delivery finishing the
  // other row each saw the other's row open: all delivered, status still
  // Under tillverkning.
  it("a row edit waits for a delivery of another row and sees it when it recomputes the status", async () => {
    const f = await order([5, 5]);
    const [a, b] = f.rows;
    await salesService.deliverGoods(f.order.id, b!.id, parsed(deliverGoodsSchema, { locationId: b!.location.id, quantity: 3 }), user.id);
    const editing = await whileHolding(
      // The delivery of the whole row A: row → order, like deliverBatch.
      async (tx) => {
        await tx.select({ id: salesOrderRows.id }).from(salesOrderRows).where(eq(salesOrderRows.id, a!.id)).for("update");
        await tx.select({ id: salesOrders.id }).from(salesOrders).where(eq(salesOrders.id, f.order.id)).for("update");
        await tx.update(salesOrderRows).set({ quantityDelivered: "5" }).where(eq(salesOrderRows.id, a!.id));
      },
      // An à-pris along: the chain does not price the row, so nothing but the
      // status recompute reads the order (bumpRevision: false likewise).
      () =>
        salesService.updateRow(
          f.order.id,
          b!.id,
          parsed(updateSalesOrderRowSchema, { quantity: 3, unitPrice: 100, discountPercent: 0, bumpRevision: false }),
          user.id
        )
    );
    expect(editing.ok ? null : editing.error).toBeNull();
    expect(await orderStatus(f.order.id)).toBe("delivered");
  });
});

describe("A8 — påminnelseavgiften betalas före kapitalet", () => {
  const Y = POSTING_BASELINE_YEAR;
  const day = (d: number) => `${Y}-09-${String(d).padStart(2, "0")}`;

  // Costs before capital (user decision): the open amount carries the fee,
  // so a payment of exactly the fee is not a payment of capital.
  it("a payment after the fee pays the fee; only the rest is a capital payment", () => {
    const fees = [{ date: day(5), amount: 60 }];
    expect(
      capitalPayments(
        [
          { date: day(10), amount: 60 },
          { date: `${Y}-10-10`, amount: 1000 },
        ],
        fees
      )
    ).toEqual([{ date: `${Y}-10-10`, amount: 1000 }]);
  });

  it("a payment on the fee's own day predates the fee and counts against the capital", () => {
    const fees = [{ date: day(5), amount: 60 }];
    expect(capitalPayments([{ date: day(5), amount: 60 }], fees)).toEqual([{ date: day(5), amount: 60 }]);
    expect(capitalPayments([{ date: day(4), amount: 60 }], fees)).toEqual([{ date: day(4), amount: 60 }]);
  });

  it("a payment larger than the fee is split, and the fee is only paid once", () => {
    const fees = [{ date: day(5), amount: 60 }];
    expect(
      capitalPayments(
        [
          { date: day(20), amount: 300 },
          { date: day(10), amount: 100 },
        ],
        fees
      )
    ).toEqual([
      { date: day(10), amount: 40 },
      { date: day(20), amount: 300 },
    ]);
    // Without a fee (or a fee of 0) the payments are untouched.
    expect(capitalPayments([{ date: day(10), amount: 100 }], [])).toEqual([{ date: day(10), amount: 100 }]);
    expect(capitalPayments([{ date: day(10), amount: 100 }], [{ date: day(5), amount: 0 }])).toEqual([{ date: day(10), amount: 100 }]);
  });

  describe("räntefaktureringens kandidat", () => {
    const DUE = day(1);
    const AS_OF = `${Y}-10-20`;
    const settings = {
      ...DEFAULT_POSTING_SETTINGS,
      reminderFee: 60,
      lateInterestEnabled: true,
      lateInterestMargin: 8,
      lateInterestMinAmount: 100,
      lateFeeEnabled: true,
    };
    const referenceRateReader = {
      async ensureReferenceRates(starts: string[]) {
        return new Map([...(await referenceRatesFor(db, starts))].map(([start, row]) => [start, row.rate] as const));
      },
    };
    const lateInterestService = createLateInterestService({
      db,
      invoiceRepo,
      invoices: { issue: (id, userId) => invoiceService.issue(id, userId) },
      referenceRates: referenceRateReader,
      // AS_OF may lie after the real today: never a "future date" here.
      today: () => `${Y}-12-31`,
    });

    beforeEach(async () => {
      await testSystemService.updateSettings(settings);
      await db.insert(referenceRates).values([
        { validFrom: `${Y}-01-01`, rate: "2", source: "riksbank" },
        { validFrom: `${Y}-07-01`, rate: "4", source: "riksbank" },
      ]);
    });
    afterAll(async () => {
      // system_settings survives the TRUNCATE and is shared with other files.
      await testSystemService.updateSettings({ ...settings, lateInterestEnabled: false, lateFeeEnabled: false });
    });

    // The 60 kr paid after the reminder took 60 kr off the capital: the
    // interest ran on 940 kr, and the 1000 kr "overpaid" it.
    it("interest runs on the whole 1000 kr until the capital itself is paid", async () => {
      const c = await customer();
      const created = await invoiceService.create(
        parsed(createInvoiceSchema, { customerId: c.id, rows: [{ description: "Leverans", quantity: 1, unitPrice: 800, vatRate: 25 }] }),
        user.id
      );
      const invoice = (await invoiceService.issue(created!.id, user.id))!;
      await db.update(invoices).set({ dueDate: DUE }).where(eq(invoices.id, invoice.id));
      // Påminnelse with the fee, sent 5 September (Stockholm).
      await db.insert(invoiceReminders).values({ invoiceId: invoice.id, level: 1, fee: "60", sentAt: new Date(`${day(5)}T10:00:00Z`), createdBy: user.id });
      const pay = (amount: number, paymentDate: string) =>
        paymentService.create(
          parsed(createPaymentSchema, { customerId: c.id, paymentDate, bankAccountNumber: "1930", amount, rows: [{ invoiceId: invoice.id, appliedAmount: amount }] }),
          user.id
        );
      await pay(60, day(10));
      const paidDay = `${Y}-10-11`;
      await pay(1000, paidDay);

      const { rows } = await lateInterestService.listCandidates({ asOf: AS_OF, includeUnpaid: true });
      expect(rows).toHaveLength(1);
      // 2 September – 11 October = 40 days at 4 + 8 %, on 1000 kr throughout.
      const expected = lateInterest({
        principal: 1000,
        dueDate: DUE,
        through: paidDay,
        payments: [{ date: paidDay, amount: 1000 }],
        rates: [{ validFrom: `${Y}-07-01`, rate: 4 }],
        margin: 8,
      });
      expect(expected.amount).toBe(13.15);
      expect(rows[0]).toMatchObject({
        invoiceId: invoice.id,
        principal: 1000,
        paidDate: paidDay,
        fromDate: day(2),
        toDate: paidDay,
        days: 40,
        interest: 13.15,
        // 450 − the påminnelseavgift already charged.
        fee: 390,
      });
    });
  });
});
