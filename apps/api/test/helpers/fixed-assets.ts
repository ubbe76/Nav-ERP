import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../../src/modules/auth/repository/auth.repository.js";
import { createFixedAssetService } from "../../src/modules/economy/service/fixed-asset.service.js";
import { createVerificationPoster } from "../../src/modules/economy/service/verification-poster.js";
import {
  DEFAULT_POSTING_SETTINGS,
  setupPostingBaseline,
  testDocumentPdfService,
  testEconomyRepository,
  testEconomyService,
} from "./services.js";

// Shared fixtures for the anläggningsregister suites. number_series is NOT
// truncated (the migration's seed row would vanish and getNextOrderNumber
// would throw); the AN- counter is reset instead.
export const FIXED_ASSET_TRUNCATE = sql`TRUNCATE fixed_asset_depreciations, fixed_asset_depreciation_runs, fixed_assets, fixed_asset_categories, vat_settlements, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;
export const RESET_ASSET_SERIES = sql`UPDATE number_series SET next_number = 1 WHERE key = 'fixed_asset'`;

export const testPoster = createVerificationPoster({ read: async () => DEFAULT_POSTING_SETTINGS });
export const testFixedAssetService = createFixedAssetService({
  db,
  poster: testPoster,
  audit: { log: async () => {} },
  pdf: testDocumentPdfService,
});

// Last calendar year: every month lies in the past, so a run "t.o.m." any of
// its months never trips the future-month guard, a disposal date in it is
// never "after today", and its periods are all open.
export const PLAN_YEAR = new Date().getFullYear() - 1;

export async function resetFixedAssets() {
  await db.execute(FIXED_ASSET_TRUNCATE);
  await db.execute(RESET_ASSET_SERIES);
}

export async function accountId(number: string): Promise<string> {
  const account = await testEconomyRepository.findAccountByNumber(number);
  if (!account) throw new Error(`BAS account ${number} not seeded`);
  return account.id;
}

export async function setupFixedAssets() {
  const user = await createAuthRepository(db).create({
    email: `fixed-asset-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomiadmin",
    role: "admin",
  });
  // Current year + BAS accounts (idempotent), then last year for the runs.
  await setupPostingBaseline();
  const planYear = await testEconomyService.createFiscalYear({
    label: String(PLAN_YEAR),
    startDate: `${PLAN_YEAR}-01-01`,
    endDate: `${PLAN_YEAR}-12-31`,
  });
  const category = await testFixedAssetService.createCategory({
    name: "Inventarier",
    assetAccountId: await accountId("1220"),
    accumulatedDepreciationAccountId: await accountId("1229"),
    depreciationExpenseAccountId: await accountId("7830"),
    disposalGainAccountId: await accountId("3973"),
    disposalLossAccountId: await accountId("7970"),
    defaultUsefulLifeMonths: 60,
  });
  return { user, category, planYearId: planYear.id };
}
