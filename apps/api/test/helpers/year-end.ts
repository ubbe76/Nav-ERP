import { asc, count, eq, sql } from "drizzle-orm";
import Fastify from "fastify";
import { ZodError } from "zod";
import { accounts, db, verificationRows, verifications, verificationSeries } from "@navet/db";
import { createAuthRepository } from "../../src/modules/auth/repository/auth.repository.js";
import { yearEndRoutes } from "../../src/modules/economy/routes/year-end.routes.js";
import { BAS_STANDARD_ACCOUNTS } from "../../src/modules/economy/service/bas-accounts.js";
import { createVerificationPoster } from "../../src/modules/economy/service/verification-poster.js";
import {
  createYearEndClosingService,
  type YearEndClosingService,
  type YearEndClosingServiceDeps,
} from "../../src/modules/economy/service/year-end-closing.service.js";
import { payablesTotalAsOf } from "../../src/modules/purchase/repository/open-amounts.js";
import { receivablesTotalAsOf } from "../../src/modules/sales/repository/open-amounts.js";
import { rejectMalformedIds } from "../../src/modules/system/middleware/reject-malformed-ids.js";
import { testFixedAssetService } from "./fixed-assets.js";
import { DEFAULT_POSTING_SETTINGS, testEconomyRepository, testEconomyService } from "./services.js";

// Fixed, long-past years: every date in them is before "today" forever, so
// no year-end test depends on the calendar (month boundaries, Stockholm vs
// UTC midnight). The current year never takes part.
export const PREVIOUS_YEAR = 2023;
export const YEAR = 2024;
export const NEXT_YEAR = 2025;

// number_series is never truncated (seed rows). CASCADE reaches every table
// that references these (posting_rules, order tables, …).
export const YEAR_END_TRUNCATE = sql`TRUNCATE profit_dispositions, year_end_accruals, year_end_closing_verifications, year_end_closings, fixed_asset_depreciations, fixed_asset_depreciation_runs, fixed_assets, fixed_asset_categories, vat_settlements, invoice_reminders, customer_payment_rows, customer_payments, invoice_rows, invoices, customers, supplier_payment_rows, supplier_payments, supplier_invoices, suppliers, verification_files, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

export async function resetYearEnd() {
  await db.execute(YEAR_END_TRUNCATE);
}

export async function accountId(number: string): Promise<string> {
  const account = await testEconomyRepository.findAccountByNumber(number);
  if (!account) throw new Error(`BAS account ${number} not seeded`);
  return account.id;
}

export async function createUser() {
  return createAuthRepository(db).create({
    email: `year-end-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Bokslutsansvarig",
    role: "admin",
  });
}

export async function createCalendarYear(year: number) {
  return testEconomyService.createFiscalYear({ label: String(year), startDate: `${year}-01-01`, endDate: `${year}-12-31` });
}

export async function setupUserAndAccounts() {
  const user = await createUser();
  await testEconomyRepository.seedAccounts([...BAS_STANDARD_ACCOUNTS]);
  return { user };
}

export async function setupYearEnd() {
  const { user } = await setupUserAndAccounts();
  const year = await createCalendarYear(YEAR);
  return { user, yearId: year.id };
}

// drizzle wraps the driver error; the violated constraint is on `cause`.
export async function expectConstraint(promise: PromiseLike<unknown>, constraint: string) {
  const error = await Promise.resolve(promise).then(
    () => null,
    (caught: unknown) => caught as { cause?: { constraint_name?: string } }
  );
  if (!error) throw new Error(`expected ${constraint} to be violated`);
  if (error.cause?.constraint_name !== constraint) throw new Error(`expected ${constraint}, got ${error.cause?.constraint_name}`);
}

export async function failure(promise: PromiseLike<unknown>): Promise<unknown> {
  return Promise.resolve(promise).then(
    () => null,
    (caught: unknown) => caught
  );
}

export const testYearEndPoster = createVerificationPoster({ read: async () => DEFAULT_POSTING_SETTINGS });

// The year-end service as the suites build it; later tasks add deps here.
export function buildYearEndService(overrides: Partial<YearEndClosingServiceDeps> = {}) {
  return createYearEndClosingService({
    db,
    poster: testYearEndPoster,
    settings: { read: async () => DEFAULT_POSTING_SETTINGS },
    receivables: { totalAsOf: receivablesTotalAsOf },
    payables: { totalAsOf: payablesTotalAsOf },
    fixedAssets: testFixedAssetService,
    fiscalYears: testEconomyService,
    // Steg 2's default: nothing in stock. Suites that test the step pass a fake.
    inventory: { getValuation: async () => ({ totalValue: 0, unvaluedCount: 0, groups: [] }) },
    ...overrides,
  });
}

// Mini-app over yearEndRoutes, as the route suites build it. Lives here (not
// in a test file) so later suites import it from a helper. The id guard runs
// before the routes' own requirePermission, as in the real app's protected
// scope; `profile` swaps the default admin for e.g. a profile without Ekonomi.
export function buildYearEndApp(
  userId: string,
  opts: { service?: YearEndClosingService; profile?: { role: string; permissions?: string[] } } = {}
) {
  const service = opts.service ?? buildYearEndService();
  const profile = opts.profile ?? { role: "admin" };
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Validation failed", code: "validation-failed", issues: err.issues });
    }
    throw err;
  });
  app.addHook("preHandler", async (req) => {
    req.user = { id: userId, email: "test@example.com", name: "Testanvändare", ...profile } as never;
  });
  app.addHook("preHandler", rejectMalformedIds());
  app.register(yearEndRoutes, { service });
  return app;
}

// A manual verification in series A, booked — for revenue, costs and
// opening balances the year-end steps then work on.
export async function bookManual(
  date: string,
  rows: { account: string; debit?: number; credit?: number }[],
  userId: string
) {
  const existing = (await testEconomyService.listSeries()).find((series) => series.code === "A");
  const series = existing ?? (await testEconomyService.createSeries({ code: "A", name: "Manuella" }));
  const resolved = [];
  for (const row of rows) {
    resolved.push({ accountId: await accountId(row.account), debit: row.debit ?? 0, credit: row.credit ?? 0 });
  }
  const draft = await testEconomyService.createVerification({ seriesId: series.id, date, description: "Testverifikat", rows: resolved }, userId);
  return testEconomyService.book(draft.id, userId);
}

export async function verificationLines(verificationId: string) {
  const rows = await db
    .select({ account: accounts.number, debit: verificationRows.debit, credit: verificationRows.credit })
    .from(verificationRows)
    .innerJoin(accounts, eq(accounts.id, verificationRows.accountId))
    .where(eq(verificationRows.verificationId, verificationId))
    .orderBy(asc(accounts.number));
  return rows.map((row) => ({ account: row.account, debit: Number(row.debit), credit: Number(row.credit) }));
}

export async function countVerifications(seriesCode: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(verifications)
    .innerJoin(verificationSeries, eq(verificationSeries.id, verifications.seriesId))
    .where(eq(verificationSeries.code, seriesCode));
  return Number(row?.n ?? 0);
}

// Revenue and cost booked in YEAR, then steps 2–4 done with nothing to book
// (no stock, no fixed assets, no accruals) — a year ready for steg 5.
export async function prepareClosableYear(
  service: ReturnType<typeof buildYearEndService>,
  userId: string,
  input: { revenue: number; cost: number; closingDate?: string }
) {
  const year = await createCalendarYear(YEAR);
  if (input.revenue > 0) {
    await bookManual(`${YEAR}-06-30`, [{ account: "1930", debit: input.revenue }, { account: "3001", credit: input.revenue }], userId);
  }
  if (input.cost > 0) {
    await bookManual(`${YEAR}-07-31`, [{ account: "4010", debit: input.cost }, { account: "1930", credit: input.cost }], userId);
  }
  const closing = await service.startClosing({ fiscalYearId: year.id, closingDate: input.closingDate }, userId);
  await service.bookInventory(closing.id, { method: "standard" }, userId);
  await service.bookDepreciation(closing.id, userId);
  await service.bookAccruals(closing.id, { rows: [] }, userId);
  return { closingId: closing.id, yearId: year.id };
}

// Resolves once a backend in this database waits on a lock — the
// deterministic "the other transaction is now blocked" signal for race
// tests (instead of a sleep that may be too short on a loaded machine).
export async function waitForLockWaiter(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    const [row] = [...result] as { n: number }[];
    if ((row?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No transaction started waiting on a lock");
}
