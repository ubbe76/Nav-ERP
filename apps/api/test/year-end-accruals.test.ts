import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accountingPeriods, db, fiscalYears, verifications, yearEndClosings } from "@navet/db";
import { readAccountBalances } from "../src/modules/economy/service/account-balances.js";
import { createVatReportService } from "../src/modules/economy/service/vat-report.service.js";
import { AccountingPeriodLockedError, InactiveAccountError } from "../src/modules/economy/service/economy.service.js";
import {
  InvalidAccrualAccountError,
  NextFiscalYearMissingError,
} from "../src/modules/economy/service/year-end-closing.service.js";
import { DEFAULT_POSTING_SETTINGS, testEconomyService } from "./helpers/services.js";
import {
  NEXT_YEAR,
  YEAR,
  accountId,
  bookManual,
  buildYearEndService,
  countVerifications,
  createCalendarYear,
  resetYearEnd,
  setupUserAndAccounts,
  setupYearEnd,
  testYearEndPoster,
  verificationLines,
} from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const service = buildYearEndService();

async function rows(el = 8400) {
  return [
    { kind: "prepaid_expense" as const, balanceAccountId: await accountId("1710"), resultAccountId: await accountId("5010"), amount: 25000, description: "Hyra januari" },
    { kind: "accrued_expense" as const, balanceAccountId: await accountId("2990"), resultAccountId: await accountId("5020"), amount: el, description: "El december" },
    { kind: "accrued_income" as const, balanceAccountId: await accountId("1790"), resultAccountId: await accountId("3001"), amount: 12000, description: "Utfört arbete december" },
  ];
}

async function netOn(account: string, from: string, to: string) {
  const balance = (await readAccountBalances(db, { from, to })).find((row) => row.accountNumber === account);
  return balance ? Math.round((balance.periodDebit - balance.periodCredit) * 100) / 100 : 0;
}

describe("steg 4 — periodiseringar", () => {
  it("books V on the closing date and R on the next year's first day, creating that year", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const result = await service.bookAccruals(closing.id, { rows: await rows() }, user.id);

    expect(result.nextFiscalYearCreated).toBe(true);
    const [next] = await db.select().from(fiscalYears).where(eq(fiscalYears.label, String(NEXT_YEAR)));
    expect(next).toMatchObject({ startDate: `${NEXT_YEAR}-01-01`, endDate: `${NEXT_YEAR}-12-31` });
    expect(await db.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, next!.id))).toHaveLength(12);

    expect(result.verification).toMatchObject({ displayNumber: `BS-${YEAR}-1`, date: `${YEAR}-12-31` });
    expect(result.reversalVerification).toMatchObject({ displayNumber: `BS-${NEXT_YEAR}-1`, date: `${NEXT_YEAR}-01-01` });
    expect(await verificationLines(result.verification!.id)).toEqual([
      { account: "1710", debit: 25000, credit: 0 },
      { account: "1790", debit: 12000, credit: 0 },
      { account: "2990", debit: 0, credit: 8400 },
      { account: "3001", debit: 0, credit: 12000 },
      { account: "5010", debit: 0, credit: 25000 },
      { account: "5020", debit: 8400, credit: 0 },
    ]);
    expect(await verificationLines(result.reversalVerification!.id)).toEqual([
      { account: "1710", debit: 0, credit: 25000 },
      { account: "1790", debit: 0, credit: 12000 },
      { account: "2990", debit: 8400, credit: 0 },
      { account: "3001", debit: 12000, credit: 0 },
      { account: "5010", debit: 25000, credit: 0 },
      { account: "5020", debit: 0, credit: 8400 },
    ]);
    // R is an ordinary booking in the next year, not an omföring of V.
    const [reversal] = await db.select().from(verifications).where(eq(verifications.id, result.reversalVerification!.id));
    expect(reversal!.reversesVerificationId).toBeNull();
    const detail = await service.getClosing(closing.id);
    expect(detail.steps.accruals.status).toBe("done");
    expect(detail.steps.accruals.rows.map((row) => [row.kind, row.balanceAccountNumber, row.resultAccountNumber, row.amount, row.description])).toEqual([
      ["prepaid_expense", "1710", "5010", 25000, "Hyra januari"],
      ["accrued_expense", "2990", "5020", 8400, "El december"],
      ["accrued_income", "1790", "3001", 12000, "Utfört arbete december"],
    ]);
    expect(detail.history.map((row) => row.role)).toEqual(["booking", "accrual_reversal"]);
  });

  it("does nothing on an identical re-run; a changed row cancels both and books a new pair, exactly once per year", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await service.bookAccruals(closing.id, { rows: await rows() }, user.id);

    expect((await service.bookAccruals(closing.id, { rows: await rows() }, user.id)).unchanged).toBe(true);
    expect(await countVerifications("BS")).toBe(2);

    const changed = await service.bookAccruals(closing.id, { rows: await rows(9100) }, user.id);
    expect(changed.cancelled.map((ref) => [ref.displayNumber, ref.date])).toEqual([
      [`BS-${YEAR}-2`, `${YEAR}-12-31`],
      [`BS-${NEXT_YEAR}-2`, `${NEXT_YEAR}-01-01`],
    ]);
    expect(changed.verification!.displayNumber).toBe(`BS-${YEAR}-3`);
    expect(changed.reversalVerification!.displayNumber).toBe(`BS-${NEXT_YEAR}-3`);
    // Net effect per year = exactly the live pair.
    expect(await netOn("5020", `${YEAR}-01-01`, `${YEAR}-12-31`)).toBe(9100);
    expect(await netOn("5020", `${NEXT_YEAR}-01-01`, `${NEXT_YEAR}-12-31`)).toBe(-9100);
    expect(await netOn("1710", `${YEAR}-01-01`, `${NEXT_YEAR}-12-31`)).toBe(0);

    // Every booking of the re-run is in the ownership log, in the same tx.
    const history = (await service.getClosing(closing.id)).history;
    expect(history.map((row) => [row.verification.displayNumber, row.step, row.role])).toEqual([
      [`BS-${YEAR}-1`, "accruals", "booking"],
      [`BS-${YEAR}-2`, "accruals", "cancellation"],
      [`BS-${YEAR}-3`, "accruals", "booking"],
      [`BS-${NEXT_YEAR}-1`, "accruals", "accrual_reversal"],
      [`BS-${NEXT_YEAR}-2`, "accruals", "cancellation"],
      [`BS-${NEXT_YEAR}-3`, "accruals", "accrual_reversal"],
    ]);
  });

  it("cancels the pair and stores none for an empty set", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await service.bookAccruals(closing.id, { rows: await rows() }, user.id);
    const none = await service.bookAccruals(closing.id, { rows: [] }, user.id);
    expect(none).toMatchObject({ verification: null, reversalVerification: null });
    expect(none.cancelled).toHaveLength(2);
    const [row] = await db.select().from(yearEndClosings).where(eq(yearEndClosings.id, closing.id));
    expect(row).toMatchObject({ accrualsVerificationId: null, accrualsReversalVerificationId: null });
    expect(row!.accrualsBookedAt).not.toBeNull();
  });

  it("marks an empty first run done without creating the next year", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const result = await service.bookAccruals(closing.id, { rows: [] }, user.id);
    expect(result).toMatchObject({ verification: null, nextFiscalYearCreated: false });
    expect(await db.select().from(fiscalYears)).toHaveLength(1);
  });

  it("409s without a trace when the next year's first period is locked", async () => {
    const { user, yearId } = await setupYearEnd();
    const next = await createCalendarYear(NEXT_YEAR);
    await testEconomyService.lockPeriod(next.periods[0]!.id, user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await expect(service.bookAccruals(closing.id, { rows: await rows() }, user.id)).rejects.toBeInstanceOf(AccountingPeriodLockedError);
    expect(await countVerifications("BS")).toBe(0);
  });

  it("409s NextFiscalYearMissingError when the next year cannot be created", async () => {
    const { user, yearId } = await setupYearEnd();
    // A later year that would overlap the proposed 2025-01-01–2025-12-31.
    await testEconomyService.createFiscalYear({ label: "Senare", startDate: `${NEXT_YEAR}-03-01`, endDate: `${NEXT_YEAR + 1}-02-28` });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await expect(service.bookAccruals(closing.id, { rows: await rows() }, user.id)).rejects.toBeInstanceOf(NextFiscalYearMissingError);
  });

  it("400s a balance account on the wrong side and a result account that is not class 3–8", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const [first] = await rows();
    await expect(
      service.bookAccruals(closing.id, { rows: [{ ...first!, kind: "accrued_expense" }] }, user.id)
    ).rejects.toBeInstanceOf(InvalidAccrualAccountError);
    await expect(
      service.bookAccruals(closing.id, { rows: [{ ...first!, resultAccountId: await accountId("1930") }] }, user.id)
    ).rejects.toBeInstanceOf(InvalidAccrualAccountError);
  });

  // Review Focus 3.
  it("creates the next brutet år and dates the reversal on its first day", async () => {
    const { user } = await setupUserAndAccounts();
    const year = await testEconomyService.createFiscalYear({ label: "2023/24", startDate: "2023-05-01", endDate: "2024-04-30" });
    const closing = await service.startClosing({ fiscalYearId: year.id }, user.id);
    const result = await service.bookAccruals(closing.id, { rows: (await rows()).slice(0, 1) }, user.id);
    const [next] = await db.select().from(fiscalYears).where(eq(fiscalYears.label, "2024/25"));
    expect(next).toMatchObject({ startDate: "2024-05-01", endDate: "2025-04-30" });
    expect(result.reversalVerification).toMatchObject({ date: "2024-05-01", displayNumber: "BS-2024/25-1" });
  });

  // Review Focus 4.
  it("400s a re-run with an account deactivated since, leaving the live pair untouched", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const first = await service.bookAccruals(closing.id, { rows: await rows() }, user.id);
    await testEconomyService.updateAccount(await accountId("5020"), { active: false });
    await expect(service.bookAccruals(closing.id, { rows: await rows(9100) }, user.id)).rejects.toBeInstanceOf(InactiveAccountError);
    expect(await countVerifications("BS")).toBe(2);
    const [row] = await db.select().from(yearEndClosings).where(eq(yearEndClosings.id, closing.id));
    expect(row!.accrualsVerificationId).toBe(first.verification!.id);
  });

  // Spec §12: an accrual on a revenue account with a momsruta must not move
  // ruta 05 from December to January (the guide's verifications are excluded).
  it("leaves the VAT report's ruta 05 untouched in December and January", async () => {
    const { user, yearId } = await setupYearEnd();
    await bookManual(`${YEAR}-12-15`, [{ account: "1510", debit: 1250 }, { account: "3001", credit: 1000 }, { account: "2610", credit: 250 }], user.id);
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await service.bookAccruals(closing.id, { rows: (await rows()).slice(2) }, user.id);

    const vatReport = createVatReportService({ db, poster: testYearEndPoster, settings: { read: async () => DEFAULT_POSTING_SETTINGS } });
    const december = await vatReport.getReport({ from: `${YEAR}-12-01`, to: `${YEAR}-12-31` });
    const january = await vatReport.getReport({ from: `${NEXT_YEAR}-01-01`, to: `${NEXT_YEAR}-01-31` });
    expect(december.boxes.sales05).toBe(1000);
    expect(january.boxes.sales05).toBe(0);
    // The accrual did book on 3001 in both months — the report just ignores it.
    expect(await netOn("3001", `${YEAR}-12-01`, `${YEAR}-12-31`)).toBe(-13000);
    expect(await netOn("3001", `${NEXT_YEAR}-01-01`, `${NEXT_YEAR}-01-31`)).toBe(12000);
  });

  it("books exactly one pair under two concurrent calls", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const set = await rows();
    const results = await Promise.all([
      service.bookAccruals(closing.id, { rows: set }, user.id),
      service.bookAccruals(closing.id, { rows: set }, user.id),
    ]);
    expect(results.filter((r) => r.unchanged)).toHaveLength(1);
    expect(await countVerifications("BS")).toBe(2);
  });
});
