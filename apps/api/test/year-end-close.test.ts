import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accountingPeriods, auditLog, db, fiscalYears, profitDispositions, yearEndClosings } from "@navet/db";
import { readAccountBalances } from "../src/modules/economy/service/account-balances.js";
import { FiscalYearClosedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { buildBalanceSheet, buildIncomeStatement } from "../src/modules/economy/service/financial-reports.service.js";
import { isBookkeepingLockViolation } from "../src/modules/system/service/db-errors.js";
import {
  NextFiscalYearClosedError,
  ProfitDispositionActiveError,
  YearEndBlockedError,
  YearEndClosingClosedError,
  YearEndClosingNotClosedError,
  YearEndStepOrderError,
} from "../src/modules/economy/service/year-end-closing.service.js";
import { testFixedAssetService } from "./helpers/fixed-assets.js";
import { testEconomyService } from "./helpers/services.js";
import {
  NEXT_YEAR,
  YEAR,
  accountId,
  bookManual,
  buildYearEndService,
  createCalendarYear,
  countVerifications,
  prepareClosableYear,
  resetYearEnd,
  setupUserAndAccounts,
  testYearEndPoster,
  verificationLines,
  waitForLockWaiter,
} from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const service = buildYearEndService();

async function yearRow(id: string) {
  const [row] = await db.select().from(fiscalYears).where(eq(fiscalYears.id, id));
  return row!;
}

// A gate a test opens by hand: `wait` blocks the code under test until
// `release()`, and `reached` resolves once that code got there.
function pausePoint() {
  let release!: () => void;
  let arrive!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  return {
    release,
    reached,
    wait: async () => {
      arrive();
      await opened;
    },
  };
}

// YEAR closed (result 60 000 transferred) and NEXT_YEAR's closing ready to
// close (nothing booked, steps 2–4 done) — the setup of the reopen/close race.
async function closeYearAndPrepareNext(userId: string) {
  const { closingId, yearId } = await prepareClosableYear(service, userId, { revenue: 100000, cost: 40000 });
  await service.bookResultTransfer(closingId, userId);
  await service.closeYear(closingId, userId);
  const next = await createCalendarYear(NEXT_YEAR);
  const nextClosing = await service.startClosing({ fiscalYearId: next.id }, userId);
  await service.bookInventory(nextClosing.id, { method: "standard" }, userId);
  await service.bookDepreciation(nextClosing.id, userId);
  await service.bookAccruals(nextClosing.id, { rows: [] }, userId);
  return { closingId, yearId, nextClosingId: nextClosing.id, nextYearId: next.id };
}

// The ownership log as the detail serves it, for one step.
async function ownership(closingId: string, step: string) {
  return (await service.getClosing(closingId)).history
    .filter((entry) => entry.step === step)
    .map((entry) => [entry.verification.displayNumber, entry.role]);
}

describe("steg 5 — resultatöverföring", () => {
  it("refuses to run before steps 2–4", async () => {
    const { user } = await setupUserAndAccounts();
    const year = await createCalendarYear(YEAR);
    const closing = await service.startClosing({ fiscalYearId: year.id }, user.id);
    await expect(service.bookResultTransfer(closing.id, user.id)).rejects.toBeInstanceOf(YearEndStepOrderError);
    await service.bookInventory(closing.id, { method: "standard" }, user.id);
    await expect(service.bookResultTransfer(closing.id, user.id)).rejects.toThrow(/Periodiseringar/);
    expect(await countVerifications("BS")).toBe(0);
  });

  it("debits 8999 and credits 2099 with the year's net, zeroing Årets resultat", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    const preview = await service.previewResultTransfer(closingId);
    expect(preview).toMatchObject({ status: "not_done", net: 60000, yearResult: 60000, verification: null });
    expect(preview.rows).toEqual([
      { accountNumber: "8999", accountName: expect.any(String), debit: 60000, credit: 0 },
      { accountNumber: "2099", accountName: expect.any(String), debit: 0, credit: 60000 },
    ]);

    const result = await service.bookResultTransfer(closingId, user.id);
    expect(result.net).toBe(60000);
    expect(result.verification).toMatchObject({ displayNumber: `BS-${YEAR}-1`, date: `${YEAR}-12-31` });
    expect(await verificationLines(result.verification!.id)).toEqual([
      { account: "2099", debit: 0, credit: 60000 },
      { account: "8999", debit: 60000, credit: 0 },
    ]);
    expect(await ownership(closingId, "result_transfer")).toEqual([[`BS-${YEAR}-1`, "booking"]]);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "year_end_closing"), eq(auditLog.action, "result_transferred")));
    expect(entry).toMatchObject({ entityId: String(YEAR), detail: { net: 60000, verification: `BS-${YEAR}-1`, cancelled: null } });

    const year = await yearRow(yearId);
    const balances = await readAccountBalances(db, { from: year.startDate, to: year.endDate });
    const sheet = buildBalanceSheet(balances);
    const equity = sheet.equityAndLiabilities.groups.find((g) => g.key === "equity")!;
    expect(equity.lines.find((l) => l.key === "yearResult")!.total).toBe(0);
    expect(equity.lines.find((l) => l.key === "unrestrictedEquity")!.total).toBe(60000);
    const income = buildIncomeStatement(balances);
    expect(income.entries.find((e) => e.key === "yearResult")!.total).toBe(60000);
    expect(income.result).toBe(0);
    expect((await service.getClosing(closingId)).steps.resultTransfer).toMatchObject({ status: "done", net: 0, yearResult: 60000 });
    // The preview of a done step still shows the transferred result.
    expect((await service.previewResultTransfer(closingId)).rows.map((row) => row.accountNumber)).toEqual(["8999", "2099"]);
  });

  it("is unchanged on a re-run and stale after a late booking, which a re-run fixes", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    expect((await service.bookResultTransfer(closingId, user.id)).unchanged).toBe(true);
    expect(await countVerifications("BS")).toBe(1);

    await bookManual(`${YEAR}-12-31`, [{ account: "1930", debit: 1000 }, { account: "3001", credit: 1000 }], user.id);
    expect((await service.getClosing(closingId)).steps.resultTransfer).toMatchObject({ status: "stale", net: 1000, yearResult: 61000 });
    const rerun = await service.bookResultTransfer(closingId, user.id);
    expect(rerun.cancelled).toMatchObject({ displayNumber: `BS-${YEAR}-2`, date: `${YEAR}-12-31` });
    expect(rerun.verification).toMatchObject({ displayNumber: `BS-${YEAR}-3` });
    expect(rerun.net).toBe(61000);
    expect(await verificationLines(rerun.cancelled!.id)).toEqual([
      { account: "2099", debit: 60000, credit: 0 },
      { account: "8999", debit: 0, credit: 60000 },
    ]);
    expect(await ownership(closingId, "result_transfer")).toEqual([
      [`BS-${YEAR}-1`, "booking"],
      [`BS-${YEAR}-2`, "cancellation"],
      [`BS-${YEAR}-3`, "booking"],
    ]);
    expect((await service.getClosing(closingId)).steps.resultTransfer.status).toBe("done");
  });

  it("credits 8999 and debits 2099 on a loss", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 0, cost: 85000 });
    const preview = await service.previewResultTransfer(closingId);
    expect(preview.yearResult).toBe(-85000);
    expect(preview.rows.map((row) => [row.accountNumber, row.debit, row.credit])).toEqual([
      ["8999", 0, 85000],
      ["2099", 85000, 0],
    ]);
    const result = await service.bookResultTransfer(closingId, user.id);
    expect(await verificationLines(result.verification!.id)).toEqual([
      { account: "2099", debit: 85000, credit: 0 },
      { account: "8999", debit: 0, credit: 85000 },
    ]);
    expect((await service.getClosing(closingId)).steps.resultTransfer).toMatchObject({ status: "done", net: 0, yearResult: -85000 });
  });
});

describe("steg 6 — stäng året", () => {
  it("locks every period, marks both statuses closed and refuses further bookings", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    const closed = await service.closeYear(closingId, user.id);
    expect(closed.status).toBe("closed");
    expect(closed.fiscalYear.status).toBe("closed");
    expect((await yearRow(yearId)).closedBy).toBe(user.id);
    const periods = await db.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, yearId));
    expect(periods.every((p) => p.status === "locked")).toBe(true);
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "year_end_closing"), eq(auditLog.action, "closed")));
    expect(entry!.detail).toMatchObject({ periodsLocked: 12, ibCheck: null, verifications: { resultTransfer: `BS-${YEAR}-1` } });

    await expect(testEconomyService.unlockPeriod(periods[11]!.id, "Rättelse december", user.id)).rejects.toBeInstanceOf(FiscalYearClosedError);
    await expect(
      bookManual(`${YEAR}-12-31`, [{ account: "1930", debit: 1 }, { account: "3001", credit: 1 }], user.id)
    ).rejects.toBeInstanceOf(FiscalYearClosedError);
    await expect(service.closeYear(closingId, user.id)).rejects.toBeInstanceOf(YearEndClosingClosedError);
    await expect(service.bookResultTransfer(closingId, user.id)).rejects.toBeInstanceOf(YearEndClosingClosedError);
  });

  it("keeps the lock stamp of a period locked before the close", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    const [march] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.startDate, `${YEAR}-03-01`));
    await testEconomyService.lockPeriod(march!.id, user.id);
    const [before] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.id, march!.id));
    await service.closeYear(closingId, user.id);
    const [after] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.id, march!.id));
    expect(after!.lockedAt).toEqual(before!.lockedAt);
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "year_end_closing"), eq(auditLog.action, "closed")));
    expect(entry!.detail).toMatchObject({ periodsLocked: 11 });
    expect((await yearRow(yearId)).status).toBe("closed");
  });

  it("refuses to close an untransferred result and rolls the year status back", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await expect(service.closeYear(closingId, user.id)).rejects.toBeInstanceOf(YearEndBlockedError);
    expect((await yearRow(yearId)).status).toBe("open");
    const periods = await db.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, yearId));
    expect(periods.every((p) => p.status === "open")).toBe(true);
    const detail = await service.getClosing(closingId);
    expect(detail.status).toBe("in_progress");
    expect(detail.checks.closeBlockers.map((c) => c.code)).toEqual(["result-not-transferred"]);
  });

  it("names every undone step in the close blockers", async () => {
    const { user } = await setupUserAndAccounts();
    const year = await createCalendarYear(YEAR);
    const closing = await service.startClosing({ fiscalYearId: year.id }, user.id);
    const detail = await service.getClosing(closing.id);
    expect(detail.steps.resultTransfer).toMatchObject({ status: "done", net: 0, verification: null });
    expect(detail.checks.closeBlockers.map((c) => c.code)).toEqual(["inventory-not-done", "accruals-not-done"]);
    await expect(service.closeYear(closing.id, user.id)).rejects.toBeInstanceOf(YearEndBlockedError);
  });

  it("blocks on an opening-balance import in the next year until it is reversed", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    await createCalendarYear(NEXT_YEAR);
    // 1930 and 2099 carry balances (8999/3001/4010 are not balance accounts).
    expect((await service.getClosing(closingId)).ibCheck).toEqual({ nextFiscalYearLabel: String(NEXT_YEAR), accounts: 2, imports: [], differences: [] });
    const imported = await db.transaction(async (tx) =>
      testYearEndPoster.postOpeningBalances(
        tx,
        { date: `${NEXT_YEAR}-01-01`, balances: [{ accountId: await accountId("1930"), amount: 5000 }, { accountId: await accountId("2091"), amount: -5000 }] },
        user.id
      )
    );
    const detail = await service.getClosing(closingId);
    expect(detail.ibCheck).toMatchObject({ nextFiscalYearLabel: String(NEXT_YEAR), imports: [`I-${NEXT_YEAR}-1`] });
    expect(detail.ibCheck!.differences).toEqual([
      { accountNumber: "1930", accountName: expect.any(String), ub: 60000, ib: 65000, difference: 5000 },
      { accountNumber: "2091", accountName: expect.any(String), ub: 0, ib: -5000, difference: -5000 },
    ]);
    expect(detail.checks.closeBlockers.map((c) => c.code)).toEqual(["next-year-opening-balance-import"]);
    await expect(service.closeYear(closingId, user.id)).rejects.toBeInstanceOf(YearEndBlockedError);

    await db.transaction((tx) =>
      testYearEndPoster.reverseBookedVerification(tx, imported.verificationId, { date: `${NEXT_YEAR}-01-01`, description: "Omföring av IB" }, user.id)
    );
    expect((await service.getClosing(closingId)).ibCheck).toMatchObject({ imports: [], differences: [] });
    const closed = await service.closeYear(closingId, user.id);
    expect(closed.status).toBe("closed");
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "year_end_closing"), eq(auditLog.action, "closed")));
    expect(entry!.detail).toMatchObject({ ibCheck: { nextFiscalYear: String(NEXT_YEAR), accounts: 3, differences: 0 } });
  });

  // Spec 4.7: only balance accounts are compared — a series-I row on class
  // 3–8 is no opening balance and must not block.
  it("ignores series-I rows on income statement accounts", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    await createCalendarYear(NEXT_YEAR);
    const series = await testEconomyService.createSeries({ code: "I", name: "Ingående balanser" });
    const draft = await testEconomyService.createVerification(
      {
        seriesId: series.id,
        date: `${NEXT_YEAR}-03-01`,
        description: "Felbokad i serie I",
        rows: [
          { accountId: await accountId("4010"), debit: 500, credit: 0 },
          { accountId: await accountId("3001"), debit: 0, credit: 500 },
        ],
      },
      user.id
    );
    await testEconomyService.book(draft.id, user.id);
    const detail = await service.getClosing(closingId);
    expect(detail.ibCheck).toMatchObject({ imports: [], differences: [] });
    expect(detail.checks.closeBlockers).toEqual([]);
    expect((await service.closeYear(closingId, user.id)).status).toBe("closed");
  });

  // A reversal dated outside the next year leaves its I verification
  // counted there but no longer "an import" — the IB still differs.
  it("blocks on any IB difference even when no unreversed import remains", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    await createCalendarYear(NEXT_YEAR);
    const imported = await db.transaction(async (tx) =>
      testYearEndPoster.postOpeningBalances(
        tx,
        { date: `${NEXT_YEAR}-01-01`, balances: [{ accountId: await accountId("1930"), amount: 5000 }, { accountId: await accountId("2091"), amount: -5000 }] },
        user.id
      )
    );
    await db.transaction((tx) =>
      testYearEndPoster.reverseBookedVerification(tx, imported.verificationId, { date: `${YEAR}-12-31`, description: "Omföring av IB" }, user.id)
    );
    const detail = await service.getClosing(closingId);
    expect(detail.ibCheck!.imports).toEqual([]);
    expect(detail.ibCheck!.differences.map((d) => [d.accountNumber, d.difference])).toEqual([
      ["1930", 5000],
      ["2091", -5000],
    ]);
    expect(detail.checks.closeBlockers.map((c) => c.code)).toEqual(["next-year-opening-balance-import"]);
    await expect(service.closeYear(closingId, user.id)).rejects.toBeInstanceOf(YearEndBlockedError);
  });

  it("waits for a booking in flight and then sees it (FOR SHARE race)", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((resolve) => (inserted = resolve));
    const a1930 = await accountId("1930");
    const a3001 = await accountId("3001");
    const booking = db.transaction(async (tx) => {
      await testYearEndPoster.postClosingEntry(
        tx,
        { date: `${YEAR}-12-31`, description: "Sen faktura", amounts: [{ accountId: a1930, amount: 1000 }, { accountId: a3001, amount: -1000 }], source: "year_end_inventory", document: "Test" },
        user.id
      );
      inserted();
      await gate;
    });
    await insertedSignal;
    let settled = false;
    const closing = service.closeYear(closingId, user.id).finally(() => (settled = true));
    // Attached before release(): the rejection is never unhandled.
    const outcome = expect(closing).rejects.toBeInstanceOf(YearEndBlockedError);
    try {
      await waitForLockWaiter(); // closeYear now waits on the fiscal_years row (the trigger's FOR SHARE)
      expect(settled).toBe(false);
    } finally {
      release(); // never leave the booking's transaction open behind a failed wait
      await booking;
    }
    await outcome;
    expect((await yearRow(yearId)).status).toBe("open");
  });

  // The period trigger reads the year FOR SHARE (migration 0106): an unlock
  // of an already-locked month that races a close waits for it and is then
  // refused — never a closed year with an open month.
  it("makes an unlock of a locked month wait for a close in flight and then refuses it", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    const [march] = await db
      .select()
      .from(accountingPeriods)
      .where(and(eq(accountingPeriods.fiscalYearId, yearId), eq(accountingPeriods.startDate, `${YEAR}-03-01`)));
    await testEconomyService.lockPeriod(march!.id, user.id);

    const pause = pausePoint();
    let armed = true;
    const pausingClose = buildYearEndService({
      fixedAssets: {
        getPlan: (query) => testFixedAssetService.getPlan(query),
        runDepreciation: (tx, input, userId) => testFixedAssetService.runDepreciation(tx, input, userId),
        // closeYear's gate reads this right after marking the year closed.
        missingDepreciation: async (executor, throughMonth) => {
          if (armed) {
            armed = false;
            await pause.wait();
          }
          return testFixedAssetService.missingDepreciation(executor, throughMonth);
        },
      },
    });
    const closing = pausingClose.closeYear(closingId, user.id);
    await pause.reached;
    let unlockError: unknown = null;
    const unlock = testEconomyService.unlockPeriod(march!.id, "Rättelse av hyra", user.id).then(
      () => null,
      (err: unknown) => (unlockError = err)
    );
    try {
      await waitForLockWaiter(); // the period trigger waits on the year row
    } finally {
      pause.release();
      await closing;
      await unlock;
    }
    expect(isBookkeepingLockViolation(unlockError)).toBe(true);
    expect((await yearRow(yearId)).status).toBe("closed");
    const periods = await db.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, yearId));
    expect(periods.filter((p) => p.status === "open")).toEqual([]);
  });
});

describe("öppna året igen", () => {
  it("reverses the result transfer, unlocks only the closing month and logs both", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    await service.closeYear(closingId, user.id);

    const reopened = await service.reopenYear(closingId, "Leverantörsfaktura för december saknades", user.id);
    expect(reopened.status).toBe("in_progress");
    expect(reopened.fiscalYear.status).toBe("open");
    expect(reopened.fiscalYear.closedAt).toBeNull();
    expect(reopened.steps.resultTransfer).toMatchObject({ status: "not_done", net: 60000, verification: null });
    const periods = await db.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, yearId));
    const open = periods.filter((p) => p.status === "open").map((p) => p.startDate);
    expect(open).toEqual([`${YEAR}-12-01`]);
    const cancellation = reopened.history.at(-1)!;
    expect(cancellation).toMatchObject({ step: "result_transfer", role: "cancellation", verification: { displayNumber: `BS-${YEAR}-2`, date: `${YEAR}-12-31` } });
    expect(await verificationLines(cancellation.verification.id)).toEqual([
      { account: "2099", debit: 60000, credit: 0 },
      { account: "8999", debit: 0, credit: 60000 },
    ]);
    const [reopenEntry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "year_end_closing"), eq(auditLog.action, "reopened")));
    expect(reopenEntry).toMatchObject({
      entityId: String(YEAR),
      detail: { reason: "Leverantörsfaktura för december saknades", cancelledResultTransfer: `BS-${YEAR}-2`, unlockedPeriod: `${YEAR}-12` },
    });
    const [periodEntry] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "accounting_period"), eq(auditLog.action, "unlocked")));
    expect(periodEntry).toMatchObject({ entityId: `${YEAR}-${YEAR}-12`, detail: { reason: "Bokslut öppnat igen: Leverantörsfaktura för december saknades" } });

    // Change, transfer again, close again.
    await bookManual(`${YEAR}-12-20`, [{ account: "4010", debit: 10000 }, { account: "1930", credit: 10000 }], user.id);
    expect((await service.bookResultTransfer(closingId, user.id)).net).toBe(50000);
    expect((await service.closeYear(closingId, user.id)).status).toBe("closed");
    expect(await ownership(closingId, "result_transfer")).toEqual([
      [`BS-${YEAR}-1`, "booking"],
      [`BS-${YEAR}-2`, "cancellation"],
      [`BS-${YEAR}-3`, "booking"],
    ]);
  });

  it("refuses an open closing", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await expect(service.reopenYear(closingId, "Rättelse behövs", user.id)).rejects.toBeInstanceOf(YearEndClosingNotClosedError);
  });

  it("refuses while the next year is closed or a profit disposition is active", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 100000, cost: 40000 });
    await service.bookResultTransfer(closingId, user.id);
    await service.closeYear(closingId, user.id);
    const next = await createCalendarYear(NEXT_YEAR);

    const disposition = await bookManual(`${NEXT_YEAR}-05-20`, [{ account: "2099", debit: 60000 }, { account: "2091", credit: 60000 }], user.id);
    await db.insert(profitDispositions).values({ closingId, agmDate: `${NEXT_YEAR}-05-20`, resultAmount: "60000", verificationId: disposition.id });
    await expect(service.reopenYear(closingId, "Rättelse behövs", user.id)).rejects.toBeInstanceOf(ProfitDispositionActiveError);

    await db.delete(profitDispositions);
    await db.update(fiscalYears).set({ status: "closed", closedAt: new Date() }).where(eq(fiscalYears.id, next.id));
    await expect(service.reopenYear(closingId, "Rättelse behövs", user.id)).rejects.toBeInstanceOf(NextFiscalYearClosedError);
    expect((await yearRow(yearId)).status).toBe("closed");
    expect(await countVerifications("BS")).toBe(1);
  });

  // Order A: N+1's close has UPDATEd its year row first. The reopen of N
  // waits on that row, then reads 'closed' and refuses.
  it("waits for a close of the next year in flight and then refuses (reopen after close)", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId, nextClosingId, nextYearId } = await closeYearAndPrepareNext(user.id);
    const pause = pausePoint();
    let armed = true;
    const pausingClose = buildYearEndService({
      fixedAssets: {
        getPlan: (query) => testFixedAssetService.getPlan(query),
        runDepreciation: (tx, input, userId) => testFixedAssetService.runDepreciation(tx, input, userId),
        // closeYear's gate reads this right after marking the year closed.
        missingDepreciation: async (executor, throughMonth) => {
          if (armed) {
            armed = false;
            await pause.wait();
          }
          return testFixedAssetService.missingDepreciation(executor, throughMonth);
        },
      },
    });
    const closingNext = pausingClose.closeYear(nextClosingId, user.id);
    await pause.reached;
    const reopen = service.reopenYear(closingId, "Rättelse behövs", user.id);
    const outcome = expect(reopen).rejects.toBeInstanceOf(NextFiscalYearClosedError);
    try {
      await waitForLockWaiter(); // the reopen waits on N+1's year row
    } finally {
      pause.release();
      await closingNext;
    }
    await outcome;
    expect((await yearRow(nextYearId)).status).toBe("closed");
    expect((await yearRow(yearId)).status).toBe("closed");
  });

  // Order B: the reopen of N has locked N+1's year row first. N+1's close
  // waits on it, then sees N open and is blocked by previous-year-open.
  it("makes a close of the next year wait for a reopen in flight (close after reopen)", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId, nextClosingId, nextYearId } = await closeYearAndPrepareNext(user.id);
    const pause = pausePoint();
    const pausingReopen = buildYearEndService({
      poster: {
        ...testYearEndPoster,
        // reopenYear reverses the result transfer after opening the year.
        reverseBookedVerification: async (tx, sourceId, opts, userId) => {
          await pause.wait();
          return testYearEndPoster.reverseBookedVerification(tx, sourceId, opts, userId);
        },
      },
    });
    const reopen = pausingReopen.reopenYear(closingId, "Rättelse behövs", user.id);
    await pause.reached;
    const closingNext = service.closeYear(nextClosingId, user.id);
    const outcome = expect(closingNext).rejects.toThrow(/Föregående räkenskapsår \(2024\) är inte stängt/);
    try {
      await waitForLockWaiter(); // N+1's close waits on its own year row
    } finally {
      pause.release();
      await reopen;
    }
    await outcome;
    expect((await yearRow(yearId)).status).toBe("open");
    expect((await yearRow(nextYearId)).status).toBe("open");
  });

  // Review Focus 5.
  it("handles a zero-result year: step 5 done without a verification, close and reopen work", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 0, cost: 0 });
    const detail = await service.getClosing(closingId);
    expect(detail.steps.resultTransfer).toMatchObject({ status: "done", verification: null });
    expect((await service.previewResultTransfer(closingId)).rows).toEqual([]);
    expect(await service.bookResultTransfer(closingId, user.id)).toMatchObject({ unchanged: true, verification: null });
    expect((await service.closeYear(closingId, user.id)).status).toBe("closed");
    const reopened = await service.reopenYear(closingId, "Kontroll av nollår", user.id);
    expect(reopened.status).toBe("in_progress");
    expect(await countVerifications("BS")).toBe(0);
    const [row] = await db.select().from(yearEndClosings).where(eq(yearEndClosings.id, closingId));
    expect(row!.resultTransferVerificationId).toBeNull();
  });
});
