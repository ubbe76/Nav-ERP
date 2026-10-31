import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { accounts, db, fiscalYears, verifications, yearEndClosingVerifications, yearEndClosings } from "@navet/db";
import { YearEndClosingVerificationError } from "../src/modules/economy/service/economy.service.js";
import type { ValuationMethod } from "@navet/shared";
import {
  InventoryAccountConflictError,
  YearEndBlockedError,
  type InventoryValuationReader,
} from "../src/modules/economy/service/year-end-closing.service.js";
import { MissingPostingAccountError } from "../src/modules/economy/service/verification-poster.js";
import { DEFAULT_POSTING_SETTINGS, testEconomyService } from "./helpers/services.js";
import {
  PREVIOUS_YEAR,
  YEAR,
  bookManual,
  buildYearEndService,
  countVerifications,
  createCalendarYear,
  resetYearEnd,
  setupYearEnd,
  verificationLines,
} from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

// The valuation is D1's job and has its own suite; here it is a fake whose
// value the test sets, and which records what it was asked.
function fakeValuation(initial: number) {
  const calls: { asOf: string; method: ValuationMethod }[] = [];
  const state = { value: initial };
  const reader: InventoryValuationReader = {
    async getValuation(query) {
      calls.push(query);
      return {
        totalValue: state.value,
        unvaluedCount: 1,
        groups: [{ rows: [{ articleNumber: "A-1", articleName: "Utan pris", unit: "st", quantity: 4, value: null }] }],
      };
    },
  };
  return { reader, state, calls };
}

async function openingInventory(userId: string, amount: number) {
  await bookManual(`${YEAR}-01-01`, [{ account: "1460", debit: amount }, { account: "2091", credit: amount }], userId);
}

describe("steg 2 — lagerförändring", () => {
  it("books the difference against 4990 on the closing date, in series BS", async () => {
    const { user, yearId } = await setupYearEnd();
    await openingInventory(user.id, 180000);
    const valuation = fakeValuation(212450);
    const service = buildYearEndService({ inventory: valuation.reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);

    const preview = await service.previewInventory(closing.id);
    expect(preview).toMatchObject({
      method: "moving_average",
      value: 212450,
      ledgerBalance: 180000,
      ledgerExcludingStep: 180000,
      difference: 32450,
      unvaluedCount: 1,
      unchanged: false,
    });
    expect(preview.rows).toEqual([
      { accountNumber: "1460", accountName: "Lager av handelsvaror", debit: 32450, credit: 0 },
      { accountNumber: "4990", accountName: "Förändring av lager", debit: 0, credit: 32450 },
    ]);

    const result = await service.bookInventory(closing.id, { method: "moving_average" }, user.id);
    expect(result).toMatchObject({ unchanged: false, cancelled: null, value: 212450, difference: 32450 });
    expect(result.verification).toMatchObject({ displayNumber: `BS-${YEAR}-1`, date: `${YEAR}-12-31` });
    expect(await verificationLines(result.verification!.id)).toEqual([
      { account: "1460", debit: 32450, credit: 0 },
      { account: "4990", debit: 0, credit: 32450 },
    ]);
    expect(valuation.calls.at(-1)).toEqual({ asOf: `${YEAR}-12-31`, method: "moving_average" });
    expect((await service.getClosing(closing.id)).steps.inventory).toMatchObject({ status: "done", value: 212450, method: "moving_average" });
  });

  it("does nothing on an identical re-run and reverses + rebooks on a method change", async () => {
    const { user, yearId } = await setupYearEnd();
    await openingInventory(user.id, 180000);
    const valuation = fakeValuation(212450);
    const service = buildYearEndService({ inventory: valuation.reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const first = await service.bookInventory(closing.id, { method: "moving_average" }, user.id);

    const again = await service.bookInventory(closing.id, { method: "moving_average" }, user.id);
    expect(again.unchanged).toBe(true);
    expect(await countVerifications("BS")).toBe(1);

    valuation.state.value = 205000;
    const changed = await service.bookInventory(closing.id, { method: "standard" }, user.id);
    expect(changed.cancelled).toMatchObject({ displayNumber: `BS-${YEAR}-2`, date: `${YEAR}-12-31` });
    expect(await verificationLines(changed.cancelled!.id)).toEqual([
      { account: "1460", debit: 0, credit: 32450 },
      { account: "4990", debit: 32450, credit: 0 },
    ]);
    expect(changed.verification).toMatchObject({ displayNumber: `BS-${YEAR}-3` });
    expect(changed.difference).toBe(25000);
    expect(first.verification!.id).not.toBe(changed.verification!.id);
    const history = (await service.getClosing(closing.id)).history.map((row) => [row.verification.displayNumber, row.role]);
    expect(history).toEqual([
      [`BS-${YEAR}-1`, "booking"],
      [`BS-${YEAR}-2`, "cancellation"],
      [`BS-${YEAR}-3`, "booking"],
    ]);

    // The ownership log is written in the same transactions as the bookings:
    // every row belongs to steg 2 of this closing.
    const ownership = await db
      .select({
        verificationId: yearEndClosingVerifications.verificationId,
        closingId: yearEndClosingVerifications.closingId,
        step: yearEndClosingVerifications.step,
        role: yearEndClosingVerifications.role,
      })
      .from(yearEndClosingVerifications)
      .innerJoin(verifications, eq(verifications.id, yearEndClosingVerifications.verificationId))
      .orderBy(asc(verifications.verificationNumber));
    expect(ownership).toEqual([
      { verificationId: first.verification!.id, closingId: closing.id, step: "inventory", role: "booking" },
      { verificationId: changed.cancelled!.id, closingId: closing.id, step: "inventory", role: "cancellation" },
      { verificationId: changed.verification!.id, closingId: closing.id, step: "inventory", role: "booking" },
    ]);
    // …so the generic Omför refuses each of them (spec §12).
    for (const row of ownership) {
      await expect(testEconomyService.reverse(row.verificationId, user.id)).rejects.toBeInstanceOf(YearEndClosingVerificationError);
    }
  });

  it("marks the step done without a verification when value equals the ledger", async () => {
    const { user, yearId } = await setupYearEnd();
    await openingInventory(user.id, 180000);
    const service = buildYearEndService({ inventory: fakeValuation(180000).reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const result = await service.bookInventory(closing.id, { method: "standard" }, user.id);
    expect(result).toMatchObject({ unchanged: false, verification: null, difference: 0 });
    const [row] = await db.select().from(yearEndClosings).where(eq(yearEndClosings.id, closing.id));
    expect(row!.inventoryBookedAt).not.toBeNull();
    expect(row!.inventoryVerificationId).toBeNull();
  });

  it("flags a later booking on 1460 as stale and corrects it on re-run", async () => {
    const { user, yearId } = await setupYearEnd();
    await openingInventory(user.id, 180000);
    const service = buildYearEndService({ inventory: fakeValuation(212450).reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await service.bookInventory(closing.id, { method: "moving_average" }, user.id);
    await bookManual(`${YEAR}-12-30`, [{ account: "1460", debit: 1000 }, { account: "4990", credit: 1000 }], user.id);

    const detail = await service.getClosing(closing.id);
    expect(detail.steps.inventory.status).toBe("stale");
    expect(detail.checks.warnings.map((w) => w.code)).toContain("inventory-stale");

    const rerun = await service.bookInventory(closing.id, { method: "moving_average" }, user.id);
    expect(rerun.difference).toBe(31450); // 212 450 − (180 000 + 1 000)
    expect((await service.getClosing(closing.id)).steps.inventory.status).toBe("done");
  });

  // Review Focus 2.
  it("refuses a re-run after the closing month was locked again, writing nothing", async () => {
    const { user, yearId } = await setupYearEnd();
    await openingInventory(user.id, 180000);
    const valuation = fakeValuation(212450);
    const service = buildYearEndService({ inventory: valuation.reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const first = await service.bookInventory(closing.id, { method: "moving_average" }, user.id);
    await testEconomyService.lockPeriod(closing.closingPeriod.id, user.id);

    valuation.state.value = 205000;
    await expect(service.bookInventory(closing.id, { method: "standard" }, user.id)).rejects.toBeInstanceOf(YearEndBlockedError);
    expect(await countVerifications("BS")).toBe(1);
    const [row] = await db.select().from(yearEndClosings).where(eq(yearEndClosings.id, closing.id));
    expect(row!.inventoryVerificationId).toBe(first.verification!.id);
    expect(row!.inventoryMethod).toBe("moving_average");
  });

  // Review Focus 1 (lager).
  it("values the inventory as of a closing date before the year's last day", async () => {
    const { user, yearId } = await setupYearEnd();
    const valuation = fakeValuation(0);
    const service = buildYearEndService({ inventory: valuation.reader });
    const closing = await service.startClosing({ fiscalYearId: yearId, closingDate: `${YEAR}-12-20` }, user.id);
    await service.bookInventory(closing.id, { method: "standard" }, user.id);
    expect(valuation.calls.at(-1)).toEqual({ asOf: `${YEAR}-12-20`, method: "standard" });
  });

  // A service company: no stock, no 1460/4990 in the chart. Value 0 on an
  // empty inventory account completes the step without either account.
  it("completes a zero valuation on an empty inventory account without the inventory accounts", async () => {
    const { user, yearId } = await setupYearEnd();
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "1460"));
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "4990"));
    const service = buildYearEndService({ inventory: fakeValuation(0).reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);

    expect(await service.previewInventory(closing.id, "standard")).toMatchObject({ value: 0, difference: 0, rows: [] });
    const result = await service.bookInventory(closing.id, { method: "standard" }, user.id);
    expect(result).toMatchObject({ unchanged: false, verification: null, difference: 0 });
    expect((await service.getClosing(closing.id)).steps.inventory).toMatchObject({ status: "done", value: 0, verification: null });
    expect(await countVerifications("BS")).toBe(0);
  });

  it("still requires the inventory accounts when there is something to value", async () => {
    const { user, yearId } = await setupYearEnd();
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "4990"));
    const service = buildYearEndService({ inventory: fakeValuation(1000).reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await expect(service.bookInventory(closing.id, { method: "standard" }, user.id)).rejects.toBeInstanceOf(MissingPostingAccountError);
  });

  it("409s when lager and lagerförändring are the same account even with nothing to value", async () => {
    const { user, yearId } = await setupYearEnd();
    const service = buildYearEndService({
      inventory: fakeValuation(0).reader,
      settings: { read: async () => ({ ...DEFAULT_POSTING_SETTINGS, postingInventoryChange: "1460" }) },
    });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await expect(service.previewInventory(closing.id, "standard")).rejects.toBeInstanceOf(InventoryAccountConflictError);
    await expect(service.bookInventory(closing.id, { method: "standard" }, user.id)).rejects.toBeInstanceOf(InventoryAccountConflictError);
  });

  it("409s when lager and lagerförändring are the same account", async () => {
    const { user, yearId } = await setupYearEnd();
    const service = buildYearEndService({
      inventory: fakeValuation(1000).reader,
      settings: { read: async () => ({ ...DEFAULT_POSTING_SETTINGS, postingInventoryChange: "1460" }) },
    });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await expect(service.bookInventory(closing.id, { method: "standard" }, user.id)).rejects.toBeInstanceOf(InventoryAccountConflictError);
  });

  it("defaults the method to the previous closed closing's, else Vägt snitt", async () => {
    const { user, yearId } = await setupYearEnd();
    const service = buildYearEndService({ inventory: fakeValuation(0).reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    expect((await service.getClosing(closing.id)).defaultInventoryMethod).toBe("moving_average");

    const previous = await createCalendarYear(PREVIOUS_YEAR);
    await db.update(fiscalYears).set({ status: "closed", closedAt: new Date() }).where(eq(fiscalYears.id, previous.id));
    await db.insert(yearEndClosings).values({
      fiscalYearId: previous.id,
      closingDate: `${PREVIOUS_YEAR}-12-31`,
      status: "closed",
      inventoryMethod: "standard",
      inventoryValue: "0",
      inventoryBookedAt: new Date(),
    });
    expect((await service.getClosing(closing.id)).defaultInventoryMethod).toBe("standard");
  });
});
