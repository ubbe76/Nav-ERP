import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { round2 } from "@navet/shared";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { BAS_STANDARD_ACCOUNTS } from "../src/modules/economy/service/bas-accounts.js";
import {
  createSieService,
  SieAlreadyImportedError,
  SieFiscalYearMismatchError,
  SieFiscalYearNotFoundError,
  SiePriorBookkeepingError,
  SieUnbalancedError,
} from "../src/modules/economy/service/sie.service.js";
import { createVerificationPoster } from "../src/modules/economy/service/verification-poster.js";
import { decodeCp437, encodeCp437 } from "../src/modules/economy/service/sie-encoding.js";
import { parseSieFile } from "../src/modules/economy/service/sie-parse.js";

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
const service = createEconomyService(repo, { log: async () => {} });

const TRUNCATE = sql`TRUNCATE vat_settlements, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, posting_rules, article_groups, audit_log, users CASCADE`;

const poster = createVerificationPoster({
  read: async () => ({
    postingAccountsReceivable: "1510", postingVatOut25: "2610", postingVatOut12: "2620",
    postingVatOut6: "2630", postingRevenue25: "3001", postingRevenue12: "3002",
    postingRevenue6: "3003", postingRevenue0: "3004", postingAccountsPayable: "2440",
    postingVatIn: "2640", postingDefaultCost: "4010", postingBank: "1930",
    postingReminderFeeAccount: "3540", postingPaymentWriteOff: "3740", postingVatSettlement: "2650",
  }),
});

const sie = createSieService({
  db,
  repo,
  system: { getCompanyInfo: async () => ({ name: "Målerifirman AB", orgNumber: "556677-8899" }) },
  poster,
  programVersion: "1.0",
});

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = 2026;

async function setupEconomy() {
  const user = await authRepo.create({
    email: `sie-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name: "Ekonomiadmin",
    role: "admin",
  });
  const year = await service.createFiscalYear({
    label: String(YEAR),
    startDate: `${YEAR}-01-01`,
    endDate: `${YEAR}-12-31`,
  });
  await service.createSeries({ code: "A", name: "Manuella verifikat" }).catch(() => undefined);
  await repo.seedAccounts(BAS_STANDARD_ACCOUNTS);
  return { user, year };
}

async function bookManual(userId: string, date: string, entries: [string, number][], description = "Testpost") {
  const series = await repo.findSeriesByCode("A");
  const rows = await Promise.all(
    entries.map(async ([number, net]) => {
      const account = await repo.findAccountByNumber(number);
      return { accountId: account!.id, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
    })
  );
  const draft = await service.createVerification({ seriesId: series!.id, date, description, rows }, userId);
  return service.book(draft.id, userId);
}

async function exportText(fiscalYearId: string) {
  const { content } = await sie.exportFiscalYear(fiscalYearId, "urban");
  return decodeCp437(content);
}

describe("SIE-export", () => {
  it("produces a spec-shaped file from real bookkeeping", async () => {
    const { user, year } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-02`, [["1930", 25000], ["2081", -25000]], "Aktiekapital");
    await bookManual(user.id, `${YEAR}-02-15`, [["1510", 12500], ["3001", -10000], ["2610", -2500]], "Kundfaktura");

    const text = await exportText(year.id);
    const lines = text.split("\r\n");

    expect(lines[0]).toBe("#FLAGGA 0");
    expect(lines).toContain("#FORMAT PC8");
    expect(lines).toContain("#SIETYP 4");
    expect(lines).toContain("#ORGNR 556677-8899");
    expect(lines).toContain('#FNAMN "Målerifirman AB"');
    expect(lines).toContain(`#RAR 0 ${YEAR}0101 ${YEAR}1231`);
    expect(lines).toContain('#KONTO 1930 "Företagskonto/checkkonto"');
    expect(lines).toContain("#KTYP 1930 T");
    expect(lines).toContain("#KTYP 2440 S");
    expect(lines).toContain("#KTYP 3001 I");
  });

  it("writes assets positive and liabilities negative in #UB", async () => {
    const { user, year } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-02`, [["1930", 25000], ["2081", -25000]]);

    const lines = (await exportText(year.id)).split("\r\n");
    expect(lines).toContain("#UB 0 1930 25000");
    expect(lines).toContain("#UB 0 2081 -25000");
  });

  it("puts revenue in #RES with a credit (negative) sign", async () => {
    const { user, year } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-15`, [["1510", 10000], ["3001", -10000]]);

    const lines = (await exportText(year.id)).split("\r\n");
    expect(lines).toContain("#RES 0 3001 -10000");
  });

  it("emits every booked verification with balanced #TRANS rows", async () => {
    const { user, year } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-02-15`, [["1510", 12500], ["3001", -10000], ["2610", -2500]], "Kundfaktura");

    const text = await exportText(year.id);
    expect(text).toContain(`#VER A 1 ${YEAR}0215 "Kundfaktura"`);
    expect(text).toContain("\t#TRANS 1510 {} 12500");
    expect(text).toContain("\t#TRANS 3001 {} -10000");
    expect(text).toContain("\t#TRANS 2610 {} -2500");

    // Every #TRANS block must sum to zero.
    const amounts = [...text.matchAll(/#TRANS \d+ \{\} (-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(amounts.reduce((sum, n) => sum + n, 0)).toBe(0);
  });

  it("never exports a draft", async () => {
    const { user, year } = await setupEconomy();
    const series = await repo.findSeriesByCode("A");
    const account = await repo.findAccountByNumber("1930");
    const other = await repo.findAccountByNumber("2081");
    await service.createVerification(
      {
        seriesId: series!.id,
        date: `${YEAR}-03-01`,
        description: "Utkast",
        rows: [
          { accountId: account!.id, debit: 999, credit: 0 },
          { accountId: other!.id, debit: 0, credit: 999 },
        ],
      },
      user.id
    );

    const text = await exportText(year.id);
    expect(text).not.toContain("Utkast");
    // No #VER block at all — the draft is the only verification there is.
    // (A bare "999" check would false-positive on BAS account 8999.)
    expect(text.split("\r\n").some((line) => line.startsWith("#VER"))).toBe(false);
    expect(text).not.toContain("#TRANS");
  });

  it("adds a #RAR -1 line when a previous fiscal year exists", async () => {
    const { year } = await setupEconomy();
    await service.createFiscalYear({
      label: String(YEAR - 1),
      startDate: `${YEAR - 1}-01-01`,
      endDate: `${YEAR - 1}-12-31`,
    });

    const lines = (await exportText(year.id)).split("\r\n");
    expect(lines).toContain(`#RAR -1 ${YEAR - 1}0101 ${YEAR - 1}1231`);
  });

  it("names the file after the company and the fiscal year", async () => {
    const { year } = await setupEconomy();
    const { filename } = await sie.exportFiscalYear(year.id, "urban");
    expect(filename).toBe(`malerifirman-ab-${YEAR}0101-${YEAR}1231.se`);
  });

  it("raises SieFiscalYearNotFoundError for an unknown year", async () => {
    await setupEconomy();
    await expect(
      sie.exportFiscalYear("00000000-0000-0000-0000-000000000000", "urban")
    ).rejects.toBeInstanceOf(SieFiscalYearNotFoundError);
  });
});

function sieFile(lines: string[]): Buffer {
  return encodeCp437(lines.join("\r\n") + "\r\n");
}

const YEAR_RAR = `#RAR 0 ${YEAR}0101 ${YEAR}1231`;

async function closingBalance(number: string, from: string, to: string) {
  const account = await repo.findAccountByNumber(number);
  const ledger = await service.getLedger({ accountId: account!.id, from, to });
  return ledger.closingBalance;
}

describe("SIE-import av ingående balanser", () => {
  it("creates unknown accounts without a momsruta (null), never a guessed box", async () => {
    const { user, year } = await setupEconomy();
    const file = sieFile([YEAR_RAR, '#KONTO 2611 "Utgående moms 25 % (egen)"', "#IB 0 2611 -100.00", "#IB 0 1930 100.00"]);

    await sie.importOpeningBalances(year.id, file, user.id);
    expect((await repo.findAccountByNumber("2611"))!.vatBox).toBeNull();
  });

  it("books the balances as one verification in series I", async () => {
    const { user, year } = await setupEconomy();
    const file = sieFile([YEAR_RAR, "#IB 0 1930 25000.00", "#IB 0 2081 -25000.00"]);

    const result = await sie.importOpeningBalances(year.id, file, user.id);
    expect(result.displayNumber).toBe(`I-${YEAR}-1`);
    expect(result.balanceCount).toBe(2);
    expect(result.accountsCreated).toEqual([]);
    // Visible in the ledger like any other posting — no special-casing.
    expect(await closingBalance("1930", `${YEAR}-01-01`, `${YEAR}-12-31`)).toBe(25000);
  });

  it("creates accounts the chart is missing, using the #KONTO name", async () => {
    const { user, year } = await setupEconomy();
    const file = sieFile([
      YEAR_RAR,
      '#KONTO 1935 "Sparkonto"',
      "#IB 0 1935 4000.00",
      "#IB 0 2081 -4000.00",
    ]);

    const result = await sie.importOpeningBalances(year.id, file, user.id);
    expect(result.accountsCreated).toEqual(["1935"]);
    expect((await repo.findAccountByNumber("1935"))!.name).toBe("Sparkonto");
  });

  it("rejects a file whose balances do not sum to zero, writing nothing", async () => {
    const { user, year } = await setupEconomy();
    const file = sieFile([YEAR_RAR, "#IB 0 1930 25000.00", "#IB 0 2081 -20000.00"]);

    await expect(sie.importOpeningBalances(year.id, file, user.id)).rejects.toBeInstanceOf(
      SieUnbalancedError
    );
    expect(await closingBalance("1930", `${YEAR}-01-01`, `${YEAR}-12-31`)).toBe(0);
  });

  it("rejects a file for a different fiscal year", async () => {
    const { user, year } = await setupEconomy();
    const file = sieFile([
      `#RAR 0 ${YEAR - 1}0101 ${YEAR - 1}1231`,
      "#IB 0 1930 1.00",
      "#IB 0 2081 -1.00",
    ]);
    await expect(sie.importOpeningBalances(year.id, file, user.id)).rejects.toBeInstanceOf(
      SieFiscalYearMismatchError
    );
  });

  it("refuses a second import rather than doubling every balance", async () => {
    const { user, year } = await setupEconomy();
    const file = sieFile([YEAR_RAR, "#IB 0 1930 100.00", "#IB 0 2081 -100.00"]);
    await sie.importOpeningBalances(year.id, file, user.id);
    await expect(sie.importOpeningBalances(year.id, file, user.id)).rejects.toBeInstanceOf(
      SieAlreadyImportedError
    );
  });

  it("refuses when the system already holds bookkeeping before the year starts", async () => {
    // The ledger carries an opening balance forward on its own, so importing
    // one on top would double it. This is the guard that makes the round-trip
    // below safe to reason about.
    const { user, year } = await setupEconomy();
    await service.createFiscalYear({
      label: String(YEAR - 1),
      startDate: `${YEAR - 1}-01-01`,
      endDate: `${YEAR - 1}-12-31`,
    });
    await bookManual(user.id, `${YEAR - 1}-06-01`, [["1930", 25000], ["2081", -25000]]);

    const file = sieFile([YEAR_RAR, "#IB 0 1930 25000.00", "#IB 0 2081 -25000.00"]);
    await expect(sie.importOpeningBalances(year.id, file, user.id)).rejects.toBeInstanceOf(
      SiePriorBookkeepingError
    );
  });

  it("round-trips: an exported #UB reads back as the same #IB balances", async () => {
    const { user, year } = await setupEconomy();
    await bookManual(user.id, `${YEAR}-01-02`, [["1930", 25000], ["2081", -25000]], "Aktiekapital");

    const exported = decodeCp437((await sie.exportFiscalYear(year.id, "urban")).content);
    // What a real year-end hand-over does: this year's closing balances
    // become next year's opening ones.
    const ub = exported
      .split("\r\n")
      .filter((line) => line.startsWith("#UB 0 "))
      .map((line) => line.replace("#UB 0 ", "#IB 0 "));
    const parsed = parseSieFile(
      sieFile([`#RAR 0 ${YEAR + 1}0101 ${YEAR + 1}1231`, ...ub])
    );

    expect(parsed.openingBalances).toEqual(
      expect.arrayContaining([
        { accountNumber: "1930", amount: 25000 },
        { accountNumber: "2081", amount: -25000 },
      ])
    );
    // And the file our exporter wrote is itself internally consistent.
    expect(round2(parsed.openingBalances.reduce((sum, row) => sum + row.amount, 0))).toBe(0);
  });
});
