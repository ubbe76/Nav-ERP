import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { accounts, auditLog, db, fiscalYears, verifications, yearEndClosingVerifications, yearEndClosings } from "@navet/db";
import type { WipBasis } from "@navet/shared";
import { YearEndClosingVerificationError } from "../src/modules/economy/service/economy.service.js";
import {
  WorkInProgressAccountConflictError,
  YearEndStepOrderError,
  type WorkInProgressReader,
} from "../src/modules/economy/service/year-end-closing.service.js";
import { MissingPostingAccountError } from "../src/modules/economy/service/verification-poster.js";
import { DEFAULT_POSTING_SETTINGS, testEconomyService } from "./helpers/services.js";
import {
  PREVIOUS_YEAR,
  YEAR,
  bookManual,
  buildYearEndApp,
  buildYearEndService,
  countVerifications,
  createCalendarYear,
  prepareClosableYear,
  resetYearEnd,
  setupUserAndAccounts,
  setupYearEnd,
  verificationLines,
} from "./helpers/year-end.js";

beforeEach(resetYearEnd);
afterAll(resetYearEnd);

// Årsbokslut, the step Produkter i arbete (#25). The PIA report is the
// costing module's job and has its own suites (work-in-progress*.test.ts);
// here it is a fake whose value the test sets and which records what it was
// asked.
function fakeWip(initial: number) {
  const calls: { asOf: string; basis: WipBasis }[] = [];
  const state = { value: initial };
  const reader: WorkInProgressReader = {
    async getWorkInProgress(query) {
      calls.push(query);
      return {
        totalValue: state.value,
        unvaluedCount: 1,
        cappedCount: 0,
        rows: [
          { orderNumber: "TO-1", articleNumber: "A-1", articleName: "Diskbänk", value: state.value },
          { orderNumber: "TO-2", articleNumber: "A-2", articleName: "Utan pris", value: null },
        ],
      };
    },
  };
  return { reader, state, calls };
}

async function auditActions(): Promise<string[]> {
  const rows = await db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityType, "year_end_closing"));
  return rows.map((row) => row.action);
}

describe("Produkter i arbete — preview and booking", () => {
  it("books the PIA against 4940 on the closing date, in series BS", async () => {
    const { user, yearId } = await setupYearEnd();
    const wip = fakeWip(12000);
    const service = buildYearEndService({ workInProgress: wip.reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    expect(closing.steps.workInProgress).toMatchObject({ status: "not_done", required: true, value: null, basis: null });
    expect(closing.defaultWipBasis).toBe("manufacturing_cost");

    const preview = await service.previewWorkInProgress(closing.id);
    expect(preview).toMatchObject({
      asOf: `${YEAR}-12-31`,
      basis: "manufacturing_cost",
      value: 12000,
      unvaluedCount: 1,
      unvaluedOrders: [{ orderNumber: "TO-2", articleNumber: "A-2", articleName: "Utan pris" }],
      ledgerBalance: 0,
      ledgerExcludingStep: 0,
      difference: 12000,
      unchanged: false,
      live: null,
    });
    expect(preview.rows).toEqual([
      { accountNumber: "1440", accountName: "Produkter i arbete", debit: 12000, credit: 0 },
      { accountNumber: "4940", accountName: "Förändring av produkter i arbete", debit: 0, credit: 12000 },
    ]);

    const result = await service.bookWorkInProgress(closing.id, { basis: "manufacturing_cost" }, user.id);
    expect(result).toMatchObject({ unchanged: false, cancelled: null, value: 12000, difference: 12000 });
    expect(result.verification).toMatchObject({ displayNumber: `BS-${YEAR}-1`, date: `${YEAR}-12-31` });
    expect(await verificationLines(result.verification!.id)).toEqual([
      { account: "1440", debit: 12000, credit: 0 },
      { account: "4940", debit: 0, credit: 12000 },
    ]);
    const [verification] = await db.select().from(verifications).where(eq(verifications.id, result.verification!.id));
    expect(verification!.description).toBe(`Förändring av produkter i arbete bokslut ${YEAR} (Tillverkningskostnad)`);
    expect(wip.calls.at(-1)).toEqual({ asOf: `${YEAR}-12-31`, basis: "manufacturing_cost" });

    const detail = await service.getClosing(closing.id);
    expect(detail.steps.workInProgress).toMatchObject({
      status: "done",
      staleReason: null,
      currentValue: 12000,
      basis: "manufacturing_cost",
      value: 12000,
      ledger: 12000,
      verification: { displayNumber: `BS-${YEAR}-1` },
    });
    expect(detail.closingDateLocked).toBe(true);
    expect(await auditActions()).toContain("wip_booked");
    const [row] = await db.select().from(yearEndClosings).where(eq(yearEndClosings.id, closing.id));
    expect(row).toMatchObject({ wipBasis: "manufacturing_cost", wipValue: "12000.00", wipVerificationId: result.verification!.id });
  });

  it("does nothing on an identical re-run and reverses + rebooks on a change", async () => {
    const { user, yearId } = await setupYearEnd();
    const wip = fakeWip(12000);
    const service = buildYearEndService({ workInProgress: wip.reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const first = await service.bookWorkInProgress(closing.id, { basis: "manufacturing_cost" }, user.id);

    const again = await service.bookWorkInProgress(closing.id, { basis: "manufacturing_cost" }, user.id);
    expect(again.unchanged).toBe(true);
    expect((await service.previewWorkInProgress(closing.id, "manufacturing_cost")).unchanged).toBe(true);
    expect(await countVerifications("BS")).toBe(1);

    wip.state.value = 9000;
    const changed = await service.bookWorkInProgress(closing.id, { basis: "direct" }, user.id);
    expect(changed.cancelled).toMatchObject({ displayNumber: `BS-${YEAR}-2`, date: `${YEAR}-12-31` });
    expect(await verificationLines(changed.cancelled!.id)).toEqual([
      { account: "1440", debit: 0, credit: 12000 },
      { account: "4940", debit: 12000, credit: 0 },
    ]);
    expect(changed).toMatchObject({ value: 9000, difference: 9000, verification: { displayNumber: `BS-${YEAR}-3` } });
    expect(wip.calls.at(-1)).toEqual({ asOf: `${YEAR}-12-31`, basis: "direct" });
    const [verification] = await db.select().from(verifications).where(eq(verifications.id, changed.verification!.id));
    expect(verification!.description).toBe(`Förändring av produkter i arbete bokslut ${YEAR} (Direkta kostnader)`);

    const ownership = await db
      .select({
        verificationId: yearEndClosingVerifications.verificationId,
        step: yearEndClosingVerifications.step,
        role: yearEndClosingVerifications.role,
      })
      .from(yearEndClosingVerifications)
      .innerJoin(verifications, eq(verifications.id, yearEndClosingVerifications.verificationId))
      .orderBy(asc(verifications.verificationNumber));
    expect(ownership).toEqual([
      { verificationId: first.verification!.id, step: "work_in_progress", role: "booking" },
      { verificationId: changed.cancelled!.id, step: "work_in_progress", role: "cancellation" },
      { verificationId: changed.verification!.id, step: "work_in_progress", role: "booking" },
    ]);
    // A guide verification: the generic Omför refuses it.
    await expect(testEconomyService.reverse(first.verification!.id, user.id)).rejects.toBeInstanceOf(YearEndClosingVerificationError);
    expect((await service.getClosing(closing.id)).steps.workInProgress).toMatchObject({ status: "done", basis: "direct", value: 9000 });
  });

  it("defaults the underlag to the previous closed closing's", async () => {
    const { user, yearId } = await setupYearEnd();
    const wip = fakeWip(0);
    const service = buildYearEndService({ workInProgress: wip.reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);

    const previous = await createCalendarYear(PREVIOUS_YEAR);
    await db.update(fiscalYears).set({ status: "closed", closedAt: new Date() }).where(eq(fiscalYears.id, previous.id));
    await db.insert(yearEndClosings).values({
      fiscalYearId: previous.id,
      closingDate: `${PREVIOUS_YEAR}-12-31`,
      status: "closed",
      wipBasis: "direct",
      wipValue: "0",
      wipBookedAt: new Date(),
    });
    expect((await service.getClosing(closing.id)).defaultWipBasis).toBe("direct");
    expect((await service.previewWorkInProgress(closing.id)).basis).toBe("direct");
  });
});

describe("Produkter i arbete — inaktuell", () => {
  it("is stale on the ledger when the PIA account moves after the booking", async () => {
    const { user, yearId } = await setupYearEnd();
    const service = buildYearEndService({ workInProgress: fakeWip(12000).reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await service.bookWorkInProgress(closing.id, { basis: "manufacturing_cost" }, user.id);
    await bookManual(`${YEAR}-12-30`, [{ account: "1440", debit: 500 }, { account: "4940", credit: 500 }], user.id);

    const detail = await service.getClosing(closing.id);
    expect(detail.steps.workInProgress).toMatchObject({ status: "stale", staleReason: "ledger", ledger: 12500, value: 12000 });
    const warning = detail.checks.warnings.find((w) => w.code === "wip-stale");
    expect(warning?.message).toMatch(/^PIA-kontots saldo/);

    const rerun = await service.bookWorkInProgress(closing.id, { basis: "manufacturing_cost" }, user.id);
    expect(rerun.difference).toBe(11500); // 12 000 − the 500 booked by hand (the ledger without the step's own booking)
    expect((await service.getClosing(closing.id)).steps.workInProgress.status).toBe("done");
  });

  it("is stale on the valuation when the PIA per the closing date changes", async () => {
    const { user, yearId } = await setupYearEnd();
    const wip = fakeWip(12000);
    const service = buildYearEndService({ workInProgress: wip.reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await service.bookWorkInProgress(closing.id, { basis: "direct" }, user.id);

    // Time reported afterwards for a day before the closing date.
    wip.state.value = 12800;
    const detail = await service.getClosing(closing.id);
    expect(detail.steps.workInProgress).toMatchObject({ status: "stale", staleReason: "valuation", value: 12000, currentValue: 12800 });
    expect(wip.calls.at(-1)).toEqual({ asOf: `${YEAR}-12-31`, basis: "direct" });
    const warning = detail.checks.warnings.find((w) => w.code === "wip-stale");
    expect(warning?.message).toMatch(/^Produkter i arbete per bokslutsdagen är nu/);
  });
});

describe("Produkter i arbete — the gate", () => {
  it("blocks the result transfer and the close only when there is something", async () => {
    const { user } = await setupUserAndAccounts();
    const wip = fakeWip(0);
    const service = buildYearEndService({ workInProgress: wip.reader });
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 10000, cost: 4000 });
    // Nothing in progress, nothing on 1440: the step is not asked for.
    const quiet = await service.getClosing(closingId);
    expect(quiet.steps.workInProgress).toMatchObject({ status: "not_done", required: false });
    expect(quiet.checks.closeBlockers.map((b) => b.code)).not.toContain("wip-not-done");

    wip.state.value = 5000;
    const blocked = await service.getClosing(closingId);
    expect(blocked.steps.workInProgress.required).toBe(true);
    expect(blocked.checks.closeBlockers.map((b) => b.code)).toContain("wip-not-done");
    await expect(service.bookResultTransfer(closingId, user.id)).rejects.toBeInstanceOf(YearEndStepOrderError);
    await expect(service.closeYear(closingId, user.id)).rejects.toThrow(/Produkter i arbete/);

    await service.bookWorkInProgress(closingId, { basis: "manufacturing_cost" }, user.id);
    const transfer = await service.bookResultTransfer(closingId, user.id);
    // 10 000 − 4 000 + the PIA's 5 000 on 4940.
    expect(transfer.net).toBe(11000);
    const closed = await service.closeYear(closingId, user.id);
    expect(closed.status).toBe("closed");
  });

  it("asks for the step when only the PIA account has a balance", async () => {
    const { user } = await setupUserAndAccounts();
    const service = buildYearEndService({ workInProgress: fakeWip(0).reader });
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 0, cost: 0 });
    await bookManual(`${YEAR}-03-31`, [{ account: "1440", debit: 700 }, { account: "1930", credit: 700 }], user.id);

    const detail = await service.getClosing(closingId);
    expect(detail.checks.closeBlockers.map((b) => b.code)).toContain("wip-not-done");
    await expect(service.bookResultTransfer(closingId, user.id)).rejects.toBeInstanceOf(YearEndStepOrderError);
    // Booking 0 against the 700 clears the account.
    const result = await service.bookWorkInProgress(closingId, { basis: "manufacturing_cost" }, user.id);
    expect(await verificationLines(result.verification!.id)).toEqual([
      { account: "1440", debit: 0, credit: 700 },
      { account: "4940", debit: 700, credit: 0 },
    ]);
  });

  it("does not re-value a closed year", async () => {
    const { user } = await setupUserAndAccounts();
    const wip = fakeWip(5000);
    const service = buildYearEndService({ workInProgress: wip.reader });
    const { closingId } = await prepareClosableYear(service, user.id, { revenue: 10000, cost: 4000 });
    await service.bookWorkInProgress(closingId, { basis: "manufacturing_cost" }, user.id);
    await service.bookResultTransfer(closingId, user.id);
    await service.closeYear(closingId, user.id);

    const callsBefore = wip.calls.length;
    wip.state.value = 9999;
    const detail = await service.getClosing(closingId);
    expect(wip.calls.length).toBe(callsBefore);
    expect(detail.steps.workInProgress).toMatchObject({ status: "done", value: 5000, currentValue: null });
    expect(detail.history.map((row) => [row.step, row.role])).toContainEqual(["work_in_progress", "booking"]);
  });
});

describe("Produkter i arbete — accounts", () => {
  // A company without manufacturing: no PIA, no 1440/4940 to book on.
  it("completes with nothing to book without the PIA accounts", async () => {
    const { user, yearId } = await setupYearEnd();
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "1440"));
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "4940"));
    const service = buildYearEndService({ workInProgress: fakeWip(0).reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    expect(closing.steps.workInProgress.required).toBe(false);

    expect(await service.previewWorkInProgress(closing.id)).toMatchObject({ value: 0, difference: 0, rows: [] });
    const result = await service.bookWorkInProgress(closing.id, { basis: "manufacturing_cost" }, user.id);
    expect(result).toMatchObject({ unchanged: false, verification: null, difference: 0 });
    expect((await service.getClosing(closing.id)).steps.workInProgress).toMatchObject({ status: "done", value: 0, verification: null });
    expect(await countVerifications("BS")).toBe(0);
  });

  it("still requires the PIA accounts when there is something to book", async () => {
    const { user, yearId } = await setupYearEnd();
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "4940"));
    const service = buildYearEndService({ workInProgress: fakeWip(1000).reader });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await expect(service.bookWorkInProgress(closing.id, { basis: "direct" }, user.id)).rejects.toBeInstanceOf(MissingPostingAccountError);
  });

  it.each([
    ["the PIA account is its change account", { postingWipChange: "1440" }],
    ["the PIA account is the inventory account", { postingWip: "1460" }],
    ["the PIA account is the inventory change account", { postingWip: "4990" }],
    ["the PIA change account is the inventory account", { postingWipChange: "1460" }],
  ])("409s when %s, even with nothing to value", async (_label, override) => {
    const { user, yearId } = await setupYearEnd();
    const service = buildYearEndService({
      workInProgress: fakeWip(0).reader,
      settings: { read: async () => ({ ...DEFAULT_POSTING_SETTINGS, ...override }) },
    });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    await expect(service.previewWorkInProgress(closing.id)).rejects.toBeInstanceOf(WorkInProgressAccountConflictError);
    await expect(service.bookWorkInProgress(closing.id, { basis: "direct" }, user.id)).rejects.toBeInstanceOf(WorkInProgressAccountConflictError);
  });

  it("lets the PIA change account be the inventory change account", async () => {
    const { user, yearId } = await setupYearEnd();
    const service = buildYearEndService({
      workInProgress: fakeWip(300).reader,
      settings: { read: async () => ({ ...DEFAULT_POSTING_SETTINGS, postingWipChange: "4990" }) },
    });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const result = await service.bookWorkInProgress(closing.id, { basis: "direct" }, user.id);
    expect(await verificationLines(result.verification!.id)).toEqual([
      { account: "1440", debit: 300, credit: 0 },
      { account: "4990", debit: 0, credit: 300 },
    ]);
  });
});

describe("Produkter i arbete — routes", () => {
  it("previews, books, 400s an unknown underlag and 409s the account conflict", async () => {
    const { user, yearId } = await setupYearEnd();
    const app = buildYearEndApp(user.id, { service: buildYearEndService({ workInProgress: fakeWip(2500).reader }) });
    const conflicting = buildYearEndApp(user.id, {
      service: buildYearEndService({
        workInProgress: fakeWip(2500).reader,
        settings: { read: async () => ({ ...DEFAULT_POSTING_SETTINGS, postingWip: "1460" }) },
      }),
    });
    try {
      const started = await app.inject({ method: "POST", url: "/year-end-closings", payload: { fiscalYearId: yearId } });
      const id = started.json().id as string;

      const preview = await app.inject({ url: `/year-end-closings/${id}/work-in-progress-preview?basis=direct` });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ basis: "direct", value: 2500, difference: 2500 });
      expect((await app.inject({ url: `/year-end-closings/${id}/work-in-progress-preview?basis=full` })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: `/year-end-closings/${id}/work-in-progress`, payload: {} })).statusCode).toBe(400);

      const conflict = await conflicting.inject({ url: `/year-end-closings/${id}/work-in-progress-preview` });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().code).toBe("work-in-progress-account-conflict");

      // The result transfer's 409 names the step it waits for.
      const order = await app.inject({ method: "POST", url: `/year-end-closings/${id}/result-transfer` });
      expect(order.statusCode).toBe(409);
      expect(order.json()).toMatchObject({ code: "year-end-step-order", step: "Lagerförändring" });

      const booked = await app.inject({ method: "POST", url: `/year-end-closings/${id}/work-in-progress`, payload: { basis: "direct" } });
      expect(booked.statusCode).toBe(200);
      expect(booked.json()).toMatchObject({ unchanged: false, value: 2500, verification: { displayNumber: `BS-${YEAR}-1` } });
    } finally {
      await app.close();
      await conflicting.close();
    }
  });
});
