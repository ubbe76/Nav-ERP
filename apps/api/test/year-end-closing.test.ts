import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, db, yearEndClosingVerifications, yearEndClosings } from "@navet/db";
import { FiscalYearNotFoundError, YearEndClosingVerificationError } from "../src/modules/economy/service/economy.service.js";
import { readVatAccountMovements } from "../src/modules/economy/service/vat-account-movements.js";
import { ZeroAmountPostingError } from "../src/modules/economy/service/verification-poster.js";
import {
  ClosingDateLockedError,
  InvalidClosingDateError,
  YearEndClosingExistsError,
} from "../src/modules/economy/service/year-end-closing.service.js";
import { testEconomyService } from "./helpers/services.js";
import {
  YEAR,
  accountId,
  buildYearEndService,
  resetYearEnd,
  setupYearEnd,
  testYearEndPoster,
  verificationLines,
} from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

const service = buildYearEndService();

async function postBs(date: string, amounts: { account: string; amount: number }[], userId: string) {
  const resolved = [];
  for (const row of amounts) resolved.push({ accountId: await accountId(row.account), amount: row.amount });
  return db.transaction((tx) =>
    testYearEndPoster.postClosingEntry(
      tx,
      { date, description: "Testpost", amounts: resolved, source: "year_end_inventory", document: "Test" },
      userId
    )
  );
}

describe("startClosing / updateClosingDate", () => {
  it("defaults the closing date to the year's last day and logs started", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    expect(closing).toMatchObject({
      closingDate: `${YEAR}-12-31`,
      status: "in_progress",
      fiscalYear: { label: String(YEAR), status: "open" },
      closingPeriod: { startDate: `${YEAR}-12-01`, endDate: `${YEAR}-12-31`, status: "open" },
      nextFiscalYear: null,
      history: [],
    });
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "year_end_closing"), eq(auditLog.action, "started")));
    expect(entry).toMatchObject({ entityId: String(YEAR), detail: { closingDate: `${YEAR}-12-31` } });
  });

  it("refuses a closing date outside the last period and accepts one inside it", async () => {
    const { user, yearId } = await setupYearEnd();
    await expect(service.startClosing({ fiscalYearId: yearId, closingDate: `${YEAR}-11-30` }, user.id)).rejects.toBeInstanceOf(
      InvalidClosingDateError
    );
    const closing = await service.startClosing({ fiscalYearId: yearId, closingDate: `${YEAR}-12-20` }, user.id);
    expect(closing.closingDate).toBe(`${YEAR}-12-20`);
  });

  it("409s a second closing for the same year and 404s an unknown year", async () => {
    const { user, yearId } = await setupYearEnd();
    await service.startClosing({ fiscalYearId: yearId }, user.id);
    await expect(service.startClosing({ fiscalYearId: yearId }, user.id)).rejects.toBeInstanceOf(YearEndClosingExistsError);
    await expect(service.startClosing({ fiscalYearId: crypto.randomUUID() }, user.id)).rejects.toBeInstanceOf(FiscalYearNotFoundError);
  });

  it("changes the closing date until a step is booked, then refuses", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    expect((await service.updateClosingDate(closing.id, `${YEAR}-12-15`, user.id)).closingDate).toBe(`${YEAR}-12-15`);
    // The same date again changes nothing and logs nothing.
    expect((await service.updateClosingDate(closing.id, `${YEAR}-12-15`, user.id)).closingDate).toBe(`${YEAR}-12-15`);
    const changes = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "year_end_closing"), eq(auditLog.action, "closing_date_changed")));
    expect(changes).toHaveLength(1);
    await expect(service.updateClosingDate(closing.id, `${YEAR}-10-01`, user.id)).rejects.toBeInstanceOf(InvalidClosingDateError);
    // A booked inventory step (value 0, nothing to book) locks the date.
    await db
      .update(yearEndClosings)
      .set({ inventoryMethod: "standard", inventoryValue: "0", inventoryBookedAt: new Date() })
      .where(eq(yearEndClosings.id, closing.id));
    await expect(service.updateClosingDate(closing.id, `${YEAR}-12-31`, user.id)).rejects.toBeInstanceOf(ClosingDateLockedError);
  });
});

describe("postClosingEntry — serie BS", () => {
  it("books in series BS numbered per year and refuses an empty entry", async () => {
    const { user } = await setupYearEnd();
    const posted = await postBs(`${YEAR}-12-31`, [
      { account: "1460", amount: 1000 },
      { account: "4990", amount: -1000 },
    ], user.id);
    expect(posted.displayNumber).toBe(`BS-${YEAR}-1`);
    expect(await verificationLines(posted.verificationId)).toEqual([
      { account: "1460", debit: 1000, credit: 0 },
      { account: "4990", debit: 0, credit: 1000 },
    ]);
    await expect(postBs(`${YEAR}-12-31`, [{ account: "1460", amount: 0 }], user.id)).rejects.toBeInstanceOf(ZeroAmountPostingError);
  });
});

describe("guide-owned verifications", () => {
  it("refuses the generic Omför, links the card to the closing and leaves the VAT report", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const owned = await postBs(`${YEAR}-12-31`, [
      { account: "1790", amount: 12000 },
      { account: "3001", amount: -12000 },
    ], user.id);
    const free = await postBs(`${YEAR}-12-31`, [
      { account: "1930", amount: 500 },
      { account: "3001", amount: -500 },
    ], user.id);
    await db.insert(yearEndClosingVerifications).values({ verificationId: owned.verificationId, closingId: closing.id, step: "accruals", role: "booking" });

    await expect(testEconomyService.reverse(owned.verificationId, user.id)).rejects.toBeInstanceOf(YearEndClosingVerificationError);
    const card = await testEconomyService.findVerificationById(owned.verificationId);
    expect(card.yearEnd).toEqual({ closingId: closing.id, fiscalYearId: yearId, fiscalYearLabel: String(YEAR), step: "accruals", role: "booking" });
    expect((await testEconomyService.findVerificationById(free.verificationId)).yearEnd).toBeNull();

    const movements = await readVatAccountMovements(db, `${YEAR}-12-01`, `${YEAR}-12-31`);
    expect(movements.find((row) => row.accountNumber === "3001")).toMatchObject({ credit: 500 });
    expect(movements.find((row) => row.accountNumber === "1790")).toBeUndefined();

    const detail = await service.getClosing(closing.id);
    expect(detail.history).toEqual([
      { verification: { id: owned.verificationId, displayNumber: `BS-${YEAR}-1`, date: `${YEAR}-12-31` }, step: "accruals", role: "booking" },
    ]);
  });

  // Spec §12: Omför is refused for EVERY role a guide-booked verification can
  // carry in the ownership log (the role enum is complete from migration
  // 0105 on) — later tasks only add the code paths that write them.
  it.each([
    { step: "inventory", role: "booking" },
    { step: "accruals", role: "accrual_reversal" },
    { step: "result_transfer", role: "cancellation" },
    { step: "profit_disposition", role: "booking" },
    { step: "profit_disposition", role: "cancellation" },
  ] as const)("refuses Omför of a $role verification ($step) and writes no draft", async ({ step, role }) => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const owned = await postBs(`${YEAR}-12-31`, [
      { account: "1460", amount: 700 },
      { account: "4990", amount: -700 },
    ], user.id);
    await db.insert(yearEndClosingVerifications).values({ verificationId: owned.verificationId, closingId: closing.id, step, role });

    await expect(testEconomyService.reverse(owned.verificationId, user.id)).rejects.toBeInstanceOf(YearEndClosingVerificationError);
    expect((await testEconomyService.findVerificationById(owned.verificationId)).reversedBy).toBeNull();
  });
});
