import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, like, sql } from "drizzle-orm";
import { auditLog, companyInfo, db, invoiceScanMailLog, invoiceScans, suppliers, systemSettings } from "@navet/db";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createSystemRepository } from "../src/modules/system/repository/system.repository.js";
import { createSystemService } from "../src/modules/system/service/system.service.js";
import { createSupplierInvoiceRepository } from "../src/modules/purchase/repository/supplier-invoice.repository.js";
import { createSupplierInvoiceService } from "../src/modules/purchase/service/supplier-invoice.service.js";
import { createInvoiceScanRepository } from "../src/modules/purchase/repository/invoice-scan.repository.js";
import { createInvoiceScanService } from "../src/modules/purchase/service/invoice-scan.service.js";
import { createInvoiceScanSettingsService } from "../src/modules/purchase/service/invoice-scan-settings.service.js";
import {
  createInvoiceScanMailService,
  InvoiceScanMailTestFailedError,
  isMailDue,
  MAIL_LEASE_MS,
  MAIL_MAX_LETTERS,
  MAIL_MAX_MESSAGE_BYTES,
} from "../src/modules/purchase/service/invoice-scan-mail.service.js";
import { InvoiceMailboxError } from "../src/modules/purchase/service/invoice-scan/invoice-mailbox.js";
import { imapflowOptions, toMailboxError } from "../src/modules/purchase/service/invoice-scan/imapflow-mailbox.js";
import { MAIL_MAX_ATTACHMENTS } from "../src/modules/purchase/service/invoice-scan/mail-selection.js";
import {
  InvoiceScanMailFoldersEqualError,
  InvoiceScanMailPasswordRequiredError,
} from "../src/modules/purchase/service/invoice-scan-settings.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";
import { createFakeInvoiceInterpreter, sampleAiFields } from "./helpers/fake-invoice-interpreter.js";
import { buildLetter, createFakeInvoiceMailbox } from "./helpers/fake-invoice-mailbox.js";
import { FAKE_BUYER, FAKE_SUPPLIER, invoicePdf, jpegImage, pngImage } from "./helpers/invoice-pdf.js";

// Fakturaskanning steg 3 — the e-mail box against the database, through the
// fake mailbox (real MIME, never the network): the attachment selection,
// the idempotency when the move fails, the synthetic Message-ID, the
// duplicate on sha256, the lease and the interval, a box turned off, the
// rules and automatic AI after the import (avsändarregeln), the connection
// error as Swedish text, Testa anslutning, the password never in a log.
// All data is made up.

const PASSWORD = "hemligt-losen-123";
const audit = createAuditRepository(db);
const systemService = createSystemService(createSystemRepository(db));
const supplierInvoiceService = createSupplierInvoiceService(
  createSupplierInvoiceRepository(db),
  createVerificationPoster({ read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) }),
  audit
);
const fake = createFakeInvoiceInterpreter();
const mailbox = createFakeInvoiceMailbox();
const repo = createInvoiceScanRepository(db);
const settings = createInvoiceScanSettingsService({ repo, audit, interpreters: fake.factory });
const logs: unknown[] = [];
const log = (msg: string, extra?: unknown) => logs.push({ msg, extra });
const scanService = createInvoiceScanService({
  repo,
  supplierInvoices: supplierInvoiceService,
  company: systemService,
  settings,
  audit,
  interpreters: fake.factory,
  log,
});
let clock = new Date("2026-10-20T10:00:00Z");
const mail = createInvoiceScanMailService({ repo, settings, scans: scanService, mailboxes: mailbox.factory, audit, now: () => clock, log });
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE invoice_scan_mail_log, invoice_scan_hints, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, supplier_contacts, suppliers, audit_log, users CASCADE`;

let companyBefore: typeof companyInfo.$inferSelect | undefined;
let userId: string;

beforeAll(async () => {
  [companyBefore] = await db.select().from(companyInfo).limit(1);
  if (!companyBefore) await db.insert(companyInfo).values({ name: FAKE_BUYER.name });
  await db.update(companyInfo).set({ name: FAKE_BUYER.name, orgNumber: FAKE_BUYER.orgNumber, vatNumber: FAKE_BUYER.vatNumber, bankgiro: FAKE_BUYER.bankgiro, plusgiro: null, iban: null });
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
  const user = await authRepo.create({ email: `fim-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Admin", role: "admin" });
  userId = user.id;
  mailbox.reset();
  fake.calls.length = 0;
  fake.state.fields = sampleAiFields();
  fake.state.error = null;
  logs.length = 0;
  clock = new Date("2026-10-20T10:00:00Z");
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

async function enableMail(over: Record<string, unknown> = {}) {
  await settings.update(
    {
      mailEnabled: true,
      mailHost: "imap.navkund.example",
      mailPort: 993,
      mailTls: true,
      mailUser: "fakturor@navkund.example",
      mailPassword: PASSWORD,
      mailIntervalMinutes: 5,
      ...over,
    },
    userId
  );
}

// A run that is always due: the clock moves past the interval first.
async function run() {
  clock = new Date(clock.getTime() + 60 * 60_000);
  const result = await mail.runMailIfDue();
  // Automatic AI is queued behind the run; an empty call resolves after it.
  await scanService.automaticAi([]);
  return result;
}

const scans = () => db.select().from(invoiceScans).orderBy(asc(invoiceScans.scanNumber));
const mailLog = () => db.select().from(invoiceScanMailLog).orderBy(asc(invoiceScanMailLog.runAt), asc(invoiceScanMailLog.id));
async function setting(key: string) {
  const [row] = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  return row?.value ?? null;
}
const bigJpeg = () => Buffer.concat([jpegImage(), Buffer.alloc(40 * 1024, 0x22)]);
const pdfAttachment = async (invoiceNumber = "4711", filename = "faktura.pdf") => ({
  filename,
  content: await invoicePdf({ invoiceNumber }),
  contentType: "application/pdf",
});

describe("isMailDue", () => {
  it("is due without an earlier run and once the interval (less a margin) has passed", () => {
    const now = new Date("2026-10-20T10:00:00Z");
    expect(isMailDue(null, 5, now)).toBe(true);
    expect(isMailDue(new Date("2026-10-20T09:55:30Z"), 5, now)).toBe(true);
    expect(isMailDue(new Date("2026-10-20T09:56:00Z"), 5, now)).toBe(false);
    expect(isMailDue(new Date("2026-10-20T09:59:30Z"), 1, now)).toBe(true);
    expect(isMailDue(new Date("2026-10-20T09:59:50Z"), 1, now)).toBe(false);
  });
});

describe("the job's guards", () => {
  it("does nothing while the box is turned off", async () => {
    mailbox.deliver(await buildLetter({ attachments: [await pdfAttachment()] }));
    await enableMail({ mailEnabled: false });
    expect(await run()).toBe("disabled");
    expect(mailbox.state.connects).toBe(0);
    expect(await scans()).toHaveLength(0);
    expect(await setting("invoice_scan_mail_last_run_at")).toBeNull();
  });

  it("waits for the interval after a run", async () => {
    await enableMail();
    expect(await mail.runMailIfDue()).toMatchObject({ letters: 0, error: null });
    clock = new Date(clock.getTime() + 2 * 60_000);
    expect(await mail.runMailIfDue()).toBe("not-due");
    clock = new Date(clock.getTime() + 3 * 60_000);
    expect(await mail.runMailIfDue()).toMatchObject({ letters: 0 });
    expect(mailbox.state.connects).toBe(2);
  });

  it("honours a live lease and releases its own", async () => {
    await enableMail();
    clock = new Date("2026-10-20T12:00:00Z");
    await db.insert(systemSettings).values({ key: "invoice_scan_mail_lease_until", value: "2026-10-20T12:05:00.000Z" });
    expect(await mail.runMailIfDue()).toBe("busy");
    expect(mailbox.state.connects).toBe(0);
    // An expired lease is taken over, and released after the run.
    clock = new Date("2026-10-20T12:06:00Z");
    expect(await mail.runMailIfDue()).toMatchObject({ letters: 0 });
    expect(await setting("invoice_scan_mail_lease_until")).toBeNull();
  });

  it("reads at most MAIL_MAX_LETTERS letters per run, oldest first", async () => {
    await enableMail();
    const letter = await buildLetter({ attachments: [] });
    for (let i = 0; i < MAIL_MAX_LETTERS + 3; i++) mailbox.deliver(letter);
    expect(await run()).toMatchObject({ letters: MAIL_MAX_LETTERS });
    expect(mailbox.state.inbox.map((l) => l.uid)).toEqual([51, 52, 53]);
  });

  it("writes a missing server, user or password as last_error without connecting", async () => {
    await enableMail({ mailPassword: null });
    expect(await run()).toMatchObject({ error: "E-postlådan saknar server, användare eller lösenord" });
    expect(mailbox.state.connects).toBe(0);
    expect(await setting("invoice_scan_mail_last_error")).toBe("E-postlådan saknar server, användare eller lösenord");
  });
});

describe("a letter", () => {
  it("becomes a scan per PDF with the letter's headers, is interpreted, logged, audited and moved", async () => {
    await enableMail();
    mailbox.deliver(
      await buildLetter({
        from: "Plåtgrossisten <Faktura@Platgrossisten.example>",
        subject: "Faktura 4711 från Plåtgrossisten",
        messageId: "<faktura-4711@platgrossisten.example>",
        attachments: [await pdfAttachment("4711", "faktura-4711.pdf")],
      })
    );
    const result = await run();
    expect(result).toMatchObject({ letters: 1, moveFailed: 0, error: null });

    const [scan] = await scans();
    expect(scan).toMatchObject({
      source: "email",
      status: "interpreted",
      interpretedBy: "rules",
      filename: "faktura-4711.pdf",
      contentType: "application/pdf",
      emailMessageId: "<faktura-4711@platgrossisten.example>",
      emailAttachmentIndex: 0,
      emailFrom: "faktura@platgrossisten.example",
      emailSubject: "Faktura 4711 från Plåtgrossisten",
      uploadedBy: null,
    });
    expect(scan!.emailReceivedAt?.toISOString()).toBe("2026-10-20T08:00:00.000Z");
    expect((scan!.result as { invoiceNumber: { value: string } }).invoiceNumber.value).toBe("4711");

    const [entry] = await mailLog();
    expect(entry).toMatchObject({
      outcome: "imported",
      messageId: "<faktura-4711@platgrossisten.example>",
      emailFrom: "faktura@platgrossisten.example",
      emailSubject: "Faktura 4711 från Plåtgrossisten",
      scanIds: [scan!.id],
    });
    expect(entry!.detail).toBe(`faktura-4711.pdf → ${scan!.scanNumber}`);

    expect(mailbox.state.inbox).toHaveLength(0);
    expect(mailbox.state.processed).toHaveLength(1);
    expect(mailbox.state.closes).toBe(1);
    const [received] = await db.select().from(auditLog).where(eq(auditLog.action, "received"));
    expect(received).toMatchObject({ entityType: "invoice_scan", entityId: scan!.scanNumber, userId: null });
    expect(received!.detail).toMatchObject({ source: "email", filename: "faktura-4711.pdf", from: "faktura@platgrossisten.example" });
    expect(await setting("invoice_scan_mail_last_error")).toBeNull();
    expect(await setting("invoice_scan_mail_last_success_at")).not.toBeNull();
  });

  it("imports every PDF and skips the inline logo, the image beside a PDF and the XML", async () => {
    await enableMail();
    mailbox.deliver(
      await buildLetter({
        attachments: [
          { filename: "logo.png", content: Buffer.concat([pngImage(300), Buffer.alloc(40 * 1024)]), contentType: "image/png", cid: "logo@sig" },
          await pdfAttachment("A-1", "a.pdf"),
          { filename: "faktura.xml", content: Buffer.from("<Invoice/>"), contentType: "application/xml" },
          { filename: "foto.jpg", content: bigJpeg(), contentType: "image/jpeg" },
          await pdfAttachment("A-2", "b.pdf"),
        ],
      })
    );
    await run();
    const rows = await scans();
    expect(rows.map((r) => [r.filename, r.emailAttachmentIndex])).toEqual([
      ["a.pdf", 1],
      ["b.pdf", 4],
    ]);
    const [entry] = await mailLog();
    expect(entry!.outcome).toBe("imported");
    expect(entry!.scanIds).toHaveLength(2);
    expect(entry!.detail).toBe(
      [
        "logo.png: inbäddad bild (t.ex. logotyp) hoppades över",
        `a.pdf → ${rows[0]!.scanNumber}`,
        "faktura.xml: filtypen stöds inte",
        "foto.jpg: bilden hoppades över — brevet har en PDF",
        `b.pdf → ${rows[1]!.scanNumber}`,
      ].join("; ")
    );
  });

  it("imports a photo when the letter has no PDF, but not a small image or an inline logo", async () => {
    await enableMail();
    mailbox.deliver(await buildLetter({ subject: "Foto", attachments: [{ filename: "foto.jpg", content: bigJpeg(), contentType: "image/jpeg" }] }));
    mailbox.deliver(await buildLetter({ subject: "Liten", attachments: [{ filename: "ikon.jpg", content: jpegImage(), contentType: "image/jpeg" }] }));
    mailbox.deliver(
      await buildLetter({
        subject: "Signatur",
        attachments: [{ filename: "logo.jpg", content: bigJpeg(), contentType: "image/jpeg", cid: "logo@sig" }],
      })
    );
    await run();
    const rows = await scans();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: "foto.jpg", contentType: "image/jpeg", emailSubject: "Foto" });
    expect((await mailLog()).map((l) => [l.emailSubject, l.outcome])).toEqual([
      ["Foto", "imported"],
      ["Liten", "no_attachment"],
      ["Signatur", "no_attachment"],
    ]);
    expect(mailbox.state.processed).toHaveLength(3);
  });

  it("logs a letter without attachments, with only XML and with a PDF over 20 MB — and moves them", async () => {
    await enableMail();
    mailbox.deliver(await buildLetter({ subject: "Hej", attachments: [] }));
    mailbox.deliver(await buildLetter({ subject: "E-faktura", attachments: [{ filename: "faktura.xml", content: Buffer.from("<Invoice/>"), contentType: "text/xml" }] }));
    const huge = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(20 * 1024 * 1024 + 10, 0x20)]);
    mailbox.deliver(await buildLetter({ subject: "Stor", attachments: [{ filename: "stor.pdf", content: huge, contentType: "application/pdf" }] }));
    await run();
    expect(await scans()).toHaveLength(0);
    expect((await mailLog()).map((l) => [l.emailSubject, l.outcome, l.detail])).toEqual([
      ["Hej", "no_attachment", "Brevet har inga bilagor"],
      ["E-faktura", "unsupported", "faktura.xml: filtypen stöds inte"],
      ["Stor", "too_large", "stor.pdf: större än 20 MB"],
    ]);
    expect(mailbox.state.processed).toHaveLength(3);
  }, 60_000);

  it("does not fetch a letter larger than the cap — logged too_large and moved", async () => {
    await enableMail();
    const letter = mailbox.deliver(await buildLetter({ attachments: [await pdfAttachment()] }), MAIL_MAX_MESSAGE_BYTES + 1);
    await run();
    expect(mailbox.state.fetches).not.toContain(letter.uid);
    expect((await mailLog()).map((l) => [l.outcome, l.detail])).toEqual([["too_large", "Brevet är större än 60 MB och lästes inte"]]);
    expect(mailbox.state.processed).toHaveLength(1);
  });

  it("finds a PDF sent as application/octet-stream by its name and refuses a PDF name that is not a PDF", async () => {
    await enableMail();
    const pdf = await invoicePdf({ invoiceNumber: "OCT-1" });
    mailbox.deliver(
      await buildLetter({
        attachments: [
          { filename: "faktura.pdf", content: pdf, contentType: "application/octet-stream" },
          { filename: "falsk.pdf", content: Buffer.from("not a pdf at all"), contentType: "application/pdf" },
        ],
      })
    );
    await run();
    const rows = await scans();
    expect(rows.map((r) => [r.filename, r.contentType])).toEqual([["faktura.pdf", "application/pdf"]]);
    expect((await mailLog())[0]!.detail).toContain("falsk.pdf: innehållet är inte en PDF, JPEG eller PNG");
  });
});

describe("idempotency", () => {
  it("reads a letter again when the move failed, without a second scan — last_error until it is moved", async () => {
    await enableMail();
    const letter = mailbox.deliver(await buildLetter({ messageId: "<flytt@platgrossisten.example>", attachments: [await pdfAttachment()] }));
    mailbox.state.moveErrors.set(letter.uid, new InvoiceMailboxError("move_failed", "NO"));
    expect(await run()).toMatchObject({ letters: 1, moveFailed: 1 });
    expect(await scans()).toHaveLength(1);
    expect(mailbox.state.inbox).toHaveLength(1);
    expect(await setting("invoice_scan_mail_last_error")).toBe(
      "Lästa brev kunde inte flyttas till mappen Nav/Inlästa — de läses igen vid nästa körning"
    );

    mailbox.state.moveErrors.clear();
    expect(await run()).toMatchObject({ letters: 1, moveFailed: 0, error: null, scanIds: [] });
    const rows = await scans();
    expect(rows).toHaveLength(1);
    const entries = await mailLog();
    expect(entries.map((l) => l.outcome)).toEqual(["imported", "duplicate"]);
    expect(entries[1]!.detail).toBe(`faktura.pdf är redan inläst (${rows[0]!.scanNumber})`);
    expect(entries[1]!.scanIds).toEqual([]);
    expect(mailbox.state.processed).toHaveLength(1);
    expect(await setting("invoice_scan_mail_last_error")).toBeNull();
  });

  it("gives a letter without Message-ID a synthetic one that is the same on the next read", async () => {
    await enableMail();
    const letter = mailbox.deliver(await buildLetter({ messageId: null, attachments: [await pdfAttachment()] }));
    expect(letter.source.toString("latin1")).not.toMatch(/^Message-ID:/im);
    mailbox.state.moveErrors.set(letter.uid, new InvoiceMailboxError("move_failed", "NO"));
    await run();
    mailbox.state.moveErrors.clear();
    await run();
    const rows = await scans();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.emailMessageId).toMatch(/^<nav-synthetic-[0-9a-f]{64}@navet\.invalid>$/);
    const entries = await mailLog();
    expect(entries.map((l) => [l.outcome, l.messageId])).toEqual([
      ["imported", rows[0]!.emailMessageId],
      ["duplicate", rows[0]!.emailMessageId],
    ]);
  });

  it("skips a file already live in the inbox (sha256) without burning an FI- number, in the same transaction as the rest", async () => {
    await enableMail();
    const pdf = await invoicePdf({ invoiceNumber: "DUP-1" });
    const uploaded = await scanService.upload([{ filename: "uppladdad.pdf", contentType: "application/pdf", data: pdf, truncated: false }], userId);
    const existing = uploaded.created[0]!;
    mailbox.deliver(
      await buildLetter({
        attachments: [
          { filename: "samma.pdf", content: pdf, contentType: "application/pdf" },
          await pdfAttachment("NY-1", "ny.pdf"),
        ],
      })
    );
    await run();
    const rows = await scans();
    expect(rows.map((r) => r.filename)).toEqual(["uppladdad.pdf", "ny.pdf"]);
    // The new one got the next number: the duplicate burnt none.
    const next = `FI-${Number(existing.scanNumber.slice(3)) + 1}`;
    expect(rows.map((r) => r.scanNumber)).toEqual([existing.scanNumber, next]);
    const [entry] = await mailLog();
    expect(entry!.outcome).toBe("imported");
    expect(entry!.detail).toBe(`samma.pdf fanns redan i inkorgen (${existing.scanNumber}); ny.pdf → ${next}`);

    // Only the duplicate: outcome duplicate.
    mailbox.deliver(await buildLetter({ subject: "Igen", attachments: [{ filename: "igen.pdf", content: pdf, contentType: "application/pdf" }] }));
    await run();
    expect((await mailLog()).map((l) => l.outcome)).toEqual(["imported", "duplicate"]);
    expect(mailbox.state.processed).toHaveLength(2);
  });
});

describe("automatic AI after the import", () => {
  async function aiFallback() {
    await settings.update({ aiMode: "fallback", aiApiKey: "sk-test-key" }, userId);
  }

  it("runs on the new scans when the rules were not enough and the sender is a supplier's, authenticated", async () => {
    await enableMail();
    await aiFallback();
    await db.insert(suppliers).values({ supplierNumber: "L1", name: FAKE_SUPPLIER.name, orgNumber: FAKE_SUPPLIER.orgNumber, currency: "SEK", email: "info@platgrossisten.example" });
    mailbox.deliver(
      await buildLetter({
        from: "ekonomi@platgrossisten.example",
        authenticationResults: ["mx.navkund.example; dkim=pass header.d=platgrossisten.example; dmarc=pass header.from=platgrossisten.example"],
        attachments: [{ filename: "foto.jpg", content: bigJpeg(), contentType: "image/jpeg" }],
      })
    );
    await run();
    expect(fake.calls).toHaveLength(1);
    const [scan] = await scans();
    expect(scan!.interpretedBy).toBe("ai");
  });

  it("never trusts From alone: no Authentication-Results, a failed check, or a forged header below the server's", async () => {
    await enableMail();
    await aiFallback();
    await db.insert(suppliers).values({ supplierNumber: "L1", name: FAKE_SUPPLIER.name, orgNumber: FAKE_SUPPLIER.orgNumber, currency: "SEK", email: "info@platgrossisten.example" });
    const photo = (n: number) => [{ filename: `foto-${n}.jpg`, content: Buffer.concat([bigJpeg(), Buffer.from([n])]), contentType: "image/jpeg" }];
    mailbox.deliver(await buildLetter({ from: "ekonomi@platgrossisten.example", subject: "Utan", attachments: photo(1) }));
    mailbox.deliver(
      await buildLetter({
        from: "ekonomi@platgrossisten.example",
        subject: "Underkänd",
        authenticationResults: ["mx.navkund.example; dkim=fail header.d=platgrossisten.example; dmarc=fail header.from=platgrossisten.example"],
        attachments: photo(2),
      })
    );
    // The sender's own "pass" sits below the receiving server's verdict.
    mailbox.deliver(
      await buildLetter({
        from: "ekonomi@platgrossisten.example",
        subject: "Förfalskad",
        authenticationResults: [
          "mx.navkund.example; dmarc=fail header.from=platgrossisten.example",
          "mx.navkund.example; dmarc=pass header.from=platgrossisten.example",
        ],
        attachments: photo(3),
      })
    );
    await run();
    expect(fake.calls).toHaveLength(0);
    expect((await scans()).map((s) => s.interpretedBy)).toEqual(["rules", "rules", "rules"]);
  });

  it("leaves a scan from an unknown sender to the button (avsändarregeln)", async () => {
    await enableMail();
    await aiFallback();
    mailbox.deliver(
      await buildLetter({
        from: "reklam@okand.example",
        authenticationResults: ["mx.navkund.example; dmarc=pass header.from=okand.example"],
        attachments: [{ filename: "foto.jpg", content: bigJpeg(), contentType: "image/jpeg" }],
      })
    );
    await run();
    expect(fake.calls).toHaveLength(0);
    const [scan] = await scans();
    expect(scan).toMatchObject({ status: "interpreted", interpretedBy: "rules" });
  });
});

describe("the run's limits", () => {
  it(`imports at most ${MAIL_MAX_ATTACHMENTS} attachments of one letter and names the rest`, async () => {
    await enableMail();
    const attachments = [];
    for (let i = 1; i <= MAIL_MAX_ATTACHMENTS + 2; i++) attachments.push(await pdfAttachment(`M-${i}`, `faktura-${i}.pdf`));
    mailbox.deliver(await buildLetter({ attachments }));
    await run();
    expect(await scans()).toHaveLength(MAIL_MAX_ATTACHMENTS);
    const [entry] = await mailLog();
    expect(entry!.outcome).toBe("imported");
    expect(entry!.detail).toContain(`faktura-${MAIL_MAX_ATTACHMENTS + 1}.pdf: fler än ${MAIL_MAX_ATTACHMENTS} fakturabilagor i brevet — lästes inte in`);
    expect(entry!.detail).toContain(`faktura-${MAIL_MAX_ATTACHMENTS + 2}.pdf: fler än`);
    expect(mailbox.state.processed).toHaveLength(1);
  });

  it("renews its lease after every letter and stops after the time budget — the next run takes the rest", async () => {
    await enableMail();
    for (let i = 1; i <= 4; i++) mailbox.deliver(await buildLetter({ subject: `Brev ${i}`, attachments: [await pdfAttachment(`T-${i}`)] }));
    // A clock that moves three minutes on every reading.
    let t = new Date("2026-10-21T10:00:00Z").getTime();
    const leases: string[] = [];
    const ticking = createInvoiceScanMailService({
      repo,
      settings,
      scans: scanService,
      mailboxes: mailbox.factory,
      audit,
      now: () => {
        const at = new Date(t);
        t += 3 * 60_000;
        return at;
      },
      log,
    });
    const renew = repo.renewMailLease.bind(repo);
    repo.renewMailLease = async (until, next) => {
      const value = await renew(until, next);
      if (value) leases.push(value);
      return value;
    };
    try {
      const result = await ticking.runMailIfDue();
      expect(result).toMatchObject({ letters: 3, stoppedEarly: true, error: null });
      // Renewed after letters 1 and 2 (each time MAIL_LEASE_MS ahead), then the budget ran out.
      expect(leases).toHaveLength(2);
      expect(new Date(leases[1]!).getTime() - new Date(leases[0]!).getTime()).toBe(3 * 60_000);
      expect(MAIL_LEASE_MS).toBe(10 * 60_000);
      // The lease was released.
      expect(await setting("invoice_scan_mail_lease_until")).toBeNull();
    } finally {
      repo.renewMailLease = renew;
    }
    expect(mailbox.state.inbox).toHaveLength(1);
    // The shared clock after the ticking run's stamp.
    clock = new Date("2026-10-21T12:00:00Z");
    await run();
    expect(mailbox.state.inbox).toHaveLength(0);
    expect(await scans()).toHaveLength(4);
  });

  it("stops when another run has taken the lease over", async () => {
    await enableMail();
    for (let i = 1; i <= 3; i++) mailbox.deliver(await buildLetter({ subject: `Brev ${i}`, attachments: [await pdfAttachment(`L-${i}`)] }));
    const renew = repo.renewMailLease.bind(repo);
    repo.renewMailLease = async () => null;
    try {
      expect(await run()).toMatchObject({ letters: 1, stoppedEarly: true });
    } finally {
      repo.renewMailLease = renew;
    }
    expect(mailbox.state.inbox).toHaveLength(2);
  });
});

describe("a mailbox that cannot be read", () => {
  it("writes the Swedish text to last_error (never the server's), keeps the letters and clears it after a good run", async () => {
    await enableMail();
    mailbox.deliver(await buildLetter({ attachments: [await pdfAttachment()] }));
    const serverError = Object.assign(new Error(`Invalid credentials for ${PASSWORD}`), { authenticationFailed: true });
    mailbox.state.connectError = toMailboxError(serverError);
    expect(await run()).toMatchObject({ letters: 0, error: "Inloggningen till e-postlådan misslyckades — kontrollera användare och lösenord" });
    expect(await setting("invoice_scan_mail_last_error")).toBe("Inloggningen till e-postlådan misslyckades — kontrollera användare och lösenord");
    expect(await setting("invoice_scan_mail_last_run_at")).not.toBeNull();
    expect(await setting("invoice_scan_mail_last_success_at")).toBeNull();
    expect(mailbox.state.inbox).toHaveLength(1);
    expect(mailbox.state.closes).toBe(1);

    mailbox.state.connectError = null;
    expect(await run()).toMatchObject({ letters: 1, error: null });
    expect(await setting("invoice_scan_mail_last_error")).toBeNull();
    expect(await setting("invoice_scan_mail_last_success_at")).not.toBeNull();
    // Neither the password nor the server's text reached a log line.
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
    expect(JSON.stringify(logs)).not.toContain("Invalid credentials");
  });

  it("stops the run when the connection drops mid-way; the letter is read again next time", async () => {
    await enableMail();
    const first = mailbox.deliver(await buildLetter({ subject: "Ett", attachments: [await pdfAttachment("C-1")] }));
    const second = mailbox.deliver(await buildLetter({ subject: "Två", attachments: [await pdfAttachment("C-2")] }));
    mailbox.state.fetchErrors.set(second.uid, new InvoiceMailboxError("connection", "ECONNRESET"));
    expect(await run()).toMatchObject({ error: "Kunde inte ansluta till e-postservern — kontrollera server och port" });
    expect((await scans()).map((s) => s.emailSubject)).toEqual(["Ett"]);
    expect(mailbox.state.processed.map((l) => l.uid)).toEqual([first.uid]);
    mailbox.state.fetchErrors.clear();
    await run();
    expect((await scans()).map((s) => s.emailSubject)).toEqual(["Ett", "Två"]);
  });

  it("says a letter could not be fetched — not that it could not be moved", async () => {
    await enableMail();
    const letter = mailbox.deliver(await buildLetter({ attachments: [await pdfAttachment()] }));
    mailbox.state.fetchErrors.set(letter.uid, new InvoiceMailboxError("unexpected", "NO"));
    expect(await run()).toMatchObject({ letters: 1, fetchFailed: 1, moveFailed: 0 });
    expect(await setting("invoice_scan_mail_last_error")).toBe("Brev kunde inte hämtas från e-postservern — de läses igen vid nästa körning");
    expect(mailbox.state.inbox).toHaveLength(1);
    mailbox.state.fetchErrors.clear();
    expect(await run()).toMatchObject({ error: null });
  });

  it("logs an empty letter and moves it", async () => {
    await enableMail();
    const letter = mailbox.deliver(Buffer.alloc(0));
    await run();
    // An empty source parses to a letter without anything in it.
    expect((await mailLog()).map((l) => l.outcome)).toEqual(["no_attachment"]);
    expect(mailbox.state.processed.map((l) => l.uid)).toEqual([letter.uid]);
  });
});

describe("toMailboxError", () => {
  it("maps imapflow's and Node's errors to the seam's kinds without the message", () => {
    const kind = (err: unknown) => toMailboxError(err).kind;
    expect(kind(Object.assign(new Error("x"), { authenticationFailed: true }))).toBe("auth");
    expect(kind(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("connection");
    expect(kind(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe("connection");
    expect(kind(Object.assign(new Error("x"), { code: "CONNECT_TIMEOUT" }))).toBe("timeout");
    expect(kind(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }))).toBe("tls");
    expect(kind(Object.assign(new Error("x"), { tlsFailed: true }))).toBe("tls");
    expect(kind(Object.assign(new Error("x"), { mailboxMissing: true }))).toBe("folder_missing");
    expect(kind(new Error("x"))).toBe("unexpected");
    const mapped = toMailboxError(Object.assign(new Error(`secret ${PASSWORD}`), { code: "ECONNRESET" }));
    expect(mapped.detail).toBe("Error:ECONNRESET");
    expect(mapped.message).not.toContain(PASSWORD);
  });
});

describe("Testa anslutning", () => {
  it("uses the form's fields, the saved password when none is typed, and saves nothing", async () => {
    await enableMail({ mailFolder: "Fakturor" });
    expect(await mail.testMail({ mailHost: "imap.annan.example", mailUser: "ny@navkund.example", mailPassword: PASSWORD })).toEqual({
      ok: true,
      unseen: 3,
      processedFolderExists: true,
    });
    expect(mailbox.configs.at(-1)).toEqual({
      host: "imap.annan.example",
      port: 993,
      tls: true,
      user: "ny@navkund.example",
      password: PASSWORD,
      folder: "Fakturor",
      processedFolder: "Nav/Inlästa",
    });
    await mail.testMail({ mailPassword: "nytt-losen", mailProcessedFolder: "Arkiv/Fakturor", mailTls: false, mailPort: 143 });
    expect(mailbox.configs.at(-1)).toMatchObject({ password: "nytt-losen", processedFolder: "Arkiv/Fakturor", tls: false, port: 143 });
    expect(await setting("invoice_scan_mail_password")).toBe(PASSWORD);
    expect(await setting("invoice_scan_mail_host")).toBe("imap.navkund.example");
  });

  it("never sends the saved password to another server or user", async () => {
    await enableMail();
    await expect(mail.testMail({ mailHost: "imap.annan.example" })).rejects.toBeInstanceOf(InvoiceScanMailPasswordRequiredError);
    await expect(mail.testMail({ mailUser: "annan@navkund.example" })).rejects.toBeInstanceOf(InvoiceScanMailPasswordRequiredError);
    expect(mailbox.configs).toHaveLength(0);
    // The saved server and user (case aside) are fine without it.
    await mail.testMail({ mailHost: "IMAP.navkund.example", mailUser: "fakturor@navkund.example" });
    expect(mailbox.configs.at(-1)).toMatchObject({ password: PASSWORD });
    // The settings refuse the same, before anything is written.
    await expect(settings.update({ mailHost: "imap.annan.example", mailPassword: "" }, userId)).rejects.toBeInstanceOf(InvoiceScanMailPasswordRequiredError);
    expect(await setting("invoice_scan_mail_host")).toBe("imap.navkund.example");
    await settings.update({ mailHost: "imap.annan.example", mailPassword: "nytt-losen" }, userId);
    expect(await setting("invoice_scan_mail_host")).toBe("imap.annan.example");
  });

  it("refuses the processed folder being the folder that is read", async () => {
    await enableMail();
    await expect(mail.testMail({ mailProcessedFolder: "inbox" })).rejects.toBeInstanceOf(InvoiceScanMailFoldersEqualError);
    await expect(settings.update({ mailFolder: "Nav/Inlästa/" }, userId)).rejects.toBeInstanceOf(InvoiceScanMailFoldersEqualError);
    expect(await setting("invoice_scan_mail_folder")).toBeNull();
  });

  it("requires STARTTLS when TLS is off — never a clear-text login", () => {
    const base = { host: "imap.navkund.example", port: 143, user: "u", password: PASSWORD, folder: "INBOX", processedFolder: "Nav/Inlästa" };
    expect(imapflowOptions({ ...base, tls: false })).toMatchObject({ secure: false, doSTARTTLS: true });
    const tls = imapflowOptions({ ...base, tls: true, port: 993 });
    expect(tls.secure).toBe(true);
    expect(tls).not.toHaveProperty("doSTARTTLS");
    expect(tls.logger).toBe(false);
  });

  it("fails with the Swedish reason", async () => {
    await enableMail({ mailFolder: "Fakturor" });
    mailbox.state.inspectError = new InvoiceMailboxError("folder_missing", "NONEXISTENT");
    await expect(mail.testMail({})).rejects.toThrow(new InvoiceScanMailTestFailedError("Mappen Fakturor finns inte i e-postlådan"));
    await expect(mail.testMail({ mailHost: null })).rejects.toThrow("E-postlådan saknar server, användare eller lösenord");
  });
});
