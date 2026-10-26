import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { like, sql } from "drizzle-orm";
import { db, permissionGroups, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { createFakeInvoiceInterpreter, InvoiceInterpreterError, sampleAiFields } from "./helpers/fake-invoice-interpreter.js";
import { jpegImage } from "./helpers/invoice-pdf.js";

// Fakturaskanning steg 2 through the real app with the fake interpreter
// injected in buildApp (never the network): Tolka med AI's answers and
// error codes, the automatic AI after the upload's answer, Testa anslutning
// (admin, not readOnlySafe) and its 409.

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE invoice_scan_hints, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, supplier_contacts, suppliers, user_settings, users, audit_log CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'FIA%'`;
const fake = createFakeInvoiceInterpreter();

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp(db, { invoiceInterpreters: fake.factory });
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.delete(systemSettings).where(like(systemSettings.key, "invoice\\_scan\\_%"));
  fake.calls.length = 0;
  fake.tests.length = 0;
  fake.state.fields = sampleAiFields();
  fake.state.error = null;
  fake.state.testError = null;
  fake.state.gate = null;
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
    .values({ code: `FIA${crypto.randomUUID().slice(0, 6)}`, name: "Fakturainkorg", permissions })
    .returning();
  const email = `user-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "Användare", role: "user", permissionGroupId: group!.id, readOnly });
  return login(email);
}

async function uploadPhoto(cookie: string, filler = 0) {
  const boundary = "----navinvoicescanaitest";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="foto.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    jpegImage(),
    Buffer.from([filler]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/invoice-scans",
    payload,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, cookie },
  });
  expect(res.statusCode).toBe(201);
  return res.json().created[0] as { id: string };
}

async function setAi(admin: string, aiMode: "off" | "fallback" | "manual") {
  const res = await app.inject({
    method: "PATCH",
    url: "/api/v1/settings/invoice-scan",
    payload: { aiMode, aiApiKey: "sk-route-test", aiModel: "claude-opus-5-5" },
    headers: { cookie: admin },
  });
  expect(res.statusCode).toBe(200);
}

const interpret = (id: string, cookie: string) =>
  app.inject({ method: "POST", url: `/api/v1/invoice-scans/${id}/interpret`, payload: { engine: "ai" }, headers: { cookie } });

describe("POST /invoice-scans/:id/interpret with engine ai", () => {
  it("answers with the detail, an AI failure as aiError (not an HTTP error), and 409 invoice-scan-busy", async () => {
    const admin = await adminCookie();
    const inkop = await userCookie(["inkop"]);
    const scan = await uploadPhoto(inkop);
    await setAi(admin, "manual");

    const ok = await interpret(scan.id, inkop);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ interpretedBy: "ai", aiAvailable: true, aiError: null, result: { invoiceNumber: { source: "ai" } } });

    fake.state.error = new InvoiceInterpreterError("unauthorized");
    const failed = await interpret(scan.id, inkop);
    expect(failed.statusCode).toBe(200);
    expect(failed.json().aiError).toBe("API-nyckeln godkändes inte");
    fake.state.error = null;

    const gate = fake.hold();
    const running = interpret(scan.id, inkop);
    await gate.entered;
    const busy = await interpret(scan.id, inkop);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().code).toBe("invoice-scan-busy");
    gate.release();
    expect((await running).statusCode).toBe(200);
  });

  it("answers 409 invoice-scan-ai-not-configured in läge Av", async () => {
    const admin = await adminCookie();
    const scan = await uploadPhoto(admin);
    await setAi(admin, "off");
    const res = await interpret(scan.id, admin);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("invoice-scan-ai-not-configured");
  });
});

describe("automatic AI after the upload", () => {
  it("runs after the upload has answered, in läge Automatiskt", async () => {
    const admin = await adminCookie();
    await setAi(admin, "fallback");
    const gate = fake.hold();
    // The upload answers while the AI call is still held open.
    const scan = await uploadPhoto(admin, 7);
    await gate.entered;
    expect(fake.calls).toHaveLength(1);
    gate.release();
    await vi.waitFor(
      async () => {
        const detail = await app.inject({ url: `/api/v1/invoice-scans/${scan.id}`, headers: { cookie: admin } });
        expect(detail.json().interpretedBy).toBe("ai");
      },
      { timeout: 5000, interval: 50 }
    );
  });

  it("does not run in läge Bara med knappen", async () => {
    const admin = await adminCookie();
    await setAi(admin, "manual");
    await uploadPhoto(admin, 8);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.calls).toHaveLength(0);
  });
});

describe("POST /settings/invoice-scan/test-ai", () => {
  it("is admin-only, refused for read-only accounts, saves nothing and answers { ok, model }", async () => {
    const inkop = await userCookie(["inkop"]);
    expect((await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-ai", payload: { apiKey: "sk-x" }, headers: { cookie: inkop } })).statusCode).toBe(403);

    // Endast läsning (an administrator can never be read-only): refused too.
    const readOnly = await userCookie(["inkop"], true);
    const refused = await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-ai", payload: { apiKey: "sk-x" }, headers: { cookie: readOnly } });
    expect(refused.statusCode).toBe(403);
    expect(fake.tests).toHaveLength(0);

    const admin = await adminCookie();
    const ok = await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-ai", payload: { apiKey: "sk-typed", model: "claude-haiku-5-5" }, headers: { cookie: admin } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, model: "claude-haiku-5-5" });
    expect(fake.tests).toEqual([{ apiKey: "sk-typed", model: "claude-haiku-5-5" }]);
    const view = await app.inject({ url: "/api/v1/settings/invoice-scan", headers: { cookie: admin } });
    expect(view.json()).toMatchObject({ aiApiKeySet: false });
  });

  it("answers 409 invoice-scan-ai-test-failed with the Swedish reason", async () => {
    const admin = await adminCookie();
    const noKey = await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-ai", payload: {}, headers: { cookie: admin } });
    expect(noKey.statusCode).toBe(409);
    expect(noKey.json()).toMatchObject({ code: "invoice-scan-ai-test-failed", message: "Ingen API-nyckel angiven", error: "Ingen API-nyckel angiven" });

    fake.state.testError = new InvoiceInterpreterError("model_unavailable");
    const res = await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-ai", payload: { apiKey: "sk-x" }, headers: { cookie: admin } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "invoice-scan-ai-test-failed", message: "API-nyckeln har inte tillgång till den valda modellen" });

    const bad = await app.inject({ method: "POST", url: "/api/v1/settings/invoice-scan/test-ai", payload: { model: "gpt-4" }, headers: { cookie: admin } });
    expect(bad.statusCode).toBe(400);
  });
});
