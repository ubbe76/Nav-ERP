import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { economyRoutes } from "../src/modules/economy/routes/economy.routes.js";
import type { VatReportService } from "../src/modules/economy/service/vat-report.service.js";
import type { FinancialReportsService } from "../src/modules/economy/service/financial-reports.service.js";
import type { SieService } from "../src/modules/economy/service/sie.service.js";

// Package 5 (uppföljningssvepet): route-level coverage for B2's poster→409
// mappings, exercised through POST /verifications/:id/reverse — previously
// only the service layer (economy-verifications.test.ts) was tested, not the
// route's own verificationError mapper (economy.routes.ts). App-boot pattern
// copied from economy-reports-csv.test.ts: a bare Fastify app registering the
// real economyRoutes plugin, with vatReport/sie stubbed out since neither is
// exercised here.

const repo = testEconomyRepository;
const service = testEconomyService;
const authRepo = createAuthRepository(db);

const TRUNCATE = sql`TRUNCATE verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = new Date().getFullYear();

async function setupEconomy() {
  const user = await authRepo.create({
    email: `poster-conflict-${crypto.randomUUID()}@example.com`,
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

// A balanced two-row draft, ready to book — same shape as
// economy-verifications.test.ts's fixtures.
async function createDraft(userId: string, date = `${YEAR}-03-05`) {
  const series = await repo.findSeriesByCode("A");
  return service.createVerification(
    {
      seriesId: series!.id,
      date,
      description: "Testpost",
      rows: [
        { accountId: await accountId("1930"), debit: 100, credit: 0 },
        { accountId: await accountId("3001"), debit: 0, credit: 100 },
      ],
    },
    userId
  );
}

function buildApp(userId: string) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    // A REAL seeded user id — reverse writes createdBy into a uuid column.
    req.user = { id: userId, email: "test@example.com", name: "Testanvändare", role: "admin" } as any;
  });
  app.register(economyRoutes, {
    service,
    vatReport: {} as unknown as VatReportService,
    reports: {} as unknown as FinancialReportsService,
    sie: {} as unknown as SieService,
  });
  return app;
}

describe("POST /verifications/:id/reverse", () => {
  it("reversing the same booked verification twice: first 201, second 409 already-reversed", async () => {
    const { user } = await setupEconomy();
    const draft = await createDraft(user.id);
    await service.book(draft.id, user.id);

    const app = buildApp(user.id);
    const first = await app.inject({ method: "POST", url: `/verifications/${draft.id}/reverse` });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({ method: "POST", url: `/verifications/${draft.id}/reverse` });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("already-reversed");
    await app.close();
  });

  it("reversing a draft (never booked) is a 409 invalid-verification-state", async () => {
    const { user } = await setupEconomy();
    const draft = await createDraft(user.id);

    const app = buildApp(user.id);
    const res = await app.inject({ method: "POST", url: `/verifications/${draft.id}/reverse` });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("invalid-verification-state");
    await app.close();
  });

  it("reversing an unknown verification id is a 404 verification-not-found", async () => {
    const { user } = await setupEconomy();
    const app = buildApp(user.id);
    const res = await app.inject({
      method: "POST",
      url: "/verifications/00000000-0000-0000-0000-000000000000/reverse",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("verification-not-found");
    await app.close();
  });
});
