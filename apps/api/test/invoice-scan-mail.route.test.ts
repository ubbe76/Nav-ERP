import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { like, sql } from "drizzle-orm";
import { db, permissionGroups, systemSettings } from "@navet/db";
import type { AlertsResponse } from "@navet/shared";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { InvoiceMailboxError } from "../src/modules/purchase/service/invoice-scan/invoice-mailbox.js";
import { createFakeInvoiceInterpreter } from "./helpers/fake-invoice-interpreter.js";
import { buildLetter, createFakeInvoiceMailbox } from "./helpers/fake-invoice-mailbox.js";
import { invoicePdf } from "./helpers/invoice-pdf.js";

// Fakturaskanning steg 3 through the real app with the fake mailbox
// injected in buildApp (never the network): Testa anslutning's answers and
// 409, Senast lästa brev, the alert E-postlådan för fakturor kunde inte
// läsas (admin only, derived from last_error), the routes' permissions and
// Endast läsning. buildApp starts no job: the test runs it by hand.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE invoice_scan_mail_log, invoice_scan_hints, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, supplier_contacts, suppliers, user_settings, users, audit_log CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'FIM%'`;
const mailbox = createFakeInvoiceMailbox();
const interpreter = createFakeInvoiceInterpreter();

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp(db, { invoiceInterpreters: interpreter.factory, invoiceMailboxes: mailbox.factory });
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
  mailbox.reset();
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function adminCookie() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Admin", role: "admin" });
  return login(email);
}

async function userCookie(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `FIM${crypto.randomUUID().slice(0, 6)}`, name: "Fakturainkorg", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

async function saveMailbox(cookie: string, over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/settings/invoice-scan",
    headers: { cookie },
    payload: {
      mailEnabled: true,
      mailHost: "imap.navkund.example",
      mailUser: "fakturor@navkund.example",
      mailPassword: "losen-som-sparats",
      ...over,
    },
  });
  expect(res.statusCode).toBe(200);
}

const mailGroup = async (cookie: string) =>
  ((await app.inject({ url: "/api/v1/alerts", headers: { cookie } })).json() as AlertsResponse).groups.find(
    (g) => g.kind === "invoice_scan_mail_failed"
  );

describe("POST /settings/invoice-scan/test-mail", () => {
  it("answers { ok, unseen, processedFolderExists } with the form's fields and the saved password", async () => {
    const admin = await adminCookie();
    await saveMailbox(admin);
    mailbox.state.inspect = { unseen: 7, processedFolderExists: false };
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/settings/invoice-scan/test-mail",
      headers: { cookie: admin },
      // The web's body: blank password and folders left out.
      payload: { mailHost: "imap.test.example", mailPort: 993, mailTls: true, mailUser: "fakturor@navkund.example" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, unseen: 7, processedFolderExists: false });
    expect(mailbox.configs.at(-1)).toMatchObject({ host: "imap.test.example", password: "losen-som-sparats", folder: "INBOX", processedFolder: "Nav/Inlästa" });
  });

  it("answers 409 invoice-scan-mail-test-failed with the Swedish reason in error and message", async () => {
    const admin = await adminCookie();
    await saveMailbox(admin);
    mailbox.state.inspectError = new InvoiceMailboxError("auth", "AuthenticationFailure");
    const res = await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-mail", headers: { cookie: admin }, payload: {} });
    expect(res.statusCode).toBe(409);
    const text = "Inloggningen till e-postlådan misslyckades — kontrollera användare och lösenord";
    expect(res.json()).toEqual({ error: text, code: "invoice-scan-mail-test-failed", message: text });
  });

  it("refuses an unknown field (400) and is admin only", async () => {
    const admin = await adminCookie();
    const bad = await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-mail", headers: { cookie: admin }, payload: { mailEnabled: true } });
    expect(bad.statusCode).toBe(400);
    const inkop = await userCookie(["inkop"]);
    expect((await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-mail", headers: { cookie: inkop }, payload: {} })).statusCode).toBe(403);
    expect(mailbox.configs).toHaveLength(0);
  });

  it("is refused for a read-only account", async () => {
    const readOnly = await userCookie(["inkop", "forsaljning"], true);
    const res = await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-mail", headers: { cookie: readOnly }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(mailbox.configs).toHaveLength(0);
  });
});

describe("GET /settings/invoice-scan/mail-log", () => {
  it("lists Senast lästa brev newest first in the documented shape, admin only", async () => {
    const admin = await adminCookie();
    await saveMailbox(admin);
    mailbox.deliver(
      await buildLetter({
        from: "faktura@platgrossisten.example",
        subject: "Faktura 1",
        messageId: "<f1@platgrossisten.example>",
        attachments: [{ filename: "f1.pdf", content: await invoicePdf({ invoiceNumber: "F1" }), contentType: "application/pdf" }],
      })
    );
    mailbox.deliver(await buildLetter({ subject: "Hej", messageId: "<hej@platgrossisten.example>", attachments: [] }));
    expect(await app.invoiceScanMail.runMailIfDue()).toMatchObject({ letters: 2, error: null });

    const res = await app.inject({ url: "/api/v1/settings/invoice-scan/mail-log?limit=50", headers: { cookie: admin } });
    expect(res.statusCode).toBe(200);
    const { rows } = res.json() as { rows: Record<string, unknown>[] };
    expect(rows).toHaveLength(2);
    const imported = rows.find((r) => r.outcome === "imported")!;
    expect(imported).toEqual({
      id: expect.any(String),
      runAt: expect.any(String),
      messageId: "<f1@platgrossisten.example>",
      emailFrom: "faktura@platgrossisten.example",
      emailSubject: "Faktura 1",
      receivedAt: "2026-10-20T08:00:00.000Z",
      outcome: "imported",
      detail: expect.stringMatching(/^f1\.pdf → FI-\d+$/),
      scanIds: [expect.any(String)],
    });
    expect(rows.find((r) => r.outcome === "no_attachment")).toMatchObject({ emailSubject: "Hej", scanIds: [] });
    expect(Date.parse(rows[0]!.runAt as string)).toBeGreaterThanOrEqual(Date.parse(rows[1]!.runAt as string));

    // The scan reached the inbox list with its sender.
    const list = await app.inject({ url: "/api/v1/invoice-scans?status=all", headers: { cookie: admin } });
    expect((list.json() as { rows: { source: string; emailFrom: string }[] }).rows).toEqual([
      expect.objectContaining({ source: "email", emailFrom: "faktura@platgrossisten.example" }),
    ]);

    expect((await app.inject({ url: "/api/v1/settings/invoice-scan/mail-log?limit=1", headers: { cookie: admin } })).json().rows).toHaveLength(1);
    expect((await app.inject({ url: "/api/v1/settings/invoice-scan/mail-log?limit=0", headers: { cookie: admin } })).statusCode).toBe(400);
    const inkop = await userCookie(["inkop"]);
    expect((await app.inject({ url: "/api/v1/settings/invoice-scan/mail-log", headers: { cookie: inkop } })).statusCode).toBe(403);
  });
});

describe("the alert E-postlådan för fakturor kunde inte läsas", () => {
  it("shows the last run's error to administrators only, and goes away after a good run or when the box is turned off", async () => {
    const admin = await adminCookie();
    const inkop = await userCookie(["inkop"]);
    await saveMailbox(admin);
    expect((await mailGroup(admin))!.count).toBe(0);

    mailbox.state.connectError = new InvoiceMailboxError("connection", "Error:ECONNREFUSED");
    await app.invoiceScanMail.runMailIfDue();
    const group = (await mailGroup(admin))!;
    expect(group).toMatchObject({
      label: "E-postlådan för fakturor kunde inte läsas",
      severity: "red",
      listHref: "/system/fakturaskanning",
      count: 1,
      error: false,
    });
    expect(group.items[0]).toMatchObject({
      key: "invoice_scan_mail",
      severity: "red",
      href: "/system/fakturaskanning",
      primary: "Kunde inte ansluta till e-postservern — kontrollera server och port",
      secondary: "Lådan har inte lästs någon gång",
    });
    expect(await mailGroup(inkop)).toBeUndefined();

    // The settings page shows the same text.
    const view = await app.inject({ url: "/api/v1/settings/invoice-scan", headers: { cookie: admin } });
    expect(view.json()).toMatchObject({ mailLastError: "Kunde inte ansluta till e-postservern — kontrollera server och port" });
    expect(view.json().mailLastRunAt).toEqual(expect.any(String));

    // Turned off: no alert, though the error is still the last run's.
    await saveMailbox(admin, { mailEnabled: false });
    expect((await mailGroup(admin))!.count).toBe(0);

    // A good run clears it.
    await saveMailbox(admin, { mailEnabled: true });
    mailbox.state.connectError = null;
    await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_mail\\_last\\_run\\_at"));
    expect(await app.invoiceScanMail.runMailIfDue()).toMatchObject({ error: null });
    expect((await mailGroup(admin))!.count).toBe(0);
  });
});
