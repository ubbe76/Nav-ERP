import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { AccountNotFoundError, createEconomyService } from "../src/modules/economy/service/economy.service.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
const auditRepository = createAuditRepository(db);
const service = createEconomyService(repo, auditRepository);

const TRUNCATE = sql`TRUNCATE verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser(name = "Ekonomiadmin") {
  return authRepo.create({
    email: `economy-ledger-${crypto.randomUUID()}@example.com`,
    passwordHash: "not-a-real-hash",
    name,
    role: "admin",
  });
}

async function makeFiscalYear(label: string, startDate: string, endDate: string) {
  return service.createFiscalYear({ label, startDate, endDate });
}

async function makeSeries(code = "A", name = "Manuella verifikat") {
  return service.createSeries({ code, name });
}

async function makeAccount(number: string, name: string) {
  return service.createAccount({ number, name });
}

// Shared setup: one fiscal year (2026), one series, and two accounts ready to
// form a balanced 2-row verification (bank debited, revenue credited).
async function setupEconomy() {
  const user = await makeUser();
  await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
  const series = await makeSeries();
  const bank = await makeAccount("1930", "Företagskonto/checkkonto");
  const revenue = await makeAccount("3001", "Försäljning");
  return { user, series, bank, revenue };
}

// Creates and immediately books a balanced verification (bank debit / revenue
// credit for `amount`) on `date` — the common two-row shape used throughout
// this file to build up ledger history.
async function bookEntry(
  series: { id: string },
  bank: { id: string },
  revenue: { id: string },
  userId: string,
  date: string,
  amount: number,
  description = "Kontantförsäljning"
) {
  const draft = await service.createVerification(
    {
      seriesId: series.id,
      date,
      description,
      rows: [
        { accountId: bank.id, debit: amount, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: amount },
      ],
    },
    userId
  );
  return service.book(draft.id, userId);
}

describe("economy service — getLedger: opening balance with no history", () => {
  it("returns opening balance 0 and no rows for an account with no verifications at all", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");

    const ledger = await service.getLedger({ accountId: bank.id });

    expect(ledger.openingBalance).toBe(0);
    expect(ledger.closingBalance).toBe(0);
    expect(ledger.rows).toEqual([]);
    expect(user).toBeDefined();
  });

  it("throws AccountNotFoundError for a non-existent accountId", async () => {
    await expect(service.getLedger({ accountId: "00000000-0000-0000-0000-000000000000" })).rejects.toBeInstanceOf(
      AccountNotFoundError
    );
  });
});

describe("economy service — getLedger: opening balance across months, running balance, closing balance", () => {
  it("carries month 1's net into month 2's opening balance, and computes a running balance per row", async () => {
    const { user, series, bank, revenue } = await setupEconomy();

    // Month 1: two bookings on the bank account (debit side): net +1500.
    await bookEntry(series, bank, revenue, user.id, "2026-01-10", 1000, "Försäljning 1");
    await bookEntry(series, bank, revenue, user.id, "2026-01-20", 500, "Försäljning 2");
    // Month 2: one more booking: +200.
    await bookEntry(series, bank, revenue, user.id, "2026-02-05", 200, "Försäljning 3");

    // Ledger for month 1 alone: no prior history, so IB = 0; running balance
    // accumulates row by row; UB = IB + period's net (1000 + 500 = 1500).
    const month1 = await service.getLedger({ accountId: bank.id, from: "2026-01-01", to: "2026-01-31" });
    expect(month1.openingBalance).toBe(0);
    expect(month1.rows).toHaveLength(2);
    expect(month1.rows[0]?.balance).toBe(1000);
    expect(month1.rows[1]?.balance).toBe(1500);
    expect(month1.closingBalance).toBe(1500);

    // Ledger for month 2 alone: IB must equal month 1's net (1500) exactly —
    // never stored, always re-derived from booked history before `from`.
    const month2 = await service.getLedger({ accountId: bank.id, from: "2026-02-01", to: "2026-02-28" });
    expect(month2.openingBalance).toBe(1500);
    expect(month2.rows).toHaveLength(1);
    expect(month2.rows[0]?.balance).toBe(1700);
    expect(month2.closingBalance).toBe(1700);
  });

  it("never counts a draft, even one dated inside the queried range", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    await bookEntry(series, bank, revenue, user.id, "2026-03-10", 100);

    // A big draft, never booked, sitting right in the middle of the range.
    await service.createVerification(
      {
        seriesId: series.id,
        date: "2026-03-15",
        description: "Utkast som aldrig bokförs",
        rows: [
          { accountId: bank.id, debit: 99999, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 99999 },
        ],
      },
      user.id
    );

    const ledger = await service.getLedger({ accountId: bank.id, from: "2026-03-01", to: "2026-03-31" });
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.closingBalance).toBe(100);
  });
});

describe("economy service — getLedger: credit-account sign convention", () => {
  it("gives a credit-heavy account (e.g. 3001 Försäljning) a negative running balance under the debit-credit convention", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    await bookEntry(series, bank, revenue, user.id, "2026-04-01", 1000, "Försäljning A");
    await bookEntry(series, bank, revenue, user.id, "2026-04-02", 500, "Försäljning B");

    const ledger = await service.getLedger({ accountId: revenue.id, from: "2026-04-01", to: "2026-04-30" });

    expect(ledger.rows).toHaveLength(2);
    // Revenue is only ever credited here, so debit - credit is negative on
    // every row — assert the sign explicitly, not just the magnitude.
    expect(ledger.rows[0]?.balance).toBeLessThan(0);
    expect(ledger.rows[0]?.balance).toBe(-1000);
    expect(ledger.rows[1]?.balance).toBeLessThan(0);
    expect(ledger.rows[1]?.balance).toBe(-1500);
    expect(ledger.closingBalance).toBe(-1500);
    expect(ledger.closingBalance).toBeLessThan(0);
  });
});

describe("economy service — getLedger: interval filtering exact on boundary dates", () => {
  it("includes a row dated exactly `from` and one dated exactly `to`, excluding rows outside on either side", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    await bookEntry(series, bank, revenue, user.id, "2026-05-09", 10, "Före intervallet");
    await bookEntry(series, bank, revenue, user.id, "2026-05-10", 20, "På from-gränsen");
    await bookEntry(series, bank, revenue, user.id, "2026-05-15", 40, "Mitt i intervallet");
    await bookEntry(series, bank, revenue, user.id, "2026-05-20", 80, "På to-gränsen");
    await bookEntry(series, bank, revenue, user.id, "2026-05-21", 160, "Efter intervallet");

    const ledger = await service.getLedger({ accountId: bank.id, from: "2026-05-10", to: "2026-05-20" });

    expect(ledger.rows.map((r) => r.description)).toEqual(["På from-gränsen", "Mitt i intervallet", "På to-gränsen"]);
    // IB must include everything strictly before `from` (only the 2026-05-09
    // row: 10) — not the from-day row itself.
    expect(ledger.openingBalance).toBe(10);
    expect(ledger.closingBalance).toBe(10 + 20 + 40 + 80);
  });

  it("orders rows by (date, verificationNumber) and includes seriesCode/yearLabel/verificationId/displayNumber per row", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const first = await bookEntry(series, bank, revenue, user.id, "2026-06-01", 10, "Första");
    const second = await bookEntry(series, bank, revenue, user.id, "2026-06-01", 20, "Andra samma dag");

    const ledger = await service.getLedger({ accountId: bank.id, from: "2026-06-01", to: "2026-06-01" });

    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]?.verificationId).toBe(first.id);
    expect(ledger.rows[1]?.verificationId).toBe(second.id);
    expect(ledger.rows[0]?.seriesCode).toBe(series.code);
    expect(ledger.rows[0]?.yearLabel).toBe("2026");
    expect(ledger.rows[0]?.displayNumber).toBe(first.displayNumber);
    expect(ledger.rows[1]?.displayNumber).toBe(second.displayNumber);
  });
});
