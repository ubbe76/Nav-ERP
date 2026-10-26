import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { auditLog, db, permissionGroups, suppliers, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { FAKE_OCR, FAKE_SUPPLIER, invoicePdf, jpegImage } from "./helpers/invoice-pdf.js";

// Fakturaskanning through the real app: the routes' shapes, multipart
// upload, the error codes, the permissions (read office, write inkop,
// settings admin), Endast läsning and the write-only settings.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE invoice_scan_hints, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, supplier_contacts, suppliers, user_settings, users, audit_log CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'FIS%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
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
    .values({ code: `FIS${crypto.randomUUID().slice(0, 6)}`, name: "Fakturainkorg", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

function multipart(files: { filename: string; contentType: string; data: Buffer }[]) {
  const boundary = "----navinvoicescantest";
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

async function upload(cookie: string, files: { filename: string; contentType: string; data: Buffer }[]) {
  const body = multipart(files);
  return app.inject({ method: "POST", url: "/api/v1/invoice-scans", payload: body.payload, headers: { ...body.headers, cookie } });
}

// Today's invoice, so the date plausibility never depends on the calendar.
function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Stockholm" });
}

describe("/invoice-scans", () => {
  it("uploads several files, lists, reads and serves them", async () => {
    const cookie = await adminCookie();
    const [supplier] = await db
      .insert(suppliers)
      .values({ supplierNumber: "L-FI-1", name: FAKE_SUPPLIER.name, orgNumber: FAKE_SUPPLIER.orgNumber, currency: "SEK" })
      .returning();
    const pdf = await invoicePdf({ invoiceDate: today(), dueDate: today() });
    const res = await upload(cookie, [
      { filename: "faktura.pdf", contentType: "application/pdf", data: pdf },
      { filename: "foto.jpg", contentType: "image/jpeg", data: jpegImage() },
      { filename: "faktura.xml", contentType: "application/xml", data: Buffer.from("<x/>") },
    ]);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.created).toHaveLength(2);
    expect(body.created[0]).toMatchObject({ filename: "faktura.pdf", status: "interpreted", supplierId: supplier!.id, invoiceNumber: "10045", uncertain: false });
    expect(body.duplicates).toEqual([]);
    expect(body.rejected).toEqual([{ filename: "faktura.xml", reason: "Filtypen stöds inte — ladda upp PDF, JPEG eller PNG" }]);

    // The same file again: nothing created, 200, the existing scan named.
    const again = await upload(cookie, [{ filename: "igen.pdf", contentType: "application/pdf", data: pdf }]);
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicates).toEqual([
      { filename: "igen.pdf", existing: { id: body.created[0].id, scanNumber: body.created[0].scanNumber, status: "interpreted" } },
    ]);

    const list = await app.inject({ url: "/api/v1/invoice-scans", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ total: 2 });
    expect(list.json().rows[0]).not.toHaveProperty("data");
    const searched = await app.inject({ url: `/api/v1/invoice-scans?search=${encodeURIComponent(FAKE_SUPPLIER.name)}`, headers: { cookie } });
    expect(searched.json()).toMatchObject({ total: 1, rows: [{ id: body.created[0].id }] });
    expect((await app.inject({ url: "/api/v1/invoice-scans?status=rejected", headers: { cookie } })).json()).toEqual({ rows: [], total: 0 });

    const detail = await app.inject({ url: `/api/v1/invoice-scans/${body.created[0].id}`, headers: { cookie } });
    expect(detail.json()).toMatchObject({ status: "interpreted", aiAvailable: false, poMatching: true, result: { invoiceNumber: { value: "10045" } } });
    expect(detail.json()).not.toHaveProperty("data");

    const file = await app.inject({ url: `/api/v1/invoice-scans/${body.created[0].id}/file`, headers: { cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(String(file.headers["content-disposition"])).toMatch(/^inline/);
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    expect(file.rawPayload.equals(pdf)).toBe(true);
  });

  it("refuses more than 20 files in one upload (400) and creates none", async () => {
    const cookie = await adminCookie();
    const files = Array.from({ length: 21 }, (_, i) => ({
      filename: `foto-${i}.jpg`,
      contentType: "image/jpeg",
      data: Buffer.concat([jpegImage(), Buffer.from([i])]),
    }));
    const res = await upload(cookie, files);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Högst 20 filer per uppladdning");
    expect((await app.inject({ url: "/api/v1/invoice-scans?status=all", headers: { cookie } })).json().total).toBe(0);
  });

  it("converts to a supplier invoice draft and maps the refusals", async () => {
    const cookie = await adminCookie();
    const [supplier] = await db
      .insert(suppliers)
      .values({ supplierNumber: "L-FI-2", name: FAKE_SUPPLIER.name, orgNumber: FAKE_SUPPLIER.orgNumber, currency: "SEK" })
      .returning();
    const created = (await upload(cookie, [{ filename: "f.pdf", contentType: "application/pdf", data: await invoicePdf() }])).json().created[0];
    const ai = await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/interpret`, payload: { engine: "ai" }, headers: { cookie } });
    expect(ai.statusCode).toBe(409);
    expect(ai.json().code).toBe("invoice-scan-ai-not-configured");
    const rules = await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/interpret`, payload: {}, headers: { cookie } });
    expect(rules.statusCode).toBe(200);

    const payload = {
      supplierId: supplier!.id,
      invoiceNumber: "10045",
      invoiceDate: today(),
      netAmount: 1000,
      vatAmount: 250,
      grossAmount: 1250,
      paymentReference: { kind: "ocr", value: FAKE_OCR },
    };
    const converted = await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/convert`, payload, headers: { cookie } });
    expect(converted.statusCode).toBe(201);
    expect(converted.json()).toMatchObject({ status: "draft", registrationNumber: expect.stringMatching(/^LF-/), files: [{ filename: "f.pdf" }] });
    const again = await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/convert`, payload, headers: { cookie } });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("invalid-status-transition");

    // The underlag that came from the inbox stays on the draft.
    const invoice = converted.json();
    const del = await app.inject({ method: "DELETE", url: `/api/v1/supplier-invoices/${invoice.id}/files/${invoice.files[0].id}`, headers: { cookie } });
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe("supplier-invoice-file-from-scan");

    // A duplicate invoice number answers as the supplier invoices do.
    const other = (await upload(cookie, [{ filename: "g.pdf", contentType: "application/pdf", data: await invoicePdf({ invoiceNumber: "777" }) }])).json().created[0];
    const duplicate = await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${other.id}/convert`, payload, headers: { cookie } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("duplicate-supplier-invoice-number");
  });

  it("rejects, restores and deletes", async () => {
    const cookie = await adminCookie();
    const created = (await upload(cookie, [{ filename: "r.pdf", contentType: "application/pdf", data: await invoicePdf() }])).json().created[0];
    expect((await app.inject({ method: "DELETE", url: `/api/v1/invoice-scans/${created.id}`, headers: { cookie } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/reject`, payload: { reason: " " }, headers: { cookie } })).statusCode).toBe(400);
    const rejected = await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/reject`, payload: { reason: "Reklam" }, headers: { cookie } });
    expect(rejected.json()).toMatchObject({ status: "rejected", rejectedReason: "Reklam" });
    const restored = await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/restore`, headers: { cookie } });
    expect(restored.json()).toMatchObject({ status: "interpreted" });
    await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/reject`, payload: { reason: "Reklam" }, headers: { cookie } });
    expect((await app.inject({ method: "DELETE", url: `/api/v1/invoice-scans/${created.id}`, headers: { cookie } })).statusCode).toBe(204);
    const gone = await app.inject({ url: `/api/v1/invoice-scans/${created.id}`, headers: { cookie } });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().code).toBe("invoice-scan-not-found");
    expect((await app.inject({ url: "/api/v1/invoice-scans/inte-ett-id", headers: { cookie } })).statusCode).toBe(400);
  });

  it("lets every office user read, only Inköp write, and nobody without a menu", async () => {
    const admin = await adminCookie();
    const created = (await upload(admin, [{ filename: "p.pdf", contentType: "application/pdf", data: await invoicePdf() }])).json().created[0];
    const lager = await userCookie(["lager"]);
    expect((await app.inject({ url: "/api/v1/invoice-scans", headers: { cookie: lager } })).statusCode).toBe(200);
    expect((await app.inject({ url: `/api/v1/invoice-scans/${created.id}/file`, headers: { cookie: lager } })).statusCode).toBe(200);
    expect((await upload(lager, [{ filename: "x.pdf", contentType: "application/pdf", data: await invoicePdf({ invoiceNumber: "1" }) }])).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/reject`, payload: { reason: "x" }, headers: { cookie: lager } })).statusCode).toBe(403);
    const terminal = await userCookie(["terminal"]);
    expect((await app.inject({ url: "/api/v1/invoice-scans", headers: { cookie: terminal } })).statusCode).toBe(403);
    const inkop = await userCookie(["inkop"]);
    expect((await upload(inkop, [{ filename: "y.pdf", contentType: "application/pdf", data: await invoicePdf({ invoiceNumber: "2" }) }])).statusCode).toBe(201);
    // Endast läsning: no upload, no interpretation, even with Inköp.
    const readOnly = await userCookie(["inkop"], true);
    const refused = await upload(readOnly, [{ filename: "z.pdf", contentType: "application/pdf", data: await invoicePdf({ invoiceNumber: "3" }) }]);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("read-only-account");
    expect((await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${created.id}/interpret`, payload: {}, headers: { cookie: readOnly } })).statusCode).toBe(403);
  });
});

describe("/settings/invoice-scan", () => {
  it("is admin-only and never returns or logs the secrets", async () => {
    const admin = await adminCookie();
    const inkop = await userCookie(["inkop"]);
    expect((await app.inject({ url: "/api/v1/settings/invoice-scan", headers: { cookie: inkop } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { poMatching: false }, headers: { cookie: inkop } })).statusCode).toBe(403);

    const defaults = await app.inject({ url: "/api/v1/settings/invoice-scan", headers: { cookie: admin } });
    expect(defaults.json()).toEqual({
      aiMode: "off",
      aiApiKeySet: false,
      aiModel: "claude-opus-5-5",
      poMatching: true,
      mailEnabled: false,
      mailHost: null,
      mailPort: 993,
      mailTls: true,
      mailUser: null,
      mailPasswordSet: false,
      mailFolder: "INBOX",
      mailProcessedFolder: "Nav/Inlästa",
      mailIntervalMinutes: 5,
      mailLastRunAt: null,
      mailLastError: null,
    });

    const secretKey = "sk-test-påhittad-nyckel".replace("å", "a");
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings/invoice-scan",
      payload: { aiMode: "manual", aiApiKey: secretKey, aiModel: "claude-sonnet-5-5", mailPassword: "hemligt-lösen".replace("ö", "o"), mailHost: "imap.example.com" },
      headers: { cookie: admin },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ aiMode: "manual", aiApiKeySet: true, aiModel: "claude-sonnet-5-5", mailPasswordSet: true, mailHost: "imap.example.com" });
    expect(JSON.stringify(saved.json())).not.toContain(secretKey);
    const logged = await db.select().from(auditLog).where(eq(auditLog.entityType, "invoice_scan_settings"));
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0]!.detail)).not.toContain(secretKey);
    expect(logged[0]!.detail).toEqual({
      keys: ["invoice_scan_ai_api_key", "invoice_scan_ai_mode", "invoice_scan_ai_model", "invoice_scan_mail_host", "invoice_scan_mail_password"],
    });

    // "" keeps the stored secret, null removes it.
    const kept = await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { aiApiKey: "" }, headers: { cookie: admin } });
    expect(kept.json().aiApiKeySet).toBe(true);
    const removed = await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { aiApiKey: null }, headers: { cookie: admin } });
    expect(removed.json().aiApiKeySet).toBe(false);

    // The saved password never follows a changed server or user (400 with
    // the Swedish text); typed again, it is fine.
    const account = await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { mailUser: "fakturor@example.com", mailPassword: "hemligt-losen" }, headers: { cookie: admin } });
    expect(account.statusCode).toBe(200);
    const otherHost = await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { mailHost: "imap.annan.example", mailPassword: "" }, headers: { cookie: admin } });
    expect(otherHost.statusCode).toBe(400);
    expect(otherHost.json()).toMatchObject({ code: "invoice-scan-mail-password-required", message: expect.stringMatching(/^Skriv in lösenordet igen/) });
    expect((await app.inject({ url: "/api/v1/settings/invoice-scan", headers: { cookie: admin } })).json().mailHost).toBe("imap.example.com");
    const sameHost = await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { mailHost: " IMAP.example.com " }, headers: { cookie: admin } });
    expect(sameHost.statusCode).toBe(200);
    const retyped = await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { mailHost: "imap.annan.example", mailUser: "ny@example.com", mailPassword: "nytt-losen" }, headers: { cookie: admin } });
    expect(retyped.statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { mailUser: "tredje@example.com" }, headers: { cookie: admin } })).statusCode).toBe(400);

    // Mapp för inlästa is never the folder that is read.
    const sameBody = await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { mailFolder: "INBOX", mailProcessedFolder: "inbox" }, headers: { cookie: admin } });
    expect(sameBody.statusCode).toBe(400);
    const againstSaved = await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { mailProcessedFolder: "INBOX" }, headers: { cookie: admin } });
    expect(againstSaved.statusCode).toBe(400);
    expect(againstSaved.json()).toMatchObject({ code: "invoice-scan-mail-folders-equal", message: "Mapp för inlästa får inte vara samma mapp som den som läses" });

    expect((await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { aiModel: "gpt-x" }, headers: { cookie: admin } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { mailIntervalMinutes: 0 }, headers: { cookie: admin } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/settings/invoice-scan", payload: { unknown: 1 }, headers: { cookie: admin } })).statusCode).toBe(400);
  });
});
