import {
  createArticleSchema,
  createCustomerSchema,
  createInvoiceSchema,
  createQuoteSchema,
  createStockLocationSchema,
  peppolLookupSchema,
  runCollectiveInvoicingSchema,
  testEinvoiceConnectionSchema,
  updateEinvoiceSettingsSchema,
} from "@navet/shared";
import type { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { and, eq, like, sql } from "drizzle-orm";
import { auditLog, companyInfo, db, einvoiceReceptions, einvoiceTransmissions, invoiceScans, invoices, suppliers, systemSettings } from "@navet/db";
import { createArticleRepository } from "../src/modules/article/repository/article.repository.js";
import { createArticleService } from "../src/modules/article/service/article.service.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createSalesRepository } from "../src/modules/sales/repository/sales.repository.js";
import { createSalesService } from "../src/modules/sales/service/sales.service.js";
import { resolvePrice } from "../src/modules/sales/service/price-resolver.js";
import { createInvoiceRepository } from "../src/modules/sales/repository/invoice.repository.js";
import { createInvoiceService } from "../src/modules/sales/service/invoice.service.js";
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
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createInvoiceScanRepository } from "../src/modules/purchase/repository/invoice-scan.repository.js";
import { createInvoiceScanService } from "../src/modules/purchase/service/invoice-scan.service.js";
import { createInvoiceScanSettingsService } from "../src/modules/purchase/service/invoice-scan-settings.service.js";
import type { EInvoiceOriginalReader } from "../src/modules/purchase/service/invoice-scan/einvoice-original.js";
import { einvoiceRoutes } from "../src/modules/einvoice/routes/einvoice.routes.js";
import { createEinvoiceRepository } from "../src/modules/einvoice/repository/einvoice.repository.js";
import { createEinvoiceSettingsService, keyEnvironment } from "../src/modules/einvoice/service/einvoice-settings.service.js";
import { createEinvoiceService, PROVIDER_DOWN_MESSAGE, UNEXPECTED_SEND_MESSAGE } from "../src/modules/einvoice/service/einvoice.service.js";
import { createEinvoiceStatusService } from "../src/modules/einvoice/service/einvoice-status.service.js";
import { createEinvoiceReceiveService, RECEIVE_TEXTS } from "../src/modules/einvoice/service/einvoice-receive.service.js";
import {
  EinvoiceDocumentInvalidError,
  EinvoiceKeyEnvironmentMismatchError,
  EinvoiceOtherEnvironmentError,
} from "../src/modules/einvoice/service/einvoice.errors.js";
import { EInvoiceProviderError } from "../src/modules/einvoice/service/einvoice-provider.js";
import { buildUblDocument } from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import { EINVOICE_COPY_TITLE } from "../src/modules/mail/service/einvoice-copy-pdf.js";
import { createFakeEinvoiceProvider, refused, unavailable } from "./helpers/fake-einvoice-provider.js";
import { createFakeInvoiceInterpreter } from "./helpers/fake-invoice-interpreter.js";
import { DEFAULT_POSTING_SETTINGS, setupPostingBaseline } from "./helpers/services.js";
import { FAKE_PDF, invoiceTwoRatesDiscount, SELLER } from "./helpers/ubl-fixtures.js";
import { parsed } from "./helpers/parsed.js";
import { pdfText } from "./helpers/pdf.js";

// E-fakturagranskningen 2026-11-10 (.claude/rules/einvoice.md: "Nyckeln och
// Miljö", "Bara den valda miljöns rader", "Spår när automatiken inte
// skickar", "Kontrollera", mottagningens sharedPdf). The services against
// Postgres with the fake access point — never B2Brouter. All data is
// invented.

// --- Sändning: the fixture of einvoice.test.ts ---

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
const audit = createAuditRepository(db);
// Without the hook: an issued invoice nothing has been sent for.
const invoiceService = createInvoiceService(createInvoiceRepository(db), mailService, documentPdfService, invoicePoster, audit, articleService);

const repo = createEinvoiceRepository(db);
const fake = createFakeEinvoiceProvider();
const originalSubmit = fake.provider.submit;
let clock = new Date("2030-03-04T09:00:00Z");
const now = () => clock;
const serviceLogged: { msg: string; extra: unknown }[] = [];
const settings = createEinvoiceSettingsService({ repo, company: systemService, audit, providerFactory: fake.factory });
const einvoice = createEinvoiceService({
  repo,
  settings,
  invoices: {
    getInvoice: (id) => invoiceService.getInvoice(id),
    archivedInvoicePdf: (id) => invoiceService.renderPdf(id),
    findCustomerById: (id) => salesService.getCustomer(id),
  },
  company: systemService,
  audit,
  now,
  log: (msg, extra) => serviceLogged.push({ msg, extra }),
});
const status = createEinvoiceStatusService({ repo, settings, audit, now, log: () => {} });
// With the hook, bound as app.ts binds it (the options go through).
const autoInvoiceService = createInvoiceService(
  createInvoiceRepository(db),
  mailService,
  documentPdfService,
  invoicePoster,
  audit,
  articleService,
  undefined,
  null,
  null,
  null,
  (invoiceId, uid, opts) => einvoice.sendAfterIssue(invoiceId, uid, opts)
);

// --- Mottagning: the fixture of einvoice-receive.test.ts ---

const interpreter = createFakeInvoiceInterpreter();
const scanRepo = createInvoiceScanRepository(db);
const scanSettings = createInvoiceScanSettingsService({ repo: scanRepo, audit, interpreters: interpreter.factory });
const originalRef: { current: EInvoiceOriginalReader | null } = { current: null };
const scanService = createInvoiceScanService({
  repo: scanRepo,
  supplierInvoices: createSupplierInvoiceService(createSupplierInvoiceRepository(db), invoicePoster, audit),
  company: systemService,
  settings: scanSettings,
  audit,
  interpreters: interpreter.factory,
  einvoiceOriginals: {
    infoForScan: (id) => originalRef.current!.infoForScan(id),
    forScan: (id) => originalRef.current!.forScan(id),
    originalXml: (id) => originalRef.current!.originalXml(id),
    attachment: (id, i) => originalRef.current!.attachment(id, i),
  },
  log: () => {},
});
const receive = createEinvoiceReceiveService({ repo, settings, scans: scanService, audit, now, log: () => {} });
originalRef.current = receive;

const TRUNCATE = sql`TRUNCATE einvoice_receptions, invoice_scan_hints, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, supplier_contacts, suppliers, purchase_order_rows, purchase_orders, einvoice_transmissions, invoice_documents, posting_rules, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, invoice_rows, invoices, sales_order_rows, sales_orders, customers, payment_terms, stock_transactions, stock_locations, warehouses, bom_components, articles, audit_log, users CASCADE`;

let companyBefore: typeof companyInfo.$inferSelect | undefined;
let userId: string;
let paymentTermId: string;

async function setSetting(key: string, value: string) {
  await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}
const setting = async (key: string) => (await db.select().from(systemSettings).where(eq(systemSettings.key, key)))[0]?.value ?? null;

// Miljö with a key that belongs to it — written directly, as a save would
// have left it.
async function useEnvironment(environment: "sandbox" | "production") {
  await setSetting("einvoice_environment", environment);
  await setSetting("einvoice_api_key", environment === "production" ? "prod_key" : "test_key");
}

beforeAll(async () => {
  [companyBefore] = await db.select().from(companyInfo).limit(1);
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(like(systemSettings.key, "einvoice\\_%"));
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
  await setupPostingBaseline();
  clock = new Date("2030-03-04T09:00:00Z");
  serviceLogged.length = 0;
  fake.provider.submit = originalSubmit;
  fake.calls.length = 0;
  fake.configs.length = 0;
  fake.state.checkKeyError = null;
  fake.state.submitState = "sent";
  fake.state.submitErrorMessage = null;
  fake.state.importError = null;
  fake.state.sendError = null;
  fake.state.statusError = null;
  fake.state.submitted.length = 0;
  fake.state.statuses = {};
  fake.state.lookup = { found: true, name: "Kund AB", documentTypes: ["invoice", "credit_note"], message: null };
  fake.state.lookupError = null;
  fake.state.received.clear();
  fake.state.listReceivedError = null;
  userId = (await authRepo.create({ email: `eg-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Biller", role: "admin" })).id;
  await systemService.updateCompanyInfo({
    name: "Nav Test AB",
    orgNumber: "556000-0001",
    vatNumber: "SE556000000101",
    address: "Fabriksvägen 1",
    postalCode: "41107",
    city: "Göteborg",
    email: "faktura@navtest.example",
    bankgiro: "5050-1055",
    plusgiro: null,
    iban: null,
    fSkatt: true,
  });
  await setSetting("einvoice_enabled", "true");
  await setSetting("einvoice_account_id", "nav-test");
  await setSetting("einvoice_reception_enabled", "true");
  await useEnvironment("sandbox");
  paymentTermId = (await registerService.paymentTerms.create({ code: "30", name: "30 dagar netto" })).id;
});

afterAll(async () => {
  fake.provider.submit = originalSubmit;
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(like(systemSettings.key, "einvoice\\_%"));
  if (companyBefore) {
    const { id: _id, ...rest } = companyBefore;
    await db.update(companyInfo).set(rest);
  }
});

// --- Helpers ---

// Luhn-valid organisationsnummer (ubl-check applies SE-R-003) and a payment
// term, so the issued invoice gets a due date (BT-9).
function makeCustomer(over: Partial<z.input<typeof createCustomerSchema>> = {}) {
  return salesService.createCustomer(parsed(createCustomerSchema, { name: "Kund AB", orgNumber: "5565555553", paymentTermId, ...over }));
}
type Customer = Awaited<ReturnType<typeof makeCustomer>>;

const serviceRow = (customer: Customer) => parsed(createInvoiceSchema, { customerId: customer.id, rows: [{ description: "Montering", quantity: 1, unitPrice: 1000 }] });

// An issued invoice no e-invoice has been attempted for.
async function issuedInvoice(customer: Customer) {
  const draft = await invoiceService.create(serviceRow(customer), userId);
  return (await invoiceService.issue(draft!.id, userId))!;
}

// Utfärda with the automatic e-invoice behind it.
async function issueWithAutoSend(customer: Customer) {
  const draft = await autoInvoiceService.create(serviceRow(customer), userId);
  return (await autoInvoiceService.issue(draft!.id, userId))!;
}

// A transmission row written directly, as the status job would find it.
async function sentRow(invoiceId: string, over: Partial<typeof einvoiceTransmissions.$inferInsert> = {}) {
  const [row] = await db
    .insert(einvoiceTransmissions)
    .values({
      invoiceId,
      provider: "b2brouter",
      environment: "sandbox",
      recipientId: "0007:5565555553",
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
const transmissionsOf = (invoiceId: string) => db.select().from(einvoiceTransmissions).where(eq(einvoiceTransmissions.invoiceId, invoiceId));

// The invoice's e-invoice events, oldest first.
async function einvoiceEvents(invoiceId: string) {
  const rows = await db
    .select({ action: auditLog.action, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "invoice"), eq(auditLog.entityId, invoiceId)))
    .orderBy(auditLog.createdAt);
  return rows.filter((r) => r.action.startsWith("einvoice_"));
}
const settingsEvents = () => db.select().from(auditLog).where(eq(auditLog.entityType, "einvoice_settings"));
const callsOf = (method: string) => fake.calls.filter((c) => c.method === method);

// The routes with the real services behind them: the error mapping only.
function routesApp() {
  const app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: userId };
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  app.register(einvoiceRoutes, { settings, service: einvoice, status, receive });
  return app;
}

// Mottagning.
async function makeSupplier() {
  const [row] = await db
    .insert(suppliers)
    .values({ supplierNumber: `L${crypto.randomUUID().slice(0, 8)}`, name: SELLER.name, orgNumber: "556677-8899", currency: "SEK" })
    .returning();
  return row!;
}
const invoiceXml = (over: Partial<ReturnType<typeof invoiceTwoRatesDiscount>> = {}) => Buffer.from(buildUblDocument({ ...invoiceTwoRatesDiscount(), ...over }), "utf8");
async function runReceive() {
  const result = await receive.runReceiveIfDue();
  if (typeof result === "string") throw new Error(`run: ${result}`);
  return result;
}
const receptions = () => db.select().from(einvoiceReceptions).orderBy(einvoiceReceptions.createdAt);
const scans = () => db.select().from(invoiceScans).orderBy(invoiceScans.createdAt);
// A document neither Nav nor the access point can read ⇒ an `unreadable` row.
const unreadableDocument = () =>
  fake.receive(Buffer.from('<CrossIndustryInvoice xmlns="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"><x/></CrossIndustryInvoice>'), {
    ublError: new EInvoiceProviderError("B2Brouter gav ett oväntat svar", "unexpected"),
  });

const other = (environment: "sandbox" | "production") => (environment === "sandbox" ? "production" : "sandbox");

// ---------------------------------------------------------------------------

describe("1. Bara den valda miljöns rader frågas med nyckeln", () => {
  it.each(["sandbox", "production"] as const)("statusjobbet och Uppdatera status rör inte en %s-rad när den andra miljön är vald", async (rowEnvironment) => {
    const invoice = await issuedInvoice(await makeCustomer());
    const row = await sentRow(invoice.id, { environment: rowEnvironment, providerInvoiceId: "4242" });
    // What the other environment's key would get for this id: 404 ⇒ the row
    // would be failed and Skicka igen opened.
    fake.state.statuses["4242"] = { state: "__gone__", errorMessage: null, updatedAt: null };
    await useEnvironment(other(rowEnvironment));
    const before = await rowOf(row.id);

    expect(await status.runStatus()).toEqual({ checked: 0, changed: 0, failed: 0, stale: 0 });
    expect(fake.calls).toEqual([]);
    expect(await rowOf(row.id)).toEqual(before);

    // Uppdatera status: the row comes back as it was.
    const polled = await status.pollTransmission(row.id);
    expect(polled).toMatchObject({ id: row.id, status: "sent", providerState: "sent", lastPolledAt: null, errorMessage: null });
    expect(fake.calls).toEqual([]);
    expect(fake.configs).toEqual([]);
    expect(await rowOf(row.id)).toEqual(before);

    // …and through the route.
    const app = routesApp();
    const res = await app.inject({ method: "POST", url: `/einvoice-transmissions/${row.id}/refresh` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: row.id, status: "sent", environment: rowEnvironment });
    expect(fake.calls).toEqual([]);
    expect(await rowOf(row.id)).toEqual(before);
    expect(await einvoiceEvents(invoice.id)).toEqual([]);
  });

  it("pollar den valda miljöns rad som förut — den andra miljöns rad på samma faktura väntar", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    const sandbox = await sentRow(invoice.id, { environment: "sandbox", providerInvoiceId: "4242" });
    const production = await sentRow(invoice.id, { environment: "production", providerInvoiceId: "4243" });
    fake.state.statuses["4242"] = { state: "registered", errorMessage: null, updatedAt: null };
    fake.state.statuses["4243"] = { state: "registered", errorMessage: null, updatedAt: null };

    await useEnvironment("production");
    expect(await status.runStatus()).toEqual({ checked: 1, changed: 1, failed: 0, stale: 0 });
    expect(callsOf("getStatus").map((c) => c.args)).toEqual([["4243"]]);
    expect(fake.configs.every((c) => c.environment === "production" && c.apiKey === "prod_key")).toBe(true);
    expect(await rowOf(production.id)).toMatchObject({ status: "delivered", providerState: "registered" });
    expect(await rowOf(sandbox.id)).toMatchObject({ status: "sent", providerState: "sent", lastPolledAt: null });

    // Back in Sandbox the waiting row is read with the sandbox key.
    await useEnvironment("sandbox");
    fake.calls.length = 0;
    fake.configs.length = 0;
    expect(await status.pollTransmission(sandbox.id)).toMatchObject({ status: "delivered", providerState: "registered" });
    expect(callsOf("getStatus").map((c) => c.args)).toEqual([["4242"]]);
    expect(fake.configs).toEqual([{ environment: "sandbox", apiKey: "test_key", accountId: "nav-test" }]);
  });

  it("Markera som hanterad vägrar en oläsbar rad från den andra miljön — ingen kvittens, raden kvar", async () => {
    const providerId = unreadableDocument();
    expect(await runReceive()).toMatchObject({ listed: 1, unreadable: 1 });
    const [row] = await receptions();
    expect(row).toMatchObject({ environment: "sandbox", outcome: "unreadable", providerInvoiceId: providerId });

    await useEnvironment("production");
    fake.calls.length = 0;
    fake.configs.length = 0;
    const refusal = await receive.dismiss(row!.id, userId).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(EinvoiceOtherEnvironmentError);
    expect(refusal).toMatchObject({ environment: "sandbox" });
    expect((refusal as Error).message).toContain("Sandbox");

    const app = routesApp();
    const res = await app.inject({ method: "POST", url: `/einvoice-settings/reception-log/${row!.id}/dismiss` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "einvoice-other-environment", environment: "sandbox" });

    expect(fake.calls).toEqual([]);
    expect(fake.configs).toEqual([]);
    expect(fake.state.received.get(providerId)!.acked).toBe(false);
    expect((await receptions())[0]).toMatchObject({ outcome: "unreadable", detail: row!.detail });
    expect(await db.select().from(auditLog).where(eq(auditLog.entityType, "einvoice_reception"))).toEqual([]);

    // In its own environment the same row is dismissed and acknowledged.
    await useEnvironment("sandbox");
    expect(await receive.dismiss(row!.id, userId)).toMatchObject({ outcome: "dismissed", detail: RECEIVE_TEXTS.dismissed });
    expect(fake.state.received.get(providerId)!.acked).toBe(true);
  });

  it("omvänt: en oläsbar produktionsrad vägras under Sandbox", async () => {
    await useEnvironment("production");
    const providerId = unreadableDocument();
    await runReceive();
    const [row] = await receptions();
    expect(row).toMatchObject({ environment: "production", outcome: "unreadable" });
    await useEnvironment("sandbox");
    fake.calls.length = 0;
    await expect(receive.dismiss(row!.id, userId)).rejects.toMatchObject({ name: "EinvoiceOtherEnvironmentError", environment: "production" });
    expect(fake.calls).toEqual([]);
    expect(fake.state.received.get(providerId)!.acked).toBe(false);
    expect((await receptions())[0]!.outcome).toBe("unreadable");
  });
});

// ---------------------------------------------------------------------------

describe("2. Nyckeln och Miljö", () => {
  it("keyEnvironment läser prefixet: test_, prod_, stag_ — utan prefix obedömd", () => {
    expect(keyEnvironment("test_abc123")).toBe("sandbox");
    expect(keyEnvironment("prod_abc123")).toBe("production");
    expect(keyEnvironment("stag_abc123")).toBe("staging");
    expect(keyEnvironment("abc123")).toBeNull();
    expect(keyEnvironment("")).toBeNull();
    // Trimmed like the form's value; the prefix is a prefix, nothing else.
    expect(keyEnvironment("  prod_abc123 ")).toBe("production");
    expect(keyEnvironment("my_test_key")).toBeNull();
    expect(keyEnvironment("production")).toBeNull();
    expect(keyEnvironment("PROD_abc")).toBeNull();
  });

  it.each([
    { apiKey: "prod_ny", environment: "sandbox", owner: "production" },
    { apiKey: "test_ny", environment: "production", owner: "sandbox" },
    { apiKey: "stag_ny", environment: "sandbox", owner: "staging" },
    { apiKey: "stag_ny", environment: "production", owner: "staging" },
  ] as const)("Spara vägrar $apiKey under $environment och sparar inget", async ({ apiKey, environment, owner }) => {
    const before = await settings.read();
    const refusal = await settings
      .update(parsed(updateEinvoiceSettingsSchema, { apiKey, environment, enabled: false, statusIntervalMinutes: 45, autoSend: false, accountId: "annat", accountName: "Annat AB" }), userId)
      .catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(EinvoiceKeyEnvironmentMismatchError);
    expect(refusal).toMatchObject({ keyEnvironment: owner, selected: environment });
    // Nothing of the save was written: neither the key, nor Miljö, nor the
    // fields beside them.
    expect(await settings.read()).toEqual(before);
    expect(await setting("einvoice_api_key")).toBe("test_key");
    expect(await setting("einvoice_environment")).toBe("sandbox");
    expect(await settingsEvents()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("vägrar en ny nyckel som motsäger den sparade miljön, och ett miljöbyte som motsäger den sparade nyckeln", async () => {
    // Only the key: checked against the saved Miljö (Sandbox).
    await expect(settings.update(parsed(updateEinvoiceSettingsSchema, { apiKey: "prod_ny" }), userId)).rejects.toBeInstanceOf(EinvoiceKeyEnvironmentMismatchError);
    expect(await setting("einvoice_api_key")).toBe("test_key");
    // Only Miljö: checked against the saved key (test_).
    await expect(settings.update(parsed(updateEinvoiceSettingsSchema, { environment: "production" }), userId)).rejects.toMatchObject({
      name: "EinvoiceKeyEnvironmentMismatchError",
      keyEnvironment: "sandbox",
      selected: "production",
    });
    // "" keeps the stored key — still that key that is judged.
    await expect(settings.update(parsed(updateEinvoiceSettingsSchema, { environment: "production", apiKey: "" }), userId)).rejects.toBeInstanceOf(EinvoiceKeyEnvironmentMismatchError);
    expect(await setting("einvoice_environment")).toBe("sandbox");
    expect(await settingsEvents()).toEqual([]);

    // The other way round: a saved production pair, Miljö back to Sandbox.
    await useEnvironment("production");
    await expect(settings.update(parsed(updateEinvoiceSettingsSchema, { environment: "sandbox" }), userId)).rejects.toMatchObject({ keyEnvironment: "production", selected: "sandbox" });
    expect(await setting("einvoice_environment")).toBe("production");

    // Key and Miljö changed together to a matching pair is the way through.
    await settings.update(parsed(updateEinvoiceSettingsSchema, { environment: "sandbox", apiKey: "test_ny" }), userId);
    expect(await settings.read()).toMatchObject({ environment: "sandbox", apiKey: "test_ny" });
    // A save that touches neither is never judged (and never refused).
    await settings.update(parsed(updateEinvoiceSettingsSchema, { statusIntervalMinutes: 20 }), userId);
    expect((await settings.read()).statusIntervalMinutes).toBe(20);
  });

  it("en nyckel utan prefix godtas i båda miljöerna", async () => {
    await settings.update(parsed(updateEinvoiceSettingsSchema, { apiKey: "aldrenyckel123", environment: "production" }), userId);
    expect(await settings.read()).toMatchObject({ apiKey: "aldrenyckel123", environment: "production" });
    await settings.provider({ requireEnabled: true, requireAccount: true });
    expect(fake.configs.at(-1)).toEqual({ environment: "production", apiKey: "aldrenyckel123", accountId: "nav-test" });
    await settings.update(parsed(updateEinvoiceSettingsSchema, { environment: "sandbox" }), userId);
    await settings.provider({ requireEnabled: true, requireAccount: true });
    expect(fake.configs.at(-1)).toEqual({ environment: "sandbox", apiKey: "aldrenyckel123", accountId: "nav-test" });
    expect(await settings.testConnection(parsed(testEinvoiceConnectionSchema, { environment: "production" }))).toMatchObject({ environment: "production" });
    expect(await settings.testConnection(parsed(testEinvoiceConnectionSchema, { apiKey: "annan-utan-prefix", environment: "sandbox" }))).toMatchObject({ environment: "sandbox" });
    expect(callsOf("checkKey")).toHaveLength(2);
  });

  it("Testa anslutning vägrar samma kombinationer utan att fråga accesspunkten", async () => {
    const attempts: z.input<typeof testEinvoiceConnectionSchema>[] = [
      { apiKey: "prod_typad", environment: "sandbox" },
      { apiKey: "test_typad", environment: "production" },
      { apiKey: "stag_typad", environment: "sandbox" },
      { apiKey: "stag_typad", environment: "production" },
      // The typed key against the saved Miljö, the typed Miljö against the saved key.
      { apiKey: "prod_typad" },
      { environment: "production" },
    ];
    for (const attempt of attempts) {
      await expect(settings.testConnection(parsed(testEinvoiceConnectionSchema, attempt))).rejects.toBeInstanceOf(EinvoiceKeyEnvironmentMismatchError);
    }
    expect(fake.calls).toEqual([]);
    expect(fake.configs).toEqual([]);
    // A matching pair is asked about as before, and nothing is saved.
    expect(await settings.testConnection(parsed(testEinvoiceConnectionSchema, { apiKey: "prod_typad", environment: "production" }))).toMatchObject({ accountId: "nav-test", environment: "production" });
    expect(callsOf("checkKey")).toHaveLength(1);
    expect(await settings.read()).toMatchObject({ apiKey: "test_key", environment: "sandbox" });
  });

  it.each([
    { apiKey: "prod_sparad", environment: "sandbox", owner: "production" },
    { apiKey: "test_sparad", environment: "production", owner: "sandbox" },
    { apiKey: "stag_sparad", environment: "production", owner: "staging" },
  ] as const)("en redan sparad felkombination ($apiKey under $environment) skickar aldrig", async ({ apiKey, environment, owner }) => {
    const invoice = await issuedInvoice(await makeCustomer());
    // Saved before the check existed.
    await setSetting("einvoice_api_key", apiKey);
    await setSetting("einvoice_environment", environment);

    await expect(settings.provider({ requireEnabled: false })).rejects.toMatchObject({ name: "EinvoiceKeyEnvironmentMismatchError", keyEnvironment: owner, selected: environment });
    await expect(settings.provider({ requireEnabled: true, requireAccount: true })).rejects.toBeInstanceOf(EinvoiceKeyEnvironmentMismatchError);
    await expect(einvoice.send(invoice.id, userId)).rejects.toBeInstanceOf(EinvoiceKeyEnvironmentMismatchError);
    expect(await db.select().from(einvoiceTransmissions)).toHaveLength(0);
    expect(fake.calls).toEqual([]);
    expect(fake.configs).toEqual([]);
    expect(await einvoiceEvents(invoice.id)).toEqual([]);

    // Kontrollera goes through the same provider().
    await expect(einvoice.lookup(invoice.customerId)).rejects.toBeInstanceOf(EinvoiceKeyEnvironmentMismatchError);
    expect(fake.calls).toEqual([]);
  });

  it("automatiken vid Utfärda med en sparad felkombination: fakturan utfärdas, inget skickas, händelsen säger varför", async () => {
    const customer = await makeCustomer({ invoiceDelivery: "peppol" });
    await setSetting("einvoice_api_key", "prod_sparad");
    const issued = await issueWithAutoSend(customer);
    expect(issued.status).toBe("issued");
    expect(issued.einvoiceAutoSend).toMatchObject({ status: "error", transmissionId: null });
    expect(issued.einvoiceAutoSend!.message).toBe("E-fakturan kunde inte skickas: Nyckeln hör till Produktion men Miljö är Sandbox — välj samma miljö som nyckeln");
    expect(await einvoiceEvents(issued.id)).toEqual([{ action: "einvoice_not_sent", detail: { reason: "error", auto: true, message: issued.einvoiceAutoSend!.message } }]);
    expect(await transmissionsOf(issued.id)).toHaveLength(0);
    expect(fake.calls).toEqual([]);
  });

  it("rutterna svarar 400 einvoice-key-environment-mismatch", async () => {
    const app = routesApp();
    const patch = await app.inject({ method: "PATCH", url: "/einvoice-settings", payload: { apiKey: "prod_ny", environment: "sandbox" } });
    expect(patch.statusCode).toBe(400);
    expect(patch.json()).toMatchObject({ code: "einvoice-key-environment-mismatch", keyEnvironment: "production", environment: "sandbox" });
    expect(patch.json().error).toContain("Nyckeln hör till Produktion men Miljö är Sandbox");
    expect(await setting("einvoice_api_key")).toBe("test_key");

    const staging = await app.inject({ method: "PATCH", url: "/einvoice-settings", payload: { apiKey: "stag_ny" } });
    expect(staging.statusCode).toBe(400);
    expect(staging.json()).toMatchObject({ code: "einvoice-key-environment-mismatch", keyEnvironment: "staging" });
    expect(staging.json().error).toContain("stag_");

    const test = await app.inject({ method: "POST", url: "/einvoice-settings/test", payload: { apiKey: "test_ny", environment: "production" } });
    expect(test.statusCode).toBe(400);
    expect(test.json()).toMatchObject({ code: "einvoice-key-environment-mismatch", keyEnvironment: "sandbox", environment: "production" });

    // A saved contradiction: Skicka e-faktura from the card.
    const invoice = await issuedInvoice(await makeCustomer());
    await setSetting("einvoice_api_key", "prod_sparad");
    const send = await app.inject({ method: "POST", url: `/invoices/${invoice.id}/einvoice`, payload: {} });
    expect(send.statusCode).toBe(400);
    expect(send.json()).toMatchObject({ code: "einvoice-key-environment-mismatch", keyEnvironment: "production", environment: "sandbox" });
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(einvoiceTransmissions)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("3. Spår när automatiken inte skickar (sendAfterIssue)", () => {
  it("(a) ett fel före sändningsraden — ubl-check underkänner — loggas som einvoice_not_sent med meddelande och problem", async () => {
    const customer = await makeCustomer({ invoiceDelivery: "peppol" });
    // Not Luhn-valid (SE-R-009): written directly, past the form.
    await db.update(companyInfo).set({ bankgiro: "1234-5678" });
    const issued = await issueWithAutoSend(customer);
    expect(issued.status).toBe("issued");
    expect(issued.invoiceNumber).not.toBeNull();
    const outcome = issued.einvoiceAutoSend!;
    expect(outcome).toMatchObject({ status: "error", reason: null, transmissionId: null, unavailable: false });
    expect(outcome.message).toMatch(/^E-fakturan kunde inte skickas: /);

    const events = await einvoiceEvents(issued.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("einvoice_not_sent");
    expect(events[0]!.detail).toEqual({
      auto: true,
      reason: "error",
      message: outcome.message,
      problems: ["Företagets bankgiro är ogiltigt (Företagsuppgifter)."],
    });
    expect(await transmissionsOf(issued.id)).toHaveLength(0);
    expect(callsOf("submit")).toEqual([]);

    // The same refusal from the card throws and logs nothing more.
    await expect(einvoice.send(issued.id, userId)).rejects.toBeInstanceOf(EinvoiceDocumentInvalidError);
    expect(await einvoiceEvents(issued.id)).toHaveLength(1);
  });

  it("(a) ett känt fel som send() inte loggat (redan skickad) får också sin einvoice_not_sent", async () => {
    const customer = await makeCustomer({ invoiceDelivery: "peppol" });
    const draft = await autoInvoiceService.create(serviceRow(customer), userId);
    const issued = (await autoInvoiceService.issue(draft!.id, userId))!;
    expect(issued.einvoiceAutoSend).toMatchObject({ status: "sent" });
    // Called once more by hand for an invoice that already has a live
    // transmission: einvoice-already-sent is a known error send() logged
    // nothing for.
    const again = await einvoice.sendAfterIssue(issued.id, userId);
    expect(again).toMatchObject({ status: "error", transmissionId: null });
    const events = await einvoiceEvents(issued.id);
    expect(events.map((e) => e.action)).toEqual(["einvoice_sent", "einvoice_not_sent"]);
    expect(events[1]!.detail).toMatchObject({ auto: true, reason: "error", message: again!.message });
    expect(callsOf("submit")).toHaveLength(1);
  });

  it("(b) accesspunkten avvisar dokumentet: bara einvoice_failed — inget loggas två gånger", async () => {
    const customer = await makeCustomer({ invoiceDelivery: "peppol" });
    fake.state.importError = refused("B2Brouter avvisade dokumentet: Invalid buyer", ["Invalid buyer"]);
    const issued = await issueWithAutoSend(customer);
    expect(issued.status).toBe("issued");
    expect(issued.einvoiceAutoSend).toMatchObject({ status: "error", reason: null, transmissionId: null, unavailable: false });
    expect(issued.einvoiceAutoSend!.message).toContain("E-fakturan kunde inte skickas: B2Brouter avvisade dokumentet");
    const rows = await transmissionsOf(issued.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", providerInvoiceId: null });
    const events = await einvoiceEvents(issued.id);
    expect(events.map((e) => e.action)).toEqual(["einvoice_failed"]);
    expect(events[0]!.detail).toMatchObject({ auto: true, kind: "validation", transmissionId: rows[0]!.id });
  });

  it("(b) importen gick igenom men sändningen svarade inte: raden lever kvar, einvoice_failed en gång, unavailable på utfallet", async () => {
    const customer = await makeCustomer({ invoiceDelivery: "peppol" });
    fake.state.sendError = unavailable();
    const issued = await issueWithAutoSend(customer);
    expect(issued.einvoiceAutoSend).toMatchObject({ status: "error", unavailable: true });
    const rows = await transmissionsOf(issued.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "sending", providerInvoiceId: expect.stringMatching(/^\d+$/) });
    expect((await einvoiceEvents(issued.id)).map((e) => e.action)).toEqual(["einvoice_failed"]);
  });

  it("(c) ett vanligt Error i submit: raden failed med den fasta texten, einvoice_failed kind unexpected, aldrig felets egen text", async () => {
    const customer = await makeCustomer({ invoiceDelivery: "peppol" });
    fake.state.importError = new Error("connect ECONNREFUSED 10.0.0.7:5432 hemlig-detalj");
    const issued = await issueWithAutoSend(customer);
    expect(issued.status).toBe("issued");
    expect(issued.einvoiceAutoSend).toMatchObject({ status: "error", reason: null, transmissionId: null, unavailable: false });
    expect(issued.einvoiceAutoSend!.message).toBe("E-fakturan kunde inte skickas: oväntat fel — se fakturakortet");

    const rows = await transmissionsOf(issued.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "failed", errorMessage: UNEXPECTED_SEND_MESSAGE, providerInvoiceId: null });
    expect(rows[0]!.statusUpdatedAt?.toISOString()).toBe(clock.toISOString());

    const events = await einvoiceEvents(issued.id);
    expect(events).toEqual([{ action: "einvoice_failed", detail: { transmissionId: rows[0]!.id, kind: "unexpected", reason: UNEXPECTED_SEND_MESSAGE, auto: true } }]);
    // The internal text reaches the server log only.
    expect(JSON.stringify([rows[0]!.errorMessage, events, issued.einvoiceAutoSend])).not.toContain("hemlig-detalj");
    expect(serviceLogged.map((l) => l.msg)).toContain("E-invoice send failed outside the access point");
    expect(JSON.stringify(serviceLogged)).toContain("hemlig-detalj");

    // Failed is terminal: Skicka e-faktura from the card works afterwards.
    fake.state.importError = null;
    expect(await einvoice.send(issued.id, userId)).toMatchObject({ status: "sent" });
  });

  it("(c) från fakturakortet: samma fasta text, utan auto, och felet kastas vidare", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    fake.state.importError = new Error("boom");
    await expect(einvoice.send(invoice.id, userId)).rejects.toThrow("boom");
    const [row] = await transmissionsOf(invoice.id);
    expect(row).toMatchObject({ status: "failed", errorMessage: UNEXPECTED_SEND_MESSAGE });
    expect(await einvoiceEvents(invoice.id)).toEqual([{ action: "einvoice_failed", detail: { transmissionId: row!.id, kind: "unexpected", reason: UNEXPECTED_SEND_MESSAGE } }]);
  });

  it("(c) ett fel i onImported — efter importen — ger samma fasta text och ingen einvoice_not_sent", async () => {
    const customer = await makeCustomer({ invoiceDelivery: "peppol" });
    // The fake calls onImported like the real adapter; a failure there (the
    // database, say) is no answer from the access point.
    fake.provider.submit = (doc, opts) =>
      originalSubmit(doc, {
        ...opts,
        onImported: async () => {
          throw new Error("db down i onImported");
        },
      });
    const issued = await issueWithAutoSend(customer);
    expect(issued.einvoiceAutoSend).toMatchObject({ status: "error", transmissionId: null });
    const rows = await transmissionsOf(issued.id);
    expect(rows[0]).toMatchObject({ status: "failed", errorMessage: UNEXPECTED_SEND_MESSAGE });
    expect((await einvoiceEvents(issued.id)).map((e) => e.action)).toEqual(["einvoice_failed"]);
  });

  it("(d) slutskrivningen är villkorad på sending: en rad webhooken redan gjort delivered skrivs inte tillbaka", async () => {
    const customer = await makeCustomer({ invoiceDelivery: "peppol" });
    const hookAt = new Date("2030-03-04T09:00:05Z");
    // The web hook's poll lands between the access point's answer and the
    // send's own final write.
    fake.provider.submit = async (doc, opts) => {
      const result = await originalSubmit(doc, opts);
      await db
        .update(einvoiceTransmissions)
        .set({ status: "delivered", providerState: "registered", sentAt: hookAt, statusUpdatedAt: hookAt, lastPolledAt: hookAt })
        .where(eq(einvoiceTransmissions.providerInvoiceId, result.providerInvoiceId));
      return result;
    };
    const issued = await issueWithAutoSend(customer);
    const rows = await transmissionsOf(issued.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "delivered", providerState: "registered", errorMessage: null });
    expect(rows[0]!.sentAt?.toISOString()).toBe(hookAt.toISOString());
    expect(rows[0]!.statusUpdatedAt?.toISOString()).toBe(hookAt.toISOString());
    expect(issued.einvoiceAutoSend).toMatchObject({ status: "delivered", transmissionId: rows[0]!.id });
    // Sent, and said so once — never "not sent" or failed.
    expect((await einvoiceEvents(issued.id)).map((e) => e.action)).toEqual(["einvoice_sent"]);
  });

  it("(d) även från fakturakortet, och när jobbet hunnit skriva sent i onImported-steget", async () => {
    const invoice = await issuedInvoice(await makeCustomer());
    const jobAt = new Date("2030-03-04T09:00:02Z");
    fake.state.submitState = "sending";
    fake.provider.submit = (doc, opts) =>
      originalSubmit(doc, {
        ...opts,
        onImported: async (id) => {
          await opts!.onImported!(id);
          await db.update(einvoiceTransmissions).set({ status: "sent", providerState: "sent", sentAt: jobAt }).where(eq(einvoiceTransmissions.providerInvoiceId, id));
        },
      });
    // The access point's answer to the send is the older "sending".
    const view = await einvoice.send(invoice.id, userId);
    expect(view).toMatchObject({ status: "sent", providerState: "sent" });
    const [row] = await transmissionsOf(invoice.id);
    expect(row).toMatchObject({ status: "sent", providerState: "sent" });
    expect(row!.sentAt?.toISOString()).toBe(jobAt.toISOString());
  });
});

// ---------------------------------------------------------------------------

describe("4. Samlingsfaktureringen när B2Brouter inte svarar", () => {
  // A delivered order row for a samlingsfaktura customer.
  async function deliveredOrder(customer: Customer) {
    const article = await articleService.createArticle(
      parsed(createArticleSchema, { articleNumber: `EG-${crypto.randomUUID().slice(0, 8)}`, name: "Diskbänk", type: "manufactured", active: true })
    );
    const warehouse = await stockService.createWarehouse({ name: `Lager ${crypto.randomUUID().slice(0, 6)}`, active: true });
    const location = await stockService.createLocation(parsed(createStockLocationSchema, { warehouseId: warehouse!.id, name: "A1", active: true }));
    await stockService.recordTransaction({ articleId: article.id, locationId: location.id, quantityDelta: 10, transactionType: "inventory_adjustment" });
    const { order, rows } = await salesService.createQuote(
      parsed(createQuoteSchema, { customerId: customer.id, customerOrderNumber: "PO-1", rows: [{ articleId: article.id, quantity: 1, unitPrice: 500 }], confirm: true }),
      userId
    );
    await salesService.startProduction(order.id);
    await salesService.deliverGoods(order.id, rows[0]!.id, { locationId: location.id, quantity: 1 }, userId);
  }

  it("slutar vänta efter första unavailable: nästa faktura utfärdas utan anrop och får einvoice_not_sent provider-unavailable", async () => {
    const first = await makeCustomer({ name: "Första AB", orgNumber: "5565555553", invoiceDelivery: "peppol", collectiveInvoicing: true });
    const second = await makeCustomer({ name: "Andra AB", orgNumber: "5561234567", invoiceDelivery: "peppol", collectiveInvoicing: true });
    const third = await makeCustomer({ name: "Tredje AB", orgNumber: "5569990004", invoiceDelivery: "peppol", collectiveInvoicing: true });
    for (const customer of [first, second, third]) await deliveredOrder(customer);
    // B2Brouter does not answer — for anyone, had it been asked again.
    fake.state.importError = unavailable();

    const { results } = await autoInvoiceService.runCollectiveInvoicing(parsed(runCollectiveInvoicingSchema, { customerIds: [first.id, second.id, third.id], issue: true }), userId);
    expect(results.map((r) => [r.customerId, r.status, r.error])).toEqual([
      [first.id, "issued", null],
      [second.id, "issued", null],
      [third.id, "issued", null],
    ]);

    // The first: asked, no answer.
    expect(results[0]!.einvoice).toMatchObject({ status: "error", unavailable: true, transmissionId: null });
    expect(results[0]!.einvoice!.message).toBe("E-fakturan kunde inte skickas: B2Brouter svarar inte, försök igen");
    // The others: not asked at all.
    for (const result of results.slice(1)) {
      expect(result.einvoice).toEqual({ status: "error", reason: null, transmissionId: null, message: PROVIDER_DOWN_MESSAGE, unavailable: true });
    }
    expect(callsOf("submit")).toHaveLength(1);
    expect(fake.calls.map((c) => c.method)).toEqual(["submit"]);

    // All three are issued invoices with a number.
    for (const result of results) {
      const [invoice] = await db.select().from(invoices).where(eq(invoices.id, result.invoiceId!));
      expect(invoice).toMatchObject({ status: "issued", invoiceNumber: result.invoiceNumber });
      expect(result.invoiceNumber).not.toBeNull();
    }

    // The trace: the first has its failed transmission, the others the
    // event that says nothing was sent — and no transmission row.
    const firstRows = await transmissionsOf(results[0]!.invoiceId!);
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({ status: "failed" });
    expect((await einvoiceEvents(results[0]!.invoiceId!)).map((e) => e.action)).toEqual(["einvoice_failed"]);
    for (const result of results.slice(1)) {
      expect(await einvoiceEvents(result.invoiceId!)).toEqual([{ action: "einvoice_not_sent", detail: { reason: "provider-unavailable", auto: true, message: PROVIDER_DOWN_MESSAGE } }]);
      expect(await transmissionsOf(result.invoiceId!)).toHaveLength(0);
    }
  });

  it("ett annat fel än unavailable stoppar inte de följande, och en e-postkund hoppas över utan att räknas", async () => {
    const first = await makeCustomer({ name: "Första AB", orgNumber: "5565555553", invoiceDelivery: "peppol", collectiveInvoicing: true });
    const email = await makeCustomer({ name: "Mejl AB", orgNumber: "5561234567", collectiveInvoicing: true });
    const third = await makeCustomer({ name: "Tredje AB", orgNumber: "5569990004", invoiceDelivery: "peppol", collectiveInvoicing: true });
    for (const customer of [first, email, third]) await deliveredOrder(customer);
    // Refused once (a validation answer is an answer), then accepted.
    fake.state.importError = refused("B2Brouter avvisade dokumentet: Invalid buyer");
    fake.provider.submit = async (doc, opts) => {
      try {
        return await originalSubmit(doc, opts);
      } finally {
        fake.state.importError = null;
      }
    };
    const { results } = await autoInvoiceService.runCollectiveInvoicing(parsed(runCollectiveInvoicingSchema, { customerIds: [first.id, email.id, third.id], issue: true }), userId);
    expect(results.map((r) => r.status)).toEqual(["issued", "issued", "issued"]);
    expect(results[0]!.einvoice).toMatchObject({ status: "error", unavailable: false });
    expect(results[1]!.einvoice).toBeNull();
    expect(results[2]!.einvoice).toMatchObject({ status: "sent" });
    expect(callsOf("submit")).toHaveLength(2);
  });

  it("en egen Utfärda efter körningen väntar på B2Brouter igen — flaggan lever bara i körningen", async () => {
    const first = await makeCustomer({ name: "Första AB", orgNumber: "5565555553", invoiceDelivery: "peppol", collectiveInvoicing: true });
    await deliveredOrder(first);
    fake.state.importError = unavailable();
    const run1 = await autoInvoiceService.runCollectiveInvoicing(parsed(runCollectiveInvoicingSchema, { customerIds: [first.id], issue: true }), userId);
    expect(run1.results[0]!.einvoice).toMatchObject({ unavailable: true });
    fake.state.importError = null;
    const second = await makeCustomer({ name: "Andra AB", orgNumber: "5561234567", invoiceDelivery: "peppol", collectiveInvoicing: true });
    await deliveredOrder(second);
    const run2 = await autoInvoiceService.runCollectiveInvoicing(parsed(runCollectiveInvoicingSchema, { customerIds: [second.id], issue: true }), userId);
    expect(run2.results[0]!.einvoice).toMatchObject({ status: "sent" });
    expect(callsOf("submit")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("5. Kontrollera med tömt fält", () => {
  it("null = fältet tömt ⇒ det härledda id:t; utelämnat ⇒ det sparade; ifyllt ⇒ det ifyllda", async () => {
    // The saved Peppol-id is another organisation's than the customer's own
    // number gives.
    const customer = await makeCustomer({ orgNumber: "556555-5553", peppolId: "0007:5560000000" });

    const emptied = await einvoice.lookup(customer.id, parsed(peppolLookupSchema, { peppolId: null }));
    expect(emptied).toMatchObject({ peppolId: "0007:5565555553", source: "org-number", found: true });
    expect(fake.calls.at(-1)).toEqual({ method: "lookupParticipant", args: ["0007", "5565555553", "SE"] });

    const saved = await einvoice.lookup(customer.id, parsed(peppolLookupSchema, {}));
    expect(saved).toMatchObject({ peppolId: "0007:5560000000", source: "customer" });
    expect(fake.calls.at(-1)).toEqual({ method: "lookupParticipant", args: ["0007", "5560000000", "SE"] });
    // No input at all is the saved one too.
    await einvoice.lookup(customer.id);
    expect(fake.calls.at(-1)).toEqual({ method: "lookupParticipant", args: ["0007", "5560000000", "SE"] });

    const typed = await einvoice.lookup(customer.id, parsed(peppolLookupSchema, { peppolId: "0088:7350000000009" }));
    expect(typed).toMatchObject({ peppolId: "0088:7350000000009", source: "customer" });
    expect(fake.calls.at(-1)).toEqual({ method: "lookupParticipant", args: ["0088", "7350000000009", "SE"] });

    expect(callsOf("lookupParticipant")).toHaveLength(4);
    // Nothing of it was stored.
    expect((await salesService.getCustomer(customer.id))!.peppolId).toBe("0007:5560000000");
  });

  it("genom rutten: webbens tomma fält ('' ⇒ null) frågar om det härledda, och utan härlett id görs inget anrop", async () => {
    const customer = await makeCustomer({ orgNumber: "556555-5553", peppolId: "0007:5560000000" });
    const app = routesApp();
    for (const peppolId of ["", null]) {
      const res = await app.inject({ method: "POST", url: `/customers/${customer.id}/peppol-lookup`, payload: { peppolId } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ peppolId: "0007:5565555553", source: "org-number" });
      expect(fake.calls.at(-1)).toEqual({ method: "lookupParticipant", args: ["0007", "5565555553", "SE"] });
    }
    const none = await app.inject({ method: "POST", url: `/customers/${customer.id}/peppol-lookup`, payload: {} });
    expect(none.json()).toMatchObject({ peppolId: "0007:5560000000", source: "customer" });

    // A German customer with a saved id: emptied, nothing can be derived —
    // the answer says so and the saved id is not asked about.
    const tysk = await makeCustomer({ country: "DE", orgNumber: "HRB 12345", peppolId: "9930:DE123456789" });
    fake.calls.length = 0;
    const emptied = await einvoice.lookup(tysk.id, parsed(peppolLookupSchema, { peppolId: null }));
    expect(emptied).toMatchObject({ peppolId: null, source: null, found: null });
    expect(fake.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("6. Samma PDF på två e-fakturor", () => {
  it("(a) två dokument med olika nummer och samma bifogade PDF blir två inkorgsposter — den andra med visningskopian", async () => {
    await makeSupplier();
    const firstId = fake.receive(invoiceXml());
    const secondId = fake.receive(invoiceXml({ invoiceNumber: "FA-1002" }));
    expect(await runReceive()).toMatchObject({ listed: 2, imported: 2, duplicates: 0, unreadable: 0, ackFailed: 0, error: null });

    const [first, second] = await scans();
    expect(await scans()).toHaveLength(2);
    expect(first).toMatchObject({ source: "einvoice", filename: "Faktura-FA-1001.pdf" });
    expect(first!.data!.equals(FAKE_PDF)).toBe(true);
    expect(second).toMatchObject({ source: "einvoice", filename: "Visningskopia-FA-1002.pdf", contentType: "application/pdf" });
    expect(second!.data!.equals(FAKE_PDF)).toBe(false);
    expect(second!.sha256).not.toBe(first!.sha256);
    const text = pdfText(second!.data!);
    expect(text).toContain(EINVOICE_COPY_TITLE);
    expect(text).toContain("FA-1002");
    expect(text).toContain(first!.scanNumber);

    const rows = await receptions();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ providerInvoiceId: firstId, documentNumber: "FA-1001", outcome: "imported", detail: null, invoiceScanId: first!.id });
    expect(rows[1]).toMatchObject({ providerInvoiceId: secondId, documentNumber: "FA-1002", outcome: "imported", detail: RECEIVE_TEXTS.sharedPdf(first!.scanNumber), invoiceScanId: second!.id });
    expect(rows[1]!.detail).toBe(`Den bifogade PDF:en finns redan i inkorgen (${first!.scanNumber}) för en annan e-faktura — visningskopian används`);
    expect(fake.state.received.get(firstId)!.acked).toBe(true);
    expect(fake.state.received.get(secondId)!.acked).toBe(true);
    // The FI numbers are consecutive: the refused first attempt burned none.
    expect(Number(second!.scanNumber.slice(3))).toBe(Number(first!.scanNumber.slice(3)) + 1);
    // The embedded PDF is still served from the second document's XML.
    const detail = await scanService.get(second!.id);
    expect(detail.einvoice?.attachments[0]).toMatchObject({ index: 0, sizeBytes: FAKE_PDF.length });

    // The same second document once more is the ordinary duplicate.
    const again = fake.receive(invoiceXml({ invoiceNumber: "FA-1002" }));
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(await runReceive()).toMatchObject({ imported: 0, duplicates: 1 });
    expect((await receptions())[2]).toMatchObject({ providerInvoiceId: again, outcome: "duplicate", detail: `Samma faktura finns redan i inkorgen (${second!.scanNumber})`, invoiceScanId: second!.id });
    expect(await scans()).toHaveLength(2);
  });

  it("(a) samma nummer och samma PDF från en ANNAN avsändare är också en egen faktura", async () => {
    await makeSupplier();
    fake.receive(invoiceXml());
    const otherSender = fake.receive(Buffer.from(invoiceXml().toString("utf8").replace('<cbc:EndpointID schemeID="0007">5566778899</cbc:EndpointID>', '<cbc:EndpointID schemeID="0007">5561234567</cbc:EndpointID>'), "utf8"));
    expect(await runReceive()).toMatchObject({ listed: 2, imported: 2, duplicates: 0 });
    const [first, second] = await scans();
    expect(second!.filename).toBe("Visningskopia-FA-1001.pdf");
    const rows = await receptions();
    expect(rows.map((r) => r.senderEndpoint)).toEqual(["0007:5566778899", "0007:5561234567"]);
    expect(rows[1]).toMatchObject({ providerInvoiceId: otherSender, outcome: "imported", detail: RECEIVE_TEXTS.sharedPdf(first!.scanNumber) });
  });

  it("(b) samma PDF som en uppladdad inkorgspost är fortfarande en dubblett", async () => {
    await makeSupplier();
    const uploaded = await scanService.upload([{ filename: "Skannad.pdf", contentType: "application/pdf", data: FAKE_PDF, truncated: false }], userId);
    expect(uploaded.created).toHaveLength(1);
    expect(uploaded.rejected).toEqual([]);
    const [post] = await scans();
    expect(post).toMatchObject({ source: "upload" });

    const id = fake.receive(invoiceXml());
    expect(await runReceive()).toMatchObject({ listed: 1, imported: 0, duplicates: 1 });
    expect(await scans()).toHaveLength(1);
    const [row] = await receptions();
    expect(row).toMatchObject({ providerInvoiceId: id, outcome: "duplicate", detail: `Filen fanns redan i inkorgen (${post!.scanNumber})`, invoiceScanId: post!.id });
    expect(fake.state.received.get(id)!.acked).toBe(true);
  });

  it("(c) samma dokument utan EndpointID en annan dag: visningskopian har samma sha256 och blir en dubblett", async () => {
    await makeSupplier();
    // No endpoint ⇒ never matched on sender + number; no attachment ⇒ the
    // post's file is the rendered copy.
    const document = () => Buffer.from(invoiceXml({ attachment: null }).toString("utf8").replace('<cbc:EndpointID schemeID="0007">5566778899</cbc:EndpointID>', ""), "utf8");
    const firstId = fake.receive(document());
    expect(await runReceive()).toMatchObject({ imported: 1, duplicates: 0 });
    const [post] = await scans();
    expect(post!.filename).toBe("Visningskopia-FA-1001.pdf");

    // Three days later (another Stockholm day, another clock in the service).
    clock = new Date("2030-03-07T22:30:00Z");
    const secondId = fake.receive(document());
    expect(await runReceive()).toMatchObject({ listed: 1, imported: 0, duplicates: 1 });
    expect(await scans()).toHaveLength(1);
    const rows = await receptions();
    expect(rows.map((r) => r.senderEndpoint)).toEqual([null, null]);
    expect(rows[0]).toMatchObject({ providerInvoiceId: firstId, outcome: "imported" });
    expect(rows[1]).toMatchObject({ providerInvoiceId: secondId, outcome: "duplicate", detail: `Filen fanns redan i inkorgen (${post!.scanNumber})`, invoiceScanId: post!.id });
    expect(rows[1]!.receivedAt.toISOString()).toBe(clock.toISOString());
    expect(fake.state.received.get(secondId)!.acked).toBe(true);
  });

  it("(c) ett ANNAT dokument utan EndpointID med samma nummer men annat innehåll kommer fortfarande in", async () => {
    await makeSupplier();
    const noEndpoint = (over: Partial<ReturnType<typeof invoiceTwoRatesDiscount>>) =>
      Buffer.from(invoiceXml(over).toString("utf8").replace('<cbc:EndpointID schemeID="0007">5566778899</cbc:EndpointID>', ""), "utf8");
    fake.receive(noEndpoint({ attachment: null }));
    await runReceive();
    fake.receive(noEndpoint({ attachment: null, note: "Rättad" }));
    clock = new Date(clock.getTime() + 3 * 24 * 60 * 60_000);
    expect(await runReceive()).toMatchObject({ imported: 1, duplicates: 0 });
    expect(await scans()).toHaveLength(2);
  });
});
