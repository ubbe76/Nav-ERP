import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, vatCodes, vatSettlements, verifications } from "@navet/db";
import { round2 } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { AccountingPeriodLockedError } from "../src/modules/economy/service/accounting-period-lock.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { ZeroAmountPostingError, createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import {
  VatAccountsNotDistinctError,
  VatPeriodAlreadySettledError,
  VatPeriodNotCoveredError,
  createVatReportService,
} from "../src/modules/economy/service/vat-report.service.js";

import { postingVatCode, resetVatCodes } from "./helpers/vat-codes.js";

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
const service = createEconomyService(repo, { log: async () => {} });

const TRUNCATE = sql`TRUNCATE vat_settlements, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;

// Same live-copy idiom as verification-poster.test.ts: tests mutate
// postingSettings to redirect a role, beforeEach restores it.
const DEFAULT_POSTING_SETTINGS = {
  postingAccountsReceivable: "1510",
  postingAccountsPayable: "2440",
  postingDefaultCost: "4010",
  postingBank: "1930",
  postingReminderFeeAccount: "3540",
  postingPaymentWriteOff: "3740",
  postingVatSettlement: "2650",
};
let postingSettings = { ...DEFAULT_POSTING_SETTINGS };
const settingsReader = { read: async () => postingSettings };
const poster = createVerificationPoster(settingsReader);
const vatReport = createVatReportService({ db, poster, settings: settingsReader });

beforeEach(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
  postingSettings = { ...DEFAULT_POSTING_SETTINGS };
});

afterAll(async () => {
  await db.execute(TRUNCATE);
  await resetVatCodes();
});

const CURRENT_YEAR = new Date().getFullYear();
const JAN = { from: `${CURRENT_YEAR}-01-01`, to: `${CURRENT_YEAR}-01-31` };
const FEB = { from: `${CURRENT_YEAR}-02-01`, to: `${CURRENT_YEAR}-02-28` };
const MAR = { from: `${CURRENT_YEAR}-03-01`, to: `${CURRENT_YEAR}-03-31` };
const Q1 = { from: `${CURRENT_YEAR}-01-01`, to: `${CURRENT_YEAR}-03-31` };

async function setupEconomy() {
  const user = await authRepo.create({
    email: `vat-report-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomiadmin",
    role: "admin",
  });
  await service.createFiscalYear({
    label: String(CURRENT_YEAR),
    startDate: `${CURRENT_YEAR}-01-01`,
    endDate: `${CURRENT_YEAR}-12-31`,
  });
  await service.createSeries({ code: "A", name: "Manuella verifikat" });
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  return { user };
}

async function accountId(number: string) {
  const account = await repo.findAccountByNumber(number);
  return account!.id;
}

// Books a balanced manual verification from (accountNumber, net) pairs where
// positive = debit, negative = credit — the suite's generalized bookEntry.
async function bookManual(userId: string, date: string, entries: [string, number][], description = "Momstestpost") {
  const series = await repo.findSeriesByCode("A");
  const rows = await Promise.all(
    entries.map(async ([number, net]) => ({
      accountId: await accountId(number),
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    }))
  );
  const draft = await service.createVerification({ seriesId: series!.id, date, description, rows }, userId);
  return service.book(draft.id, userId);
}

// A typical domestic sale: AR gross debit, revenue + outgoing VAT credited.
async function bookSale(userId: string, date: string, net: number, vatAccount: string, vatRate: number, revenueAccount = "3001") {
  const vat = round2(net * (vatRate / 100));
  await bookManual(userId, date, [
    ["1510", net + vat],
    [revenueAccount, -net],
    ...(vat !== 0 ? ([[vatAccount, -vat]] as [string, number][]) : []),
  ]);
}

// A typical purchase: cost + incoming VAT debited, AP credited.
async function bookPurchase(userId: string, date: string, net: number, vat: number) {
  await bookManual(userId, date, [
    ["4010", net],
    ["2640", vat],
    ["2440", -(net + vat)],
  ]);
}

describe("vat report — period coverage validation", () => {
  it("rejects a from date that is not a period start", async () => {
    await setupEconomy();
    await expect(vatReport.getReport({ from: `${CURRENT_YEAR}-03-15`, to: MAR.to })).rejects.toBeInstanceOf(
      VatPeriodNotCoveredError
    );
  });

  it("rejects a to date that is not a period end", async () => {
    await setupEconomy();
    await expect(vatReport.getReport({ from: MAR.from, to: `${CURRENT_YEAR}-03-30` })).rejects.toBeInstanceOf(
      VatPeriodNotCoveredError
    );
  });

  it("rejects a range with no accounting periods at all", async () => {
    await setupEconomy();
    await expect(
      vatReport.getReport({ from: `${CURRENT_YEAR + 2}-01-01`, to: `${CURRENT_YEAR + 2}-01-31` })
    ).rejects.toBeInstanceOf(VatPeriodNotCoveredError);
  });

  it("rejects a range with a gap between covered periods", async () => {
    await setupEconomy();
    // Second fiscal year two years out — the year in between has no periods.
    await service.createFiscalYear({
      label: String(CURRENT_YEAR + 2),
      startDate: `${CURRENT_YEAR + 2}-01-01`,
      endDate: `${CURRENT_YEAR + 2}-12-31`,
    });
    await expect(
      vatReport.getReport({ from: `${CURRENT_YEAR}-12-01`, to: `${CURRENT_YEAR + 2}-01-31` })
    ).rejects.toBeInstanceOf(VatPeriodNotCoveredError);
  });

  it("accepts a single month and returns its period with lock status", async () => {
    const { user } = await setupEconomy();
    const period = await repo.findPeriodForDate(MAR.from);
    await service.lockPeriod(period!.id, user.id);

    const report = await vatReport.getReport(MAR);
    expect(report.from).toBe(MAR.from);
    expect(report.to).toBe(MAR.to);
    expect(report.periods).toHaveLength(1);
    expect(report.periods[0]).toMatchObject({ startDate: MAR.from, endDate: MAR.to, status: "locked" });
  });
});

describe("vat report — box computation", () => {
  it("derives rutorna 05/10/11/12/48/49 from booked rows on the configured accounts", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-03-05`, 1000, "2610", 25, "3001");
    await bookSale(user.id, `${CURRENT_YEAR}-03-10`, 500, "2620", 12, "3002");
    await bookSale(user.id, `${CURRENT_YEAR}-03-15`, 200, "2630", 6, "3003");
    await bookPurchase(user.id, `${CURRENT_YEAR}-03-20`, 400, 100);

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["05"]).toBe(1700);
    expect(report.boxes["10"]).toBe(250);
    expect(report.boxes["11"]).toBe(60);
    expect(report.boxes["12"]).toBe(12);
    expect(report.boxes["48"]).toBe(100);
    expect(report.boxes["49"]).toBe(round2(250 + 60 + 12 - 100));
  });

  it("counts rows on the range's boundary dates (inclusive at both ends)", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, MAR.from, 100, "2610", 25);
    await bookSale(user.id, MAR.to, 100, "2610", 25);
    // Outside on both sides.
    await bookSale(user.id, `${CURRENT_YEAR}-02-28`, 100, "2610", 25);
    await bookSale(user.id, `${CURRENT_YEAR}-04-01`, 100, "2610", 25);

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["10"]).toBe(50);
    expect(report.boxes["05"]).toBe(200);
  });

  it("splits momsfri/EU/export sales out of ruta 05 into rutorna 42/35/36", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-03-05`, 1000, "2610", 25, "3001");
    await bookManual(user.id, `${CURRENT_YEAR}-03-06`, [
      ["1510", 300],
      ["3004", -300],
    ]);
    await bookManual(user.id, `${CURRENT_YEAR}-03-07`, [
      ["1510", 400],
      ["3108", -400],
    ]);
    await bookManual(user.id, `${CURRENT_YEAR}-03-08`, [
      ["1510", 500],
      ["3105", -500],
    ]);

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["05"]).toBe(1000);
    expect(report.boxes["42"]).toBe(300);
    expect(report.boxes["35"]).toBe(400);
    expect(report.boxes["36"]).toBe(500);
  });

  it("ruta 05 is account-based: a box-tagged account counts, an unclassified one is a warning, 'none' is silent", async () => {
    const { user } = await setupEconomy();
    await service.createAccount({ number: "3010", name: "Försäljning övrigt", vatBox: "05" });
    await bookManual(user.id, `${CURRENT_YEAR}-03-05`, [
      ["1510", 250],
      ["3010", -200],
      ["2610", -50],
    ]);
    // Reminder fees and öres-/kronutjämning are seeded with "Ingen ruta".
    await bookManual(user.id, `${CURRENT_YEAR}-03-06`, [
      ["1510", 60],
      ["3540", -60],
    ]);
    await bookManual(user.id, `${CURRENT_YEAR}-03-07`, [
      ["1510", 2],
      ["3740", -2],
    ]);
    // Not in BAS, created without a box: left out of every box AND reported.
    await service.createAccount({ number: "3911", name: "Hyresintäkter" });
    await bookManual(user.id, `${CURRENT_YEAR}-03-08`, [
      ["1930", 800],
      ["3911", -800],
    ]);

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["05"]).toBe(200);
    expect(report.warnings.unassignedAccounts).toEqual([{ accountNumber: "3911", accountName: "Hyresintäkter", net: 800 }]);
    expect(report.warnings.vatCodeBoxMismatches).toEqual([]);
    expect(report.warnings.ruleBoxMismatches).toEqual([]);
  });

  it("draft verifications never count", async () => {
    const { user } = await setupEconomy();
    const series = await repo.findSeriesByCode("A");
    await service.createVerification(
      {
        seriesId: series!.id,
        date: `${CURRENT_YEAR}-03-05`,
        description: "Utkast",
        rows: [
          { accountId: await accountId("1510"), debit: 125, credit: 0 },
          { accountId: await accountId("2610"), debit: 0, credit: 25 },
          { accountId: await accountId("3001"), debit: 0, credit: 100 },
        ],
      },
      user.id
    );

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["10"]).toBe(0);
    expect(report.boxes["05"]).toBe(0);
  });

  it("a credit invoice posted through the real poster mirrors out of the boxes", async () => {
    const { user } = await setupEconomy();
    const mp25 = await postingVatCode("MP25");
    await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        { invoiceNumber: "FA-1", type: "invoice", invoiceDate: `${CURRENT_YEAR}-03-05`, customerName: "Kund AB" },
        [{ articleGroupId: null, lineAmount: 1000, vatAmount: 250, vatRate: 25, vatCode: mp25 }],
        user.id
      )
    );
    await db.transaction((tx) =>
      poster.postCustomerInvoice(
        tx,
        { invoiceNumber: "FA-2", type: "credit", invoiceDate: `${CURRENT_YEAR}-03-10`, customerName: "Kund AB" },
        [{ articleGroupId: null, lineAmount: 400, vatAmount: 100, vatRate: 25, vatCode: mp25 }],
        user.id
      )
    );

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["05"]).toBe(600);
    expect(report.boxes["10"]).toBe(150);
    expect(report.boxes["49"]).toBe(150);
  });

  it("manual verifications on a configured VAT account count (account-based, not document-based)", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${CURRENT_YEAR}-03-05`, [
      ["1930", 75],
      ["2610", -75],
    ]);

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["10"]).toBe(75);
  });

  it("ruta 49 goes negative on a momsfordran period", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-03-05`, 100, "2610", 25);
    await bookPurchase(user.id, `${CURRENT_YEAR}-03-10`, 800, 200);

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["49"]).toBe(round2(25 - 200));
  });

  it("a quarter report equals the sum of its three month reports", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-01-10`, 1000, "2610", 25);
    await bookSale(user.id, `${CURRENT_YEAR}-02-10`, 500, "2620", 12);
    await bookPurchase(user.id, `${CURRENT_YEAR}-03-10`, 400, 100);

    const [jan, feb, mar, q1] = await Promise.all([
      vatReport.getReport(JAN),
      vatReport.getReport(FEB),
      vatReport.getReport(MAR),
      vatReport.getReport(Q1),
    ]);

    for (const key of Object.keys(q1.boxes) as (keyof typeof q1.boxes)[]) {
      expect(q1.boxes[key]).toBe(round2(jan.boxes[key] + feb.boxes[key] + mar.boxes[key]));
    }
    expect(q1.periods).toHaveLength(3);
  });

  it("a momskod pointing at an account without its box is reported, and the box-driven omföring leaves that account alone", async () => {
    const { user } = await setupEconomy();
    await service.createAccount({ number: "2611", name: "Utgående moms 25 % (egen)" });
    await db.update(vatCodes).set({ outputVatAccount: "2611" }).where(eq(vatCodes.code, "MP25"));
    await bookManual(user.id, `${CURRENT_YEAR}-03-05`, [
      ["1930", 125],
      ["2611", -125],
    ]);

    const report = await vatReport.getReport(MAR);
    // 2611 has no box (unknown number): not in ruta 10, but visible twice.
    expect(report.boxes["10"]).toBe(0);
    expect(report.warnings.unassignedAccounts).toEqual([
      { accountNumber: "2611", accountName: "Utgående moms 25 % (egen)", net: 125 },
    ]);
    expect(report.warnings.vatCodeBoxMismatches).toEqual([
      {
        code: "MP25",
        slot: "outputVat",
        accountNumber: "2611",
        expectedBox: "10",
        actualBox: null,
        problem: "box_mismatch",
        message: "Momskod MP25: konto 2611 har ingen ruta men ska ha ruta 10",
      },
    ]);
    // Only accounts with a box that enters ruta 49 are emptied — none moved.
    expect(report.settlement.rows).toEqual([]);
    await expect(vatReport.settle(MAR, user.id)).rejects.toBeInstanceOf(ZeroAmountPostingError);
  });

  it("tagging the account with box 10 clears both warnings and the omföring empties it", async () => {
    const { user } = await setupEconomy();
    await service.createAccount({ number: "2611", name: "Utgående moms 25 % (egen)", vatBox: "10" });
    await db.update(vatCodes).set({ outputVatAccount: "2611" }).where(eq(vatCodes.code, "MP25"));
    await bookManual(user.id, `${CURRENT_YEAR}-03-05`, [
      ["1930", 125],
      ["2611", -125],
    ]);

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["10"]).toBe(125);
    expect(report.warnings).toEqual({ unassignedAccounts: [], vatCodeBoxMismatches: [], ruleBoxMismatches: [] });

    const result = await vatReport.settle(MAR, user.id);
    expect(await ledgerNet("2611", MAR.from, MAR.to)).toBe(0);
    expect(result.verification.displayNumber).toBe(`M-${CURRENT_YEAR}-1`);
  });

  it("rejects a redovisningskonto that itself carries a box the omföring empties", async () => {
    await setupEconomy();
    postingSettings = { ...postingSettings, postingVatSettlement: "2640" };

    await expect(vatReport.getReport(MAR)).rejects.toBeInstanceOf(VatAccountsNotDistinctError);
  });

  it("exposes every moved account with a settled box, ruta 49 in kronor and the öresutjämning as the settlement preview", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-03-05`, 1000, "2610", 25);
    await bookPurchase(user.id, `${CURRENT_YEAR}-03-10`, 400, 100);
    // Omvänd moms on an EU purchase: 2614 (ruta 30) and 2645 (ruta 48).
    await bookManual(user.id, `${CURRENT_YEAR}-03-12`, [
      ["4515", 1000.6],
      ["2645", 250.15],
      ["2614", -250.15],
      ["2440", -1000.6],
    ]);

    const report = await vatReport.getReport(MAR);
    expect(report.settlement.rows.map((row) => [row.accountNumber, row.vatBox, row.net])).toEqual([
      ["2610", "10", -250],
      ["2614", "30", -250.15],
      ["2640", "48", 100],
      ["2645", "48", 250.15],
    ]);
    expect(report.boxes["20"]).toBe(1000.6);
    expect(report.roundedBoxes["20"]).toBe(1001);
    // (250 + 250) − (100 + 250) in kronor.
    expect(report.roundedBoxes["49"]).toBe(150);
    expect(report.settlement.settlementAccount).toEqual({ number: "2650", name: "Redovisningskonto för moms", amount: 150 });
    expect(report.settlement.roundingAccount).toEqual({ number: "3740", name: "Öres- och kronutjämning", amount: 0 });
    expect(report.settlements).toEqual([]);
  });

  it("accepts a whole fiscal year (helår) as the range", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-02-05`, 100, "2610", 25);
    await bookSale(user.id, `${CURRENT_YEAR}-11-05`, 100, "2610", 25);
    const report = await vatReport.getReport({ from: `${CURRENT_YEAR}-01-01`, to: `${CURRENT_YEAR}-12-31` });
    expect(report.periods).toHaveLength(12);
    expect(report.boxes["10"]).toBe(50);
  });
});

// Books the reversal of a settlement's M verification through the ordinary
// manual path (Omför creates a same-series draft dated today, then book it) —
// exactly what the verification card's undo flow does.
async function reverseAndBook(verificationId: string, userId: string) {
  const draft = await service.reverse(verificationId, userId);
  return service.book(draft.id, userId);
}

async function ledgerNet(accountNumber: string, from: string, to: string) {
  const ledger = await repo.getLedger(await accountId(accountNumber), from, to);
  return round2(ledger.rows.reduce((sum, row) => sum + Number(row.debit) - Number(row.credit), 0));
}

describe("vat report — settlement", () => {
  it("books the momsomföring dated on the range's end and empties the VAT accounts in the ledger", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-03-05`, 1000, "2610", 25);
    await bookPurchase(user.id, `${CURRENT_YEAR}-03-10`, 400, 100);

    const result = await vatReport.settle(MAR, user.id);

    expect(result.verification.displayNumber).toBe(`M-${CURRENT_YEAR}-1`);
    expect(result.settlement).toMatchObject({ fromDate: MAR.from, toDate: MAR.to });
    expect(await ledgerNet("2610", MAR.from, MAR.to)).toBe(0);
    expect(await ledgerNet("2640", MAR.from, MAR.to)).toBe(0);
    // The payable lands on redovisningskontot: 250 − 100 = 150 kr credit.
    expect(await ledgerNet("2650", MAR.from, MAR.to)).toBe(-150);
  });

  it("puts ruta 49 in whole kronor on 2650 and the öre difference on öres- och kronutjämning", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${CURRENT_YEAR}-03-05`, [
      ["1510", 1252.4],
      ["3001", -1002],
      ["2610", -250.4],
    ]);
    await bookPurchase(user.id, `${CURRENT_YEAR}-03-10`, 400, 100.3);

    const report = await vatReport.getReport(MAR);
    expect(report.boxes["49"]).toBe(150.1);
    // 250 − 100 on the rounded boxes.
    expect(report.roundedBoxes["49"]).toBe(150);
    expect(report.settlement.roundingAccount.amount).toBe(0.1);

    await vatReport.settle(MAR, user.id);
    expect(await ledgerNet("2610", MAR.from, MAR.to)).toBe(0);
    expect(await ledgerNet("2640", MAR.from, MAR.to)).toBe(0);
    expect(await ledgerNet("2650", MAR.from, MAR.to)).toBe(-150);
    expect(await ledgerNet("3740", MAR.from, MAR.to)).toBe(-0.1);
  });

  it("validates period coverage like the report does", async () => {
    const { user } = await setupEconomy();
    await expect(vatReport.settle({ from: `${CURRENT_YEAR}-03-15`, to: MAR.to }, user.id)).rejects.toBeInstanceOf(
      VatPeriodNotCoveredError
    );
  });

  it("refuses a redovisningskonto carrying a box the omföring empties", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-03-05`, 100, "2610", 25);
    postingSettings = { ...postingSettings, postingVatSettlement: "2610" };

    await expect(vatReport.settle(MAR, user.id)).rejects.toBeInstanceOf(VatAccountsNotDistinctError);
    expect(await db.select().from(vatSettlements)).toHaveLength(0);
  });

  it("keeps the report's boxes unchanged after settling and lists the settlement", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-03-05`, 1000, "2610", 25);

    const before = await vatReport.getReport(MAR);
    const settled = await vatReport.settle(MAR, user.id);
    const after = await vatReport.getReport(MAR);

    expect(after.boxes).toEqual(before.boxes);
    expect(after.settlement).toEqual(before.settlement);
    expect(after.settlements).toHaveLength(1);
    expect(after.settlements[0]).toMatchObject({
      fromDate: MAR.from,
      toDate: MAR.to,
      displayNumber: settled.verification.displayNumber,
      reversed: false,
      reversedBy: null,
    });
  });

  it("throws ZeroAmountPostingError for a range with no VAT movement, writing nothing", async () => {
    const { user } = await setupEconomy();

    await expect(vatReport.settle(MAR, user.id)).rejects.toBeInstanceOf(ZeroAmountPostingError);
    expect(await db.select().from(vatSettlements)).toHaveLength(0);
  });

  it("blocks overlapping ranges while a settlement is active: identical, month-inside-quarter and partial", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-01-10`, 100, "2610", 25);
    await bookSale(user.id, `${CURRENT_YEAR}-02-10`, 100, "2610", 25);
    await vatReport.settle(JAN, user.id);

    await expect(vatReport.settle(JAN, user.id)).rejects.toBeInstanceOf(VatPeriodAlreadySettledError);
    await expect(vatReport.settle(Q1, user.id)).rejects.toBeInstanceOf(VatPeriodAlreadySettledError);
    await expect(
      vatReport.settle({ from: JAN.from, to: FEB.to }, user.id)
    ).rejects.toBeInstanceOf(VatPeriodAlreadySettledError);

    // The adjacent month is untouched by the January settlement.
    const feb = await vatReport.settle(FEB, user.id);
    expect(feb.verification.displayNumber).toBe(`M-${CURRENT_YEAR}-2`);
  });

  it("reversal frees the range and a re-settle books the full accumulated net (exclusion covers both sides)", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-01-10`, 1000, "2610", 25);
    const first = await vatReport.settle(JAN, user.id);

    // More VAT lands in the already-settled month (period is still open).
    await bookSale(user.id, `${CURRENT_YEAR}-01-20`, 400, "2610", 25);
    await expect(vatReport.settle(JAN, user.id)).rejects.toBeInstanceOf(VatPeriodAlreadySettledError);

    await reverseAndBook(first.verification.id, user.id);

    const report = await vatReport.getReport(JAN);
    expect(report.boxes["10"]).toBe(350);
    expect(report.settlements[0]).toMatchObject({ reversed: true });
    expect(report.settlements[0]!.reversedBy).not.toBeNull();

    const second = await vatReport.settle(JAN, user.id);
    // The re-settle empties the FULL 350 (250 + 100): the first settlement
    // and its reversal are both excluded from the movement computation.
    // Asserted over the whole year — the reversal is dated TODAY (Omför's
    // convention), so January's own window still holds M-1's debit; only the
    // full history nets to zero (−250 −100 +250 M-1 −250 omföring +350 M-2).
    expect(await ledgerNet("2610", JAN.from, `${CURRENT_YEAR}-12-31`)).toBe(0);
    // M-2 is the REVERSAL (Omför books the mirror in the source's own
    // series), so the second declaration takes M-3.
    expect(second.verification.displayNumber).toBe(`M-${CURRENT_YEAR}-3`);
  });

  // The exclusion's OTHER half: a settlement's booked reversal (dated TODAY
  // by Omför's convention) must be invisible in the month it lands in — not
  // just in the settled range. The fixture month is chosen ≠ today's month
  // so the two ranges never coincide regardless of when the suite runs.
  it("a settlement's reversal is itself invisible in the month it is booked", async () => {
    const { user } = await setupEconomy();
    const today = new Date().toLocaleDateString("sv-SE");
    const target = today.slice(5, 7) === "01" ? FEB : JAN;
    await bookSale(user.id, `${target.from.slice(0, 8)}10`, 1000, "2610", 25);
    const settled = await vatReport.settle(target, user.id);
    await reverseAndBook(settled.verification.id, user.id);

    const todayPeriod = await repo.findPeriodForDate(today);
    const report = await vatReport.getReport({ from: todayPeriod!.startDate, to: todayPeriod!.endDate });
    // The reversal credits 2650 and debits... nothing counted: every box zero.
    for (const value of Object.values(report.boxes)) {
      expect(value).toBe(0);
    }
  });

  // ...while a reversal of an ORDINARY verification must still count — the
  // exclusion is keyed on vat_settlements links, not on reversal-ness.
  it("a reversal of an ordinary verification still counts in the boxes (mirrored)", async () => {
    const { user } = await setupEconomy();
    const today = new Date().toLocaleDateString("sv-SE");
    const target = today.slice(5, 7) === "01" ? FEB : JAN;
    await bookSale(user.id, `${target.from.slice(0, 8)}10`, 100, "2610", 25);
    const series = await repo.findSeriesByCode("A");
    const [sale] = await db
      .select({ id: verifications.id })
      .from(verifications)
      .where(eq(verifications.seriesId, series!.id));
    await reverseAndBook(sale!.id, user.id);

    const todayPeriod = await repo.findPeriodForDate(today);
    const report = await vatReport.getReport({ from: todayPeriod!.startDate, to: todayPeriod!.endDate });
    expect(report.boxes["10"]).toBe(-25);
    expect(report.boxes["05"]).toBe(-100);
  });

  it("settles a quarter whose earlier months are locked, but refuses when the end month is locked", async () => {
    const { user } = await setupEconomy();
    await bookSale(user.id, `${CURRENT_YEAR}-01-10`, 100, "2610", 25);
    await bookSale(user.id, `${CURRENT_YEAR}-03-10`, 100, "2610", 25);

    const janPeriod = await repo.findPeriodForDate(JAN.from);
    const febPeriod = await repo.findPeriodForDate(FEB.from);
    await service.lockPeriod(janPeriod!.id, user.id);
    await service.lockPeriod(febPeriod!.id, user.id);

    // Booking date is the END of the range — only March's lock state matters.
    const q1 = await vatReport.settle(Q1, user.id);
    expect(q1.verification.displayNumber).toBe(`M-${CURRENT_YEAR}-1`);

    // April: lock the end month and nothing may be written.
    await bookSale(user.id, `${CURRENT_YEAR}-04-10`, 100, "2610", 25);
    const aprPeriod = await repo.findPeriodForDate(`${CURRENT_YEAR}-04-01`);
    await service.lockPeriod(aprPeriod!.id, user.id);
    await expect(
      vatReport.settle({ from: `${CURRENT_YEAR}-04-01`, to: `${CURRENT_YEAR}-04-30` }, user.id)
    ).rejects.toBeInstanceOf(AccountingPeriodLockedError);
    expect(await db.select().from(vatSettlements)).toHaveLength(1);
  });
});
