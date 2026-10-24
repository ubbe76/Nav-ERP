import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, db, einvoiceTransmissions, invoices } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService, InvoiceNotFoundError } from "../src/modules/sales/service/invoice.service.js";
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
import { createEinvoiceRepository } from "../src/modules/einvoice/repository/einvoice.repository.js";
import { createEinvoiceSettingsService } from "../src/modules/einvoice/service/einvoice-settings.service.js";
import { createEinvoiceService, resolveRecipient, blockedReasonFor } from "../src/modules/einvoice/service/einvoice.service.js";
import {
  createEinvoiceStatusService,
  DOCUMENT_GONE_MESSAGE,
  isStatusDue,
  STALE_DRAFT_MESSAGE,
  STALE_SENDING_MESSAGE,
  STATUS_LEASE_MS,
} from "../src/modules/einvoice/service/einvoice-status.service.js";
import { PROVIDER_STATE_MAP } from "../src/modules/einvoice/service/einvoice-status.js";
import {
  EinvoiceAlreadySentError,
  EinvoiceDocumentInvalidError,
  EinvoiceNotAllowedError,
  EinvoiceNotConfiguredError,
  EinvoiceProviderRejectedError,
  EinvoiceProviderUnavailableError,
} from "../src/modules/einvoice/service/einvoice.errors.js";
import { EInvoiceProviderError } from "../src/modules/einvoice/service/einvoice-provider.js";
import { createFakeEinvoiceProvider, refused, unavailable } from "./helpers/fake-einvoice-provider.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";

// E-faktura (Peppol) — the service against Postgres with a fake access point
// (spec §6): every guard of the send flow, the insert-before-call order, one
// live transmission per invoice, failure modes, and the status job.

const articleService = createArticleService(createArticleRepository(db));
const stockService = createStockService(createStockRepository(db));
const authRepo = createAuthRepository(db);
const registerService = createRegisterService(createRegisterRepository(db));
const systemService = createSystemService(createSystemRepository(db));
const mailService = createMailService(createMailRepository(db), systemService, () => ({ async sendMail() {} }));
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
const invoicePoster = createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) });
const invoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  documentPdfService,
  invoicePoster,
  { log: async () => {} },
  articleService
);

const auditRepository = createAuditRepository(db);
const repo = createEinvoiceRepository(db);
const fake = createFakeEinvoiceProvider();
let clock = new Date("2030-03-04T09:00:00Z");
const now = () => clock;
const settings = createEinvoiceSettingsService({ repo, company: systemService, audit: auditRepository, providerFactory: fake.factory });
const einvoice = createEinvoiceService({
  repo,
  settings,
  invoices: {
    getInvoice: (id) => invoiceService.getInvoice(id),
    archivedInvoicePdf: (id) => invoiceService.renderPdf(id),
    findCustomerById: (id) => salesService.getCustomer(id),
  },
  company: systemService,
  audit: auditRepository,
  now,
  log: (msg) => serviceLogged.push(msg),
});
const serviceLogged: string[] = [];
const logged: string[] = [];
const status = createEinvoiceStatusService({ repo, settings, audit: auditRepository, now, log: (msg) => logged.push(msg) });

const TRUNCATE = sql`TRUNCATE einvoice_transmissions, invoice_documents, posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_rows, invoices, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

let userId: string;

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'einvoice_%'`);
  await setupPostingBaseline();
  clock = new Date("2030-03-04T09:00:00Z");
  logged.length = 0;
  serviceLogged.length = 0;
  fake.calls.length = 0;
  fake.configs.length = 0;
  fake.state.submitState = "sent";
  fake.state.submitErrorMessage = null;
  fake.state.importError = null;
  fake.state.sendError = null;
  fake.state.statusError = null;
  fake.state.submitted.length = 0;
  fake.state.statuses = {};
  fake.state.lookup = { found: true, name: "Kund AB", documentTypes: ["invoice", "credit_note"], message: null };
  fake.state.lookupError = null;
  userId = (
    await authRepo.create({ email: `einv-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Biller", role: "admin" })
  ).id;
  await systemService.updateCompanyInfo({
    name: "Nav Test AB",
    orgNumber: "556000-0001",
    vatNumber: "SE556000000101",
    address: "Fabriksvägen 1",
    postalCode: "41107",
    city: "Göteborg",
    email: "faktura@navtest.example",
    bankgiro: "5050-1055",
    fSkatt: true,
  });
  await enable();
  paymentTermId = (await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" })).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.execute(sql`DELETE FROM system_settings WHERE key LIKE 'einvoice_%'`);
});

async function enable(extra: Record<string, string> = {}) {
  const values: Record<string, string> = {
    einvoice_enabled: "true",
    einvoice_environment: "sandbox",
    einvoice_api_key: "test_key",
    einvoice_account_id: "nav-test",
    ...extra,
  };
  for (const [key, value] of Object.entries(values)) {
    await db.execute(sql`INSERT INTO system_settings (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = ${value}`);
  }
}

// Luhn-valid organisationsnummer (ubl-check applies SE-R-003) and a payment
// term, so the issued invoice gets a due date (BT-9 is required).
let paymentTermId: string;
async function makeCustomer(over: Record<string, unknown> = {}) {
  return salesService.createCustomer({ name: "Kund AB", orgNumber: "5565555553", paymentTermId, active: true, ...over } as never);
}

// A delivered order row → draft invoice → issued (FA number, archived PDF).
async function issuedInvoice(customer: Awaited<ReturnType<typeof makeCustomer>>, opts: { issue?: boolean; credit?: boolean } = {}) {
  const article = await articleService.createArticle({
    articleNumber: `EINV-${crypto.randomUUID().slice(0, 8)}`,
    name: "Diskbänk",
    type: "manufactured",
    active: true,
  });
  const warehouse = await stockService.createWarehouse({ name: "Huvudlager", active: true });
  const location = await stockService.createLocation({ warehouseId: warehouse.id, name: "A1", active: true });
  await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
  const { order, rows } = await salesService.createQuote(
    {
      customerId: customer.id,
      customerOrderNumber: "PO-778",
      customerReference: "Anna Andersson",
      rows: [{ articleId: article.id, quantity: 2, unitPrice: 500, discountPercent: 10 }],
      confirm: true,
    },
    userId
  );
  await salesService.startProduction(order.id);
  await salesService.deliverGoods(order.id, rows[0]!.id, { locationId: location.id, quantity: 2 }, userId);
  const draft = await invoiceService.create(
    { customerId: customer.id, rows: [{ description: "Diskbänk", articleId: article.id, salesOrderRowId: rows[0]!.id, quantity: 2, unitPrice: 500, discountPercent: 10 }] },
    userId
  );
  if (opts.issue === false) return draft!;
  const issued = await invoiceService.issue(draft!.id, userId);
  if (!opts.credit) return issued!;
  const credit = await invoiceService.createCredit(issued!.id, {}, userId);
  return (await invoiceService.issue(credit!.id, userId))!;
}

// A transmission row written directly, as the status job would find it.
async function sentRow(invoiceId: string, over: Partial<typeof einvoiceTransmissions.$inferInsert> = {}) {
  const [row] = await db
    .insert(einvoiceTransmissions)
    .values({
      invoiceId,
      provider: "b2brouter",
      environment: "sandbox",
      recipientId: "0007:5565555555",
      status: "sent",
      providerInvoiceId: "4242",
      providerState: "sent",
      document: Buffer.from("<Invoice/>"),
      sha256: "0".repeat(64),
      startedAt: clock,
      sentAt: clock,
      ...over,
    })
    .returning();
  return row!;
}

async function rowOf(id: string) {
  const [row] = await db.select().from(einvoiceTransmissions).where(eq(einvoiceTransmissions.id, id));
  return row!;
}

async function auditActions(invoiceId: string) {
  const rows = await db
    .select({ action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "invoice"), eq(auditLog.entityId, invoiceId)));
  return rows.filter((r) => r.action.startsWith("einvoice_"));
}

describe("pure rules", () => {
  it("resolves the recipient: the customer's Peppol-id, else 0007 + organisationsnummer", () => {
    expect(resolveRecipient({ peppolId: "0088:7350000000000", orgNumber: "5560000001" })).toEqual({ peppolId: "0088:7350000000000", source: "customer" });
    expect(resolveRecipient({ peppolId: null, orgNumber: "556000-0000" })).toEqual({ peppolId: "0007:5560000000", source: "org-number" });
    expect(resolveRecipient({ peppolId: null, orgNumber: "165560000000" })).toEqual({ peppolId: "0007:5560000000", source: "org-number" });
    expect(resolveRecipient({ peppolId: null, orgNumber: "12345" })).toEqual({ peppolId: null, source: null });
    expect(resolveRecipient({ peppolId: null, orgNumber: null }, "0007:1111111111")).toEqual({ peppolId: "0007:1111111111", source: "customer" });
  });

  it("blocks in the spec's order", () => {
    const company = { orgNumber: "5560000000", vatNumber: "SE556000000001" } as never;
    const ok = { privatePerson: false, country: "SE", invoiceCountry: null, peppolId: null, orgNumber: "5565555553" };
    expect(blockedReasonFor({ status: "draft", currency: "SEK" }, ok, company)).toBe("invoice-not-issued");
    expect(blockedReasonFor({ status: "issued", currency: "SEK" }, { ...ok, privatePerson: true }, company)).toBe("private-person");
    expect(blockedReasonFor({ status: "issued", currency: "SEK" }, { ...ok, country: "DK" }, company)).toBe("foreign-customer");
    expect(blockedReasonFor({ status: "issued", currency: "SEK" }, { ...ok, invoiceCountry: "NO" }, company)).toBe("foreign-customer");
    expect(blockedReasonFor({ status: "issued", currency: "EUR" }, ok, company)).toBe("currency");
    expect(blockedReasonFor({ status: "issued", currency: "SEK" }, ok, { orgNumber: null, vatNumber: "SE1" } as never)).toBe("missing-company-data");
    expect(blockedReasonFor({ status: "issued", currency: "SEK" }, ok, { orgNumber: "5560000000", vatNumber: "" } as never)).toBe("missing-company-data");
    expect(blockedReasonFor({ status: "issued", currency: "SEK" }, { ...ok, orgNumber: null }, company)).toBe("missing-recipient-id");
    expect(blockedReasonFor({ status: "paid", currency: "SEK" }, ok, company)).toBeNull();
  });

  it("is due by the interval with a margin, never before half the interval on short ones", () => {
    const t = new Date("2030-03-04T10:00:00Z");
    expect(isStatusDue(null, 30, t)).toBe(true);
    expect(isStatusDue(new Date("2030-03-04T09:32:00Z"), 30, t)).toBe(true);
    expect(isStatusDue(new Date("2030-03-04T09:40:00Z"), 30, t)).toBe(false);
    expect(isStatusDue(new Date("2030-03-04T09:57:00Z"), 5, t)).toBe(true);
    expect(isStatusDue(new Date("2030-03-04T09:58:00Z"), 5, t)).toBe(false);
  });
});

describe("Skicka e-faktura — guards", () => {
  it("refuses when e-invoicing is off, has no key or no account", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    await db.execute(sql`UPDATE system_settings SET value = 'false' WHERE key = 'einvoice_enabled'`);
    await expect(einvoice.send(invoice.id, userId)).rejects.toMatchObject({ name: "EinvoiceNotConfiguredError", reason: "disabled" });
    await enable();
    await db.execute(sql`DELETE FROM system_settings WHERE key = 'einvoice_api_key'`);
    await expect(einvoice.send(invoice.id, userId)).rejects.toMatchObject({ name: "EinvoiceNotConfiguredError", reason: "no-key" });
    await enable();
    await db.execute(sql`DELETE FROM system_settings WHERE key = 'einvoice_account_id'`);
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceNotConfiguredError);
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(einvoiceTransmissions)).toHaveLength(0);
  });

  it("404s an unknown invoice and refuses a draft", async () => {
    await expect(einvoice.send(crypto.randomUUID(), userId)).rejects.toBeInstanceOf(InvoiceNotFoundError);
    const draft = await issuedInvoice(await makeCustomer(), { issue: false });
    await expect(einvoice.send(draft.id, userId)).rejects.toMatchObject({ name: "EinvoiceNotAllowedError", reason: "invoice-not-issued" });
  });

  it("refuses a private person, a foreign customer, another currency, missing company data and a missing recipient id", async () => {
    const privat = await issuedInvoice(await makeCustomer({ privatePerson: true }));
    await expect(einvoice.send(privat.id, userId)).rejects.toMatchObject({ reason: "private-person" });

    const dansk = await issuedInvoice(await makeCustomer({ country: "DK" }));
    await expect(einvoice.send(dansk.id, userId)).rejects.toMatchObject({ reason: "foreign-customer" });

    const euro = await issuedInvoice(await makeCustomer());
    await db.update(invoices).set({ currency: "EUR" }).where(eq(invoices.id, euro.id));
    await expect(einvoice.send(euro.id, userId)).rejects.toMatchObject({ reason: "currency" });

    const noId = await issuedInvoice(await makeCustomer({ orgNumber: null }));
    await expect(einvoice.send(noId.id, userId)).rejects.toMatchObject({ reason: "missing-recipient-id" });

    await systemService.updateCompanyInfo({ vatNumber: null });
    const plain = await issuedInvoice(await makeCustomer());
    await expect(einvoice.send(plain.id, userId)).rejects.toMatchObject({ reason: "missing-company-data" });

    expect(fake.calls).toEqual([]);
    expect(await db.select().from(einvoiceTransmissions)).toHaveLength(0);
    // The card's view says the same thing.
    const view = await einvoice.getInvoiceView(privat.id);
    expect(view).toMatchObject({ enabled: true, environment: "sandbox", blockedReason: "private-person", transmissions: [] });
    expect(view.blockedMessage).toContain("Privatpersoner");
  });

  it("refuses a document Nav's own check rejects, before anything leaves", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    // No invoice number is impossible for an issued invoice — forced here to
    // make the pure check fail (BT-1 is mandatory).
    await db.update(invoices).set({ invoiceNumber: null }).where(eq(invoices.id, invoice.id));
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceDocumentInvalidError);
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(einvoiceTransmissions)).toHaveLength(0);
  });
});

describe("Skicka e-faktura — the send", () => {
  it("inserts the sending row BEFORE the access point is called, then marks it sent and logs it", async () => {
    const customer = await makeCustomer({ peppolId: "0088:7350000000000" });
    const invoice = await issuedInvoice(customer);
    let rowsAtSubmit: { status: string; providerInvoiceId: string | null }[] = [];
    const original = fake.provider.submit;
    fake.provider.submit = async (doc) => {
      rowsAtSubmit = await db.select({ status: einvoiceTransmissions.status, providerInvoiceId: einvoiceTransmissions.providerInvoiceId }).from(einvoiceTransmissions);
      return original(doc);
    };
    let view;
    try {
      view = await einvoice.send(invoice.id, userId);
    } finally {
      fake.provider.submit = original;
    }
    expect(rowsAtSubmit).toEqual([{ status: "sending", providerInvoiceId: null }]);
    expect(view).toMatchObject({ status: "sent", statusLabel: "Skickad", environment: "sandbox", recipientId: "0088:7350000000000", providerInvoiceId: expect.stringMatching(/^\d+$/), providerState: "sent", errorMessage: null });
    expect(view.sentAt?.toISOString()).toBe(clock.toISOString());
    expect(view.createdByName).toBe("Biller");
    // The provider was built from the settings, with the account.
    expect(fake.configs.at(-1)).toEqual({ environment: "sandbox", apiKey: "test_key", accountId: "nav-test" });

    // The document is the UBL as sent, hashed, with the invoice's own data.
    const row = await rowOf(view.id);
    const xml = row.document.toString("utf8");
    expect(xml).toContain(`<cbc:ID>${invoice.invoiceNumber}</cbc:ID>`);
    expect(xml).toContain('schemeID="0088">7350000000000<');
    expect(xml).toContain("<cbc:BuyerReference>Anna Andersson</cbc:BuyerReference>");
    expect(xml).toContain("<cbc:ID>PO-778</cbc:ID>");
    expect(xml).toContain("EmbeddedDocumentBinaryObject");
    expect(fake.state.submitted[0]!.xml.equals(row.document)).toBe(true);
    expect(fake.state.submitted[0]!.filename).toBe(`${invoice.invoiceNumber}.xml`);
    const doc = await einvoice.getDocument(view.id);
    expect(doc!.filename).toBe(`${invoice.invoiceNumber}.xml`);
    expect(doc!.content.equals(row.document)).toBe(true);

    expect(await auditActions(invoice.id)).toEqual([
      { action: "einvoice_sent", detail: { transmissionId: view.id, recipientId: "0088:7350000000000", environment: "sandbox", providerInvoiceId: view.providerInvoiceId } },
    ]);
    const card = await einvoice.getInvoiceView(invoice.id);
    expect(card.transmissions.map((t) => t.id)).toEqual([view.id]);
    expect(card.recipient).toEqual({ peppolId: "0088:7350000000000", source: "customer" });
  });

  it("derives the recipient from the organisationsnummer and falls back to the customer number as BT-10", async () => {
    const customer = await makeCustomer({ orgNumber: "556555-5553" });
    const article = await articleService.createArticle({ articleNumber: `FREE-${crypto.randomUUID().slice(0, 6)}`, name: "Tjänst", type: "service", active: true });
    const draft = await invoiceService.create({ customerId: customer.id, rows: [{ description: "Konsulttimme", articleId: article.id, quantity: 1, unitPrice: 100 }] }, userId);
    const issued = await invoiceService.issue(draft!.id, userId);
    const view = await einvoice.send(issued!.id, userId);
    expect(view.recipientId).toBe("0007:5565555553");
    const xml = (await rowOf(view.id)).document.toString("utf8");
    expect(xml).toContain(`<cbc:BuyerReference>${customer.customerNumber}</cbc:BuyerReference>`);
    expect(xml).not.toContain("<cac:OrderReference>");
  });

  it("sends a credit note with the credited invoice's number", async () => {
    const credit = await issuedInvoice(await makeCustomer(), { credit: true });
    const view = await einvoice.send(credit.id, userId);
    const xml = (await rowOf(view.id)).document.toString("utf8");
    expect(xml).toContain("<CreditNote");
    expect(xml).toContain("<cac:BillingReference>");
  });

  it("allows one live transmission per invoice — a double click gives 409 and sends once", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    const original = fake.provider.submit;
    fake.provider.submit = async (doc) => {
      await new Promise((r) => setTimeout(r, 150));
      return original(doc);
    };
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled([einvoice.send(invoice.id, userId), einvoice.send(invoice.id, userId)]);
    } finally {
      fake.provider.submit = original;
    }
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(EinvoiceAlreadySentError);
    expect(fake.state.submitted).toHaveLength(1);
    expect(await db.select().from(einvoiceTransmissions)).toHaveLength(1);
    // And again after the fact.
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceAlreadySentError);
  });

  it("marks the row failed when the access point refuses the document, and allows a resend", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    fake.state.importError = refused("B2Brouter avvisade dokumentet", ["BR-CO-10: Sum of line amounts"]);
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceProviderRejectedError);
    const [failed] = await db.select().from(einvoiceTransmissions);
    expect(failed).toMatchObject({ status: "failed", providerInvoiceId: null, errorMessage: "B2Brouter avvisade dokumentet — BR-CO-10: Sum of line amounts" });
    expect(await auditActions(invoice.id)).toEqual([
      { action: "einvoice_failed", detail: expect.objectContaining({ kind: "validation", reason: "B2Brouter avvisade dokumentet" }) },
    ]);

    fake.state.importError = null;
    const view = await einvoice.send(invoice.id, userId);
    expect(view.status).toBe("sent");
    const all = await repo.listTransmissions(invoice.id);
    expect(all.map((t) => t.status)).toEqual(["sent", "failed"]);
  });

  it("keeps the row sending with the provider id when the import went through but the send did not", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    fake.state.sendError = unavailable();
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceProviderUnavailableError);
    const [row] = await db.select().from(einvoiceTransmissions);
    expect(row).toMatchObject({ status: "sending", providerInvoiceId: expect.stringMatching(/^\d+$/), errorMessage: "B2Brouter svarar inte, försök igen" });
    // Still live: no second send.
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceAlreadySentError);
    // The status job reads what became of the draft.
    fake.state.statuses[row!.providerInvoiceId!] = { state: "sent", errorMessage: null, updatedAt: null };
    const polled = await status.pollTransmission(row!.id);
    expect(polled).toMatchObject({ status: "sent", providerState: "sent" });
    expect(polled.sentAt?.toISOString()).toBe(clock.toISOString());
  });

  it("fails the row when the send is refused after import (no retry is possible)", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    fake.state.sendError = refused("B2Brouter avvisade dokumentet");
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceProviderRejectedError);
    const [row] = await db.select().from(einvoiceTransmissions);
    expect(row).toMatchObject({ status: "failed", providerInvoiceId: expect.stringMatching(/^\d+$/) });
  });

  it("fails the row and rethrows on an unexpected error", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    fake.state.importError = new Error("boom");
    await expect(einvoice.send(invoice.id, userId)).rejects.toThrow("boom");
    const [row] = await db.select().from(einvoiceTransmissions);
    expect(row).toMatchObject({ status: "failed", errorMessage: "boom" });
  });

  it("writes the access point's id to the row BEFORE the send, so a death in between leaves a pollable row", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    let rowAfterImport: { status: string; providerInvoiceId: string | null } | undefined;
    const original = fake.provider.submit;
    fake.provider.submit = (doc, opts) =>
      original(doc, {
        onImported: async (id) => {
          await opts!.onImported!(id);
          [rowAfterImport] = await db.select({ status: einvoiceTransmissions.status, providerInvoiceId: einvoiceTransmissions.providerInvoiceId }).from(einvoiceTransmissions);
        },
      });
    try {
      await einvoice.send(invoice.id, userId);
    } finally {
      fake.provider.submit = original;
    }
    expect(rowAfterImport).toEqual({ status: "sending", providerInvoiceId: expect.stringMatching(/^\d+$/) });
  });

  it("maps the state reported right after the send: a queued send stays Skickas without sentAt", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    fake.state.submitState = "sending";
    const view = await einvoice.send(invoice.id, userId);
    expect(view).toMatchObject({ status: "sending", providerState: "sending", sentAt: null });
    expect((await auditActions(invoice.id)).map((a) => a.action)).toEqual(["einvoice_sent"]);
    // Still live: the job polls it, nobody can send again.
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceAlreadySentError);
    fake.state.statuses[view.providerInvoiceId!] = { state: "sent", errorMessage: null, updatedAt: null };
    expect(await status.pollTransmission(view.id)).toMatchObject({ status: "sent", sentAt: clock });
  });

  it("an immediate error or refusal after the send is final at once — never written as sent", async () => {
    const a = await issuedInvoice(await makeCustomer());
    fake.state.submitState = "error";
    fake.state.submitErrorMessage = "PEPPOL_NO_RECEIVER";
    const failed = await einvoice.send(a.id, userId);
    expect(failed).toMatchObject({ status: "failed", providerState: "error", errorMessage: "Mottagaren finns inte i Peppol", sentAt: null });
    expect(await auditActions(a.id)).toEqual([
      { action: "einvoice_failed", detail: expect.objectContaining({ transmissionId: failed.id, status: "failed", providerState: "error", reason: "Mottagaren finns inte i Peppol" }) },
    ]);
    // Terminal: the invoice can be sent again right away.
    fake.state.submitState = "refused";
    fake.state.submitErrorMessage = null;
    const rejected = await einvoice.send(a.id, userId);
    expect(rejected).toMatchObject({ status: "rejected", errorMessage: "Mottagaren avvisade fakturan" });
  });

  it("a database failure AFTER the send is logged and rethrown — the row is never marked failed", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    const original = repo.updateTransmission;
    repo.updateTransmission = async (id, patch, ifStatus) => {
      if (patch.status !== "sending") throw new Error("db down");
      return original.call(repo, id, patch, ifStatus);
    };
    try {
      await expect(einvoice.send(invoice.id, userId)).rejects.toThrow("db down");
    } finally {
      repo.updateTransmission = original;
    }
    expect(fake.state.submitted).toHaveLength(1);
    const [row] = await db.select().from(einvoiceTransmissions);
    // The id written before the send is there; the status job resolves it.
    expect(row).toMatchObject({ status: "sending", providerInvoiceId: expect.stringMatching(/^\d+$/), errorMessage: null });
    expect(serviceLogged).toEqual(["E-invoice sent but the transmission row could not be updated"]);
    expect(await status.pollTransmission(row!.id)).toMatchObject({ status: "sent" });
  });

  it("one live transmission per invoice AND environment: a sandbox trial never blocks the real send", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    await sentRow(invoice.id, { environment: "sandbox", status: "delivered", providerState: "registered" });
    await enable({ einvoice_environment: "production" });
    const real = await einvoice.send(invoice.id, userId);
    expect(real).toMatchObject({ status: "sent", environment: "production" });
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceAlreadySentError);
    // And a live production row does not stop a sandbox trial either.
    await enable({ einvoice_environment: "sandbox" });
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceAlreadySentError);
    await db.update(einvoiceTransmissions).set({ status: "failed" }).where(and(eq(einvoiceTransmissions.invoiceId, invoice.id), eq(einvoiceTransmissions.environment, "sandbox")));
    expect((await einvoice.send(invoice.id, userId)).environment).toBe("sandbox");
    const card = await einvoice.getInvoiceView(invoice.id);
    expect(card.transmissions.map((t) => `${t.environment}:${t.status}`).sort()).toEqual(["production:sent", "sandbox:failed", "sandbox:sent"]);
  });

  it("the database refuses changing or deleting the sent document (NV001)", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    const view = await einvoice.send(invoice.id, userId);
    await expect(
      db.update(einvoiceTransmissions).set({ document: Buffer.from("x") }).where(eq(einvoiceTransmissions.id, view.id))
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: "NV001" }) });
    await expect(db.delete(einvoiceTransmissions).where(eq(einvoiceTransmissions.id, view.id))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "NV001" }),
    });
    // The status columns stay writable.
    await db.update(einvoiceTransmissions).set({ providerState: "registered" }).where(eq(einvoiceTransmissions.id, view.id));
  });
});

describe("statusjobbet", () => {
  it.each(Object.entries(PROVIDER_STATE_MAP))("maps B2Brouter state %s to Nav status %s", async (state, expected) => {
    const invoice = await issuedInvoice(await makeCustomer());
    const row = await sentRow(invoice.id, { status: "sending", providerState: "new", sentAt: null });
    fake.state.statuses["4242"] = { state, errorMessage: state === "error" ? "PEPPOL_NO_RECEIVER" : null, updatedAt: null };
    // Five minutes later: a draft still "new" is not stale yet (see below).
    clock = new Date("2030-03-04T09:05:00Z");
    const polled = await status.pollTransmission(row.id);
    expect(polled.status).toBe(expected);
    expect(polled.providerState).toBe(state);
    expect(polled.lastPolledAt?.toISOString()).toBe(clock.toISOString());
    if (expected !== "sending") expect(polled.statusUpdatedAt?.toISOString()).toBe(clock.toISOString());
    if (expected === "failed") expect(polled.errorMessage).toBe("Mottagaren finns inte i Peppol");
    if (expected === "rejected") expect(polled.errorMessage).toBe("Mottagaren avvisade fakturan");
    if (expected === "sent" || expected === "delivered") expect(polled.sentAt).not.toBeNull();
    const failures = (await auditActions(invoice.id)).filter((a) => a.action === "einvoice_failed");
    expect(failures).toHaveLength(expected === "failed" || expected === "rejected" ? 1 : 0);
  });

  it("keeps an unknown state live (sending) and logs nothing", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    const row = await sentRow(invoice.id);
    fake.state.statuses["4242"] = { state: "something_new", errorMessage: null, updatedAt: null };
    expect((await status.pollTransmission(row.id)).status).toBe("sending");
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceAlreadySentError);
  });

  it("leaves a terminal row alone and 404s an unknown one", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    const row = await sentRow(invoice.id, { status: "delivered", providerState: "registered" });
    await status.pollTransmission(row.id);
    expect(fake.calls.filter((c) => c.method === "getStatus")).toHaveLength(0);
    await expect(status.pollTransmission(crypto.randomUUID())).rejects.toMatchObject({ name: "EinvoiceTransmissionNotFoundError" });
  });

  it("fails a sending row without a provider id after ten minutes, never a younger one or one with an id", async () => {
    const a = await issuedInvoice(await makeCustomer());
    const b = await issuedInvoice(await makeCustomer());
    const c = await issuedInvoice(await makeCustomer());
    const stale = await sentRow(a.id, { status: "sending", providerInvoiceId: null, providerState: null, sentAt: null, startedAt: new Date("2030-03-04T08:49:00Z") });
    const young = await sentRow(b.id, { status: "sending", providerInvoiceId: null, providerState: null, sentAt: null, startedAt: new Date("2030-03-04T08:52:00Z") });
    const withId = await sentRow(c.id, { status: "sending", providerInvoiceId: "7", providerState: "new", sentAt: null, startedAt: new Date("2030-03-04T08:00:00Z") });
    fake.state.statuses["7"] = { state: "registered", errorMessage: null, updatedAt: null };

    const result = await status.runStatus();
    expect(result).toEqual({ checked: 1, changed: 1, failed: 0, stale: 1 });
    expect(await rowOf(stale.id)).toMatchObject({ status: "failed", errorMessage: STALE_SENDING_MESSAGE });
    expect((await rowOf(young.id)).status).toBe("sending");
    expect((await rowOf(withId.id)).status).toBe("delivered");
    expect(await auditActions(a.id)).toEqual([{ action: "einvoice_failed", detail: expect.objectContaining({ reason: STALE_SENDING_MESSAGE }) }]);
    // The invoice can be sent again.
    expect((await einvoice.send(a.id, userId)).status).toBe("sent");
  });

  it("fails a draft that is still new at the access point after ten minutes — never a younger one", async () => {
    const a = await issuedInvoice(await makeCustomer());
    const b = await issuedInvoice(await makeCustomer());
    const stale = await sentRow(a.id, { status: "sending", providerInvoiceId: "7", providerState: "new", sentAt: null, startedAt: new Date("2030-03-04T08:49:00Z") });
    const young = await sentRow(b.id, { status: "sending", providerInvoiceId: "8", providerState: "new", sentAt: null, startedAt: new Date("2030-03-04T08:52:00Z") });
    fake.state.statuses["7"] = { state: "new", errorMessage: null, updatedAt: null };
    fake.state.statuses["8"] = { state: "new", errorMessage: null, updatedAt: null };
    expect(await status.runStatus()).toEqual({ checked: 2, changed: 1, failed: 0, stale: 0 });
    expect(await rowOf(stale.id)).toMatchObject({ status: "failed", providerState: "new", errorMessage: STALE_DRAFT_MESSAGE });
    expect(await rowOf(young.id)).toMatchObject({ status: "sending", errorMessage: null });
    expect(await auditActions(a.id)).toEqual([{ action: "einvoice_failed", detail: expect.objectContaining({ reason: STALE_DRAFT_MESSAGE, providerState: "new" }) }]);
    expect(await auditActions(b.id)).toEqual([]);
    expect((await einvoice.send(a.id, userId)).status).toBe("sent");
  });

  it("a document the access point no longer knows (404) is failed, once", async () => {
    const a = await issuedInvoice(await makeCustomer());
    const row = await sentRow(a.id, { providerInvoiceId: "9" });
    fake.state.statuses["9"] = { state: "__gone__", errorMessage: null, updatedAt: null };
    expect(await status.pollTransmission(row.id)).toMatchObject({ status: "failed", providerState: "sent", errorMessage: DOCUMENT_GONE_MESSAGE });
    // Terminal now: polled again, nothing is asked and nothing logged twice.
    await status.pollTransmission(row.id);
    expect(await auditActions(a.id)).toEqual([{ action: "einvoice_failed", detail: expect.objectContaining({ reason: DOCUMENT_GONE_MESSAGE }) }]);
  });

  it("clears an earlier transient error text once the access point reports the send through", async () => {
    const a = await issuedInvoice(await makeCustomer());
    const row = await sentRow(a.id, { status: "sending", providerState: "new", sentAt: null, errorMessage: "B2Brouter svarar inte, försök igen" });
    fake.state.statuses["4242"] = { state: "new", errorMessage: null, updatedAt: null };
    expect((await status.pollTransmission(row.id)).errorMessage).toBe("B2Brouter svarar inte, försök igen");
    fake.state.statuses["4242"] = { state: "sent", errorMessage: null, updatedAt: null };
    expect(await status.pollTransmission(row.id)).toMatchObject({ status: "sent", errorMessage: null });
  });

  it("a refresh racing the job writes nothing and logs nothing when the row moved on in between", async () => {
    const a = await issuedInvoice(await makeCustomer());
    const row = await sentRow(a.id);
    fake.state.statuses["4242"] = { state: "refused", errorMessage: "Fel kontering", updatedAt: null };
    const original = repo.updateTransmission;
    repo.updateTransmission = async (id, patch, ifStatus) => {
      // The other poll got there first.
      await db.update(einvoiceTransmissions).set({ status: "rejected", errorMessage: "först" }).where(eq(einvoiceTransmissions.id, id));
      return original.call(repo, id, patch, ifStatus);
    };
    try {
      expect(await status.pollTransmission(row.id)).toMatchObject({ status: "rejected", errorMessage: "först" });
    } finally {
      repo.updateTransmission = original;
    }
    expect(await auditActions(a.id)).toEqual([]);
  });

  it("polls only rows younger than 30 days, and one failing row does not stop the others", async () => {
    const a = await issuedInvoice(await makeCustomer());
    const b = await issuedInvoice(await makeCustomer());
    const c = await issuedInvoice(await makeCustomer());
    const old = await sentRow(a.id, { providerInvoiceId: "1", startedAt: new Date("2030-02-01T00:00:00Z") });
    const broken = await sentRow(b.id, { providerInvoiceId: "2" });
    const fine = await sentRow(c.id, { providerInvoiceId: "3" });
    fake.state.statuses["1"] = { state: "registered", errorMessage: null, updatedAt: null };
    fake.state.statuses["3"] = { state: "refused", errorMessage: "Fel kontering", updatedAt: null };
    // "2" has no scripted status → the fake throws unexpected.
    expect(await status.runStatus()).toEqual({ checked: 2, changed: 1, failed: 1, stale: 0 });
    expect((await rowOf(old.id)).status).toBe("sent");
    expect((await rowOf(broken.id)).status).toBe("sent");
    expect(await rowOf(fine.id)).toMatchObject({ status: "rejected", errorMessage: "Fel kontering" });
    expect(logged).toEqual(["E-invoice status poll failed"]);
  });

  it("runs when due, stamps after the run, honours the interval and the lease", async () => {
    await db.execute(sql`UPDATE system_settings SET value = 'false' WHERE key = 'einvoice_enabled'`);
    expect(await status.runStatusIfDue()).toBe("disabled");
    await enable();
    expect(await status.runStatusIfDue()).toEqual({ checked: 0, changed: 0, failed: 0, stale: 0 });
    expect((await settings.read()).lastStatusRunAt?.toISOString()).toBe(clock.toISOString());
    clock = new Date("2030-03-04T09:20:00Z");
    expect(await status.runStatusIfDue()).toBe("not-due");
    clock = new Date("2030-03-04T09:28:00Z");
    expect(await status.runStatusIfDue()).toEqual({ checked: 0, changed: 0, failed: 0, stale: 0 });
    // The lease was released after the run: it can be claimed again, and a
    // held lease makes the next due run busy until it expires.
    clock = new Date("2030-03-04T10:00:00Z");
    const lease = await repo.claimStatusLease(clock, STATUS_LEASE_MS);
    expect(lease).not.toBeNull();
    expect(await status.runStatusIfDue()).toBe("busy");
    clock = new Date("2030-03-04T10:16:00Z");
    expect(await status.runStatusIfDue()).toEqual({ checked: 0, changed: 0, failed: 0, stale: 0 });
    // A release with another run's value leaves the live lease in place.
    const mine = await repo.claimStatusLease(clock, STATUS_LEASE_MS);
    await repo.releaseStatusLease(lease!);
    expect(await repo.claimStatusLease(clock, STATUS_LEASE_MS)).toBeNull();
    await repo.releaseStatusLease(mine!);
    expect(await repo.claimStatusLease(clock, STATUS_LEASE_MS)).not.toBeNull();
    // The lease/stamp keys never leak into the view.
    expect(JSON.stringify(await settings.view())).not.toContain("lease");
  });

  it("a run that throws leaves the stamp unwritten and frees the lease", async () => {
    await enable({ einvoice_status_interval_minutes: "60" });
    const a = await issuedInvoice(await makeCustomer());
    await sentRow(a.id);
    const original = repo.listPollable;
    repo.listPollable = async () => {
      throw new Error("db down");
    };
    try {
      await expect(status.runStatusIfDue()).rejects.toThrow("db down");
    } finally {
      repo.listPollable = original;
    }
    expect((await settings.read()).lastStatusRunAt).toBeNull();
    fake.state.statuses["4242"] = { state: "sent", errorMessage: null, updatedAt: null };
    expect(await status.runStatusIfDue()).toEqual({ checked: 1, changed: 0, failed: 0, stale: 0 });
  });
});

describe("Kontrollera mottagaren", () => {
  it("looks up the customer's Peppol-id, labels the document types and stores nothing", async () => {
    const customer = await makeCustomer({ orgNumber: "556555-5553" });
    const result = await einvoice.lookup(customer.id);
    expect(result).toEqual({
      peppolId: "0007:5565555553",
      source: "org-number",
      environment: "sandbox",
      found: true,
      name: "Kund AB",
      documentTypes: ["Faktura", "Kreditfaktura"],
      message: null,
    });
    expect(fake.calls.at(-1)).toEqual({ method: "lookupParticipant", args: ["0007", "5565555553"] });
    expect((await salesService.getCustomer(customer.id))!.peppolId).toBeNull();
  });

  it("takes an unsaved value from the form, and answers without a call when there is no id at all", async () => {
    const customer = await makeCustomer({ orgNumber: null });
    const typed = await einvoice.lookup(customer.id, { peppolId: "0088:7350000000000" });
    expect(typed).toMatchObject({ peppolId: "0088:7350000000000", source: "customer", found: true });
    expect(fake.calls.at(-1)).toEqual({ method: "lookupParticipant", args: ["0088", "7350000000000"] });
    fake.calls.length = 0;
    const none = await einvoice.lookup(customer.id);
    expect(none).toMatchObject({ peppolId: null, source: null, found: null });
    expect(none.message).toContain("saknar Peppol-id");
    expect(fake.calls).toEqual([]);
  });

  it("passes the directory's own answers through and maps a refused key", async () => {
    const customer = await makeCustomer();
    fake.state.lookup = { found: false, name: null, documentTypes: [], message: null };
    expect((await einvoice.lookup(customer.id)).found).toBe(false);
    fake.state.lookup = { found: null, name: null, documentTypes: [], message: "Katalogen svarade inte, försök igen" };
    expect(await einvoice.lookup(customer.id)).toMatchObject({ found: null, message: "Katalogen svarade inte, försök igen" });
    fake.state.lookupError = new EInvoiceProviderError("nekad", "unauthorized");
    await expect(einvoice.lookup(customer.id)).rejects.toMatchObject({ name: "EinvoiceProviderUnauthorizedError" });
    // Works without the feature enabled, but not without a key.
    fake.state.lookupError = null;
    fake.state.lookup = { found: true, name: "Kund AB", documentTypes: ["invoice"], message: null };
    await db.execute(sql`UPDATE system_settings SET value = 'false' WHERE key = 'einvoice_enabled'`);
    expect((await einvoice.lookup(customer.id)).found).toBe(true);
    await db.execute(sql`DELETE FROM system_settings WHERE key = 'einvoice_api_key'`);
    await expect(einvoice.lookup(customer.id)).rejects.toMatchObject({ reason: "no-key" });
  });
});

describe("fakturalistan", () => {
  it("carries the latest transmission's status and environment per invoice, production before sandbox", async () => {
    const sent = await issuedInvoice(await makeCustomer());
    const never = await issuedInvoice(await makeCustomer());
    const both = await issuedInvoice(await makeCustomer());
    await einvoice.send(sent.id, userId);
    await sentRow(both.id, { environment: "production", status: "rejected", providerState: "refused", startedAt: new Date("2030-03-01T00:00:00Z") });
    await sentRow(both.id, { environment: "sandbox", status: "delivered", providerState: "registered" });
    const { rows } = await invoiceService.list({ limit: 50, offset: 0 });
    expect(rows.find((r) => r.id === sent.id)).toMatchObject({ einvoiceStatus: "sent", einvoiceEnvironment: "sandbox" });
    expect(rows.find((r) => r.id === never.id)).toMatchObject({ einvoiceStatus: null, einvoiceEnvironment: null });
    // The older production row wins over the newer sandbox one.
    expect(rows.find((r) => r.id === both.id)).toMatchObject({ einvoiceStatus: "rejected", einvoiceEnvironment: "production" });
  });
});

describe("momskoder (spec 4.5)", () => {
  it("blocks a document with a code that has no Peppol category, MP*/MF/OB pass", () => {
    const company = { orgNumber: "5560000000", vatNumber: "SE556000000001" } as never;
    const ok = { privatePerson: false, country: "SE", invoiceCountry: null, peppolId: null, orgNumber: "5565555553" };
    const rows = (...codes: string[]) => codes.map((code) => ({ vatCode: { code, invoiceText: null } }));
    expect(blockedReasonFor({ status: "issued", currency: "SEK", rows: rows("MP25", "MF", "OB") }, ok, company)).toBeNull();
    expect(blockedReasonFor({ status: "issued", currency: "SEK", rows: rows("MP25", "EXV") }, ok, company)).toBe("vat-code-unsupported");
    expect(blockedReasonFor({ status: "issued", currency: "SEK", rows: rows("EUT") }, ok, company)).toBe("vat-code-unsupported");
  });

  it("sends omvänd betalningsskyldighet as AE with the code's text and the buyer's VAT number", async () => {
    const service = await articleService.createArticle({
      articleNumber: `EINV-OB-${crypto.randomUUID().slice(0, 8)}`,
      name: "Montage",
      type: "service",
      active: true,
    });
    const bygg = await makeCustomer({ name: "Bygg AB", reverseChargeConstruction: true, vatNumber: "SE556555555301" });
    const draft = await invoiceService.create(
      { customerId: bygg.id, rows: [{ articleId: service.id, description: "Montage", quantity: 2, unitPrice: 800 }] },
      userId
    );
    expect(draft!.rows[0]!.vatCode.code).toBe("OB");
    const issued = await invoiceService.issue(draft!.id, userId);
    // BuyerReference falls back to the customer number (no order link).
    await einvoice.send(issued!.id, userId);
    const xml = fake.state.submitted[0]!.xml.toString("utf8");
    expect(xml).toContain("<cbc:ID>AE</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReason>Omvänd betalningsskyldighet</cbc:TaxExemptionReason>");
    expect(xml).toContain("<cac:PartyTaxScheme><cbc:CompanyID>SE556555555301</cbc:CompanyID>");
  });

  it("refuses a Swedish invoice with a hand-picked export code (vat-code-unsupported)", async () => {
    const customer = await makeCustomer();
    const { vatCodes } = await import("@navet/db");
    const [exv] = await db.select({ id: vatCodes.id }).from(vatCodes).where(eq(vatCodes.code, "EXV"));
    const draft = await invoiceService.create(
      { customerId: customer.id, rows: [{ description: "Export", quantity: 1, unitPrice: 100, vatCodeId: exv!.id }] },
      userId
    );
    const issued = await invoiceService.issue(draft!.id, userId);
    const err = await einvoice.send(issued!.id, userId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EinvoiceNotAllowedError);
    expect(err).toMatchObject({ reason: "vat-code-unsupported" });
    expect(fake.state.submitted).toHaveLength(0);
    const view = await einvoice.getInvoiceView(issued!.id);
    expect(view.blockedReason).toBe("vat-code-unsupported");
  });
});
