import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { accountingPeriods, auditLog, db, users, verificationRows, verifications } from "@navet/db";
import { verificationRowInputSchema } from "@navet/shared";
import { createAuthRepository } from "../src/modules/auth/repository/auth.repository.js";
import { createEconomyRepository } from "../src/modules/economy/repository/economy.repository.js";
import { createAuditRepository } from "../src/modules/system/repository/audit.repository.js";
import {
  AccountNotFoundError,
  AccountingPeriodLockedError,
  AlreadyReversedError,
  InactiveAccountError,
  InvalidVerificationStateError,
  NoAccountingPeriodError,
  NoFiscalYearForDateError,
  TooFewVerificationRowsError,
  UnbalancedVerificationError,
  VerificationNotFoundError,
  VerificationRowNotFoundError,
  VerificationFileLockedError,
  VerificationFileNotFoundError,
  InvalidVerificationFileTypeError,
  VerificationSeriesNotFoundError,
  createEconomyService,
} from "../src/modules/economy/service/economy.service.js";

const repo = createEconomyRepository(db);
const authRepo = createAuthRepository(db);
// Task 7 needs to assert on the "booked"/"reversal_created" audit trail, so
// this file switched from the no-op stub (still used by economy-accounts.
// test.ts) to the real audit repository, same as economy-fiscal-years.test.ts.
const auditRepository = createAuditRepository(db);
const service = createEconomyService(repo, auditRepository);

const TRUNCATE = sql`TRUNCATE verification_files, verification_rows, verifications, verification_counters, verification_series, accounting_periods, fiscal_years, accounts, audit_log, users CASCADE`;

beforeEach(async () => {
  await db.execute(TRUNCATE);
});

afterAll(async () => {
  await db.execute(TRUNCATE);
});

async function makeUser(name = "Ekonomiadmin") {
  return authRepo.create({
    email: `economy-verifications-${crypto.randomUUID()}@example.com`,
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

async function auditRows(entityType: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.action, action)));
}

async function makeAccount(number: string, name: string) {
  return service.createAccount({ number, name });
}

// setupEconomy()'s fiscal year MUST cover "today": the reverse() tests below
// stamp the mirrored draft with the real current date
// (new Date().toLocaleDateString("sv-SE")), so a year hardcoded to a fixed
// label/range would go red the moment the real calendar rolls past it (e.g.
// 2026-12-31 -> 2027-01-01) — derived once here instead.
const CURRENT_YEAR = new Date().getFullYear();
const FISCAL_YEAR_LABEL = String(CURRENT_YEAR);
const FISCAL_YEAR_START = `${CURRENT_YEAR}-01-01`;
const FISCAL_YEAR_END = `${CURRENT_YEAR}-12-31`;
const DEFAULT_VERIFICATION_DATE = `${CURRENT_YEAR}-03-15`;

// Shared setup for the booking/reverse tests below: one fiscal year (covers
// "today", see above), one series, and two accounts ready to form a
// balanced 2-row draft.
async function setupEconomy() {
  const user = await makeUser();
  await makeFiscalYear(FISCAL_YEAR_LABEL, FISCAL_YEAR_START, FISCAL_YEAR_END);
  const series = await makeSeries();
  const bank = await makeAccount("1930", "Företagskonto/checkkonto");
  const revenue = await makeAccount("3001", "Försäljning");
  return { user, series, bank, revenue };
}

async function makeBalancedDraft(
  series: { id: string },
  bank: { id: string },
  revenue: { id: string },
  userId: string,
  overrides?: { date?: string; description?: string; amount?: number }
) {
  const amount = overrides?.amount ?? 500;
  return service.createVerification(
    {
      seriesId: series.id,
      date: overrides?.date ?? DEFAULT_VERIFICATION_DATE,
      description: overrides?.description ?? "Kontantförsäljning",
      rows: [
        { accountId: bank.id, debit: amount, credit: 0 },
        { accountId: revenue.id, debit: 0, credit: amount },
      ],
    },
    userId
  );
}

describe("economy service — verifications: create", () => {
  it("creates a draft with rows, rounding amounts to 2 decimals", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");
    const revenue = await makeAccount("3001", "Försäljning");

    const created = await service.createVerification(
      {
        seriesId: series.id,
        date: "2026-03-15",
        description: "Kontantförsäljning",
        rows: [
          { accountId: bank.id, debit: 100.005, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 100.005 },
        ],
      },
      user.id
    );

    expect(created.status).toBe("draft");
    expect(created.displayNumber).toBe("Utkast");
    expect(created.rows).toHaveLength(2);
    // round2's Number.EPSILON nudge: 100.005 -> 100.01 (matches round2's own
    // documented one-sided behavior, see money.ts).
    expect(created.rows.map((r) => Number(r.debit))).toContain(100.01);
    expect(created.rows.map((r) => Number(r.credit))).toContain(100.01);
    expect(created.rows[0]?.accountNumber).toBeDefined();
    expect(created.rows[0]?.accountName).toBeDefined();
  });

  it("creates a draft with no rows (rows optional at create)", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();

    const created = await service.createVerification(
      { seriesId: series.id, date: "2026-03-15", description: "Tom utkast", rows: [] },
      user.id
    );

    expect(created.rows).toEqual([]);
  });

  it("rejects a date with no covering fiscal year (400/NoFiscalYearForDateError)", async () => {
    const user = await makeUser();
    const series = await makeSeries();

    await expect(
      service.createVerification({ seriesId: series.id, date: "2025-06-15", description: "X", rows: [] }, user.id)
    ).rejects.toBeInstanceOf(NoFiscalYearForDateError);
  });

  it("rejects a non-existent seriesId (mapped 404, not a raw FK violation)", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");

    await expect(
      service.createVerification(
        { seriesId: "00000000-0000-0000-0000-000000000000", date: "2026-03-15", description: "X", rows: [] },
        user.id
      )
    ).rejects.toBeInstanceOf(VerificationSeriesNotFoundError);
  });

  it("rejects a row referencing a non-existent account", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();

    await expect(
      service.createVerification(
        {
          seriesId: series.id,
          date: "2026-03-15",
          description: "X",
          rows: [{ accountId: "00000000-0000-0000-0000-000000000000", debit: 100, credit: 0 }],
        },
        user.id
      )
    ).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("rejects a row referencing an inactive account", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");
    await service.updateAccount(bank.id, { active: false });

    await expect(
      service.createVerification(
        { seriesId: series.id, date: "2026-03-15", description: "X", rows: [{ accountId: bank.id, debit: 100, credit: 0 }] },
        user.id
      )
    ).rejects.toBeInstanceOf(InactiveAccountError);
  });

  it("throws VerificationNotFoundError for a missing id", async () => {
    await expect(service.findVerificationById("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      VerificationNotFoundError
    );
  });
});

describe("verificationRowInputSchema — debit XOR credit", () => {
  it("rejects a row with both debit and credit > 0", () => {
    expect(
      verificationRowInputSchema.safeParse({ accountId: "00000000-0000-0000-0000-000000000000", debit: 100, credit: 50 })
        .success
    ).toBe(false);
  });

  it("rejects a row with both debit and credit = 0", () => {
    expect(
      verificationRowInputSchema.safeParse({ accountId: "00000000-0000-0000-0000-000000000000", debit: 0, credit: 0 })
        .success
    ).toBe(false);
  });

  it("accepts a row with exactly one of debit/credit > 0", () => {
    expect(
      verificationRowInputSchema.safeParse({ accountId: "00000000-0000-0000-0000-000000000000", debit: 100, credit: 0 })
        .success
    ).toBe(true);
    expect(
      verificationRowInputSchema.safeParse({ accountId: "00000000-0000-0000-0000-000000000000", debit: 0, credit: 100 })
        .success
    ).toBe(true);
  });
});

describe("economy service — verifications: list, filter, search", () => {
  it("lists, filters by fiscalYearId/seriesId/status, and searches on description", async () => {
    const user = await makeUser();
    const year2026 = await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const year2027 = await makeFiscalYear("2027", "2027-01-01", "2027-12-31");
    const seriesA = await makeSeries("A", "Manuella verifikat");
    const seriesB = await makeSeries("B", "Andra verifikat");
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");
    const revenue = await makeAccount("3001", "Försäljning");

    const v1 = await service.createVerification(
      { seriesId: seriesA.id, date: "2026-03-15", description: "Hyra lokal mars", rows: [] },
      user.id
    );
    const v2 = await service.createVerification(
      { seriesId: seriesB.id, date: "2026-04-01", description: "Kontorsmaterial", rows: [] },
      user.id
    );
    const v3 = await service.createVerification(
      { seriesId: seriesA.id, date: "2027-01-10", description: "Hyra lokal januari", rows: [] },
      user.id
    );

    const all = await service.listVerifications({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const byYear = await service.listVerifications({ limit: 50, offset: 0, fiscalYearId: year2026.id });
    expect(byYear.rows.map((r) => r.id).sort()).toEqual([v1.id, v2.id].sort());

    const bySeries = await service.listVerifications({ limit: 50, offset: 0, seriesId: seriesA.id });
    expect(bySeries.rows.map((r) => r.id).sort()).toEqual([v1.id, v3.id].sort());

    const bySearch = await service.listVerifications({ limit: 50, offset: 0, search: "hyra" });
    expect(bySearch.total).toBe(2);

    const searchNoHit = await service.listVerifications({ limit: 50, offset: 0, search: "nomatch" });
    expect(searchNoHit.total).toBe(0);

    // Every fresh verification is a draft — displayNumber must read "Utkast".
    for (const row of all.rows) {
      expect(row.displayNumber).toBe("Utkast");
    }

    const byStatusDraft = await service.listVerifications({ limit: 50, offset: 0, status: ["draft"] });
    expect(byStatusDraft.total).toBe(3);
    const byStatusBooked = await service.listVerifications({ limit: 50, offset: 0, status: ["booked"] });
    expect(byStatusBooked.total).toBe(0);

    // Simulate a booked verification directly (booking itself is Task 7) to
    // verify the displayNumber assembly rule: "<seriesCode>-<yearLabel>-<n>".
    await db
      .update(verifications)
      .set({ status: "booked", verificationNumber: 17 })
      .where(eq(verifications.id, v1.id));

    const afterBooking = await service.findVerificationById(v1.id);
    expect(afterBooking.displayNumber).toBe("A-2026-17");
    expect(afterBooking.status).toBe("booked");

    const byStatusBookedAfter = await service.listVerifications({ limit: 50, offset: 0, status: ["booked"] });
    expect(byStatusBookedAfter.total).toBe(1);
    expect(byStatusBookedAfter.rows[0]?.displayNumber).toBe("A-2026-17");

    // Silence unused-var lint for rows not otherwise referenced by id.
    expect([bank.id, revenue.id].every((id) => typeof id === "string")).toBe(true);
  });

  it("paginates with limit/offset", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();
    for (let i = 0; i < 3; i++) {
      await service.createVerification({ seriesId: series.id, date: "2026-03-15", description: `V${i}`, rows: [] }, user.id);
    }

    const page1 = await service.listVerifications({ limit: 2, offset: 0 });
    const page2 = await service.listVerifications({ limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);
  });
});

describe("economy service — verifications: row editing on a draft", () => {
  it("adds, updates (full-replace) and deletes a row", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");
    const revenue = await makeAccount("3001", "Försäljning");
    const other = await makeAccount("3002", "Övrig försäljning");

    const created = await service.createVerification(
      { seriesId: series.id, date: "2026-03-15", description: "Test", rows: [] },
      user.id
    );

    const row = await service.addRow(created.id, { accountId: bank.id, debit: 200, credit: 0 });
    expect(Number(row.debit)).toBe(200);

    const updated = await service.updateRow(created.id, row.id, { accountId: revenue.id, debit: 0, credit: 200.005 });
    expect(updated.accountId).toBe(revenue.id);
    expect(Number(updated.credit)).toBe(200.01);

    await service.deleteRow(created.id, updated.id);
    const afterDelete = await service.findVerificationById(created.id);
    expect(afterDelete.rows).toHaveLength(0);

    // Silence unused-var lint.
    expect(other.id).toBeDefined();
  });

  it("throws VerificationRowNotFoundError for updating/deleting a row that doesn't belong to the verification", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");

    const v1 = await service.createVerification(
      { seriesId: series.id, date: "2026-03-15", description: "V1", rows: [] },
      user.id
    );
    const v2 = await service.createVerification(
      { seriesId: series.id, date: "2026-03-16", description: "V2", rows: [] },
      user.id
    );
    const rowOnV1 = await service.addRow(v1.id, { accountId: bank.id, debit: 100, credit: 0 });

    await expect(
      service.updateRow(v2.id, rowOnV1.id, { accountId: bank.id, debit: 50, credit: 0 })
    ).rejects.toBeInstanceOf(VerificationRowNotFoundError);
    await expect(service.deleteRow(v2.id, rowOnV1.id)).rejects.toBeInstanceOf(VerificationRowNotFoundError);
  });

  it("updates the header (series/date/description) while draft", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const seriesA = await makeSeries("A", "Manuella verifikat");
    const seriesB = await makeSeries("B", "Andra verifikat");

    const created = await service.createVerification(
      { seriesId: seriesA.id, date: "2026-03-15", description: "Original", rows: [] },
      user.id
    );

    const updated = await service.updateVerificationHeader(created.id, { seriesId: seriesB.id, description: "Ändrad" });
    expect(updated.seriesId).toBe(seriesB.id);
    expect(updated.description).toBe("Ändrad");
  });

  it("rejects a header PATCH moving to a non-existent seriesId", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();

    const created = await service.createVerification(
      { seriesId: series.id, date: "2026-03-15", description: "Original", rows: [] },
      user.id
    );

    await expect(
      service.updateVerificationHeader(created.id, { seriesId: "00000000-0000-0000-0000-000000000000" })
    ).rejects.toBeInstanceOf(VerificationSeriesNotFoundError);
  });

  it("deletes a draft verification (cascades its rows)", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");

    const created = await service.createVerification(
      { seriesId: series.id, date: "2026-03-15", description: "X", rows: [{ accountId: bank.id, debit: 10, credit: 0 }] },
      user.id
    );

    await service.deleteVerification(created.id);
    await expect(service.findVerificationById(created.id)).rejects.toBeInstanceOf(VerificationNotFoundError);
  });
});

describe("economy service — verifications: date change across a fiscal year boundary", () => {
  it("re-resolves fiscalYearId when the date moves to a different fiscal year", async () => {
    const user = await makeUser();
    const year2026 = await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const year2027 = await makeFiscalYear("2027", "2027-01-01", "2027-12-31");
    const series = await makeSeries();

    const created = await service.createVerification(
      { seriesId: series.id, date: "2026-12-20", description: "Årsskifte", rows: [] },
      user.id
    );
    expect(created.fiscalYearId).toBe(year2026.id);

    const moved = await service.updateVerificationHeader(created.id, { date: "2027-01-05" });
    expect(moved.fiscalYearId).toBe(year2027.id);
    expect(moved.date).toBe("2027-01-05");
  });

  it("rejects moving the date to one with no covering fiscal year", async () => {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();

    const created = await service.createVerification(
      { seriesId: series.id, date: "2026-06-15", description: "X", rows: [] },
      user.id
    );

    await expect(service.updateVerificationHeader(created.id, { date: "2025-01-01" })).rejects.toBeInstanceOf(
      NoFiscalYearForDateError
    );
  });
});

describe("economy repository — draft status required for every write path", () => {
  async function makeBookedVerification() {
    const user = await makeUser();
    await makeFiscalYear("2026", "2026-01-01", "2026-12-31");
    const series = await makeSeries();
    const bank = await makeAccount("1930", "Företagskonto/checkkonto");
    const created = await service.createVerification(
      { seriesId: series.id, date: "2026-03-15", description: "X", rows: [{ accountId: bank.id, debit: 10, credit: 0 }] },
      user.id
    );
    // Booking itself is Task 7 — flip the status directly to simulate an
    // already-booked verification for these repo-level guard tests.
    await db.update(verifications).set({ status: "booked" }).where(eq(verifications.id, created.id));
    const row = created.rows[0]!;
    return { verificationId: created.id, rowId: row.id, bank };
  }

  it("updateVerificationHeader returns null on a booked verification", async () => {
    const { verificationId } = await makeBookedVerification();
    expect(await repo.updateVerificationHeader(verificationId, { description: "Ny text" })).toBeNull();
  });

  it("addRow returns null on a booked verification", async () => {
    const { verificationId, bank } = await makeBookedVerification();
    expect(await repo.addRow(verificationId, { accountId: bank.id, debit: 5, credit: 0, description: null })).toBeNull();
  });

  it("updateRow returns null on a booked verification", async () => {
    const { verificationId, rowId, bank } = await makeBookedVerification();
    expect(
      await repo.updateRow(verificationId, rowId, { accountId: bank.id, debit: 20, credit: 0, description: null })
    ).toBeNull();
  });

  it("deleteRow returns null on a booked verification", async () => {
    const { verificationId, rowId } = await makeBookedVerification();
    expect(await repo.deleteRow(verificationId, rowId)).toBeNull();
  });

  it("deleteVerification returns null on a booked verification", async () => {
    const { verificationId } = await makeBookedVerification();
    expect(await repo.deleteVerification(verificationId)).toBeNull();
  });

  it("service maps every repo-level null to InvalidVerificationStateError", async () => {
    const { verificationId, rowId } = await makeBookedVerification();
    const bank = await makeAccount("1940", "Övrigt bankkonto");

    await expect(
      service.updateVerificationHeader(verificationId, { description: "X" })
    ).rejects.toBeInstanceOf(InvalidVerificationStateError);
    await expect(
      service.addRow(verificationId, { accountId: bank.id, debit: 5, credit: 0 })
    ).rejects.toBeInstanceOf(InvalidVerificationStateError);
    await expect(
      service.updateRow(verificationId, rowId, { accountId: bank.id, debit: 5, credit: 0 })
    ).rejects.toBeInstanceOf(InvalidVerificationStateError);
    await expect(service.deleteRow(verificationId, rowId)).rejects.toBeInstanceOf(InvalidVerificationStateError);
    await expect(service.deleteVerification(verificationId)).rejects.toBeInstanceOf(InvalidVerificationStateError);
  });
});

describe("economy service — booking (book): guards and success", () => {
  it("books a balanced draft: number 1, status booked, bookedAt/bookedBy set, audit logged", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);

    const booked = await service.book(draft.id, user.id);

    expect(booked.status).toBe("booked");
    expect(booked.verificationNumber).toBe(1);
    expect(booked.displayNumber).toBe(`${series.code}-${FISCAL_YEAR_LABEL}-1`);
    expect(booked.bookedAt).toBeTruthy();
    expect(booked.bookedBy).toBe(user.id);

    const entries = await auditRows("verification", "booked");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityId: booked.displayNumber, userId: user.id });
  });

  it("joins the creator's and booker's names on the detail, soft-deleted users included", async () => {
    const { user: creator, series, bank, revenue } = await setupEconomy();
    const booker = await makeUser("Bokförare Berg");
    const draft = await makeBalancedDraft(series, bank, revenue, creator.id);
    expect(await service.findVerificationById(draft.id)).toMatchObject({ createdByName: "Ekonomiadmin", bookedByName: null });

    await service.book(draft.id, booker.id);
    // The signature must outlive the account (soft delete keeps the row).
    await db.update(users).set({ deletedAt: new Date(), active: false }).where(eq(users.id, booker.id));
    expect(await service.findVerificationById(draft.id)).toMatchObject({
      createdByName: "Ekonomiadmin",
      bookedBy: booker.id,
      bookedByName: "Bokförare Berg",
    });
  });

  it("throws VerificationNotFoundError for a missing id", async () => {
    const user = await makeUser();
    await expect(service.book("00000000-0000-0000-0000-000000000000", user.id)).rejects.toBeInstanceOf(
      VerificationNotFoundError
    );
  });

  it("rejects booking an already-booked verification (InvalidVerificationStateError)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    await service.book(draft.id, user.id);

    await expect(service.book(draft.id, user.id)).rejects.toBeInstanceOf(InvalidVerificationStateError);
  });

  it("rejects a verification with fewer than 2 rows (TooFewVerificationRowsError)", async () => {
    const { user, series, bank } = await setupEconomy();
    const draft = await service.createVerification(
      {
        seriesId: series.id,
        date: DEFAULT_VERIFICATION_DATE,
        description: "En rad",
        rows: [{ accountId: bank.id, debit: 100, credit: 0 }],
      },
      user.id
    );

    await expect(service.book(draft.id, user.id)).rejects.toBeInstanceOf(TooFewVerificationRowsError);
  });

  it("rejects an unbalanced verification by 1 öre, with the difference in the error message", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await service.createVerification(
      {
        seriesId: series.id,
        date: DEFAULT_VERIFICATION_DATE,
        description: "Obalans",
        rows: [
          { accountId: bank.id, debit: 100, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 99.99 },
        ],
      },
      user.id
    );

    await expect(service.book(draft.id, user.id)).rejects.toBeInstanceOf(UnbalancedVerificationError);
    await expect(service.book(draft.id, user.id)).rejects.toThrow(/0\.01/);
  });

  it("accepts an öre-level sum across three debit rows against one credit row (0.10+0.10+0.10 = 0.30)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const other1 = await makeAccount("1940", "Övrigt bankkonto 1");
    const other2 = await makeAccount("1950", "Övrigt bankkonto 2");
    const draft = await service.createVerification(
      {
        seriesId: series.id,
        date: DEFAULT_VERIFICATION_DATE,
        description: "Öressummering",
        rows: [
          { accountId: bank.id, debit: 0.1, credit: 0 },
          { accountId: other1.id, debit: 0.1, credit: 0 },
          { accountId: other2.id, debit: 0.1, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 0.3 },
        ],
      },
      user.id
    );

    const booked = await service.book(draft.id, user.id);
    expect(booked.status).toBe("booked");
  });

  it("rejects booking when a referenced account has been deactivated after the row was added (InactiveAccountError)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    await service.updateAccount(bank.id, { active: false });

    await expect(service.book(draft.id, user.id)).rejects.toBeInstanceOf(InactiveAccountError);
  });

  it("rejects booking in a locked accounting period (AccountingPeriodLockedError, 409)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id, { date: DEFAULT_VERIFICATION_DATE });
    const period = await repo.findPeriodForDate(DEFAULT_VERIFICATION_DATE);
    await service.lockPeriod(period!.id, user.id);

    await expect(service.book(draft.id, user.id)).rejects.toBeInstanceOf(AccountingPeriodLockedError);
  });

  it("rejects booking when no accounting period covers the date at all (NoAccountingPeriodError, 400) — impossible by construction, guarded anyway", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id, { date: DEFAULT_VERIFICATION_DATE });

    // createFiscalYearWithPeriods always generates full monthly coverage, so
    // a "date with a fiscal year but no covering period" can't happen
    // through the normal API surface — remove the period directly to
    // exercise the cheap defensive guard anyway.
    await db
      .delete(accountingPeriods)
      .where(
        and(
          eq(accountingPeriods.startDate, `${CURRENT_YEAR}-03-01`),
          eq(accountingPeriods.endDate, `${CURRENT_YEAR}-03-31`)
        )
      );

    await expect(service.book(draft.id, user.id)).rejects.toBeInstanceOf(NoAccountingPeriodError);
  });

  it("still allows editing a draft (header + rows) while its accounting period is locked — only booking is blocked", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id, { date: DEFAULT_VERIFICATION_DATE });
    const period = await repo.findPeriodForDate(DEFAULT_VERIFICATION_DATE);
    await service.lockPeriod(period!.id, user.id);

    const updated = await service.updateVerificationHeader(draft.id, { description: "Ändrad trots låst period" });
    expect(updated.description).toBe("Ändrad trots låst period");

    const row = await service.addRow(draft.id, { accountId: bank.id, debit: 10, credit: 0 });
    expect(row).toBeTruthy();

    await service.deleteRow(draft.id, row.id);
    await expect(service.findVerificationById(draft.id)).resolves.toBeTruthy();
  });
});

describe("economy service — booking: unbroken number sequence", () => {
  it("books A→1, deletes draft B, books C→2 (sequence stays unbroken)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const a = await makeBalancedDraft(series, bank, revenue, user.id, { description: "A" });
    const b = await makeBalancedDraft(series, bank, revenue, user.id, { description: "B" });
    const c = await makeBalancedDraft(series, bank, revenue, user.id, { description: "C" });

    const bookedA = await service.book(a.id, user.id);
    expect(bookedA.verificationNumber).toBe(1);

    await service.deleteVerification(b.id);

    const bookedC = await service.book(c.id, user.id);
    expect(bookedC.verificationNumber).toBe(2);
  });
});

describe("economy repository — bookVerification: race and immutability at repo level", () => {
  it("book on an already-booked verification fails with reason 'race' and does not advance the counter (next booking gets the next consecutive number)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Först" });
    const other = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Sedan" });

    const first = await repo.bookVerification(draft.id, user.id);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.verification.verificationNumber).toBe(1);

    // Race: book the SAME (now-booked) verification again at repo level.
    const raced = await repo.bookVerification(draft.id, user.id);
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.reason).toBe("race");

    // The counter must not have advanced from the failed race attempt — a
    // fresh booking gets the next CONSECUTIVE number (2, not 3).
    const second = await repo.bookVerification(other.id, user.id);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.verification.verificationNumber).toBe(2);
  });

  // TOCTOU: the service's own row-count/balance/active-account checks read
  // an UNLOCKED snapshot before repo.bookVerification's transaction opens.
  // These tests bypass the service (calling the repo directly, same as a
  // concurrent edit that committed in that window would) to prove the
  // repo's re-validation under the FOR UPDATE lock is the real guarantee —
  // a booked verification is immutable, so this window has to be closed
  // HERE, not just at the service's fast path.
  it("re-validates balance under the lock: a row edited to unbalanced after the draft passed service checks fails booking with reason 'unbalanced', and the counter does not advance", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Blir obalanserad" });
    const other = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Frisk" });

    // Simulate a concurrent edit that committed in the TOCTOU window — a
    // real edit would go through service.updateRow, which re-validates the
    // account/rounding but has no opinion on the OTHER rows' balance, so
    // this state (debit 600 vs credit 500) is reachable through the normal
    // API surface, just not through service.book()'s own fast-path check.
    // Going straight to the DB here is only a deterministic stand-in for
    // that race, landing on the exact same post-condition.
    await db
      .update(verificationRows)
      .set({ debit: "600" })
      .where(and(eq(verificationRows.verificationId, draft.id), eq(verificationRows.accountId, bank.id)));

    const result = await repo.bookVerification(draft.id, user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unbalanced");

    // Counter must not have advanced — the next real booking still gets 1.
    const fresh = await repo.bookVerification(other.id, user.id);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.verification.verificationNumber).toBe(1);
  });

  it("re-validates row count under the lock: a row deleted down to 1 after the draft passed service checks fails booking with reason 'too_few_rows', and the counter does not advance", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Tappar en rad" });
    const other = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Frisk" });

    // Same TOCTOU simulation as above, this time dropping to a single row.
    await db.delete(verificationRows).where(and(eq(verificationRows.verificationId, draft.id), eq(verificationRows.accountId, bank.id)));

    const result = await repo.bookVerification(draft.id, user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too_few_rows");

    const fresh = await repo.bookVerification(other.id, user.id);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.verification.verificationNumber).toBe(1);
  });

  it("re-validates active accounts under the lock: an account deactivated after the draft passed service checks fails booking with reason 'inactive_account', and the counter does not advance", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Konto stängs" });

    // A second, fully independent pair of accounts for the "counter didn't
    // advance" check below — deactivating `bank` must not also break this
    // one, or a false pass on "next number is 1" would just be masking a
    // second real booking failure.
    const otherBank = await makeAccount("1940", "Övrigt bankkonto");
    const otherRevenue = await makeAccount("3002", "Övrig försäljning");
    const other = await makeBalancedDraft(series, otherBank, otherRevenue, user.id, { description: "Frisk" });

    await service.updateAccount(bank.id, { active: false });

    const result = await repo.bookVerification(draft.id, user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("inactive_account");
      if (result.reason === "inactive_account") expect(result.accountId).toBe(bank.id);
    }

    const fresh = await repo.bookVerification(other.id, user.id);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.verification.verificationNumber).toBe(1);
  });

  // The fourth in-tx guard (row-count/balance/active-account are the other
  // three): the service's own book() reads the period status against an
  // UNLOCKED snapshot before this transaction even opens, so it can miss
  // both an admin lock landing mid-booking and a concurrent header PATCH
  // moving `date` into an already-locked period — that fresh `date` was
  // never period-checked at all until the repo's own re-check under the
  // FOR UPDATE lock. This test bypasses the service (calling the repo
  // directly, same as the other TOCTOU tests above) to prove that re-check
  // is the real guarantee, not just the service's fast path.
  it("re-validates period status under the lock: a period locked after the draft passed service checks fails booking with reason 'locked_period', and the counter does not advance", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Perioden låses" });
    // A different month (still inside the same fiscal year) so locking
    // draft's period below doesn't also lock this one out — otherwise the
    // "counter didn't advance" check would be masked by a second, unrelated
    // booking failure.
    const other = await makeBalancedDraft(series, bank, revenue, user.id, {
      description: "Frisk",
      date: `${CURRENT_YEAR}-04-15`,
    });

    // Simulate a concurrent admin lock that committed in the TOCTOU window.
    const period = await repo.findPeriodForDate(draft.date);
    await repo.lockPeriod(period!.id, user.id);

    const result = await repo.bookVerification(draft.id, user.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("locked_period");

    // The counter must not have advanced — the next real booking (in the
    // still-open period covering `other`) still gets the fresh, consecutive
    // number 1.
    const fresh = await repo.bookVerification(other.id, user.id);
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.verification.verificationNumber).toBe(1);
  });

  it("a genuinely booked verification is immutable at the repo level (every draft-conditioned write returns null)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    const rowId = draft.rows[0]!.id;
    await service.book(draft.id, user.id);

    expect(await repo.updateVerificationHeader(draft.id, { description: "X" })).toBeNull();
    expect(await repo.addRow(draft.id, { accountId: bank.id, debit: 5, credit: 0, description: null })).toBeNull();
    expect(
      await repo.updateRow(draft.id, rowId, { accountId: bank.id, debit: 5, credit: 0, description: null })
    ).toBeNull();
    expect(await repo.deleteRow(draft.id, rowId)).toBeNull();
    expect(await repo.deleteVerification(draft.id)).toBeNull();
  });
});

describe("economy service — a booked verification is immutable (409 InvalidVerificationStateError)", () => {
  it("rejects header PATCH, row POST/PATCH/DELETE, and DELETE on a booked verification", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    const rowId = draft.rows[0]!.id;
    await service.book(draft.id, user.id);

    await expect(service.updateVerificationHeader(draft.id, { description: "X" })).rejects.toBeInstanceOf(
      InvalidVerificationStateError
    );
    await expect(service.addRow(draft.id, { accountId: bank.id, debit: 5, credit: 0 })).rejects.toBeInstanceOf(
      InvalidVerificationStateError
    );
    await expect(
      service.updateRow(draft.id, rowId, { accountId: bank.id, debit: 5, credit: 0 })
    ).rejects.toBeInstanceOf(InvalidVerificationStateError);
    await expect(service.deleteRow(draft.id, rowId)).rejects.toBeInstanceOf(InvalidVerificationStateError);
    await expect(service.deleteVerification(draft.id)).rejects.toBeInstanceOf(InvalidVerificationStateError);
  });
});

describe("economy service — reverse (Omför)", () => {
  it("creates a mirrored draft (debit<->credit per row, same accounts/amounts) that nets each account to zero with the source", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const other = await makeAccount("1940", "Övrigt bankkonto");
    const source = await service.createVerification(
      {
        seriesId: series.id,
        date: DEFAULT_VERIFICATION_DATE,
        description: "Hyra",
        rows: [
          { accountId: bank.id, debit: 300, credit: 0 },
          { accountId: other.id, debit: 200, credit: 0 },
          { accountId: revenue.id, debit: 0, credit: 500 },
        ],
      },
      user.id
    );
    const booked = await service.book(source.id, user.id);

    const reversal = await service.reverse(booked.id, user.id);

    expect(reversal.status).toBe("draft");
    expect(reversal.displayNumber).toBe("Utkast");
    expect(reversal.reversesVerificationId).toBe(booked.id);
    expect(reversal.description).toBe(`Omföring av ${booked.displayNumber}`);
    expect(reversal.date).toBe(new Date().toLocaleDateString("sv-SE"));
    expect(reversal.seriesId).toBe(booked.seriesId);

    expect(reversal.rows).toHaveLength(3);
    const bySourceAccount = new Map(booked.rows.map((r) => [r.accountId, r]));
    for (const row of reversal.rows) {
      const sourceRow = bySourceAccount.get(row.accountId);
      expect(sourceRow).toBeDefined();
      expect(Number(row.debit)).toBe(Number(sourceRow!.credit));
      expect(Number(row.credit)).toBe(Number(sourceRow!.debit));
    }

    // Net per account across source + reversal must be zero.
    const net = new Map<string, number>();
    for (const row of [...booked.rows, ...reversal.rows]) {
      net.set(row.accountId, (net.get(row.accountId) ?? 0) + Number(row.debit) - Number(row.credit));
    }
    for (const [, value] of net) {
      expect(value).toBe(0);
    }

    const entries = await auditRows("verification", "reversal_created");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityId: booked.displayNumber, userId: user.id });
  });

  it("exposes the reverse-direction link: findVerificationById(source).reversedBy points at the reversal draft, and stays unset on unrelated verifications", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    const booked = await service.book(draft.id, user.id);
    const untouched = await makeBalancedDraft(series, bank, revenue, user.id, { description: "Orörd" });

    const reversal = await service.reverse(booked.id, user.id);

    const sourceAfter = await service.findVerificationById(booked.id);
    expect(sourceAfter.reversedBy?.id).toBe(reversal.id);
    // The reversal is a fresh draft, not yet booked itself — displayNumber
    // reads "Utkast" until someone books it too.
    expect(sourceAfter.reversedBy).toEqual({ id: reversal.id, displayNumber: "Utkast" });

    // Neither the reversal itself nor an unrelated verification has a
    // reversedBy of their own.
    const reversalDetail = await service.findVerificationById(reversal.id);
    expect(reversalDetail.reversedBy).toBeNull();
    const untouchedDetail = await service.findVerificationById(untouched.id);
    expect(untouchedDetail.reversedBy).toBeNull();
  });

  it("rejects reversing a draft (InvalidVerificationStateError)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);

    await expect(service.reverse(draft.id, user.id)).rejects.toBeInstanceOf(InvalidVerificationStateError);
  });

  it("throws VerificationNotFoundError for a missing id", async () => {
    const user = await makeUser();
    await expect(service.reverse("00000000-0000-0000-0000-000000000000", user.id)).rejects.toBeInstanceOf(
      VerificationNotFoundError
    );
  });

  it("rejects reversing an already-reversed verification (AlreadyReversedError, 409)", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    const booked = await service.book(draft.id, user.id);

    await service.reverse(booked.id, user.id);

    await expect(service.reverse(booked.id, user.id)).rejects.toBeInstanceOf(AlreadyReversedError);
  });
});


// Underlag on a verification (kvitto, kontoutdrag): räkenskapsinformation —
// removable only while a draft, always addable.
describe("verification underlag (files)", () => {
  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);

  it("stores a file with its SHA-256, shows it on the card, logs it and serves it back", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    const data = pdf("kvitto");
    const row = await service.addFile(draft.id, { filename: "kvitto.pdf", contentType: "application/pdf", data }, user.id);

    const expected = (await import("node:crypto")).createHash("sha256").update(data).digest("hex");
    expect(row).toMatchObject({ filename: "kvitto.pdf", sha256: expected, sizeBytes: data.length });
    expect(row).not.toHaveProperty("data");
    expect((await service.findVerificationById(draft.id)).files.map((f) => f.id)).toEqual([row.id]);
    expect(Buffer.compare((await service.downloadFile(draft.id, row.id)).data, data)).toBe(0);
    expect(await auditRows("verification", "file_added")).toHaveLength(1);
  });

  it("removes a draft's file, refuses once booked, and still accepts new files after booking", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    const wrong = await service.addFile(draft.id, { filename: "fel.pdf", contentType: "application/pdf", data: pdf("fel") }, user.id);
    await service.deleteFile(draft.id, wrong.id, user.id);
    expect(await service.listFiles(draft.id)).toEqual([]);
    expect(await auditRows("verification", "file_deleted")).toHaveLength(1);

    const right = await service.addFile(draft.id, { filename: "ratt.pdf", contentType: "application/pdf", data: pdf("ratt") }, user.id);
    await service.book(draft.id, user.id);
    await expect(service.deleteFile(draft.id, right.id, user.id)).rejects.toBeInstanceOf(VerificationFileLockedError);

    await service.addFile(draft.id, { filename: "sida2.png", contentType: "image/png", data: Buffer.from([0x89, 0x50]) }, user.id);
    expect(await service.listFiles(draft.id)).toHaveLength(2);
  });

  it("deleting a draft verification takes its underlag with it", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const draft = await makeBalancedDraft(series, bank, revenue, user.id);
    await service.addFile(draft.id, { filename: "a.pdf", contentType: "application/pdf", data: pdf("a") }, user.id);
    await service.deleteVerification(draft.id);
    await expect(service.findVerificationById(draft.id)).rejects.toBeInstanceOf(VerificationNotFoundError);
  });

  it("rejects other file types and 404s a file from another verification", async () => {
    const { user, series, bank, revenue } = await setupEconomy();
    const a = await makeBalancedDraft(series, bank, revenue, user.id);
    const b = await makeBalancedDraft(series, bank, revenue, user.id);
    await expect(
      service.addFile(a.id, { filename: "x.zip", contentType: "application/zip", data: Buffer.from("PK") }, user.id)
    ).rejects.toBeInstanceOf(InvalidVerificationFileTypeError);
    const file = await service.addFile(a.id, { filename: "a.pdf", contentType: "application/pdf", data: pdf("a") }, user.id);
    await expect(service.downloadFile(b.id, file.id)).rejects.toBeInstanceOf(VerificationFileNotFoundError);
  });
});
