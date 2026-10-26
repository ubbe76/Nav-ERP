import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { companyInfo, db, invoiceScans, supplierContacts, suppliers, systemSettings } from "@navet/db";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createInvoiceScanRepository } from "../src/modules/purchase/repository/invoice-scan.repository.js";
import {
  createInvoiceScanService,
  InvoiceScanAiNotConfiguredError,
  InvoiceScanBusyError,
  type UploadedFile,
} from "../src/modules/purchase/service/invoice-scan.service.js";
import {
  createInvoiceScanSettingsService,
  InvoiceScanAiTestFailedError,
} from "../src/modules/purchase/service/invoice-scan-settings.service.js";
import { InvalidStatusTransitionError } from "../src/modules/purchase/service/purchase.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";
import { createFakeInvoiceInterpreter, InvoiceInterpreterError, sampleAiFields } from "./helpers/fake-invoice-interpreter.js";
import { FAKE_BUYER, FAKE_SUPPLIER, imageOnlyPdf, invoicePdf, jpegImage } from "./helpers/invoice-pdf.js";

// Fakturaskanning steg 2 — the AI interpretation against the database,
// through the fake interpreter (never the network): Tolka med AI, the
// automatic mode, avsändarregeln, the reservation, a late answer after
// Avvisa/Skapa, the Swedish ai_error, the limits before a call, Testa
// anslutning. All data is made up.

const TODAY = "2026-10-15";
const audit = createAuditRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const supplierInvoiceService = createSupplierInvoiceService(
  createSupplierInvoiceRepository(db),
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  audit
);
const fake = createFakeInvoiceInterpreter();
const repo = createInvoiceScanRepository(db);
const settings = createInvoiceScanSettingsService({ repo, audit, interpreters: fake.factory });
const service = createInvoiceScanService({
  repo,
  supplierInvoices: supplierInvoiceService,
  company: systemService,
  settings,
  audit,
  interpreters: fake.factory,
  today: () => TODAY,
  log: () => {},
});
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE invoice_scan_hints, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, purchase_order_rows, purchase_orders, article_suppliers, supplier_contacts, suppliers, audit_log, users CASCADE`;

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
  fake.calls.length = 0;
  fake.tests.length = 0;
  fake.state.fields = sampleAiFields({ invoiceDate: { value: TODAY, confidence: "high" } });
  fake.state.truncated = false;
  fake.state.error = null;
  fake.state.testError = null;
  fake.state.gate = null;
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

async function enableAi(mode: "fallback" | "manual" | "off" = "manual", key: string | null = "sk-test-key") {
  await settings.update({ aiMode: mode, aiApiKey: key, aiModel: "claude-sonnet-5-5" }, userId);
}

async function upload(file: UploadedFile) {
  const result = await service.upload([file], userId);
  expect(result.created).toHaveLength(1);
  return result.created[0]!;
}
const pdf = async (data?: Buffer) => upload({ filename: "faktura.pdf", contentType: "application/pdf", data: data ?? (await invoicePdf()), truncated: false });
const jpeg = (data = jpegImage()) => upload({ filename: "foto.jpg", contentType: "image/jpeg", data, truncated: false });

async function row(id: string) {
  const [scan] = await db.select().from(invoiceScans).where(eq(invoiceScans.id, id));
  return scan!;
}

describe("aiAvailable", () => {
  it("is derived from the mode and the key", async () => {
    const scan = await jpeg();
    expect((await service.get(scan.id)).aiAvailable).toBe(false);
    await enableAi("manual", null);
    expect((await service.get(scan.id)).aiAvailable).toBe(false);
    await enableAi("manual");
    expect((await service.get(scan.id)).aiAvailable).toBe(true);
    await enableAi("off");
    expect((await service.get(scan.id)).aiAvailable).toBe(false);
  });
});

describe("Tolka med AI", () => {
  it("is refused without a key or in läge Av (409)", async () => {
    const scan = await jpeg();
    await expect(service.interpret(scan.id, "ai")).rejects.toBeInstanceOf(InvoiceScanAiNotConfiguredError);
    await enableAi("off");
    await expect(service.interpret(scan.id, "ai")).rejects.toBeInstanceOf(InvoiceScanAiNotConfiguredError);
    expect(fake.calls).toHaveLength(0);
  });

  it("interprets the file, matches locally and sends only the file and the company's name + orgnr", async () => {
    const supplier = await makeSupplier();
    await enableAi("manual");
    const scan = await jpeg();
    const detail = await service.interpret(scan.id, "ai");
    expect(detail).toMatchObject({ status: "interpreted", interpretedBy: "ai", aiError: null, aiStartedAt: null });
    expect(detail.result!.supplier).toMatchObject({ matchedSupplierId: supplier.id, matchedBy: "org_number" });
    expect(detail.result!.invoiceNumber).toEqual({ value: "AI-4711", confidence: "high", source: "ai" });
    expect(detail.result!.rows).toHaveLength(2);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.config).toEqual({ apiKey: "sk-test-key", model: "claude-sonnet-5-5" });
    expect(call.file.contentType).toBe("image/jpeg");
    expect(call.context).toEqual({ companyName: FAKE_BUYER.name, companyOrgNumber: FAKE_BUYER.orgNumber, today: TODAY });
  });

  it("goes through the duplicate check like the rules", async () => {
    const supplier = await makeSupplier();
    await enableAi("manual");
    const first = await jpeg();
    await service.convert(
      first.id,
      { supplierId: supplier.id, invoiceNumber: "AI-4711", invoiceDate: TODAY, netAmount: 1000, vatAmount: 250, grossAmount: 1250, rows: [] },
      userId
    );
    const scan = await jpeg(Buffer.concat([jpegImage(), Buffer.from([1])]));
    const detail = await service.interpret(scan.id, "ai");
    expect(detail.result!.duplicateOf).toMatchObject({ supplierInvoiceId: expect.any(String) });
  });

  it("lowers the AI's confidence when a local check fails — never raises it", async () => {
    await makeSupplier();
    await enableAi("manual");
    fake.state.fields = sampleAiFields({
      invoiceDate: { value: TODAY, confidence: "high" },
      grossAmount: { value: 1300, confidence: "high" },
      paymentReference: { value: "471100017", kind: "ocr", confidence: "high" },
    });
    const scan = await jpeg();
    const detail = await service.interpret(scan.id, "ai");
    expect(detail.result!.grossAmount.confidence).toBe("low");
    expect(detail.result!.netAmount.confidence).toBe("low");
    expect(detail.result!.paymentReference).toMatchObject({ value: { kind: "message" }, confidence: "low" });
    expect(detail.uncertain).toBe(true);
  });

  it("replaces a rules result on a PDF and keeps the text layer's facts", async () => {
    await makeSupplier();
    await enableAi("manual");
    const scan = await pdf();
    expect(scan.status).toBe("interpreted");
    const detail = await service.interpret(scan.id, "ai");
    expect(detail).toMatchObject({ interpretedBy: "ai", hasTextLayer: true, pageCount: 1 });
    expect(fake.calls[0]!.file.contentType).toBe("application/pdf");
  });

  it("answers 409 invoice-scan-busy while another AI call on the scan runs", async () => {
    await enableAi("manual");
    const scan = await jpeg();
    const gate = fake.hold();
    const first = service.interpret(scan.id, "ai");
    await gate.entered;
    await expect(service.interpret(scan.id, "ai")).rejects.toBeInstanceOf(InvoiceScanBusyError);
    gate.release();
    expect((await first).interpretedBy).toBe("ai");
    expect(fake.calls).toHaveLength(1);
  });

  it("takes over a stale reservation (a process that died mid-call)", async () => {
    await enableAi("manual");
    const scan = await jpeg();
    await db.update(invoiceScans).set({ aiStartedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(invoiceScans.id, scan.id));
    expect((await service.interpret(scan.id, "ai")).interpretedBy).toBe("ai");
    await db.update(invoiceScans).set({ aiStartedAt: new Date(Date.now() - 60_000) }).where(eq(invoiceScans.id, scan.id));
    await expect(service.interpret(scan.id, "ai")).rejects.toBeInstanceOf(InvoiceScanBusyError);
  });

  it("drops a late answer when the scan was rejected meanwhile", async () => {
    await enableAi("manual");
    const scan = await jpeg();
    const before = await row(scan.id);
    const gate = fake.hold();
    const call = service.interpret(scan.id, "ai");
    await gate.entered;
    await service.reject(scan.id, "Reklam", userId);
    gate.release();
    const detail = await call;
    expect(detail).toMatchObject({ status: "rejected", interpretedBy: "rules", aiStartedAt: null, aiError: null });
    expect((await row(scan.id)).result).toEqual(before.result);
  });

  it("drops a late answer when the supplier invoice was created meanwhile", async () => {
    const supplier = await makeSupplier();
    await enableAi("manual");
    const scan = await jpeg();
    const gate = fake.hold();
    const call = service.interpret(scan.id, "ai");
    await gate.entered;
    await service.convert(
      scan.id,
      { supplierId: supplier.id, invoiceNumber: "F-1", invoiceDate: TODAY, netAmount: 1000, vatAmount: 250, grossAmount: 1250, rows: [] },
      userId
    );
    gate.release();
    const detail = await call;
    expect(detail).toMatchObject({ status: "converted", interpretedBy: "rules", aiStartedAt: null });
  });

  it("refuses a converted or rejected scan like the other actions", async () => {
    await enableAi("manual");
    const scan = await jpeg();
    await service.reject(scan.id, "Fel mottagare", userId);
    await expect(service.interpret(scan.id, "ai")).rejects.toBeInstanceOf(InvalidStatusTransitionError);
  });

  it("stores a Swedish ai_error — never the error's own message — and keeps the previous result", async () => {
    await enableAi("manual");
    const scan = await jpeg();
    const before = await row(scan.id);
    fake.state.error = new InvoiceInterpreterError("unauthorized", "AuthenticationError 401");
    let detail = await service.interpret(scan.id, "ai");
    expect(detail).toMatchObject({ aiError: "API-nyckeln godkändes inte", status: before.status, interpretedBy: "rules", aiStartedAt: null });
    expect((await row(scan.id)).result).toEqual(before.result);

    fake.state.error = new Error("provider said: invalid x-api-key sk-secret");
    detail = await service.interpret(scan.id, "ai");
    expect(detail.aiError).toBe("AI-tolkningen misslyckades — försök igen eller fyll i fälten för hand");
    expect(detail.aiError).not.toContain("sk-secret");

    fake.state.error = new InvoiceInterpreterError("rate_limited");
    expect((await service.interpret(scan.id, "ai")).aiError).toBe("AI-tjänsten är tillfälligt överbelastad — försök igen om en stund");
  });

  it("reports a refusal", async () => {
    await enableAi("manual");
    const scan = await jpeg();
    fake.state.error = new InvoiceInterpreterError("refusal");
    expect((await service.interpret(scan.id, "ai")).aiError).toBe("AI-tjänsten avböjde att tolka filen");
  });

  it("clears an earlier ai_error when a call succeeds", async () => {
    await enableAi("manual");
    const scan = await jpeg();
    fake.state.error = new InvoiceInterpreterError("unavailable");
    expect((await service.interpret(scan.id, "ai")).aiError).toBe("AI-tjänsten svarade inte");
    fake.state.error = null;
    expect((await service.interpret(scan.id, "ai")).aiError).toBeNull();
  });

  it("uses the head fields of a truncated answer and says to fill in the rows", async () => {
    await makeSupplier();
    await enableAi("manual");
    fake.state.fields = sampleAiFields({ invoiceDate: { value: TODAY, confidence: "high" }, rows: [] });
    fake.state.truncated = true;
    const scan = await jpeg();
    const detail = await service.interpret(scan.id, "ai");
    expect(detail).toMatchObject({ interpretedBy: "ai", aiError: "Svaret blev för långt — fyll i raderna för hand" });
    expect(detail.result!.grossAmount.value).toBe(1250);
    expect(detail.result!.rows).toEqual([]);
  });

  it("treats an answer outside the agreed structure as an error", async () => {
    await enableAi("manual");
    const scan = await jpeg();
    fake.state.fields = { nonsense: true } as never;
    expect((await service.interpret(scan.id, "ai")).aiError).toBe("AI-tjänsten svarade i ett format som inte gick att läsa");
  });

  it("never sends an image over the API's limit", async () => {
    await enableAi("manual");
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(7_600_000, 0x11), Buffer.from([0xff, 0xd9])]);
    const scan = await jpeg(big);
    const detail = await service.interpret(scan.id, "ai");
    expect(fake.calls).toHaveLength(0);
    expect(detail.aiError).toBe("Bilden är för stor för AI-tolkning (max 7,5 MB) — fota med lägre upplösning");
    expect(detail.aiStartedAt).toBeNull();
  });
});

describe("automatic AI (Automatiskt när reglerna inte räcker)", () => {
  it("leaves a PDF alone when the rules were enough", async () => {
    await makeSupplier();
    await enableAi("fallback");
    const scan = await pdf();
    await service.automaticAi([scan.id]);
    expect(fake.calls).toHaveLength(0);
    expect((await service.get(scan.id)).interpretedBy).toBe("rules");
  });

  it("runs on a photo, a scanned PDF and a PDF the rules could not finish", async () => {
    await makeSupplier();
    await enableAi("fallback");
    const photo = await jpeg();
    const scanned = await pdf(await imageOnlyPdf());
    const partial = await pdf(await invoicePdf({ gross: null, invoiceNumber: "77001" }));
    await service.automaticAi([photo.id, scanned.id, partial.id]);
    expect(fake.calls.map((c) => c.file.contentType)).toEqual(["image/jpeg", "application/pdf", "application/pdf"]);
    for (const id of [photo.id, scanned.id, partial.id]) expect((await service.get(id)).interpretedBy).toBe("ai");
  });

  it("does nothing in läge Bara med knappen, in läge Av or without a key", async () => {
    const scan = await jpeg();
    await enableAi("manual");
    await service.automaticAi([scan.id]);
    await enableAi("off");
    await service.automaticAi([scan.id]);
    await enableAi("fallback", null);
    await service.automaticAi([scan.id]);
    expect(fake.calls).toHaveLength(0);
  });

  it("skips a scan already interpreted by AI or no longer pending, and never throws", async () => {
    await enableAi("fallback");
    const done = await jpeg();
    await service.interpret(done.id, "ai");
    const rejected = await jpeg(Buffer.concat([jpegImage(), Buffer.from([2])]));
    await service.reject(rejected.id, "Reklam", userId);
    fake.calls.length = 0;
    await service.automaticAi([done.id, rejected.id, crypto.randomUUID()]);
    expect(fake.calls).toHaveLength(0);
  });

  it("follows avsändarregeln for e-mailed scans", async () => {
    const supplier = await makeSupplier({ email: "info@platgrossisten.example" });
    await db.insert(supplierContacts).values({ supplierId: supplier.id, name: "Ekonomi", email: "ekonomi@kontakt.example" });
    await enableAi("fallback");
    const asEmail = async (from: string, filler: number) => {
      const scan = await jpeg(Buffer.concat([jpegImage(), Buffer.from([filler])]));
      await db.update(invoiceScans).set({ source: "email", emailFrom: from }).where(eq(invoiceScans.id, scan.id));
      return scan.id;
    };
    const known = await asEmail("Plåtgrossisten <faktura@platgrossisten.example>", 3);
    const contact = await asEmail("ekonomi@kontakt.example", 4);
    const spam = await asEmail("erbjudande@reklam.example", 5);
    await service.automaticAi([known, contact, spam]);
    expect(fake.calls).toHaveLength(2);
    expect((await service.get(spam)).interpretedBy).toBe("rules");
  });

  it("runs one scan at a time", async () => {
    await enableAi("fallback");
    const a = await jpeg();
    const b = await jpeg(Buffer.concat([jpegImage(), Buffer.from([6])]));
    const gate = fake.hold();
    const first = service.automaticAi([a.id]);
    const second = service.automaticAi([b.id]);
    await gate.entered;
    expect(fake.calls).toHaveLength(1);
    gate.release();
    await Promise.all([first, second]);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("Testa anslutning (AI)", () => {
  it("uses the typed key and model, else the saved ones, and saves nothing", async () => {
    await expect(settings.testAi({})).rejects.toThrow(new InvoiceScanAiTestFailedError("Ingen API-nyckel angiven"));
    expect(await settings.testAi({ apiKey: "sk-typed", model: "claude-haiku-5-5" })).toEqual({ ok: true, model: "claude-haiku-5-5" });
    expect(fake.tests.at(-1)).toEqual({ apiKey: "sk-typed", model: "claude-haiku-5-5" });
    expect((await settings.view()).aiApiKeySet).toBe(false);
    await enableAi("manual", "sk-saved");
    expect(await settings.testAi({ apiKey: "" })).toEqual({ ok: true, model: "claude-sonnet-5-5" });
    expect(fake.tests.at(-1)).toEqual({ apiKey: "sk-saved", model: "claude-sonnet-5-5" });
  });

  it("fails with the Swedish reason", async () => {
    fake.state.testError = new InvoiceInterpreterError("unauthorized");
    await expect(settings.testAi({ apiKey: "sk-bad" })).rejects.toThrow("API-nyckeln godkändes inte");
    fake.state.testError = new Error("sk-bad leaked");
    const err = await settings.testAi({ apiKey: "sk-bad" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(InvoiceScanAiTestFailedError);
    expect((err as Error).message).not.toContain("leaked");
  });
});
