import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accountingPeriods, auditLog, db, verificationRows, verifications } from "@navet/db";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import {
  AccountingPeriodLockedError,
  InactiveAccountError,
  InvalidVerificationStateError,
  UnbalancedVerificationError,
  VerificationNotFoundError,
  createEconomyService,
} from "../src/modules/economy/service/economy.service.js";
import { stockholmToday } from "../src/modules/system/service/delivery-days.js";

// Snabbare manuell bokföring: PUT rows (replace-the-set), POST with
// book: true (create + book in one transaction) and Kopiera — the service
// against Postgres.

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
const service = createEconomyService(repo, createAuditRepository(db));

const TRUNCATE = sql`TRUNCATE verification_files, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});
afterAll(async () => {
  await db.execute(TRUNCATE);
});

const YEAR = new Date().getFullYear();
const DATE = `${YEAR}-03-15`;

async function setup() {
  const user = await authRepo.create({ email: `rows-${crypto.randomUUID()}@example.com`, passwordHash: "x", name: "Ekonom", role: "admin" });
  await service.createFiscalYear({ label: String(YEAR), startDate: `${YEAR}-01-01`, endDate: `${YEAR}-12-31` });
  const series = await service.createSeries({ code: "A", name: "Manuella verifikat" });
  const bank = await service.createAccount({ number: "1930", name: "Företagskonto" });
  const revenue = await service.createAccount({ number: "3001", name: "Försäljning" });
  const vat = await service.createAccount({ number: "2610", name: "Utgående moms 25 %" });
  return { user, series, bank, revenue, vat };
}

async function rowCount(verificationId: string) {
  const rows = await db.select().from(verificationRows).where(eq(verificationRows.verificationId, verificationId));
  return rows.length;
}

describe("replaceRows (PUT /verifications/:id/rows)", () => {
  it("replaces the whole row set on a draft, in input order", async () => {
    const { user, series, bank, revenue, vat } = await setup();
    const draft = await service.createVerification(
      { seriesId: series.id, date: DATE, description: "Kontant", rows: [{ accountId: bank.id, debit: 100, credit: 0 }], book: false },
      user.id
    );
    const replaced = await service.replaceRows(draft.id, [
      { accountId: bank.id, debit: 125, credit: 0, description: "Inbetalning" },
      { accountId: revenue.id, debit: 0, credit: 100 },
      { accountId: vat.id, debit: 0, credit: 25 },
    ]);
    expect(replaced.rows.map((r) => [r.accountNumber, Number(r.debit), Number(r.credit), r.description])).toEqual([
      ["1930", 125, 0, "Inbetalning"],
      ["3001", 0, 100, null],
      ["2610", 0, 25, null],
    ]);
    expect(await rowCount(draft.id)).toBe(3);
  });

  it("accepts an empty list (clears the draft)", async () => {
    const { user, series, bank, revenue } = await setup();
    const draft = await service.createVerification(
      {
        seriesId: series.id,
        date: DATE,
        description: "X",
        rows: [
          { accountId: bank.id, debit: 1, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 1 },
        ],
        book: false,
      },
      user.id
    );
    const replaced = await service.replaceRows(draft.id, []);
    expect(replaced.rows).toEqual([]);
  });

  it("refuses a booked verification and leaves its rows alone", async () => {
    const { user, series, bank, revenue } = await setup();
    const booked = await service.createVerification(
      {
        seriesId: series.id,
        date: DATE,
        description: "X",
        rows: [
          { accountId: bank.id, debit: 1, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 1 },
        ],
        book: true,
      },
      user.id
    );
    await expect(service.replaceRows(booked.id, [{ accountId: bank.id, debit: 5, credit: 0 }])).rejects.toThrow(InvalidVerificationStateError);
    expect(await rowCount(booked.id)).toBe(2);
  });

  it("refuses an inactive account before writing anything", async () => {
    const { user, series, bank, revenue } = await setup();
    const draft = await service.createVerification(
      { seriesId: series.id, date: DATE, description: "X", rows: [{ accountId: bank.id, debit: 1, credit: 0 }], book: false },
      user.id
    );
    await service.updateAccount(revenue.id, { active: false });
    await expect(
      service.replaceRows(draft.id, [
        { accountId: bank.id, debit: 9, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: 9 },
      ])
    ).rejects.toThrow(InactiveAccountError);
    expect((await service.findVerificationById(draft.id)).rows.map((r) => Number(r.debit))).toEqual([1]);
  });

  it("loses to a booking that landed between the status check and the write", async () => {
    const { user, series, bank, revenue } = await setup();
    const draft = await service.createVerification(
      {
        seriesId: series.id,
        date: DATE,
        description: "X",
        rows: [
          { accountId: bank.id, debit: 1, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 1 },
        ],
        book: false,
      },
      user.id
    );
    // Simulate the race: the repo-level replace runs against a row that was
    // booked after the service's own fast-path read.
    await service.book(draft.id, user.id);
    const result = await repo.replaceRows(draft.id, [{ accountId: bank.id, debit: 5, credit: 0, description: null }]);
    expect(result).toBeNull();
    expect(await rowCount(draft.id)).toBe(2);
  });

  it("404s an unknown verification", async () => {
    await setup();
    await expect(service.replaceRows(crypto.randomUUID(), [])).rejects.toThrow(VerificationNotFoundError);
  });
});

describe("createVerification with book: true (Spara och bokför)", () => {
  it("creates and books in one go, with a number and the audit entry", async () => {
    const { user, series, bank, revenue } = await setup();
    const booked = await service.createVerification(
      {
        seriesId: series.id,
        date: DATE,
        description: "Kontantförsäljning",
        rows: [
          { accountId: bank.id, debit: 500, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 500 },
        ],
        book: true,
      },
      user.id
    );
    expect(booked.status).toBe("booked");
    expect(booked.displayNumber).toBe(`A-${YEAR}-1`);
    expect(booked.bookedBy).toBe(user.id);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "verification"), eq(auditLog.action, "booked")));
    expect(audits.map((a) => a.entityId)).toEqual([`A-${YEAR}-1`]);
  });

  it("leaves nothing behind when the booking is refused (unbalanced)", async () => {
    const { user, series, bank, revenue } = await setup();
    await expect(
      service.createVerification(
        {
          seriesId: series.id,
          date: DATE,
          description: "Fel",
          rows: [
            { accountId: bank.id, debit: 500, credit: 0 },
            { accountId: revenue.id, debit: 0, credit: 400 },
          ],
          book: true,
        },
        user.id
      )
    ).rejects.toThrow(UnbalancedVerificationError);
    expect(await db.select().from(verifications)).toEqual([]);
  });

  it("leaves nothing behind in a locked period, and the next booking still gets number 1", async () => {
    const { user, series, bank, revenue } = await setup();
    const [period] = await db.select().from(accountingPeriods).where(eq(accountingPeriods.startDate, `${YEAR}-03-01`));
    await service.lockPeriod(period!.id, user.id);
    const rows = [
      { accountId: bank.id, debit: 5, credit: 0 },
      { accountId: revenue.id, debit: 0, credit: 5 },
    ];
    await expect(
      service.createVerification({ seriesId: series.id, date: DATE, description: "Låst", rows, book: true }, user.id)
    ).rejects.toThrow(AccountingPeriodLockedError);
    expect(await db.select().from(verifications)).toEqual([]);
    const ok = await service.createVerification({ seriesId: series.id, date: `${YEAR}-04-02`, description: "Öppen", rows, book: true }, user.id);
    expect(ok.displayNumber).toBe(`A-${YEAR}-1`);
  });

  it("book: false (the default) still creates a plain draft", async () => {
    const { user, series, bank } = await setup();
    const draft = await service.createVerification(
      { seriesId: series.id, date: DATE, description: "Utkast", rows: [{ accountId: bank.id, debit: 1, credit: 0 }], book: false },
      user.id
    );
    expect(draft.status).toBe("draft");
  });
});

describe("copy (Kopiera)", () => {
  it("makes a new draft with the same series, description and rows, dated today", async () => {
    const { user, series, bank, revenue } = await setup();
    const source = await service.createVerification(
      {
        seriesId: series.id,
        date: DATE,
        description: "Hyra mars",
        rows: [
          { accountId: bank.id, debit: 0, credit: 8000, description: "Betalning" },
          { accountId: revenue.id, debit: 8000, credit: 0 },
        ],
        book: true,
      },
      user.id
    );
    const { verification, warnings } = await service.copy(source.id, user.id);
    expect(warnings).toEqual([]);
    expect(verification.id).not.toBe(source.id);
    expect(verification.status).toBe("draft");
    expect(verification.seriesId).toBe(series.id);
    expect(verification.description).toBe("Hyra mars");
    expect(verification.date).toBe(stockholmToday());
    expect(verification.rows.map((r) => [r.accountNumber, Number(r.debit), Number(r.credit), r.description])).toEqual([
      ["1930", 0, 8000, "Betalning"],
      ["3001", 8000, 0, null],
    ]);
    // The source is untouched.
    expect((await service.findVerificationById(source.id)).status).toBe("booked");
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "copied"));
    expect(audits).toHaveLength(1);
  });

  it("leaves out a row on an account that has been deactivated and says so", async () => {
    const { user, series, bank, revenue } = await setup();
    const source = await service.createVerification(
      {
        seriesId: series.id,
        date: DATE,
        description: "X",
        rows: [
          { accountId: bank.id, debit: 10, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 10 },
        ],
        book: true,
      },
      user.id
    );
    await service.updateAccount(revenue.id, { active: false });
    const { verification, warnings } = await service.copy(source.id, user.id);
    expect(verification.rows.map((r) => r.accountNumber)).toEqual(["1930"]);
    expect(warnings).toEqual(["Konto 3001 Försäljning är inaktivt — raden utelämnades"]);
  });

  it("404s an unknown source", async () => {
    const { user } = await setup();
    await expect(service.copy(crypto.randomUUID(), user.id)).rejects.toThrow(VerificationNotFoundError);
  });
});
