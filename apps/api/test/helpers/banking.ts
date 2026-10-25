import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify, { type FastifyPluginAsync } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { eq, like, sql } from "drizzle-orm";
import { ZodError } from "zod";
import {
  accountingPeriods,
  bankFileEntries,
  bankFiles,
  companyInfo,
  customers,
  db,
  invoiceRows,
  invoices,
  paymentBatchItems,
  paymentBatches,
  suppliers,
  supplierInvoices,
  systemSettings,
  type BankEntryReference,
} from "@navet/db";
import { createAuthRepository } from "../../src/modules/auth/repository/auth.repository.js";
import { createBankFileRepository } from "../../src/modules/banking/repository/bank-file.repository.js";
import { createBankSettingsRepository } from "../../src/modules/banking/repository/bank-settings.repository.js";
import { createPaymentBatchRepository } from "../../src/modules/banking/repository/payment-batch.repository.js";
import { createBankFileService } from "../../src/modules/banking/service/bank-file.service.js";
import { createBankReconciliationRepository } from "../../src/modules/banking/repository/bank-reconciliation.repository.js";
import { createBankReconciliationService } from "../../src/modules/banking/service/bank-reconciliation.service.js";
import { createBankSettingsService } from "../../src/modules/banking/service/bank-settings.service.js";
import { createPaymentBatchService } from "../../src/modules/banking/service/payment-batch.service.js";
import { createVerificationPoster } from "../../src/modules/economy/service/verification-poster.js";
import { createSupplierPaymentRepository } from "../../src/modules/purchase/repository/supplier-payment.repository.js";
import { createSupplierPaymentService } from "../../src/modules/purchase/service/supplier-payment.service.js";
import { createPaymentRepository } from "../../src/modules/sales/repository/payment.repository.js";
import { createPaymentService } from "../../src/modules/sales/service/payment.service.js";
import { createAuditRepository } from "../../src/modules/system/repository/audit.repository.js";
import { readPostingSettings } from "../../src/modules/system/service/posting-settings.js";
import { BAS_STANDARD_ACCOUNTS } from "../../src/modules/economy/service/bas-accounts.js";
import { rejectMalformedIds } from "../../src/modules/system/middleware/reject-malformed-ids.js";
import { isBookkeepingLockViolation } from "../../src/modules/system/service/db-errors.js";
import { computeOcrNumber } from "../../src/modules/system/service/ocr.js";
import { ExchangeRateUnavailableError } from "../../src/modules/system/service/exchange-rates.js";
import { toSek } from "@navet/shared";
import { DEFAULT_POSTING_SETTINGS, testEconomyRepository, testEconomyService, testSystemService } from "./services.js";
import { vatCodeId } from "./vat-codes.js";

// Fixed, long-past year and a fixed clock: no banking test depends on the
// real calendar (month boundaries, Stockholm vs UTC midnight). The clock is
// injected into every banking service (`now`); CLOCK is 12:00 in Stockholm.
export const BANK_YEAR = 2024;
export const CLOCK = new Date("2024-10-09T10:00:00Z");
export const TODAY = "2024-10-09";

// number_series is never truncated (seed rows). The banking tables come
// first; CASCADE reaches everything else that references these.
export const BANKING_TRUNCATE = sql`TRUNCATE bank_match_rows, bank_match_entries, bank_matches, bank_reconciliations, bank_statement_entries, bank_statements, bank_accounts, bank_rules, bank_file_entries, bank_files, payment_batch_items, payment_batches, invoice_reminders, customer_payment_rows, customer_payments, invoice_rows, invoices, customers, supplier_payment_rows, supplier_payments, supplier_invoice_rows, supplier_invoices, suppliers, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

export async function resetBanking() {
  await db.execute(BANKING_TRUNCATE);
}

export async function setupBanking() {
  const user = await createAuthRepository(db).create({
    email: `bank-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomi",
    role: "admin",
  });
  await testEconomyRepository.seedAccounts([...BAS_STANDARD_ACCOUNTS]);
  await testEconomyService.createFiscalYear({ label: String(BANK_YEAR), startDate: `${BANK_YEAR}-01-01`, endDate: `${BANK_YEAR}-12-31` });
  // system_settings survives the truncate — reset the roles and a 1 kr tolerance.
  await testSystemService.updateSettings({ ...DEFAULT_POSTING_SETTINGS, paymentTolerance: 1 });
  return { user };
}

export async function makeCustomer(name = "Kund AB") {
  const [row] = await db
    .insert(customers)
    .values({ name, customerNumber: `TEST-${crypto.randomUUID()}`, active: true })
    .returning();
  return row!;
}

// An issued customer invoice written straight to the tables (no F
// verification — like an invoice issued before B2): issue() always stamps
// today's date, which a fixed-year test cannot use. The open amount is derived
// from the rows only (open-amounts.ts), so this is a real open item.
export async function makeIssuedCustomerInvoice(
  customerId: string,
  input: { invoiceNumber: string; gross: number; type?: "invoice" | "credit"; dueDate?: string | null; customerName?: string }
) {
  const net = Math.round((Math.abs(input.gross) / 1.25) * 100) / 100;
  const vat = Math.round((Math.abs(input.gross) - net) * 100) / 100;
  const ocrNumber = computeOcrNumber(input.invoiceNumber);
  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber: input.invoiceNumber,
      type: input.type ?? "invoice",
      customerId,
      status: "issued",
      invoiceDate: `${BANK_YEAR}-09-01`,
      dueDate: input.dueDate === undefined ? `${BANK_YEAR}-10-01` : input.dueDate,
      ocrNumber,
      customerName: input.customerName ?? null,
      issuedAt: new Date(`${BANK_YEAR}-09-01T08:00:00Z`),
    })
    .returning();
  await db.insert(invoiceRows).values({
    invoiceId: invoice!.id,
    description: "Leverans",
    quantity: "1",
    unitPrice: String(net),
    vatRate: "25",
    vatCodeId: await vatCodeId("MP25"),
    lineAmount: String(net),
    vatAmount: String(vat),
  });
  return { id: invoice!.id, invoiceNumber: input.invoiceNumber, ocrNumber };
}

export async function makeSupplier(input: Partial<typeof suppliers.$inferInsert> = {}) {
  const [row] = await db
    .insert(suppliers)
    .values({ name: "Leverantör AB", supplierNumber: `TEST-${crypto.randomUUID()}`, currency: "SEK", active: true, ...input })
    .returning();
  return row!;
}

// An attested supplier invoice written straight to the table (no L
// verification), so the open item exists without a posting in the current
// calendar year.
export async function makeApprovedSupplierInvoice(
  supplierId: string,
  input: {
    registrationNumber: string;
    gross: number;
    dueDate?: string | null;
    invoiceDate?: string;
    invoiceNumber?: string;
    paymentReferenceKind?: "ocr" | "message" | null;
    paymentReference?: string | null;
    // Valuta: an invoice in another currency, attested at `exchangeRate`.
    currency?: string;
    exchangeRate?: number;
  }
) {
  const currency = input.currency ?? "SEK";
  const rate = currency === "SEK" ? 1 : input.exchangeRate ?? 11.131;
  const [row] = await db
    .insert(supplierInvoices)
    .values({
      registrationNumber: input.registrationNumber,
      invoiceNumber: input.invoiceNumber ?? `INV-${crypto.randomUUID().slice(0, 8)}`,
      supplierId,
      vatCodeId: await vatCodeId("MP25"),
      invoiceDate: input.invoiceDate ?? `${BANK_YEAR}-09-15`,
      dueDate: input.dueDate === undefined ? `${BANK_YEAR}-10-15` : input.dueDate,
      currency,
      exchangeRate: String(rate),
      exchangeRateSource: currency === "SEK" ? null : "manual",
      status: "approved",
      netAmount: String(Math.round((input.gross / 1.25) * 100) / 100),
      vatAmount: String(Math.round((input.gross - input.gross / 1.25) * 100) / 100),
      grossAmount: String(input.gross),
      // Valuta: an attested invoice carries its SEK debt.
      grossAmountSek: String(currency === "SEK" ? input.gross : toSek(input.gross, rate)),
      paymentReferenceKind: input.paymentReferenceKind ?? null,
      paymentReference: input.paymentReference ?? null,
    })
    .returning();
  return row!;
}

let fixtureCounter = 0;

// A batch with one row, written straight to the tables (Task 7 builds the
// service; this lets Task 3 test the reservation guards without it).
export async function makeBatchItem(input: {
  supplierInvoiceId: string;
  supplierId: string;
  amount: number;
  status?: "pending" | "exported" | "confirmed";
  batchNumber?: string;
}) {
  fixtureCounter += 1;
  const batchNumber = input.batchNumber ?? `BO-T${fixtureCounter}`;
  const status = input.status ?? "exported";
  const [batch] = await db
    .insert(paymentBatches)
    .values({ batchNumber, bankAccountNumber: "1930", status: status === "pending" ? "draft" : "exported" })
    .returning();
  const [item] = await db
    .insert(paymentBatchItems)
    .values({
      batchId: batch!.id,
      seq: 1,
      endToEndId: `${batchNumber}-1`,
      supplierInvoiceId: input.supplierInvoiceId,
      supplierId: input.supplierId,
      amount: String(input.amount),
      executionDate: `${BANK_YEAR}-10-15`,
      status,
    })
    .returning();
  return { batch: batch!, item: item! };
}

// One incoming bank file with one entry, written straight to the tables.
export async function makeBankEntry(input: {
  direction: "credit" | "debit";
  amount: number;
  endToEndId?: string | null;
  reversal?: boolean;
  bookingDate?: string;
  counterpartyName?: string | null;
  remittance?: BankEntryReference[];
  dedupeKey?: string;
  dedupeSource?: "tx_acct_svcr_ref" | "clr_sys_ref" | "entry_ref" | "content_hash";
  // Valuta steg 2: a payment in another currency from the SEK account.
  instructedAmount?: number;
  instructedCurrency?: string;
  chargesAmount?: number;
}) {
  fixtureCounter += 1;
  const data = Buffer.from(`fixture-${fixtureCounter}-${crypto.randomUUID()}`);
  const [file] = await db
    .insert(bankFiles)
    .values({
      direction: "incoming",
      messageType: "camt.054.001.02",
      filename: `fixture-${fixtureCounter}.xml`,
      contentType: "application/xml",
      sizeBytes: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      data,
      entryCount: 1,
    })
    .returning();
  const [entry] = await db
    .insert(bankFileEntries)
    .values({
      bankFileId: file!.id,
      dedupeKey: input.dedupeKey ?? `test:${crypto.randomUUID()}`,
      dedupeSource: input.dedupeSource ?? "tx_acct_svcr_ref",
      direction: input.direction,
      reversal: input.reversal ?? false,
      account: "5512348",
      amount: String(input.amount),
      currency: "SEK",
      bookingDate: input.bookingDate ?? TODAY,
      endToEndId: input.endToEndId ?? null,
      counterpartyName: input.counterpartyName ?? null,
      remittance: input.remittance ?? [],
      position: 0,
      instructedAmount: input.instructedAmount === undefined ? null : String(input.instructedAmount),
      instructedCurrency: input.instructedCurrency ?? null,
      chargesAmount: input.chargesAmount === undefined ? null : String(input.chargesAmount),
    })
    .returning();
  return { file: file!, entry: entry! };
}

// BO-7 -> 7, UTB-31 -> 31.
export function numericPart(documentNumber: string): number {
  return Number(documentNumber.replace(/^\D+/, "").split("-").pop());
}

export async function resetBankSettings() {
  await db.delete(systemSettings).where(like(systemSettings.key, "bank_%"));
}

// company_info is a shared singleton other suites read — every banking
// suite snapshots it in beforeAll and restores it in afterAll.
export async function snapshotCompany(): Promise<() => Promise<void>> {
  const [row] = await db.select().from(companyInfo).limit(1);
  return async () => {
    await db
      .update(companyInfo)
      .set({ name: row!.name, orgNumber: row!.orgNumber, postalCode: row!.postalCode, city: row!.city, iban: row!.iban, bic: row!.bic, bankgiro: row!.bankgiro, plusgiro: row!.plusgiro });
  };
}

export async function configureSwedbank() {
  await db
    .update(companyInfo)
    .set({ name: "Exempel Verkstad AB", orgNumber: "556677-8899", postalCode: "802 22", city: "Gävle", bankgiro: "551-2348", iban: null, plusgiro: null });
  for (const [key, value] of [
    ["bank_profile", "swedbank"],
    ["bank_initiating_party_id", "123456789123B001"],
    ["bank_debit_account_kind", "bankgiro"],
  ] as const) {
    await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
  }
}

// Mini-app over one banking route plugin, as the route suites build it: the
// id guard runs before the routes' own requirePermission, as in the real
// protected scope; `user` swaps the admin for e.g. a profile with only inkop.
export function buildRouteApp<O extends Record<string, unknown>>(
  plugin: FastifyPluginAsync<O>,
  opts: O,
  user: { id: string; role?: "admin" | "user"; permissions?: string[] }
) {
  const app = Fastify();
  app.register(fastifyMultipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    if (isBookkeepingLockViolation(err)) return reply.code(409).send({ error: err.message, code: "bookkeeping-record-locked" });
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: user.id, email: "test@example.com", name: "Testanvändare", role: user.role ?? "admin", permissions: user.permissions ?? [] } as never;
  });
  app.addHook("preHandler", rejectMalformedIds());
  app.register(plugin, opts);
  return app;
}

export const testPoster = createVerificationPoster({ read: readPostingSettings });
export const testSupplierPaymentService = createSupplierPaymentService(createSupplierPaymentRepository(db), testPoster, createAuditRepository(db));
export const testBankSettingsService = createBankSettingsService({ repo: createBankSettingsRepository(db), audit: createAuditRepository(db) });

// A fixed exchange rate table for the KU81 threshold — a currency missing
// from it answers ExchangeRateUnavailableError, like the real reader when
// Riksbanken has nothing.
export function fakeExchangeRates(rates: Record<string, number>, date = TODAY) {
  const asked: string[] = [];
  return {
    asked,
    async getRate(currency: string, requestedDate: string) {
      asked.push(`${currency} ${requestedDate}`);
      if (currency === "SEK") return { currency, requestedDate, date: requestedDate, rate: 1, source: null };
      const rate = rates[currency];
      if (rate === undefined) throw new ExchangeRateUnavailableError(currency, requestedDate);
      return { currency, requestedDate, date, rate, source: "riksbank" as const };
    },
  };
}

// The payment batch service as app.ts wires it, on the fixed CLOCK unless a
// test moves time (export/confirmation after the execution date). Without
// `exchangeRates` every payment abroad in another currency than SEK is
// reported (no rate = the safe side).
export function buildPaymentBatchService(now: () => Date = () => CLOCK, exchangeRates?: ReturnType<typeof fakeExchangeRates>) {
  return createPaymentBatchService({
    db,
    repo: createPaymentBatchRepository(db),
    bankSettings: testBankSettingsService,
    supplierPayments: testSupplierPaymentService,
    exchangeRates,
    now,
  });
}

// A supplier Swedbank can pay: bankgiro + town (Swedbank requires it).
export async function swedbankSupplier(overrides: Partial<typeof suppliers.$inferInsert> = {}) {
  return makeSupplier({ name: "Plåtlagret AB", postalCode: "753 20", city: "Uppsala", paymentMethod: "bankgiro", bankgiro: "50501055", ...overrides });
}

export async function periodStarting(date: string) {
  const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.startDate, date));
  return period!;
}

const testPaymentRepository = createPaymentRepository(db);
export const testPaymentService = createPaymentService(testPaymentRepository, testPoster, createAuditRepository(db));

// The bank file service as app.ts wires it, on the fixed CLOCK.
export function buildBankFileService(now: () => Date = () => CLOCK, exchangeRates?: ReturnType<typeof fakeExchangeRates>) {
  return createBankFileService({
    db,
    repo: createBankFileRepository(db),
    batches: buildPaymentBatchService(now, exchangeRates),
    customerPayments: testPaymentService,
    receivables: testPaymentRepository,
    company: createBankSettingsRepository(db),
    now,
  });
}

export function fixtureXml(name: string): string {
  return readFileSync(new URL(`../fixtures/iso20022/${name}`, import.meta.url), "utf8");
}

// A multipart body for app.inject — field "file", like the web upload.
export function multipartFile(filename: string, content: string | Buffer) {
  const boundary = "----navbankfiletest";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/xml\r\n\r\n`;
  const payload = Buffer.concat([Buffer.from(head), Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

// Bankavstämning (etapp 4): the reconciliation service as app.ts wires it.
export const testBankReconciliationRepository = createBankReconciliationRepository(db);
export function buildBankReconciliationService(now: () => Date = () => CLOCK) {
  return createBankReconciliationService({
    db,
    repo: testBankReconciliationRepository,
    economy: testEconomyService,
    settings: { read: readPostingSettings },
    company: createBankSettingsRepository(db),
    now,
  });
}

// A multipart body with text fields beside the file (bankAccountId,
// csvMapping, autoMatch) — the statement import's form.
export function multipartWithFields(filename: string, content: string | Buffer, fields: Record<string, string>, contentType = "application/xml") {
  const boundary = "----navbankstatementtest";
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
  parts.push(Buffer.isBuffer(content) ? content : Buffer.from(content));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
