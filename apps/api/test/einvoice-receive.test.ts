import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { auditLog, companyInfo, db, einvoiceReceptions, invoiceScans, suppliers, systemSettings } from "@navet/db";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createInvoiceScanRepository } from "../src/modules/purchase/repository/invoice-scan.repository.js";
import { createInvoiceScanService, InvoiceScanEinvoiceNoAiError, InvoiceScanEinvoiceOriginalNotFoundError } from "../src/modules/purchase/service/invoice-scan.service.js";
import { createInvoiceScanSettingsService } from "../src/modules/purchase/service/invoice-scan-settings.service.js";
import type { EInvoiceOriginalReader } from "../src/modules/purchase/service/invoice-scan/einvoice-original.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEinvoiceRepository } from "../src/modules/einvoice/repository/einvoice.repository.js";
import { createEinvoiceSettingsService, EINVOICE_WEBHOOK_EVENTS } from "../src/modules/einvoice/service/einvoice-settings.service.js";
import { createEinvoiceReceiveService, isReceiveDue, RECEIVE_LEASE_MS, RECEIVE_PAGE_SIZE, RECEIVE_TEXTS } from "../src/modules/einvoice/service/einvoice-receive.service.js";
import { renderEInvoiceCopy } from "../src/modules/mail/service/einvoice-copy-pdf.js";
import { createAlertsRepository } from "../src/modules/alerts/repository/alerts.repository.js";
import { createAlertsService } from "../src/modules/alerts/service/alerts.service.js";
import { InvalidStatusTransitionError } from "../src/modules/purchase/service/purchase.service.js";
import { createEinvoiceWebhookService } from "../src/modules/einvoice/service/einvoice-webhook.service.js";
import { EinvoiceReceiveBusyError, EinvoiceReceptionNotFoundError, EinvoiceReceptionRegisteredElsewhereError, fromProviderError } from "../src/modules/einvoice/service/einvoice.errors.js";
import { EInvoiceProviderError } from "../src/modules/einvoice/service/einvoice-provider.js";
import { buildUblDocument } from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import { EINVOICE_COPY_TITLE } from "../src/modules/mail/service/einvoice-copy-pdf.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";
import { createFakeEinvoiceProvider, conflict, unavailable } from "./helpers/fake-einvoice-provider.js";
import { createFakeInvoiceInterpreter } from "./helpers/fake-invoice-interpreter.js";
import { FAKE_PDF, invoiceTwoRatesDiscount, SELLER } from "./helpers/ubl-fixtures.js";
import { FAKE_BUYER, FAKE_OCR } from "./helpers/invoice-pdf.js";
import { pdfText } from "./helpers/pdf.js";
import { createHmac } from "node:crypto";

// E-faktura, mottagning (spec 2026-11-05-e-faktura-mottagning) against the
// database through the fake access point: the import into the inbox, the
// ack after commit and a failed ack (no duplicate), the duplicate on sender
// + number, an unreadable document and the BIS3 reserve, lease/interval/
// switch/environment, the visningskopia when the PDF is missing or too
// large, the conversion (the original stays, NV001), Ta emot e-faktura and
// the web hook's nudge. All data is invented.

const audit = createAuditRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const supplierInvoiceService = createSupplierInvoiceService(
  createSupplierInvoiceRepository(db),
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  audit
);
const interpreter = createFakeInvoiceInterpreter();
const scanRepo = createInvoiceScanRepository(db);
const scanSettings = createInvoiceScanSettingsService({ repo: scanRepo, audit, interpreters: interpreter.factory });
const logs: unknown[] = [];
const log = (msg: string, extra?: unknown) => logs.push({ msg, extra });
const originalRef: { current: EInvoiceOriginalReader | null } = { current: null };
const scanService = createInvoiceScanService({
  repo: scanRepo,
  supplierInvoices: supplierInvoiceService,
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
  log,
});
const repo = createEinvoiceRepository(db);
const fake = createFakeEinvoiceProvider();
let clock = new Date("2026-11-05T09:00:00Z");
const now = () => clock;
const settings = createEinvoiceSettingsService({ repo, company: systemService, audit, providerFactory: fake.factory });
const receive = createEinvoiceReceiveService({ repo, settings, scans: scanService, audit, now, log });
originalRef.current = receive;
const kicks: number[] = [];
const webhook = createEinvoiceWebhookService({
  repo,
  settings,
  status: { pollTransmission: async () => ({}) as never },
  receive: { kick: () => kicks.push(1) },
  now,
});
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE einvoice_receptions, invoice_scan_hints, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, supplier_contacts, suppliers, purchase_order_rows, purchase_orders, audit_log, users CASCADE`;

let companyBefore: typeof companyInfo.$inferSelect | undefined;
let userId: string;

beforeAll(async () => {
  [companyBefore] = await db.select().from(companyInfo).limit(1);
  if (!companyBefore) await db.insert(companyInfo).values({ name: FAKE_BUYER.name });
  await db.update(companyInfo).set({ name: FAKE_BUYER.name, orgNumber: FAKE_BUYER.orgNumber, vatNumber: FAKE_BUYER.vatNumber, bankgiro: FAKE_BUYER.bankgiro, plusgiro: null, iban: null });
});

async function setSetting(key: string, value: string) {
  await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
}

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(like(systemSettings.key, "einvoice\\_%"));
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
  await setSetting("einvoice_api_key", "test_key");
  await setSetting("einvoice_account_id", "4711");
  await setSetting("einvoice_environment", "sandbox");
  await setSetting("einvoice_reception_enabled", "true");
  clock = new Date("2026-11-05T09:00:00Z");
  logs.length = 0;
  kicks.length = 0;
  fake.calls.length = 0;
  fake.state.received.clear();
  fake.state.listReceivedError = null;
  fake.state.setReceptionError = null;
  fake.state.updateWebhookError = null;
  fake.state.webhooks.clear();
  fake.state.transport = { enabled: true, reception: false, smlStatus: "not_published", directoryStatus: "not_published", migrationPending: false, documentTypes: [], participantId: "0007:5599114567" };
  userId = (await authRepo.create({ email: `er-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Inköpare", role: "admin" })).id;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(like(systemSettings.key, "einvoice\\_%"));
  if (companyBefore) {
    const { id: _id, ...rest } = companyBefore;
    await db.update(companyInfo).set(rest);
  } else {
    await db.delete(companyInfo);
  }
});

// The seller of the golden files, in the register.
async function makeSupplier(over: Partial<typeof suppliers.$inferInsert> = {}) {
  const [row] = await db
    .insert(suppliers)
    .values({ supplierNumber: `L${crypto.randomUUID().slice(0, 8)}`, name: SELLER.name, orgNumber: "556677-8899", currency: "SEK", ...over })
    .returning();
  return row!;
}

const invoiceXml = (over: Partial<ReturnType<typeof invoiceTwoRatesDiscount>> = {}) => Buffer.from(buildUblDocument({ ...invoiceTwoRatesDiscount(), ...over }), "utf8");

async function run() {
  const result = await receive.runReceiveIfDue();
  if (typeof result === "string") throw new Error(`run: ${result}`);
  return result;
}

const receptions = () => db.select().from(einvoiceReceptions).orderBy(einvoiceReceptions.createdAt);
const scans = () => db.select().from(invoiceScans).orderBy(invoiceScans.createdAt);
const setting = async (key: string) => (await db.select().from(systemSettings).where(eq(systemSettings.key, key)))[0]?.value ?? null;

describe("the reception run", () => {
  it("imports a received UBL invoice into the inbox, acknowledges it after commit and interprets it", async () => {
    const supplier = await makeSupplier();
    const id = fake.receive(invoiceXml());
    const result = await run();
    expect(result).toMatchObject({ listed: 1, imported: 1, duplicates: 0, unreadable: 0, ackFailed: 0, error: null });

    const [scan] = await scans();
    expect(scan).toMatchObject({ source: "einvoice", status: "interpreted", filename: "Faktura-FA-1001.pdf", contentType: "application/pdf", interpretedBy: "rules", uploadedBy: null });
    expect(scan!.data!.equals(FAKE_PDF)).toBe(true);
    const proposal = scan!.result as { supplier: { matchedSupplierId: string | null }; invoiceNumber: { value: string; source: string }; purchaseOrderReference: { value: string | null } };
    expect(proposal.supplier.matchedSupplierId).toBe(supplier.id);
    expect(proposal.invoiceNumber).toMatchObject({ value: "FA-1001", source: "einvoice" });
    expect(proposal.purchaseOrderReference.value).toBe("PO-4711");

    const [reception] = await receptions();
    expect(reception).toMatchObject({
      environment: "sandbox",
      providerInvoiceId: id,
      documentType: "invoice",
      documentNumber: "FA-1001",
      issueDate: "2026-10-21",
      senderEndpoint: "0007:5566778899",
      senderName: SELLER.name,
      currency: "SEK",
      payableAmount: "16901.90",
      originalContentType: "application/xml",
      interpretationXml: null,
      outcome: "imported",
      detail: null,
      invoiceScanId: scan!.id,
    });
    expect(reception!.originalXml.equals(invoiceXml())).toBe(true);
    expect(fake.state.received.get(id)!.acked).toBe(true);
    expect(fake.calls.map((c) => c.method)).toEqual(["listReceived", "getReceivedOriginal", "acknowledgeReceived"]);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityType, "invoice_scan"));
    expect(audits.map((a) => a.action)).toEqual(["received"]);
    expect(audits[0]!.detail).toMatchObject({ source: "einvoice", providerInvoiceId: id, sender: SELLER.name, documentNumber: "FA-1001" });
    expect(await setting("einvoice_last_receive_run_at")).toBe(clock.toISOString());
    expect(await setting("einvoice_receive_last_success_at")).toBe(clock.toISOString());
    expect(await setting("einvoice_receive_last_error")).toBeNull();

    // The inbox's view of the post.
    const detail = await scanService.get(scan!.id);
    expect(detail.einvoice).toEqual({
      environment: "sandbox",
      senderEndpoint: "0007:5566778899",
      senderName: SELLER.name,
      receivedAt: reception!.receivedAt.toISOString(),
      attachments: [{ index: 0, filename: "Faktura-FA-1001.pdf", contentType: "application/pdf", sizeBytes: FAKE_PDF.length }],
    });
    const original = await scanService.einvoiceOriginal(scan!.id);
    expect(original).toMatchObject({ contentType: "application/xml", filename: "e-faktura-FA-1001.xml" });
    expect(original.xml.equals(invoiceXml())).toBe(true);
    const attachment = await scanService.einvoiceAttachment(scan!.id, 0);
    expect(attachment).toMatchObject({ filename: "Faktura-FA-1001.pdf", contentType: "application/pdf" });
    expect(attachment.data.equals(FAKE_PDF)).toBe(true);
    await expect(scanService.einvoiceAttachment(scan!.id, 1)).rejects.toBeInstanceOf(InvoiceScanEinvoiceOriginalNotFoundError);
  });

  it("a failed ack keeps the post and the log row; the next run acknowledges again without a second post", async () => {
    await makeSupplier();
    const id = fake.receive(invoiceXml(), { ackError: new EInvoiceProviderError("B2Brouter gav ett oväntat svar", "unexpected") });
    const first = await run();
    expect(first).toMatchObject({ imported: 1, ackFailed: 1, error: RECEIVE_TEXTS.ackFailed(1) });
    expect(await scans()).toHaveLength(1);
    expect(await receptions()).toHaveLength(1);
    expect(fake.state.received.get(id)!.acked).toBe(false);
    expect(await setting("einvoice_receive_last_error")).toBe(RECEIVE_TEXTS.ackFailed(1));
    expect(await setting("einvoice_receive_last_success_at")).toBeNull();

    // A process that died between commit and interpretation left the post
    // `new` without a result: the next run interprets it while acking.
    const [scanBefore] = await scans();
    await db.update(invoiceScans).set({ status: "new", result: null, interpretedBy: null, interpretedAt: null }).where(eq(invoiceScans.id, scanBefore!.id));
    fake.state.received.get(id)!.ackError = undefined;
    clock = new Date(clock.getTime() + 20 * 60_000);
    const second = await run();
    expect(second).toMatchObject({ listed: 1, imported: 0, alreadyImported: 1, ackFailed: 0, error: null });
    expect(await scans()).toHaveLength(1);
    expect((await scans())[0]).toMatchObject({ status: "interpreted", interpretedBy: "rules" });
    expect(await receptions()).toHaveLength(1);
    expect(fake.state.received.get(id)!.acked).toBe(true);
    expect(await setting("einvoice_receive_last_error")).toBeNull();
  });

  it("logs a resend of the same sender's invoice number as a duplicate and acknowledges it — the same PDF under another number is its own post with the visningskopia", async () => {
    await makeSupplier();
    fake.receive(invoiceXml());
    await run();
    // Same number, a different document (no attachment ⇒ a different PDF).
    const resend = fake.receive(invoiceXml({ attachment: null, note: "Påminnelse" }));
    // Same PDF bytes, another number.
    const samePdf = fake.receive(invoiceXml({ invoiceNumber: "FA-1002" }));
    clock = new Date(clock.getTime() + 20 * 60_000);
    const result = await run();
    // The resend is a duplicate; the other number is ANOTHER invoice that
    // happens to carry the same PDF (review 2026-11-10: it used to be
    // thrown away as "Filen fanns redan i inkorgen" and never reached the
    // inbox) — it becomes its own post with the visningskopia as its file.
    expect(result).toMatchObject({ listed: 2, imported: 1, duplicates: 1 });
    const [first, second] = await scans();
    expect(await scans()).toHaveLength(2);
    const rows = await receptions();
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ providerInvoiceId: resend, outcome: "duplicate", detail: `Samma faktura finns redan i inkorgen (${first!.scanNumber})`, invoiceScanId: first!.id });
    expect(rows[2]).toMatchObject({ providerInvoiceId: samePdf, outcome: "imported", detail: RECEIVE_TEXTS.sharedPdf(first!.scanNumber), invoiceScanId: second!.id });
    expect(second).toMatchObject({ source: "einvoice", filename: "Visningskopia-FA-1002.pdf" });
    expect(second!.data!.equals(FAKE_PDF)).toBe(false);
    expect(fake.state.received.get(resend)!.acked).toBe(true);
    expect(fake.state.received.get(samePdf)!.acked).toBe(true);
    // No FI- number was burned by the sha256 duplicate inside that import.
    const next = fake.receive(invoiceXml({ invoiceNumber: "FA-1003", attachment: null }));
    clock = new Date(clock.getTime() + 20 * 60_000);
    await run();
    const numbers = (await scans()).map((s) => Number(s.scanNumber.slice(3)));
    expect(numbers).toEqual([numbers[0]!, numbers[0]! + 1, numbers[0]! + 2]);
    expect(fake.state.received.get(next)!.acked).toBe(true);
  });

  it("a rejected post lets the same document come in again", async () => {
    await makeSupplier();
    fake.receive(invoiceXml());
    await run();
    const [scan] = await scans();
    await scanService.reject(scan!.id, "Fel", userId);
    fake.receive(invoiceXml({ note: "Igen" }));
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(await run()).toMatchObject({ imported: 1, duplicates: 0 });
    expect(await scans()).toHaveLength(2);
  });

  it("never matches a resend on the sender's name alone: without an endpoint the document is imported again", async () => {
    await makeSupplier();
    const noEndpoint = (over: Record<string, unknown>) => Buffer.from(invoiceXml(over).toString("utf8").replace('<cbc:EndpointID schemeID="0007">5566778899</cbc:EndpointID>', ""), "utf8");
    fake.receive(noEndpoint({ attachment: null }));
    await run();
    fake.receive(noEndpoint({ attachment: null, note: "Igen" }));
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(await run()).toMatchObject({ imported: 1, duplicates: 0 });
    expect((await receptions()).map((r) => r.senderEndpoint)).toEqual([null, null]);
  });

  it("logs an unreadable document once and never acknowledges it; the scheduled run skips it, Hämta nu retries and fills the row when it can be read", async () => {
    await makeSupplier();
    const id = fake.receive(Buffer.from('<CrossIndustryInvoice xmlns="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"><x/></CrossIndustryInvoice>'), {
      contentType: "application/xml",
      ublError: new EInvoiceProviderError("B2Brouter gav ett oväntat svar", "unexpected"),
    });
    expect(await run()).toMatchObject({ listed: 1, unreadable: 1, imported: 0, error: null });
    let rows = await receptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "unreadable", documentType: null, attachments: null, invoiceScanId: null, detail: `${RECEIVE_TEXTS.unreadable}: ${RECEIVE_TEXTS.noUbl}` });
    expect(fake.state.received.get(id)!.acked).toBe(false);
    expect(await scans()).toHaveLength(0);

    // The scheduled run leaves it alone — no download, no second row.
    fake.calls.length = 0;
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(await run()).toMatchObject({ listed: 1, unreadable: 0, skipped: 1 });
    expect(fake.calls.map((c) => c.method)).toEqual(["listReceived"]);
    expect(await receptions()).toHaveLength(1);

    // Hämta nu retries it (still unreadable: one row, same detail).
    expect(await receive.receiveNow()).toEqual({ imported: 0, duplicates: 0, unreadable: 1 });
    expect(await receptions()).toHaveLength(1);

    // The access point now has a BIS3 rendering: Hämta nu imports it and the
    // row is filled once (identity, interpretation, attachments).
    const doc = fake.state.received.get(id)!;
    doc.ublError = undefined;
    doc.ubl = invoiceXml();
    expect(await receive.receiveNow()).toEqual({ imported: 1, duplicates: 0, unreadable: 0 });
    rows = await receptions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "imported", documentType: "invoice", documentNumber: "FA-1001", senderEndpoint: "0007:5566778899", senderName: SELLER.name, currency: "SEK", payableAmount: "16901.90" });
    expect(rows[0]!.interpretationXml!.equals(invoiceXml())).toBe(true);
    expect(rows[0]!.attachments).toEqual([{ index: 0, filename: "Faktura-FA-1001.pdf", contentType: "application/pdf", sizeBytes: FAKE_PDF.length }]);
    expect(rows[0]!.invoiceScanId).not.toBeNull();
    expect(doc.acked).toBe(true);
    const [scan] = await scans();
    expect(scan!.status).toBe("interpreted");
    expect((await scanService.get(scan!.id)).einvoice?.senderName).toBe(SELLER.name);
    await scanService.interpret(scan!.id, "rules");

    // Filled once: the identity is frozen from now on …
    await expect(db.update(einvoiceReceptions).set({ documentNumber: "FA-9" }).where(eq(einvoiceReceptions.id, rows[0]!.id))).rejects.toMatchObject({ cause: expect.objectContaining({ code: "NV001" }) });
    // … and a resend of the same document is a duplicate of the filled row.
    fake.receive(invoiceXml({ attachment: null, note: "Igen" }));
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(await run()).toMatchObject({ duplicates: 1, imported: 0 });
    expect((await receptions())[1]).toMatchObject({ outcome: "duplicate", invoiceScanId: scan!.id });
  });

  it("one bad document never stops the queue: a crash while importing is logged unreadable and the next document goes on", async () => {
    await makeSupplier();
    // The copy renderer crashes for one document (no attachment ⇒ a copy is
    // drawn); the other has its PDF embedded and needs no copy.
    const crashing = createEinvoiceReceiveService({
      repo,
      settings,
      scans: scanService,
      audit,
      now,
      log,
      renderCopy: async (doc, o) => {
        if (doc.number === "FA-1001") throw new TypeError("boom");
        return renderEInvoiceCopy(doc, o);
      },
    });
    const bad = fake.receive(invoiceXml({ attachment: null }));
    const good = fake.receive(invoiceXml({ invoiceNumber: "FA-1002" }));
    const result = await crashing.runReceive();
    expect(result).toMatchObject({ listed: 2, unreadable: 1, imported: 1, error: null });
    const rows = await receptions();
    expect(rows.find((r) => r.providerInvoiceId === bad)).toMatchObject({ outcome: "unreadable", detail: `${RECEIVE_TEXTS.unreadable}: ${RECEIVE_TEXTS.unexpected}` });
    expect(rows.find((r) => r.providerInvoiceId === good)).toMatchObject({ outcome: "imported" });
    expect(fake.state.received.get(bad)!.acked).toBe(false);
    expect(fake.state.received.get(good)!.acked).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("boom");
    // Also a document the reader refuses outright (a date that is no date)
    // only costs its own row.
    fake.receive(invoiceXml({ invoiceNumber: "FA-1003", issueDate: "2026-02-30", attachment: null }));
    fake.receive(invoiceXml({ invoiceNumber: "FA-1004", attachment: null }));
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(await run()).toMatchObject({ unreadable: 1, imported: 1, skipped: 1 });
  });

  it("stores the original's bytes exactly as served — an ISO-8859-1 document included", async () => {
    await makeSupplier();
    const latin1 = Buffer.from(invoiceXml({ attachment: null }).toString("utf8").replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'), "latin1");
    expect(latin1.includes(Buffer.from("Gävle", "utf8"))).toBe(false);
    const id = fake.receive(latin1);
    expect(await run()).toMatchObject({ imported: 1 });
    const [row] = await receptions();
    expect(row!.originalXml.equals(latin1)).toBe(true);
    expect(row!.senderName).toBe(SELLER.name);
    expect(fake.state.received.get(id)!.acked).toBe(true);
    const [scan] = await scans();
    expect((await scanService.get(scan!.id)).result!.supplier.city.value).toBe("Gävle");
    expect((await scanService.einvoiceOriginal(scan!.id)).xml.equals(latin1)).toBe(true);
  });

  it("whitelists the attachments' content types: text/html and a value with a control character become octet-stream", async () => {
    await makeSupplier();
    const xml = invoiceXml()
      .toString("utf8")
      .replace(
        "</cac:AdditionalDocumentReference>",
        '</cac:AdditionalDocumentReference><cac:AdditionalDocumentReference><cbc:ID>bilaga</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/html" filename="sida.html">PGh0bWw+PC9odG1sPg==</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference><cac:AdditionalDocumentReference><cbc:ID>csv</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/csv&#10;x" filename="rader.csv">YTtiCg==</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>'
      );
    fake.receive(Buffer.from(xml, "utf8"));
    expect(await run()).toMatchObject({ imported: 1 });
    const [scan] = await scans();
    const detail = await scanService.get(scan!.id);
    expect(detail.einvoice?.attachments.map((a) => a.contentType)).toEqual(["application/pdf", "application/octet-stream", "application/octet-stream"]);
    expect((await scanService.einvoiceAttachment(scan!.id, 1)).contentType).toBe("application/octet-stream");
    expect((await scanService.einvoiceAttachment(scan!.id, 2)).contentType).toBe("application/octet-stream");
    expect((await scanService.einvoiceAttachment(scan!.id, 1)).data.toString()).toBe("<html></html>");
  });

  it("uses the access point's BIS3 rendering when the original is not UBL and keeps it as the interpretation", async () => {
    await makeSupplier();
    const id = fake.receive(Buffer.from('<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"><rsm:x/></rsm:CrossIndustryInvoice>'), { ubl: invoiceXml() });
    expect(await run()).toMatchObject({ imported: 1 });
    const [row] = await receptions();
    expect(row!.interpretationXml!.equals(invoiceXml())).toBe(true);
    expect(row!.originalXml.toString()).toContain("CrossIndustryInvoice");
    expect(fake.state.received.get(id)!.acked).toBe(true);
    const [scan] = await scans();
    expect((await scanService.get(scan!.id)).einvoice?.attachments).toHaveLength(1);
    expect(fake.calls.map((c) => c.method)).toEqual(["listReceived", "getReceivedOriginal", "getReceivedAsUbl", "acknowledgeReceived"]);
  });

  it("marks a document gone from the access point as unreadable and does not stop the run; a lost connection does", async () => {
    await makeSupplier();
    const gone = fake.receive(invoiceXml(), { originalError: new EInvoiceProviderError("Dokumentet finns inte längre hos B2Brouter", "not-found") });
    const goneOnAck = fake.receive(invoiceXml({ invoiceNumber: "FA-1009", attachment: null }), { ackError: new EInvoiceProviderError("Dokumentet finns inte längre hos B2Brouter", "not-found") });
    expect(await run()).toMatchObject({ listed: 2, imported: 1, ackFailed: 0, error: null });
    expect(fake.state.received.get(gone)!.acked).toBe(false);
    expect(await receptions()).toHaveLength(1);
    expect((await receptions())[0]!.providerInvoiceId).toBe(goneOnAck);

    fake.state.received.clear();
    fake.receive(invoiceXml({ invoiceNumber: "FA-1010", attachment: null }), { originalError: unavailable() });
    fake.receive(invoiceXml({ invoiceNumber: "FA-1011", attachment: null }));
    clock = new Date(clock.getTime() + 20 * 60_000);
    const result = await run();
    expect(result).toMatchObject({ imported: 0, error: "B2Brouter svarar inte, försök igen" });
    expect(await setting("einvoice_receive_last_error")).toBe("B2Brouter svarar inte, försök igen");
    expect(await setting("einvoice_last_receive_run_at")).toBe(clock.toISOString());
    expect(logs.some((l) => JSON.stringify(l).includes("försök igen"))).toBe(false);
  });

  it("draws the visningskopia when the e-invoice carries no PDF, and when the attachment is not a PDF or too large", async () => {
    await makeSupplier();
    fake.receive(invoiceXml({ attachment: null }));
    fake.receive(invoiceXml({ invoiceNumber: "FA-1002", attachment: { filename: "bild.pdf", description: "x", mimeCode: "application/pdf", content: Buffer.from("not a pdf at all") } }));
    expect(await run()).toMatchObject({ imported: 2 });
    const rows = await scans();
    expect(rows[0]!.filename).toBe("Visningskopia-FA-1001.pdf");
    expect(rows[0]!.data!.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfText(rows[0]!.data!)).toContain(EINVOICE_COPY_TITLE);
    expect(rows[1]!.filename).toBe("Visningskopia-FA-1002.pdf");
    expect(pdfText(rows[1]!.data!)).toContain(RECEIVE_TEXTS.attachmentNotPdf);
    const log2 = await receptions();
    expect(log2[1]!.detail).toBe(RECEIVE_TEXTS.attachmentNotPdf);
  });

  it("leaves an embedded PDF over 20 MB in the XML: the copy with the remark, and the check on the proposal", async () => {
    await makeSupplier();
    // A base64 body just over the cap (the reader never decodes it).
    const big = Buffer.alloc(21 * 1024 * 1024, 0x25);
    fake.receive(invoiceXml({ attachment: { filename: "stor.pdf", description: "Faktura", mimeCode: "application/pdf", content: big } }));
    expect(await run()).toMatchObject({ imported: 1 });
    const [scan] = await scans();
    expect(scan!.filename).toBe("Visningskopia-FA-1001.pdf");
    expect(pdfText(scan!.data!)).toContain(RECEIVE_TEXTS.attachmentTooLarge);
    expect((scan!.result as { checks: string[] }).checks).toContain(RECEIVE_TEXTS.attachmentTooLarge);
    const detail = await scanService.get(scan!.id);
    expect(detail.einvoice?.attachments[0]).toMatchObject({ index: 0, filename: "stor.pdf", sizeBytes: big.length });
    const attachment = await scanService.einvoiceAttachment(scan!.id, 0);
    expect(attachment.data.length).toBe(big.length);
  }, 60_000);
});

describe("the scheduler's guards", () => {
  it("runs only with the reception on, a key and an account; honours the interval and the lease; Hämta nu ignores the interval", async () => {
    fake.receive(invoiceXml({ attachment: null }));
    await setSetting("einvoice_reception_enabled", "false");
    expect(await receive.runReceiveIfDue()).toBe("disabled");
    await setSetting("einvoice_reception_enabled", "true");
    await db.delete(systemSettings).where(eq(systemSettings.key, "einvoice_account_id"));
    expect(await receive.runReceiveIfDue()).toBe("disabled");
    await setSetting("einvoice_account_id", "4711");

    expect(await run()).toMatchObject({ imported: 1 });
    fake.receive(invoiceXml({ invoiceNumber: "FA-1002", attachment: null }));
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await receive.runReceiveIfDue()).toBe("not-due");
    // Hämta nu runs regardless of the interval.
    expect(await receive.receiveNow()).toEqual({ imported: 1, duplicates: 0, unreadable: 0 });

    clock = new Date(clock.getTime() + 15 * 60_000);
    const lease = await repo.claimReceiveLease(clock, RECEIVE_LEASE_MS);
    expect(lease).not.toBeNull();
    expect(await receive.runReceiveIfDue()).toBe("busy");
    await expect(receive.receiveNow()).rejects.toBeInstanceOf(EinvoiceReceiveBusyError);
    await repo.releaseReceiveLease(lease!);
    expect(await receive.runReceiveIfDue()).toMatchObject({ listed: 0 });
    // The lease is released after the run.
    expect(await setting("einvoice_receive_lease_until")).toBeNull();

    expect(isReceiveDue(null, 15, clock)).toBe(true);
    expect(isReceiveDue(new Date(clock.getTime() - 12 * 60_000), 15, clock)).toBe(false);
    expect(isReceiveDue(new Date(clock.getTime() - 13 * 60_000), 15, clock)).toBe(true);
    expect(isReceiveDue(new Date(clock.getTime() - 3 * 60_000), 5, clock)).toBe(true);
    expect(isReceiveDue(new Date(clock.getTime() - 2 * 60_000), 5, clock)).toBe(false);
  });

  it("pages through the listing — acknowledged documents leave it, the rest push the offset — and renews the lease per page", async () => {
    await makeSupplier();
    const unreadable = fake.receive(Buffer.from("<nope/>"));
    for (let i = 0; i < RECEIVE_PAGE_SIZE + 2; i++) fake.receive(invoiceXml({ invoiceNumber: `FA-${2000 + i}`, attachment: null }));
    fake.calls.length = 0;
    const result = await run();
    expect(result).toMatchObject({ listed: RECEIVE_PAGE_SIZE + 3, imported: RECEIVE_PAGE_SIZE + 2, unreadable: 1, stoppedEarly: false });
    const lists = fake.calls.filter((c) => c.method === "listReceived").map((c) => c.args[0]);
    expect(lists).toEqual([
      { offset: 0, limit: RECEIVE_PAGE_SIZE },
      { offset: 1, limit: RECEIVE_PAGE_SIZE },
    ]);
    expect(await scans()).toHaveLength(RECEIVE_PAGE_SIZE + 2);
    expect(fake.state.received.get(unreadable)!.acked).toBe(false);
    expect(await setting("einvoice_receive_lease_until")).toBeNull();
  }, 120_000);

  it("stops taking new pages when the time budget is spent or the lease is lost", async () => {
    await makeSupplier();
    let tick = new Date("2026-11-05T09:00:00Z");
    const slow = createEinvoiceReceiveService({
      repo,
      settings,
      scans: scanService,
      audit,
      now: () => tick,
      log,
      renderCopy: (doc, o) => {
        tick = new Date(tick.getTime() + 60_000);
        return renderEInvoiceCopy(doc, o);
      },
    });
    for (let i = 0; i < RECEIVE_PAGE_SIZE + 1; i++) fake.receive(invoiceXml({ invoiceNumber: `FA-${3000 + i}`, attachment: null }));
    // 100 copies × 1 minute ≫ the 8-minute budget: the second page waits.
    expect(await slow.runReceiveIfDue()).toMatchObject({ listed: RECEIVE_PAGE_SIZE, imported: RECEIVE_PAGE_SIZE, stoppedEarly: true });
    expect([...fake.state.received.values()].filter((d) => !d.acked)).toHaveLength(1);

    // The lease taken over by someone else mid-run stops the run.
    fake.state.received.clear();
    for (let i = 0; i < RECEIVE_PAGE_SIZE + 1; i++) fake.receive(invoiceXml({ invoiceNumber: `FA-${4000 + i}`, attachment: null }));
    tick = new Date(tick.getTime() + 60 * 60_000);
    const stealing = createEinvoiceReceiveService({
      repo,
      settings,
      scans: scanService,
      audit,
      now: () => tick,
      log,
      renderCopy: async (doc, o) => {
        if (doc.number === `FA-${4000 + RECEIVE_PAGE_SIZE - 1}`) await db.update(systemSettings).set({ value: "2099-01-01T00:00:00.000Z" }).where(eq(systemSettings.key, "einvoice_receive_lease_until"));
        return renderEInvoiceCopy(doc, o);
      },
    });
    expect(await stealing.runReceiveIfDue()).toMatchObject({ listed: RECEIVE_PAGE_SIZE, stoppedEarly: true });
    expect(await setting("einvoice_receive_lease_until")).toBe("2099-01-01T00:00:00.000Z");
    await db.delete(systemSettings).where(eq(systemSettings.key, "einvoice_receive_lease_until"));
  }, 120_000);

  it("a listing failure is the run's error (and Hämta nu throws it); no key is reported without a call", async () => {
    fake.state.listReceivedError = unavailable();
    expect(await run()).toMatchObject({ listed: 0, error: "B2Brouter svarar inte, försök igen" });
    await expect(receive.receiveNow()).rejects.toMatchObject({ kind: "unavailable" });
    expect(await setting("einvoice_receive_last_error")).toBe("B2Brouter svarar inte, försök igen");
    await db.delete(systemSettings).where(eq(systemSettings.key, "einvoice_api_key"));
    fake.calls.length = 0;
    await expect(receive.receiveNow()).rejects.toMatchObject({ name: "EinvoiceNotConfiguredError" });
    expect(fake.calls).toEqual([]);
  });

  it("keeps sandbox and production apart: the same provider id in both, and the reception log says which", async () => {
    await makeSupplier();
    fake.receive(invoiceXml({ attachment: null }));
    await run();
    await setSetting("einvoice_environment", "production");
    // The production key with it: test_key under Produktion is refused.
    await setSetting("einvoice_api_key", "prod_key");
    fake.state.received.forEach((d) => (d.acked = false));
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(await run()).toMatchObject({ duplicates: 1 });
    const rows = await receptions();
    expect(rows.map((r) => r.environment)).toEqual(["sandbox", "production"]);
    expect(rows[1]!.outcome).toBe("duplicate");
    const list = await receive.receptionLog(10);
    const [scan] = await scans();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ environment: "production", outcome: "duplicate", scanNumber: scan!.scanNumber, documentNumber: "FA-1001", payableAmount: 16901.9, senderName: SELLER.name });
    expect(list[1]).toMatchObject({ environment: "sandbox", outcome: "imported", scanNumber: scan!.scanNumber });
  });
});

describe("the inbox post", () => {
  async function imported() {
    const supplier = await makeSupplier();
    fake.receive(invoiceXml());
    await run();
    const [scan] = await scans();
    return { supplier, scan: scan! };
  }

  it("never goes to the AI: Tolka med AI is refused, automatic AI skips it, Tolka igen re-reads the original", async () => {
    await setSetting("invoice_scan_ai_mode", "fallback");
    await setSetting("invoice_scan_ai_api_key", "sk-test");
    const { scan } = await imported();
    await expect(scanService.interpret(scan.id, "ai")).rejects.toBeInstanceOf(InvoiceScanEinvoiceNoAiError);
    await scanService.automaticAi([scan.id]);
    expect(interpreter.calls).toHaveLength(0);
    // A supplier created after the arrival is matched by Tolka igen.
    await db.delete(suppliers);
    const again = await scanService.interpret(scan.id, "rules");
    expect(again.result!.supplier.matchedSupplierId).toBeNull();
    const created = await makeSupplier({ orgNumber: null, vatNumber: "SE556677889901" });
    const matched = await scanService.interpret(scan.id, "rules");
    expect(matched.result!.supplier).toMatchObject({ matchedSupplierId: created.id, matchedBy: "vat_number" });
  });

  it("converts to a supplier invoice: the PDF moves, the original stays, the LF card knows the post, nothing is learned", async () => {
    const { supplier, scan } = await imported();
    const invoice = await scanService.convert(
      scan.id,
      { supplierId: supplier.id, invoiceNumber: "FA-1001", invoiceDate: "2026-10-21", dueDate: "2026-11-20", netAmount: 13625, vatAmount: 3276.9, grossAmount: 16901.9, paymentReference: { kind: "ocr", value: FAKE_OCR }, rows: [] } as never,
      userId
    );
    expect(invoice!.einvoiceScanId).toBe(scan.id);
    expect(invoice!.files[0]!.filename).toBe("Faktura-FA-1001.pdf");
    const [after] = await scans();
    expect(after).toMatchObject({ status: "converted", data: null, supplierInvoiceId: invoice!.id });
    expect((await scanService.einvoiceOriginal(scan.id)).xml.equals(invoiceXml())).toBe(true);
    expect((await scanService.readFile(scan.id)).data.equals(FAKE_PDF)).toBe(true);
    const [reception] = await receptions();
    expect(reception!.invoiceScanId).toBe(scan.id);
    expect(await db.select().from(invoiceScans).then((r) => r.length)).toBe(1);
    expect(await db.execute(sql`SELECT count(*)::int AS n FROM invoice_scan_hints`).then((r) => (r[0] as { n: number }).n)).toBe(0);
    // Another invoice created by hand has no e-invoice post.
    expect((await supplierInvoiceService.getInvoice(invoice!.id))!.einvoiceScanId).toBe(scan.id);
  });

  it("the reception log is append-only: NV001 on the original and on DELETE; the outcome columns may change", async () => {
    const { scan } = await imported();
    const [row] = await receptions();
    const nv001 = async (p: Promise<unknown>) => {
      try {
        await p;
        expect.unreachable();
      } catch (err) {
        const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
        expect(code).toBe("NV001");
      }
    };
    await nv001(db.update(einvoiceReceptions).set({ originalXml: Buffer.from("x") }).where(eq(einvoiceReceptions.id, row!.id)));
    await nv001(db.update(einvoiceReceptions).set({ documentNumber: "FA-9" }).where(eq(einvoiceReceptions.id, row!.id)));
    await nv001(db.delete(einvoiceReceptions).where(eq(einvoiceReceptions.id, row!.id)));
    await db.update(einvoiceReceptions).set({ detail: "ändrad", outcome: "imported" }).where(eq(einvoiceReceptions.id, row!.id));
    // A rejected post may be deleted: the FK nulls the link, the original stays.
    await scanService.reject(scan.id, "Fel", userId);
    await scanService.remove(scan.id, userId);
    const [kept] = await receptions();
    expect(kept).toMatchObject({ id: row!.id, invoiceScanId: null, detail: "ändrad" });
    expect(kept!.originalXml.equals(invoiceXml())).toBe(true);
  });
});

describe("Ta emot e-faktura and the web hook", () => {
  it("switches the transport's reception, mirrors it, gives an existing hook the received event and shows the live state", async () => {
    await setSetting("einvoice_reception_enabled", "false");
    await setSetting("einvoice_webhook_id", "77");
    await setSetting("einvoice_webhook_secret", "s");
    await setSetting("einvoice_webhook_environment", "sandbox");
    fake.state.webhooks.set("77", { url: "https://nav.example.se/api/v1/einvoice/webhook", events: ["issued_invoice.state_change"] });
    const on = await settings.setReception({ enabled: true }, userId);
    expect(on).toMatchObject({ enabled: true, smlStatus: "not_published", directoryStatus: "not_published", migrationPending: false, documentTypes: ["xml.ubl.invoice.bis3", "xml.ubl.credit_note.bis3"], participantId: "0007:5599114567", intervalMinutes: 15, lastRunAt: null, lastError: null });
    expect(await setting("einvoice_reception_enabled")).toBe("true");
    expect(fake.state.webhooks.get("77")!.events).toEqual(EINVOICE_WEBHOOK_EVENTS);
    expect(fake.calls.filter((c) => c.method === "setReception")[0]!.args[0]).toEqual({ enabled: true, migrationCode: undefined });
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityType, "einvoice_settings"));
    expect(audits.at(-1)).toMatchObject({ action: "reception_enabled", detail: { environment: "sandbox", migrationCode: false, webhookUpdated: true } });

    const view = await settings.view();
    expect(view.reception).toMatchObject({ enabled: true, smlStatus: "not_published", participantId: "0007:5599114567" });

    const off = await settings.setReception({ enabled: false, migrationCode: "ignored" }, userId);
    expect(off.enabled).toBe(false);
    expect(fake.calls.filter((c) => c.method === "setReception").at(-1)!.args[0]).toEqual({ enabled: false, migrationCode: undefined });
    expect(await setting("einvoice_reception_enabled")).toBe("false");
  });

  it("passes the migration code only when enabling, and maps the access point's 409 to the registered-elsewhere error", async () => {
    await settings.setReception({ enabled: true, migrationCode: "ABC-123" }, userId);
    expect(fake.calls.filter((c) => c.method === "setReception").at(-1)!.args[0]).toEqual({ enabled: true, migrationCode: "ABC-123" });
    fake.state.setReceptionError = conflict("Organisationsnumret tas redan emot av en annan accesspunkt — ange migreringskoden från den leverantören");
    await expect(settings.setReception({ enabled: true }, userId)).rejects.toMatchObject({ kind: "conflict" });
    const mapped = fromProviderError(fake.state.setReceptionError as EInvoiceProviderError);
    expect(mapped).toBeInstanceOf(EinvoiceReceptionRegisteredElsewhereError);
    expect(mapped.message).toMatch(/migreringskoden/);
    // Nothing was stored by the refused call.
    expect(await setting("einvoice_reception_enabled")).toBe("true");
  });

  it("the settings view survives an access point that does not answer: the transport fields are null", async () => {
    fake.state.transport = null;
    const view = await settings.view();
    expect(view.reception).toMatchObject({ enabled: true, smlStatus: null, directoryStatus: null, migrationPending: null, documentTypes: [], participantId: null });
    await db.delete(systemSettings).where(eq(systemSettings.key, "einvoice_api_key"));
    fake.calls.length = 0;
    expect((await settings.view()).reception.smlStatus).toBeNull();
    expect(fake.calls).toEqual([]);
  });

  it("a signed received_invoice.created nudges a run (only for the hook's own environment)", async () => {
    const SECRET = "whsec_receive";
    await setSetting("einvoice_webhook_id", "1");
    await setSetting("einvoice_webhook_secret", SECRET);
    await setSetting("einvoice_webhook_environment", "sandbox");
    const body = Buffer.from(JSON.stringify({ code: "received_invoice.created", data: { invoice_id: 99, account_id: 4711, state: "new" } }));
    const sign = (raw: Buffer) => `t=1,s=${createHmac("sha256", SECRET).update("1.").update(raw).digest("hex")}`;
    expect(await webhook.receive(body, sign(body))).toBe(204);
    expect(kicks).toHaveLength(1);
    expect(await webhook.receive(body, "t=1,s=00")).toBe(401);
    await setSetting("einvoice_webhook_environment", "production");
    expect(await webhook.receive(body, sign(body))).toBe(204);
    expect(kicks).toHaveLength(1);
    const other = Buffer.from(JSON.stringify({ code: "received_invoice.state_change", data: { invoice_id: 99 } }));
    expect(await webhook.receive(other, sign(other))).toBe(204);
    expect(kicks).toHaveLength(1);
  });

  it("Markera som hanterad acknowledges an unreadable document and closes the row; the alert counts the rest", async () => {
    const alerts = createAlertsService({
      repo: createAlertsRepository(db),
      planning: {} as never,
      settings: { supplierInvoiceDays: async () => 7, quoteFollowupDays: async () => 7 },
      today: () => "2026-11-05",
    });
    const a = fake.receive(Buffer.from("<nope/>"));
    const b = fake.receive(Buffer.from("<nope2/>"));
    const good = fake.receive(invoiceXml({ attachment: null }));
    await makeSupplier();
    expect(await run()).toMatchObject({ unreadable: 2, imported: 1 });
    const group = (await alerts.computeAlerts(["einvoice_receive_failed"])).groups[0]!;
    expect(group.count).toBe(1);
    expect(group.items[0]).toMatchObject({ key: "einvoice_unreadable", primary: "2 e-fakturor kunde inte läsas — se Mottagningsloggen", href: "/system/e-faktura" });

    const rows = await receptions();
    const rowA = rows.find((r) => r.providerInvoiceId === a)!;
    const rowGood = rows.find((r) => r.providerInvoiceId === good)!;
    // Only an unreadable row can be dismissed; an unknown one is 404.
    await expect(receive.dismiss(rowGood.id, userId)).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    await expect(receive.dismiss("11111111-1111-4111-8111-111111111111", userId)).rejects.toBeInstanceOf(EinvoiceReceptionNotFoundError);
    // A transport failure on the ack changes nothing.
    fake.state.received.get(a)!.ackError = unavailable();
    await expect(receive.dismiss(rowA.id, userId)).rejects.toMatchObject({ kind: "unavailable" });
    expect((await repo.findReception(rowA.id))!.outcome).toBe("unreadable");
    fake.state.received.get(a)!.ackError = undefined;
    const dismissed = await receive.dismiss(rowA.id, userId);
    expect(dismissed).toMatchObject({ id: rowA.id, outcome: "dismissed", detail: RECEIVE_TEXTS.dismissed });
    expect(fake.state.received.get(a)!.acked).toBe(true);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityType, "einvoice_reception"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "dismissed", entityId: rowA.id, userId });
    expect(audits[0]!.detail).toMatchObject({ providerInvoiceId: a });
    // Gone at the access point counts as acknowledged.
    fake.state.received.get(b)!.ackError = new EInvoiceProviderError("Dokumentet finns inte längre hos B2Brouter", "not-found");
    const rowB = rows.find((r) => r.providerInvoiceId === b)!;
    expect((await receive.dismiss(rowB.id, userId)).outcome).toBe("dismissed");
    await expect(receive.dismiss(rowB.id, userId)).rejects.toBeInstanceOf(InvalidStatusTransitionError);
    expect((await alerts.computeAlerts(["einvoice_receive_failed"])).groups[0]!.count).toBe(0);
    // b was never acknowledged at the fake (not-found): it is listed again
    // and only acknowledged, a (acked) is not.
    clock = new Date(clock.getTime() + 20 * 60_000);
    expect(await run()).toMatchObject({ listed: 1, alreadyImported: 1 });
    expect((await receive.receptionLog(10)).map((r) => r.outcome).sort()).toEqual(["dismissed", "dismissed", "imported"]);
  });

  it("kick() runs under the lease when the reception is on", async () => {
    await makeSupplier();
    fake.receive(invoiceXml({ attachment: null }));
    receive.kick();
    for (let i = 0; i < 50 && (await scans()).length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await scans()).toHaveLength(1);
    expect(await setting("einvoice_receive_lease_until")).toBeNull();
  });
});
