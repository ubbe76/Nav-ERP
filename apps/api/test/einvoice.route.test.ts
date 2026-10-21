import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { ZodError } from "zod";
import { sql } from "drizzle-orm";
import { db, permissionGroups } from "@navet/db";
import { buildApp } from "../src/app.js";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createAuthService } from "../src/modules/auth/service/auth.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import { einvoiceRoutes } from "../src/modules/einvoice/routes/einvoice.routes.js";
import { EInvoiceProviderError } from "../src/modules/einvoice/service/einvoice-provider.js";
import type { EinvoiceSettingsService } from "../src/modules/einvoice/service/einvoice-settings.service.js";
import type { EinvoiceStatusService } from "../src/modules/einvoice/service/einvoice-status.service.js";
import type { EinvoiceService } from "../src/modules/einvoice/service/einvoice.service.js";
import {
  EinvoiceAlreadySentError,
  EinvoiceDocumentInvalidError,
  EinvoiceNotAllowedError,
  EinvoiceNotConfiguredError,
  EinvoiceTransmissionNotFoundError,
} from "../src/modules/einvoice/service/einvoice.errors.js";
import { InvoiceNotFoundError } from "../src/modules/sales/service/invoice.service.js";

const ID = "11111111-1111-4111-8111-111111111111";

// --- Envelope: the routes with stubbed services ---

function routesApp(service: Partial<EinvoiceService>, status: Partial<EinvoiceStatusService> = {}, settings: Partial<EinvoiceSettingsService> = {}) {
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
    service: service as EinvoiceService,
    status: status as EinvoiceStatusService,
  });
  return app;
}

const TRANSMISSION = {
  id: ID,
  status: "sent" as const,
  statusLabel: "Skickad",
  environment: "sandbox" as const,
  recipientId: "0007:5565555553",
  providerInvoiceId: "1",
  providerState: "sent",
  errorMessage: null,
  startedAt: new Date("2030-01-01T10:00:00Z"),
  sentAt: new Date("2030-01-01T10:00:01Z"),
  statusUpdatedAt: null,
  lastPolledAt: null,
  createdByName: "Biller",
};

describe("einvoice routes — envelope", () => {
  it("201s a send with the transmission, ISO dates", async () => {
    const app = routesApp({ send: async () => TRANSMISSION });
    const res = await app.inject({ method: "POST", url: `/invoices/${ID}/einvoice`, payload: {} });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: ID, status: "sent", statusLabel: "Skickad", startedAt: "2030-01-01T10:00:00.000Z" });
  });

  it("maps the domain errors to their codes and extras", async () => {
    let next: Error = new EinvoiceNotConfiguredError("no-key");
    const app = routesApp({
      send: async () => {
        throw next;
      },
    });
    const post = () => app.inject({ method: "POST", url: `/invoices/${ID}/einvoice` });

    let res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "einvoice-not-configured", reason: "no-key" });

    next = new EinvoiceNotAllowedError("private-person");
    res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "einvoice-not-allowed", reason: "private-person", error: expect.stringContaining("Privatpersoner") });

    next = new EinvoiceAlreadySentError("FA-1");
    res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "einvoice-already-sent" });

    next = new EinvoiceDocumentInvalidError(["Fakturan saknar förfallodatum"]);
    res = await post();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "einvoice-document-invalid", problems: ["Fakturan saknar förfallodatum"] });

    next = new EInvoiceProviderError("B2Brouter avvisade dokumentet", "validation", ["BR-CO-10"], "req-1");
    res = await post();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "einvoice-provider-rejected", fieldErrors: ["BR-CO-10"], requestId: "req-1" });

    next = new EInvoiceProviderError("nekad", "unauthorized");
    res = await post();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "einvoice-provider-unauthorized" });

    next = new EInvoiceProviderError("nere", "unavailable");
    res = await post();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: "einvoice-provider-unavailable" });

    next = new EInvoiceProviderError("konstigt", "unexpected");
    expect((await post()).statusCode).toBe(502);

    next = new InvoiceNotFoundError(ID);
    expect((await post()).statusCode).toBe(404);
  });

  it("404s an unknown transmission on refresh and document, 400s a malformed id", async () => {
    const app = routesApp(
      {
        getDocument: async () => null,
      },
      {
        pollTransmission: async (id) => {
          throw new EinvoiceTransmissionNotFoundError(id);
        },
      }
    );
    const refresh = await app.inject({ method: "POST", url: `/einvoice-transmissions/${ID}/refresh` });
    expect(refresh.statusCode).toBe(404);
    expect(refresh.json()).toMatchObject({ code: "einvoice-transmission-not-found" });
    expect((await app.inject({ url: `/einvoice-transmissions/${ID}/document` })).statusCode).toBe(404);
    expect((await app.inject({ url: "/einvoice-transmissions/nope/document" })).statusCode).toBe(400);
  });

  it("serves the document as XML with the invoice number as file name", async () => {
    const app = routesApp({ getDocument: async () => ({ filename: "FA-1001.xml", content: Buffer.from("<Invoice/>") }) });
    const res = await app.inject({ url: `/einvoice-transmissions/${ID}/document` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/xml");
    expect(res.headers["content-disposition"]).toContain('attachment; filename="FA-1001.xml"');
    expect(res.body).toBe("<Invoice/>");
  });

  it("refresh answers with the polled row", async () => {
    const app = routesApp({ getTransmission: async () => TRANSMISSION }, { pollTransmission: async () => TRANSMISSION as never });
    const res = await app.inject({ method: "POST", url: `/einvoice-transmissions/${ID}/refresh` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ID, status: "sent" });
  });

  it("validates the settings and lookup bodies", async () => {
    const app = routesApp({ lookup: async (_id, input) => ({ input }) as never }, {}, { update: async () => ({}) as never });
    expect((await app.inject({ method: "PATCH", url: "/einvoice-settings", payload: { statusIntervalMinutes: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/einvoice-settings", payload: { nope: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/customers/${ID}/peppol-lookup`, payload: { peppolId: "abc" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: `/customers/${ID}/peppol-lookup` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ input: {} });
    const typed = await app.inject({ method: "POST", url: `/customers/${ID}/peppol-lookup`, payload: { peppolId: " 0007:5565555553 " } });
    expect(typed.json()).toEqual({ input: { peppolId: "0007:5565555553" } });
  });
});

// --- Rules through the real app: workshop profile, non-admin settings, read-only ---

const authService = createAuthService(createAuthRepository(db), "unused", createAuditRepository(db));
const PASSWORD = "correcthorsebattery";
const TRUNCATE = sql`TRUNCATE einvoice_transmissions, invoices, customers, audit_log, user_settings, users CASCADE`;
const DELETE_GROUPS = sql`DELETE FROM permission_groups WHERE code LIKE 'EINV%'`;

let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});
beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});
afterAll(async () => {
  await app.close();
  await db.execute(TRUNCATE);
  await db.execute(DELETE_GROUPS);
});

async function login(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return `session=${res.cookies.find((c) => c.name === "session")!.value}`;
}

async function userWith(permissions: string[], readOnly = false) {
  const [group] = await db
    .insert(permissionGroups)
    .values({ code: `EINV${crypto.randomUUID().slice(0, 5)}`, name: "Test", permissions })
    .returning();
  const email = `einv-${crypto.randomUUID()}@example.com`;
  await authService.createUser({ email, password: PASSWORD, name: "T", role: "user", permissionGroupId: group!.id, readOnly } as never);
  return login(email);
}

describe("einvoice routes — rules", () => {
  it("settings are admin only; the verkstad profile gets 403 on the card's read; read-only gets 403 on send", async () => {
    const adminEmail = `admin-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email: adminEmail, password: PASSWORD, name: "Admin", role: "admin" });
    const admin = await login(adminEmail);
    const seller = await userWith(["forsaljning"]);
    const workshop = await userWith(["terminal"]);
    const readOnly = await userWith(["forsaljning"], true);

    // Settings: admin yes, a Försäljning user no.
    expect((await app.inject({ url: "/api/v1/einvoice-settings", headers: { cookie: admin } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/einvoice-settings", headers: { cookie: seller } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/api/v1/einvoice-settings", headers: { cookie: seller }, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/einvoice-settings/test", headers: { cookie: seller }, payload: {} })).statusCode).toBe(403);

    // The card's read: office yes (404 for the unknown invoice), workshop no.
    expect((await app.inject({ url: `/api/v1/invoices/${ID}/einvoice`, headers: { cookie: seller } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/v1/invoices/${ID}/einvoice`, headers: { cookie: workshop } })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/v1/einvoice-transmissions/${ID}/document`, headers: { cookie: workshop } })).statusCode).toBe(403);

    // Writes: Försäljning reaches the service (not configured ⇒ 409), the
    // workshop and a read-only account are refused before it.
    const sent = await app.inject({ method: "POST", url: `/api/v1/invoices/${ID}/einvoice`, headers: { cookie: seller }, payload: {} });
    expect(sent.statusCode).toBe(409);
    expect(sent.json()).toMatchObject({ code: "einvoice-not-configured", reason: "disabled" });
    expect((await app.inject({ method: "POST", url: `/api/v1/invoices/${ID}/einvoice`, headers: { cookie: workshop }, payload: {} })).statusCode).toBe(403);
    const ro = await app.inject({ method: "POST", url: `/api/v1/invoices/${ID}/einvoice`, headers: { cookie: readOnly }, payload: {} });
    expect(ro.statusCode).toBe(403);
    expect(ro.json()).toMatchObject({ code: "read-only-account" });
    expect((await app.inject({ method: "POST", url: `/api/v1/customers/${ID}/peppol-lookup`, headers: { cookie: readOnly }, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/v1/einvoice-transmissions/${ID}/refresh`, headers: { cookie: workshop } })).statusCode).toBe(403);
    // A Försäljning user may look up, and gets 409 without a key.
    const lookup = await app.inject({ method: "POST", url: `/api/v1/customers/${ID}/peppol-lookup`, headers: { cookie: seller }, payload: {} });
    expect([404, 409]).toContain(lookup.statusCode);
  });

  it("customers carry invoiceDelivery and peppolId through POST, PATCH and GET", async () => {
    const adminEmail = `admin-${crypto.randomUUID()}@example.com`;
    await authService.createUser({ email: adminEmail, password: PASSWORD, name: "Admin", role: "admin" });
    const admin = await login(adminEmail);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/customers",
      headers: { cookie: admin },
      payload: { name: "Kund AB", invoiceDelivery: "peppol", peppolId: "0088:7350000000000" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ invoiceDelivery: "peppol", peppolId: "0088:7350000000000" });
    const id = created.json().id as string;
    const cleared = await app.inject({ method: "PATCH", url: `/api/v1/customers/${id}`, headers: { cookie: admin }, payload: { peppolId: "" } });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ invoiceDelivery: "peppol", peppolId: null });
    const bad = await app.inject({ method: "PATCH", url: `/api/v1/customers/${id}`, headers: { cookie: admin }, payload: { peppolId: "no-scheme" } });
    expect(bad.statusCode).toBe(400);
    const got = await app.inject({ url: `/api/v1/customers/${id}`, headers: { cookie: admin } });
    expect(got.json()).toMatchObject({ invoiceDelivery: "peppol", peppolId: null });
    const plain = await app.inject({ method: "POST", url: "/api/v1/customers", headers: { cookie: admin }, payload: { name: "Annan AB" } });
    expect(plain.json()).toMatchObject({ invoiceDelivery: "email", peppolId: null });
  });
});
