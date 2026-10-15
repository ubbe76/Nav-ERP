import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { accounts, db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { createVatReportService } from "../src/modules/economy/service/vat-report.service.js";
import { readAccountBalances } from "../src/modules/economy/service/account-balances.js";
import {
  ReportFiscalYearNotFoundError,
  createFinancialReportsService,
} from "../src/modules/economy/service/financial-reports.service.js";

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
const service = createEconomyService(repo, { log: async () => {} });

const TRUNCATE = sql`TRUNCATE vat_settlements, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;

const POSTING_SETTINGS = {
  postingAccountsReceivable: "1510",
  postingVatOut25: "2610",
  postingVatOut12: "2620",
  postingVatOut6: "2630",
  postingRevenue25: "3001",
  postingRevenue12: "3002",
  postingRevenue6: "3003",
  postingRevenue0: "3004",
  postingAccountsPayable: "2440",
  postingVatIn: "2640",
  postingDefaultCost: "4010",
  postingBank: "1930",
  postingReminderFeeAccount: "3540",
  postingPaymentWriteOff: "3740",
  postingVatSettlement: "2650",
};
const settingsReader = { read: async () => POSTING_SETTINGS };
const poster = createVerificationPoster(settingsReader);
const vatReport = createVatReportService({ db, poster, settings: settingsReader });
const reports = createFinancialReportsService({ db, repo });

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = 2026;

async function setupEconomy(startDate = `${YEAR}-01-01`, endDate = `${YEAR}-12-31`, label = String(YEAR)) {
  const user = await authRepo.create({
    email: `reports-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomiadmin",
    role: "admin",
  });
  await service.createFiscalYear({ label, startDate, endDate });
  await service.createSeries({ code: "A", name: "Manuella verifikat" });
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  return { user };
}

async function accountId(number: string) {
  const account = await repo.findAccountByNumber(number);
  return account!.id;
}

// Books a balanced manual verification from (accountNumber, net) pairs where
// positive = debit, negative = credit.
async function bookManual(userId: string, date: string, entries: [string, number][], description = "Testpost") {
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

async function draftManual(userId: string, date: string, entries: [string, number][]) {
  const series = await repo.findSeriesByCode("A");
  const rows = await Promise.all(
    entries.map(async ([number, net]) => ({
      accountId: await accountId(number),
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    }))
  );
  return service.createVerification({ seriesId: series!.id, date, description: "Utkast", rows }, userId);
}

function byNumber(balances: Awaited<ReturnType<typeof readAccountBalances>>, number: string) {
  return balances.find((balance) => balance.accountNumber === number);
}

describe("readAccountBalances", () => {
  it("splits opening and period sums on the from date", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-10`, [["1930", 1000], ["3001", -1000]]);
    await bookManual(user.id, `${YEAR}-06-10`, [["1930", 500], ["3001", -500]]);

    const balances = await readAccountBalances(db, { from: `${YEAR}-06-01`, to: `${YEAR}-12-31` });
    const bank = byNumber(balances, "1930")!;
    expect(bank.openingDebit).toBe(1000);
    expect(bank.openingCredit).toBe(0);
    expect(bank.periodDebit).toBe(500);
    expect(bank.periodCredit).toBe(0);
  });

  it("treats the range as inclusive at both ends", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-03-01`, [["1930", 100], ["3001", -100]]);
    await bookManual(user.id, `${YEAR}-03-31`, [["1930", 200], ["3001", -200]]);

    const balances = await readAccountBalances(db, { from: `${YEAR}-03-01`, to: `${YEAR}-03-31` });
    expect(byNumber(balances, "1930")!.periodDebit).toBe(300);
  });

  it("never lets rows after the to date leak in", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-03-31`, [["1930", 100], ["3001", -100]]);
    await bookManual(user.id, `${YEAR}-04-01`, [["1930", 999], ["3001", -999]]);

    const balances = await readAccountBalances(db, { from: `${YEAR}-01-01`, to: `${YEAR}-03-31` });
    expect(byNumber(balances, "1930")!.periodDebit).toBe(100);
    expect(byNumber(balances, "1930")!.openingDebit).toBe(0);
  });

  it("ignores drafts entirely", async () => {
    const { user } = await setupEconomy();
    await draftManual(user.id, `${YEAR}-02-01`, [["1930", 1000000], ["3001", -1000000]]);

    const balances = await readAccountBalances(db, { from: `${YEAR}-01-01`, to: `${YEAR}-12-31` });
    expect(byNumber(balances, "1930")).toBeUndefined();
  });

  it("returns zero openings when from is null", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-10`, [["1930", 1000], ["3001", -1000]]);

    const balances = await readAccountBalances(db, { from: null, to: `${YEAR}-12-31` });
    const bank = byNumber(balances, "1930")!;
    expect(bank.openingDebit).toBe(0);
    expect(bank.openingCredit).toBe(0);
    expect(bank.periodDebit).toBe(1000);
  });

  it("keeps a booked momsomföring's rows — unlike readVatAccountMovements", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-15`, [["1510", 1250], ["3001", -1000], ["2610", -250]]);
    await vatReport.settle({ from: `${YEAR}-01-01`, to: `${YEAR}-01-31` }, user.id);

    const balances = await readAccountBalances(db, { from: null, to: `${YEAR}-12-31` });
    // The settlement moved 250 off 2610 and onto 2650.
    expect(byNumber(balances, "2650")!.periodCredit).toBe(250);
    expect(byNumber(balances, "2610")!.periodDebit).toBe(250);
    expect(byNumber(balances, "2610")!.periodCredit).toBe(250);
  });

  it("includes rows booked on an account that was later deactivated", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-01`, [["1910", 750], ["3001", -750]]);
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "1910"));

    const balances = await readAccountBalances(db, { from: null, to: `${YEAR}-12-31` });
    expect(byNumber(balances, "1910")!.periodDebit).toBe(750);
  });

  it("orders by account number and returns no row for accounts without postings", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-01`, [["3001", -400], ["1930", 400]]);

    const balances = await readAccountBalances(db, { from: null, to: `${YEAR}-12-31` });
    expect(balances.map((balance) => balance.accountNumber)).toEqual(["1930", "3001"]);
  });
});

function line(sheet: Awaited<ReturnType<typeof reports.getBalanceSheet>>, lineKey: string) {
  for (const section of [sheet.assets, sheet.equityAndLiabilities]) {
    for (const group of section.groups) {
      const found = group.lines.find((l) => l.key === lineKey);
      if (found) return found;
    }
  }
  return undefined;
}

describe("balansräkning", () => {
  it("sums every booked row up to and including asOf, with no lower bound", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-05`, [["1930", 1000], ["2081", -1000]]);
    await bookManual(user.id, `${YEAR}-07-05`, [["1930", 500], ["2081", -500]]);

    const sheet = await reports.getBalanceSheet({ asOf: `${YEAR}-07-05` });
    expect(line(sheet, "cashAndBank")!.total).toBe(1500);
    expect(sheet.fiscalYear.label).toBe(String(YEAR));
  });

  it("balances on a mixed data set with invoices, VAT settlement and a reversal", async () => {
    const { user } = await setupEconomy();
    // Sale, purchase, salary, and a reversed mistake.
    await bookManual(user.id, `${YEAR}-01-15`, [["1510", 12500], ["3001", -10000], ["2610", -2500]]);
    await bookManual(user.id, `${YEAR}-01-20`, [["4010", 4000], ["2640", 1000], ["2440", -5000]]);
    await bookManual(user.id, `${YEAR}-01-25`, [["7010", 30000], ["2710", -9000], ["1930", -21000]]);
    const mistake = await bookManual(user.id, `${YEAR}-02-01`, [["5010", 999], ["1930", -999]]);
    // reverse() dates the reversal today, which the fiscal year covers.
    await service.reverse(mistake.id, user.id);
    await vatReport.settle({ from: `${YEAR}-01-01`, to: `${YEAR}-01-31` }, user.id);

    const sheet = await reports.getBalanceSheet({ asOf: `${YEAR}-12-31` });
    expect(sheet.difference).toBe(0);
    expect(sheet.assets.total).toBe(sheet.equityAndLiabilities.total);
  });

  it("keeps a settled VAT month's 2650 on the balance sheet", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-15`, [["1510", 1250], ["3001", -1000], ["2610", -250]]);
    await vatReport.settle({ from: `${YEAR}-01-01`, to: `${YEAR}-01-31` }, user.id);

    const sheet = await reports.getBalanceSheet({ asOf: `${YEAR}-12-31` });
    const numbers = line(sheet, "otherCurrentLiabilities")!.accounts.map((a) => a.accountNumber);
    expect(numbers).toContain("2650");
    expect(sheet.difference).toBe(0);
  });

  it("presents the period result as Årets resultat when no closing entry exists", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-03-01`, [["1930", 500], ["3001", -500]]);

    const sheet = await reports.getBalanceSheet({ asOf: `${YEAR}-12-31` });
    expect(line(sheet, "yearResult")!.total).toBe(500);
    expect(line(sheet, "retainedResult")!.total).toBe(0);
    expect(sheet.difference).toBe(0);
  });

  it("stays correct when a manual bokslut moves the result into eget kapital", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-03-01`, [["1930", 500], ["3001", -500]]);
    // Close revenue to 8999, then 8999 to 2099 — class 3–8 nets to zero.
    await bookManual(user.id, `${YEAR}-12-31`, [["3001", 500], ["8999", -500]], "Bokslut 1");
    await bookManual(user.id, `${YEAR}-12-31`, [["8999", 500], ["2099", -500]], "Bokslut 2");

    const sheet = await reports.getBalanceSheet({ asOf: `${YEAR}-12-31` });
    expect(line(sheet, "yearResult")!.total).toBe(0);
    expect(line(sheet, "unrestrictedEquity")!.total).toBe(500);
    expect(sheet.difference).toBe(0);
  });

  it("never counts drafts", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-03-01`, [["1930", 100], ["2081", -100]]);
    await draftManual(user.id, `${YEAR}-03-02`, [["1930", 1000000], ["2081", -1000000]]);

    const sheet = await reports.getBalanceSheet({ asOf: `${YEAR}-12-31` });
    expect(line(sheet, "cashAndBank")!.total).toBe(100);
  });

  it("splits retained and current result on a brutet räkenskapsår's boundary", async () => {
    const { user } = await setupEconomy(`${YEAR}-05-01`, `${YEAR + 1}-04-30`, `${YEAR}/${YEAR + 1}`);
    // The previous broken year, so there is a period to book the retained
    // result into at all.
    await service.createFiscalYear({
      label: `${YEAR - 1}/${YEAR}`,
      startDate: `${YEAR - 1}-05-01`,
      endDate: `${YEAR}-04-30`,
    });
    // Before the fiscal year start — retained, even though it is the same calendar year.
    await bookManual(user.id, `${YEAR}-04-15`, [["1930", 300], ["3001", -300]]);
    await bookManual(user.id, `${YEAR}-06-15`, [["1930", 700], ["3001", -700]]);

    const sheet = await reports.getBalanceSheet({ asOf: `${YEAR}-12-31` });
    expect(line(sheet, "retainedResult")!.total).toBe(300);
    expect(line(sheet, "yearResult")!.total).toBe(700);
    expect(sheet.difference).toBe(0);
  });

  it("omits an account that nets to zero at asOf", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-10`, [["1910", 500], ["2081", -500]]);
    await bookManual(user.id, `${YEAR}-02-10`, [["1910", -500], ["2081", 500]]);

    const sheet = await reports.getBalanceSheet({ asOf: `${YEAR}-12-31` });
    expect(line(sheet, "cashAndBank")).toBeUndefined();
  });

  it("raises ReportFiscalYearNotFoundError for a date no fiscal year covers", async () => {
    await setupEconomy();
    await expect(reports.getBalanceSheet({ asOf: `${YEAR + 5}-01-01` })).rejects.toBeInstanceOf(
      ReportFiscalYearNotFoundError
    );
  });
});

describe("resultaträkning", () => {
  it("is bounded by from–to — earlier revenue never leaks in", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-15`, [["1930", 1000], ["3001", -1000]]);
    await bookManual(user.id, `${YEAR}-06-15`, [["1930", 400], ["3001", -400]]);

    const statement = await reports.getIncomeStatement({ from: `${YEAR}-06-01`, to: `${YEAR}-06-30` });
    expect(statement.result).toBe(400);
  });

  it("counts rows on both boundary dates", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-03-01`, [["1930", 100], ["3001", -100]]);
    await bookManual(user.id, `${YEAR}-03-31`, [["1930", 200], ["3001", -200]]);

    const statement = await reports.getIncomeStatement({ from: `${YEAR}-03-01`, to: `${YEAR}-03-31` });
    expect(statement.result).toBe(300);
  });

  it("makes a quarter equal the sum of its three months", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-15`, [["1930", 100], ["3001", -100]]);
    await bookManual(user.id, `${YEAR}-02-15`, [["4010", 40], ["1930", -40]]);
    await bookManual(user.id, `${YEAR}-03-15`, [["1930", 250], ["3001", -250]]);

    const months = await Promise.all([
      reports.getIncomeStatement({ from: `${YEAR}-01-01`, to: `${YEAR}-01-31` }),
      reports.getIncomeStatement({ from: `${YEAR}-02-01`, to: `${YEAR}-02-28` }),
      reports.getIncomeStatement({ from: `${YEAR}-03-01`, to: `${YEAR}-03-31` }),
    ]);
    const quarter = await reports.getIncomeStatement({ from: `${YEAR}-01-01`, to: `${YEAR}-03-31` });
    expect(quarter.result).toBe(months.reduce((sum, month) => sum + month.result, 0));
  });

  it("never counts drafts", async () => {
    const { user } = await setupEconomy();
    await draftManual(user.id, `${YEAR}-02-01`, [["1930", 5000], ["3001", -5000]]);

    const statement = await reports.getIncomeStatement({ from: `${YEAR}-01-01`, to: `${YEAR}-12-31` });
    expect(statement.result).toBe(0);
  });

  it("matches the balance sheet's Årets resultat for the same window", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-10`, [["1510", 12500], ["3001", -10000], ["2610", -2500]]);
    await bookManual(user.id, `${YEAR}-03-10`, [["4010", 4000], ["2440", -4000]]);
    await bookManual(user.id, `${YEAR}-04-10`, [["7010", 2500], ["1930", -2500]]);

    const asOf = `${YEAR}-06-30`;
    const sheet = await reports.getBalanceSheet({ asOf });
    const statement = await reports.getIncomeStatement({ from: `${YEAR}-01-01`, to: asOf });
    expect(statement.result).toBe(line(sheet, "yearResult")!.total);
  });
});

const FULL_YEAR = { from: `${YEAR}-01-01`, to: `${YEAR}-12-31`, onlyWithMovement: true };

describe("utökad huvudbok", () => {
  it("returns every account with movement, ordered by account number", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-01`, [["3001", -500], ["1930", 500]]);

    const ledger = await reports.getGeneralLedger(FULL_YEAR);
    expect(ledger.accounts.map((a) => a.accountNumber)).toEqual(["1930", "3001"]);
    expect(ledger.accountFrom).toBe("0000");
    expect(ledger.accountTo).toBe("9999");
  });

  it("agrees with the single-account /ledger on opening balance and rows", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-10`, [["1930", 1000], ["2081", -1000]]);
    await bookManual(user.id, `${YEAR}-06-10`, [["1930", 250], ["3001", -250]]);

    const range = { from: `${YEAR}-06-01`, to: `${YEAR}-12-31` };
    const single = await service.getLedger({ accountId: await accountId("1930"), ...range });
    const multi = await reports.getGeneralLedger({ ...range, onlyWithMovement: true });
    const bank = multi.accounts.find((a) => a.accountNumber === "1930")!;

    expect(bank.openingBalance).toBe(single.openingBalance);
    expect(bank.closingBalance).toBe(single.closingBalance);
    expect(bank.rows.map((r) => r.balance)).toEqual(single.rows.map((r) => r.balance));
  });

  it("runs the balance from opening to closing", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-10`, [["1930", 1000], ["2081", -1000]]);
    await bookManual(user.id, `${YEAR}-02-10`, [["1930", -400], ["4010", 400]]);

    const ledger = await reports.getGeneralLedger(FULL_YEAR);
    const bank = ledger.accounts.find((a) => a.accountNumber === "1930")!;
    expect(bank.openingBalance).toBe(0);
    expect(bank.rows.map((r) => r.balance)).toEqual([1000, 600]);
    expect(bank.closingBalance).toBe(600);
    expect(bank.totalDebit).toBe(1000);
    expect(bank.totalCredit).toBe(400);
  });

  it("restricts the printout to the account interval", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-01`, [["3001", -500], ["1930", 500]]);

    const ledger = await reports.getGeneralLedger({ ...FULL_YEAR, accountFrom: "3000", accountTo: "3999" });
    expect(ledger.accounts.map((a) => a.accountNumber)).toEqual(["3001"]);
  });

  it("keeps an account with an opening balance but no rows, with or without onlyWithMovement", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-10`, [["1930", 1000], ["2081", -1000]]);

    const range = { from: `${YEAR}-06-01`, to: `${YEAR}-12-31` };
    const withMovement = await reports.getGeneralLedger({ ...range, onlyWithMovement: true });
    expect(withMovement.accounts.map((a) => a.accountNumber)).toEqual(["1930", "2081"]);

    const all = await reports.getGeneralLedger({ ...range, onlyWithMovement: false });
    const bank = all.accounts.find((a) => a.accountNumber === "1930")!;
    expect(bank.openingBalance).toBe(1000);
    expect(bank.rows).toEqual([]);
    expect(bank.closingBalance).toBe(1000);
  });

  it("lists a result account only when it moved in the interval, a balance account also on its opening balance", async () => {
    const { user } = await setupEconomy();
    // 3001 earned in January only; 1930 carries the cash from then on.
    await bookManual(user.id, `${YEAR}-01-10`, [["1930", 1000], ["3001", -1000]]);

    const range = { from: `${YEAR}-06-01`, to: `${YEAR}-12-31` };
    const ledger = await reports.getGeneralLedger({ ...range, onlyWithMovement: true });
    expect(ledger.accounts.map((a) => a.accountNumber)).toEqual(["1930"]);

    // Moving in the interval lists it again.
    await bookManual(user.id, `${YEAR}-07-01`, [["1930", 200], ["3001", -200]]);
    const again = await reports.getGeneralLedger({ ...range, onlyWithMovement: true });
    expect(again.accounts.map((a) => a.accountNumber)).toEqual(["1930", "3001"]);
  });

  // A result account (class 3–8) starts every fiscal year at 0: its IB is
  // the movement from the start of the year containing `from`. A balance
  // account keeps its cumulative IB. Same rule for the single-account ledger.
  it("starts a result account's opening balance at the fiscal year containing from", async () => {
    const { user } = await setupEconomy();
    await service.createFiscalYear({ label: String(YEAR - 1), startDate: `${YEAR - 1}-01-01`, endDate: `${YEAR - 1}-12-31` });
    await bookManual(user.id, `${YEAR - 1}-12-31`, [["4010", 3000], ["1930", -3000]]);
    await bookManual(user.id, `${YEAR}-02-10`, [["4010", 500], ["1930", -500]]);

    const opening = async (from: string, to: string, number: string) => {
      const multi = await reports.getGeneralLedger({ from, to, onlyWithMovement: false });
      const single = await service.getLedger({ accountId: await accountId(number), from, to });
      const account = multi.accounts.find((a) => a.accountNumber === number)!;
      expect(account.openingBalance).toBe(single.openingBalance);
      expect(account.closingBalance).toBe(single.closingBalance);
      return account.openingBalance;
    };

    expect(await opening(`${YEAR}-01-01`, `${YEAR}-12-31`, "4010")).toBe(0);
    expect(await opening(`${YEAR}-03-01`, `${YEAR}-12-31`, "4010")).toBe(500);
    expect(await opening(`${YEAR}-01-01`, `${YEAR}-12-31`, "1930")).toBe(-3000);
    expect(await opening(`${YEAR}-03-01`, `${YEAR}-12-31`, "1930")).toBe(-3500);
    // No fiscal year covers `from`: cumulative, as before.
    expect(await opening(`${YEAR + 1}-01-01`, `${YEAR + 1}-12-31`, "4010")).toBe(3500);

    const ledger = await reports.getGeneralLedger({ from: `${YEAR}-01-01`, to: `${YEAR}-12-31`, onlyWithMovement: true });
    const cost = ledger.accounts.find((a) => a.accountNumber === "4010")!;
    expect(cost.rows.map((r) => r.balance)).toEqual([500]);
    expect(cost.closingBalance).toBe(500);
  });

  it("includes an account that was deactivated after it got history", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-01`, [["1910", 750], ["2081", -750]]);
    await db.update(accounts).set({ active: false }).where(eq(accounts.number, "1910"));

    const ledger = await reports.getGeneralLedger(FULL_YEAR);
    expect(ledger.accounts.map((a) => a.accountNumber)).toContain("1910");
  });

  it("breaks ties on date, verification number and series code", async () => {
    const { user } = await setupEconomy();
    await service.createSeries({ code: "B", name: "Andra serien" });
    const seriesB = await repo.findSeriesByCode("B");
    const bankId = await accountId("1930");
    const equityId = await accountId("2081");

    // Same date, both get number 1 in their own series — series code decides.
    const draftB = await service.createVerification(
      {
        seriesId: seriesB!.id,
        date: `${YEAR}-04-01`,
        description: "Serie B",
        rows: [
          { accountId: bankId, debit: 20, credit: 0 },
          { accountId: equityId, debit: 0, credit: 20 },
        ],
      },
      user.id
    );
    await service.book(draftB.id, user.id);
    await bookManual(user.id, `${YEAR}-04-01`, [["1930", 10], ["2081", -10]], "Serie A");

    const ledger = await reports.getGeneralLedger(FULL_YEAR);
    const bank = ledger.accounts.find((a) => a.accountNumber === "1930")!;
    expect(bank.rows.map((r) => r.seriesCode)).toEqual(["A", "B"]);
  });

  it("never shows drafts", async () => {
    const { user } = await setupEconomy();
    await draftManual(user.id, `${YEAR}-02-01`, [["1930", 5000], ["2081", -5000]]);

    const ledger = await reports.getGeneralLedger(FULL_YEAR);
    expect(ledger.accounts).toHaveLength(0);
  });

  it("has equal debit and credit totals over a full fiscal year", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-15`, [["1510", 12500], ["3001", -10000], ["2610", -2500]]);
    await bookManual(user.id, `${YEAR}-02-15`, [["4010", 4000], ["2440", -4000]]);

    const ledger = await reports.getGeneralLedger(FULL_YEAR);
    expect(ledger.totalDebit).toBe(ledger.totalCredit);
  });
});

describe("verifikatlista", () => {
  it("lists verifications in date order with their posting rows", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-01`, [["1930", 500], ["3001", -500]], "Andra");
    await bookManual(user.id, `${YEAR}-01-01`, [["1930", 100], ["3001", -100]], "Första");

    const list = await reports.getVerificationList({});
    expect(list.verifications.map((v) => v.description)).toEqual(["Första", "Andra"]);
    expect(list.verifications[0]!.displayNumber).toBe(`A-${YEAR}-2`);
    expect(list.verifications[0]!.rows.map((r) => r.accountNumber)).toEqual(["1930", "3001"]);
    expect(list.verifications[0]!.totalDebit).toBe(100);
    expect(list.verifications[0]!.totalCredit).toBe(100);
  });

  it("prints Utkast for a draft", async () => {
    const { user } = await setupEconomy();
    await draftManual(user.id, `${YEAR}-02-01`, [["1930", 500], ["3001", -500]]);

    const list = await reports.getVerificationList({});
    expect(list.verifications[0]!.displayNumber).toBe("Utkast");
  });

  it("filters on status, series and date range", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-10`, [["1930", 100], ["3001", -100]], "Bokförd");
    await draftManual(user.id, `${YEAR}-01-11`, [["1930", 200], ["3001", -200]]);

    const booked = await reports.getVerificationList({ status: ["booked"] });
    expect(booked.verifications).toHaveLength(1);
    expect(booked.verifications[0]!.description).toBe("Bokförd");

    const series = await repo.findSeriesByCode("A");
    const bySeries = await reports.getVerificationList({ seriesId: series!.id });
    expect(bySeries.verifications).toHaveLength(2);

    const outsideRange = await reports.getVerificationList({
      from: `${YEAR}-02-01`,
      to: `${YEAR}-02-28`,
    });
    expect(outsideRange.verifications).toHaveLength(0);
  });

  it("balances debit and credit within every verification", async () => {
    const { user } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-15`, [["1510", 12500], ["3001", -10000], ["2610", -2500]]);

    const list = await reports.getVerificationList({});
    for (const verification of list.verifications) {
      expect(verification.totalDebit).toBe(verification.totalCredit);
    }
  });

  it("returns an empty list rather than failing when nothing matches", async () => {
    await setupEconomy();
    const list = await reports.getVerificationList({});
    expect(list.verifications).toEqual([]);
  });
});
