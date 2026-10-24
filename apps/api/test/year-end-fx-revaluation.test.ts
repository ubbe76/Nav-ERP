import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customers, db, fiscalYears, verifications, yearEndClosings } from "@navet/db";
import { readAccountBalances } from "../src/modules/economy/service/account-balances.js";
import { formatNumber } from "../src/modules/mail/service/document-pdf.js";
import { YearEndClosingVerificationError } from "../src/modules/economy/service/economy.service.js";
import { readVatAccountMovements } from "../src/modules/economy/service/vat-account-movements.js";
import {
  ClosingDateLockedError,
  FxRevaluationRateMissingError,
  YearEndBlockedError,
  YearEndClosingClosedError,
  YearEndStepOrderError,
} from "../src/modules/economy/service/year-end-closing.service.js";
import { payablesTotalAsOf } from "../src/modules/purchase/repository/open-amounts.js";
import { receivablesTotalAsOf } from "../src/modules/sales/repository/open-amounts.js";
import { testEconomyService } from "./helpers/services.js";
import {
  NEXT_YEAR,
  YEAR,
  bookManual,
  buildYearEndService,
  countVerifications,
  expectConstraint,
  prepareClosableYear,
  resetYearEnd,
  setupUserAndAccounts,
  setupYearEnd,
  verificationLines,
} from "./helpers/year-end.js";
import {
  asOf,
  attestedEurInvoice,
  eurSupplier,
  fxInvoiceService as invoiceService,
  fxPaymentService as paymentService,
  fxSupplierPaymentService as supplierPaymentService,
  issuedEurCredit,
  issuedEurInvoice,
  openEurItems as openItems,
  stubExchangeRates,
} from "./helpers/year-end-fx.js";

// Valuta steg 4: valutaomvärderingen i årsbokslutet, end to end — real EUR
// invoices (Utfärda and attest through their own services, booked in the
// closing year), the step's pair V/R, the payments the year after and the
// reconciliation. The rate lookup is a stub: the suite never calls
// Riksbanken.

const { rates: stubRates, lookups, reader } = stubExchangeRates();
const service = buildYearEndService({ exchangeRates: reader });
const CLOSING = `${YEAR}-12-31`;
const openEurItems = () => openItems(service);

beforeEach(async () => {
  await resetYearEnd();
  stubRates.clear();
  lookups.length = 0;
});
afterAll(resetYearEnd);

async function netOn(account: string, from: string | null, to: string) {
  const balance = (await readAccountBalances(db, { from, to })).find((row) => row.accountNumber === account);
  return balance ? Math.round((balance.periodDebit - balance.periodCredit) * 100) / 100 : 0;
}

describe("valutaomvärdering — förhandsvisningen", () => {
  it("shows per currency and side the rate, the open and booked amounts and the difference", async () => {
    const { closing } = await openEurItems();
    stubRates.set("EUR", 11.5);
    const step = (await service.getClosing(closing.id)).steps.fxRevaluation;
    expect(step).toMatchObject({ status: "not_done", required: true, verification: null, reversalVerification: null, bookedRates: null });
    expect(step.preview).toMatchObject({
      asOf: CLOSING,
      rates: [{ currency: "EUR", rate: 11.5, date: CLOSING, source: "riksbank", fromBooking: false }],
      missingCurrencies: [],
      receivable: {
        accountNumber: "1510",
        invoiceCount: 1,
        bookedSek: 11000,
        revaluedSek: 11500,
        difference: 500,
        currencies: [{ currency: "EUR", rate: 11.5, invoiceCount: 1, openAmount: 1000, bookedSek: 11000, revaluedSek: 11500, difference: 500 }],
      },
      payable: {
        accountNumber: "2440",
        invoiceCount: 1,
        bookedSek: 5500,
        revaluedSek: 5750,
        difference: 250,
        currencies: [{ currency: "EUR", rate: 11.5, invoiceCount: 1, openAmount: 500, bookedSek: 5500, revaluedSek: 5750, difference: 250 }],
      },
      resultEffect: 250,
      unchanged: false,
    });
    expect(step.preview.rows).toEqual([
      { accountNumber: "1510", accountName: "Kundfordringar", debit: 500, credit: 0 },
      { accountNumber: "2440", accountName: "Leverantörsskulder", debit: 0, credit: 250 },
      { accountNumber: "3960", accountName: expect.any(String), debit: 0, credit: 500 },
      { accountNumber: "7960", accountName: expect.any(String), debit: 250, credit: 0 },
    ]);
    // Every lookup is the closing date's rate (startClosing's detail too).
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((l) => l.currency === "EUR" && l.date === CLOSING)).toBe(true);
    // The close waits for the step; the transfer refuses to run before it.
    expect((await service.getClosing(closing.id)).checks.closeBlockers.map((c) => c.code)).toContain("fx-revaluation-not-done");
  });

  it("previews typed rates, lists every invoice and names a currency without a rate", async () => {
    const { closing, invoice } = await openEurItems();
    const missing = await service.getClosing(closing.id);
    expect(missing.steps.fxRevaluation.preview).toMatchObject({
      rates: [{ currency: "EUR", rate: null, date: null, source: null, fromBooking: false }],
      missingCurrencies: ["EUR"],
      resultEffect: null,
      rows: [],
    });
    const lookupsBefore = lookups.length;
    const typed = await service.previewFxRevaluation(closing.id, { EUR: 10.5 });
    expect(typed.rates).toEqual([{ currency: "EUR", rate: 10.5, date: null, source: "step", fromBooking: false }]);
    expect(typed.receivable.difference).toBe(-500);
    expect(typed.payable.difference).toBe(-250);
    expect(typed.invoices).toEqual([
      expect.objectContaining({ side: "receivable", id: invoice.id, number: invoice.invoiceNumber, partnerName: "Kunde GmbH", currency: "EUR", exchangeRate: 11, openAmount: 1000, bookedSek: 11000, rate: 10.5, revaluedSek: 10500, difference: -500 }),
      expect.objectContaining({ side: "payable", partnerName: "Lieferant GmbH", openAmount: 500, bookedSek: 5500, rate: 10.5, revaluedSek: 5250, difference: -250 }),
    ]);
    // A typed rate is never looked up.
    expect(lookups.length).toBe(lookupsBefore);
  });

  it("says there is nothing to revalue for SEK-only reskontror, and the step can be marked done", async () => {
    const { user, yearId } = await setupYearEnd();
    const [sekCustomer] = await db.insert(customers).values({ name: "Svensk AB", customerNumber: `FX-${crypto.randomUUID()}`, active: true }).returning();
    await asOf(`${YEAR}-11-15`, async () => {
      const draft = await invoiceService.create({ customerId: sekCustomer!.id, rows: [{ description: "Leverans", quantity: 1, unitPrice: 800, vatRate: 25 }] }, user.id);
      return invoiceService.issue(draft!.id, user.id);
    });
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const before = (await service.getClosing(closing.id)).steps.fxRevaluation;
    expect(before).toMatchObject({ status: "not_done", required: false });
    expect(before.preview).toMatchObject({ rates: [], missingCurrencies: [], resultEffect: 0, rows: [] });
    expect(before.preview.receivable.currencies).toEqual([]);
    expect((await service.getClosing(closing.id)).checks.closeBlockers.map((c) => c.code)).not.toContain("fx-revaluation-not-done");

    const done = await service.bookFxRevaluation(closing.id, { rates: {} }, user.id);
    expect(done).toMatchObject({ unchanged: false, verification: null, reversalVerification: null, cancelled: [], nextFiscalYearCreated: false, rates: [] });
    const [row] = await db.select().from(yearEndClosings).where(eq(yearEndClosings.id, closing.id));
    expect(row!.fxBookedAt).not.toBeNull();
    expect(row!.fxRates).toEqual([]);
    expect((await service.getClosing(closing.id)).steps.fxRevaluation.status).toBe("done");
    expect(await db.select().from(fiscalYears)).toHaveLength(1);
    expect(lookups).toEqual([]);
    expect((await service.bookFxRevaluation(closing.id, { rates: {} }, user.id)).unchanged).toBe(true);
  });
});

describe("valutaomvärdering — bokföringen", () => {
  it("books receivables/payables against kursvinst/kursförlust on the closing date and reverses it on the next year's first day", async () => {
    const { user, closing } = await openEurItems();
    stubRates.set("EUR", 11.5);
    const result = await service.bookFxRevaluation(closing.id, { rates: {} }, user.id);

    expect(result).toMatchObject({ unchanged: false, nextFiscalYearCreated: true, cancelled: [] });
    expect(result.rates).toEqual([{ currency: "EUR", rate: 11.5, date: CLOSING, source: "riksbank" }]);
    expect(result.revaluation).toMatchObject({ receivable: { difference: 500 }, payable: { difference: 250 }, resultEffect: 250 });
    expect(result.verification).toMatchObject({ displayNumber: `BS-${YEAR}-1`, date: CLOSING });
    expect(result.reversalVerification).toMatchObject({ displayNumber: `BS-${NEXT_YEAR}-1`, date: `${NEXT_YEAR}-01-01` });
    expect(await verificationLines(result.verification!.id)).toEqual([
      { account: "1510", debit: 500, credit: 0 },
      { account: "2440", debit: 0, credit: 250 },
      { account: "3960", debit: 0, credit: 500 },
      { account: "7960", debit: 250, credit: 0 },
    ]);
    expect(await verificationLines(result.reversalVerification!.id)).toEqual([
      { account: "1510", debit: 0, credit: 500 },
      { account: "2440", debit: 250, credit: 0 },
      { account: "3960", debit: 500, credit: 0 },
      { account: "7960", debit: 0, credit: 250 },
    ]);
    const [v] = await db.select().from(verifications).where(eq(verifications.id, result.verification!.id));
    expect(v!.description).toBe(`Valutaomvärdering bokslut ${YEAR} (EUR 11,500000)`);
    // R is an ordinary booking in the next year, not an omföring of V.
    const [r] = await db.select().from(verifications).where(eq(verifications.id, result.reversalVerification!.id));
    expect(r!.reversesVerificationId).toBeNull();

    const detail = await service.getClosing(closing.id);
    expect(detail.steps.fxRevaluation).toMatchObject({
      status: "done",
      required: true,
      verification: { displayNumber: `BS-${YEAR}-1` },
      reversalVerification: { displayNumber: `BS-${NEXT_YEAR}-1` },
      bookedRates: [{ currency: "EUR", rate: 11.5, date: CLOSING, source: "riksbank" }],
    });
    // The default for a re-run is the booked rate, and nothing would change.
    expect(detail.steps.fxRevaluation.preview.rates).toEqual([{ currency: "EUR", rate: 11.5, date: CLOSING, source: "riksbank", fromBooking: true }]);
    expect(detail.steps.fxRevaluation.preview.unchanged).toBe(true);
    expect(detail.history.map((row) => [row.verification.displayNumber, row.step, row.role])).toEqual([
      [`BS-${YEAR}-1`, "fx_revaluation", "booking"],
      [`BS-${NEXT_YEAR}-1`, "fx_revaluation", "fx_reversal"],
    ]);
    expect(detail.checks.closeBlockers.map((c) => c.code)).not.toContain("fx-revaluation-not-done");

    // Steg 6: the ledger = the reskontra + the revaluation, per the year's end.
    expect(await netOn("1510", null, CLOSING)).toBe(11500);
    expect(await receivablesTotalAsOf(db, CLOSING)).toBe(11000);
    expect(await netOn("2440", null, CLOSING)).toBe(-5750);
    expect(await payablesTotalAsOf(db, CLOSING)).toBe(5500);
    const codes = detail.checks.warnings.map((w) => w.code);
    expect(codes).not.toContain("receivables-mismatch");
    expect(codes).not.toContain("payables-mismatch");
    expect(codes).not.toContain("fx-revaluation-stale");
  });

  it("gives the right total exchange difference over both years when the invoices are paid the year after", async () => {
    const { user, closing, customer, supplier, invoice, supplierInvoice } = await openEurItems();
    stubRates.set("EUR", 11.5);
    await service.bookFxRevaluation(closing.id, { rates: {} }, user.id);

    // Paid in the next year at 11,30 (customer) and 11,20 (supplier) — the
    // payments' own kursdifferens is against the INVOICE's rate (11,00).
    await paymentService.create(
      { customerId: customer.id, paymentDate: `${NEXT_YEAR}-02-10`, bankAccountNumber: "1930", amount: 1000, amountSek: 11300, rows: [{ invoiceId: invoice.id, appliedAmount: 1000 }] },
      user.id
    );
    await supplierPaymentService.create(
      { supplierId: supplier.id, paymentDate: `${NEXT_YEAR}-02-12`, bankAccountNumber: "1930", amount: 500, amountSek: 5600, rows: [{ supplierInvoiceId: supplierInvoice.id, appliedAmount: 500 }] },
      user.id
    );

    const yearOne = { gain: await netOn("3960", `${YEAR}-01-01`, `${YEAR}-12-31`), loss: await netOn("7960", `${YEAR}-01-01`, `${YEAR}-12-31`) };
    const yearTwo = {
      gain: await netOn("3960", `${NEXT_YEAR}-01-01`, `${NEXT_YEAR}-12-31`),
      loss: await netOn("7960", `${NEXT_YEAR}-01-01`, `${NEXT_YEAR}-12-31`),
    };
    // Year 1: the revaluation (+500 receivable, −250 payable).
    expect(yearOne).toEqual({ gain: -500, loss: 250 });
    // Year 2: the reversal (−500/+250) and the payments (+300 gain, −100 loss).
    expect(yearTwo).toEqual({ gain: 500 - 300, loss: -250 + 100 });
    // Over both years: exactly what the bank moved minus what was booked.
    expect(Math.round((yearOne.gain + yearTwo.gain) * 100) / 100).toBe(-(11300 - 11000));
    expect(Math.round((yearOne.loss + yearTwo.loss) * 100) / 100).toBe(5600 - 5500);
    expect(await netOn("1510", null, `${NEXT_YEAR}-12-31`)).toBe(0);
    expect(await netOn("2440", null, `${NEXT_YEAR}-12-31`)).toBe(0);
  });

  it("re-runs with a changed rate by cancelling the pair and booking a new one; an identical re-run is unchanged", async () => {
    const { user, closing } = await openEurItems();
    stubRates.set("EUR", 11.5);
    await service.bookFxRevaluation(closing.id, { rates: {} }, user.id);

    // No rates, or the booked rate typed again: nothing changes.
    expect((await service.bookFxRevaluation(closing.id, { rates: {} }, user.id)).unchanged).toBe(true);
    expect((await service.bookFxRevaluation(closing.id, { rates: { EUR: 11.5 } }, user.id)).unchanged).toBe(true);
    expect(await countVerifications("BS")).toBe(2);

    const changed = await service.bookFxRevaluation(closing.id, { rates: { EUR: 11.4 } }, user.id);
    expect(changed.unchanged).toBe(false);
    expect(changed.cancelled.map((ref) => [ref.displayNumber, ref.date])).toEqual([
      [`BS-${YEAR}-2`, CLOSING],
      [`BS-${NEXT_YEAR}-2`, `${NEXT_YEAR}-01-01`],
    ]);
    expect(changed.verification!.displayNumber).toBe(`BS-${YEAR}-3`);
    expect(changed.reversalVerification!.displayNumber).toBe(`BS-${NEXT_YEAR}-3`);
    expect(changed.rates).toEqual([{ currency: "EUR", rate: 11.4, date: null, source: "step" }]);
    expect(await verificationLines(changed.verification!.id)).toEqual([
      { account: "1510", debit: 400, credit: 0 },
      { account: "2440", debit: 0, credit: 200 },
      { account: "3960", debit: 0, credit: 400 },
      { account: "7960", debit: 200, credit: 0 },
    ]);
    // Net effect per year = exactly the live pair.
    expect(await netOn("1510", `${YEAR}-01-01`, `${YEAR}-12-31`)).toBe(11400);
    expect(await netOn("1510", `${NEXT_YEAR}-01-01`, `${NEXT_YEAR}-12-31`)).toBe(-400);
    expect(await netOn("3960", `${YEAR}-01-01`, `${NEXT_YEAR}-12-31`)).toBe(0);

    // The typed rate is the step's default from now on, and is kept.
    const detail = await service.getClosing(closing.id);
    expect(detail.steps.fxRevaluation.preview.rates).toEqual([{ currency: "EUR", rate: 11.4, date: null, source: "step", fromBooking: true }]);
    expect((await service.bookFxRevaluation(closing.id, { rates: {} }, user.id)).unchanged).toBe(true);
    expect(detail.history.map((row) => [row.verification.displayNumber, row.step, row.role])).toEqual([
      [`BS-${YEAR}-1`, "fx_revaluation", "booking"],
      [`BS-${YEAR}-2`, "fx_revaluation", "cancellation"],
      [`BS-${YEAR}-3`, "fx_revaluation", "booking"],
      [`BS-${NEXT_YEAR}-1`, "fx_revaluation", "fx_reversal"],
      [`BS-${NEXT_YEAR}-2`, "fx_revaluation", "cancellation"],
      [`BS-${NEXT_YEAR}-3`, "fx_revaluation", "fx_reversal"],
    ]);
  });

  it("409s fx-revaluation-rate-missing without a trace, then books with the rate typed in", async () => {
    const { user, closing } = await openEurItems();
    const error = await service.bookFxRevaluation(closing.id, { rates: {} }, user.id).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(FxRevaluationRateMissingError);
    expect(error).toMatchObject({ currencies: ["EUR"], date: CLOSING });
    expect(await countVerifications("BS")).toBe(0);
    expect(await db.select().from(fiscalYears)).toHaveLength(1);
    const [row] = await db.select().from(yearEndClosings).where(eq(yearEndClosings.id, closing.id));
    expect(row!.fxBookedAt).toBeNull();

    const typed = await service.bookFxRevaluation(closing.id, { rates: { EUR: 10.5 } }, user.id);
    // A weaker EUR: the receivable loses 500, the debt shrinks by 250.
    expect(await verificationLines(typed.verification!.id)).toEqual([
      { account: "1510", debit: 0, credit: 500 },
      { account: "2440", debit: 250, credit: 0 },
      { account: "3960", debit: 0, credit: 250 },
      { account: "7960", debit: 500, credit: 0 },
    ]);
  });

  it("revalues a partly paid invoice and an open credit note, and goes stale when the items change", async () => {
    const { user, closing, customer, invoice } = await openEurItems();
    // Partly paid in the year: 400 EUR at 11,20 releases 4 400,00 SEK.
    await paymentService.create(
      { customerId: customer.id, paymentDate: `${YEAR}-12-05`, bankAccountNumber: "1930", amount: 400, amountSek: 4480, rows: [{ invoiceId: invoice.id, appliedAmount: 400 }] },
      user.id
    );
    stubRates.set("EUR", 11.5);
    const first = await service.bookFxRevaluation(closing.id, { rates: {} }, user.id);
    // 600 EUR left, 6 600,00 SEK booked ⇒ 6 900,00: +300; the payable +250.
    expect(first.revaluation.receivable.difference).toBe(300);
    expect((await service.getClosing(closing.id)).steps.fxRevaluation.status).toBe("done");

    // A new EUR invoice in the year (200 EUR at 11,20 = 2 240,00) changes
    // the open items: the booking is stale (a warning), and the
    // reconciliation still holds.
    const second = await issuedEurInvoice(customer.id, user.id, 160, 11.2, `${YEAR}-12-10`);
    const stale = await service.getClosing(closing.id);
    expect(stale.steps.fxRevaluation.status).toBe("stale");
    expect(stale.steps.fxRevaluation.preview.unchanged).toBe(false);
    const codes = stale.checks.warnings.map((w) => w.code);
    expect(codes).toContain("fx-revaluation-stale");
    expect(codes).not.toContain("receivables-mismatch");

    const rerun = await service.bookFxRevaluation(closing.id, { rates: {} }, user.id);
    expect(rerun.unchanged).toBe(false);
    expect(rerun.revaluation.receivable.currencies).toEqual([
      { currency: "EUR", rate: 11.5, invoiceCount: 2, openAmount: 800, bookedSek: 8840, revaluedSek: 9200, difference: 360 },
    ]);

    // Its credit note is an open item of −200 EUR (−2 240,00) that revalues
    // the other way: −60, back to +300 on the side.
    await issuedEurCredit(second.id, user.id, `${YEAR}-12-12`);
    expect((await service.getClosing(closing.id)).steps.fxRevaluation.status).toBe("stale");
    const third = await service.bookFxRevaluation(closing.id, { rates: {} }, user.id);
    expect(third.revaluation.receivable.currencies).toEqual([
      { currency: "EUR", rate: 11.5, invoiceCount: 3, openAmount: 600, bookedSek: 6600, revaluedSek: 6900, difference: 300 },
    ]);
    expect(await verificationLines(third.verification!.id)).toEqual([
      { account: "1510", debit: 300, credit: 0 },
      { account: "2440", debit: 0, credit: 250 },
      { account: "3960", debit: 0, credit: 300 },
      { account: "7960", debit: 250, credit: 0 },
    ]);
    const done = await service.getClosing(closing.id);
    expect(done.steps.fxRevaluation.status).toBe("done");
    expect(done.checks.warnings.map((w) => w.code)).not.toContain("receivables-mismatch");
  });
});

describe("valutaomvärdering — spärrarna", () => {
  it("locks the closing date once booked", async () => {
    const { user, closing } = await openEurItems();
    await service.bookFxRevaluation(closing.id, { rates: { EUR: 11.5 } }, user.id);
    expect((await service.getClosing(closing.id)).closingDateLocked).toBe(true);
    await expect(service.updateClosingDate(closing.id, `${YEAR}-12-30`, user.id)).rejects.toBeInstanceOf(ClosingDateLockedError);
  });

  it("must stand before the result transfer when there are foreign items", async () => {
    const { user, closing } = await openEurItems();
    await service.bookInventory(closing.id, { method: "standard" }, user.id);
    await service.bookDepreciation(closing.id, user.id);
    await service.bookAccruals(closing.id, { rows: [] }, user.id);
    await expect(service.bookResultTransfer(closing.id, user.id)).rejects.toBeInstanceOf(YearEndStepOrderError);
    await service.bookFxRevaluation(closing.id, { rates: { EUR: 11.5 } }, user.id);
    expect((await service.bookResultTransfer(closing.id, user.id)).verification).not.toBeNull();
  });

  it("refuses a run on a closed year, and the generic Omför of both verifications", async () => {
    const { user } = await setupUserAndAccounts();
    const { closingId, yearId } = await prepareClosableYear(service, user.id, { revenue: 0, cost: 0 });
    const supplier = await eurSupplier();
    await attestedEurInvoice(supplier.id, user.id, 500, 11);
    const booked = await service.bookFxRevaluation(closingId, { rates: { EUR: 11.5 } }, user.id);
    await service.bookResultTransfer(closingId, user.id);
    await service.closeYear(closingId, user.id);
    const [year] = await db.select().from(fiscalYears).where(eq(fiscalYears.id, yearId));
    expect(year!.status).toBe("closed");

    await expect(service.bookFxRevaluation(closingId, { rates: { EUR: 11.2 } }, user.id)).rejects.toBeInstanceOf(YearEndClosingClosedError);
    await expect(testEconomyService.reverse(booked.verification!.id, user.id)).rejects.toBeInstanceOf(YearEndClosingVerificationError);
    await expect(testEconomyService.reverse(booked.reversalVerification!.id, user.id)).rejects.toBeInstanceOf(YearEndClosingVerificationError);
    const card = await testEconomyService.findVerificationById(booked.reversalVerification!.id);
    expect(card.yearEnd).toMatchObject({ closingId, step: "fx_revaluation", role: "fx_reversal" });
  });

  it("refuses to book when the closing date moved after the rates were looked up", async () => {
    const { user, closing } = await openEurItems();
    // The lookup runs before the transaction; the date moves meanwhile.
    const moving = buildYearEndService({
      exchangeRates: {
        async getRate(currency, date) {
          await service.updateClosingDate(closing.id, `${YEAR}-12-30`, user.id);
          return { currency, requestedDate: date, date, rate: 11.5, source: "riksbank" };
        },
      },
    });
    await expect(moving.bookFxRevaluation(closing.id, { rates: {} }, user.id)).rejects.toBeInstanceOf(YearEndBlockedError);
    expect(await countVerifications("BS")).toBe(0);
  });

  it("stays out of the VAT report", async () => {
    const { user, closing } = await openEurItems();
    const booked = await service.bookFxRevaluation(closing.id, { rates: { EUR: 11.5 } }, user.id);
    // A VAT-free revenue booking on 3960 itself does count.
    await bookManual(CLOSING, [{ account: "1930", debit: 10 }, { account: "3960", credit: 10 }], user.id);
    const movements = await readVatAccountMovements(db, `${YEAR}-12-01`, CLOSING);
    expect(movements.find((row) => row.accountNumber === "3960")).toMatchObject({ credit: 10 });
    expect(movements.find((row) => row.accountNumber === "7960")).toBeUndefined();
    expect(booked.verification).not.toBeNull();
  });

  it("names the revaluation in the reconciliation when the ledger drifts", async () => {
    const { user, closing } = await openEurItems();
    await service.bookFxRevaluation(closing.id, { rates: { EUR: 11.5 } }, user.id);
    await bookManual(`${YEAR}-12-20`, [{ account: "1510", credit: 60 }, { account: "3740", debit: 60 }], user.id);
    const warning = (await service.getClosing(closing.id)).checks.warnings.find((w) => w.code === "receivables-mismatch");
    expect(warning!.message).toContain(`reskontra ${formatNumber(11000)} + valutaomvärdering ${formatNumber(500)}`);
  });
});

describe("migration 0146", () => {
  it("refuses a revaluation without its reversal and a done step without its rates", async () => {
    const { user, yearId } = await setupYearEnd();
    const closing = await service.startClosing({ fiscalYearId: yearId }, user.id);
    const booked = await bookManual(CLOSING, [{ account: "1510", debit: 1 }, { account: "3960", credit: 1 }], user.id);
    await expectConstraint(
      db.update(yearEndClosings).set({ fxVerificationId: booked.id, fxBookedAt: new Date(), fxRates: [] }).where(eq(yearEndClosings.id, closing.id)),
      "year_end_fx_pair"
    );
    await expectConstraint(db.update(yearEndClosings).set({ fxBookedAt: new Date() }).where(eq(yearEndClosings.id, closing.id)), "year_end_fx_rates_booked");
  });
});
