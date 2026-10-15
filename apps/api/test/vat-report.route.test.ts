import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createVatReportService } from "../src/modules/economy/service/vat-report.service.js";
import { createFinancialReportsService } from "../src/modules/economy/service/financial-reports.service.js";
import { economyRoutes } from "../src/modules/economy/routes/economy.routes.js";
import type { SieService } from "../src/modules/economy/service/sie.service.js";

// Package 5 (uppföljningssvepet): route-level coverage for B5's vat-report
// error mappings (economy.routes.ts's vatReportError), previously only
// exercised at the service layer (economy-vat-report.test.ts). App-boot
// pattern and seeding copied from that file and from economy-reports-csv.
// test.ts; sie is stubbed since it's never exercised here.

const repo = testEconomyRepository;
const service = testEconomyService;
const authRepo = createAuthRepository(db);

const DEFAULT_POSTING_SETTINGS = {
  postingAccountsReceivable: "1510",
  postingVatOut25: "2610",
  postingVatOut12: "2620",
  postingVatOut6: "2630",
  postingRevenue25: "3001",
  postingRevenue12: "3002",
  postingRevenue6: "3003",
  postingRevenue0: "3004",
  postingAccountsPayable: "2440",
  postingVatIn: "2640",
  postingDefaultCost: "4010",
  postingBank: "1930",
  postingReminderFeeAccount: "3540",
  postingPaymentWriteOff: "3740",
  postingVatSettlement: "2650",
};
const settingsReader = { read: async () => DEFAULT_POSTING_SETTINGS };
const poster = createVerificationPoster(settingsReader);
const vatReportService = createVatReportService({ db, poster, settings: settingsReader });
const reports = createFinancialReportsService({ db, repo });

const TRUNCATE = sql`TRUNCATE vat_settlements, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = new Date().getFullYear();
const MAR = { from: `${YEAR}-03-01`, to: `${YEAR}-03-31` };

async function setupEconomy() {
  const user = await authRepo.create({
    email: `vat-report-route-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomiadmin",
    role: "admin",
  });
  await service.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  await service.createSeries({ code: "A", name: "Manuella verifikat" });
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  return { user };
}

async function accountId(number: string) {
  const account = await repo.findAccountByNumber(number);
  return account!.id;
}

// A domestic sale booked and immediately booked (not draft) so it produces
// real VAT movement for the report/settle calls below — same helper shape as
// economy-vat-report.test.ts's bookSale, collapsed to what this file needs.
async function bookSale(userId: string, date: string, net: number, vat: number) {
  const series = await repo.findSeriesByCode("A");
  const draft = await service.createVerification(
    {
      seriesId: series!.id,
      date,
      description: "Momstestpost",
      rows: [
        { accountId: await accountId("1510"), debit: net + vat, credit: 0 },
        { accountId: await accountId("3001"), debit: 0, credit: net },
        { accountId: await accountId("2610"), debit: 0, credit: vat },
      ],
    },
    userId
  );
  return service.book(draft.id, userId);
}

function buildApp(userId: string) {
  const app = Fastify();
  // Bare-app equivalent of app.ts's global ZodError branch — needed here
  // (unlike the other route-test siblings) because vatReportQuerySchema's
  // own refine (to must not be before from) throws OUTSIDE the route's
  // try/catch, so it never reaches vatReportError.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: userId, email: "test@example.com", name: "Testanvändare", role: "admin" } as any;
  });
  app.register(economyRoutes, {
    service,
    vatReport: vatReportService,
    reports,
    sie: {} as unknown as SieService,
  });
  return app;
}

describe("GET /vat-report", () => {
  it("400s validation-failed for a malformed range (to before from)", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const res = await app.inject({ url: `/vat-report?from=${MAR.to}&to=${MAR.from}` });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("validation-failed");
    await app.close();
  });

  it("400s vat-period-not-covered for a range that doesn't tile whole accounting periods", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const res = await app.inject({ url: `/vat-report?from=${YEAR}-03-15&to=${MAR.to}` });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("vat-period-not-covered");
    await app.close();
  });
});

describe("POST /vat-report/settle", () => {
  it("double-settling the same range is a 409 vat-period-already-settled", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, MAR.from, 1000, 250);

    const app = buildApp(user.id);
    const first = await app.inject({ method: "POST", url: "/vat-report/settle", payload: MAR });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: "POST", url: "/vat-report/settle", payload: MAR });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("vat-period-already-settled");
    await app.close();
  });

  it("400s vat-period-not-covered on settle for the same malformed-coverage range as the report", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const res = await app.inject({
      method: "POST",
      url: "/vat-report/settle",
      payload: { from: `${YEAR}-03-15`, to: MAR.to },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("vat-period-not-covered");
    await app.close();
  });
});
