import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { accountingPeriods, db, fiscalYears, verificationSeries, verifications } from "@navet/db";
import { economyRoutes } from "../src/modules/economy/routes/economy.routes.js";
import { AccountingPeriodLockedError, FiscalYearClosedError } from "../src/modules/economy/service/accounting-period-lock.js";
import type { FinancialReportsService } from "../src/modules/economy/service/financial-reports.service.js";
import type { SieService } from "../src/modules/economy/service/sie.service.js";
import type { VatReportService } from "../src/modules/economy/service/vat-report.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { isBookkeepingLockViolation, isClosedFiscalYearViolation } from "../src/modules/system/service/db-errors.js";
import { bookFailureError } from "../src/modules/economy/service/economy.service.js";
import { DEFAULT_POSTING_SETTINGS, testEconomyRepository, testEconomyService } from "./helpers/services.js";
import { NEXT_YEAR, YEAR, accountId, createCalendarYear, failure, resetYearEnd, setupYearEnd } from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const poster = createVerificationPoster({ read: async () => DEFAULT_POSTING_SETTINGS });

async function closeBySql(fiscalYearId: string) {
  await db.update(accountingPeriods).set({ status: "locked", lockedAt: new Date() }).where(eq(accountingPeriods.fiscalYearId, fiscalYearId));
  await db.update(fiscalYears).set({ status: "closed", closedAt: new Date() }).where(eq(fiscalYears.id, fiscalYearId));
}

async function seriesA() {
  const [row] = await db.insert(verificationSeries).values({ code: "A", name: "Manuella" }).returning();
  return row!.id;
}

function buildEconomyApp(userId: string) {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    req.user = { id: userId, email: "t@example.com", name: "T", role: "admin" } as never;
  });
  app.register(economyRoutes, {
    service: testEconomyService,
    vatReport: {} as unknown as VatReportService,
    reports: {} as unknown as FinancialReportsService,
    sie: {} as unknown as SieService,
  });
  return app;
}

// A balanced manual draft dated in YEAR, created while the year is still open.
async function manualDraftInYear(userId: string) {
  return testEconomyService.createVerification(
    {
      seriesId: await seriesA(),
      date: `${YEAR}-06-30`,
      description: "Manuellt",
      rows: [
        { accountId: await accountId("1930"), debit: 100, credit: 0 },
        { accountId: await accountId("2091"), debit: 0, credit: 100 },
      ],
    },
    userId
  );
}

describe("closed fiscal year — application guards", () => {
  it("names the year, not the date, in the poster's FiscalYearClosedError", async () => {
    const { user, yearId } = await setupYearEnd();
    await closeBySql(yearId);
    const balances = [
      { accountId: await accountId("1930"), amount: 100 },
      { accountId: await accountId("2091"), amount: -100 },
    ];
    const err = await failure(db.transaction((tx) => poster.postOpeningBalances(tx, { date: `${YEAR}-06-30`, balances }, user.id)));
    expect(err).toBeInstanceOf(FiscalYearClosedError);
    expect((err as Error).message).toBe(`The fiscal year (${YEAR}) is closed — reopen it under Bokslut`);
  });

  it("tells the closed-year triggers' NV001 apart from the bookkeeping lock's", async () => {
    const { yearId } = await setupYearEnd();
    await closeBySql(yearId);
    // The period guard (migration 0106): locked → open in a closed year.
    const err = await failure(db.update(accountingPeriods).set({ status: "open" }).where(eq(accountingPeriods.fiscalYearId, yearId)));
    expect(isBookkeepingLockViolation(err)).toBe(true);
    expect(isClosedFiscalYearViolation(err)).toBe(true);
    // The 0095 triggers' messages are about booked records.
    expect(isClosedFiscalYearViolation({ code: "NV001", message: "Bokfört verifikat kan inte ändras — rätta med en omföring (id x)" })).toBe(false);
  });

  it("the poster refuses with FiscalYearClosedError, which is also an AccountingPeriodLockedError", async () => {
    const { user, yearId } = await setupYearEnd();
    await closeBySql(yearId);
    const bank = await accountId("1930");
    const equity = await accountId("2091");
    const err = await failure(
      db.transaction((tx) =>
        poster.postOpeningBalances(
          tx,
          {
            date: `${YEAR}-06-30`,
            balances: [
              { accountId: bank, amount: 100 },
              { accountId: equity, amount: -100 },
            ],
          },
          user.id
        )
      )
    );
    expect(err).toBeInstanceOf(FiscalYearClosedError);
    expect(err).toBeInstanceOf(AccountingPeriodLockedError);
  });

  it("unlockPeriod refuses a period of a closed year but still unlocks in an open year", async () => {
    const { user, yearId } = await setupYearEnd();
    const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, yearId)).limit(1);
    await testEconomyService.lockPeriod(period!.id, user.id);
    await testEconomyService.unlockPeriod(period!.id, "Rättelse av hyra", user.id);
    await closeBySql(yearId);
    await expect(testEconomyService.unlockPeriod(period!.id, "Rättelse av hyra", user.id)).rejects.toBeInstanceOf(FiscalYearClosedError);
  });

  it("refuses creating a draft in a closed year and moving a draft into one", async () => {
    const { user, yearId } = await setupYearEnd();
    await createCalendarYear(NEXT_YEAR);
    const series = await seriesA();
    const draft = await testEconomyService.createVerification(
      { seriesId: series, date: `${NEXT_YEAR}-02-01`, description: "Utkast", rows: [] },
      user.id
    );
    await closeBySql(yearId);
    await expect(
      testEconomyService.createVerification({ seriesId: series, date: `${YEAR}-06-30`, description: "Sent", rows: [] }, user.id)
    ).rejects.toBeInstanceOf(FiscalYearClosedError);
    await expect(testEconomyService.updateVerificationHeader(draft.id, { date: `${YEAR}-12-31` })).rejects.toBeInstanceOf(
      FiscalYearClosedError
    );
  });

  // Spec §12: a manual draft that predates the closing can never be booked
  // into the closed year — the year's periods are locked, so book() refuses
  // with the period lock, and the draft stays a draft.
  it("refuses booking a manual draft into a closed year", async () => {
    const { user, yearId } = await setupYearEnd();
    const draft = await manualDraftInYear(user.id);
    await closeBySql(yearId);
    await expect(testEconomyService.book(draft.id, user.id)).rejects.toBeInstanceOf(AccountingPeriodLockedError);
    const [row] = await db.select({ status: verifications.status }).from(verifications).where(eq(verifications.id, draft.id));
    expect(row!.status).toBe("draft");
  });

  // Omför raises its mirror draft dated TODAY through repo.createVerification,
  // which has no year check of its own — reverse() must refuse a today that
  // lies in a closed year. The clock is pinned inside the fixed YEAR (only
  // Date is faked; the driver's timers stay real).
  it("refuses Omför when today's fiscal year is closed and writes no draft", async () => {
    const { user, yearId } = await setupYearEnd();
    const draft = await manualDraftInYear(user.id);
    await testEconomyService.book(draft.id, user.id);
    await closeBySql(yearId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${YEAR}-06-15T10:00:00Z`));
    try {
      await expect(testEconomyService.reverse(draft.id, user.id)).rejects.toBeInstanceOf(FiscalYearClosedError);
    } finally {
      vi.useRealTimers();
    }
    expect((await testEconomyService.findVerificationById(draft.id)).reversedBy).toBeNull();
  });

  it("POST /verifications/:id/book answers 409 fiscal-year-closed for a draft in a closed year", async () => {
    const { user, yearId } = await setupYearEnd();
    const draft = await manualDraftInYear(user.id);
    await closeBySql(yearId);
    const app = buildEconomyApp(user.id);
    const res = await app.inject({ method: "POST", url: `/verifications/${draft.id}/book` });
    expect(res.statusCode).toBe(409);
    // The year before the period: every period of a closed year is locked,
    // but the answer the user needs is "reopen the year".
    expect(res.json().code).toBe("fiscal-year-closed");
    await app.close();
  });

  it("the in-tx re-check reports a closed year as FiscalYearClosedError (before the locked period)", async () => {
    const { user, yearId } = await setupYearEnd();
    const draft = await manualDraftInYear(user.id);
    await closeBySql(yearId);
    const failure = await testEconomyRepository.bookVerification(draft.id, user.id);
    expect(failure).toEqual({ ok: false, reason: "closed_year", label: String(YEAR) });
    const err = bookFailureError(draft.id, failure as Extract<typeof failure, { ok: false }>);
    expect(err).toBeInstanceOf(FiscalYearClosedError);
    expect(err).toBeInstanceOf(AccountingPeriodLockedError);
  });

  it("POST /verifications answers 409 fiscal-year-closed for a draft dated in a closed year", async () => {
    const { user, yearId } = await setupYearEnd();
    const series = await seriesA();
    await closeBySql(yearId);
    const app = buildEconomyApp(user.id);
    const res = await app.inject({
      method: "POST",
      url: "/verifications",
      payload: { seriesId: series, date: `${YEAR}-06-30`, description: "Sent", rows: [] },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("fiscal-year-closed");
    await app.close();
  });

  it("POST /accounting-periods/:id/unlock answers 409 fiscal-year-closed", async () => {
    const { user, yearId } = await setupYearEnd();
    const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, yearId)).limit(1);
    await closeBySql(yearId);
    const app = buildEconomyApp(user.id);
    const res = await app.inject({ method: "POST", url: `/accounting-periods/${period!.id}/unlock`, payload: { reason: "Rättelse av hyra" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("fiscal-year-closed");
    await app.close();
  });
});
