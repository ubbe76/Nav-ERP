import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { createFinancialReportsService } from "../src/modules/economy/service/financial-reports.service.js";
import { economyRoutes } from "../src/modules/economy/routes/economy.routes.js";
import type { VatReportService } from "../src/modules/economy/service/vat-report.service.js";
import type { SieService } from "../src/modules/economy/service/sie.service.js";

// F2: CSV siblings of the B6a report routes (balance-sheet/csv,
// income-statement/csv, general-ledger/csv, verification-list/csv) plus the
// previously-missing GET /verification-list JSON route. Route-level tests
// (not just the pure builders in financial-reports-csv.test.ts) so the admin
// guard and the actual HTTP response (content-type, BOM, filename) are
// covered too. Seeding approach copied from test/economy-reports.test.ts.

const repo = testEconomyRepository;
const service = testEconomyService;
const authRepo = createAuthRepository(db);
const reports = createFinancialReportsService({ db, repo });

const TRUNCATE = sql`TRUNCATE vat_settlements, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = 2026;

async function setupEconomy() {
  const user = await authRepo.create({
    email: `reports-csv-${crypto.randomUUID()}@example.com`,
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

// Books a balanced manual verification from (accountNumber, net) pairs where
// positive = debit, negative = credit — same helper as economy-reports.test.ts.
async function bookManual(userId: string, date: string, entries: [string, number][], description = "Testpost") {
  const series = await repo.findSeriesByCode("A");
  const rows = await Promise.all(
    entries.map(async ([number, net]) => ({
      accountId: await accountId(number),
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    }))
  );
  const draft = await service.createVerification({ seriesId: series!.id, date, description, rows }, userId);
  return service.book(draft.id, userId);
}

// vatReport/sie are never exercised by the routes under test here — cast
// empty stubs so economyRoutes' single combined registration still type-checks.
function buildApp(role: "admin" | "user" = "admin") {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = { id: "test-user", email: "test@example.com", name: "Testanvändare", role } as any;
  });
  app.register(economyRoutes, {
    service,
    vatReport: {} as unknown as VatReportService,
    reports,
    sie: {} as unknown as SieService,
  });
  return app;
}

describe("GET /balance-sheet/csv", () => {
  it("returns text/csv with a BOM, a dated filename, and the Summa tillgångar row", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-06-10`, [
      ["1930", 1000],
      ["3001", -1000],
    ]);

    const app = buildApp();
    const res = await app.inject({ url: `/balance-sheet/csv?asOf=${YEAR}-12-31` });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="balansrakning-2026-12-31\.csv"/);
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body).toContain("Summa tillgångar");
    expect(res.body).toContain("1930");
    await app.close();
  });

  it("403s for a non-admin user", async () => {
    await setupEconomy();
    const app = buildApp("user");
    const res = await app.inject({ url: `/balance-sheet/csv?asOf=${YEAR}-12-31` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /verification-list", () => {
  it("was missing a JSON route — now returns the booked verifications", async () => {
    const { user } = await setupEconomy();
    await bookManual(
      user.id,
      `${YEAR}-06-10`,
      [
        ["1930", 1000],
        ["3001", -1000],
      ],
      "Kontantförsäljning"
    );

    const app = buildApp();
    const res = await app.inject({ url: "/verification-list" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.verifications).toHaveLength(1);
    expect(body.verifications[0].description).toBe("Kontantförsäljning");
    await app.close();
  });
});

describe("GET /verification-list/csv", () => {
  it("returns text/csv with a BOM and the verification's rows", async () => {
    const { user } = await setupEconomy();
    await bookManual(
      user.id,
      `${YEAR}-06-10`,
      [
        ["1930", 1000],
        ["3001", -1000],
      ],
      "Kontantförsäljning"
    );

    const app = buildApp();
    const res = await app.inject({ url: "/verification-list/csv" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    expect(res.body).toContain("Kontantförsäljning");
    await app.close();
  });
});
