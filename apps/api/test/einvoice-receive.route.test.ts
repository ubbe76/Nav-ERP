import type { EinvoiceReceptionView } from "@navet/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { createHash, createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, einvoiceReceptions, invoiceScans, permissionGroups, suppliers, systemSettings } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { einvoiceRoutes } from "../src/modules/einvoice/routes/einvoice.routes.js";
import { EInvoiceProviderError } from "../src/modules/einvoice/service/einvoice-provider.js";
import type { EinvoiceReceiveService } from "../src/modules/einvoice/service/einvoice-receive.service.js";
import type { EinvoiceSettingsService } from "../src/modules/einvoice/service/einvoice-settings.service.js";
import type { EinvoiceStatusService } from "../src/modules/einvoice/service/einvoice-status.service.js";
import type { EinvoiceService } from "../src/modules/einvoice/service/einvoice.service.js";
import { EinvoiceNotConfiguredError, EinvoiceReceiveBusyError, EinvoiceReceptionNotFoundError } from "../src/modules/einvoice/service/einvoice.errors.js";
import { InvalidStatusTransitionError } from "../src/modules/purchase/service/purchase.service.js";
import { buildUblDocument } from "../src/modules/einvoice/service/ubl/ubl-invoice-builder.js";
import { FAKE_PDF, invoiceTwoRatesDiscount, SELLER } from "./helpers/ubl-fixtures.js";
import { FAKE_OCR } from "./helpers/invoice-pdf.js";

// Mottagning through the routes: the envelope with stubbed services, and
// the rules through the real app (admin-only settings, the inbox's office
// read, Endast läsning, the original and the attachments, the LF card's
// einvoiceScanId, the web hook's received_invoice.created).

const ID = "11111111-1111-4111-8111-111111111111";

const RECEPTION_VIEW: EinvoiceReceptionView = {
  enabled: true,
  smlStatus: "published",
  directoryStatus: "processing",
  migrationPending: false,
  documentTypes: ["xml.ubl.invoice.bis3"],
  participantId: "0007:5599114567",
  intervalMinutes: 15,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
};

function routesApp(settings: Partial<EinvoiceSettingsService> = {}, receive: Partial<EinvoiceReceiveService> = {}) {
  const app = Fastify();
  app.decorateRequest("user", null);
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: "u1" };
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ code: "validation-failed" });
    throw err;
  });
  app.register(einvoiceRoutes, {
    settings: settings as EinvoiceSettingsService,
    service: {} as EinvoiceService,
    status: {} as EinvoiceStatusService,
    receive: receive as EinvoiceReceiveService,
  });
  return app;
}

describe("reception routes — envelope", () => {
  it("POST /einvoice-settings/reception answers with the reception view, validates the body and maps the refusals", async () => {
    const inputs: unknown[] = [];
    let fail: Error | null = null;
    const app = routesApp({
      setReception: async (input) => {
        inputs.push(input);
        if (fail) throw fail;
        return RECEPTION_VIEW;
      },
    });
    const ok = await app.inject({ method: "POST", url: "/einvoice-settings/reception", payload: { enabled: true, migrationCode: "ABC-1" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(RECEPTION_VIEW);
    expect(inputs).toEqual([{ enabled: true, migrationCode: "ABC-1" }]);
    expect((await app.inject({ method: "POST", url: "/einvoice-settings/reception", payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/einvoice-settings/reception", payload: { enabled: true, extra: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/einvoice-settings/reception", payload: { enabled: true, migrationCode: "nej\u0007" } })).statusCode).toBe(400);

    fail = new EInvoiceProviderError("Organisationsnumret tas redan emot av en annan accesspunkt — ange migreringskoden från den leverantören", "conflict", [], "req-9");
    const elsewhere = await app.inject({ method: "POST", url: "/einvoice-settings/reception", payload: { enabled: true } });
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json()).toMatchObject({ code: "einvoice-reception-registered-elsewhere", message: expect.stringContaining("migreringskoden"), requestId: "req-9" });
    fail = new EinvoiceNotConfiguredError("no-account");
    const notConfigured = await app.inject({ method: "POST", url: "/einvoice-settings/reception", payload: { enabled: true } });
    expect(notConfigured.statusCode).toBe(409);
    expect(notConfigured.json()).toMatchObject({ code: "einvoice-not-configured", reason: "no-account" });
    fail = new EInvoiceProviderError("B2Brouter svarar inte, försök igen", "unavailable");
    expect((await app.inject({ method: "POST", url: "/einvoice-settings/reception", payload: { enabled: false } })).statusCode).toBe(502);
    fail = new EInvoiceProviderError("B2Brouter godkände inte API-nyckeln — kontrollera den under System → E-faktura", "unauthorized");
    const unauthorized = await app.inject({ method: "POST", url: "/einvoice-settings/reception", payload: { enabled: false } });
    expect(unauthorized.statusCode).toBe(409);
    expect(unauthorized.json()).toMatchObject({ code: "einvoice-provider-unauthorized" });
  });

  it("POST /einvoice-settings/receive-now answers with the counts, 409 while busy; GET reception-log answers { rows }", async () => {
    let busy = false;
    const limits: number[] = [];
    const app = routesApp(
      {},
      {
        receiveNow: async () => {
          if (busy) throw new EinvoiceReceiveBusyError();
          return { imported: 2, duplicates: 1, unreadable: 0 };
        },
        receptionLog: async (limit) => {
          limits.push(limit);
          return [
            {
              id: ID,
              environment: "sandbox",
              receivedAt: "2026-11-05T09:00:00.000Z",
              documentType: "invoice",
              documentNumber: "FA-1001",
              issueDate: "2026-10-21",
              senderEndpoint: "0007:5566778899",
              senderName: SELLER.name,
              currency: "SEK",
              payableAmount: 16901.9,
              outcome: "imported",
              detail: null,
              invoiceScanId: ID,
              scanNumber: "FI-1",
            },
          ];
        },
      }
    );
    const now = await app.inject({ method: "POST", url: "/einvoice-settings/receive-now" });
    expect(now.statusCode).toBe(200);
    expect(now.json()).toEqual({ imported: 2, duplicates: 1, unreadable: 0 });
    busy = true;
    const refused = await app.inject({ method: "POST", url: "/einvoice-settings/receive-now" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "einvoice-receive-busy" });

    const log = await app.inject({ url: "/einvoice-settings/reception-log?limit=5" });
    expect(log.statusCode).toBe(200);
    expect(log.json()).toEqual({ rows: [expect.objectContaining({ scanNumber: "FI-1", outcome: "imported", payableAmount: 16901.9 })] });
    expect((await app.inject({ url: "/einvoice-settings/reception-log" })).statusCode).toBe(200);
    expect(limits).toEqual([5, 50]);
    expect((await app.inject({ url: "/einvoice-settings/reception-log?limit=0" })).statusCode).toBe(400);
  });

  it("POST /einvoice-settings/reception-log/:id/dismiss answers with the row, 409 unless unreadable, 404 unknown, 502 on transport failure", async () => {
    let fail: Error | null = null;
    const app = routesApp(
      {},
      {
        dismiss: async (id) => {
          if (fail) throw fail;
          return { id, outcome: "dismissed", detail: "Markerad som hanterad" } as never;
        },
      }
    );
    const ok = await app.inject({ method: "POST", url: `/einvoice-settings/reception-log/${ID}/dismiss` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: ID, outcome: "dismissed" });
    expect((await app.inject({ method: "POST", url: "/einvoice-settings/reception-log/nope/dismiss" })).statusCode).toBe(400);
    fail = new InvalidStatusTransitionError("Cannot dismiss");
    const refused = await app.inject({ method: "POST", url: `/einvoice-settings/reception-log/${ID}/dismiss` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "invalid-status-transition" });
    fail = new EinvoiceReceptionNotFoundError(ID);
    expect((await app.inject({ method: "POST", url: `/einvoice-settings/reception-log/${ID}/dismiss` })).statusCode).toBe(404);
    fail = new EInvoiceProviderError("B2Brouter svarar inte, försök igen", "unavailable");
    expect((await app.inject({ method: "POST", url: `/einvoice-settings/reception-log/${ID}/dismiss` })).statusCode).toBe(502);
  });
});

// --- Rules through the real app ---

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE einvoice_receptions, invoice_scans, supplier_invoice_files, supplier_invoice_rows, supplier_invoices, suppliers, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'EIRC%'`;
const DELETE_SETTINGS = sql`DELETE FROM system_settings WHERE key LIKE 'einvoice\\_%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(DELETE_SETTINGS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
  await db.execute(DELETE_SETTINGS);
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

async function userWith(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `EIRC${crypto.randomUUID().slice(0, 5)}`, name: "Test", permissions })
    .returning();
  const email = `eirc-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "T", role: "user", permissionGroupId: group!.id, readOnly } as never);
  return login(email);
}

// An e-invoice post as the reception writes it: the PDF on the scan, the
// original on the reception row.
async function einvoiceScan() {
  const xml = Buffer.from(
    buildUblDocument(invoiceTwoRatesDiscount()).replace(
      "</cac:AdditionalDocumentReference>",
      '</cac:AdditionalDocumentReference><cac:AdditionalDocumentReference><cbc:ID>bilaga</cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/html" filename="sida.html">PGh0bWw+PC9odG1sPg==</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>'
    ),
    "utf8"
  );
  const [scan] = await db
    .insert(invoiceScans)
    .values({
      scanNumber: `FI-R${crypto.randomUUID().slice(0, 6)}`,
      source: "einvoice",
      status: "new",
      filename: "Faktura-FA-1001.pdf",
      contentType: "application/pdf",
      sizeBytes: FAKE_PDF.length,
      sha256: createHash("sha256").update(FAKE_PDF).digest("hex"),
      data: FAKE_PDF,
    })
    .returning({ id: invoiceScans.id });
  await db.insert(einvoiceReceptions).values({
    environment: "sandbox",
    providerInvoiceId: `p-${crypto.randomUUID().slice(0, 8)}`,
    documentType: "invoice",
    documentNumber: "FA-1001",
    issueDate: "2026-10-21",
    senderEndpoint: "0007:5566778899",
    senderName: SELLER.name,
    currency: "SEK",
    payableAmount: "16901.90",
    originalXml: xml,
    originalSha256: createHash("sha256").update(xml).digest("hex"),
    originalContentType: "application/xml",
    attachments: [
      { index: 0, filename: "Faktura-FA-1001.pdf", contentType: "application/pdf", sizeBytes: FAKE_PDF.length },
      { index: 1, filename: "sida.html", contentType: "application/octet-stream", sizeBytes: 13 },
    ],
    outcome: "imported",
    invoiceScanId: scan!.id,
  });
  return { id: scan!.id, xml };
}

describe("reception routes — rules", () => {
  it("the settings routes are admin only and answer not-configured without a key", async () => {
    const admin = await adminCookie();
    const buyer = await userWith(["inkop"]);
    for (const [method, url] of [
      ["POST", "/api/v1/einvoice-settings/reception"],
      ["POST", "/api/v1/einvoice-settings/receive-now"],
      ["GET", "/api/v1/einvoice-settings/reception-log"],
      ["POST", `/api/v1/einvoice-settings/reception-log/${ID}/dismiss`],
    ] as const) {
      const res = await app.inject({ method, url, headers: { cookie: buyer }, payload: method === "POST" ? { enabled: true } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const reception = await app.inject({ method: "POST", url: "/api/v1/einvoice-settings/reception", headers: { cookie: admin }, payload: { enabled: true } });
    expect(reception.statusCode).toBe(409);
    expect(reception.json()).toMatchObject({ code: "einvoice-not-configured", reason: "no-key" });
    const now = await app.inject({ method: "POST", url: "/api/v1/einvoice-settings/receive-now", headers: { cookie: admin } });
    expect(now.statusCode).toBe(409);
    expect(now.json()).toMatchObject({ code: "einvoice-not-configured" });
    const log = await app.inject({ url: "/api/v1/einvoice-settings/reception-log", headers: { cookie: admin } });
    expect(log.statusCode).toBe(200);
    expect(log.json()).toEqual({ rows: [] });
    const dismiss = await app.inject({ method: "POST", url: `/api/v1/einvoice-settings/reception-log/${ID}/dismiss`, headers: { cookie: admin } });
    expect(dismiss.statusCode).toBe(404);
    expect(dismiss.json()).toMatchObject({ code: "einvoice-reception-not-found" });
    const view = await app.inject({ url: "/api/v1/einvoice-settings", headers: { cookie: admin } });
    expect(view.json().reception).toEqual({
      enabled: false,
      smlStatus: null,
      directoryStatus: null,
      migrationPending: null,
      documentTypes: [],
      participantId: null,
      intervalMinutes: 15,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
    });
    const patched = await app.inject({ method: "PATCH", url: "/api/v1/einvoice-settings", headers: { cookie: admin }, payload: { receiveIntervalMinutes: 30 } });
    expect(patched.json().reception.intervalMinutes).toBe(30);
  });

  it("serves the original XML and the attachments to the office (read-only too), never to the workshop profile", async () => {
    const { id, xml } = await einvoiceScan();
    const reader = await userWith(["inkop"], true);
    const original = await app.inject({ url: `/api/v1/invoice-scans/${id}/einvoice-original`, headers: { cookie: reader } });
    expect(original.statusCode).toBe(200);
    expect(original.headers["content-type"]).toMatch(/^application\/xml/);
    expect(original.headers["x-content-type-options"]).toBe("nosniff");
    expect(original.headers["content-disposition"]).toContain("e-faktura-FA-1001.xml");
    expect(original.rawPayload.equals(xml)).toBe(true);

    const attachment = await app.inject({ url: `/api/v1/invoice-scans/${id}/einvoice-attachments/0`, headers: { cookie: reader } });
    expect(attachment.statusCode).toBe(200);
    expect(attachment.headers["content-type"]).toMatch(/^application\/pdf/);
    expect(attachment.headers["content-disposition"]).toContain("Faktura-FA-1001.pdf");
    expect(attachment.rawPayload.equals(FAKE_PDF)).toBe(true);
    // A sender-chosen text/html is served as octet-stream, never as a page.
    const hostile = await app.inject({ url: `/api/v1/invoice-scans/${id}/einvoice-attachments/1`, headers: { cookie: reader } });
    expect(hostile.statusCode).toBe(200);
    expect(hostile.headers["content-type"]).toMatch(/^application\/octet-stream/);
    expect(hostile.headers["content-disposition"]).toContain("attachment");
    expect((await app.inject({ url: `/api/v1/invoice-scans/${id}/einvoice-attachments/2`, headers: { cookie: reader } })).statusCode).toBe(404);
    const bad = await app.inject({ url: `/api/v1/invoice-scans/${id}/einvoice-attachments/abc`, headers: { cookie: reader } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "validation-failed" });

    const detail = await app.inject({ url: `/api/v1/invoice-scans/${id}`, headers: { cookie: reader } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      source: "einvoice",
      einvoice: {
        environment: "sandbox",
        senderEndpoint: "0007:5566778899",
        senderName: SELLER.name,
        attachments: [
          { index: 0, filename: "Faktura-FA-1001.pdf", contentType: "application/pdf", sizeBytes: FAKE_PDF.length },
          { index: 1, filename: "sida.html", contentType: "application/octet-stream", sizeBytes: 13 },
        ],
      },
    });
    expect(typeof detail.json().einvoice.receivedAt).toBe("string");
    const list = await app.inject({ url: "/api/v1/invoice-scans?source=einvoice", headers: { cookie: reader } });
    expect(list.json().total).toBe(1);

    const workshop = await userWith(["terminal"]);
    expect((await app.inject({ url: `/api/v1/invoice-scans/${id}/einvoice-original`, headers: { cookie: workshop } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/invoice-scans/${id}/einvoice-attachments/0`, headers: { cookie: workshop } })).statusCode).toBe(403);
    // Tolka med AI on an e-invoice post is refused.
    const buyer = await userWith(["inkop"]);
    const ai = await app.inject({ method: "POST", url: `/api/v1/invoice-scans/${id}/interpret`, headers: { cookie: buyer }, payload: { engine: "ai" } });
    expect(ai.statusCode).toBe(409);
    expect(ai.json()).toMatchObject({ code: "invoice-scan-einvoice-no-ai" });
  });

  it("an uploaded scan has no original (404); the created supplier invoice carries einvoiceScanId", async () => {
    const buyer = await userWith(["inkop"]);
    const [supplier] = await db
      .insert(suppliers)
      .values({ supplierNumber: "L-E1", name: SELLER.name, orgNumber: "556677-8899", currency: "SEK" })
      .returning();
    const { id } = await einvoiceScan();
    const converted = await app.inject({
      method: "POST",
      url: `/api/v1/invoice-scans/${id}/convert`,
      headers: { cookie: buyer },
      payload: { supplierId: supplier!.id, invoiceNumber: "FA-1001", invoiceDate: "2026-10-21", dueDate: "2026-11-20", netAmount: 13625, vatAmount: 3276.9, grossAmount: 16901.9, paymentReference: { kind: "ocr", value: FAKE_OCR }, rows: [] },
    });
    expect(converted.statusCode).toBe(201);
    expect(converted.json().einvoiceScanId).toBe(id);
    const card = await app.inject({ url: `/api/v1/supplier-invoices/${converted.json().id}`, headers: { cookie: buyer } });
    expect(card.json().einvoiceScanId).toBe(id);
    // The original is still served after the conversion.
    expect((await app.inject({ url: `/api/v1/invoice-scans/${id}/einvoice-original`, headers: { cookie: buyer } })).statusCode).toBe(200);

    const [uploaded] = await db
      .insert(invoiceScans)
      .values({ scanNumber: "FI-U1", source: "upload", status: "new", filename: "x.pdf", contentType: "application/pdf", sizeBytes: 3, sha256: "a".repeat(64), data: Buffer.from("%PD") })
      .returning({ id: invoiceScans.id });
    const none = await app.inject({ url: `/api/v1/invoice-scans/${uploaded!.id}/einvoice-original`, headers: { cookie: buyer } });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ code: "invoice-scan-einvoice-original-not-found" });
    expect((await app.inject({ url: `/api/v1/invoice-scans/${uploaded!.id}`, headers: { cookie: buyer } })).json().einvoice).toBeNull();
  });

  it("the public web hook takes received_invoice.created with the same signature", async () => {
    const SECRET = "whsec_receive_route";
    const settingRows: [string, string][] = [
      ["einvoice_webhook_id", "1"],
      ["einvoice_webhook_secret", SECRET],
      ["einvoice_webhook_environment", "sandbox"],
    ];
    for (const [key, value] of settingRows) {
      await db.insert(systemSettings).values({ key, value }).onConflictDoUpdate({ target: systemSettings.key, set: { value } });
    }
    const body = JSON.stringify({ code: "received_invoice.created", triggered_at: 1, data: { account_id: 1, invoice_id: 4242, state: "new" } });
    const sign = (raw: string, secret = SECRET) => `t=1,s=${createHmac("sha256", secret).update("1.").update(raw).digest("hex")}`;
    const post = (signature: string) =>
      app.inject({ method: "POST", url: "/api/v1/einvoice/webhook", headers: { "content-type": "application/json", "x-b2brouter-signature": signature }, payload: body });
    expect((await post(sign(body))).statusCode).toBe(204);
    expect((await post(sign(body, "other"))).statusCode).toBe(401);
    const [stamp] = await db.select().from(systemSettings).where(eq(systemSettings.key, "einvoice_webhook_last_received_at"));
    expect(stamp).toBeDefined();
  });
});
