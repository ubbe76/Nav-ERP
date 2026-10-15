import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidAgmDateError,
  NothingToDisposeError,
  ProfitDispositionActiveError,
  ProfitDispositionExistsError,
  YearEndClosingNotClosedError,
} from "../src/modules/economy/service/year-end-closing.service.js";
import { accountingPeriods, db, yearEndClosingVerifications } from "@navet/db";
import { and, eq, gte, lte } from "drizzle-orm";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { YearEndClosingVerificationError } from "../src/modules/economy/service/economy.service.js";
import { testEconomyService } from "./helpers/services.js";
import {
  NEXT_YEAR,
  YEAR,
  buildYearEndService,
  countVerifications,
  createCalendarYear,
  prepareClosableYear,
  resetYearEnd,
  setupUserAndAccounts,
  verificationLines,
} from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const service = buildYearEndService();
const AGM = `${NEXT_YEAR}-05-20`;

async function closedYear(userId: string, revenue: number, cost: number) {
  const { closingId } = await prepareClosableYear(service, userId, { revenue, cost });
  await service.bookResultTransfer(closingId, userId);
  await createCalendarYear(NEXT_YEAR);
  await service.closeYear(closingId, userId);
  return closingId;
}

describe("vinstdisposition", () => {
  it("refuses an open closing and an AGM date not after year end", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 1000, cost: 0 });
    await expect(service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 0 }, user.id)).rejects.toBeInstanceOf(
      YearEndClosingNotClosedError
    );
    await service.bookResultTransfer(closingId, user.id);
    await createCalendarYear(NEXT_YEAR);
    await service.closeYear(closingId, user.id);
    await expect(
      service.bookProfitDisposition(closingId, { agmDate: `${YEAR}-12-31`, dividendAmount: 0 }, user.id)
    ).rejects.toBeInstanceOf(InvalidAgmDateError);
  });

  it("moves 2099 to 2898 and 2091 on the AGM date, once", async () => {
    const { user } = await setupUserAndAccounts();
    const closingId = await closedYear(user.id, 100000, 40000);
    const preview = await service.previewProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 20000 });
    expect(preview).toMatchObject({ resultAmount: 60000, dividend: 20000, freeEquity: 60000, warnings: [] });

    const booked = await service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 20000 }, user.id);
    expect(booked.verification).toMatchObject({ displayNumber: `BS-${NEXT_YEAR}-1`, date: AGM });
    expect(await verificationLines(booked.verification.id)).toEqual([
      { account: "2091", debit: 0, credit: 40000 },
      { account: "2099", debit: 60000, credit: 0 },
      { account: "2898", debit: 0, credit: 20000 },
    ]);
    expect((await service.getClosing(closingId)).profitDisposition).toMatchObject({ agmDate: AGM, resultAmount: 60000, dividendAmount: 20000 });
    await expect(service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 0 }, user.id)).rejects.toBeInstanceOf(
      ProfitDispositionExistsError
    );
  });

  it("warns, but books, a dividend above free equity", async () => {
    const { user } = await setupUserAndAccounts();
    const closingId = await closedYear(user.id, 100000, 40000);
    const preview = await service.previewProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 70000 });
    expect(preview.warnings).toHaveLength(1);
    const booked = await service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 70000 }, user.id);
    expect(await verificationLines(booked.verification.id)).toEqual([
      { account: "2091", debit: 10000, credit: 0 },
      { account: "2099", debit: 60000, credit: 0 },
      { account: "2898", debit: 0, credit: 70000 },
    ]);
  });

  it("disposes a loss onto 2091", async () => {
    const { user } = await setupUserAndAccounts();
    const closingId = await closedYear(user.id, 0, 85000);
    const booked = await service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 0 }, user.id);
    expect(await verificationLines(booked.verification.id)).toEqual([
      { account: "2091", debit: 85000, credit: 0 },
      { account: "2099", debit: 0, credit: 85000 },
    ]);
  });

  it("undoes with an omföring on the AGM date and then allows a new disposition and a reopen", async () => {
    const { user } = await setupUserAndAccounts();
    const closingId = await closedYear(user.id, 100000, 40000);
    await service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 20000 }, user.id);
    await expect(service.reopenYear(closingId, "Rättelse behövs", user.id)).rejects.toBeInstanceOf(ProfitDispositionActiveError);

    const undone = await service.undoProfitDisposition(closingId, user.id);
    expect(undone.reversalVerification).toMatchObject({ displayNumber: `BS-${NEXT_YEAR}-2`, date: AGM });
    expect((await service.getClosing(closingId)).profitDisposition).toBeNull();
    expect((await service.reopenYear(closingId, "Rättelse behövs", user.id)).status).toBe("in_progress");
  });

  it("409s NothingToDispose for a zero-result year without a dividend", async () => {
    const { user } = await setupUserAndAccounts();
    const closingId = await closedYear(user.id, 0, 0);
    await expect(service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 0 }, user.id)).rejects.toBeInstanceOf(
      NothingToDisposeError
    );
  });
});

describe("vinstdisposition — ägarlogg och varning", () => {
  it("logs the booking and its reversal in the ownership log, and the generic Omför refuses both", async () => {
    const { user } = await setupUserAndAccounts();
    const closingId = await closedYear(user.id, 100000, 40000);
    const booked = await service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 20000 }, user.id);
    const undone = await service.undoProfitDisposition(closingId, user.id);
    const log = await db
      .select({ verificationId: yearEndClosingVerifications.verificationId, role: yearEndClosingVerifications.role })
      .from(yearEndClosingVerifications)
      .where(eq(yearEndClosingVerifications.step, "profit_disposition"));
    expect(log).toHaveLength(2);
    expect(log).toContainEqual({ verificationId: booked.verification.id, role: "booking" });
    expect(log).toContainEqual({ verificationId: undone.reversalVerification.id, role: "cancellation" });
    await expect(testEconomyService.reverse(booked.verification.id, user.id)).rejects.toBeInstanceOf(YearEndClosingVerificationError);
  });

  it("does not warn for a zero dividend even when free equity is negative", async () => {
    const { user } = await setupUserAndAccounts();
    const closingId = await closedYear(user.id, 0, 85000);
    const preview = await service.previewProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 0 });
    expect(preview).toMatchObject({ resultAmount: -85000, dividend: 0, warnings: [] });
  });

  it("writes no verification, ownership row or disposition when the AGM period is locked", async () => {
    const { user } = await setupUserAndAccounts();
    const closingId = await closedYear(user.id, 100000, 40000);
    await db
      .update(accountingPeriods)
      .set({ status: "locked", lockedAt: new Date() })
      .where(and(lte(accountingPeriods.startDate, AGM), gte(accountingPeriods.endDate, AGM)));
    const before = await countVerifications("BS");
    await expect(service.bookProfitDisposition(closingId, { agmDate: AGM, dividendAmount: 0 }, user.id)).rejects.toBeInstanceOf(
      AccountingPeriodLockedError
    );
    expect(await countVerifications("BS")).toBe(before);
    expect((await service.getClosing(closingId)).profitDisposition).toBeNull();
    const owned = await db.select().from(yearEndClosingVerifications).where(eq(yearEndClosingVerifications.step, "profit_disposition"));
    expect(owned).toHaveLength(0);
  });
});
