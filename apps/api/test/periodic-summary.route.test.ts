import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { inArray, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { customers, db, invoiceRows, invoices, systemSettings } from "@navet/db";
import { effectivePermissions } from "@navet/shared";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createVatReportService } from "../src/modules/economy/service/vat-report.service.js";
import { createFinancialReportsService } from "../src/modules/economy/service/financial-reports.service.js";
import { createPeriodicSummaryService } from "../src/modules/economy/service/periodic-summary.service.js";
import { economyRoutes } from "../src/modules/economy/routes/economy.routes.js";
import type { SieService } from "../src/modules/economy/service/sie.service.js";
import type { VatCodeService } from "../src/modules/economy/service/vat-code.service.js";
import {
  VAT_CONTACT_EMAIL_KEY,
  VAT_CONTACT_NAME_KEY,
  VAT_CONTACT_PHONE_KEY,
  VAT_REPORTING_PERIOD_KEY,
  writeVatReportingSettings,
} from "../src/modules/system/service/vat-reporting-settings.js";
import { DEFAULT_POSTING_SETTINGS } from "./helpers/services.js";
import { vatCodeId } from "./helpers/vat-codes.js";

// GET /periodic-summary and /periodic-summary/file on a bare app: the
// contract, the file's headers and the error mapping (400 period/amount,
// 409 empty/reporter with body.missing). The invoices are inserted as rows —
// the issue flow itself is periodic-summary.integration.test.ts's.

const settingsReader = { read: async () => ({ ...DEFAULT_POSTING_SETTINGS }) };
const poster = createVerificationPoster(settingsReader);
const vatReport = createVatReportService({ db, poster, settings: settingsReader });
const reports = createFinancialReportsService({ db, repo: testEconomyRepository });
let companyVatNumber: string | null = "SE556000016701";
const periodicSummary = createPeriodicSummaryService({ db, company: { vatNumber: async () => companyVatNumber } });

const SETTING_KEYS = [VAT_REPORTING_PERIOD_KEY, VAT_CONTACT_NAME_KEY, VAT_CONTACT_PHONE_KEY, VAT_CONTACT_EMAIL_KEY];
const TRUNCATE = sql`TRUNCATE invoice_documents, invoice_rows, invoices, customers, verification_rows, verifications, audit_log CASCADE`;
const MAY = { from: "2030-05-01", to: "2030-05-31" };

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  companyVatNumber = "SE556000016701";
  currentUser = ADMIN;
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
});

const ADMIN = { id: "00000000-0000-0000-0000-000000000001", email: "a@example.com", name: "Admin", role: "admin", permissions: effectivePermissions("admin", []) };
const INKOP = { id: "00000000-0000-0000-0000-000000000002", email: "i@example.com", name: "Inköp", role: "user", permissions: effectivePermissions("user", ["inkop"]) };
let currentUser: typeof ADMIN = ADMIN;

function buildApp() {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = currentUser as never;
  });
  app.register(economyRoutes, {
    service: testEconomyService,
    vatReport,
    reports,
    sie: {} as unknown as SieService,
    vatCodes: {} as unknown as VatCodeService,
    periodicSummary,
  });
  return app;
}

let customerSeq = 0;
async function customer(name: string, country: string) {
  customerSeq += 1;
  const [row] = await db
    .insert(customers)
    .values({ customerNumber: `PS-${customerSeq}`, name, country })
    .returning({ id: customers.id });
  return row!.id;
}

// An issued invoice (or credit note) with one EU row.
async function issued(opts: {
  customerId: string;
  number: string;
  vatNumber: string | null;
  code: "EUV" | "EUT";
  amount: string;
  date?: string;
  type?: "invoice" | "credit";
  // unit_price is numeric(14,4) — a huge line amount needs a quantity.
  quantity?: string;
  unitPrice?: string;
}) {
  const [invoice] = await db
    .insert(invoices)
    .values({
      invoiceNumber: opts.number,
      type: opts.type ?? "invoice",
      customerId: opts.customerId,
      status: "issued",
      invoiceDate: opts.date ?? "2030-05-15",
      vatNumber: opts.vatNumber,
      issuedAt: new Date(),
    })
    .returning({ id: invoices.id });
  await db.insert(invoiceRows).values({
    invoiceId: invoice!.id,
    description: "Rad",
    quantity: opts.quantity ?? "1",
    unitPrice: opts.unitPrice ?? opts.amount,
    vatCodeId: await vatCodeId(opts.code),
    vatRate: "0",
    lineAmount: opts.amount,
    vatAmount: "0",
  });
  return invoice!.id;
}

async function setContact() {
  await writeVatReportingSettings(db, { contactName: "Per Persson", contactPhone: "0123-45690", contactEmail: "post@example.com" });
}

describe("GET /periodic-summary", () => {
  it("answers with the contract", async () => {
    await setContact();
    const kunde = await customer("Kunde GmbH", "DE");
    const id = await issued({ customerId: kunde, number: "FA9001", vatNumber: "DE123456789", code: "EUV", amount: "1500.50" });
    const app = buildApp();
    const res = await app.inject({ url: `/periodic-summary?from=${MAY.from}&to=${MAY.to}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      from: MAY.from,
      to: MAY.to,
      kind: "month",
      periodCode: "3005",
      rows: [
        {
          vatNumber: "DE123456789",
          customers: [{ id: kunde, name: "Kunde GmbH" }],
          goods: 1501,
          triangular: null,
          services: 0,
          invoices: [{ id, invoiceNumber: "FA9001" }],
        },
      ],
      totals: { goods: 1501, services: 0 },
      ledger: { box35: 0, box39: 0 },
      differences: { goods: 1501, services: 0 },
      warnings: [
        {
          kind: "ledger_difference",
          message:
            "Varor: sammanställningen 1 501 kr, bokfört i ruta 35 0 kr (skillnad 1 501 kr) — typiskt ett manuellt verifikat eller en faktura med fel momskod",
          invoices: [],
        },
      ],
      reporter: { vatNumber: "SE556000016701", contactName: "Per Persson", contactPhone: "0123-45690", contactEmail: "post@example.com" },
      missing: [],
    });
    await app.close();
  });

  it("400s periodic-summary-period-invalid for anything but a calendar month or quarter", async () => {
    const app = buildApp();
    for (const [from, to] of [
      ["2030-05-02", "2030-05-31"],
      ["2030-01-01", "2030-12-31"],
      ["2030-02-01", "2030-04-30"],
      ["2030-05-31", "2030-05-01"],
    ]) {
      const res = await app.inject({ url: `/periodic-summary?from=${from}&to=${to}` });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("periodic-summary-period-invalid");
    }
    const quarter = await app.inject({ url: "/periodic-summary?from=2030-04-01&to=2030-06-30" });
    expect(quarter.statusCode).toBe(200);
    expect(quarter.json()).toMatchObject({ kind: "quarter", periodCode: "30-2" });
    await app.close();
  });

  it("400s validation-failed without a range", async () => {
    const app = buildApp();
    const res = await app.inject({ url: "/periodic-summary?from=2030-05-01" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation-failed");
    await app.close();
  });

  it("needs the Ekonomi permission", async () => {
    currentUser = INKOP;
    const app = buildApp();
    expect((await app.inject({ url: `/periodic-summary?from=${MAY.from}&to=${MAY.to}` })).statusCode).toBe(403);
    expect((await app.inject({ url: `/periodic-summary/file?from=${MAY.from}&to=${MAY.to}` })).statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /periodic-summary/file", () => {
  it("serves the file as ISO-8859-1 text with CRLF and a letters-and-digits name", async () => {
    await writeVatReportingSettings(db, { contactName: "Åsa Öberg", contactPhone: "08 123 456" });
    const kunde = await customer("Kunde GmbH", "DE");
    await issued({ customerId: kunde, number: "FA9001", vatNumber: "DE123456789", code: "EUV", amount: "1000.00" });
    await issued({ customerId: kunde, number: "FA9002", vatNumber: "DE123456789", code: "EUV", amount: "1000.00", type: "credit" });
    const kunta = await customer("Oy Ab", "FI");
    await issued({ customerId: kunta, number: "FA9003", vatNumber: "FI01409351", code: "EUT", amount: "300.00" });

    const app = buildApp();
    const res = await app.inject({ url: "/periodic-summary/file?from=2030-04-01&to=2030-06-30" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; charset=ISO-8859-1");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="PeriodiskSammanstallning30K2\.txt"/);
    expect(res.rawPayload.toString("latin1")).toBe(
      ["SKV574008;", "556000016701;30-2;Åsa Öberg;08123456;", "DE123456789;0;;;", "FI01409351;;;300;", ""].join("\r\n")
    );
    // Å is one latin1 byte, not UTF-8's two.
    expect(res.rawPayload.includes(Buffer.from([0xc5]))).toBe(true);
    await app.close();
  });

  it("409s periodic-summary-empty without EU sales", async () => {
    await setContact();
    const app = buildApp();
    const res = await app.inject({ url: `/periodic-summary/file?from=${MAY.from}&to=${MAY.to}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("periodic-summary-empty");
    await app.close();
  });

  it("409s periodic-summary-reporter-incomplete with the missing fields", async () => {
    companyVatNumber = null;
    const kunde = await customer("Kunde GmbH", "DE");
    await issued({ customerId: kunde, number: "FA9001", vatNumber: "DE123456789", code: "EUV", amount: "100.00" });
    const app = buildApp();
    const res = await app.inject({ url: `/periodic-summary/file?from=${MAY.from}&to=${MAY.to}` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: "periodic-summary-reporter-incomplete",
      missing: ["vatNumber", "contactName", "contactPhone"],
    });
    await app.close();
  });

  it("400s periodic-summary-amount-too-large for an amount over 12 characters", async () => {
    await setContact();
    const kunde = await customer("Kunde GmbH", "DE");
    // 999 999 999 999,99 rounds to 1 000 000 000 000 — 13 characters.
    await issued({ customerId: kunde, number: "FA9001", vatNumber: "DE123456789", code: "EUV", amount: "999999999999.99", quantity: "1000", unitPrice: "999999999.9999" });
    const app = buildApp();
    const res = await app.inject({ url: `/periodic-summary/file?from=${MAY.from}&to=${MAY.to}` });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("periodic-summary-amount-too-large");
    await app.close();
  });

  it("400s periodic-summary-period-invalid", async () => {
    await setContact();
    const app = buildApp();
    const res = await app.inject({ url: "/periodic-summary/file?from=2030-05-01&to=2030-06-30" });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("periodic-summary-period-invalid");
    await app.close();
  });
});
