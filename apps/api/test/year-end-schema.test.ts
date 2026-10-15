import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accountingPeriods, db, fiscalYears, profitDispositions, verificationSeries, verifications, yearEndAccruals, yearEndClosings } from "@navet/db";
import { isBookkeepingLockViolation } from "../src/modules/system/service/db-errors.js";
import { YEAR, accountId, expectConstraint, failure, resetYearEnd, setupYearEnd } from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

async function seriesId() {
  const [row] = await db.insert(verificationSeries).values({ code: "T", name: "Test" }).returning();
  return row!.id;
}

async function lockAllPeriods(fiscalYearId: string) {
  await db.update(accountingPeriods).set({ status: "locked", lockedAt: new Date() }).where(eq(accountingPeriods.fiscalYearId, fiscalYearId));
}

async function closeBySql(fiscalYearId: string) {
  await lockAllPeriods(fiscalYearId);
  await db.update(fiscalYears).set({ status: "closed", closedAt: new Date() }).where(eq(fiscalYears.id, fiscalYearId));
}

function bookedVerification(series: string, fiscalYearId: string, number: number) {
  return db.insert(verifications).values({
    seriesId: series,
    fiscalYearId,
    verificationNumber: number,
    date: `${YEAR}-06-30`,
    description: "Test",
    status: "booked",
  });
}

describe("migration 0105 — fiscal_years.status", () => {
  it("defaults to open and refuses closed without closed_at", async () => {
    const { yearId } = await setupYearEnd();
    const [year] = await db.select().from(fiscalYears).where(eq(fiscalYears.id, yearId));
    expect(year!.status).toBe("open");
    await expectConstraint(
      db.update(fiscalYears).set({ status: "closed" }).where(eq(fiscalYears.id, yearId)),
      "fiscal_year_closed_consistent"
    );
  });
});

describe("migration 0105 — closed-year triggers", () => {
  it("refuses booking a verification into a closed year (NV001), but not into an open one", async () => {
    const { yearId } = await setupYearEnd();
    const series = await seriesId();
    await bookedVerification(series, yearId, 1); // open year: allowed
    await closeBySql(yearId);
    const err = await failure(bookedVerification(series, yearId, 2));
    expect(isBookkeepingLockViolation(err)).toBe(true);
  });

  it("lets a draft in but refuses its draft → booked flip in a closed year", async () => {
    const { yearId } = await setupYearEnd();
    const series = await seriesId();
    await closeBySql(yearId);
    const [draft] = await db
      .insert(verifications)
      .values({ seriesId: series, fiscalYearId: yearId, date: `${YEAR}-06-30`, description: "Utkast" })
      .returning();
    const err = await failure(
      db.update(verifications).set({ status: "booked", verificationNumber: 1 }).where(eq(verifications.id, draft!.id))
    );
    expect(isBookkeepingLockViolation(err)).toBe(true);
  });

  it("refuses unlocking a period of a closed year, allows it in an open year", async () => {
    const { yearId } = await setupYearEnd();
    const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.fiscalYearId, yearId)).limit(1);
    await lockAllPeriods(yearId);
    await db.update(accountingPeriods).set({ status: "open", lockedAt: null }).where(eq(accountingPeriods.id, period!.id));
    await closeBySql(yearId);
    const err = await failure(
      db.update(accountingPeriods).set({ status: "open", lockedAt: null }).where(eq(accountingPeriods.id, period!.id))
    );
    expect(isBookkeepingLockViolation(err)).toBe(true);
  });
});

describe("migration 0105 — year_end_closings", () => {
  it("refuses an accrual verification without its reversal and a booked inventory step without a method", async () => {
    const { yearId } = await setupYearEnd();
    const series = await seriesId();
    const [verification] = await bookedVerification(series, yearId, 1).returning();
    await expectConstraint(
      db.insert(yearEndClosings).values({
        fiscalYearId: yearId,
        closingDate: `${YEAR}-12-31`,
        accrualsVerificationId: verification!.id,
        accrualsBookedAt: new Date(),
      }),
      "year_end_accruals_pair"
    );
    await expectConstraint(
      db.insert(yearEndClosings).values({ fiscalYearId: yearId, closingDate: `${YEAR}-12-31`, inventoryBookedAt: new Date() }),
      "year_end_inventory_consistent"
    );
  });

  it("refuses an inventory method outside the valuation methods", async () => {
    const { yearId } = await setupYearEnd();
    await expectConstraint(
      db.insert(yearEndClosings).values({
        fiscalYearId: yearId,
        closingDate: `${YEAR}-12-31`,
        inventoryMethod: "fifo",
        inventoryValue: "0",
        inventoryBookedAt: new Date(),
      }),
      "year_end_inventory_method_valid"
    );
  });
});

describe("migration 0105 — year_end_accruals", () => {
  it("refuses a non-positive amount and the same account on both sides", async () => {
    const { yearId } = await setupYearEnd();
    const series = await seriesId();
    const [verification] = await bookedVerification(series, yearId, 1).returning();
    const [closing] = await db.insert(yearEndClosings).values({ fiscalYearId: yearId, closingDate: `${YEAR}-12-31` }).returning();
    const row = {
      closingId: closing!.id,
      verificationId: verification!.id,
      kind: "prepaid_expense" as const,
      balanceAccountId: await accountId("1710"),
      resultAccountId: await accountId("5010"),
      amount: "100",
      description: "Hyra",
      sortOrder: 0,
    };
    await db.insert(yearEndAccruals).values(row); // valid row: allowed
    await expectConstraint(db.insert(yearEndAccruals).values({ ...row, amount: "0" }), "year_end_accrual_amount_positive");
    await expectConstraint(db.insert(yearEndAccruals).values({ ...row, amount: "-5" }), "year_end_accrual_amount_positive");
    await expectConstraint(
      db.insert(yearEndAccruals).values({ ...row, resultAccountId: row.balanceAccountId }),
      "year_end_accrual_accounts_distinct"
    );
  });
});

describe("profit_dispositions", () => {
  it("allows one active disposition per closing and refuses an empty one", async () => {
    const { yearId } = await setupYearEnd();
    const series = await seriesId();
    const [first] = await bookedVerification(series, yearId, 1).returning();
    const [second] = await bookedVerification(series, yearId, 2).returning();
    const [third] = await bookedVerification(series, yearId, 3).returning();
    const [closing] = await db.insert(yearEndClosings).values({ fiscalYearId: yearId, closingDate: `${YEAR}-12-31` }).returning();
    const row = { closingId: closing!.id, agmDate: `${YEAR + 1}-05-20`, resultAmount: "100", dividendAmount: "0", verificationId: first!.id };
    const [active] = await db.insert(profitDispositions).values(row).returning();
    // A second ACTIVE one is refused; a reversed one frees the slot.
    await expectConstraint(db.insert(profitDispositions).values({ ...row, verificationId: second!.id }), "profit_dispositions_one_active");
    await db.update(profitDispositions).set({ reversalVerificationId: third!.id }).where(eq(profitDispositions.id, active!.id));
    await db.insert(profitDispositions).values({ ...row, verificationId: second!.id });
    // result 0 and dividend 0 books nothing.
    await expectConstraint(
      db.insert(profitDispositions).values({ ...row, closingId: closing!.id, resultAmount: "0", dividendAmount: "0", verificationId: (await bookedVerification(series, yearId, 4).returning())[0]!.id, reversalVerificationId: (await bookedVerification(series, yearId, 5).returning())[0]!.id }),
      "profit_disposition_nonzero"
    );
  });
});
